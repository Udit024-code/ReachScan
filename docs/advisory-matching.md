# Dependencies and advisory matching

`reachscan deps <dir>` answers the first question of a scan: **which installed packages have known advisories?** It matches by version only. Whether the app calls the vulnerable code is a separate question, answered by `reachscan reach` (see [verdict-rules.md](verdict-rules.md)).

```bash
npm run reachscan -- deps path/to/project
npm run reachscan -- deps path/to/project --format json --out deps.json
```

## Reading the lockfile

Only npm's `package-lock.json` is read, and nothing is installed or run.

| Situation                                      | Result                                                                         |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `lockfileVersion` 2 or 3 (npm 7+)              | Read                                                                           |
| `lockfileVersion` 1 (npm 6 and older)          | Unsupported, with a message to regenerate it                                   |
| `yarn.lock`, `pnpm-lock.yaml`, `bun.lock` only | Unsupported; the message names the file found                                  |
| No lockfile                                    | Unsupported, with the command to create one: `npm install --package-lock-only` |
| Lockfile over 50 MB or invalid JSON            | Unsupported                                                                    |

For each entry under `node_modules/` the reader records:

- **Exact version and install path**, e.g. `node_modules/send/node_modules/ms`. Every copy is kept, so two versions of the same package are both checked.
- **The real package name.** For an npm alias (`"old": "npm:new@2"`), the advisory lookup uses `new`.
- **direct**: the package is installed at the top level and declared in the root `package.json` or a workspace `package.json`.
- **dev**: npm marked it as needed only for development.
- **integrity**: the lockfile's `sha512-…` hash, kept so library tarballs can be verified when they are fetched later.

Skipped: the root project, workspace folders and their `link` entries (these are the app's own code), and optional packages that weren't installed (no version).

## Matching versions against OSV

Advisories come from [OSV](https://osv.dev):

1. One `POST /v1/querybatch` call for every 500 package names returns advisory ids and their `modified` times. Pagination is followed.
2. Full records come from the local cache when `modified` hasn't changed; otherwise from `GET /v1/vulns/{id}`, 8 at a time.
3. Each installed `name@version` is checked locally against the record's ranges.

Checking locally, not trusting the server's answer, keeps results reproducible and testable. A test checks that the local matcher reaches exactly the answer api.osv.dev gives for every package in a real lockfile.

Matching rules, following the [OSV schema](https://ossf.github.io/osv-schema/#evaluation):

- Only `affected` entries whose ecosystem is `npm` and whose package name matches count. Advisories often list other ecosystems in the same record; for example, lodash advisories also list `lodash-rails`, a Ruby gem.
- `SEMVER` and `ECOSYSTEM` ranges are evaluated with npm semver ordering (prereleases sort before the release). Events are walked in version order: `introduced` turns "affected" on, `fixed` turns it off at that version, `last_affected` turns it off above that version. `GIT` ranges are ignored.
- Exact versions listed in `versions` also match.
- The version is affected if **any** entry or range says so. The reported fix is the lowest `fixed` version above the installed one, or "no fix listed".
- Withdrawn advisories are skipped.
- **Fail-closed:** if a version can't be compared (a git or file dependency, or a non-semver version in the advisory), the match is still reported, marked `uncertain` with the reason. A missed advisory is worse than an extra one.

Severity is the advisory database's own rating (`CRITICAL`, `HIGH`, `MODERATE`, `LOW`), or `UNKNOWN` when there is none.

## Cache

Advisory records are cached as one JSON file per id:

| OS           | Default folder                                              |
| ------------ | ----------------------------------------------------------- |
| Windows      | `%LOCALAPPDATA%\reachscan\osv`                              |
| macOS, Linux | `$XDG_CACHE_HOME/reachscan/osv` or `~/.cache/reachscan/osv` |

Override the folder with `--cache-dir <dir>` or the `REACHSCAN_CACHE_DIR` environment variable, and disable caching with `--no-cache`. A record is refetched when OSV reports a newer `modified` time. Advisory ids are checked against a strict pattern before they are used as file names, so a bad response can't write outside the cache folder. Files are written to a temp file and then renamed, so an interrupted run never leaves half-written records.

## Exit codes

| Code | Meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| 0    | Scan finished (whether or not anything was found)                                 |
| 2    | Unsupported project (see the lockfile table above)                                |
| 3    | Advisory lookup failed (network error, or OSV returned an error after 3 attempts) |

## Report (`--format json`)

```jsonc
{
  "schemaVersion": 1,
  "kind": "dependencies",
  "analyzer": { "name": "reachscan", "version": "0.3.0" },
  "generatedAt": "2026-11-09T12:00:00.000Z",
  "project": { "name": "shop-api" },
  "lockfile": { "version": 3, "installed": 71, "uniquePackages": 69 },
  "advisorySource": "osv.dev",
  "summary": {
    "vulnerablePackages": 5,
    "advisories": 14,
    "bySeverity": { "CRITICAL": 1, "HIGH": 5, "MODERATE": 6, "LOW": 2, "UNKNOWN": 0 },
    "directPackages": 2,
    "devOnlyPackages": 1
  },
  "matches": [
    {
      "advisory": {
        "id": "GHSA-xvch-5gv4-984h",
        "aliases": ["CVE-2021-44906"],
        "summary": "Prototype Pollution in minimist",
        "severity": "CRITICAL",
        "cwes": ["CWE-1321"],
        "url": "https://osv.dev/vulnerability/GHSA-xvch-5gv4-984h",
        "modified": "…"
      },
      "package": {
        "name": "minimist",
        "version": "1.2.5",
        "paths": ["node_modules/minimist"],
        "direct": true,
        "dev": true
      },
      "fixedVersion": "1.2.6"
    }
  ],
  "limitations": ["…"]
}
```

## Test data

`packages/core/test/data/` holds real data, so the tests don't depend on the network:

- `lockfiles/express-lodash/`: a lockfile npm generated for express 4.21.2, lodash 4.17.15 and (dev) minimist 1.2.5. It was created with `npm install --package-lock-only --ignore-scripts`, so no package code was downloaded or run.
- `osv/records.json`: the 54 OSV records that mention any package in that lockfile, fetched on 2026-11-09.
- `osv/osv-server-matches.json`: api.osv.dev's own answer for each installed `name@version`, which the local matcher must equal.

A side note from this data: the lodash `merge` prototype-pollution advisory ([GHSA-4xc9-xhrj-v574](https://osv.dev/vulnerability/GHSA-4xc9-xhrj-v574)) was fixed in **4.17.11**, so lodash 4.17.15 isn't affected by it. The call-graph fixtures that target `lodash#merge` therefore pin lodash **4.17.10**.
