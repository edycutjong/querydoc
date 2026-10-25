import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LlmGateway } from "./adapters/nim.js";
import { Diagnoser } from "./agents/diagnoser.js";
import { detectPatterns } from "./agents/patterns.js";
import { profileJoinKeys } from "./agents/profile.js";
import { Rewriter } from "./agents/rewriter.js";
import { Verifier, type Attempt } from "./agents/verifier.js";
import type { VerifierConfig } from "./config.js";
import { ROOT } from "./config.js";
import type { Plan, QueryEngine } from "./engine/types.js";
import { runChain, type ChainResult } from "./reasoning/chain.js";
import { Trace } from "./trace.js";
import type { Case, RunInput, RunOptions } from "./types.js";

// runCase: the whole pipeline for one query — guard → pre-check → plan + detector + key facts → Diagnoser → (candidate_sql | the
// Markovian rewrite chain) → Verifier verdict → Case. The verdict comes from the Verifier's fields only; the Orchestrator maps
// them to a case verdict and never invents a number. Nothing is applied anywhere: an ACCEPTED case is a reviewable candidate.

export interface Deps {
  engine: QueryEngine;
  cfg: VerifierConfig;
  llm: LlmGateway;
  attemptCap: number; // querydoc.config.json policy.attemptCap
  logDir?: string; // JSONL traces go to <logDir>/trace-<run_id>.jsonl
  reasoning?: { diagnoser: "on" | "off"; rewriter: "on" | "off" };
}

export interface CaseRun {
  case: Case;
  trace: Trace;
  chain?: ChainResult["markovian"];
}

export async function runCase(input: RunInput, deps: Deps, opts: RunOptions = {}): Promise<CaseRun> {
  const runId = opts.runId ?? `run-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}Z`;
  const logDir = deps.logDir ?? join(ROOT, "logs");
  mkdirSync(logDir, { recursive: true });
  const trace = new Trace(runId, join(logDir, `trace-${runId}.jsonl`));
  const maxAttempts = Math.max(1, Math.min(opts.maxAttempts ?? deps.attemptCap, 3));
  const c: Case = {
    run_id: runId, sql: input.sql, source: input.source ?? "paste", engine: deps.engine.name, llm: deps.llm.live ? "nim" : "cache",
    started_at: new Date().toISOString(), attempts: [], verdict: "ERROR", playbook_hits: [],
  };
  const finish = (verdict: Case["verdict"], extra: Partial<Case> = {}, chain?: ChainResult["markovian"]): CaseRun => {
    Object.assign(c, { verdict, finished_at: new Date().toISOString() }, extra);
    trace.emit({
      agent_name: "Orchestrator", action: "case_verdict", input_summary: `${c.attempts.length} attempt(s)`,
      output_summary: `${verdict}${c.no_rewrite_reason ? ` (${c.no_rewrite_reason})` : ""}${c.detail ? ` — ${c.detail.slice(0, 160)}` : ""}`,
      target_agent: "Human", retry_count: Math.max(0, c.attempts.length - 1), status: verdict === "ERROR" ? "error" : "ok",
    });
    return { case: c, trace, ...(chain ? { chain } : {}) };
  };

  const verifier = new Verifier(deps.engine, deps.cfg, trace);
  trace.emit({
    agent_name: "Orchestrator", action: "start_case", input_summary: input.sql.replace(/\s+/g, " ").slice(0, 120),
    output_summary: `engine ${deps.engine.name}; llm ${c.llm}; attempt cap ${maxAttempts}`, target_agent: "Verifier", retry_count: 0, status: "ok",
  });

  try {
    const pre = await verifier.precheck(input.sql);
    if (!pre.ok) return finish(pre.verdict ?? "ERROR", { detail: pre.reason });
    c.precheck = { deterministic: pre.deterministic, rows: pre.rows, fingerprint: pre.fingerprint, fingerprint_kind: pre.fingerprint_kind, vacuous: pre.vacuous, columns: pre.columns };

    let plan: Plan | null = null;
    try {
      plan = await deps.engine.explain(input.sql);
      trace.emit({
        agent_name: "Orchestrator", action: "explain", input_summary: "original query", output_summary: `${plan.nodes.length} plan node(s)`, target_agent: "Diagnoser",
        sponsor_call: { service: deps.engine.name, name: "explain", latency_ms: Math.round(plan.wallMs * 10) / 10 }, retry_count: 0, status: "ok",
      });
    } catch (e) {
      trace.emit({ agent_name: "Orchestrator", action: "explain", input_summary: "original query", output_summary: (e as Error).message.slice(0, 200), target_agent: "Diagnoser", retry_count: 0, status: "error" });
    }
    const detection = detectPatterns(input.sql, plan);
    const facts = await profileJoinKeys(deps.engine, input.sql, deps.cfg.dialect, trace);
    const diagnoser = new Diagnoser(deps.llm, trace, deps.reasoning?.diagnoser ?? "on");
    c.diagnosis = await diagnoser.diagnose(input.sql, plan, detection, facts);
    if (c.diagnosis.narrative === "llm") c.llm = "nim";
    else if (c.diagnosis.narrative === "llm-cache") c.llm = "cache";

    // Own-candidate path: the human supplied the rewrite; the Verifier judges it, no Rewriter runs.
    if (input.candidate_sql) {
      const att = await verifier.verify({ n: 1, origin: "candidate_sql", hypothesis_id: null, sql: input.candidate_sql, change_summary: "candidate supplied with the request" }, pre, { lastAttempt: true });
      c.attempts.push(att);
      return finalise(att.verdict === "ACCEPT" ? att : null, c.attempts, null, finish);
    }

    const rewriter = new Rewriter(deps.llm, trace, deps.reasoning?.rewriter ?? "on");
    const chain = await runChain({ sql: input.sql, plan, diagnosis: c.diagnosis, facts, pre, rewriter, verifier, trace, maxAttempts });
    c.attempts.push(...chain.attempts);
    if (chain.upstreamError) throw new Error(chain.upstreamError);
    return finalise(chain.accepted, chain.attempts, chain, finish);
  } catch (e) {
    const detail = (e as Error).message.slice(0, 300);
    // after >= 1 attempt an upstream failure is NO_SAFE_REWRITE + "upstream"; before the first it is ERROR (architecture §Schema)
    return c.attempts.length ? finish("NO_SAFE_REWRITE", { no_rewrite_reason: "upstream", detail }) : finish("ERROR", { detail });
  }

  function finalise(accepted: Attempt | null, attempts: Attempt[], chain: ChainResult | null, fin: typeof finish): CaseRun {
    if (accepted) return fin("ACCEPTED", {}, chain?.markovian);
    if (chain?.llmError) {
      return fin("NO_SAFE_REWRITE", { no_rewrite_reason: chain.llmError.unavailable ? "llm_unavailable" : "upstream", detail: chain.llmError.message }, chain.markovian);
    }
    return fin("NO_SAFE_REWRITE", { no_rewrite_reason: "attempts_exhausted", detail: attempts.map((a) => `#${a.n} ${a.verdict} ${a.reason ?? ""}`).join(", ") }, chain?.markovian);
  }
}
