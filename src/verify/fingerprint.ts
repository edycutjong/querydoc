import type { Column } from "../engine/types.js";
import { typeClass } from "./canonical.js";

// Engine-side row-hash fingerprint for result sets too large to transfer: COUNT(*) plus the SUM of a per-row hash. Summing
// (never XOR-ing) keeps it order-independent without letting duplicate rows cancel out. Each column is canonicalised to a string
// first, with a sentinel for NULL, because xxhash64 skips NULL arguments — (NULL, 'a') and ('a', NULL) would otherwise collide.
// Float columns are rounded to N significant digits in SQL (`format_string('%.<N-1>e')`), the same relative tolerance the
// transferred-rows path applies. The 64-bit hashes are summed as DECIMAL(38,0) so the sum cannot overflow BIGINT. Hash function
// and dialect: Spark SQL on Zetaris, probed in scripts/spike_zetaris.ts (docs/DX-REPORT.md).

export const NULL_SENTINEL = "<qd:null>";

export function quoteSparkIdent(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

export function engineFingerprintSql(
  innerSql: string,
  columns: (string | Column)[],
  hashFn = "xxhash64",
  floatSigDigits = 9,
): string {
  const cols = columns.map((c) => (typeof c === "string" ? { name: c, type: "string" } : c));
  if (cols.length === 0) throw new Error("fingerprint needs at least one column");
  if (new Set(cols.map((c) => c.name)).size !== cols.length) throw new Error("fingerprint needs distinct column names");
  const parts = cols.map((c) => {
    const ref = `q.${quoteSparkIdent(c.name)}`;
    const asString =
      typeClass(c.type) === "float" ? `format_string('%.${floatSigDigits - 1}e', CAST(${ref} AS DOUBLE))` : `CAST(${ref} AS STRING)`;
    return `COALESCE(${asString}, '${NULL_SENTINEL}')`;
  });
  return (
    `SELECT COUNT(*) AS qd_rows, CAST(SUM(CAST(${hashFn}(${parts.join(", ")}) AS DECIMAL(38,0))) AS STRING) AS qd_hash_sum ` +
    `FROM (${innerSql.trim().replace(/;\s*$/, "")}) q`
  );
}

export const countStarSql = (innerSql: string): string =>
  `SELECT COUNT(*) AS qd_count FROM (${innerSql.trim().replace(/;\s*$/, "")}) q`;

// DuckDB variant (sample engine). Same construction: each column canonicalised to text with a sentinel for NULL, rows hashed,
// hashes summed as HUGEINT (cannot overflow, order-independent, duplicates do not cancel). Floats are rounded to N significant
// digits with printf('%.<N-1>e'). The unit separator keeps ('ab','c') apart from ('a','bc').
export function duckdbFingerprintSql(innerSql: string, columns: Column[], floatSigDigits = 9): string {
  if (columns.length === 0) throw new Error("fingerprint needs at least one column");
  if (new Set(columns.map((c) => c.name)).size !== columns.length) throw new Error("fingerprint needs distinct column names");
  const parts = columns.map((c) => {
    const ref = `q."${c.name.replace(/"/g, '""')}"`;
    const asText = typeClass(c.type) === "float" ? `printf('%.${floatSigDigits - 1}e', CAST(${ref} AS DOUBLE))` : `CAST(${ref} AS VARCHAR)`;
    return `COALESCE(${asText}, '${NULL_SENTINEL}')`;
  });
  return (
    `SELECT COUNT(*) AS qd_rows, CAST(SUM(CAST(hash(${parts.join(" || chr(31) || ")}) AS HUGEINT)) AS VARCHAR) AS qd_hash_sum ` +
    `FROM (${innerSql.trim().replace(/;\s*$/, "")}) q`
  );
}
