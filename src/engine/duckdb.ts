import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { ROOT } from "../config.js";
import { duckdbFingerprintSql } from "../verify/fingerprint.js";
import { sqlGuard } from "../guard/sqlGuard.js";
import { EngineError, type Cell, type Column, type Plan, type PlanNode, type QueryEngine, type RunOptions, type RunResult, type TableRef } from "./types.js";

// The keyless sample engine: an in-process DuckDB holding the committed NYC TLC subset (data/sample/) in schemas `lake` and `ops`.
// It is a different optimiser from Zetaris — sample-mode speedups say nothing about Zetaris — but it runs the same Verifier code.
// After loading, external access is switched off and the configuration locked, so a SELECT that calls a file or URL reader
// (read_text('/proc/self/environ')) fails inside the engine even if it got past the guard.

export const SAMPLE_DIR = join(ROOT, "data", "sample");
const DEFAULT_ROW_CAP = 10_000;
const DEFAULT_TIMEOUT_SEC = 120;

export interface DuckDbOptions {
  dataDir?: string;
  // Replicates lake.trips K times at load into lake.trips_scaled (labelled "scaled ×K at load"); traps never use it.
  scaleTrips?: number;
}

export class DuckDbEngine implements QueryEngine {
  readonly name = "duckdb" as const;
  readonly reportsTruncation = true;
  readonly scale: number;

  private constructor(private readonly db: DuckDBInstance, private readonly conn: DuckDBConnection, scale: number) {
    this.scale = scale;
  }

  static async open(o: DuckDbOptions = {}): Promise<DuckDbEngine> {
    const dir = resolve(o.dataDir ?? SAMPLE_DIR);
    const trips = join(dir, "trips.parquet");
    const zones = join(dir, "zones.parquet");
    if (!existsSync(trips) || !existsSync(zones)) throw new EngineError(`sample data missing in ${dir} (run scripts/make_sample.ts)`);
    const db = await DuckDBInstance.create(":memory:");
    const conn = await db.connect();
    const q = (p: string) => p.replace(/'/g, "''");
    await conn.run("CREATE SCHEMA lake");
    await conn.run("CREATE SCHEMA ops");
    await conn.run(`CREATE TABLE lake.trips AS SELECT * FROM read_parquet('${q(trips)}')`);
    await conn.run(`CREATE TABLE ops.zones AS SELECT * FROM read_parquet('${q(zones)}')`);
    const scale = Math.max(1, Math.floor(o.scaleTrips ?? 1));
    if (scale > 1) await conn.run(`CREATE TABLE lake.trips_scaled AS SELECT t.* FROM lake.trips t, range(${scale}) r(k)`);
    await conn.run("SET memory_limit = '2GB'");
    await conn.run("SET enable_external_access = false");
    await conn.run("SET lock_configuration = true");
    return new DuckDbEngine(db, conn, scale);
  }

  rowHashSql(innerSql: string, columns: Column[], floatSigDigits: number): string {
    return duckdbFingerprintSql(innerSql, columns, floatSigDigits);
  }

  async health() {
    const t0 = performance.now();
    try {
      await this.conn.runAndReadAll("SELECT 1");
      return { ok: true, wallMs: Math.round((performance.now() - t0) * 10) / 10 };
    } catch (e) {
      return { ok: false, wallMs: 0, error: (e as Error).message };
    }
  }

  async listTables(schema: string): Promise<TableRef[]> {
    const r = await this.conn.runAndReadAll("SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 2", [schema]);
    return r.getRowsJson().map((row) => ({ schema: String(row[0]), table: String(row[1]) }));
  }

  async tableInfo(t: TableRef): Promise<Column[]> {
    const r = await this.conn.runAndReadAll(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position",
      [t.schema, t.table],
    );
    return r.getRowsJson().map((row) => ({ name: String(row[0]), type: String(row[1]).toLowerCase() }));
  }

  async run(sql: string, opts: RunOptions = {}): Promise<RunResult> {
    const g = sqlGuard(sql, "postgresql");
    if (!g.ok) throw new EngineError(`guard refused the statement: ${g.reason}`);
    const rowCap = opts.rowCap ?? DEFAULT_ROW_CAP;
    const timer = setTimeout(() => this.conn.interrupt(), (opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000);
    const t0 = performance.now();
    try {
      const reader = opts.drain ? await this.conn.runAndReadAll(sql) : await this.conn.runAndReadUntil(sql, rowCap + 1);
      const wallMs = Math.round((performance.now() - t0) * 10) / 10;
      const all = reader.getRowsJson() as Cell[][];
      const columns: Column[] = reader.columnNames().map((name, i) => ({ name, type: String(reader.columnTypes()[i]).toLowerCase() }));
      const truncated = all.length > rowCap;
      return {
        columns, rows: all.slice(0, rowCap), rowCount: opts.drain || !truncated ? all.length : rowCap + 1,
        rowCountExact: opts.drain ? true : !truncated, truncated, wallMs,
      };
    } catch (e) {
      throw new EngineError((e as Error).message.split("\n")[0] ?? "duckdb error", null, Math.round((performance.now() - t0) * 10) / 10);
    } finally {
      clearTimeout(timer);
    }
  }

  // DuckDB's physical plan from EXPLAIN. Node ids are pre-order indexes of the operator boxes' names read from EXPLAIN (FORMAT JSON).
  async explain(sql: string): Promise<Plan> {
    const g = sqlGuard(sql, "postgresql");
    if (!g.ok) throw new EngineError(`guard refused the statement to explain: ${g.reason}`);
    const t0 = performance.now();
    const r = await this.conn.runAndReadAll(`EXPLAIN (FORMAT JSON) ${sql.trim().replace(/;\s*$/, "")}`);
    const wallMs = Math.round((performance.now() - t0) * 10) / 10;
    const text = String(r.getRowsJson()[0]?.[1] ?? "");
    const nodes: PlanNode[] = [];
    try {
      const walk = (n: { name?: string; extra_info?: Record<string, unknown>; children?: unknown[] }, depth: number) => {
        const extra = n.extra_info ?? {};
        const detail = Object.entries(extra).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join("; ") : String(v)}`).join(" | ").replace(/\s+/g, " ").slice(0, 300);
        nodes.push({ id: nodes.length + 1, depth, operator: String(n.name ?? "?").trim(), detail });
        for (const c of n.children ?? []) walk(c as typeof n, depth + 1);
      };
      for (const root of JSON.parse(text) as unknown[]) walk(root as { name?: string }, 0);
    } catch {
      nodes.length = 0;
    }
    return { format: "duckdb-json", text, nodes, wallMs };
  }

  async close() {
    this.conn.closeSync();
    this.db.closeSync();
  }
}

export const sampleDirExists = (dir = SAMPLE_DIR): boolean => existsSync(join(dir, "trips.parquet")) && existsSync(join(dirname(dir), "sample", "zones.parquet"));
