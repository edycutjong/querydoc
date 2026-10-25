import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmGateway, NimClient, NimError, SampleModeNoLLM, extractJson, normalisedKey } from "../src/adapters/nim.js";

const reply = (content: string, reasoning = "think") =>
  new Response(JSON.stringify({ choices: [{ message: { content, reasoning_content: reasoning }, finish_reason: "stop" }], usage: { completion_tokens: 7 } }), { status: 200 });
const REQ = { system: "s", user: "u", reasoning: "on" as const };

describe("NimClient", () => {
  it("returns content and reasoning separately and sends the thinking switch + bearer key", async () => {
    let seen: { body: Record<string, unknown>; auth: string } | undefined;
    const fetchFn = (async (_u: unknown, init: RequestInit) => {
      seen = { body: JSON.parse(init.body as string), auth: (init.headers as Record<string, string>).Authorization! };
      return reply('{"a":1}', "long reasoning");
    }) as typeof fetch;
    const r = await new NimClient("k-test", { fetchFn }).chat({ ...REQ, reasoning: "off" });
    expect(r).toMatchObject({ content: '{"a":1}', reasoning: "long reasoning", completionTokens: 7, finishReason: "stop" });
    expect(seen?.auth).toBe("Bearer k-test");
    expect(seen?.body.model).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(seen?.body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("retries a 429 and a 5xx with backoff, but not a 400", async () => {
    let n = 0;
    const flaky = (async () => (++n === 1 ? new Response("slow down", { status: 429 }) : n === 2 ? new Response("boom", { status: 503 }) : reply("{}"))) as typeof fetch;
    expect((await new NimClient("k", { fetchFn: flaky, backoffMs: 1 }).chat(REQ)).content).toBe("{}");
    expect(n).toBe(3);
    let m = 0;
    const bad = (async () => (++m, new Response("bad request", { status: 400 }))) as typeof fetch;
    await expect(new NimClient("k", { fetchFn: bad, backoffMs: 1 }).chat(REQ)).rejects.toThrow(/NIM 400/);
    expect(m).toBe(1);
  });

  it("gives up after the retries on a persistent network error", async () => {
    const down = (async () => {
      throw new Error("ECONNRESET");
    }) as typeof fetch;
    await expect(new NimClient("k", { fetchFn: down, backoffMs: 1, retries: 1 }).chat(REQ)).rejects.toThrow(NimError);
  });
});

describe("extractJson", () => {
  it("handles plain, fenced and chatty replies, and braces inside strings", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure!\n```json\n{"a":{"b":2}}\n```\nDone')).toEqual({ a: { b: 2 } });
    expect(extractJson('{"sql":"select \\"}\\" from t"} trailing')).toEqual({ sql: 'select "}" from t' });
    expect(() => extractJson("no json here")).toThrow(/no JSON/);
    expect(() => extractJson('{"a": 1')).toThrow(/unterminated/);
  });
});

describe("llm-cache + LlmGateway", () => {
  const Ok = z.object({ x: z.number() });
  it("keys on normalised fields, independent of their order", () => {
    expect(normalisedKey("t", { a: 1, b: 2 })).toBe(normalisedKey("t", { b: 2, a: 1 }));
    expect(normalisedKey("t", { a: 1 })).not.toBe(normalisedKey("u", { a: 1 }));
  });

  it("records on a live call (cacheWrite), then serves the same call keyless; a miss is SampleModeNoLLM, never a canned answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qd-cache-"));
    const client = new NimClient("k", { fetchFn: (async () => reply('{"x":5}')) as typeof fetch });
    const live = new LlmGateway({ client, cacheDir: dir, cacheWrite: true });
    const a = await live.call("task", { sql: "select 1" }, REQ, (r) => Ok.parse(r));
    expect(a).toMatchObject({ out: { x: 5 }, source: "nim" });
    expect(readdirSync(dir)).toHaveLength(1);
    const keyless = new LlmGateway({ client: null, cacheDir: dir });
    expect(await keyless.call("task", { sql: "select 1" }, REQ, (r) => Ok.parse(r))).toMatchObject({ out: { x: 5 }, source: "llm-cache", latencyMs: 0 });
    await expect(keyless.call("task", { sql: "select 2" }, REQ, (r) => Ok.parse(r))).rejects.toBeInstanceOf(SampleModeNoLLM);
  });

  it("does not write when cacheWrite is off", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qd-cache-"));
    const client = new NimClient("k", { fetchFn: (async () => reply('{"x":1}')) as typeof fetch });
    await new LlmGateway({ client, cacheDir: dir }).call("t", {}, REQ, (r) => Ok.parse(r));
    expect(readdirSync(dir)).toHaveLength(0);
  });

  it("retries once with the validation error in the prompt, then throws", async () => {
    const users: string[] = [];
    let n = 0;
    const fetchFn = (async (_u: unknown, init: RequestInit) => {
      users.push(JSON.parse(init.body as string).messages[1].content);
      return reply(++n === 1 ? '{"x":"nope"}' : '{"x":2}');
    }) as typeof fetch;
    const g = new LlmGateway({ client: new NimClient("k", { fetchFn }) });
    expect((await g.call("t", {}, REQ, (r) => Ok.parse(r))).out).toEqual({ x: 2 });
    expect(users[1]).toContain("previous reply was rejected");
    const always = new LlmGateway({ client: new NimClient("k", { fetchFn: (async () => reply('{"x":"nope"}')) as typeof fetch }) });
    await expect(always.call("t", {}, REQ, (r) => Ok.parse(r))).rejects.toThrow(/no valid reply after 2 calls/);
  });

  it("a reply cut off at max_tokens is retried with reasoning off, and the failure says why", async () => {
    const bodies: Record<string, unknown>[] = [];
    let n = 0;
    const fetchFn = (async (_u: unknown, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return ++n === 1
        ? new Response(JSON.stringify({ choices: [{ message: { content: '{"x":', reasoning_content: "very long" }, finish_reason: "length" }] }), { status: 200 })
        : reply('{"x":3}');
    }) as typeof fetch;
    const g = new LlmGateway({ client: new NimClient("k", { fetchFn }) });
    expect((await g.call("t", {}, REQ, (r) => Ok.parse(r))).out).toEqual({ x: 3 });
    expect(bodies.map((b) => (b.chat_template_kwargs as { enable_thinking: boolean }).enable_thinking)).toEqual([true, false]);
    const cut = new LlmGateway({ client: new NimClient("k", { fetchFn: (async () => new Response(JSON.stringify({ choices: [{ message: { content: "{" }, finish_reason: "length" }] }), { status: 200 })) as typeof fetch }) });
    await expect(cut.call("t", {}, REQ, (r) => Ok.parse(r))).rejects.toThrow(/truncated at max_tokens/);
  });

  it("a reasoning call that times out is retried once with reasoning off (not re-sent with the same settings)", async () => {
    const modes: boolean[] = [];
    const fetchFn = (async (_u: unknown, init: RequestInit) => {
      const on = (JSON.parse(init.body as string).chat_template_kwargs as { enable_thinking: boolean }).enable_thinking;
      modes.push(on);
      if (on) throw new DOMException("The operation timed out.", "TimeoutError");
      return reply('{"x":4}');
    }) as typeof fetch;
    const g = new LlmGateway({ client: new NimClient("k", { fetchFn, backoffMs: 1 }) });
    expect((await g.call("t", {}, REQ, (r) => Ok.parse(r))).out).toEqual({ x: 4 });
    expect(modes).toEqual([true, false]);
    const dead = new LlmGateway({ client: new NimClient("k", { fetchFn: (async () => { throw new DOMException("x", "TimeoutError"); }) as typeof fetch }) });
    await expect(dead.call("t", {}, REQ, (r) => Ok.parse(r))).rejects.toThrow(/timed out/);
  });

  it("a cache file with a stale shape fails validation keyless instead of being trusted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qd-cache-"));
    writeFileSync(join(dir, `${normalisedKey("t", {})}.json`), JSON.stringify({ value: { x: "str" } }));
    await expect(new LlmGateway({ client: null, cacheDir: dir }).call("t", {}, REQ, (r) => Ok.parse(r))).rejects.toThrow();
  });
});
