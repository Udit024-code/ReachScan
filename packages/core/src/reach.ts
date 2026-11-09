import type {
  CallGraph,
  Edge,
  EntryPoint,
  ExternalRef,
  Finding,
  PackageUse,
  PathStep,
  ReasonCode,
  TargetSpec,
} from "./types.ts";

const DYNAMIC_CODE_REASONS = new Set(["EVAL", "DYNAMIC_REQUIRE", "DYNAMIC_IMPORT"]);
const MAX_BLOCKERS = 20;

export const LIMITATIONS = [
  "Reachable means a call path exists; it does not prove the vulnerability is exploitable.",
  "Every non-test file's top-level code is treated as running when the app starts (over-approximation).",
  "Only calls to the named export are matched; other exports of the package that call it internally are not linked yet.",
  "Only the app's own code is searched; paths through other packages (transitive dependencies) are not followed yet.",
];

/** "lodash#merge" → lodash, matching `_.merge`, `{ merge }` and `lodash/merge`. */
export function parseTarget(spec: string): TargetSpec {
  const hash = spec.lastIndexOf("#");
  if (hash <= 0 || hash === spec.length - 1) {
    throw new Error(`Target must look like "package#export", got "${spec}"`);
  }
  const pkg = spec.slice(0, hash);
  const member = spec
    .slice(hash + 1)
    .split(".")
    .filter(Boolean);
  return {
    package: pkg,
    label: spec,
    exports: [
      { subpath: null, member },
      { subpath: member.join("/"), member: [] },
    ],
  };
}

function isPrefix(prefix: string[], of: string[]): boolean {
  return prefix.length <= of.length && prefix.every((p, i) => p === of[i]);
}

/** esModuleInterop lets code reach exports through `.default`; ignore that hop. */
function normalizeMember(member: string[]): string[] {
  return member[0] === "default" ? member.slice(1) : member;
}

export function matchesTarget(ref: ExternalRef, target: TargetSpec): boolean {
  if (ref.package !== target.package) return false;
  const member = normalizeMember(ref.member);
  return target.exports.some((e) => e.subpath === ref.subpath && isPrefix(e.member, member));
}

/** Could this escaped package value give code access to the target export? */
function escapeMayExposeTarget(use: PackageUse, target: TargetSpec): boolean {
  if (use.ref.package !== target.package) return false;
  if (use.detail?.startsWith("result of the call")) return true;
  const member = normalizeMember(use.ref.member);
  return target.exports.some(
    (e) => e.subpath === use.ref.subpath && (isPrefix(member, e.member) || isPrefix(e.member, member)),
  );
}

type Parent = { from: string; edge: Edge } | { entry: EntryPoint };

/** Breadth-first search from all entry points; routes first so paths start at a route when possible. */
function searchFromEntries(graph: CallGraph): Map<string, Parent> {
  const parents = new Map<string, Parent>();
  const queue: string[] = [];
  const ordered = [
    ...graph.entries.filter((e) => e.kind === "route"),
    ...graph.entries.filter((e) => e.kind === "module"),
  ];
  for (const entry of ordered) {
    if (!entry.functionId || parents.has(entry.functionId)) continue;
    parents.set(entry.functionId, { entry });
    queue.push(entry.functionId);
  }
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i] as string;
    for (const edge of graph.edges.get(current) ?? []) {
      if (parents.has(edge.to)) continue;
      parents.set(edge.to, { from: current, edge });
      queue.push(edge.to);
    }
  }
  return parents;
}

/** Every function that can reach one of `targets` through edges we resolved. */
function reverseClosure(graph: CallGraph, targets: Iterable<string>): Set<string> {
  const reverse = new Map<string, string[]>();
  for (const [from, edges] of graph.edges) {
    for (const edge of edges) {
      const list = reverse.get(edge.to);
      if (list) list.push(from);
      else reverse.set(edge.to, [from]);
    }
  }
  const seen = new Set(targets);
  const queue = [...seen];
  for (let i = 0; i < queue.length; i++) {
    for (const caller of reverse.get(queue[i] as string) ?? []) {
      if (seen.has(caller)) continue;
      seen.add(caller);
      queue.push(caller);
    }
  }
  return seen;
}

function buildPath(graph: CallGraph, parents: Map<string, Parent>, site: PackageUse): PathStep[] {
  const steps: PathStep[] = [{ label: `${site.text}()`, at: site.at }];
  let current = site.callerId;
  for (;;) {
    const parent = parents.get(current);
    if (!parent) break;
    const fn = graph.functions.get(current);
    if ("entry" in parent) {
      const { entry } = parent;
      steps.push({
        label: entry.kind === "route" ? `${entry.label} → ${fn?.name ?? entry.text}` : entry.label,
        at: entry.at,
      });
      break;
    }
    const via = parent.edge.kind === "callback" ? " (passed as callback)" : "";
    steps.push({ label: `${fn?.name ?? current}()${via}`, at: parent.edge.at });
    current = parent.from;
  }
  return steps.reverse();
}

export function analyzeReachability(graph: CallGraph, target: TargetSpec): Finding {
  const parents = searchFromEntries(graph);
  const sites = graph.packageUses.filter((u) => u.kind === "call" && matchesTarget(u.ref, target));
  const unresolvedCalls = graph.calls.filter((c) => c.target.kind === "unresolved");
  const base = {
    target: target.label,
    limitations: LIMITATIONS,
    stats: {
      files: graph.files.length,
      functions: [...graph.functions.values()].filter((f) => !f.isModule).length,
      calls: graph.calls.length,
      unresolvedCalls: unresolvedCalls.length,
      entryPoints: graph.entries.filter((e) => e.kind === "route").length,
    },
  };

  const reached = sites.find((s) => parents.has(s.callerId));
  if (reached) {
    return {
      ...base,
      verdict: "reachable",
      reasonCodes: ["PATH_FOUND"],
      path: buildPath(graph, parents, reached),
      blockers: [],
    };
  }

  // No path. "Unreachable" is only allowed if nothing we failed to follow could lead to the target.
  const reasons: ReasonCode[] = [];
  const blockers: Finding["blockers"] = [];
  const inReachedCode = (callerId: string) => parents.has(callerId);

  const regionUnresolved = unresolvedCalls
    .filter((c) => inReachedCode(c.callerId))
    .map((c) => ({
      at: c.at,
      text: c.callee,
      reason: c.target.kind === "unresolved" ? c.target.reason : "",
    }));
  for (const entry of graph.entries) {
    if (entry.functionId === null) {
      regionUnresolved.push({ at: entry.at, text: entry.text, reason: "UNRESOLVED_ROUTE_HANDLER" });
    }
  }

  const dynamic = regionUnresolved.filter((u) => DYNAMIC_CODE_REASONS.has(u.reason));
  if (dynamic.length > 0) {
    reasons.push("DYNAMIC_CODE");
    blockers.push(...dynamic);
  }

  const escapes = graph.packageUses.filter(
    (u) => u.kind === "escape" && inReachedCode(u.callerId) && escapeMayExposeTarget(u, target),
  );
  if (escapes.length > 0) {
    reasons.push("PACKAGE_REFERENCE_ESCAPES");
    blockers.push(...escapes.map((u) => ({ at: u.at, text: u.text, reason: u.detail ?? "escape" })));
  }

  const canReachSite = reverseClosure(
    graph,
    sites.map((s) => s.callerId),
  );
  const escaping = [...canReachSite].map((id) => graph.functions.get(id)).filter((f) => f?.escapes);
  if (escaping.length > 0 && regionUnresolved.length > 0) {
    reasons.push("MAY_BE_CALLED_DYNAMICALLY");
    for (const f of escaping) {
      if (f) blockers.push({ at: f.at, text: `${f.name}()`, reason: f.escapeReason ?? "escapes" });
    }
    blockers.push(...regionUnresolved.filter((u) => !DYNAMIC_CODE_REASONS.has(u.reason)));
  }

  if (reasons.length > 0) {
    return {
      ...base,
      verdict: "unknown",
      reasonCodes: reasons,
      path: null,
      blockers: blockers.slice(0, MAX_BLOCKERS),
    };
  }
  return {
    ...base,
    verdict: "unreachable",
    reasonCodes: [sites.length === 0 ? "TARGET_NEVER_CALLED" : "NO_PATH_FROM_ENTRY"],
    path: null,
    blockers: [],
  };
}
