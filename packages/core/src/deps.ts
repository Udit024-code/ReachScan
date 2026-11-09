import path from "node:path";
import { readLockfile } from "./lockfile.ts";
import type { AdvisorySource } from "./osv/client.ts";
import { matchDependencies, type Severity, type VersionMatch } from "./osv/match.ts";
import { ANALYZER_VERSION, REPORT_SCHEMA_VERSION } from "./report.ts";

/** Output of `reachscan deps`: which installed packages have advisories, by version alone. */
export interface DependencyReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  kind: "dependencies";
  analyzer: { name: "reachscan"; version: string };
  generatedAt: string;
  project: { name: string };
  lockfile: { version: number; installed: number; uniquePackages: number };
  advisorySource: string;
  summary: {
    vulnerablePackages: number;
    advisories: number;
    bySeverity: Record<Severity, number>;
    directPackages: number;
    devOnlyPackages: number;
  };
  /** One entry per (advisory, installed name@version), most severe first. */
  matches: VersionMatch[];
  limitations: string[];
}

export const DEPENDENCY_LIMITATIONS = [
  "Matched by version only: this says which installed versions have advisories, not whether your code calls the vulnerable code.",
  "Only npm package-lock.json (v2/v3) is read; nothing is installed.",
];

export async function scanDependencies(
  projectDir: string,
  source: AdvisorySource,
  now: Date = new Date(),
): Promise<DependencyReport> {
  const tree = readLockfile(projectDir);
  const names = [...new Set(tree.dependencies.map((d) => d.name))];
  const advisories = await source.advisoriesFor(names);
  const matches = matchDependencies(tree.dependencies, advisories);

  const packages = new Map<string, VersionMatch["package"]>();
  for (const m of matches) packages.set(`${m.package.name}@${m.package.version}`, m.package);
  const bySeverity: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MODERATE: 0, LOW: 0, UNKNOWN: 0 };
  for (const m of matches) bySeverity[m.advisory.severity]++;

  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    kind: "dependencies",
    analyzer: { name: "reachscan", version: ANALYZER_VERSION },
    generatedAt: now.toISOString(),
    project: { name: path.basename(path.resolve(projectDir)) },
    lockfile: {
      version: tree.lockfileVersion,
      installed: tree.dependencies.length,
      uniquePackages: names.length,
    },
    advisorySource: source.name,
    summary: {
      vulnerablePackages: packages.size,
      advisories: new Set(matches.map((m) => m.advisory.id)).size,
      bySeverity,
      directPackages: [...packages.values()].filter((p) => p.direct).length,
      devOnlyPackages: [...packages.values()].filter((p) => p.dev).length,
    },
    matches,
    limitations: DEPENDENCY_LIMITATIONS,
  };
}
