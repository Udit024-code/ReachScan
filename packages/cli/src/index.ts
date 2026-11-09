#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { buildCallGraph, type CallSite, type Finding, scanTarget } from "@reachscan/core";
import { Command, Option } from "commander";

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
  .description("Find out whether your code can reach a vulnerable dependency function.");

program
  .command("reach")
  .description("decide whether a package export is reachable from the app's entry points")
  .argument("<dir>", "path to the project to scan")
  .requiredOption("-t, --target <package#export>", 'vulnerable export, e.g. "lodash#merge"')
  .addOption(formatOption())
  .option("-o, --out <file>", "write the report to a file")
  .action((dir: string, opts: { target: string; format: string; out?: string }) => {
    const finding = scanTarget(dir, opts.target);
    emit(opts.format === "json" ? JSON.stringify(finding, null, 2) : findingToText(finding), opts.out);
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

program.parse();
