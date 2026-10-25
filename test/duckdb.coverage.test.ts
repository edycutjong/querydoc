import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DuckDbEngine, SAMPLE_DIR, sampleDirExists } from "../src/engine/duckdb.js";
import { EngineError } from "../src/engine/types.js";

type Conn = { runAndReadAll(sql: string): Promise<unknown> };
const connOf = (x: DuckDbEngine) => (x as unknown as { conn: Conn }).conn;

let e: DuckDbEngine;
beforeAll(async () => {
  e = await DuckDbEngine.open();
});
afterAll(async () => {
  await e.close();
});

describe("DuckDbEngine.open", () => {
  it("fails with an EngineError naming the directory when the sample parquet files are missing", async () => {
    await expect(DuckDbEngine.open({ dataDir: "/nonexistent-querydoc-dir" })).rejects.toThrow(/sample data missing in \/nonexistent-querydoc-dir/);
    await expect(DuckDbEngine.open({ dataDir: "/nonexistent-querydoc-dir" })).rejects.toBeInstanceOf(EngineError);
  });

  it("accepts an explicit dataDir and clamps a non-positive scale to 1 without creating trips_scaled", async () => {
    const x = await DuckDbEngine.open({ dataDir: SAMPLE_DIR, scaleTrips: 0 });
    try {
      expect(x.scale).toBe(1);
      expect((await x.listTables("lake")).map((t) => t.table)).toEqual(["trips"]);
    } finally {
      await x.close();
    }
  });

  it("replicates trips K times into lake.trips_scaled when scaleTrips > 1 (fractional K floors)", async () => {
    const x = await DuckDbEngine.open({ scaleTrips: 2.9 });
    try {
      expect(x.scale).toBe(2);
      expect((await x.listTables("lake")).map((t) => t.table)).toEqual(["trips", "trips_scaled"]);
      const r = await x.run("SELECT (SELECT COUNT(*) FROM lake.trips_scaled) = 2 * (SELECT COUNT(*) FROM lake.trips) AS ok", { drain: true });
      expect(r.rows[0]![0]).toBe(true);
    } finally {
      await x.close();
    }
  }, 30_000);
});

describe("DuckDbEngine.health", () => {
  it("reports ok with a wall time on a live connection", async () => {
    const h = await e.health();
    expect(h.ok).toBe(true);
    expect(h.wallMs).toBeGreaterThanOrEqual(0);
    expect("error" in h).toBe(false);
  });

  it("reports ok:false with the error message when the query fails", async () => {
    const x = await DuckDbEngine.open();
    try {
      (x as unknown as { conn: Conn }).conn = { runAndReadAll: async () => { throw new Error("boom"); } };
    } finally {
      const h = await x.health();
      expect(h).toEqual({ ok: false, wallMs: 0, error: "boom" });
    }
  });
});

describe("DuckDbEngine.run", () => {
  it("returns typed columns and an exact count for a small result without drain", async () => {
    const r = await e.run("SELECT LocationID, Borough FROM ops.zones ORDER BY LocationID LIMIT 3");
    expect(r.columns.map((c) => c.name)).toEqual(["LocationID", "Borough"]);
    expect(r.rows.length).toBe(3);
    expect(r.rowCount).toBe(3);
    expect(r.rowCountExact).toBe(true);
    expect(r.truncated).toBe(false);
  });

  it("marks a capped, non-drained result truncated with rowCount cap+1 and an inexact count", async () => {
    const r = await e.run("SELECT * FROM ops.zones", { rowCap: 5 });
    expect(r.rows.length).toBe(5);
    expect(r.truncated).toBe(true);
    expect(r.rowCount).toBe(6);
    expect(r.rowCountExact).toBe(false);
  });

  it("drains a small table to an exact count while still truncating the returned rows at the cap", async () => {
    const r = await e.run("SELECT * FROM ops.zones", { rowCap: 5, drain: true });
    expect(r.rows.length).toBe(5);
    expect(r.truncated).toBe(true);
    expect(r.rowCount).toBe(265);
    expect(r.rowCountExact).toBe(true);
  });

  it("drains a small result that fits the cap as exact and not truncated", async () => {
    const r = await e.run("SELECT * FROM ops.zones LIMIT 4", { drain: true });
    expect(r.rowCount).toBe(4);
    expect(r.rowCountExact).toBe(true);
    expect(r.truncated).toBe(false);
  });

  it("wraps an engine error as EngineError carrying only the first message line and a wall time", async () => {
    const err = await e.run("SELECT nope FROM ops.zones").catch((x: unknown) => x);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as Error).message).not.toContain("\n");
    expect((err as Error).message).toMatch(/nope/i);
  });

  it("surfaces guard refusals with the guard reason", async () => {
    await expect(e.run("DELETE FROM ops.zones")).rejects.toThrow(/^guard refused the statement: /);
  });

  it("uses the first line of a multi-line engine message", async () => {
    const x = await DuckDbEngine.open();
    try {
      (x as unknown as { conn: unknown }).conn = {
        runAndReadAll: async () => { throw new Error("line one\nline two"); },
        runAndReadUntil: async () => { throw new Error("line one\nline two"); },
        interrupt: () => undefined,
      };
      await expect(x.run("SELECT 1")).rejects.toThrow(/^line one$/);
    } finally {
      await x.run("SELECT 1").catch(() => undefined);
    }
  });
});

describe("DuckDbEngine.explain", () => {
  it("builds a depth-annotated plan for a trailing-semicolon statement", async () => {
    const p = await e.explain("SELECT * FROM ops.zones WHERE LocationID = 1;  ");
    expect(p.format).toBe("duckdb-json");
    expect(p.nodes.length).toBeGreaterThan(0);
    expect(p.nodes[0]!.depth).toBe(0);
    expect(p.nodes.every((n) => n.operator.length > 0)).toBe(true);
    expect(JSON.parse(p.text)).toBeInstanceOf(Array);
  });

  it("refuses to explain a write statement with the guard reason", async () => {
    await expect(e.explain("DROP TABLE lake.trips")).rejects.toThrow(/^guard refused the statement to explain: /);
  });

  it("propagates the engine error when explaining SQL over a missing table", async () => {
    await expect(e.explain("SELECT * FROM lake.no_such_table")).rejects.toThrow(/no_such_table/);
  });

  it("explain with external readers is refused by the guard before reaching the engine", async () => {
    await expect(e.explain("SELECT * FROM read_text('/etc/hosts')")).rejects.toBeInstanceOf(EngineError);
  });

  describe("plan text parsing", () => {
    const withText = async (text: unknown) => {
      const c = connOf(e);
      const orig = c.runAndReadAll;
      c.runAndReadAll = async () => ({ getRowsJson: () => text }) as never;
      try {
        return await e.explain("SELECT 1");
      } finally {
        c.runAndReadAll = orig;
      }
    };

    it("returns an empty node list when the plan text is not JSON", async () => {
      const p = await withText([["physical_plan", "not json"]]);
      expect(p.nodes).toEqual([]);
      expect(p.text).toBe("not json");
    });

    it("returns empty text and no nodes when EXPLAIN yields no rows", async () => {
      const p = await withText([]);
      expect(p.text).toBe("");
      expect(p.nodes).toEqual([]);
    });

    it("names an unnamed operator '?', renders array and scalar extra_info, and recurses into children", async () => {
      const tree = [{ extra_info: { Projections: ["a", "b"], Estimated: 5 }, children: [{ name: "  SEQ_SCAN  ", extra_info: { t: "zones" } }] }];
      const p = await withText([["physical_plan", JSON.stringify(tree)]]);
      expect(p.nodes).toEqual([
        { id: 1, depth: 0, operator: "?", detail: "Projections: a; b | Estimated: 5" },
        { id: 2, depth: 1, operator: "SEQ_SCAN", detail: "t: zones" },
      ]);
    });

    it("truncates long detail to 300 characters and collapses whitespace", async () => {
      const tree = [{ name: "X", extra_info: { big: "a  \n b".repeat(200) } }];
      const p = await withText([["physical_plan", JSON.stringify(tree)]]);
      expect(p.nodes[0]!.detail.length).toBe(300);
      expect(p.nodes[0]!.detail).not.toMatch(/\s{2}/);
    });
  });
});

describe("DuckDbEngine metadata and helpers", () => {
  it("lists nothing for an unknown schema and reports no columns for an unknown table", async () => {
    expect(await e.listTables("no_such_schema")).toEqual([]);
    expect(await e.tableInfo({ schema: "ops", table: "no_such_table" })).toEqual([]);
  });

  it("sampleDirExists is true for the committed sample and false for a missing directory", () => {
    expect(sampleDirExists()).toBe(true);
    expect(sampleDirExists("/nonexistent-querydoc-dir")).toBe(false);
  });

  it("exposes engine identity flags", () => {
    expect(e.name).toBe("duckdb");
    expect(e.reportsTruncation).toBe(true);
    expect(e.scale).toBe(1);
  });
});
