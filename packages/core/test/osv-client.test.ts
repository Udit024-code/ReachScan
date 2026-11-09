import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AdvisoryLookupError, OsvApiSource } from "../src/osv/client.ts";
import type { OsvVulnerability } from "../src/osv/types.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const records = JSON.parse(
  readFileSync(path.join(here, "data/osv/records.json"), "utf8"),
) as OsvVulnerability[];
const merge = records.find((r) => r.id === "GHSA-4xc9-xhrj-v574") as OsvVulnerability;
const template = records.find((r) => r.id === "GHSA-35jh-r3h4-6jhm") as OsvVulnerability;

/** A fake api.osv.dev that serves two lodash advisories, split across two pages. */
function fakeOsv(store: Map<string, OsvVulnerability>) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(`${init?.method} ${url.replace("https://api.osv.dev", "")}`);
    if (url.endsWith("/v1/querybatch")) {
      const { queries } = JSON.parse(String(init?.body)) as {
        queries: Array<{ package: { name: string }; page_token?: string }>;
      };
      const results = queries.map((q) => {
        if (q.package.name !== "lodash") return {};
        const ref = (v: OsvVulnerability) => ({ id: v.id, modified: v.modified });
        return q.page_token
          ? { vulns: [ref(store.get(template.id) as OsvVulnerability)] }
          : { vulns: [ref(store.get(merge.id) as OsvVulnerability)], next_page_token: "page-2" };
      });
      return Response.json({ results });
    }
    const id = decodeURIComponent(url.split("/v1/vulns/")[1] ?? "");
    const record = store.get(id);
    return record ? Response.json(record) : new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("OsvApiSource", () => {
  let cacheDir: string;
  beforeEach(() => {
    cacheDir = mkdtempSync(path.join(os.tmpdir(), "reachscan-cache-"));
  });
  afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

  it("follows pagination and returns full records per package", async () => {
    const { fetchImpl } = fakeOsv(new Map([merge, template].map((r) => [r.id, r])));
    const source = new OsvApiSource({ cacheDir, fetchImpl });
    const result = await source.advisoriesFor(["lodash", "express"]);
    expect(result.get("lodash")?.map((r) => r.id)).toEqual([merge.id, template.id]);
    expect(result.has("express")).toBe(false);
  });

  it("serves unchanged records from the cache and refetches modified ones", async () => {
    const store = new Map([merge, template].map((r) => [r.id, r]));
    const first = fakeOsv(store);
    await new OsvApiSource({ cacheDir, fetchImpl: first.fetchImpl }).advisoriesFor(["lodash"]);
    expect(first.calls.filter((c) => c.includes("/v1/vulns/"))).toHaveLength(2);
    expect(existsSync(path.join(cacheDir, "osv", `${merge.id}.json`))).toBe(true);

    const second = fakeOsv(store);
    await new OsvApiSource({ cacheDir, fetchImpl: second.fetchImpl }).advisoriesFor(["lodash"]);
    expect(second.calls.filter((c) => c.includes("/v1/vulns/"))).toHaveLength(0);

    store.set(merge.id, { ...merge, modified: "2030-01-01T00:00:00Z" });
    const third = fakeOsv(store);
    const result = await new OsvApiSource({ cacheDir, fetchImpl: third.fetchImpl }).advisoriesFor(["lodash"]);
    expect(third.calls.filter((c) => c.includes("/v1/vulns/"))).toEqual([`GET /v1/vulns/${merge.id}`]);
    expect(result.get("lodash")?.[0]?.modified).toBe("2030-01-01T00:00:00Z");
  });

  it("refuses advisory ids that could escape the cache folder", async () => {
    const fetchImpl = (async () =>
      Response.json({
        results: [{ vulns: [{ id: "../../evil", modified: "x" }] }],
      })) as unknown as typeof fetch;
    const source = new OsvApiSource({ cacheDir, fetchImpl });
    await expect(source.advisoriesFor(["lodash"])).rejects.toThrow(AdvisoryLookupError);
  });

  it("retries server errors, then reports a clear error", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      return new Response("down", { status: 503 });
    }) as unknown as typeof fetch;
    const source = new OsvApiSource({ cacheDir: null, fetchImpl });
    await expect(source.advisoriesFor(["lodash"])).rejects.toThrow(/HTTP 503/);
    expect(attempts).toBe(3);
  });
});
