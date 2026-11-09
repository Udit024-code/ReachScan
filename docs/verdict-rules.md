# Verdict rules and supported patterns

This is the contract for what ReachScan's verdicts mean. Each rule here is checked by a fixture in [`fixtures/dev`](../fixtures/dev); the fixture number is shown in brackets, e.g. [03].

Analyzer version: 0.3.0 · Report schema: 1

## The four verdicts

| Verdict         | Given when                                                                               | What to do                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **reachable**   | A call path from an entry point to the vulnerable export was found.                      | Fix first.                                                                                                                                             |
| **unreachable** | No path exists, and nothing the analyzer failed to follow could lead there.              | Lower priority; still shown.                                                                                                                           |
| **unknown**     | No path was found, but code the analyzer couldn't follow might reach it.                 | Review the listed blockers by hand.                                                                                                                    |
| **unavailable** | The scan failed, the project isn't supported, or no verified vulnerable function exists. | Treat as a normal alert. (Not produced by `reach` yet. `deps` already refuses unsupported projects with exit code 2; joining the two comes in week 8.) |

Two rules override everything else:

1. **Missing information never becomes "unreachable".** When unsure, the answer is unknown.
2. **"Reachable" means a call path exists**, not that the bug is proven exploitable.

## How a verdict is decided

1. **Parse.** Every non-test source file is loaded with the TypeScript compiler (ts-morph). Nothing is installed or run, and `node_modules` is never read.
2. **Resolve every call** to one of:
   - an **app function** (becomes a call-graph edge),
   - a **package export** such as `lodash.merge`,
   - **ignored**: builtins (`console.log`, `Array.prototype.map`), module loads, Express app/router methods, and methods on objects a package returned (these are also recorded as package escapes, see step 5),
   - **unresolved**, with a reason code (table below).
3. **Find entry points:** Express route handlers, plus every file's top-level code.
4. **Search** breadth-first from the entry points. Functions passed as arguments are assumed to be called by the function that receives them. If a call to the target export is reached → **reachable**, with the shortest path.
5. **No path?** Check whether something unfollowed could still reach the target. The answer is **unknown** if any of these holds:

   | Reason code                 | Condition                                                                                                                                                                                                                                        | Fixture   |
   | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
   | `DYNAMIC_CODE`              | `eval`, `new Function`, `require(variable)` or `import(variable)` runs in reachable code.                                                                                                                                                        | [06]      |
   | `PACKAGE_REFERENCE_ESCAPES` | The package value is used in a way we don't follow, in reachable code: passed as an argument, read dynamically (`_[k]`), read without being called (`const f = _.merge`), or a method is called on something it returned (`_.chain(x).merge()`). | [07] [14] |
   | `MAY_BE_CALLED_DYNAMICALLY` | A function that leads to the target call _escapes_ (stored in an object, a class method, assigned to `module.exports`, returned, or used as a value), **and** reachable code contains at least one unresolved call.                              | [03]      |

6. Otherwise → **unreachable**, with reason `TARGET_NEVER_CALLED` [02] [13] or `NO_PATH_FROM_ENTRY` [04].

### Why "unreachable" is safe even when some calls are unresolved

Almost every real app has calls the analyzer can't resolve. Without type definitions, even `res.json()` is one. If any unresolved call forced "unknown", nearly every finding would be unknown. Instead, the check asks whether an unresolved call could possibly land on the vulnerable code:

- **To call `merge`, code must get it from the `lodash` import.** If every use of that import is a direct, static call such as `_.uniq(...)`, nothing else can obtain `merge` [02].
- **An unresolved call can only land on a function that escapes.** Code that is never stored, passed or exported can only run through calls we resolved [04].

Known holes in this argument are listed under [Not handled yet](#not-handled-yet).

## Unresolved call reasons

| Reason                     | Example                                                                    |
| -------------------------- | -------------------------------------------------------------------------- |
| `DYNAMIC_PROPERTY_CALL`    | `handlers[action](req.body)`                                               |
| `UNKNOWN_RECEIVER`         | `res.json(x)` when `res` has no type                                       |
| `UNKNOWN_CALLEE`           | `fn()` where `fn` is a parameter or the result of a computation            |
| `CALL_ON_CALL_RESULT`      | `makeHandler()(req)`                                                       |
| `EVAL`                     | `eval(code)`, `new Function(code)`                                         |
| `DYNAMIC_REQUIRE`          | `require("./plugins/" + name)`                                             |
| `DYNAMIC_IMPORT`           | `import(name)`                                                             |
| `UNRESOLVED_ROUTE_HANDLER` | `app.get("/x", something)` where `something` can't be traced to a function |

## Supported patterns

### Imports of the vulnerable package

| Pattern                  | Example                                           | Handling                              | Fixture   |
| ------------------------ | ------------------------------------------------- | ------------------------------------- | --------- |
| Default import           | `import _ from "lodash"`                          | Resolved                              | [01]      |
| Namespace import         | `import * as lodash from "lodash"`                | Resolved                              | [08]      |
| Named / aliased import   | `import { merge as m } from "lodash"`             | Resolved                              | [05]      |
| Subpath import           | `import merge from "lodash/merge"`                | Resolved                              | [09]      |
| CommonJS require         | `const _ = require("lodash")`                     | Resolved                              | [02]      |
| Destructured require     | `const { merge: m } = require("lodash")`          | Resolved                              | [10]      |
| Inline require           | `require("lodash").merge(x)`                      | Resolved                              | —         |
| Re-export                | `export { merge as deepMerge } from "lodash"`     | Resolved                              | [05]      |
| `esModuleInterop` access | `_.default.merge(x)`                              | Resolved                              | unit test |
| Package passed around    | `run(_)`, `lib[op]()`                             | Unknown (`PACKAGE_REFERENCE_ESCAPES`) | [14]      |
| Wrapper / chain objects  | `_.chain(x).merge()`, `const w = _(x); w.merge()` | Unknown (`PACKAGE_REFERENCE_ESCAPES`) | [07]      |

### Calls inside the app

| Pattern                                  | Example                             | Handling                                       | Fixture |
| ---------------------------------------- | ----------------------------------- | ---------------------------------------------- | ------- |
| Direct call across files                 | `updateSettings(req.body)`          | Resolved                                       | [01]    |
| Callback argument                        | `items.forEach((x) => merge(a, x))` | Assumed called                                 | [05]    |
| `call` / `apply`                         | `fn.call(null, x)`                  | Resolved                                       | [10]    |
| Class method on an instance              | `controller.update(req, res)`       | Resolved                                       | [15]    |
| Relative require of an exported function | `require("./routes")(app)`          | Resolved                                       | [12]    |
| Default-exported handler                 | `export default function save()`    | Resolved                                       | [11]    |
| Dynamic property call                    | `handlers[action]()`                | Unknown if it could reach the target           | [03]    |
| Dynamic require / eval                   | `require(name)`                     | Unknown                                        | [06]    |
| Dependency injection, event emitters     | `emitter.on(evt, fn)`               | `fn` is assumed called by `on` (callback rule) | —       |

### Express entry points

| Pattern                     | Example                                                               | Handling                                          | Fixture   |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------- | --------- |
| App and router methods      | `app.get`, `router.post`, `.put`, `.patch`, `.delete`, `.all`, `.use` | Entry point                                       | [01] [08] |
| `route()` chains            | `router.route("/p").put(h)`                                           | Entry point                                       | [05]      |
| Handler arrays              | `router.put("/s", [auth, handler])`                                   | Each one is an entry point                        | [15]      |
| Typed registrar parameter   | `function register(app: Express)`                                     | Entry point                                       | [11]      |
| Untyped registrar parameter | `module.exports = (app) => app.post(...)`                             | Handler reached as a callback; no route label yet | [12]      |
| Package middleware          | `express.json()`, `cors()`, `helmet`                                  | Skipped (package code)                            | [01]      |

### Files

Test code is not part of the running app and is **not scanned**: `*.test.*`, `*.spec.*`, `__tests__/`, `test/`, `tests/` [13]. Also excluded: `node_modules/`, `dist/`, `build/`, `coverage/`, `*.d.ts`.

## Not handled yet

These are real gaps. Each one is either already fail-closed (gives unknown) or listed as a limitation on every finding.

- **Top-level code of every file is assumed to run**, even files nothing imports. This can only produce extra "reachable" results, never a false "unreachable". (Week 6: start from the main file's import graph.)
- **Library internals.** Only direct calls to the named export are matched. If the app calls `_.mergeWith` and that calls the vulnerable `baseMergeDeep` internally, it isn't linked yet. **This can produce a false "unreachable"** until week 7. Every finding carries this limitation.
- **Transitive dependencies.** Paths through other packages (app → express → qs) aren't followed. Every finding carries this limitation.
- **Route prefixes** from `app.use("/api", router)` aren't added to labels.
- **Untyped registrar parameters** aren't recognised as Express [12]. The handler is still reached, but the path starts at the file instead of the route.
- **Getters, setters, `Proxy`, `toString`/`valueOf` and other implicit calls** aren't modelled as calls. Accessors and class methods are treated as escaping, which limits the damage.
- **Globals.** A package stored on `global` or `globalThis` and used elsewhere isn't traced.

## Report format (schema 1)

`reachscan reach <dir> --target pkg#export --format json` prints:

```jsonc
{
  "schemaVersion": 1,
  "analyzer": { "name": "reachscan", "version": "0.3.0" },
  "generatedAt": "2026-11-09T12:00:00.000Z",
  "project": { "name": "shop-api" }, // folder name only, never an absolute path
  "findings": [
    {
      "target": "lodash#merge",
      "verdict": "reachable", // reachable | unreachable | unknown | unavailable
      "reasonCodes": ["PATH_FOUND"],
      "path": [
        // null unless reachable
        {
          "label": "POST /settings → <anonymous>",
          "at": { "file": "src/routes/settings.ts", "line": 6, "column": 26 }
        },
        { "label": "updateSettings()", "at": { "file": "src/routes/settings.ts", "line": 7, "column": 17 } },
        { "label": "_.merge()", "at": { "file": "src/services/user.ts", "line": 6, "column": 3 } }
      ],
      "blockers": [], // for unknown: what couldn't be followed, with file/line and reason
      "limitations": ["..."],
      "stats": { "files": 3, "functions": 2, "calls": 10, "unresolvedCalls": 1, "entryPoints": 1 }
    }
  ]
}
```

All file paths are repo-relative with forward slashes, so reports are identical on Windows and Linux.

`schemaVersion` changes when a field is renamed or removed, or its meaning changes. Adding optional fields doesn't change it.

## Adding a fixture

1. Create `fixtures/dev/NN-<verdict>-<pattern>/` with a `package.json` and a `src/` folder.
2. Add `expected.json`:

   ```json
   {
     "description": "What pattern this checks and why the verdict is right.",
     "target": "lodash#merge",
     "verdict": "reachable",
     "reasonCodes": ["PATH_FOUND"],
     "pathLabels": ["POST /x", "helper()", "_.merge()"],
     "blockerTexts": []
   }
   ```

   `pathLabels` must each appear in a path step, in order. `blockerTexts` must each appear in a blocker.
3. Run `npm test`. The suite also fails if any fixture that isn't expected to be unreachable comes out as unreachable.

The held-out benchmark (week 10) is written separately and is never used while changing the analyzer.
