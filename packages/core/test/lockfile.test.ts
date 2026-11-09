import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  nameFromInstallPath,
  parseLockfile,
  readLockfile,
  UnsupportedProjectError,
} from "../src/lockfile.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const realProject = path.join(here, "data/lockfiles/express-lodash");

describe("readLockfile on a real npm lockfile (express + lodash + dev minimist)", () => {
  const tree = readLockfile(realProject);
  const find = (name: string) => tree.dependencies.filter((d) => d.name === name);

  it("reads every installed package with its exact version", () => {
    expect(tree.lockfileVersion).toBe(3);
    expect(tree.dependencies).toHaveLength(71); // 72 entries minus the root project
    expect(find("lodash")).toEqual([
      expect.objectContaining({ version: "4.17.15", path: "node_modules/lodash", direct: true, dev: false }),
    ]);
  });

  it("marks direct vs transitive and dev dependencies", () => {
    expect(find("express")[0]).toMatchObject({ direct: true, dev: false });
    expect(find("qs")[0]).toMatchObject({ direct: false, dev: false });
    expect(find("minimist")[0]).toMatchObject({ version: "1.2.5", direct: true, dev: true });
  });

  it("keeps every copy when two versions of a package are installed", () => {
    const ms = find("ms").map((d) => `${d.version} ${d.path}`);
    expect(ms).toEqual(["2.0.0 node_modules/ms", "2.1.3 node_modules/send/node_modules/ms"]);
  });

  it("records integrity hashes for later tarball verification", () => {
    expect(find("lodash")[0]?.integrity).toMatch(/^sha512-/);
  });
});

describe("parseLockfile edge cases", () => {
  it("handles scoped packages, aliases, workspace links and missing optional packages", () => {
    const tree = parseLockfile({
      lockfileVersion: 3,
      packages: {
        "": {
          name: "app",
          workspaces: ["packages/*"],
          dependencies: { "@scope/util": "^1.0.0", "old-name": "npm:new-name@^2.0.0" },
        },
        "packages/api": { name: "api", dependencies: { lodash: "^4.17.0" } },
        "node_modules/api": { resolved: "packages/api", link: true },
        "node_modules/@scope/util": { version: "1.2.0" },
        "node_modules/old-name": { name: "new-name", version: "2.1.0" },
        "node_modules/lodash": { version: "4.17.21" },
        "node_modules/@scope/util/node_modules/lodash": { version: "3.10.1" },
        "node_modules/fsevents": { version: undefined, optional: true },
      },
    });
    const summary = tree.dependencies.map(
      (d) => `${d.name}@${d.version} ${d.direct ? "direct" : "transitive"}`,
    );
    expect(summary).toEqual([
      "@scope/util@1.2.0 direct",
      "lodash@3.10.1 transitive",
      "lodash@4.17.21 direct", // declared by the workspace package
      "new-name@2.1.0 direct", // alias: real name is new-name
    ]);
  });

  it("rejects lockfile v1 with a clear message", () => {
    expect(() => parseLockfile({ lockfileVersion: 1, dependencies: {} })).toThrow(UnsupportedProjectError);
    expect(() => parseLockfile({ lockfileVersion: 1, dependencies: {} })).toThrow(
      /version 1 is not supported/,
    );
  });

  it("extracts names from install paths", () => {
    expect(nameFromInstallPath("node_modules/a/node_modules/@s/b")).toBe("@s/b");
    expect(nameFromInstallPath("packages/api")).toBeNull();
  });
});

describe("readLockfile on unsupported projects", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("names the other lockfile it found", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "reachscan-"));
    writeFileSync(path.join(dir, "yarn.lock"), "");
    expect(() => readLockfile(dir)).toThrow(/Found yarn.lock/);
  });

  it("explains how to create a lockfile when there is none", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "reachscan-"));
    expect(() => readLockfile(dir)).toThrow(/No package-lock.json/);
  });

  it("reports invalid JSON as unsupported, not as a crash", () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "reachscan-"));
    writeFileSync(path.join(dir, "package-lock.json"), "{ nope");
    expect(() => readLockfile(dir)).toThrow(UnsupportedProjectError);
  });
});
