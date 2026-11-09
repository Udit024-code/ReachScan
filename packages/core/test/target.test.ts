import { describe, expect, it } from "vitest";
import { matchesTarget, parseTarget } from "../src/index.ts";
import { parseBareSpecifier } from "../src/resolve.ts";

describe("parseBareSpecifier", () => {
  it("splits package and subpath", () => {
    expect(parseBareSpecifier("lodash")).toEqual({ package: "lodash", subpath: null });
    expect(parseBareSpecifier("lodash/merge")).toEqual({ package: "lodash", subpath: "merge" });
    expect(parseBareSpecifier("@scope/pkg/a/b")).toEqual({ package: "@scope/pkg", subpath: "a/b" });
  });

  it("ignores relative paths and Node builtins", () => {
    expect(parseBareSpecifier("./utils")).toBeNull();
    expect(parseBareSpecifier("fs")).toBeNull();
    expect(parseBareSpecifier("fs/promises")).toBeNull();
    expect(parseBareSpecifier("node:path")).toBeNull();
  });
});

describe("parseTarget / matchesTarget", () => {
  const target = parseTarget("lodash#merge");

  it("matches the export however it was imported", () => {
    expect(matchesTarget({ package: "lodash", subpath: null, member: ["merge"] }, target)).toBe(true);
    expect(matchesTarget({ package: "lodash", subpath: "merge", member: [] }, target)).toBe(true);
    expect(matchesTarget({ package: "lodash", subpath: null, member: ["default", "merge"] }, target)).toBe(
      true,
    );
    expect(matchesTarget({ package: "lodash", subpath: null, member: ["merge", "call"] }, target)).toBe(true);
  });

  it("does not match other exports or packages", () => {
    expect(matchesTarget({ package: "lodash", subpath: null, member: ["mergeWith"] }, target)).toBe(false);
    expect(matchesTarget({ package: "lodash", subpath: null, member: ["uniq"] }, target)).toBe(false);
    expect(matchesTarget({ package: "lodash-es", subpath: null, member: ["merge"] }, target)).toBe(false);
  });

  it("rejects malformed targets", () => {
    expect(() => parseTarget("lodash")).toThrow();
    expect(() => parseTarget("lodash#")).toThrow();
  });
});
