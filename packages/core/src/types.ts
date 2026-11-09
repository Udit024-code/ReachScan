export type Verdict = "reachable" | "unreachable" | "unknown" | "unavailable";

/** A position in the scanned repo. `file` is repo-relative with forward slashes. */
export interface Location {
  file: string;
  line: number;
  column: number;
}

/**
 * A value that comes from an npm package, described by how the app got it:
 * `import _ from "lodash"; _.merge` → { package: "lodash", subpath: null, member: ["merge"] }
 * `import merge from "lodash/merge"` → { package: "lodash", subpath: "merge", member: [] }
 * An empty `member` means the module value itself (default or namespace import).
 */
export interface ExternalRef {
  package: string;
  subpath: string | null;
  member: string[];
}

export type UnresolvedReason =
  | "DYNAMIC_PROPERTY_CALL" // handlers[action]()
  | "UNKNOWN_RECEIVER" // req.thing.run() where the receiver's type is unknown
  | "UNKNOWN_CALLEE" // a callee whose value can't be traced to a function
  | "CALL_ON_CALL_RESULT" // makeHandler()()
  | "EVAL" // eval(...) or new Function(...)
  | "DYNAMIC_REQUIRE" // require(name)
  | "DYNAMIC_IMPORT" // import(name)
  | "UNRESOLVED_ROUTE_HANDLER"; // app.get("/x", something we can't trace)

export type CallTarget =
  | { kind: "internal"; functionId: string }
  | { kind: "external"; ref: ExternalRef }
  | { kind: "ignored"; why: string } // builtins, module loads, classes without constructors
  | { kind: "unresolved"; reason: UnresolvedReason };

export interface CallSite {
  at: Location;
  callee: string;
  callerId: string;
  target: CallTarget;
}

export interface FunctionNode {
  id: string;
  name: string;
  at: Location;
  /** True for a file's top-level code, which runs when the module loads. */
  isModule: boolean;
  /**
   * True when the function is stored or passed somewhere we don't follow
   * (object property, class method, module.exports, ...), so a call we
   * couldn't resolve might land on it.
   */
  escapes: boolean;
  escapeReason?: string;
}

export interface Edge {
  to: string;
  at: Location;
  /** "callback": the function was passed as an argument and is assumed to be called. */
  kind: "call" | "callback";
}

export interface EntryPoint {
  kind: "route" | "module";
  /** null when the route handler could not be traced to a function. */
  functionId: string | null;
  /** e.g. "POST /settings" or "load src/app.ts". */
  label: string;
  /** Source text of the handler argument. */
  text: string;
  at: Location;
}

export interface PackageUse {
  at: Location;
  ref: ExternalRef;
  /** The source text, e.g. "_.merge". */
  text: string;
  callerId: string;
  /**
   * "call": the package member is called directly, e.g. _.merge(a, b).
   * "escape": the package value is used in a way we don't follow, e.g.
   * passed as an argument, read dynamically (_[k]) or chained on (_.chain(x).merge()).
   */
  kind: "call" | "escape";
  detail?: string;
}

export interface CallGraph {
  root: string;
  files: string[];
  functions: Map<string, FunctionNode>;
  calls: CallSite[];
  edges: Map<string, Edge[]>;
  entries: EntryPoint[];
  packageUses: PackageUse[];
}

/** A vulnerable export of a package, e.g. "lodash#merge". */
export interface TargetSpec {
  package: string;
  exports: Array<{ subpath: string | null; member: string[] }>;
  label: string;
}

export interface PathStep {
  label: string;
  at: Location;
}

export type ReasonCode =
  | "PATH_FOUND"
  | "TARGET_NEVER_CALLED"
  | "NO_PATH_FROM_ENTRY"
  | "DYNAMIC_CODE"
  | "PACKAGE_REFERENCE_ESCAPES"
  | "MAY_BE_CALLED_DYNAMICALLY";

export interface Finding {
  target: string;
  verdict: Verdict;
  reasonCodes: ReasonCode[];
  path: PathStep[] | null;
  /** Constructs the analyzer could not follow that affected this verdict. */
  blockers: Array<{ at: Location; text: string; reason: string }>;
  limitations: string[];
  stats: {
    files: number;
    functions: number;
    calls: number;
    unresolvedCalls: number;
    entryPoints: number;
  };
}
