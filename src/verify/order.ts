import pkg from "node-sql-parser";
import { maskSql } from "../sql/text.js";

const { Parser } = pkg;
const parser = new Parser();

// How a result must be compared, read from the ORIGINAL query's top-level ORDER BY / LIMIT:
// - multiset: no top-level ORDER BY → order is not part of the answer;
// - ordered:  every ORDER BY key is an output column (by name, alias or ordinal) → rows compare in key sequence, and rows tied on
//             the keys compare as a multiset (a tie emitted in another order is not a difference);
// - raw:      ORDER BY present but unparsed, or a key is an expression / not selected → rows compare in raw result order
//             (fail-safe: a tie can only cause a refusal, never an accept).

export type OrderSpec =
  | { kind: "multiset"; limit: number | null }
  | { kind: "ordered"; keyIdx: number[]; limit: number | null }
  | { kind: "raw"; reason: string; limit: number | null };

interface AstLike {
  type?: string;
  orderby?: { expr: { type: string; column?: unknown; value?: unknown } }[] | null;
  limit?: { value?: { type: string; value: unknown }[] } | null;
  _next?: AstLike | null;
}

function columnName(c: unknown): string | null {
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && "expr" in c) {
    const v = (c as { expr: { value?: unknown } }).expr.value;
    return typeof v === "string" ? v : null;
  }
  return null;
}

export function orderSpec(sql: string, outputColumns: string[], dialect = "hive"): OrderSpec {
  let ast: AstLike;
  try {
    const parsed = parser.astify(sql, { database: dialect }) as AstLike | AstLike[];
    ast = Array.isArray(parsed) ? parsed[0]! : parsed;
  } catch {
    const masked = maskSql(sql);
    const hasOrder = /\border\s+by\b/i.test(masked);
    const m = /\bLIMIT\s+(\d+)\s*;?\s*$/i.exec(masked);
    const limit = m ? Number(m[1]) : null;
    return hasOrder ? { kind: "raw", reason: "ORDER BY not parsed", limit } : { kind: "multiset", limit };
  }
  // In a UNION chain the trailing ORDER BY / LIMIT belong to the whole statement and sit on the last branch.
  let top: AstLike = ast;
  while (top._next) top = top._next;
  const lim = top.limit?.value?.[0];
  const limit = lim && lim.type === "number" ? Number(lim.value) : null;
  const keys = top.orderby ?? ast.orderby ?? null;
  if (!keys || keys.length === 0) return { kind: "multiset", limit };

  const lower = outputColumns.map((c) => c.toLowerCase());
  const keyIdx: number[] = [];
  for (const k of keys) {
    let idx = -1;
    if (k.expr.type === "number") {
      const ord = Number(k.expr.value);
      if (Number.isInteger(ord) && ord >= 1 && ord <= outputColumns.length) idx = ord - 1;
    } else if (k.expr.type === "column_ref") {
      const name = columnName(k.expr.column)?.toLowerCase();
      if (name !== undefined && name !== null && lower.filter((c) => c === name).length === 1) idx = lower.indexOf(name);
    }
    if (idx < 0) return { kind: "raw", reason: "ORDER BY key is not a single output column", limit };
    keyIdx.push(idx);
  }
  return { kind: "ordered", keyIdx, limit };
}

// True when the statement has an ORDER BY outside every parenthesis — the one that orders the result. A subquery's ORDER BY or a
// window's OVER (ORDER BY …) does not count. Text-level, so it also holds for a statement the parser cannot read.
export function hasTopLevelOrderBy(sql: string): boolean {
  const m = maskSql(sql);
  let depth = 0;
  for (let i = 0; i < m.length; i++) {
    const c = m[i];
    if (c === "(") depth++;
    else if (c === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (c === "o" || c === "O") && /^order\s+by\b/i.test(m.slice(i, i + 12)) && !/\w/.test(m[i - 1] ?? "")) return true;
  }
  return false;
}
