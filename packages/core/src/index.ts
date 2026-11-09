import { buildCallGraph } from "./callgraph.ts";
import { analyzeReachability, parseTarget } from "./reach.ts";
import type { Finding } from "./types.ts";

export { buildCallGraph } from "./callgraph.ts";
export { analyzeReachability, LIMITATIONS, matchesTarget, parseTarget } from "./reach.ts";
export { ANALYZER_VERSION, buildReport, REPORT_SCHEMA_VERSION, type ScanReport } from "./report.ts";
export type * from "./types.ts";

/** Builds the app's call graph and decides whether `target` (e.g. "lodash#merge") is reachable. */
export function scanTarget(rootDir: string, target: string): Finding {
  return analyzeReachability(buildCallGraph(rootDir), parseTarget(target));
}
