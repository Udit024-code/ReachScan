/** The subset of the OSV schema (https://ossf.github.io/osv-schema/) that ReachScan reads. */

export interface OsvEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
  limit?: string;
}

export interface OsvRange {
  type: "SEMVER" | "ECOSYSTEM" | "GIT" | string;
  events: OsvEvent[];
  repo?: string;
}

export interface OsvAffected {
  package?: { name: string; ecosystem: string; purl?: string };
  ranges?: OsvRange[];
  versions?: string[];
}

export interface OsvReference {
  type: string;
  url: string;
}

export interface OsvVulnerability {
  id: string;
  modified: string;
  published?: string;
  withdrawn?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  severity?: Array<{ type: string; score: string }>;
  affected?: OsvAffected[];
  references?: OsvReference[];
  database_specific?: { severity?: string; cwe_ids?: string[] };
}
