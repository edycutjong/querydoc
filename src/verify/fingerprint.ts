// Engine-side row-hash fingerprint for result sets too large to transfer: COUNT(*) plus the SUM of a per-row hash. Summing
// (never XOR-ing) keeps it order-independent without letting duplicate rows cancel out. Each column is canonicalised to a string
// first, with a sentinel for NULL, because xxhash64 skips NULL arguments — (NULL, 'a') and ('a', NULL) would otherwise collide.
// The 64-bit hashes are summed as DECIMAL(38,0) so the sum cannot overflow BIGINT. Hash function and dialect: Spark SQL on
// Zetaris, probed in scripts/spike_zetaris.ts (docs/DX-REPORT.md).

export const NULL_SENTINEL = "<qd:null>";

export function quoteSparkIdent(name: string): string {
  return "`" + name.replace(/`/g, "``") + "`";
}

export function engineFingerprintSql(innerSql: string, columns: string[], hashFn = "xxhash64"): string {
  if (columns.length === 0) throw new Error("fingerprint needs at least one column");
  if (new Set(columns).size !== columns.length) throw new Error("fingerprint needs distinct column names");
  const parts = columns.map((c) => `COALESCE(CAST(q.${quoteSparkIdent(c)} AS STRING), '${NULL_SENTINEL}')`);
  return (
    `SELECT COUNT(*) AS qd_rows, CAST(SUM(CAST(${hashFn}(${parts.join(", ")}) AS DECIMAL(38,0))) AS STRING) AS qd_hash_sum ` +
    `FROM (${innerSql.trim().replace(/;\s*$/, "")}) q`
  );
}
