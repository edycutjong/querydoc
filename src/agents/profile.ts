import type { QueryEngine } from "../engine/types.js";
import { sqlGuard } from "../guard/sqlGuard.js";
import { maskSql, trimStatement } from "../sql/text.js";
import type { Trace } from "../trace.js";
import { findJoins } from "./patterns.js";

// SQL-aggregate profile facts for the columns a join touches (no MCP `profile_table` exists on the local platform): for each
// join key on the joined side, row count, non-NULL count and distinct count. These go into the Rewriter's prompt so it knows
// whether a key is unique — the fact that separates the hero from its trap. Read-only, guarded, wall time in the trace.

export interface KeyFact {
  table: string;
  column: string;
  rows: number;
  non_null: number;
  distinct: number;
  unique: boolean; // distinct == non_null == rows
}

export async function profileJoinKeys(engine: QueryEngine, sql: string, dialect: string, trace: Trace): Promise<KeyFact[]> {
  const m = maskSql(trimStatement(sql)).toLowerCase();
  const wanted = new Map<string, { table: string; column: string }>();
  for (const j of findJoins(m)) {
    const re = new RegExp(`\\b${j.alias}\\s*\\.\\s*([a-z_][a-z0-9_]*)`, "g");
    for (const c of j.on.matchAll(re)) wanted.set(`${j.table}.${c[1]}`, { table: j.table, column: c[1]! });
  }
  const facts: KeyFact[] = [];
  for (const { table, column } of wanted.values()) {
    const q = `SELECT COUNT(*) AS n, COUNT(${column}) AS nn, COUNT(DISTINCT ${column}) AS d FROM ${table}`;
    if (!sqlGuard(q, dialect).ok) continue;
    try {
      const r = await engine.run(q, { rowCap: 1, timeoutSec: 120 });
      const [n, nn, d] = (r.rows[0] ?? []).map(Number) as [number, number, number];
      facts.push({ table, column, rows: n, non_null: nn, distinct: d, unique: d === nn && nn === n });
      trace.emit({
        agent_name: "Orchestrator", action: "profile_keys", input_summary: `${table}.${column}`,
        output_summary: `rows ${n}, non-null ${nn}, distinct ${d}`, target_agent: "Rewriter",
        sponsor_call: { service: engine.name, name: "run_sql", latency_ms: Math.round(r.wallMs * 10) / 10 }, retry_count: 0, status: "ok",
      });
    } catch (e) {
      trace.emit({
        agent_name: "Orchestrator", action: "profile_keys", input_summary: `${table}.${column}`, output_summary: (e as Error).message.slice(0, 200),
        target_agent: null, retry_count: 0, status: "error",
      });
    }
  }
  return facts;
}

export const keyFactLine = (f: KeyFact): string =>
  `${f.table}.${f.column}: ${f.rows} rows, ${f.non_null} non-NULL, ${f.distinct} distinct → ${f.unique ? "UNIQUE" : f.distinct === f.non_null ? "has NULLs, otherwise unique" : "NOT unique (repeated values)"}`;
