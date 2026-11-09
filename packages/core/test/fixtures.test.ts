import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanTarget } from "../src/index.ts";

const fixturesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../fixtures/dev");

interface Expected {
  description: string;
  target: string;
  verdict: string;
  reasonCodes: string[];
  pathLabels?: string[];
  blockerTexts?: string[];
}

const fixtures = readdirSync(fixturesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();

describe("development fixtures", () => {
  it("has fixtures to run", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const name of fixtures) {
    const dir = path.join(fixturesDir, name);
    const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as Expected;

    it(`${name}: ${expected.verdict}`, () => {
      const finding = scanTarget(dir, expected.target);
      const context = JSON.stringify(finding, null, 2);

      expect(finding.verdict, context).toBe(expected.verdict);
      for (const code of expected.reasonCodes) {
        expect(finding.reasonCodes, context).toContain(code);
      }
      if (expected.pathLabels) {
        const labels = (finding.path ?? []).map((s) => s.label);
        let from = 0;
        for (const wanted of expected.pathLabels) {
          const index = labels.findIndex((l, i) => i >= from && l.includes(wanted));
          expect(index, `path step "${wanted}" missing or out of order in ${context}`).toBeGreaterThanOrEqual(
            0,
          );
          from = index + 1;
        }
      }
      for (const text of expected.blockerTexts ?? []) {
        expect(
          finding.blockers.some((b) => b.text.includes(text)),
          `blocker "${text}" missing in ${context}`,
        ).toBe(true);
      }
    });
  }
});

describe("the most important rule", () => {
  it("never says unreachable when the expected answer is reachable or unknown", () => {
    const falseUnreachable = fixtures.filter((name) => {
      const dir = path.join(fixturesDir, name);
      const expected = JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as Expected;
      return expected.verdict !== "unreachable" && scanTarget(dir, expected.target).verdict === "unreachable";
    });
    expect(falseUnreachable).toEqual([]);
  });
});
