import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type OsvVulnerability, StaticAdvisorySource, scanDependencies } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const records = JSON.parse(
  readFileSync(path.join(here, "data/osv/records.json"), "utf8"),
) as OsvVulnerability[];
const project = path.join(here, "data/lockfiles/express-lodash");

describe("scanDependencies (offline, real lockfile + real advisory records)", async () => {
  const report = await scanDependencies(
    project,
    new StaticAdvisorySource(records),
    new Date("2026-11-09T00:00:00Z"),
  );

  it("summarizes what version matching finds", () => {
    expect(report.kind).toBe("dependencies");
    expect(report.lockfile).toEqual({ version: 3, installed: 71, uniquePackages: 69 });
    expect(report.summary).toEqual({
      vulnerablePackages: 5,
      advisories: 14,
      bySeverity: { CRITICAL: 1, HIGH: 5, MODERATE: 6, LOW: 2, UNKNOWN: 0 },
      directPackages: 2, // lodash and minimist; the rest arrive through express
      devOnlyPackages: 1, // minimist
    });
  });

  it("lists the most severe matches first, with fix versions", () => {
    expect(report.matches[0]).toMatchObject({
      advisory: { id: "GHSA-xvch-5gv4-984h", severity: "CRITICAL" },
      package: { name: "minimist", version: "1.2.5", direct: true, dev: true },
      fixedVersion: "1.2.6",
    });
    const lodash = report.matches.filter((m) => m.package.name === "lodash").map((m) => m.advisory.id);
    expect(lodash).toHaveLength(5);
    // The merge advisory was fixed in 4.17.11, so 4.17.15 must not be flagged for it.
    expect(lodash).not.toContain("GHSA-4xc9-xhrj-v574");
  });

  it("never includes absolute paths", () => {
    const json = JSON.stringify(report);
    expect(json).not.toContain(path.resolve(project));
    expect(json).not.toContain(path.resolve(project).replace(/\\/g, "/"));
    // A drive letter on its own (C:\ or C:/), not the "s:/" inside "https://".
    expect(json).not.toMatch(/(?<![A-Za-z])[A-Za-z]:[\\/]/);
  });
});
