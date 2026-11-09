import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readLockfile } from "../src/lockfile.ts";
import { checkAffected, groupByNpmPackage, matchDependencies } from "../src/osv/match.ts";
import type { OsvVulnerability } from "../src/osv/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const records = JSON.parse(
  readFileSync(path.join(here, "data/osv/records.json"), "utf8"),
) as OsvVulnerability[];
const serverMatches = (
  JSON.parse(readFileSync(path.join(here, "data/osv/osv-server-matches.json"), "utf8")) as {
    matches: Record<string, string[]>;
  }
).matches;
const byId = new Map(records.map((r) => [r.id, r]));
const record = (id: string) => byId.get(id) as OsvVulnerability;

describe("matching agrees with OSV itself on real data", () => {
  it("finds exactly the advisories api.osv.dev reports for every package in a real lockfile", () => {
    const tree = readLockfile(path.join(here, "data/lockfiles/express-lodash"));
    const matches = matchDependencies(tree.dependencies, groupByNpmPackage(records));

    const ours: Record<string, string[]> = {};
    for (const m of matches) {
      const key = `${m.package.name}@${m.package.version}`;
      ours[key] = [...(ours[key] ?? []), m.advisory.id].sort();
    }
    expect(ours).toEqual(serverMatches);
  });
});

describe("checkAffected on real lodash advisories", () => {
  it("merge prototype pollution (GHSA-4xc9-xhrj-v574) is fixed in 4.17.11", () => {
    const merge = record("GHSA-4xc9-xhrj-v574");
    expect(checkAffected(merge, "lodash", "4.17.10")).toEqual({ affected: true, fixedVersion: "4.17.11" });
    expect(checkAffected(merge, "lodash", "4.17.11").affected).toBe(false);
    expect(checkAffected(merge, "lodash", "4.17.15").affected).toBe(false);
  });

  it("ignores entries for other ecosystems that share the advisory (lodash-rails is a Ruby gem)", () => {
    const merge = record("GHSA-4xc9-xhrj-v574");
    expect(checkAffected(merge, "lodash-rails", "4.17.10").affected).toBe(false);
  });

  it("respects introduced lower bounds", () => {
    const zipObjectDeep = record("GHSA-p6mc-m468-83gw"); // introduced 3.7.0
    expect(checkAffected(zipObjectDeep, "lodash", "3.6.0").affected).toBe(false);
    expect(checkAffected(zipObjectDeep, "lodash", "3.7.0").affected).toBe(true);
    expect(checkAffected(zipObjectDeep, "lodash", "4.17.15")).toEqual({
      affected: true,
      fixedVersion: "4.17.19",
    });
  });

  it("picks the lowest fix when several ranges match", () => {
    const defaultsDeep = record("GHSA-jf85-cpcp-j695"); // npm lodash: fixed 4.17.12
    expect(checkAffected(defaultsDeep, "lodash", "4.17.11").fixedVersion).toBe("4.17.12");
  });
});

describe("checkAffected range semantics", () => {
  const vuln = (events: object[], extra: Partial<OsvVulnerability> = {}): OsvVulnerability => ({
    id: "TEST-1",
    modified: "2026-01-01T00:00:00Z",
    affected: [{ package: { name: "pkg", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events }] }],
    ...extra,
  });

  it("handles last_affected as an inclusive upper bound with no fix", () => {
    const v = vuln([{ introduced: "1.0.0" }, { last_affected: "1.4.0" }]);
    expect(checkAffected(v, "pkg", "1.4.0")).toEqual({ affected: true, fixedVersion: null });
    expect(checkAffected(v, "pkg", "1.4.1").affected).toBe(false);
  });

  it("handles several introduced/fixed pairs in one range", () => {
    const v = vuln([{ introduced: "0" }, { fixed: "1.2.3" }, { introduced: "2.0.0" }, { fixed: "2.1.0" }]);
    expect(checkAffected(v, "pkg", "1.5.0").affected).toBe(false);
    expect(checkAffected(v, "pkg", "2.0.5")).toEqual({ affected: true, fixedVersion: "2.1.0" });
  });

  it("orders prereleases before the release", () => {
    const v = vuln([{ introduced: "0" }, { fixed: "2.0.0" }]);
    expect(checkAffected(v, "pkg", "2.0.0-beta.1").affected).toBe(true);
    expect(checkAffected(v, "pkg", "2.0.0").affected).toBe(false);
  });

  it("matches exact versions listed outside ranges", () => {
    const v: OsvVulnerability = {
      id: "TEST-2",
      modified: "2026-01-01T00:00:00Z",
      affected: [{ package: { name: "pkg", ecosystem: "npm" }, versions: ["1.0.1"] }],
    };
    expect(checkAffected(v, "pkg", "1.0.1").affected).toBe(true);
    expect(checkAffected(v, "pkg", "1.0.2").affected).toBe(false);
  });

  it("skips withdrawn advisories", () => {
    const v = vuln([{ introduced: "0" }], { withdrawn: "2026-02-01T00:00:00Z" });
    expect(checkAffected(v, "pkg", "1.0.0").affected).toBe(false);
  });

  it("fails closed: a non-semver installed version is reported as uncertain, not dropped", () => {
    const v = vuln([{ introduced: "0" }, { fixed: "1.0.0" }]);
    const result = checkAffected(v, "pkg", "github:user/pkg#abc123");
    expect(result.affected).toBe(true);
    expect(result.uncertain).toMatch(/not a semver version/);
  });
});
