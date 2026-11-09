import semver from "semver";
import type { Dependency } from "../lockfile.ts";
import type { OsvAffected, OsvEvent, OsvVulnerability } from "./types.ts";

export type Severity = "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";

const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"];

export interface AdvisorySummary {
  id: string;
  aliases: string[];
  summary: string;
  severity: Severity;
  cwes: string[];
  url: string;
  modified: string;
}

/** One advisory affecting one installed name@version. */
export interface VersionMatch {
  advisory: AdvisorySummary;
  package: {
    name: string;
    version: string;
    /** Every install location of this name@version. */
    paths: string[];
    /** True if any copy is a direct dependency. */
    direct: boolean;
    /** True only if every copy is dev-only. */
    dev: boolean;
  };
  /** Lowest fixed version above the installed one, or null if the advisory lists no fix. */
  fixedVersion: string | null;
  /**
   * Set when a version couldn't be compared (e.g. a git dependency). The match is
   * reported anyway: a missed advisory is worse than an extra one.
   */
  uncertain?: string;
}

interface AffectResult {
  affected: boolean;
  fixedVersion: string | null;
  uncertain?: string;
}

const NOT_AFFECTED: AffectResult = { affected: false, fixedVersion: null };

function compare(a: string, b: string): number {
  return semver.compare(a, b);
}

/** OSV range evaluation: walk events in version order; introduced turns "affected" on, fixed/last_affected turn it off. */
function rangeAffects(events: OsvEvent[], version: string): AffectResult {
  for (const e of events) {
    for (const v of [e.introduced, e.fixed, e.last_affected]) {
      if (v !== undefined && v !== "0" && !semver.valid(v)) {
        return {
          affected: true,
          fixedVersion: null,
          uncertain: `advisory range uses non-semver version "${v}"`,
        };
      }
    }
  }
  const sorted = events
    .filter((e) => e.introduced !== undefined || e.fixed !== undefined || e.last_affected !== undefined)
    .map((e) => ({ e, v: (e.introduced ?? e.fixed ?? e.last_affected) as string }))
    .sort((a, b) => (a.v === "0" ? -1 : b.v === "0" ? 1 : compare(a.v, b.v)));

  let affected = false;
  let fixedVersion: string | null = null;
  for (const { e, v } of sorted) {
    if (e.introduced !== undefined) {
      if (v === "0" || compare(version, v) >= 0) affected = true;
    } else if (e.fixed !== undefined) {
      if (compare(version, v) >= 0) affected = false;
      else if (affected && fixedVersion === null) fixedVersion = v;
    } else if (e.last_affected !== undefined) {
      if (compare(version, v) > 0) affected = false;
    }
  }
  return affected ? { affected, fixedVersion } : NOT_AFFECTED;
}

function lowest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return compare(a, b) <= 0 ? a : b;
}

/** Is `name@version` (an npm package) affected by this advisory? */
export function checkAffected(vuln: OsvVulnerability, name: string, version: string): AffectResult {
  if (vuln.withdrawn) return NOT_AFFECTED;
  const entries = (vuln.affected ?? []).filter(
    (a): a is OsvAffected & { package: NonNullable<OsvAffected["package"]> } =>
      a.package?.ecosystem === "npm" && a.package.name === name,
  );
  if (entries.length === 0) return NOT_AFFECTED;

  if (!semver.valid(version)) {
    return {
      affected: true,
      fixedVersion: null,
      uncertain: `installed version "${version}" is not a semver version`,
    };
  }

  let result: AffectResult = NOT_AFFECTED;
  for (const entry of entries) {
    if (entry.versions?.includes(version)) {
      result = { ...result, affected: true };
    }
    for (const range of entry.ranges ?? []) {
      if (range.type !== "SEMVER" && range.type !== "ECOSYSTEM") continue; // npm's ecosystem order is semver
      const r = rangeAffects(range.events, version);
      if (!r.affected) continue;
      result = {
        affected: true,
        fixedVersion: lowest(result.fixedVersion, r.fixedVersion),
        ...(r.uncertain || result.uncertain ? { uncertain: r.uncertain ?? result.uncertain } : {}),
      };
    }
  }
  return result;
}

export function normalizeSeverity(vuln: OsvVulnerability): Severity {
  const raw = vuln.database_specific?.severity?.toUpperCase();
  if (raw === "MEDIUM") return "MODERATE";
  return SEVERITY_ORDER.includes(raw as Severity) ? (raw as Severity) : "UNKNOWN";
}

export function summarizeAdvisory(vuln: OsvVulnerability): AdvisorySummary {
  return {
    id: vuln.id,
    aliases: vuln.aliases ?? [],
    summary: vuln.summary ?? vuln.details?.split("\n")[0]?.slice(0, 200) ?? "",
    severity: normalizeSeverity(vuln),
    cwes: vuln.database_specific?.cwe_ids ?? [],
    url: `https://osv.dev/vulnerability/${vuln.id}`,
    modified: vuln.modified,
  };
}

/**
 * Matches every installed name@version against the advisories for that package.
 * `advisories` maps an npm package name to the advisories that mention it.
 */
export function matchDependencies(
  dependencies: Dependency[],
  advisories: Map<string, OsvVulnerability[]>,
): VersionMatch[] {
  const installs = new Map<string, Dependency[]>();
  for (const dep of dependencies) {
    const key = `${dep.name}@${dep.version}`;
    const list = installs.get(key);
    if (list) list.push(dep);
    else installs.set(key, [dep]);
  }

  const matches: VersionMatch[] = [];
  for (const copies of installs.values()) {
    const first = copies[0] as Dependency;
    for (const vuln of advisories.get(first.name) ?? []) {
      const result = checkAffected(vuln, first.name, first.version);
      if (!result.affected) continue;
      matches.push({
        advisory: summarizeAdvisory(vuln),
        package: {
          name: first.name,
          version: first.version,
          paths: copies.map((c) => c.path),
          direct: copies.some((c) => c.direct),
          dev: copies.every((c) => c.dev),
        },
        fixedVersion: result.fixedVersion,
        ...(result.uncertain ? { uncertain: result.uncertain } : {}),
      });
    }
  }

  return matches.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.advisory.severity) - SEVERITY_ORDER.indexOf(b.advisory.severity) ||
      a.package.name.localeCompare(b.package.name) ||
      compare(a.package.version, b.package.version) ||
      a.advisory.id.localeCompare(b.advisory.id),
  );
}

/** Groups advisory records by the npm package names they affect. */
export function groupByNpmPackage(vulns: OsvVulnerability[]): Map<string, OsvVulnerability[]> {
  const byName = new Map<string, OsvVulnerability[]>();
  for (const vuln of vulns) {
    const names = new Set(
      (vuln.affected ?? [])
        .filter((a) => a.package?.ecosystem === "npm")
        .map((a) => a.package?.name as string),
    );
    for (const name of names) {
      const list = byName.get(name);
      if (list) list.push(vuln);
      else byName.set(name, [vuln]);
    }
  }
  return byName;
}
