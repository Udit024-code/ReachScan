import { builtinModules } from "node:module";
import {
  type ArrowFunction,
  type ConstructorDeclaration,
  type FunctionDeclaration,
  type FunctionExpression,
  type GetAccessorDeclaration,
  type Identifier,
  type MethodDeclaration,
  type Symbol as MorphSymbol,
  Node,
  type SetAccessorDeclaration,
  SyntaxKind,
} from "ts-morph";
import type { ExternalRef } from "./types.ts";

const MAX_DEPTH = 10;
const BUILTINS = new Set(builtinModules);

export type FunctionLike =
  | FunctionDeclaration
  | FunctionExpression
  | ArrowFunction
  | MethodDeclaration
  | ConstructorDeclaration
  | GetAccessorDeclaration
  | SetAccessorDeclaration;

export function isFunctionLike(node: Node): node is FunctionLike {
  return (
    Node.isFunctionDeclaration(node) ||
    Node.isFunctionExpression(node) ||
    Node.isArrowFunction(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isConstructorDeclaration(node) ||
    Node.isGetAccessorDeclaration(node) ||
    Node.isSetAccessorDeclaration(node)
  );
}

/** Strips wrappers that don't change which value an expression refers to. */
export function unwrap(node: Node): Node {
  let current = node;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isNonNullExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isTypeAssertion(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/** "lodash/merge" → { package: "lodash", subpath: "merge" }. Relative paths and Node builtins → null. */
export function parseBareSpecifier(specifier: string): { package: string; subpath: string | null } | null {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("node:") ||
    /^[a-zA-Z]:/.test(specifier)
  ) {
    return null;
  }
  const parts = specifier.split("/");
  const nameParts = specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
  const name = nameParts.join("/");
  if (!name || BUILTINS.has(name)) return null;
  const rest = parts.slice(nameParts.length).join("/");
  return { package: name, subpath: rest || null };
}

function stringLiteralValue(node: Node | undefined): string | null {
  if (!node) return null;
  if (Node.isStringLiteral(node) || Node.isNoSubstitutionTemplateLiteral(node)) {
    return node.getLiteralValue();
  }
  return null;
}

/** `require("x")` → "x". Returns null for anything else, including require(variable). */
export function requireSpecifier(node: Node): string | null {
  if (!Node.isCallExpression(node)) return null;
  const callee = node.getExpression();
  if (!Node.isIdentifier(callee) || callee.getText() !== "require") return null;
  if (hasAppDeclaration(callee)) return null; // a local function that happens to be called require
  return stringLiteralValue(node.getArguments()[0]);
}

/** `import("x")` → "x". */
export function dynamicImportSpecifier(node: Node): string | null {
  if (!Node.isCallExpression(node)) return null;
  if (node.getExpression().getKind() !== SyntaxKind.ImportKeyword) return null;
  return stringLiteralValue(node.getArguments()[0]);
}

function isInsideNodeModules(node: Node): boolean {
  return node.getSourceFile().getFilePath().includes("/node_modules/");
}

/** True when the identifier is declared in the scanned app's own code (not lib.d.ts or a package). */
export function hasAppDeclaration(id: Identifier): boolean {
  const symbol = id.getSymbol();
  if (!symbol) return false;
  return symbol
    .getDeclarations()
    .some((d) => !d.getSourceFile().isDeclarationFile() && !isInsideNodeModules(d));
}

function withMember(ref: ExternalRef, member: string): ExternalRef {
  return { ...ref, member: [...ref.member, member] };
}

/**
 * Traces an expression back to an npm package, if it came from one.
 * `_.merge` with `import _ from "lodash"` → lodash, member ["merge"].
 */
export function originOfExpression(node: Node, depth = 0): ExternalRef | null {
  if (depth > MAX_DEPTH) return null;
  const expr = unwrap(node);

  if (Node.isIdentifier(expr)) return originOfIdentifier(expr, depth + 1);

  if (Node.isPropertyAccessExpression(expr)) {
    const base = originOfExpression(expr.getExpression(), depth + 1);
    return base ? withMember(base, expr.getName()) : null;
  }

  if (Node.isAwaitExpression(expr)) {
    const spec = dynamicImportSpecifier(unwrap(expr.getExpression()));
    const parsed = spec ? parseBareSpecifier(spec) : null;
    return parsed ? { ...parsed, member: [] } : null;
  }

  const spec = requireSpecifier(expr);
  const parsed = spec ? parseBareSpecifier(spec) : null;
  return parsed ? { ...parsed, member: [] } : null;
}

/**
 * Traces an object back to the package call that created it, e.g. `w` in
 * `const w = _.chain(x)`, or `app` in `const app = express()`.
 * Methods on such objects are package code we don't model yet.
 */
export function packageResultOrigin(node: Node, depth = 0): ExternalRef | null {
  if (depth > MAX_DEPTH) return null;
  const expr = unwrap(node);
  if (Node.isCallExpression(expr) || Node.isNewExpression(expr)) {
    const callee = expr.getExpression();
    return originOfExpression(callee) ?? packageResultOrigin(callee, depth + 1);
  }
  if (Node.isPropertyAccessExpression(expr) || Node.isAwaitExpression(expr)) {
    return packageResultOrigin(expr.getExpression(), depth + 1);
  }
  if (Node.isIdentifier(expr)) {
    for (const decl of expr.getSymbol()?.getDeclarations() ?? []) {
      if (!Node.isVariableDeclaration(decl)) continue;
      const init = decl.getInitializer();
      const ref = init ? packageResultOrigin(init, depth + 1) : null;
      if (ref) return ref;
    }
  }
  return null;
}

function valueSymbolOf(id: Identifier): MorphSymbol | undefined {
  const parent = id.getParent();
  // In `{ merge }`, the identifier's own symbol is the new property; we want the variable it reads.
  if (Node.isShorthandPropertyAssignment(parent)) {
    return parent.getValueSymbol() ?? id.getSymbol();
  }
  return id.getSymbol();
}

export function originOfIdentifier(id: Identifier, depth = 0): ExternalRef | null {
  let symbol = valueSymbolOf(id);
  const seen = new Set<unknown>();
  while (symbol && !seen.has(symbol.compilerSymbol)) {
    seen.add(symbol.compilerSymbol);
    for (const decl of symbol.getDeclarations()) {
      const ref = externalFromDeclaration(decl, depth + 1);
      if (ref) return ref;
    }
    // Follow one alias hop at a time so re-exports like `export { merge } from "lodash"` are seen.
    symbol = symbol.isAlias() ? symbol.getImmediatelyAliasedSymbol() : undefined;
  }
  return null;
}

function externalFromDeclaration(decl: Node, depth: number): ExternalRef | null {
  if (depth > MAX_DEPTH) return null;

  if (Node.isImportSpecifier(decl)) {
    const parsed = parseBareSpecifier(decl.getImportDeclaration().getModuleSpecifierValue());
    if (!parsed) return null;
    const name = decl.getName();
    return { ...parsed, member: name === "default" ? [] : [name] };
  }

  if (Node.isImportClause(decl) || Node.isNamespaceImport(decl)) {
    const importDecl = decl.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    const parsed = importDecl ? parseBareSpecifier(importDecl.getModuleSpecifierValue()) : null;
    return parsed ? { ...parsed, member: [] } : null;
  }

  if (Node.isExportSpecifier(decl)) {
    const spec = decl.getExportDeclaration().getModuleSpecifierValue();
    const parsed = spec ? parseBareSpecifier(spec) : null;
    if (!parsed) return null;
    const name = decl.getName();
    return { ...parsed, member: name === "default" ? [] : [name] };
  }

  if (Node.isNamespaceExport(decl)) {
    const exportDecl = decl.getFirstAncestorByKind(SyntaxKind.ExportDeclaration);
    const spec = exportDecl?.getModuleSpecifierValue();
    const parsed = spec ? parseBareSpecifier(spec) : null;
    return parsed ? { ...parsed, member: [] } : null;
  }

  if (Node.isImportEqualsDeclaration(decl)) {
    const ref = decl.getModuleReference();
    if (!Node.isExternalModuleReference(ref)) return null;
    const spec = stringLiteralValue(ref.getExpression());
    const parsed = spec ? parseBareSpecifier(spec) : null;
    return parsed ? { ...parsed, member: [] } : null;
  }

  if (Node.isVariableDeclaration(decl)) {
    const init = decl.getInitializer();
    return init ? originOfExpression(init, depth + 1) : null;
  }

  if (Node.isBindingElement(decl)) {
    // Only one level of destructuring: const { merge: m } = require("lodash")
    const pattern = decl.getParent();
    const varDecl = pattern?.getParent();
    if (!Node.isVariableDeclaration(varDecl)) return null;
    const init = varDecl.getInitializer();
    if (!init) return null;
    const base = originOfExpression(init, depth + 1);
    if (!base) return null;
    const name = decl.getPropertyNameNode()?.getText() ?? decl.getName();
    return withMember(base, name);
  }

  return null;
}

/** Resolves an expression to the function in the app it refers to, if it can be traced. */
export function functionFromExpression(node: Node, depth = 0): FunctionLike | null {
  if (depth > MAX_DEPTH) return null;
  const expr = unwrap(node);
  if (isFunctionLike(expr)) return expr;
  if (Node.isIdentifier(expr)) return functionFromSymbol(valueSymbolOf(expr), depth + 1);
  if (Node.isPropertyAccessExpression(expr)) {
    return functionFromSymbol(expr.getNameNode().getSymbol(), depth + 1);
  }
  return null;
}

export function functionFromSymbol(symbol: MorphSymbol | undefined, depth = 0): FunctionLike | null {
  if (!symbol || depth > MAX_DEPTH) return null;
  const resolved = symbol.isAlias() ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
  for (const decl of resolved.getDeclarations()) {
    const fn = functionFromDeclaration(decl, depth + 1);
    if (fn) return fn;
  }
  return null;
}

function functionFromDeclaration(decl: Node, depth: number): FunctionLike | null {
  if (depth > MAX_DEPTH) return null;
  if (isFunctionLike(decl)) return decl.getBody() ? decl : null;

  if (
    Node.isVariableDeclaration(decl) ||
    Node.isPropertyAssignment(decl) ||
    Node.isPropertyDeclaration(decl)
  ) {
    const init = decl.getInitializer();
    return init ? functionFromExpression(init, depth + 1) : null;
  }
  if (Node.isShorthandPropertyAssignment(decl)) {
    return functionFromSymbol(decl.getValueSymbol(), depth + 1);
  }
  if (Node.isExportAssignment(decl)) {
    return functionFromExpression(decl.getExpression(), depth + 1);
  }
  if (Node.isBinaryExpression(decl)) {
    return functionFromExpression(decl.getRight(), depth + 1);
  }
  // CommonJS: exports.update = function () {}
  if (Node.isPropertyAccessExpression(decl)) {
    const parent = decl.getParent();
    if (Node.isBinaryExpression(parent) && parent.getLeft() === decl) {
      return functionFromExpression(parent.getRight(), depth + 1);
    }
  }
  if (Node.isClassDeclaration(decl) || Node.isClassExpression(decl)) {
    return decl.getConstructors().find((c) => c.getBody()) ?? null;
  }
  return null;
}
