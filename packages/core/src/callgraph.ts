import { type CallExpression, type NewExpression, Node, type SourceFile, SyntaxKind } from "ts-morph";
import { findExpressEntries, isExpressObject } from "./express.ts";
import { loadProject, relativePath } from "./project.ts";
import {
  dynamicImportSpecifier,
  type FunctionLike,
  functionFromExpression,
  functionFromSymbol,
  hasAppDeclaration,
  isFunctionLike,
  originOfExpression,
  originOfIdentifier,
  packageResultOrigin,
  parseBareSpecifier,
  requireSpecifier,
  unwrap,
} from "./resolve.ts";
import type {
  CallGraph,
  CallTarget,
  Edge,
  ExternalRef,
  FunctionNode,
  Location,
  PackageUse,
} from "./types.ts";

/** Shared state while building one graph. */
export class GraphBuilder {
  readonly root: string;
  readonly graph: CallGraph;

  constructor(root: string, files: SourceFile[]) {
    this.root = root;
    this.graph = {
      root,
      files: files.map((sf) => relativePath(root, sf.getFilePath())),
      functions: new Map(),
      calls: [],
      edges: new Map(),
      entries: [],
      packageUses: [],
    };
  }

  loc(node: Node): Location {
    const sf = node.getSourceFile();
    const { line, column } = sf.getLineAndColumnAtPos(node.getStart());
    return { file: relativePath(this.root, sf.getFilePath()), line, column };
  }

  moduleId(sf: SourceFile): string {
    return `${relativePath(this.root, sf.getFilePath())}#<module>`;
  }

  functionId(fn: FunctionLike): string {
    const at = this.loc(fn);
    return `${at.file}#${functionName(fn)}@${at.line}:${at.column}`;
  }

  /** The function (or module top level) that a node's code runs in. */
  callerId(node: Node): string {
    const fn = node.getFirstAncestor((a) => isFunctionLike(a));
    return fn && isFunctionLike(fn) ? this.functionId(fn) : this.moduleId(node.getSourceFile());
  }

  /** The node for a function in the scanned app, or undefined for library/builtin code. */
  appFunction(fn: FunctionLike | null): FunctionNode | undefined {
    return fn ? this.graph.functions.get(this.functionId(fn)) : undefined;
  }

  addEdge(from: string, edge: Edge): void {
    const list = this.graph.edges.get(from);
    if (list) list.push(edge);
    else this.graph.edges.set(from, [edge]);
  }

  markEscape(node: FunctionNode, reason: string): void {
    if (node.escapes) return;
    node.escapes = true;
    node.escapeReason = reason;
  }
}

export function buildCallGraph(rootDir: string): CallGraph {
  const { project, root } = loadProject(rootDir);
  const files = project.getSourceFiles();
  const b = new GraphBuilder(root, files);

  for (const sf of files) addFunctionNodes(b, sf);
  for (const sf of files) {
    for (const call of sf.getDescendants()) {
      if (Node.isCallExpression(call) || Node.isNewExpression(call)) handleCall(b, call);
    }
  }
  for (const sf of files) scanIdentifiers(b, sf);
  for (const sf of files) findExpressEntries(b, sf);

  // Week-1 simplification: every file's top-level code is assumed to run.
  for (const sf of files) {
    b.graph.entries.push({
      kind: "module",
      functionId: b.moduleId(sf),
      label: `load ${relativePath(root, sf.getFilePath())}`,
      text: "",
      at: { file: relativePath(root, sf.getFilePath()), line: 1, column: 1 },
    });
  }
  return b.graph;
}

function functionName(fn: FunctionLike): string {
  const className = () => {
    const cls = fn.getParent();
    return (Node.isClassDeclaration(cls) || Node.isClassExpression(cls)) && cls.getName()
      ? cls.getName()
      : "<class>";
  };
  if (Node.isConstructorDeclaration(fn)) return `${className()}.constructor`;
  if (
    Node.isMethodDeclaration(fn) ||
    Node.isGetAccessorDeclaration(fn) ||
    Node.isSetAccessorDeclaration(fn)
  ) {
    const parent = fn.getParent();
    const prefix = Node.isObjectLiteralExpression(parent) ? "" : `${className()}.`;
    return `${prefix}${fn.getName()}`;
  }
  if (Node.isFunctionDeclaration(fn)) return fn.getName() ?? "default";
  if (Node.isFunctionExpression(fn) && fn.getName()) return fn.getName() as string;

  let parent = fn.getParent();
  while (parent && Node.isParenthesizedExpression(parent)) parent = parent.getParent();
  if (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent)) {
    return parent.getName();
  }
  if (Node.isBinaryExpression(parent)) return parent.getLeft().getText();
  if (Node.isExportAssignment(parent)) return "default";
  return "<anonymous>";
}

/** Why a function expression's position means it may be called from code we don't follow. */
function syntacticEscape(fn: FunctionLike): string | undefined {
  if (
    Node.isMethodDeclaration(fn) ||
    Node.isGetAccessorDeclaration(fn) ||
    Node.isSetAccessorDeclaration(fn)
  ) {
    return "method or accessor (may be called through any reference to its object)";
  }
  if (Node.isFunctionDeclaration(fn) || Node.isConstructorDeclaration(fn)) return undefined;

  let child: Node = fn;
  let parent = fn.getParent();
  while (parent && Node.isParenthesizedExpression(parent)) {
    child = parent;
    parent = parent.getParent();
  }
  if (Node.isCallExpression(parent) || Node.isNewExpression(parent)) {
    return undefined; // callback argument or IIFE; both get explicit edges
  }
  if (Node.isVariableDeclaration(parent) && parent.getInitializer() === child) return undefined;
  if (Node.isExportAssignment(parent)) return undefined;
  if (Node.isPropertyAssignment(parent)) return "stored as an object property";
  if (Node.isBinaryExpression(parent)) return `assigned to ${parent.getLeft().getText()}`;
  if (Node.isReturnStatement(parent)) return "returned from a function";
  return "used as a value";
}

function addFunctionNodes(b: GraphBuilder, sf: SourceFile): void {
  const moduleId = b.moduleId(sf);
  b.graph.functions.set(moduleId, {
    id: moduleId,
    name: "<module>",
    at: { file: relativePath(b.root, sf.getFilePath()), line: 1, column: 1 },
    isModule: true,
    escapes: false,
  });
  for (const node of sf.getDescendants()) {
    if (!isFunctionLike(node) || !node.getBody()) continue;
    const id = b.functionId(node);
    const escapeReason = syntacticEscape(node);
    b.graph.functions.set(id, {
      id,
      name: functionName(node),
      at: b.loc(node),
      isModule: false,
      escapes: escapeReason !== undefined,
      ...(escapeReason ? { escapeReason } : {}),
    });
  }
}

function handleCall(b: GraphBuilder, call: CallExpression | NewExpression): void {
  const callerId = b.callerId(call);
  const at = b.loc(call);
  const calleeExpr = call.getExpression();
  const target = resolveCallee(b, call);
  b.graph.calls.push({ at, callee: calleeExpr.getText(), callerId, target });
  if (target.kind === "internal") {
    b.addEdge(callerId, { to: target.functionId, at, kind: "call" });
  }

  // Functions passed as arguments are assumed to be called by the callee.
  for (const arg of call.getArguments()) {
    const fn = b.appFunction(functionFromExpression(arg));
    if (fn) b.addEdge(callerId, { to: fn.id, at: b.loc(arg), kind: "callback" });
  }

  // require("lodash").merge(x) — a package use that doesn't go through a named binding.
  const spec = requireSpecifier(call) ?? dynamicImportSpecifier(call);
  const parsed = spec ? parseBareSpecifier(spec) : null;
  if (parsed && !isBindingInitializer(call)) {
    classifyPackageUse(b, call, { ...parsed, member: [] });
  }
}

function resolveCallee(b: GraphBuilder, call: CallExpression | NewExpression): CallTarget {
  const rawCallee = call.getExpression();
  const callee = unwrap(rawCallee);

  if (callee.getKind() === SyntaxKind.ImportKeyword) {
    return dynamicImportSpecifier(call) !== null
      ? { kind: "ignored", why: "module load" }
      : { kind: "unresolved", reason: "DYNAMIC_IMPORT" };
  }
  if (Node.isIdentifier(callee) && !hasAppDeclaration(callee)) {
    const name = callee.getText();
    if (name === "require") {
      return requireSpecifier(call) !== null
        ? { kind: "ignored", why: "module load" }
        : { kind: "unresolved", reason: "DYNAMIC_REQUIRE" };
    }
    if (name === "eval" || name === "Function") return { kind: "unresolved", reason: "EVAL" };
  }

  const ref = originOfExpression(callee);
  if (ref) return { kind: "external", ref };

  // w.merge() with const w = _.chain(x), or app.listen() with const app = express().
  if (Node.isPropertyAccessExpression(callee)) {
    const resultRef = packageResultOrigin(callee.getExpression());
    if (resultRef) {
      b.graph.packageUses.push({
        at: b.loc(callee),
        ref: resultRef,
        text: callee.getText(),
        callerId: b.callerId(call),
        kind: "escape",
        detail: "result of the call is used further (method on an object the package returned)",
      });
      return { kind: "ignored", why: `method on an object returned by ${resultRef.package}` };
    }
  }

  // app.post(...) where app is a parameter typed as Express. Handlers passed in get callback edges.
  if (Node.isPropertyAccessExpression(callee) && isExpressObject(callee.getExpression())) {
    return { kind: "ignored", why: "Express app/router API" };
  }

  if (isFunctionLike(callee)) {
    const fn = b.appFunction(callee);
    if (fn) return { kind: "internal", functionId: fn.id };
  }
  // require("./routes")(app): call the function routes.js exports.
  if (Node.isCallExpression(callee)) {
    const fn = b.appFunction(functionFromExpression(callee));
    if (fn) return { kind: "internal", functionId: fn.id };
  }
  if (Node.isCallExpression(callee) || Node.isNewExpression(callee)) {
    return { kind: "unresolved", reason: "CALL_ON_CALL_RESULT" };
  }
  if (Node.isElementAccessExpression(callee)) {
    return { kind: "unresolved", reason: "DYNAMIC_PROPERTY_CALL" };
  }

  if (Node.isPropertyAccessExpression(callee) || Node.isIdentifier(callee)) {
    // fn.call(thisArg, ...) / fn.apply(thisArg, args)
    if (Node.isPropertyAccessExpression(callee) && ["call", "apply"].includes(callee.getName())) {
      const fn = b.appFunction(functionFromExpression(callee.getExpression()));
      if (fn) return { kind: "internal", functionId: fn.id };
    }
    const symbol = Node.isIdentifier(callee) ? callee.getSymbol() : callee.getNameNode().getSymbol();
    if (!symbol) {
      return {
        kind: "unresolved",
        reason: Node.isPropertyAccessExpression(callee) ? "UNKNOWN_RECEIVER" : "UNKNOWN_CALLEE",
      };
    }
    const fn = b.appFunction(functionFromSymbol(symbol));
    if (fn) return { kind: "internal", functionId: fn.id };

    const resolved = symbol.isAlias() ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
    const decls = resolved.getDeclarations();
    if (decls.length > 0 && decls.every((d) => d.getSourceFile().isDeclarationFile())) {
      return { kind: "ignored", why: "builtin or typed library API" };
    }
    if (decls.some((d) => Node.isClassDeclaration(d) || Node.isClassExpression(d))) {
      return { kind: "ignored", why: "class without a constructor" };
    }
  }
  return { kind: "unresolved", reason: "UNKNOWN_CALLEE" };
}

/** True for `const x = <node>` and `const { a } = <node>`, which create names we trace separately. */
function isBindingInitializer(node: Node): boolean {
  let child: Node = node;
  let parent = node.getParent();
  while (parent && (Node.isParenthesizedExpression(parent) || Node.isAwaitExpression(parent))) {
    child = parent;
    parent = parent.getParent();
  }
  return Node.isVariableDeclaration(parent) && parent.getInitializer() === child;
}

/**
 * Records how a value from a package is used. Only a direct call with a static
 * member name (`_.merge(...)`) is fully understood; anything else is an escape.
 */
function classifyPackageUse(b: GraphBuilder, start: Node, base: ExternalRef): void {
  let node: Node = start;
  const member = [...base.member];
  for (;;) {
    const parent = node.getParent();
    if (Node.isPropertyAccessExpression(parent) && parent.getExpression() === node) {
      member.push(parent.getName());
      node = parent;
    } else if (Node.isParenthesizedExpression(parent) || Node.isNonNullExpression(parent)) {
      node = parent;
    } else {
      break;
    }
  }
  const ref: ExternalRef = { ...base, member };
  const parent = node.getParent();
  const use = (kind: PackageUse["kind"], detail?: string): void => {
    b.graph.packageUses.push({
      at: b.loc(node),
      ref,
      text: node.getText(),
      callerId: b.callerId(node),
      kind,
      ...(detail ? { detail } : {}),
    });
  };

  if ((Node.isCallExpression(parent) || Node.isNewExpression(parent)) && parent.getExpression() === node) {
    // Methods called on the result (_.chain(x).merge()) are recorded by resolveCallee.
    use("call");
    return;
  }
  if (isBindingInitializer(node)) return; // const m = _.merge — uses of m are traced on their own
  if (Node.isTypeOfExpression(parent)) return;
  if (Node.isElementAccessExpression(parent) && parent.getExpression() === node) {
    use("escape", "dynamic property access");
    return;
  }
  if (Node.isCallExpression(parent) || Node.isNewExpression(parent)) {
    use("escape", "passed as an argument");
    return;
  }
  use("escape", "used as a value");
}

function isDeclarationName(id: Node): boolean {
  const parent = id.getParent();
  if (!parent || Node.isShorthandPropertyAssignment(parent)) return false;
  if (Node.isPropertyAccessExpression(parent)) return parent.getNameNode() === id;
  if (Node.isBindingElement(parent)) {
    return parent.getNameNode() === id || parent.getPropertyNameNode() === id;
  }
  if (
    Node.isImportSpecifier(parent) ||
    Node.isExportSpecifier(parent) ||
    Node.isImportClause(parent) ||
    Node.isNamespaceImport(parent) ||
    Node.isNamespaceExport(parent) ||
    Node.isQualifiedName(parent) ||
    Node.isTypeReference(parent) ||
    Node.isTypeQuery(parent) ||
    Node.isLabeledStatement(parent) ||
    Node.isBreakStatement(parent) ||
    Node.isContinueStatement(parent)
  ) {
    return true;
  }
  const withName = parent as Node & { getNameNode?: () => Node | undefined };
  if (typeof withName.getNameNode === "function") {
    try {
      return withName.getNameNode() === id;
    } catch {
      return false;
    }
  }
  return false;
}

/** Finds package uses and functions that are referenced as values (and so may be called dynamically). */
function scanIdentifiers(b: GraphBuilder, sf: SourceFile): void {
  for (const id of sf.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (isDeclarationName(id)) continue;
    const parent = id.getParent();

    const ref = originOfIdentifier(id);
    if (ref) {
      classifyPackageUse(b, id, ref);
      continue;
    }

    if ((Node.isCallExpression(parent) || Node.isNewExpression(parent)) && parent.getExpression() === id) {
      continue; // direct call: an edge was added in handleCall
    }
    const fn = b.appFunction(functionFromExpression(id));
    if (!fn) continue;
    if (
      (Node.isCallExpression(parent) || Node.isNewExpression(parent)) &&
      parent.getArguments().includes(id)
    ) {
      continue; // callback: an edge was added in handleCall
    }
    if (
      Node.isPropertyAccessExpression(parent) &&
      parent.getExpression() === id &&
      ["call", "apply"].includes(parent.getName())
    ) {
      continue;
    }
    if (Node.isExportSpecifier(parent) || Node.isExportAssignment(parent)) continue;
    if (Node.isVariableDeclaration(parent) && parent.getInitializer() === id) continue;
    const at = b.loc(id);
    b.markEscape(fn, `referenced as a value at ${at.file}:${at.line}`);
  }
}
