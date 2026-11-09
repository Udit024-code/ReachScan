import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { groupByNpmPackage } from "./match.ts";
import type { OsvVulnerability } from "./types.ts";

/** Where advisories come from. The CLI uses the OSV API; tests use fixed records. */
export interface AdvisorySource {
  readonly name: string;
  /** Advisories mentioning each npm package name. Names with none may be missing from the map. */
  advisoriesFor(packageNames: string[]): Promise<Map<string, OsvVulnerability[]>>;
}

export class AdvisoryLookupError extends Error {
  override name = "AdvisoryLookupError";
}

/** Serves a fixed set of advisory records. */
export class StaticAdvisorySource implements AdvisorySource {
  readonly name = "static";
  readonly #byName: Map<string, OsvVulnerability[]>;

  constructor(records: OsvVulnerability[]) {
    this.#byName = groupByNpmPackage(records);
  }

  async advisoriesFor(packageNames: string[]): Promise<Map<string, OsvVulnerability[]>> {
    const result = new Map<string, OsvVulnerability[]>();
    for (const name of packageNames) {
      const list = this.#byName.get(name);
      if (list) result.set(name, list);
    }
    return result;
  }
}

export interface OsvApiOptions {
  /** Folder for cached advisory records; null disables the cache. */
  cacheDir: string | null;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  concurrency?: number;
  userAgent?: string;
}

interface QueryBatchResponse {
  results: Array<{ vulns?: Array<{ id: string; modified: string }>; next_page_token?: string }>;
}

/** OSV ids look like GHSA-xxxx-xxxx-xxxx, CVE-2024-1234 or MAL-2024-1. Anything else is refused. */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,100}$/;
const BATCH_SIZE = 500;

/**
 * Looks advisories up on api.osv.dev:
 * 1. one /v1/querybatch call per 500 package names returns advisory ids and modified times;
 * 2. full records come from the cache when their modified time is unchanged, else /v1/vulns/{id}.
 */
export class OsvApiSource implements AdvisorySource {
  readonly name = "osv.dev";
  readonly #options: Required<Omit<OsvApiOptions, "cacheDir">> & { cacheDir: string | null };

  constructor(options: OsvApiOptions) {
    this.#options = {
      baseUrl: "https://api.osv.dev",
      fetchImpl: fetch,
      timeoutMs: 20_000,
      concurrency: 8,
      userAgent: "reachscan",
      ...options,
    };
  }

  async advisoriesFor(packageNames: string[]): Promise<Map<string, OsvVulnerability[]>> {
    const names = [...new Set(packageNames)].sort();
    const idsByName = new Map<string, Array<{ id: string; modified: string }>>();
    for (let i = 0; i < names.length; i += BATCH_SIZE) {
      await this.#queryBatch(names.slice(i, i + BATCH_SIZE), idsByName);
    }

    const wanted = new Map<string, string>();
    for (const refs of idsByName.values()) for (const ref of refs) wanted.set(ref.id, ref.modified);
    const records = await this.#loadRecords(wanted);

    const result = new Map<string, OsvVulnerability[]>();
    for (const [name, refs] of idsByName) {
      const list = refs
        .map((ref) => records.get(ref.id))
        .filter((r): r is OsvVulnerability => r !== undefined);
      if (list.length > 0) result.set(name, list);
    }
    return result;
  }

  async #queryBatch(
    names: string[],
    into: Map<string, Array<{ id: string; modified: string }>>,
  ): Promise<void> {
    let pending = names.map((name) => ({ name, pageToken: undefined as string | undefined }));
    while (pending.length > 0) {
      const body = {
        queries: pending.map((p) => ({
          package: { name: p.name, ecosystem: "npm" },
          ...(p.pageToken ? { page_token: p.pageToken } : {}),
        })),
      };
      const response = (await this.#request("/v1/querybatch", {
        method: "POST",
        body: JSON.stringify(body),
      })) as QueryBatchResponse;
      if (!Array.isArray(response?.results) || response.results.length !== pending.length) {
        throw new AdvisoryLookupError("OSV querybatch returned an unexpected response.");
      }
      const next: typeof pending = [];
      response.results.forEach((result, i) => {
        const { name } = pending[i] as { name: string };
        const refs = into.get(name) ?? [];
        for (const v of result.vulns ?? []) {
          if (!SAFE_ID.test(v.id)) throw new AdvisoryLookupError(`OSV returned an invalid id: ${v.id}`);
          refs.push({ id: v.id, modified: v.modified });
        }
        into.set(name, refs);
        if (result.next_page_token) next.push({ name, pageToken: result.next_page_token });
      });
      pending = next;
    }
  }

  async #loadRecords(wanted: Map<string, string>): Promise<Map<string, OsvVulnerability>> {
    const records = new Map<string, OsvVulnerability>();
    const toFetch: string[] = [];
    for (const [id, modified] of wanted) {
      const cached = this.#readCache(id);
      if (cached && cached.modified === modified) records.set(id, cached);
      else toFetch.push(id);
    }
    for (let i = 0; i < toFetch.length; i += this.#options.concurrency) {
      const batch = toFetch.slice(i, i + this.#options.concurrency);
      const fetched = await Promise.all(
        batch.map((id) => this.#request(`/v1/vulns/${encodeURIComponent(id)}`, { method: "GET" })),
      );
      for (const record of fetched as OsvVulnerability[]) {
        if (!record || typeof record.id !== "string" || !SAFE_ID.test(record.id)) {
          throw new AdvisoryLookupError("OSV returned an invalid advisory record.");
        }
        records.set(record.id, record);
        this.#writeCache(record);
      }
    }
    return records;
  }

  async #request(endpoint: string, init: { method: string; body?: string }): Promise<unknown> {
    const url = `${this.#options.baseUrl}${endpoint}`;
    for (let attempt = 1; ; attempt++) {
      let response: Response;
      try {
        response = await this.#options.fetchImpl(url, {
          ...init,
          headers: { "content-type": "application/json", "user-agent": this.#options.userAgent },
          signal: AbortSignal.timeout(this.#options.timeoutMs),
        });
      } catch (error) {
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          continue;
        }
        throw new AdvisoryLookupError(`Could not reach OSV (${url}): ${(error as Error).message}`);
      }
      if (response.ok) return response.json();
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
        continue;
      }
      throw new AdvisoryLookupError(`OSV request failed: ${init.method} ${url} → HTTP ${response.status}`);
    }
  }

  #cacheFile(id: string): string | null {
    if (!this.#options.cacheDir || !SAFE_ID.test(id)) return null;
    return path.join(this.#options.cacheDir, "osv", `${id.replace(/:/g, "_")}.json`);
  }

  #readCache(id: string): OsvVulnerability | null {
    const file = this.#cacheFile(id);
    if (!file) return null;
    try {
      const record = JSON.parse(readFileSync(file, "utf8")) as OsvVulnerability;
      return record.id === id ? record : null;
    } catch {
      return null;
    }
  }

  #writeCache(record: OsvVulnerability): void {
    const file = this.#cacheFile(record.id);
    if (!file) return;
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      // Write then rename, so a crash never leaves a half-written record behind.
      const temp = `${file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify(record));
      renameSync(temp, file);
    } catch {
      // A cache we can't write only costs speed.
    }
  }
}
