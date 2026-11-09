import { Node, type SourceFile, SyntaxKind } from "ts-morph";
import type { GraphBuilder } from "./callgraph.ts";
import { functionFromExpression, originOfExpression, unwrap } from "./resolve.ts";

const ROUTE_METHODS = new Set(["get", "post", "put", "delete", "patch", "options", "head", "all", "use"]);

/**
 * Finds Express route registrations (app.get, router.post, app.route("/x").put, app.use, ...)
 * and records each handler as an entry point.
 */
export function findExpressEntries(b: GraphBuilder, sf: SourceFile): void {
  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const callee = call.getExpression();
    if (!Node.isPropertyAccessExpression(callee)) continue;
    const method = callee.getName();
    if (!ROUTE_METHODS.has(method)) continue;
    const receiver = expressReceiver(callee.getExpression());
    if (!receiver) continue;

    const args = call.getArguments();
    let routePath = receiver.path;
    let first = 0;
    if (args[0] && isPathLike(args[0])) {
      routePath = args[0].getText().replace(/^["'`]|["'`]$/g, "");
      first = 1;
    }
    // app.get("setting") reads a config value; it isn't a route.
    if (method === "get" && args.length === first) continue;

    const label = `${method.toUpperCase()} ${routePath ?? (method === "use" ? "/" : "*")}`;
    for (const handler of flattenArrays(args.slice(first))) {
      if (expressReceiver(handler)) continue; // app.use(router): its own routes are found separately
      if (originOfExpression(handler)) continue; // a package's middleware, e.g. helmet
      if (Node.isCallExpression(handler) && originOfExpression(handler.getExpression())) {
        continue; // express.json(), cors()
      }
      const fn = b.appFunction(functionFromExpression(handler));
      b.graph.entries.push({
        kind: "route",
        functionId: fn ? fn.id : null,
        label,
        text: handler.getText(),
        at: b.loc(handler),
      });
    }
  }
}

function isPathLike(node: Node): boolean {
  if (
    Node.isStringLiteral(node) ||
    Node.isNoSubstitutionTemplateLiteral(node) ||
    Node.isRegularExpressionLiteral(node)
  ) {
    return true;
  }
  return Node.isArrayLiteralExpression(node) && node.getElements().every(isPathLike);
}

function flattenArrays(nodes: Node[]): Node[] {
  return nodes.flatMap((n) => (Node.isArrayLiteralExpression(n) ? flattenArrays(n.getElements()) : [n]));
}

/** express() or express.Router() / Router() from the "express" package. */
function isExpressFactoryCall(node: Node): boolean {
  if (!Node.isCallExpression(node)) return false;
  const ref = originOfExpression(node.getExpression());
  if (ref?.package !== "express") return false;
  const last = ref.member.at(-1);
  return ref.member.length === 0 || last === "Router" || last === "default";
}

/** Returns route info when `node` evaluates to an Express app or router. */
function expressReceiver(node: Node, depth = 0): { path: string | null } | null {
  if (depth > 5) return null;
  const expr = unwrap(node);

  // app.route("/users").get(handler)
  if (Node.isCallExpression(expr)) {
    const callee = expr.getExpression();
    if (Node.isPropertyAccessExpression(callee) && callee.getName() === "route") {
      if (!expressReceiver(callee.getExpression(), depth + 1)) return null;
      const arg = expr.getArguments()[0];
      return { path: arg ? arg.getText().replace(/^["'`]|["'`]$/g, "") : null };
    }
    return isExpressFactoryCall(expr) ? { path: null } : null;
  }

  if (!Node.isIdentifier(expr)) return null;
  const symbol = expr.getSymbol();
  if (!symbol) return null;
  const resolved = symbol.isAlias() ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
  for (const decl of resolved.getDeclarations()) {
    if (Node.isVariableDeclaration(decl)) {
      const init = decl.getInitializer();
      if (init && (isExpressFactoryCall(unwrap(init)) || expressReceiver(init, depth + 1))) {
        return { path: null };
      }
    }
    // function register(router: Router) { router.get(...) }
    if (Node.isParameterDeclaration(decl)) {
      const typeNode = decl.getTypeNode();
      if (Node.isTypeReference(typeNode)) {
        const typeName = typeNode.getTypeName();
        const ref = Node.isIdentifier(typeName) ? originOfExpression(typeName) : null;
        if (ref?.package === "express") return { path: null };
      }
    }
    // export default express.Router() in another file
    if (Node.isExportAssignment(decl) && isExpressFactoryCall(unwrap(decl.getExpression()))) {
      return { path: null };
    }
  }
  return null;
}
