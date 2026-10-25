import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDbEngine } from "../src/engine/duckdb.js";
import { EngineError } from "../src/engine/types.js";
import { sqlGuard } from "../src/guard/sqlGuard.js";

let e: DuckDbEngine;
beforeAll(async () => {
  e = await DuckDbEngine.open();
});
afterAll(async () => {
  await e.close();
});

describe("DuckDB sample engine (committed NYC TLC subset)", () => {
  it("has the two schemas with real NULLs and duplicates for the traps", async () => {
    expect((await e.listTables("lake")).map((t) => t.table)).toEqual(["trips"]);
    expect((await e.listTables("ops")).map((t) => t.table)).toEqual(["zones"]);
    const r = await e.run("SELECT COUNT(*) AS n, COUNT(*) - COUNT(RatecodeID) AS null_rate FROM lake.trips", { drain: true });
    expect(Number(r.rows[0]![0])).toBeGreaterThan(100_000);
    expect(Number(r.rows[0]![1])).toBeGreaterThan(0);
    expect((await e.tableInfo({ schema: "ops", table: "zones" })).map((c) => c.name)).toContain("LocationID");
  });

  it("reports the row cap truncation reliably and an exact count when draining", async () => {
    const capped = await e.run("SELECT * FROM lake.trips", { rowCap: 50 });
    expect(capped.rows.length).toBe(50);
    expect(capped.truncated).toBe(true);
    expect(capped.rowCountExact).toBe(false);
    const drained = await e.run("SELECT * FROM lake.trips", { rowCap: 50, drain: true });
    expect(drained.truncated).toBe(true);
    expect(drained.rowCountExact).toBe(true);
    expect(drained.rowCount).toBeGreaterThan(100_000);
    const small = await e.run("SELECT * FROM ops.zones", { rowCap: 1000 });
    expect(small.truncated).toBe(false);
    expect(small.rows.length).toBe(265);
  });

  it("the row-hash fingerprint is order-independent, sees a changed value, and duplicate rows do not cancel", async () => {
    const fp = async (inner: string) => {
      const cols = (await e.run(inner, { rowCap: 1 })).columns;
      const r = await e.run(e.rowHashSql(inner, cols, 9), { rowCap: 1 });
      return JSON.stringify(r.rows[0]);
    };
    const a = await fp("SELECT LocationID, Borough FROM ops.zones");
    expect(await fp("SELECT LocationID, Borough FROM ops.zones ORDER BY LocationID DESC")).toBe(a);
    expect(await fp("SELECT LocationID, CASE WHEN LocationID = 7 THEN 'x' ELSE Borough END AS Borough FROM ops.zones")).not.toBe(a);
    // the XOR trap: two copies of the same row vs none must differ
    expect(await fp("SELECT 1 AS a, 'x' AS b UNION ALL SELECT 1, 'x'")).not.toBe(await fp("SELECT 1 AS a, 'x' AS b WHERE false"));
    // ('ab','c') vs ('a','bc') and (NULL,'a') vs ('a',NULL) stay apart
    expect(await fp("SELECT 'ab' AS a, 'c' AS b")).not.toBe(await fp("SELECT 'a' AS a, 'bc' AS b"));
    expect(await fp("SELECT NULL::VARCHAR AS a, 'a' AS b")).not.toBe(await fp("SELECT 'a' AS a, NULL::VARCHAR AS b"));
  });

  it("refuses file, URL and environment readers: the guard says no, and with the guard bypassed the engine still cannot read", async () => {
    for (const sql of ["SELECT * FROM read_text('/etc/hosts')", "SELECT * FROM read_csv('/etc/hosts')", "SELECT getenv('NVIDIA_API_KEY')", "SELECT * FROM glob('/*')"]) {
      expect(sqlGuard(sql, "postgresql").ok).toBe(false);
      await expect(e.run(sql)).rejects.toBeInstanceOf(EngineError);
    }
    const conn = (e as unknown as { conn: { runAndReadAll(sql: string): Promise<unknown> } }).conn;
    await expect(conn.runAndReadAll("SELECT * FROM read_text('/etc/hosts')")).rejects.toThrow(/external access|disabled|permission/i);
    await expect(conn.runAndReadAll("SET enable_external_access = true")).rejects.toThrow(/lock|configuration|cannot/i);
  });

  it("explain returns numbered plan nodes with operator names", async () => {
    const p = await e.explain("SELECT z.Borough, COUNT(*) FROM lake.trips t JOIN ops.zones z ON z.LocationID = t.PULocationID GROUP BY 1");
    expect(p.format).toBe("duckdb-json");
    expect(p.nodes.map((n) => n.id)).toEqual(p.nodes.map((_, i) => i + 1));
    expect(p.nodes.some((n) => /JOIN/.test(n.operator))).toBe(true);
  });

  it("a write statement is refused before it reaches the engine", async () => {
    await expect(e.run("DROP TABLE lake.trips")).rejects.toThrow(/guard refused/);
    await expect(e.run("SELECT 1; SELECT 2")).rejects.toThrow(/guard refused/);
    expect((await e.run("SELECT COUNT(*) FROM lake.trips", { drain: true })).rows.length).toBe(1);
  });
});

describe("DuckDB engine limits and guard extras", () => {
  it("interrupts a query that runs past its timeout and stays usable afterwards", async () => {
    await expect(e.run("SELECT COUNT(*) FROM range(100000000000) a, range(1000) b", { timeoutSec: 1, drain: true })).rejects.toBeInstanceOf(EngineError);
    expect(Number((await e.run("SELECT 1", { drain: true })).rows[0]![0])).toBe(1);
  }, 20_000);

  it("refuses quoted-path replacement scans (FROM 'file') at the guard, and the engine would refuse them anyway", async () => {
    for (const sql of ["SELECT * FROM '/etc/hosts'", "SELECT * FROM 'data/sample/zones.parquet'", "SELECT * FROM lake.trips t JOIN 'https://x.example/a.csv' c ON true"]) {
      expect(sqlGuard(sql, "postgresql").ok, sql).toBe(false);
    }
    expect(sqlGuard('SELECT * FROM  "/etc/hosts"', "postgresql").ok).toBe(false);
    const fine = ["SELECT * FROM lake.trips WHERE store_and_fwd_flag = 'N'", "SELECT EXTRACT(year FROM '2024-01-01'::date) AS y", "SELECT TRIM(BOTH 'x' FROM 'xabcx') AS t", "SELECT a FROM (SELECT 'a' AS a) q", "SELECT 1 WHERE 'data from ''x''' = 'y'"];
    for (const ok of fine) expect(sqlGuard(ok, "postgresql").ok, ok).toBe(true);
    const conn = (e as unknown as { conn: { runAndReadAll(sql: string): Promise<unknown> } }).conn;
    await expect(conn.runAndReadAll("SELECT * FROM '/etc/hosts'")).rejects.toThrow(/disabled|permission|external|does not exist/i); // with external access off the path is not even looked up as a file
  });
});
