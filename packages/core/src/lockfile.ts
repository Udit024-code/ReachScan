import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** One installed copy of a package, as recorded in package-lock.json. */
export interface Dependency {
  /** The real package name (for an alias like "foo": "npm:bar@1", this is "bar"). */
  name: string;
  version: string;
  /** Install location, e.g. "node_modules/debug/node_modules/ms". */
  path: string;
  /** Listed in the root (or a workspace) package.json and installed at the top level. */
  direct: boolean;
  /** Only needed for development (devDependencies and what they pull in). */
  dev: boolean;
  optional: boolean;
  integrity: string | null;
  resolved: string | null;
}

export interface DependencyTree {
  lockfileVersion: number;
  /** Every installed copy, sorted by path. The same name@version can appear at several paths. */
  dependencies: Dependency[];
}

export class UnsupportedProjectError extends Error {
  override name = "UnsupportedProjectError";
}

/** Bigger lockfiles than this are almost certainly not a normal app; refuse rather than hang. */
const MAX_LOCKFILE_BYTES = 50 * 1024 * 1024;

const OTHER_LOCKFILES = ["yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock", "npm-shrinkwrap.json"];

interface LockEntry {
  name?: string;
  version?: string;
  resolved?: string;
  integrity?: string;
  link?: boolean;
  dev?: boolean;
  optional?: boolean;
  devOptional?: boolean;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockEntry>;
}

/** Reads `<dir>/package-lock.json`. Throws UnsupportedProjectError for anything v1 doesn't handle. */
export function readLockfile(projectDir: string): DependencyTree {
  const file = path.join(projectDir, "package-lock.json");
  if (!existsSync(file)) {
    const other = OTHER_LOCKFILES.find((name) => existsSync(path.join(projectDir, name)));
    throw new UnsupportedProjectError(
      other
        ? `Found ${other}, but only npm's package-lock.json is supported for now.`
        : "No package-lock.json found. Run `npm install --package-lock-only` to create one.",
    );
  }
  if (statSync(file).size > MAX_LOCKFILE_BYTES) {
    throw new UnsupportedProjectError(`package-lock.json is larger than ${MAX_LOCKFILE_BYTES} bytes.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new UnsupportedProjectError(`package-lock.json is not valid JSON: ${(error as Error).message}`);
  }
  return parseLockfile(parsed);
}

/** Install path → package name: "node_modules/a/node_modules/@s/b" → "@s/b". */
export function nameFromInstallPath(installPath: string): string | null {
  const marker = "node_modules/";
  const index = installPath.lastIndexOf(marker);
  return index === -1 ? null : installPath.slice(index + marker.length);
}

export function parseLockfile(raw: unknown): DependencyTree {
  if (typeof raw !== "object" || raw === null) {
    throw new UnsupportedProjectError("package-lock.json is not an object.");
  }
  const lock = raw as Lockfile;
  const version = lock.lockfileVersion ?? 1;
  if (version < 2 || !lock.packages) {
    throw new UnsupportedProjectError(
      `package-lock.json version ${version} is not supported (npm 7+ writes version 2 or 3). ` +
        "Regenerate it with a current npm.",
    );
  }

  // Names declared by the root package and by workspace packages (entries outside node_modules).
  const declared = new Set<string>();
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (key.includes("node_modules/")) continue;
    for (const deps of [
      entry.dependencies,
      entry.devDependencies,
      entry.optionalDependencies,
      entry.peerDependencies,
    ]) {
      for (const name of Object.keys(deps ?? {})) declared.add(name);
    }
  }

  const dependencies: Dependency[] = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    const installedAs = nameFromInstallPath(key);
    if (!installedAs) continue; // the root project or a workspace folder
    if (entry.link) continue; // symlink to a workspace folder, which is the app's own code
    if (!entry.version) continue; // nothing installed (e.g. an optional package for another OS)

    dependencies.push({
      // npm aliases record the real package in `name`.
      name: entry.name ?? installedAs,
      version: entry.version,
      path: key,
      direct: key === `node_modules/${installedAs}` && declared.has(installedAs),
      dev: entry.dev === true,
      optional: entry.optional === true || entry.devOptional === true,
      integrity: entry.integrity ?? null,
      resolved: entry.resolved ?? null,
    });
  }
  dependencies.sort((a, b) => a.path.localeCompare(b.path));
  return { lockfileVersion: version, dependencies };
}
