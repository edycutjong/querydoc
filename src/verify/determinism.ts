import { maskSql } from "../sql/text.js";
import type { CanonRow } from "./canonical.js";
import type { OrderSpec } from "./order.js";

// Pre-check lint: a query whose answer can change between two runs cannot be verified, so it is NOT_VERIFIABLE before any attempt.
// The lint catches the textual causes; the double run of the original (fingerprints must match) catches the rest; the top-N tie
// probe catches `ORDER BY … LIMIT k` cutting through a tie (which rows survive the cut is then arbitrary).

const NONDETERMINISTIC = [
  "rand", "random", "randn", "uuid", "now", "current_timestamp", "current_date", "current_time", "localtimestamp", "localtime",
  "unix_timestamp", "monotonically_increasing_id", "spark_partition_id", "input_file_name", "shuffle", "gen_random_uuid",
];
const NONDET_RE = new RegExp(`\\b(${NONDETERMINISTIC.join("|")})\\b`, "gi");
const SAMPLING_RE = /\b(TABLESAMPLE|USING\s+SAMPLE)\b/i;

export function lintDeterminism(sql: string, spec: OrderSpec): string[] {
  const masked = maskSql(sql);
  const issues: string[] = [];
  const fns = new Set([...masked.matchAll(NONDET_RE)].map((m) => m[1]!.toLowerCase()));
  if (fns.size) issues.push(`non-deterministic function(s): ${[...fns].join(", ")}`);
  if (SAMPLING_RE.test(masked)) issues.push("sampling clause");
  if (/\bTOP\s+\d+/i.test(masked) && spec.kind === "multiset") issues.push("TOP without a top-level ORDER BY");
  if (spec.limit !== null && spec.kind === "multiset") issues.push("LIMIT without a top-level ORDER BY");
  return issues;
}

// The original with its trailing top-level LIMIT k replaced by LIMIT k+1, or null when the LIMIT is not the statement's last clause.
export function tieProbeSql(sql: string, k: number): string | null {
  const stmt = sql.trim().replace(/;\s*$/, "");
  const masked = maskSql(stmt);
  const m = /\bLIMIT\s+(\d+)\s*$/i.exec(masked);
  if (!m || Number(m[1]) !== k) return null;
  return stmt.slice(0, m.index) + `LIMIT ${k + 1}`;
}

// With k+1 rows from the probe: the k-th and (k+1)-th rows equal on every sort key → a tie at the cut.
export function tieAtCut(rows: CanonRow[], keyIdx: number[], k: number): boolean {
  if (rows.length <= k) return false;
  const a = rows[k - 1]!;
  const b = rows[k]!;
  return keyIdx.every((i) => (a[i] ?? null) === (b[i] ?? null));
}
