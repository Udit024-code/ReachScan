# ReachScan

ReachScan tells you which vulnerable dependencies your JavaScript/TypeScript Express app actually calls. It shows the call path as evidence, and it answers **unknown** instead of guessing when it can't be sure.

> Status: week 2. The call-graph core works on 15 fixture apps for a single target such as `lodash#merge`, with a versioned JSON report. Lockfile reading, OSV matching and AI mapping come next.
>
> **[Verdict rules and supported patterns →](docs/verdict-rules.md)**

## Quick start

Requires Node 24+. The repo uses npm workspaces.

```bash
npm install
npm test
npm run reachscan -- reach fixtures/dev/01-reachable-direct --target lodash#merge
npm run reachscan -- calls fixtures/dev/01-reachable-direct
npm run reachscan -- reach fixtures/dev/01-reachable-direct --target lodash#merge --format json --out report.json
```

Example output:

```
Target:  lodash#merge
Verdict: REACHABLE  [PATH_FOUND]
Path:
   POST /settings → <anonymous>    src/routes/settings.ts:6
   → updateSettings()              src/routes/settings.ts:7
   → _.merge()                     src/services/user.ts:6
```

## Verdicts

| Verdict     | Meaning                                                                                              |
| ----------- | ---------------------------------------------------------------------------------------------------- |
| reachable   | A call path from an entry point to the vulnerable function was found.                                |
| unreachable | No path exists, and nothing the analyzer failed to follow could lead there.                          |
| unknown     | No path was found, but code the analyzer couldn't follow might reach it. The report lists that code. |
| unavailable | The scan failed or the project isn't supported (not produced yet).                                   |

A false "unreachable" is the worst possible mistake, so when in doubt the answer is unknown. The fixture test suite fails if any fixture gets a false "unreachable".

## How "unreachable" is decided

Short version below; the full rules, reason codes and supported-pattern tables are in [docs/verdict-rules.md](docs/verdict-rules.md).

1. Every call in the app is resolved with the TypeScript compiler (ts-morph) to an app function, a package export, a builtin, or **unresolved** (for example `handlers[action]()` or `require(name)`).
2. Express route handlers and every file's top-level code are entry points. Functions passed as arguments are assumed to be called.
3. Breadth-first search from the entry points looks for a call to the target export. If one is found, the verdict is reachable and the shortest path is shown.
4. If there's no path, the target can only be reached through code we didn't follow. It is **unknown** if any of these is true:
   - `eval`, `require(variable)` or `import(variable)` runs in reachable code;
   - the package value escapes, for example `_[name]`, passing `_` to another function, or chaining `_.chain(x).merge()`;
   - a function that leads to the target is stored or passed somewhere we don't follow (an object property, a class method, `module.exports`), **and** reachable code contains an unresolved call.
5. Otherwise the target is **unreachable**.

The last rule is why a project that only uses `_.uniq` is unreachable even though `res.json()` can't be resolved without type definitions. To call `merge`, code has to get it from the `lodash` binding, and every use of that binding is a direct `_.uniq(...)` call.

## Layout

```
packages/core   analyzer: project loading, call graph, Express entry points, verdicts
packages/cli    `reachscan` command line
fixtures/dev    small apps with an expected.json each (verdict, reason codes, path)
                (fixtures are only parsed, never installed or run)
docs/           verdict rules, supported patterns, report format
```

## Known limitations

- Reachable means a call path exists, not that the bug is exploitable.
- Every non-test file's top-level code is assumed to run.
- Only direct calls to the named export are matched. Until the library's internal call graph is linked (week 7), a call to another export that uses the vulnerable code internally (e.g. `_.mergeWith`) is missed.
- Paths through other packages (transitive dependencies) aren't followed yet.

The full list is in [docs/verdict-rules.md](docs/verdict-rules.md#not-handled-yet).

## License

MIT
