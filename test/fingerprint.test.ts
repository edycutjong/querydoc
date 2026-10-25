import { describe, expect, it } from "vitest";
import { engineFingerprintSql, NULL_SENTINEL } from "../src/verify/fingerprint.js";

describe("engineFingerprintSql", () => {
  it("wraps the query, canonicalises every column with a NULL sentinel, sums hashes as DECIMAL", () => {
    const sql = engineFingerprintSql("SELECT a, b FROM t;", ["a", "b"]);
    expect(sql).toBe(
      "SELECT COUNT(*) AS qd_rows, CAST(SUM(CAST(xxhash64(" +
        `COALESCE(CAST(q.\`a\` AS STRING), '${NULL_SENTINEL}'), COALESCE(CAST(q.\`b\` AS STRING), '${NULL_SENTINEL}')` +
        ") AS DECIMAL(38,0))) AS STRING) AS qd_hash_sum FROM (SELECT a, b FROM t) q",
    );
  });

  it("quotes awkward column names", () => {
    expect(engineFingerprintSql("SELECT count(1) FROM t", ["count(1)"])).toContain("q.`count(1)`");
    expect(engineFingerprintSql("SELECT 1 AS `x`", ["we`ird"])).toContain("q.`we``ird`");
  });

  it("refuses duplicate or missing column names", () => {
    expect(() => engineFingerprintSql("SELECT 1", [])).toThrow();
    expect(() => engineFingerprintSql("SELECT a, a FROM t", ["a", "a"])).toThrow();
  });
});
