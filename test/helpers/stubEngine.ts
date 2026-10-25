import { createHash } from "node:crypto";
import { EngineError, type Cell, type Column, type Plan, type QueryEngine, type RunOptions, type RunResult, type TableRef } from "../../src/engine/types.js";

// An in-memory engine for Verifier tests. Each registered query has columns, rows (or a function of the call number, for a
// non-deterministic query) and a wall time. It answers the Verifier's two wrappers — COUNT(*) and the row-hash fingerprint —
// over the FULL rows, and can silently truncate plain results at `silentLimit` without flagging it (an unknown tool limit).

export interface StubQuery {
  columns: Column[];
  rows: Cell[][] | ((call: number) => Cell[][]);
  wallMs?: number;
  delayMs?: number; // real time spent per call, for the timing cap
  failOnCall?: number; // the n-th plain run of this query throws (an engine error mid-timing)
}

export class StubEngine implements QueryEngine {
  readonly name = "duckdb" as const;
  readonly calls: string[] = [];
  private readonly counts = new Map<string, number>();
  constructor(
    private readonly queries: Record<string, StubQuery>,
    readonly reportsTruncation = true,
    private readonly silentLimit = Infinity,
    private readonly brokenRowHash = false, // the fingerprint wrapper returns a NULL sum (e.g. a DECIMAL overflow)
  ) {}

  private lookup(sql: string): { q: StubQuery; rows: Cell[][] } {
    const q = this.queries[sql.trim()];
    if (!q) throw new Error(`stub: unknown query ${sql}`);
    const n = (this.counts.get(sql) ?? 0) + 1;
    this.counts.set(sql, n);
    return { q, rows: typeof q.rows === "function" ? q.rows(n) : q.rows };
  }

  async run(sql: string, opts: RunOptions = {}): Promise<RunResult> {
    this.calls.push(sql);
    const inner = (prefix: string) => (sql.startsWith(prefix) ? sql.slice(sql.indexOf("FROM (") + 6, -3) : null);
    const countInner = inner("SELECT COUNT(*) AS qd_count FROM (");
    if (countInner !== null) {
      const { q, rows } = this.lookup(countInner);
      return this.result([{ name: "qd_count", type: "bigint" }], [[rows.length]], q.wallMs ?? 10, false);
    }
    const hashInner = inner("SELECT COUNT(*) AS qd_rows");
    if (hashInner !== null && this.brokenRowHash) return this.result([{ name: "qd_rows", type: "bigint" }, { name: "qd_hash_sum", type: "string" }], [[0, null]], 1, false);
    if (hashInner !== null) {
      const { q, rows } = this.lookup(hashInner);
      let sum = 0n;
      for (const r of rows) sum += BigInt("0x" + createHash("sha256").update(JSON.stringify(r)).digest("hex").slice(0, 15));
      return this.result([{ name: "qd_rows", type: "bigint" }, { name: "qd_hash_sum", type: "string" }], [[rows.length, sum.toString()]], q.wallMs ?? 10, false);
    }
    const { q, rows } = this.lookup(sql);
    if (q.delayMs) await new Promise((r) => setTimeout(r, q.delayMs));
    if (q.failOnCall !== undefined && this.counts.get(sql) === q.failOnCall) throw new EngineError("stub: engine error", null, 1);
    const cap = opts.rowCap ?? 10_000;
    const visible = rows.slice(0, this.silentLimit);
    const truncated = this.reportsTruncation && visible.length > cap;
    return this.result(q.columns, visible.slice(0, cap), q.wallMs ?? 10, truncated);
  }

  private result(columns: Column[], rows: Cell[][], wallMs: number, truncated: boolean): RunResult {
    return { columns, rows, rowCount: rows.length, rowCountExact: !truncated, truncated, wallMs };
  }

  rowHashSql(innerSql: string, columns: Column[]): string {
    return `SELECT COUNT(*) AS qd_rows, SUM(hash(${columns.map((c) => c.name).join(", ")})) FROM (${innerSql}) q`;
  }
  async health() {
    return { ok: true, wallMs: 1 };
  }
  async listTables(): Promise<TableRef[]> {
    return [];
  }
  async tableInfo(): Promise<Column[]> {
    return [];
  }
  async explain(): Promise<Plan> {
    return { format: "duckdb-json", text: "", nodes: [], wallMs: 0 };
  }
  async close() {}
}
