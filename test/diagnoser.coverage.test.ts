import { describe, expect, it } from "vitest";
import { Diagnoser, engineSystem, planExcerpt, DIAGNOSER_SYSTEM, REVISE_SYSTEM } from "../src/agents/diagnoser.js";
import { SampleModeNoLLM, type LlmGateway } from "../src/adapters/nim.js";
import { Trace } from "../src/trace.js";
import type { Plan } from "../src/engine/types.js";
import type { Detection } from "../src/agents/patterns.js";
import type { Attempt } from "../src/agents/verifier.js";
import type { Diagnosis } from "../src/types.js";
import type { KeyFact } from "../src/agents/profile.js";

type Source = "live" | "llm-cache";
interface Call { task: string; key: Record<string, unknown>; req: { system: string; user: string }; }

// A fake gateway: runs the caller's zod parser on a crafted raw reply, exactly as the real gateway does after JSON extraction.
function fakeGateway(raw: unknown | Error, opts: { source?: Source; provider?: "nim" | "nightshift" | null } = {}) {
  const calls: Call[] = [];
  const gw = {
    provider: opts.provider === undefined ? null : opts.provider,
    async call(task: string, key: Record<string, unknown>, req: { system: string; user: string }, parse: (r: unknown) => unknown) {
      calls.push({ task, key, req });
      if (raw instanceof Error) throw raw;
      return { out: parse(raw), source: opts.source ?? "live", latencyMs: 5, reasoningChars: 0, provider: opts.source === "llm-cache" ? null : "nim", requestedModel: "m", handledModel: "m" };
    },
  };
  return { gw: gw as unknown as LlmGateway, calls };
}

const plan: Plan = {
  format: "spark-physical-text",
  text: "== Physical Plan ==\n(1) Scan a\n(2) BroadcastNestedLoopJoin",
  nodes: [{ id: 1, op: "Scan", note: "a" }, { id: 2, op: "BroadcastNestedLoopJoin", note: "or" }] as unknown as Plan["nodes"],
  wallMs: 1,
};

const detection = (over: Partial<Detection> = {}): Detection => ({
  label: "or_join_condition",
  hits: [{ label: "or_join_condition", evidence: "ON a.x = b.x OR a.y = b.y" }],
  parsed: true,
  tables: ["s.a", "s.b"],
  planNodes: [{ id: 2, op: "BroadcastNestedLoopJoin", note: "or" }],
  ...over,
});

const SQL = "SELECT 1 FROM a JOIN b ON a.x = b.x OR a.y = b.y";
const mk = (raw: unknown | Error, o: Parameters<typeof fakeGateway>[1] = {}, engine = "", reasoning: "on" | "off" = "on") => {
  const g = fakeGateway(raw, o);
  const trace = new Trace("t");
  return { ...g, trace, d: new Diagnoser(g.gw, trace, reasoning, engine) };
};

const GOOD = { bottleneck: "The nested loop join dominates the runtime.", hypotheses: [{ plan_node_id: 1, claim: "The scan of a is read twice and could be pruned." }] };

describe("engineSystem and planExcerpt", () => {
  it("rewrites the Spark wording to DuckDB for the duckdb engine only", () => {
    expect(engineSystem(DIAGNOSER_SYSTEM, "duckdb")).toContain("DuckDB (PostgreSQL-like dialect)");
    expect(engineSystem(DIAGNOSER_SYSTEM, "duckdb")).not.toContain("Spark");
    expect(engineSystem(DIAGNOSER_SYSTEM, "spark")).toBe(DIAGNOSER_SYSTEM);
    expect(engineSystem("a Spark-based engine (Hive dialect)", "duckdb")).toBe("DuckDB (PostgreSQL-like dialect)");
  });
  it("says no plan is available for a null plan and truncates long plans", () => {
    expect(planExcerpt(null)).toBe("(no plan available)");
    expect(planExcerpt(plan, 5)).toBe("== Ph");
    expect(planExcerpt(plan)).toBe(plan.text);
  });
});

describe("Diagnoser.diagnose", () => {
  it("keeps a valid live LLM hypothesis whose node exists in the plan and marks the narrative llm", async () => {
    const { d, calls, trace } = mk(GOOD, {}, "duckdb");
    const out = await d.diagnose(SQL, plan, detection(), []);
    expect(out.narrative).toBe("llm");
    expect(out.bottleneck).toBe(GOOD.bottleneck);
    expect(out.raw_refs).toEqual([]);
    expect(out.hypotheses.map((h) => [h.id, h.source, h.plan_node_id])).toEqual([["h1", "detector", "2"], ["h2", "llm", "1"]]);
    expect(out.hypotheses[0]!.claim).toContain("OR inside the JOIN condition");
    expect(out.hypotheses[0]!.claim).toContain("(matched: ON a.x = b.x OR a.y = b.y)");
    expect(calls[0]!.task).toBe("diagnose");
    expect(calls[0]!.req.system).toContain("DuckDB");
    expect(calls[0]!.req.user).toContain("Join-key facts: none (no joins).");
    expect(trace.events.map((e) => e.action)).toEqual(["detect_pattern", "analyse_plan"]);
    expect(trace.events[1]!.status).toBe("ok");
  });

  it("marks the narrative llm-cache when the gateway replayed a cache entry", async () => {
    const { d } = mk(GOOD, { source: "llm-cache" });
    const out = await d.diagnose(SQL, plan, detection(), []);
    expect(out.narrative).toBe("llm-cache");
  });

  it("drops hypotheses citing a node absent from the plan and logs each in raw_refs", async () => {
    const reply = { bottleneck: GOOD.bottleneck, hypotheses: [{ plan_node_id: "99", claim: "An invented node is blamed here." }, { plan_node_id: "2", claim: "The detector node is cited correctly." }] };
    const { d, trace } = mk(reply);
    const out = await d.diagnose(SQL, plan, detection(), []);
    expect(out.raw_refs).toEqual(["dropped hypothesis citing unknown plan node 99"]);
    expect(out.hypotheses.map((h) => h.id)).toEqual(["h1", "h2"]);
    expect(out.hypotheses[1]!.plan_node_id).toBe("2");
    expect(trace.events[1]!.output_summary).toContain("2 LLM hypothesis(es), 1 dropped; ranked: h1 > h2");
  });

  it("includes key facts in the prompt and works with a null plan, no hits and no detector nodes", async () => {
    const fact = { table: "a" } as unknown as KeyFact;
    const { d, calls, trace } = mk({ bottleneck: GOOD.bottleneck, hypotheses: [{ plan_node_id: 7, claim: "Nothing in the plan matches this node." }] });
    const out = await d.diagnose(SQL, null, detection({ label: "other", hits: [], planNodes: [], tables: [] }), [fact]);
    expect(out.bottleneck).toBe(GOOD.bottleneck);
    expect(out.hypotheses).toHaveLength(1);
    expect(out.hypotheses[0]).toMatchObject({ id: "h1", plan_node_id: "0", claim: "No known pattern matched; the plan's most expensive operator is the candidate." });
    expect(out.raw_refs).toEqual(["dropped hypothesis citing unknown plan node 7"]);
    expect(calls[0]!.req.user).toContain("(no plan available)");
    expect(calls[0]!.req.user).toContain("cited plan nodes none.");
    expect(calls[0]!.req.user).toContain("Join-key facts (measured by SQL aggregate):");
    expect(trace.events[0]!.output_summary).toBe("other; 0 hit(s); parser ok; cites plan nodes none");
    expect(trace.events[1]!.input_summary).toBe("plan 0 nodes + detector other");
  });

  it("reports parser fallback in the detect_pattern trace", async () => {
    const { d, trace } = mk(GOOD);
    await d.diagnose(SQL, plan, detection({ parsed: false }), []);
    expect(trace.events[0]!.output_summary).toContain("parser fallback");
  });

  it("keeps the detector hypothesis and skips when no model and no cache entry exist", async () => {
    const { d, trace } = mk(new SampleModeNoLLM("diagnose"));
    const out = await d.diagnose(SQL, plan, detection({ label: "union_dedupe", hits: [] }), []);
    expect(out.narrative).toBe("omitted");
    expect(out.bottleneck).toBe("Detector: union_dedupe");
    expect(out.hypotheses).toHaveLength(1);
    const ev = trace.events[1]!;
    expect(ev.status).toBe("skipped");
    expect(ev.output_summary).toBe("no live model and no cache entry — narrative omitted, detector hypothesis kept");
    expect(ev.sponsor_call?.service).toBe("llm-cache");
  });

  it("records an error event with the provider name when the LLM output is malformed", async () => {
    const { d, trace } = mk({ bottleneck: "short", hypotheses: [] }, { provider: "nightshift" });
    const out = await d.diagnose(SQL, plan, detection(), []);
    expect(out.narrative).toBe("omitted");
    expect(out.hypotheses).toHaveLength(1);
    const ev = trace.events[1]!;
    expect(ev.status).toBe("error");
    expect(ev.sponsor_call?.service).toBe("nightshift");
    expect(ev.output_summary.length).toBeLessThanOrEqual(250);
  });

  it("records an error event for a non-Sample-mode failure and truncates the message to 250 chars", async () => {
    const { d, trace } = mk(new Error("boom".repeat(100)));
    const out = await d.diagnose(SQL, plan, detection(), []);
    expect(out.narrative).toBe("omitted");
    expect(trace.events[1]!.status).toBe("error");
    expect(trace.events[1]!.output_summary).toBe("boom".repeat(100).slice(0, 250));
  });
});

const diagnosis = (over: Partial<Diagnosis> = {}): Diagnosis => ({
  bottleneck: "b",
  pattern_label: "or_join_condition",
  plan_nodes: [{ id: "2", op: "Join", note: "or" }],
  hypotheses: [
    { id: "h1", source: "detector", plan_node_id: "2", claim: "Detector claim about the join.", status: "falsified" },
    { id: "h2", source: "llm", plan_node_id: "1", claim: "Second claim about the scan.", status: "untested" },
    { id: "h3", source: "llm", plan_node_id: "1", claim: "Third claim about the scan.", status: "unproven" },
  ] as Diagnosis["hypotheses"],
  raw_refs: [],
  narrative: "llm",
  ...over,
});

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  n: 1, origin: "rewriter", hypothesis_id: "h1", sql: "SELECT 1", change_summary: "x", verdict: "REJECT", reason: "NOT_FASTER", not_faster_detail: "no_gain",
  rows: { orig: 1, rewrite: 1 }, fingerprint: { orig: "a", rewrite: "a" },
  timing_ms: { orig: [10, 10, 10], rewrite: [10, 10, 10], median_speedup: 1, median_saving_ms: 0, faster_pairs: 0, excluded_pairs: 0, timed_as: "plain", noise_floor_ms: 1, gates_missed: [] },
  ...over,
} as Attempt);

const revArgs = (over: Record<string, unknown> = {}) => ({ sql: SQL, plan, diagnosis: diagnosis(), attempt: attempt(), carryoverKey: "k", attemptNo: 2, ...over });

describe("Diagnoser.revise", () => {
  it("returns next for an untested hypothesis and prompts with ledger and timing numbers", async () => {
    const { d, calls, trace } = mk({ action: "next", hypothesis_id: "h2" });
    const out = await d.revise(revArgs({ schema: "s" }));
    expect(out).toEqual({ action: "next", hypothesis_id: "h2", source: "live" });
    expect(calls[0]!.task).toBe("diagnose_revise");
    expect(calls[0]!.key.schema).toBe("s");
    expect(calls[0]!.req.system).toBe(REVISE_SYSTEM);
    expect(calls[0]!.req.user).toContain("median 1×, saving 0 ms, 0/3 pairs faster");
    expect(calls[0]!.req.user).toContain("UNTESTED OR UNPROVEN HYPOTHESES: h2, h3.");
    expect(trace.events[0]).toMatchObject({ action: "revise", output_summary: "try h2", target_agent: "Rewriter", retry_count: 1 });
  });

  it("accepts an unproven hypothesis id as next", async () => {
    const { d } = mk({ action: "next", hypothesis_id: "h3" });
    expect((await d.revise(revArgs())).action).toBe("next");
  });

  it("turns a next naming an already falsified hypothesis into a withdrawal", async () => {
    const { d, trace } = mk({ action: "next", hypothesis_id: "h1" });
    const out = await d.revise(revArgs());
    expect(out).toEqual({ action: "withdraw", reason: "no valid hypothesis (named h1)", source: "live" });
    expect(trace.events[0]!.target_agent).toBe("Orchestrator");
    expect(trace.events[0]!.output_summary).toBe("withdraw: no valid hypothesis (named h1)");
  });

  it("returns a new hypothesis citing a plan node and truncates the claim in the trace summary", async () => {
    const claim = "A new falsifiable claim. ".repeat(10).trim().slice(0, 200);
    const { d, trace } = mk({ action: "new", plan_node_id: 1, claim });
    const out = await d.revise(revArgs());
    expect(out).toEqual({ action: "new", plan_node_id: "1", claim, source: "live" });
    expect(trace.events[0]!.output_summary).toBe(`new hypothesis on node 1: ${claim.slice(0, 100)}`);
    expect(trace.events[0]!.target_agent).toBe("Rewriter");
  });

  it("accepts a new hypothesis citing a diagnosis plan node even when the plan is null", async () => {
    const { d, calls } = mk({ action: "new", plan_node_id: "2", claim: "The diagnosis node is the real cost." }, { source: "llm-cache" });
    const out = await d.revise(revArgs({ plan: null }));
    expect(out).toEqual({ action: "new", plan_node_id: "2", claim: "The diagnosis node is the real cost.", source: "llm-cache" });
    expect(calls[0]!.req.user).toContain("(no plan available)");
    expect(calls[0]!.key.schema).toBe("");
  });

  it("turns a new hypothesis citing an unknown plan node into a withdrawal", async () => {
    const { d } = mk({ action: "new", plan_node_id: "404", claim: "This node does not exist anywhere." });
    expect(await d.revise(revArgs())).toEqual({ action: "withdraw", reason: "no valid hypothesis (unknown plan node 404)", source: "live" });
  });

  it("passes through a model withdrawal with its reason", async () => {
    const { d } = mk({ action: "withdraw", reason: "nothing left" });
    expect(await d.revise(revArgs())).toEqual({ action: "withdraw", reason: "nothing left", source: "live" });
  });

  it("describes a supplied candidate with no timing and no untested hypotheses", async () => {
    const dg = diagnosis({ hypotheses: [{ id: "h1", source: "detector", plan_node_id: "2", claim: "Only the detector claim.", status: "falsified" }] as Diagnosis["hypotheses"] });
    const { d, calls, trace } = mk({ action: "withdraw", reason: "none" });
    await d.revise(revArgs({ diagnosis: dg, attempt: attempt({ hypothesis_id: null, origin: "candidate_sql", timing_ms: undefined }) }));
    expect(calls[0]!.req.user).toContain("(candidate_sql) on a supplied candidate: rows identical, NOT FASTER — no timing.");
    expect(calls[0]!.req.user).toContain("UNTESTED OR UNPROVEN HYPOTHESES: none.");
    expect(trace.events[0]!.input_summary).toBe("ledger after candidate falsified; 0 untested");
  });

  it("propagates a SampleModeNoLLM error and rejects malformed replies", async () => {
    await expect(mk(new SampleModeNoLLM("diagnose_revise")).d.revise(revArgs())).rejects.toBeInstanceOf(SampleModeNoLLM);
    await expect(mk({ action: "dance" }).d.revise(revArgs())).rejects.toThrow();
  });

  it("uses the DuckDB system prompt for the duckdb engine", async () => {
    const { d, calls } = mk({ action: "withdraw", reason: "done" }, {}, "duckdb", "off");
    await d.revise(revArgs());
    expect(calls[0]!.req.system).toContain("You revise a SQL performance diagnosis");
    expect(calls[0]!.key.engine).toBe("duckdb");
  });
});
