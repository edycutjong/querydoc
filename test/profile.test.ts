import { describe, expect, it } from "vitest";
import { profileJoinKeys } from "../src/agents/profile.js";
import type { QueryEngine, RunResult } from "../src/engine/types.js";
import { Trace } from "../src/trace.js";

// The join-key profile quotes every name, so a key or table named like a guarded keyword still gets its measured fact.
const fake = (name: "zetaris" | "duckdb", seen: string[]) =>
  ({
    name,
    run: async (sql: string): Promise<RunResult> => {
      seen.push(sql);
      return { columns: [], rows: [[4, 4, 4]], rowCount: 1, rowCountExact: true, truncated: false, wallMs: 1 };
    },
  }) as unknown as QueryEngine;

describe("profileJoinKeys", () => {
  it("a join key named like a keyword (comment) is profiled, quoted for the engine", async () => {
    const seen: string[] = [];
    const facts = await profileJoinKeys(fake("zetaris", seen), "SELECT COUNT(1) FROM db.f x LEFT JOIN db.d y ON x.comment = y.comment", "hive", new Trace("t"));
    expect(seen).toEqual(["SELECT COUNT(*) AS n, COUNT(`comment`) AS nn, COUNT(DISTINCT `comment`) AS d FROM `db`.`d`"]);
    expect(facts).toMatchObject([{ table: "db.d", column: "comment", unique: true }]);
  });
  it("DuckDB gets double-quoted names", async () => {
    const seen: string[] = [];
    await profileJoinKeys(fake("duckdb", seen), "SELECT COUNT(1) FROM lake.trips t LEFT JOIN ops.zones z ON t.pulocationid = z.locationid", "postgresql", new Trace("t"));
    expect(seen[0]).toBe('SELECT COUNT(*) AS n, COUNT("locationid") AS nn, COUNT(DISTINCT "locationid") AS d FROM "ops"."zones"');
  });
});
