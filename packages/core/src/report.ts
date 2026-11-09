import path from "node:path";
import type { Finding } from "./types.ts";

/**
 * Bump when the JSON shape changes in a way consumers would notice
 * (renamed/removed fields, changed meanings). Adding optional fields doesn't need a bump.
 */
export const REPORT_SCHEMA_VERSION = 1;

/** Keep in sync with packages/core/package.json (a test checks this). */
export const ANALYZER_VERSION = "0.2.0";

export interface ScanReport {
  schemaVersion: typeof REPORT_SCHEMA_VERSION;
  analyzer: { name: "reachscan"; version: string };
  generatedAt: string;
  /** Only the folder name: reports never contain absolute paths from the machine that ran the scan. */
  project: { name: string };
  findings: Finding[];
}

export function buildReport(projectDir: string, findings: Finding[], now: Date = new Date()): ScanReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    analyzer: { name: "reachscan", version: ANALYZER_VERSION },
    generatedAt: now.toISOString(),
    project: { name: path.basename(path.resolve(projectDir)) },
    findings,
  };
}
