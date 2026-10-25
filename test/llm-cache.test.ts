import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LlmGateway, NimClient, hasCandidateOrigin, normalisedKey } from "../src/adapters/nim.js";
import { ROOT } from "../src/config.js";
import { carryoverKey } from "../src/reasoning/chain.js";
import { canonicalSql } from "../src/sql/text.js";
import type { Attempt } from "../src/agents/verifier.js";

const att = (over: Partial<Attempt> = {}): Attempt => ({
  n: 1, origin: "rewriter", hypothesis_id: "h1", sql: "SELECT 1", change_summary: "x", verdict: "REJECT", reason: "ROW_DIFF", rows: { orig: 1, rewrite: 2 }, fingerprint: { orig: "a", rewrite: "b" }, ...over,
});
const reply = (content: string) => (async () => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] }), { status: 200 })) as typeof fetch;

describe("llm-cache protocol", () => {
  it("never writes a response whose state key holds a candidate-origin rejected attempt, even with cacheWrite on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qd-lc-"));
    const gw = new LlmGateway({ client: new NimClient("k", { fetchFn: reply('{"a": 1}') }), cacheDir: dir, cacheWrite: true });
    const h = [{ id: "h1", source: "detector" as const, plan_node_id: "1", claim: "c", status: "unproven" as const }];
    const fromCandidate = { template: "rewriter@1", carryover: carryoverKey(h, [att({ origin: "candidate_sql", hypothesis_id: null })]) };
    const fromRewriter = { template: "rewriter@1", carryover: carryoverKey(h, [att()]) };
    expect(hasCandidateOrigin(fromCandidate)).toBe(true);
    expect(hasCandidateOrigin(fromRewriter)).toBe(false);
    const parse = (x: unknown) => x;
    await gw.call("rewrite", fromCandidate, { system: "s", user: "u", reasoning: "off", maxTokens: 100 }, parse);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    await gw.call("rewrite", fromRewriter, { system: "s", user: "u", reasoning: "off", maxTokens: 100 }, parse);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("a rejected attempt's origin changes the key (a synthetic pair identical except for origin gets different keys)", () => {
    const h = [{ id: "h1", source: "detector" as const, plan_node_id: "1", claim: "c", status: "unproven" as const }];
    const k = (origin: "rewriter" | "candidate_sql") => normalisedKey("rewrite", { carryover: carryoverKey(h, [att({ origin })]) });
    expect(k("rewriter")).not.toBe(k("candidate_sql"));
    expect(k("rewriter")).toBe(k("rewriter"));
  });

  it("every committed cache entry is a recorded agent-path response: model, template, engine, schema, pattern in its key; no candidate-origin state", () => {
    const dir = join(ROOT, "llm-cache");
    expect(existsSync(dir)).toBe(true);
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const f of files) {
      const e = JSON.parse(readFileSync(join(dir, f), "utf8")) as { task: string; model: string; key_fields: Record<string, unknown> };
      expect(e.model).toBe("nvidia/nemotron-3-ultra-550b-a55b");
      expect(e.key_fields).toMatchObject({ engine: "duckdb" });
      for (const field of ["template", "model", "schema", "pattern", "sql"]) expect(e.key_fields[field], `${f}: ${field}`).toBeTruthy();
      expect(hasCandidateOrigin(e.key_fields), f).toBe(false);
      expect(normalisedKey(e.task, e.key_fields) + ".json", f).toBe(f); // the file name is the key of its own key fields
    }
  });

  it("canonicalSql ignores comments, case and spacing outside quotes but keeps literals apart", () => {
    expect(canonicalSql("SELECT  a -- c\nFROM T ;")).toBe(canonicalSql("select a from t"));
    expect(canonicalSql("SELECT 'x--y'")).not.toBe(canonicalSql("SELECT 'x--z'"));
    expect(canonicalSql("SELECT 'Cash'")).not.toBe(canonicalSql("SELECT 'cash'"));
    expect(canonicalSql("SELECT /* hi */ 1")).toBe("select 1");
  });
});
