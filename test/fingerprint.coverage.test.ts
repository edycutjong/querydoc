import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDbEngine } from "../src/engine/duckdb.js";
import { countStarSql, duckdbFingerprintSql, engineFingerprintSql, NULL_SENTINEL, quoteSparkIdent } from "../src/verify/fingerprint.js";

describe("engineFingerprintSql column handling", () => {
  it("rounds float Column objects to the requested significant digits and casts others to STRING", () => {
    const sql = engineFingerprintSql("SELECT x, y FROM t", [
      { name: "x", type: "double" },
      { name: "y", type: "bigint" },
    ]);
    expect(sql).toContain("format_string('%.8e', CAST(q.`x` AS DOUBLE))");
    expect(sql).toContain("CAST(q.`y` AS STRING)");
    expect(engineFingerprintSql("SELECT x FROM t", [{ name: "x", type: "float" }], "xxhash64", 4)).toContain("'%.3e'");
  });

  it("honours a custom hash function and rejects empty or duplicate Column objects", () => {
    expect(engineFingerprintSql("SELECT a FROM t", ["a"], "murmur3")).toContain("SUM(CAST(murmur3(");
    expect(() => engineFingerprintSql("SELECT 1", [])).toThrow("at least one column");
    expect(() => engineFingerprintSql("SELECT 1", [{ name: "a", type: "int" }, { name: "a", type: "int" }])).toThrow("distinct");
  });

  it("quotes backticks and strips trailing semicolons in helper SQL", () => {
    expect(quoteSparkIdent("a`b")).toBe("`a``b`");
    expect(countStarSql("  SELECT 1;  ")).toBe("SELECT COUNT(*) AS qd_count FROM (SELECT 1) q");
  });
});

describe("duckdbFingerprintSql", () => {
  it("builds tagged, variadic-hash SQL with float rounding and quoted identifiers", () => {
    const sql = duckdbFingerprintSql("SELECT * FROM t;", [
      { name: 'we"ird', type: "varchar" },
      { name: "f", type: "double" },
    ]);
    expect(sql).toContain(`COALESCE('v' || CAST(q."we""ird" AS VARCHAR), '${NULL_SENTINEL}')`);
    expect(sql).toContain(`printf('%.8e', CAST(q."f" AS DOUBLE))`);
    expect(sql).toContain("AS HUGEINT");
    expect(sql.endsWith("FROM (SELECT * FROM t) q")).toBe(true);
    expect(duckdbFingerprintSql("SELECT f", [{ name: "f", type: "real" }], 5)).toContain("'%.4e'");
  });

  it("refuses empty or duplicate columns", () => {
    expect(() => duckdbFingerprintSql("SELECT 1", [])).toThrow("at least one column");
    expect(() => duckdbFingerprintSql("SELECT 1", [{ name: "a", type: "int" }, { name: "a", type: "int" }])).toThrow("distinct");
  });

  describe("executed on DuckDB", () => {
    let e: DuckDbEngine;
    beforeAll(async () => {
      e = await DuckDbEngine.open();
    });
    afterAll(async () => {
      await e.close();
    });

    const fp = async (inner: string) => {
      const cols = (await e.run(inner, { rowCap: 1 })).columns;
      const r = await e.run(duckdbFingerprintSql(inner, cols), { rowCap: 1 });
      return r.rows[0]!.map(String);
    };

    it("is order-independent, counts duplicates, and separates NULL from the literal 'n'", async () => {
      const a = await fp("SELECT * FROM (VALUES (1, 'a'), (2, NULL), (1, 'a')) t(i, s)");
      const b = await fp("SELECT * FROM (VALUES (1, 'a'), (1, 'a'), (2, NULL)) t(i, s)");
      expect(a).toEqual(b);
      expect(a[0]).toBe("3");
      const nul = await fp("SELECT * FROM (VALUES (CAST(NULL AS VARCHAR))) t(s)");
      const lit = await fp("SELECT * FROM (VALUES ('n')) t(s)");
      expect(nul[1]).not.toBe(lit[1]);
    });

    it("treats floats equal within the rounding digits only", async () => {
      const x = await fp("SELECT 1.00000000001::DOUBLE AS f");
      const y = await fp("SELECT 1.0::DOUBLE AS f");
      const z = await fp("SELECT 1.1::DOUBLE AS f");
      expect(x).toEqual(y);
      expect(x[1]).not.toBe(z[1]);
    });
  });
});
