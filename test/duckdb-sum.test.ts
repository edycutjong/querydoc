import { DuckDBInstance } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";
import { canonRows } from "../src/verify/canonical.js";
import { diffRows } from "../src/verify/diff.js";
import { orderSpec } from "../src/verify/order.js";

// Sets the float tolerance: a pre-aggregation rewrite re-orders a SUM(double), which moves its last bits. The Verifier must call
// the two results equal at floatSigDigits (9) and still see a real change in the value.
describe("re-ordered SUM(double) on DuckDB", () => {
  it("raw sums differ in the last bits; canonical rows at 9 significant digits are equal", async () => {
    const db = await DuckDBInstance.create(":memory:");
    const c = await db.connect();
    await c.run(
      "CREATE TABLE f AS SELECT i % 97 AS g, (((i * 7919) % 100003) / 7.0) * (CASE WHEN i % 2 = 0 THEN 1e6 ELSE 1e-3 END) AS x FROM range(200000) t(i)",
    );
    const read = async (sql: string) => {
      const r = await c.runAndReadAll(sql);
      return { rows: r.getRowsJS() as number[][], cols: r.columnNames().map((name, i) => ({ name, type: String(r.columnTypes()[i]) })) };
    };
    const direct = await read("SELECT SUM(x) AS s FROM (SELECT x FROM f ORDER BY x DESC)");
    const preAgg = await read("SELECT SUM(s) AS s FROM (SELECT g, SUM(x) AS s FROM (SELECT g, x FROM f ORDER BY x ASC) GROUP BY g)");
    expect(direct.cols[0]!.type).toBe("DOUBLE");
    const a = direct.rows[0]![0]!;
    const b = preAgg.rows[0]![0]!;
    expect(a).not.toBe(b); // the re-ordering really moved the last bits
    const rel = Math.abs(a - b) / Math.abs(a);
    expect(rel).toBeLessThan(1e-9);
    const spec = orderSpec("SELECT SUM(x) AS s FROM f", ["s"]);
    expect(diffRows(canonRows(direct.rows, direct.cols, 9), canonRows(preAgg.rows, preAgg.cols, 9), spec).equal).toBe(true);
    // a real change (one row dropped) is still a difference
    const dropped = await read("SELECT SUM(x) AS s FROM f WHERE NOT (g = 3 AND x = (SELECT MAX(x) FROM f WHERE g = 3))");
    expect(diffRows(canonRows(direct.rows, direct.cols, 9), canonRows(dropped.rows, dropped.cols, 9), spec).equal).toBe(false);
    c.closeSync();
  });
});
