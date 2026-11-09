import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ANALYZER_VERSION, buildReport, REPORT_SCHEMA_VERSION, scanTarget } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.resolve(here, "../../../fixtures/dev/01-reachable-direct");

describe("JSON report", () => {
  it("ANALYZER_VERSION matches packages/core/package.json", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(here, "../package.json"), "utf8")) as {
      version: string;
    };
    expect(ANALYZER_VERSION).toBe(pkg.version);
  });

  it("has a stable top-level shape", () => {
    const now = new Date("2026-11-09T12:00:00Z");
    const report = buildReport(fixture, [scanTarget(fixture, "lodash#merge")], now);

    expect(report.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(report.analyzer).toEqual({ name: "reachscan", version: ANALYZER_VERSION });
    expect(report.generatedAt).toBe("2026-11-09T12:00:00.000Z");
    expect(report.project).toEqual({ name: "01-reachable-direct" });
    expect(Object.keys(report).sort()).toEqual(
      ["analyzer", "findings", "generatedAt", "project", "schemaVersion"].sort(),
    );

    const [finding] = report.findings;
    expect(Object.keys(finding ?? {}).sort()).toEqual(
      ["blockers", "limitations", "path", "reasonCodes", "stats", "target", "verdict"].sort(),
    );
  });

  it("never leaks absolute paths from the scanning machine", () => {
    const report = buildReport(fixture, [scanTarget(fixture, "lodash#merge")]);
    const json = JSON.stringify(report);
    expect(json).not.toContain(path.resolve(fixture).replace(/\\/g, "/"));
    expect(json).not.toContain(path.resolve(fixture));
    expect(json).not.toMatch(/[A-Za-z]:[\\/]/);
  });
});
