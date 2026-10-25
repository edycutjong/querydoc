import { describe, expect, it } from "vitest";
import { sqlGuard } from "../src/guard/sqlGuard.js";
import { maskSql } from "../src/sql/text.js";

describe("sqlGuard (Zetaris side, hive dialect)", () => {
  const passes = [
    "SELECT COUNT(1) AS n FROM TPCDS_DB.store_sales ss LEFT JOIN TPCDS_DB.promotion p ON ss.ss_promo_sk = p.p_promo_sk WHERE ss.ss_customer_sk IS NULL",
    "WITH c AS (SELECT 1 AS a) SELECT a FROM c",
    "SELECT 'DROP TABLE x; DELETE' AS s",
    "SELECT a FROM t -- DROP TABLE t\n",
    "SELECT /* INSERT INTO t */ a FROM t ORDER BY a DESC",
    "SELECT date_add(d, 1), replace(s, 'a', 'b') FROM t;",
    "(SELECT 1)",
  ];
  for (const sql of passes) it(`passes: ${sql.slice(0, 60)}`, () => expect(sqlGuard(sql)).toMatchObject({ ok: true }));

  const refused: [string, RegExp][] = [
    ["CREATE TABLE x AS SELECT 1", /not a SELECT/],
    ["ALTER TABLE t ADD COLUMNS (c INT)", /not a SELECT/],
    ["INSERT INTO t SELECT 1", /not a SELECT/],
    ["ACTIVATE DATASOURCE s3src", /not a SELECT/],
    ["SELECT 1; DROP TABLE t", /more than one statement/],
    ["SELECT 1;\nINSERT INTO t VALUES (1)", /more than one statement/],
    ["WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", /INSERT/],
    ["SELECT * FROM parquet.`s3a://bucket/path`", /file/],
    ["SELECT reflect('java.lang.Runtime', 'getRuntime')", /JVM/],
    ["/* hi */ DELETE FROM t", /not a SELECT/],
    ["", /empty/],
  ];
  for (const [sql, why] of refused)
    it(`refuses: ${sql.slice(0, 60) || "(empty)"}`, () => {
      const g = sqlGuard(sql);
      expect(g.ok).toBe(false);
      expect(g.reason).toMatch(why);
    });

  it("a single statement the parser cannot read but the scan passes is a WARN", () => {
    const g = sqlGuard("SELECT a FROM t QUALIFY ROW_NUMBER() OVER (PARTITION BY a ORDER BY b) = 1 ???");
    expect(g.ok).toBe(true);
    expect(g.warnings[0]).toMatch(/keyword scan passed/);
  });

  it("masks literals, quoted identifiers and comments but keeps offsets", () => {
    const sql = "SELECT 'a;b', `x;y` -- ;\nFROM t";
    const m = maskSql(sql);
    expect(m).toHaveLength(sql.length);
    expect(m.includes(";")).toBe(false);
  });
});
