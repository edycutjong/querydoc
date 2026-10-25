import type { PlanNode } from "./types.js";

// Parses the output of Zetaris `EXPLAIN FORMATTED` (a Spark physical plan). The tree section prints one operator per line with
// Spark's own operator id in parentheses — "+- BroadcastHashJoin LeftOuter BuildRight (7)" — followed by one detail block per
// id: "(7) BroadcastHashJoin\nLeft keys [1]: ...". Node ids are Spark's ids, so a prompt can cite "node (7)" and a human can find
// it in the same text. Plain `EXPLAIN` output (no ids) falls back to pre-order line numbering of the tree lines.

const TREE_LINE = /^([\s:|+\-]*?)(\*\s+)?([A-Za-z][^()]*?)\s*\((\d+)\)\s*$/;
const PLAIN_LINE = /^([\s:|+\-]*?)(\*\(\d+\)\s+)?([A-Za-z]\S*)(.*)$/;

export function parseSparkPlan(text: string): PlanNode[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("== Physical Plan =="));
  const body = start >= 0 ? lines.slice(start + 1) : lines;

  const nodes: PlanNode[] = [];
  let i = 0;
  for (; i < body.length; i++) {
    const line = body[i] ?? "";
    if (line.trim() === "") break;
    const m = TREE_LINE.exec(line);
    if (!m) {
      nodes.length = 0;
      break;
    }
    const [, prefix = "", , label = "", id = "0"] = m;
    const [operator = label, ...rest] = label.split(" ");
    nodes.push({
      id: Number(id),
      depth: Math.round(prefix.length / 3),
      operator,
      detail: rest.join(" "),
    });
  }
  if (nodes.length > 0) {
    attachDetails(body.slice(i), nodes);
    return nodes;
  }
  return parsePlain(body);
}

function attachDetails(rest: string[], nodes: PlanNode[]) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let current: PlanNode | undefined;
  for (const line of rest) {
    const head = /^\((\d+)\)\s/.exec(line);
    if (head) {
      current = byId.get(Number(head[1]));
      continue;
    }
    if (line.trim() === "") {
      current = undefined;
      continue;
    }
    const codegen = /^\[codegen id : (\d+)\]/.exec(line.trim());
    if (current && codegen) current.stage = Number(codegen[1]);
    else if (current) current.detail = current.detail ? `${current.detail}; ${line.trim()}` : line.trim();
  }
}

function parsePlain(body: string[]): PlanNode[] {
  const nodes: PlanNode[] = [];
  for (const line of body) {
    if (line.trim() === "") break;
    const m = PLAIN_LINE.exec(line);
    if (!m) continue;
    const [, prefix = "", codegen, operator = "", detail = ""] = m;
    const stage = codegen ? Number(/\d+/.exec(codegen)?.[0]) : undefined;
    nodes.push({
      id: nodes.length + 1,
      depth: Math.round(prefix.length / 3),
      operator,
      detail: detail.trim(),
      ...(stage !== undefined ? { stage } : {}),
    });
  }
  return nodes;
}
