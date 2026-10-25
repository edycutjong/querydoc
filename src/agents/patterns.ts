import pkg from "node-sql-parser";
import type { Plan, PlanNode } from "../engine/types.js";
import { maskSql, trimStatement } from "../sql/text.js";

const { Parser } = pkg;
const parser = new Parser();

// The deterministic half of the Diagnoser (architecture §agents/diagnoser.ts part 1): a closed-enum pattern label and the plan
// nodes it cites, from rules over the masked SQL text with the parser's table list as structure. No key, no model: it always
// runs, and no model output is used to pick a label that reaches a verdict or the playbook (W4). `unused_outer_join` is added to
// the architecture's enum because the hero (trino#2939 shape) and its trap are exactly that shape.

export const PATTERN_LABELS = [
  "unused_outer_join",
  "outer_join_predicate",
  "not_in_nullable",
  "correlated_subquery",
  "union_dedupe",
  "non_sargable_predicate",
  "distinct_over_fanout",
  "cross_source_join_no_pushdown",
  "other",
] as const;
export type PatternLabel = (typeof PATTERN_LABELS)[number];

export interface PatternHit {
  label: PatternLabel;
  evidence: string; // the matched text, trimmed, for the trace and the report
}

export interface Detection {
  label: PatternLabel; // highest-priority hit, or `other`
  hits: PatternHit[]; // every hit, in priority order
  parsed: boolean; // true when node-sql-parser accepted the statement; false = regex + plan-text fallback only
  tables: string[]; // lower-case `schema.table` names, from the parser or the regex fallback
  planNodes: { id: number; op: string; note: string }[];
}

const IDENT = "[a-z_][a-z0-9_]*";

interface Join {
  kind: string; // "left" | "right" | "full" | "inner" | "cross" | ""
  table: string;
  alias: string;
  on: string; // text of the ON condition
  start: number; // offset of the join keyword in the masked text
  end: number; // offset where the ON condition ends
}

// Joins found by scanning `[kind] JOIN <table> [AS] <alias> ON <cond>` where <cond> runs to the next top-level clause keyword.
export function findJoins(m: string): Join[] {
  const out: Join[] = [];
  const re = new RegExp(`\\b((?:left|right|full)(?:\\s+outer)?|inner|cross)?\\s*join\\s+(\`?[\\w.\`]+\`?)(?:\\s+(?:as\\s+)?(${IDENT}))?`, "gi");
  const stop = /\b(?:left|right|full|inner|cross)?\s*(?:outer\s+)?join\b|\bwhere\b|\bgroup\s+by\b|\border\s+by\b|\bhaving\b|\blimit\b|\bunion\b|\)\s*(?:\)|$)|;/i;
  for (const mm of m.matchAll(re)) {
    let alias = mm[3] ?? "";
    let consumed = mm[0].length;
    if (/^(on|using|where|left|right|full|inner|cross|join|group|order|limit|union)$/i.test(alias)) {
      consumed -= alias.length; // the "alias" was the next keyword: leave it in the text that follows
      alias = "";
    }
    const table = mm[2]!.replace(/`/g, "").toLowerCase();
    const afterName = mm.index! + consumed;
    const rest = m.slice(afterName);
    const onAt = rest.search(/\bon\b/i);
    if (onAt < 0 || /\b(?:join|where|select|from)\b/i.test(rest.slice(0, onAt))) continue; // no ON before the next clause (USING / CROSS)
    const condStart = onAt + 2;
    const tail = rest.slice(condStart);
    const s = stop.exec(tail);
    const condEnd = s ? s.index : tail.length;
    out.push({
      kind: (mm[1] ?? "").toLowerCase().replace(/\s+outer/, ""),
      table,
      alias: (alias || table.split(".").pop()!).toLowerCase(),
      on: tail.slice(0, condEnd),
      start: mm.index!,
      end: afterName + condStart + condEnd,
    });
  }
  return out;
}

const trim = (s: string, n = 140) => s.replace(/\s+/g, " ").trim().slice(0, n);

export function detectPatterns(sql: string, plan?: Plan | null): Detection {
  const text = trimStatement(sql);
  const m = maskSql(text).toLowerCase();
  const hits: PatternHit[] = [];

  let tables: string[] = [];
  let parsed = false;
  try {
    const tl = parser.tableList(text, { database: "hive" }) as string[]; // entries look like "select::tpcds_db::store_sales"
    tables = [...new Set(tl.map((t) => t.split("::").slice(1).filter((p) => p && p !== "null").join(".").toLowerCase()))];
    parsed = true;
  } catch {
    tables = [...m.matchAll(/\b(?:from|join)\s+`?([\w.]+)`?/g)].map((x) => x[1]!);
  }

  const joins = findJoins(m);

  // unused_outer_join: a LEFT JOIN whose alias is read nowhere outside its own ON condition.
  for (const j of joins) {
    if (j.kind !== "left") continue;
    const outside = m.slice(0, j.start) + " " + m.slice(j.end) + " " + joins.filter((o) => o !== j).map((o) => o.on).join(" ");
    const readsAlias = new RegExp(`\\b${j.alias}\\s*\\.`, "i").test(outside) || new RegExp(`\\b${j.alias}\\s*\\.\\s*\\*`).test(outside);
    // `select *` would read every joined column
    const star = /\bselect\s+(?:distinct\s+)?\*/i.test(m.slice(0, j.start));
    if (!readsAlias && !star) hits.push({ label: "unused_outer_join", evidence: trim(`${j.kind} join ${j.table} ${j.alias} on ${j.on}`) });
  }

  // outer_join_predicate: a LEFT JOIN whose ON also filters the joined side against a literal / list (T1 shape).
  for (const j of joins) {
    if (j.kind !== "left") continue;
    const f = new RegExp(`\\b${j.alias}\\s*\\.\\s*${IDENT}\\s*(?:=|<>|!=|<=|>=|<|>|\\blike\\b|\\bin\\b|\\bis\\b)\\s*(?:'|"|\\d|\\(|null)`, "i").exec(j.on);
    if (f) hits.push({ label: "outer_join_predicate", evidence: trim(`left join ${j.table} ${j.alias} on … and ${f[0]}`) });
  }

  const notIn = /\bnot\s+in\s*\(\s*select\b/.exec(m);
  if (notIn) hits.push({ label: "not_in_nullable", evidence: trim(m.slice(notIn.index, notIn.index + 90)) });

  // correlated_subquery: a (select … from <t> <a2> where … a2.x = a1.y) with an alias from outside the subquery.
  const P = "(?:[^()]|\\([^()]*\\))*"; // text with at most one level of parentheses, e.g. AVG(x)
  const sub = new RegExp(`\\(\\s*select\\b${P}?\\bfrom\\s+[\\w.\`]+(?:\\s+(?:as\\s+)?(\\w+))?\\s+where\\b(${P})\\)`, "g");
  for (const s of m.matchAll(sub)) {
    const inner = (s[1] ?? "").toLowerCase();
    const where = s[2]!;
    const refs = [...where.matchAll(new RegExp(`\\b(${IDENT})\\s*\\.\\s*${IDENT}`, "g"))].map((r) => r[1]!);
    const outer = refs.filter((a) => a !== inner && new RegExp(`\\b(?:from|join)\\s+[\\w.\`]+\\s+(?:as\\s+)?${a}\\b`).test(m.replace(s[0], " ")));
    if (outer.length) {
      hits.push({ label: "correlated_subquery", evidence: trim(s[0]) });
      break;
    }
  }

  const un = /\bunion\b(?!\s+all\b)/.exec(m);
  if (un) hits.push({ label: "union_dedupe", evidence: trim(m.slice(Math.max(0, un.index - 30), un.index + 40)) });

  const nonSarg = /\b(year|month|day|date|upper|lower|substr|substring|cast|coalesce|trim|to_date|date_format)\s*\(\s*[\w.`]+[^()]*\)\s*(?:=|<>|!=|<=|>=|<|>|\blike\b)/.exec(m.slice(Math.max(0, m.search(/\bwhere\b/))));
  if (nonSarg && /\bwhere\b/.test(m)) hits.push({ label: "non_sargable_predicate", evidence: trim(nonSarg[0]) });

  if (/\bselect\s+distinct\b/.test(m) && joins.length > 0) hits.push({ label: "distinct_over_fanout", evidence: trim(`select distinct … ${joins.length} join(s)`) });

  const sources = new Set(tables.filter((t) => t.includes(".")).map((t) => t.split(".")[0]!));
  if (sources.size > 1) hits.push({ label: "cross_source_join_no_pushdown", evidence: `sources: ${[...sources].sort().join(", ")}` });

  const order = (l: PatternLabel) => PATTERN_LABELS.indexOf(l);
  hits.sort((a, b) => order(a.label) - order(b.label));
  const label: PatternLabel = hits[0]?.label ?? "other";
  return { label, hits, parsed, tables, planNodes: plan ? citePlanNodes(label, plan.nodes) : [] };
}

// Which plan operators carry a pattern. The first few matching nodes are cited; the Diagnoser's hypotheses may only cite ids
// that exist in this list (zod-checked), so a model cannot invent a node.
const NODE_OPS: Record<PatternLabel, RegExp> = {
  unused_outer_join: /Join/i,
  outer_join_predicate: /Join/i,
  not_in_nullable: /Join|Subquery|Filter/i,
  correlated_subquery: /Join|Subquery|Aggregate/i,
  union_dedupe: /Union|Aggregate|Distinct/i,
  non_sargable_predicate: /Filter|Scan/i,
  distinct_over_fanout: /Aggregate|Distinct|Join/i,
  cross_source_join_no_pushdown: /Join|Scan/i,
  other: /Join|Aggregate|Scan/i,
};

export function citePlanNodes(label: PatternLabel, nodes: PlanNode[], max = 3): { id: number; op: string; note: string }[] {
  const re = NODE_OPS[label];
  const picked = nodes.filter((n) => re.test(n.operator)).slice(0, max);
  const use = picked.length ? picked : nodes.slice(0, 1);
  return use.map((n) => ({ id: n.id, op: n.operator, note: n.detail.replace(/\s+/g, " ").slice(0, 120) }));
}
