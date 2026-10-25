// Query Doctor — Report UI. Two screens: Intake and the Case report (+ the agent-trace rail). Plain ES modules, no build step.
// Every verdict and number on screen is copied from a Verifier field of the case JSON; model text is labelled as model text.
import { sqlDiff, sqlPlain } from "/web/sqldiff.js";

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtMs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);
const median = (xs) => { const s = [...xs].sort((a, b) => a - b), m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const short = (h, n = 8) => (h ? String(h).slice(0, n) : "—");
const num = (n) => Number(n).toLocaleString("en-US");
const api = async (path, init) => {
  const r = await fetch(path, init);
  let j = null;
  try { j = await r.json(); } catch { /* non-JSON body */ }
  return { ok: r.ok, status: r.status, json: j };
};

const state = { health: null, cache: new Map(), polling: null, reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches };
const main = $("#main"), rail = $("#rail"), layout = $(".layout");

// --- chrome ------------------------------------------------------------------------------------------------------------------
async function loadHealth() {
  const { json } = await api("/health");
  state.health = json ?? {};
  const eng = state.health.engine?.name;
  const live = eng === "zetaris";
  $("#badges").innerHTML =
    `<span class="badge ${live ? "live" : ""}" title="${live ? "queries run on the Zetaris platform" : "queries run on DuckDB over committed public sample data"}">${live ? "LIVE · Zetaris" : "SAMPLE · DuckDB (public sample data)"}</span>` +
    (state.health.llm_cache ? `<span class="badge" title="model responses may be replayed from llm-cache/">llm-cache</span>` : "") +
    (state.health.llm?.configured ? "" : `<span class="badge" title="no Nightshift runtime token: cached model responses only">no model key</span>`);
  const b = $("#banner");
  if (state.health.banner) { b.hidden = false; b.textContent = state.health.banner; } else b.hidden = true;
}

function showRail(on) { rail.hidden = !on; layout.classList.toggle("has-rail", on); if (!on) rail.innerHTML = ""; }

// --- router ------------------------------------------------------------------------------------------------------------------
async function route() {
  clearInterval(state.polling);
  const h = location.hash.replace(/^#/, "") || "/";
  let m;
  main.setAttribute("aria-busy", "true");
  try {
    if (h === "/new") return await intake();
    if ((m = h.match(/^\/run\/([\w-]+)$/))) return await runView(m[1]);
    if ((m = h.match(/^\/recorded\/([a-z0-9-]+)$/))) return await recordedView(m[1]);
    if (h === "/") {
      const sample = state.health?.engine?.name !== "zetaris";
      if (sample) {
        const rec = (await api("/traces/recorded")).json?.runs ?? [];
        const first = rec.includes("hero-r1") ? "hero-r1" : rec[0];
        if (first) return await recordedView(first, true);
      }
      return await intake();
    }
    main.innerHTML = `<h1>Not found</h1><p><a href="#/">Back to the start</a></p>`;
    showRail(false);
  } finally {
    main.removeAttribute("aria-busy");
  }
}

// --- Intake ------------------------------------------------------------------------------------------------------------------
const prevRuns = () => { try { return JSON.parse(localStorage.getItem("qd.runs") || "[]"); } catch { return []; } };
const rememberRun = (id, verdict) => { try { localStorage.setItem("qd.runs", JSON.stringify([{ id, verdict }, ...prevRuns().filter((r) => r.id !== id)].slice(0, 8))); } catch { /* storage off */ } };

async function intake(preset = {}) {
  showRail(false);
  const sample = state.health?.engine?.name !== "zetaris";
  const [slow, rec] = await Promise.all([api("/slow-queries"), api("/traces/recorded")]);
  const items = slow.json?.items ?? [];
  const recorded = rec.json?.runs ?? [];
  const recMeta = await Promise.all(recorded.map(async (n) => { const j = (await api(`/traces/recorded/${n}`)).json; return { n, v: j?.case?.verdict, at: j?.case?.started_at?.slice(0, 10) }; }));
  main.innerHTML = `
    <h1>New case</h1>
    <p class="lede muted">Give it a slow query. It diagnoses the plan, proposes a rewrite, and a deterministic Verifier runs both. A rewrite is kept only if the rows are identical <em>and</em> it is faster.</p>
    <form id="intake" class="mode" novalidate>
      <label class="choice"><input type="radio" name="mode" value="candidate" ${preset.mode === "agents" ? "" : "checked"}><span class="t">Check a rewrite you were sent</span>
        <div class="d">Paste the original and the rewrite. The Verifier gives its verdict on exactly that rewrite — nothing else is tried.</div></label>
      <label class="choice"><input type="radio" name="mode" value="agents" ${preset.mode === "agents" ? "checked" : ""}><span class="t">Or let the agents find one</span>
        <div class="d">Paste the SQL (or pick one below). The Diagnoser reads the plan, the Rewriter proposes, the Verifier decides.${sample ? " In sample mode this needs NVIDIA_API_KEY or a recorded model response." : ""}</div></label>
      <div class="fields">
        <label>Original SQL<textarea id="sql" spellcheck="false" placeholder="SELECT …" required>${esc(preset.sql ?? "")}</textarea></label>
        <label id="cand-wrap">Rewrite to check (candidate_sql)<textarea id="cand" spellcheck="false" placeholder="SELECT …">${esc(preset.cand ?? "")}</textarea></label>
        ${items.length ? `<label>${sample ? "Sample query pack (committed, labelled)" : "Query pack"}<select id="pick"><option value="">— pick a query —</option>${items.map((i) => `<option value="${esc(i.id)}">${esc(i.id)}</option>`).join("")}</select></label>` : ""}
        ${sample ? `<label>Playbook<select id="pb"><option value="seed">seed — one earlier refusal is already on the ledger</option><option value="empty">empty — nothing remembered</option>${prevRuns().map((r) => `<option value="run:${esc(r.id)}">memory of ${esc(r.id)}</option>`).join("")}</select></label>
          <p class="note">Sample mode: the playbook resets on every run. <span class="data">example_3</span> shows a seeded run; a refusal of your own candidate can be reused on the next run by picking its memory here.</p>` : ""}
      </div>
      <div><button class="primary" id="go" type="submit">Examine</button></div>
    </form>
    <div id="live"></div>
    <h2>Recorded live runs <small>real runs on the Zetaris platform, kept as evidence</small></h2>
    ${recMeta.length ? `<ul class="rec-list">${recMeta.map((r) => `<li><a href="#/recorded/${esc(r.n)}">${esc(r.n)}</a><span class="muted data">recorded live run · ${esc(r.at ?? "")}</span><span class="v ${r.v === "ACCEPTED" ? "acc" : ""}">${esc(verdictWord(r.v))}</span></li>`).join("")}</ul>` : `<p class="empty">No recorded runs in this checkout.</p>`}`;
  const form = $("#intake"), cand = $("#cand-wrap");
  const sync = () => { cand.hidden = form.mode.value !== "candidate"; };
  form.addEventListener("change", sync); sync();
  $("#pick")?.addEventListener("change", (e) => { const it = items.find((i) => i.id === e.target.value); if (it) { $("#sql").value = it.sql; } });
  form.addEventListener("submit", (e) => { e.preventDefault(); examine(form); });
}

async function examine(form) {
  const sql = $("#sql").value.trim();
  const candidate = form.mode.value === "candidate" ? $("#cand").value.trim() : "";
  if (!sql) { $("#live").innerHTML = `<div class="status err" role="alert">Paste the original SQL first.</div>`; $("#sql").focus(); return; }
  if (form.mode.value === "candidate" && !candidate) { $("#live").innerHTML = `<div class="status err" role="alert">Paste the rewrite to check, or switch to “let the agents find one”.</div>`; $("#cand").focus(); return; }
  const runId = `ui-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
  const body = { run_id: runId, input: { sql, ...(candidate ? { candidate_sql: candidate } : {}), source: "paste" }, options: {} };
  if (state.health?.engine?.name !== "zetaris") { body.options.sample_mode = true; body.options.playbook = $("#pb")?.value ?? "seed"; }
  $("#go").disabled = true;
  $("#live").innerHTML = `<div class="status" role="status">Examining <span class="data">${esc(runId)}</span><span class="dots"></span> <span class="muted">live runs on a large table can take a minute; the trace on the right fills as agents work.</span></div>`;
  showRail(true);
  const poll = async () => { const t = (await api(`/runs/${runId}/trace`)).json; if (t?.events) paintRail(t.events, false); };
  state.polling = setInterval(poll, 1200); poll();
  const r = await api("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  clearInterval(state.polling);
  $("#go") && ($("#go").disabled = false);
  const j = r.json;
  if (!j || !j.output?.case) {
    $("#live").innerHTML = `<div class="status err" role="alert"><b>${esc(j?.error?.type ?? "Error")}</b> — ${esc(j?.error?.message ?? `HTTP ${r.status}`)}</div>`;
    return;
  }
  state.cache.set(j.run_id, { case: j.output.case, dossier: j.output.dossier, partial: j.status === "partial", error: j.error });
  rememberRun(j.run_id, j.verdict);
  location.hash = `#/run/${j.run_id}`;
}

// --- Case views --------------------------------------------------------------------------------------------------------------
async function runView(id) {
  let entry = state.cache.get(id);
  const t = (await api(`/runs/${id}/trace`)).json;
  if (!entry) {
    const r = await api(`/runs/${id}`);
    if (!r.json?.case) { main.innerHTML = `<h1>No such run</h1><p class="muted">Run <span class="data">${esc(id)}</span> is not on this server. <a href="#/new">Start a new case</a>.</p>`; showRail(false); return; }
    entry = { case: r.json.case, dossier: r.json.dossier };
    state.cache.set(id, entry);
  }
  const hits = await playbookEntries(entry.case, id);
  renderCase(entry.case, { runId: id, trace: t?.events ?? [], dossier: entry.dossier, partial: entry.partial, hits });
}

async function recordedView(name, landing = false) {
  const r = await api(`/traces/recorded/${name}`);
  if (!r.json?.case) { main.innerHTML = `<h1>Recorded run not found</h1><p><a href="#/new">New case</a></p>`; showRail(false); return; }
  const hits = await playbookEntries(r.json.case, null);
  renderCase(r.json.case, { recorded: { name, label: r.json.label }, trace: r.json.trace ?? [], dossier: r.json.dossier, hits, landing });
}

async function playbookEntries(c, runId) {
  if (!c.playbook_hits?.length) return [];
  const q = c.engine === "duckdb" && runId ? `/playbook?run_id=${encodeURIComponent(runId)}` : "/playbook";
  const j = (await api(q)).json;
  const byId = new Map((j?.entries ?? []).map((e) => [e.id, e]));
  return c.playbook_hits.map((id) => byId.get(id) ?? { id, missing: true });
}

function verdictWord(v) {
  return ({ ACCEPTED: "Accepted", NO_SAFE_REWRITE: "No kept rewrite", NOT_VERIFIABLE: "Not verifiable", REFUSED: "Refused", ERROR: "Error" })[v] ?? v ?? "—";
}

const reasonText = (a) => {
  if (a.reused_from) return `refusal reused from ledger ${a.reused_from} — same original-result fingerprint; not re-run`;
  if (a.reason === "ROW_DIFF") return `rows differ: ${num(a.rows.orig)} vs ${num(a.rows.rewrite)}${a.first_diff ? ` — first differing row ${JSON.stringify(a.first_diff.row)} (${a.first_diff.side} only)` : ""}`;
  if (a.reason === "NOT_FASTER") {
    const t = a.timing_ms;
    return `rows identical, but not faster by the gate${t ? ` (${t.median_speedup}× median, saving ${fmtMs(t.median_saving_ms)}; missed: ${t.gates_missed.join(", ") || "see timing"})` : ""}`;
  }
  if (a.reason === "GUARD") return `refused by the SQL guard — ${a.detail ?? "statement not allowed"}`;
  return a.detail ?? "the engine returned an error";
};

function sourcesOf(sql) {
  const set = new Set();
  for (const m of sql.matchAll(/\b(?:from|join)\s+([A-Za-z_][\w.]*)/gi)) set.add(m[1]);
  return [...set];
}

function bars(t, animate) {
  const o = median(t.orig), w = median(t.rewrite);
  const pct = Math.max(2, Math.min(100, (w / o) * 100));
  return `<div class="bars" aria-label="median runtime: original ${fmtMs(o)}, rewrite ${fmtMs(w)}">
    <span>original</span><div class="bar ${animate ? "anim" : ""}" style="width:100%"><span class="h" aria-hidden="true">H</span></div><span>${fmtMs(o)}</span>
    <span>rewrite</span><div class="bar after ${animate ? "anim" : ""}" style="width:${pct.toFixed(1)}%"></div><span>${fmtMs(w)}</span></div>`;
}

const stamp = (fp, animate) => `<div class="stamp ${animate ? "anim" : ""}" role="img" aria-label="Verifier stamp: rows identical, fingerprint ${esc(short(fp))}">Row-identical · ${esc(short(fp))}</div>`;

function renderCase(c, o) {
  const accepted = c.attempts.find((a) => a.verdict === "ACCEPT");
  const animate = !state.reducedMotion && !o.recorded;
  const statusLabel = o.recorded ? `recorded live run · ${esc(c.started_at?.slice(0, 10) ?? "")}` : esc(c.run_id);
  const live = c.engine === "zetaris";
  const cal = state.health?.calibration;
  const bestTimed = accepted ?? [...c.attempts].reverse().find((a) => a.timing_ms);
  const h = [];

  if (o.recorded) {
    h.push(`<div class="note" role="note"><b>Recorded live run${live ? " on Zetaris" : ""}</b> — ${esc(o.recorded.name)} · ${esc(c.started_at ?? "")}. This is evidence from an earlier run, not a new execution.${o.landing ? ` <a href="#/new">Try your own SQL on the sample engine →</a>` : ""}</div>`);
  }
  h.push(`<h1>Case report — <span class="verdict ${c.verdict === "ACCEPTED" ? "ok" : ""}">${esc(verdictWord(c.verdict))}</span></h1>
    <p class="data muted">${statusLabel} · specimen ${esc(short(c.precheck?.fingerprint))} · engine ${esc(c.engine)}${live ? "" : " (public sample data — a different optimiser; speedups here say nothing about Zetaris)"} · model text: ${esc(c.llm)}${o.partial ? " · partial" : ""}</p>`);

  // hero assay at the top of an accepted dossier
  if (accepted?.timing_ms) {
    const t = accepted.timing_ms;
    h.push(`<section class="hero-assay" aria-label="Accepted rewrite"><div class="big"><span class="x">${t.median_speedup}×</span><span class="cap">median over ${t.orig.length} alternating pairs · saves ${fmtMs(t.median_saving_ms)} · ${t.faster_pairs}/${t.orig.length} pairs faster · same ${num(accepted.rows.orig)} row(s)</span></div>
      ${bars(t, animate)}${stamp(accepted.fingerprint.orig, animate)}</section>`);
  }

  // empty / error states are report comments, never a blank screen
  if (c.verdict !== "ACCEPTED") h.push(`<div class="note" role="status"><b>${esc(verdictWord(c.verdict))}.</b> ${esc(noRewriteText(c, o))}</div>`);

  // Specimen
  h.push(`<h2>Specimen</h2>${sqlPlain(c.sql)}
    <p class="data muted">specimen ${esc(short(c.precheck?.fingerprint, 16))}${c.schema_fqn ? ` · schema ${esc(c.schema_fqn)}` : ""} · sources: ${esc(sourcesOf(c.sql).join(", ") || "—")}${c.precheck ? ` · ${num(c.precheck.rows)} row(s), ${c.precheck.deterministic ? "deterministic" : "non-deterministic"}` : ""}</p>`);

  // Findings
  if (c.diagnosis) {
    const d = c.diagnosis;
    h.push(`<h2>Findings <small>Diagnoser</small></h2>
      <p><span class="tag det">detector</span><span class="data">pattern: ${esc(d.pattern_label)}</span></p>
      <p>${d.narrative !== "omitted" ? `<span class="tag model">model text, unverified</span>` : `<span class="tag">no model reading</span>`}${esc(d.bottleneck)}</p>
      ${d.plan_nodes?.length ? `<table><thead><tr><th class="l">plan node</th><th class="l">operator</th><th class="l">note</th></tr></thead><tbody>${d.plan_nodes.map((n) => `<tr><td class="l">#${esc(n.id)}</td><td class="l">${esc(n.op)}</td><td class="l wrap">${esc(n.note)}</td></tr>`).join("")}</tbody></table>` : ""}`);
    // Hypotheses
    h.push(`<h2>Hypotheses</h2><ul class="hyp">${d.hypotheses.map((x) => `<li><span class="id">${esc(x.id)}</span><div><span class="st ${esc(x.status)}"><span aria-hidden="true">${statusGlyph(x.status)}</span> ${esc(x.status)}</span><span class="data muted">node ${esc(x.plan_node_id)} · ${x.source === "llm" ? "model claim, unverified" : "detector"}</span><div>${esc(x.claim)}</div></div>${x.evidence ? `<span class="ev">${esc(x.evidence)}</span>` : ""}</li>`).join("")}</ul>`);
  }

  // Attempts
  if (c.attempts.length) {
    h.push(`<h2>Attempts</h2>`);
    const candAttempt = c.attempts.find((a) => a.origin === "candidate_sql");
    if (candAttempt) {
      const a = candAttempt;
      const rowsLine = a.reason === "ROW_DIFF" ? `differ${a.first_diff ? ` (first differing row ${JSON.stringify(a.first_diff.row)}, ${a.first_diff.side} only)` : ""}` : a.reason === "GUARD" || a.reason === "ERROR" ? "not checked — the candidate failed before a comparison" : "identical";
      const speedLine = a.verdict === "ACCEPT" ? `faster (median ${a.timing_ms?.median_speedup}×, saving ${fmtMs(a.timing_ms?.median_saving_ms ?? 0)})` : a.reason === "NOT_FASTER" ? `not faster (gate missed: ${a.timing_ms?.gates_missed.join(", ") || "see timing"})` : "not measured — refused before timing";
      h.push(`<div class="facts" aria-label="Your rewrite"><b>Rows</b><span>${esc(rowsLine)}</span><b>Speed</b><span>${esc(speedLine)}</span>${a.reason === "NOT_FASTER" && a.not_faster_detail ? `<b>Heading</b><span>Safe, not faster by the gate</span>` : ""}</div>`);
    }
    for (const a of c.attempts) {
      const cls = a.verdict === "ACCEPT" ? "accepted" : "rejected";
      const label = a.origin === "candidate_sql" ? "your rewrite" : a.hypothesis_id ? `hypothesis ${a.hypothesis_id}` : "rewrite";
      h.push(`<article class="assay ${cls}"><span class="n">${a.n}</span>
        <div class="meta">${esc(label)} · ${a.verdict}${a.reason ? ` (${esc(a.reason)}${a.not_faster_detail ? "/" + esc(a.not_faster_detail) : ""})` : ""}</div>
        <div class="what">${a.origin === "rewriter" ? `<span class="tag model">Rewriter's note — model text</span>` : ""}${esc(a.change_summary)}</div>
        ${a.verdict === "ACCEPT" && a.timing_ms ? bars(a.timing_ms, animate) + stamp(a.fingerprint.orig, animate) : ""}
        <div class="margin ${a.verdict === "ACCEPT" ? "ok" : ""}">${a.verdict === "ACCEPT" ? `Verified by execution: same rows, ${a.timing_ms.median_speedup}× faster.` : esc(reasonText(a))}</div>
        <details><summary>SQL — diff against the original</summary>${sqlDiff(c.sql, a.sql)}</details></article>`);
    }
  }

  // Playbook hits
  h.push(`<h2>Playbook hits <small>H-MEM</small></h2>${playbookHtml(c, o.hits ?? [])}`);

  // Results vs reference
  if (bestTimed?.timing_ms) {
    const a = bestTimed, t = a.timing_ms;
    const sp = (xs) => `${fmtMs(Math.min(...xs))} – ${fmtMs(Math.max(...xs))}`;
    h.push(`<h2>Results vs reference</h2><table><thead><tr><th class="l">side</th><th>rows</th><th>fingerprint</th><th>median</th><th>spread</th><th>faster pairs</th><th>timed as</th></tr></thead><tbody>
      <tr><td class="l">original</td><td>${num(a.rows.orig)}</td><td>${esc(short(a.fingerprint.orig))}</td><td>${fmtMs(median(t.orig))}</td><td>${sp(t.orig)}</td><td>—</td><td>${esc(t.timed_as)}</td></tr>
      <tr><td class="l">attempt ${a.n}</td><td>${num(a.rows.rewrite)}</td><td>${esc(short(a.fingerprint.rewrite))}</td><td>${fmtMs(median(t.rewrite))}</td><td>${sp(t.rewrite)}</td><td>${t.faster_pairs}/${t.orig.length}</td><td>${esc(t.timed_as)}</td></tr></tbody>
      <caption>Wall clock measured by the Verifier, ${t.orig.length} alternating pairs, order swapped each pair. Noise floor ${fmtMs(t.noise_floor_ms)} (a saving below it is not counted).${live && cal?.select1_median_ms ? ` Baseline: a bare <span class="data">SELECT 1</span> round trip takes ${cal.select1_median_ms} ms median (spread ${cal.select1_spread_ms} ms) on this instance.` : ""}</caption></table>`);
  } else if (c.attempts.length) {
    h.push(`<h2>Results vs reference</h2><p class="muted">No timing was taken: every attempt was refused before the timing step.${c.precheck ? ` The original returned ${num(c.precheck.rows)} row(s), fingerprint <span class="data">${esc(short(c.precheck.fingerprint))}</span>.` : ""}</p>`);
  }

  // Comments
  const conf = c.diagnosis?.hypotheses.find((x) => x.status === "confirmed");
  h.push(`<h2>Comments</h2>`);
  if (accepted) {
    h.push(`<p><span class="tag model">Rewriter's note — model text</span>${esc(accepted.change_summary)}</p>`);
    if (conf) h.push(`<p><span class="tag model">Diagnoser's reading — not a proof</span><b>Why the engine's plan was slow:</b> ${esc(conf.claim)}</p>`);
  }
  h.push(`<p class="note">Residual risk: the rewrite is identical on the current data and verified by execution — it is not a proof for all future data.</p>`);

  // Verified by + decision
  h.push(`<h2>Verified by</h2><p class="verified"><span class="tag det">Verifier</span>deterministic code — it executed both queries and compared the rows${c.decision ? "" : accepted && !o.recorded ? " · awaiting human sign-off" : ""}.</p>`);
  if (accepted) h.push(decisionHtml(c, o));

  main.innerHTML = h.join("\n");
  showRail(true);
  paintRail(o.trace, !!o.recorded);
  wireDecision(c, o);
  window.scrollTo({ top: 0 });
}

const statusGlyph = (s) => ({ untested: "○", unproven: "◐", falsified: "✕", confirmed: "✓", withdrawn: "–" })[s] ?? "·";

function noRewriteText(c, o) {
  if (o.partial || c.no_rewrite_reason === "llm_unavailable") {
    const a = c.attempts.find((x) => x.origin === "candidate_sql");
    if (a?.reason === "ROW_DIFF") return `Your rewrite changes the result (${reasonText(a).replace(/^rows differ: /, "")}). Automatic retries need NVIDIA_API_KEY.`;
    if (a?.reason === "NOT_FASTER") return `Your rewrite returns identical rows but is not faster by the gate (${a.timing_ms?.gates_missed.join(", ") || "see timing"}). Automatic retries need NVIDIA_API_KEY.`;
    return "Diagnosis is below; rewrites need NVIDIA_API_KEY, or pass your own rewrite to check.";
  }
  switch (c.no_rewrite_reason) {
    case "attempts_exhausted": return `Every attempt was refused or not faster (${c.attempts.length} tried). The original stays as it is — no kept rewrite.`;
    case "diagnoser_withdrew": return "The Diagnoser withdrew its reading (model text, not a proof); nothing was left to try.";
    case "upstream": return `The engine or the model was unreachable: ${c.detail ?? "see the trace"}.`;
    case "timeout": return "The run hit its time cap before a verdict.";
    default: return c.detail ?? "No rewrite was kept.";
  }
}

function playbookHtml(c, hits) {
  const rows = [];
  for (const e of hits) {
    if (e.missing) { rows.push(`<tr><td class="l">${esc(e.id)}</td><td class="l" colspan="5">entry not in this checkout's store (it was written by the recorded run)</td></tr>`); continue; }
    const tag = (p) => (e.tags.find((t) => t.startsWith(p)) ?? "").slice(p.length);
    rows.push(`<tr><td class="l">${esc(e.id)}</td><td class="l">${esc(tag("pattern:"))}</td><td class="l">${esc(tag("outcome:") || "—")}</td><td>${e.confidence}</td><td>${e.history?.length ?? 0}</td><td class="l wrap">${esc(String(e.content).split("\n")[0].slice(0, 140))}</td></tr>`);
  }
  const d = c.decision ? `<p class="data">New entry after the decision: ${esc(c.decision.memory_id)} · ${c.decision.ledger_entries} ledger line(s).</p>` : "";
  if (!rows.length) return `<p class="muted">No earlier entries matched this pattern and schema.</p>${d}`;
  return `<table><thead><tr><th class="l">entry</th><th class="l">pattern</th><th class="l">outcome</th><th>confidence</th><th>ledger</th><th class="l">what it recorded</th></tr></thead><tbody>${rows.join("")}</tbody></table>
    <p class="muted data">Outcome <b>refused</b> = a trap the Verifier caught; <b>no_gain</b> = already tried, no time saved. Whole store: <a href="/playbook">/playbook</a>.</p>${d}`;
}

function decisionHtml(c, o) {
  if (o.recorded) return `<p class="muted">Recorded run — the decision bar is available on a new case.</p>`;
  if (c.decision) return `<p class="note"><b>${c.decision.decision === "approve" ? "Approved" : "Rejected"}</b> by ${esc(c.decision.actor)} · ${esc(c.decision.at)} · playbook entry ${esc(c.decision.memory_id)}.</p><div id="patch"></div>`;
  return `<div class="decide" id="decide"><label>Your name<input type="text" id="actor" maxlength="60" autocomplete="name" placeholder="who is signing off"></label>
    <label>Note (optional)<input type="text" id="dnote" maxlength="300"></label>
    <button class="primary" id="approve">Approve rewrite</button><button id="reject">Reject</button></div><p id="dmsg" class="muted" role="status"></p><div id="patch"></div>`;
}

function wireDecision(c, o) {
  const dec = $("#decide");
  if (!dec) return;
  const send = async (decision) => {
    const actor = $("#actor").value.trim();
    if (!actor) { $("#dmsg").textContent = "Enter your name to sign the decision."; $("#actor").focus(); return; }
    dec.querySelectorAll("button").forEach((b) => (b.disabled = true));
    const r = await api(`/runs/${o.runId}/decision`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision, actor, note: $("#dnote").value.trim() || undefined }) });
    if (r.json?.status !== "ok") { $("#dmsg").textContent = r.json?.error?.message ?? "The decision was not recorded."; dec.querySelectorAll("button").forEach((b) => (b.disabled = false)); return; }
    c.decision = r.json.decision;
    $("#dmsg").innerHTML = `<b>${decision === "approve" ? "Approved" : "Rejected"}</b> — playbook entry ${esc(r.json.memory_id)}, ${r.json.ledger_entries} ledger line(s).`;
    dec.hidden = true;
    if (r.json.patch) {
      $("#patch").innerHTML = `<details open><summary>Patch (.sql)</summary><pre class="sql">${esc(r.json.patch.sql)}</pre></details><details><summary>Pull-request review comment (Markdown)</summary><pre class="sql">${esc(r.json.patch.markdown)}</pre></details>`;
    }
  };
  $("#approve").addEventListener("click", () => send("approve"));
  $("#reject").addEventListener("click", () => send("reject"));
}

// --- Trace rail --------------------------------------------------------------------------------------------------------------
const SRC = { zetaris: "zetaris-live", duckdb: "duckdb-sample", nightshift: "nightshift-live", nim: "nim-live", "llm-cache": "llm-cache", hmem: "hmem", markovian: "markovian" };
function paintRail(events, recorded) {
  const rows = events.map((e) => {
    const sc = e.sponsor_call;
    const critique = e.action === "critique" && e.status === "needs_revision";
    const toDiag = critique && e.target_agent === "Diagnoser";
    const cls = critique ? "reject" : e.action === "critique" ? "approve" : "";
    const edge = critique ? `<span class="edge ${toDiag ? "revise" : "fix"}">${toDiag ? "→ Diagnoser · revise diagnosis" : "→ Rewriter · fix semantics"}</span>`
      : e.agent_name === "Rewriter" && e.action === "retry" ? `<span class="edge fix">↳ retry after the critique</span>`
      : e.agent_name === "Diagnoser" && e.action === "revise" ? `<span class="edge revise">↳ revised diagnosis</span>` : "";
    return `<div class="ev ${cls}">${sc ? `<span class="lat">${fmtMs(sc.latency_ms)}</span>` : ""}<span class="who">${esc(e.agent_name)}</span> · ${esc(e.action)}
      ${sc ? `<br><span class="chip">${esc(sc.service)}:${esc(sc.name)}</span><span class="src">${esc(SRC[sc.service] ?? sc.service)}</span>${sc.handled_model ? `<span class="src" title="requested route ${esc(sc.requested_model ?? "")}">handled by ${esc(sc.handled_model)}</span>` : ""}` : ""}
      <div class="muted">${esc((e.output_summary || e.input_summary || "").slice(0, 160))}</div>${edge}</div>`;
  });
  rail.innerHTML = `<h2>Agent trace</h2>${recorded ? `<p class="muted data">recorded live run — ${events.length} events</p>` : ""}${rows.length ? rows.join("") : `<p class="empty">Waiting for the first agent<span class="status"><span class="dots"></span></span></p>`}`;
}

// --- boot --------------------------------------------------------------------------------------------------------------------
addEventListener("hashchange", route);
loadHealth().then(route);
