#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AdvisoryLookupError,
  ANALYZER_VERSION,
  buildCallGraph,
  buildReport,
  type CallSite,
  type DependencyReport,
  type Finding,
  OsvApiSource,
  scanDependencies,
  scanTarget,
  UnsupportedProjectError,
} from "@reachscan/core";
import { Command, Option } from "commander";

/** %LOCALAPPDATA%\reachscan on Windows, $XDG_CACHE_HOME/reachscan or ~/.cache/reachscan elsewhere. */
function defaultCacheDir(): string {
  if (process.env.REACHSCAN_CACHE_DIR) return process.env.REACHSCAN_CACHE_DIR;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "reachscan");
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "reachscan");
}

function dependencyReportToText(r: DependencyReport): string {
  const s = r.summary;
  const lines = [
    `${r.project.name} · package-lock.json v${r.lockfile.version} · ${r.lockfile.installed} installed packages (${r.lockfile.uniquePackages} unique)`,
    `${s.vulnerablePackages} vulnerable package${s.vulnerablePackages === 1 ? "" : "s"}, ${s.advisories} advisor${s.advisories === 1 ? "y" : "ies"} (by version only; reachability not checked)`,
  ];
  const severities = Object.entries(s.bySeverity).filter(([, n]) => n > 0);
  if (severities.length > 0)
    lines.push(severities.map(([sev, n]) => `${sev.toLowerCase()} ${n}`).join(" · "));
  if (r.matches.length > 0) {
    lines.push("");
    const pkgWidth = Math.max(...r.matches.map((m) => `${m.package.name}@${m.package.version}`.length));
    for (const m of r.matches) {
      const pkg = `${m.package.name}@${m.package.version}`.padEnd(pkgWidth);
      const fix = m.fixedVersion ? `fix: ${m.fixedVersion}` : "no fix listed";
      const tags = [m.package.direct ? "direct" : "transitive", ...(m.package.dev ? ["dev"] : [])];
      lines.push(
        `${m.advisory.severity.padEnd(8)}  ${pkg}  ${m.advisory.id.padEnd(19)}  ${fix.padEnd(15)}  ${tags.join(", ").padEnd(15)}  ${m.advisory.summary}`,
      );
      if (m.uncertain) lines.push(`          ⚠ ${m.uncertain}`);
    }
  }
  return lines.join("\n");
}

const formatOption = () =>
  new Option("--format <format>", "output format").choices(["text", "json"]).default("text");

function emit(output: string, outFile: string | undefined): void {
  if (outFile) {
    writeFileSync(outFile, `${output}\n`);
    console.error(`Wrote ${outFile}`);
  } else {
    console.log(output);
  }
}

function describeTarget(call: CallSite): string {
  const t = call.target;
  switch (t.kind) {
    case "internal":
      return `→ ${t.functionId}`;
    case "external":
      return `→ ${t.ref.package}${t.ref.subpath ? `/${t.ref.subpath}` : ""}${t.ref.member.length ? `.${t.ref.member.join(".")}` : ""} [package]`;
    case "ignored":
      return `(${t.why})`;
    case "unresolved":
      return `?? ${t.reason}`;
  }
}

function findingToText(f: Finding): string {
  const at = (l: { file: string; line: number }) => `${l.file}:${l.line}`;
  const lines = [
    `Target:  ${f.target}`,
    `Verdict: ${f.verdict.toUpperCase()}  [${f.reasonCodes.join(", ")}]`,
  ];
  if (f.path) {
    const width = Math.max(...f.path.map((s) => s.label.length)) + 4;
    lines.push("Path:");
    f.path.forEach((step, i) => {
      const prefix = i === 0 ? "   " : "   → ";
      lines.push(`${(prefix + step.label).padEnd(width + 5)}${at(step.at)}`);
    });
  }
  if (f.blockers.length > 0) {
    lines.push("Could not follow:");
    for (const b of f.blockers) lines.push(`   ${b.text}  ${at(b.at)}  (${b.reason})`);
  }
  const s = f.stats;
  lines.push(
    `Scanned: ${s.files} files, ${s.functions} functions, ${s.calls} calls (${s.unresolvedCalls} unresolved), ${s.entryPoints} route handler${s.entryPoints === 1 ? "" : "s"}`,
  );
  lines.push("Limitations:");
  for (const l of f.limitations) lines.push(`   - ${l}`);
  return lines.join("\n");
}

const program = new Command()
  .name("reachscan")
  .version(ANALYZER_VERSION)
  .description("Find out whether your code can reach a vulnerable dependency function.");

program
  .command("deps")
  .description("read package-lock.json and list installed packages with known advisories (OSV)")
  .argument("<dir>", "path to the project to scan")
  .addOption(formatOption())
  .option("-o, --out <file>", "write the report to a file")
  .option("--cache-dir <dir>", "where to cache advisory records", defaultCacheDir())
  .option("--no-cache", "always download advisory records")
  .action(async (dir: string, opts: { format: string; out?: string; cacheDir: string; cache: boolean }) => {
    const source = new OsvApiSource({
      cacheDir: opts.cache ? opts.cacheDir : null,
      userAgent: `reachscan/${ANALYZER_VERSION}`,
    });
    const report = await scanDependencies(dir, source);
    emit(opts.format === "json" ? JSON.stringify(report, null, 2) : dependencyReportToText(report), opts.out);
  });

program
  .command("reach")
  .description("decide whether a package export is reachable from the app's entry points")
  .argument("<dir>", "path to the project to scan")
  .requiredOption("-t, --target <package#export>", 'vulnerable export, e.g. "lodash#merge"')
  .addOption(formatOption())
  .option("-o, --out <file>", "write the report to a file")
  .action((dir: string, opts: { target: string; format: string; out?: string }) => {
    const finding = scanTarget(dir, opts.target);
    const output =
      opts.format === "json" ? JSON.stringify(buildReport(dir, [finding]), null, 2) : findingToText(finding);
    emit(output, opts.out);
  });

program
  .command("calls")
  .description("list every function call in the project with file and line")
  .argument("<dir>", "path to the project to scan")
  .addOption(formatOption())
  .option("-o, --out <file>", "write the list to a file")
  .action((dir: string, opts: { format: string; out?: string }) => {
    const graph = buildCallGraph(dir);
    if (opts.format === "json") {
      emit(
        JSON.stringify({ files: graph.files, calls: graph.calls, entries: graph.entries }, null, 2),
        opts.out,
      );
      return;
    }
    const lines = graph.calls.map(
      (c) => `${c.at.file}:${c.at.line}:${c.at.column}  ${c.callee}  ${describeTarget(c)}`,
    );
    lines.push("", "Entry points:");
    for (const e of graph.entries.filter((e) => e.kind === "route")) {
      lines.push(`  ${e.label}  ${e.at.file}:${e.at.line}  ${e.functionId ?? `?? ${e.text}`}`);
    }
    emit(lines.join("\n"), opts.out);
  });

try {
  await program.parseAsync();
} catch (error) {
  // Expected problems get a one-line message and a distinct exit code; anything else is a bug.
  if (error instanceof UnsupportedProjectError) {
    console.error(`Unsupported project: ${error.message}`);
    process.exitCode = 2;
  } else if (error instanceof AdvisoryLookupError) {
    console.error(`Advisory lookup failed: ${error.message}`);
    process.exitCode = 3;
  } else {
    throw error;
  }
}
