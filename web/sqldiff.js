// SqlBlock: numbered SQL, and a token-level before/after diff (added tokens underlined in --after, removed tokens struck in --before).
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// Break before the major clauses so two single-line queries still line up. Display only: the SQL that ran is never altered.
const BREAK = /\s+(?=(?:FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|UNION(?:\s+ALL)?|(?:(?:LEFT|RIGHT|FULL|INNER|CROSS)(?:\s+OUTER)?\s+)?JOIN)\b)(?<!\b(?:LEFT|RIGHT|FULL|INNER|CROSS|OUTER)\s+)/gi;
export function pretty(sql) {
  const s = sql.trim().replace(/;\s*$/, "");
  return s.includes("\n") ? s.replace(/[ \t]+$/gm, "") : s.replace(BREAK, "\n");
}

// Tokens carry `sp` (whitespace came before them in the source) so output spacing matches what the author wrote.
function tokens(s) {
  const out = [];
  let sp = false, nl = false;
  for (const t of s.match(/\n|[ \t]+|'(?:[^']|'')*'|"[^"]*"|\w+|[^\w\s]/g) ?? []) {
    if (t === "\n") { nl = true; continue; }
    if (/^[ \t]+$/.test(t)) { sp = true; continue; }
    out.push({ t, sp, nl });
    sp = nl = false;
  }
  return out;
}

function lcsOps(A, B) {
  const n = A.length, m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i].t === B[j].t ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i].t === B[j].t) { ops.push(["=", B[j]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push(["-", A[i]]); i++; }
    else { ops.push(["+", B[j]]); j++; }
  }
  while (i < n) ops.push(["-", A[i++]]);
  while (j < m) ops.push(["+", B[j++]]);
  return ops;
}

function lines(parts) {
  const out = [[]];
  for (const [cls, tok] of parts) {
    if (tok.nl && out.at(-1).length) out.push([]);
    const body = cls ? `<span class="${cls}">${esc(tok.t)}</span>` : esc(tok.t);
    out.at(-1).push((tok.sp && out.at(-1).length ? " " : "") + body);
  }
  return out.map((l, i) => `<span class="ln">${i + 1}</span>${l.join("")}`).join("\n");
}

export function sqlPlain(sql) {
  return `<pre class="sql" tabindex="0">${lines(tokens(pretty(sql)).map((t) => ["", t]))}</pre>`;
}

export function sqlDiff(orig, rewrite) {
  const ops = lcsOps(tokens(pretty(orig)), tokens(pretty(rewrite)));
  const parts = ops.map(([k, t]) => [k === "+" ? "add" : k === "-" ? "del" : "", t]);
  return `<pre class="sql" tabindex="0" aria-label="rewrite with changes marked: added tokens underlined, removed tokens struck through">${lines(parts)}</pre>`;
}
