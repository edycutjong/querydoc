import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { llmClientFromEnv } from "../src/adapters/llm.js";
import { NightshiftClient, NightshiftError, checkRuntime, detectRuntime, nightshiftCheck, nightshiftClientFromEnv, normaliseBaseUrl, parseConnectLink, pickModel } from "../src/adapters/nightshift.js";
import { LlmGateway, llmSponsorCall } from "../src/adapters/nim.js";

type Seen = { url: string; method: string; headers: Record<string, string>; body: Record<string, any> | null };
// A mock Meterless runtime: GET /v1/models and POST /v1/chat/completions, bearer-token checked like the real one.
function runtime(opts: { token?: string; models?: string[]; handled?: string; chatStatus?: number; reject400OnKwargs?: boolean } = {}) {
  const seen: Seen[] = [];
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body ? JSON.parse(init.body as string) : null;
    seen.push({ url, method: init.method ?? "GET", headers, body });
    if (headers.authorization !== `Bearer ${opts.token ?? "tok"}`) return new Response("unauthorized", { status: 401 });
    if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: (opts.models ?? ["meterless/auto", "meterless/deep", "nvidia/nemotron-3-ultra-550b-a55b"]).map((id) => ({ id })) }), { status: 200 });
    if (url.endsWith("/v1/chat/completions")) {
      if (opts.reject400OnKwargs && body?.chat_template_kwargs) return new Response("unknown field chat_template_kwargs", { status: 400 });
      if (opts.chatStatus) return new Response("nope", { status: opts.chatStatus });
      return new Response(JSON.stringify({ model: opts.handled ?? body?.model, choices: [{ message: { content: '{"a":1}', reasoning_content: "r" }, finish_reason: "stop" }], usage: { completion_tokens: 3 } }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { seen, fetchFn };
}
const REQ = { system: "s", user: "u", reasoning: "off" as const };

describe("normaliseBaseUrl", () => {
  it("normalises every pasted shape to <host>/v1 and never produces /v1/v1", () => {
    for (const input of ["127.0.0.1:8088", "http://127.0.0.1:8088", "http://127.0.0.1:8088/", "http://127.0.0.1:8088/v1", "http://127.0.0.1:8088/v1/", "http://127.0.0.1:8088/v1/v1", "127.0.0.1:8088/v1/chat/completions", "http://127.0.0.1:8088/v1/models", "http://127.0.0.1:8088/healthz", "  http://127.0.0.1:8088/v1/models  "]) {
      expect(normaliseBaseUrl(input)).toBe("http://127.0.0.1:8088/v1");
    }
    expect(normaliseBaseUrl("")).toBe("http://127.0.0.1:8088/v1");
    expect(normaliseBaseUrl("https://night.example.com/v1")).toBe("https://night.example.com/v1");
  });
  it("reads a connect link: base URL from the origin, key from #k=", () => {
    expect(parseConnectLink("http://127.0.0.1:8090/connect#k=abc123")).toEqual({ baseUrl: "http://127.0.0.1:8090/v1", token: "abc123" });
    expect(parseConnectLink("http://127.0.0.1:8090/v1")).toBeNull();
    expect(parseConnectLink("http://127.0.0.1:8090/connect")).toBeNull();
  });
});

describe("runtime state", () => {
  it("a wrong token is unauthorized, not offline; a dead port is offline; the right token is online with model ids", async () => {
    const rt = runtime();
    expect(await checkRuntime("http://127.0.0.1:8088", "wrong", rt.fetchFn)).toMatchObject({ state: "unauthorized", status: 401 });
    const ok = await checkRuntime("http://127.0.0.1:8088/v1/models", "tok", rt.fetchFn);
    expect(ok).toMatchObject({ state: "online", baseUrl: "http://127.0.0.1:8088/v1" });
    expect(ok.models).toContain("nvidia/nemotron-3-ultra-550b-a55b");
    const dead = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    expect(await checkRuntime("http://127.0.0.1:1", "tok", dead)).toMatchObject({ state: "offline", status: null });
    const teapot = (async () => new Response("x", { status: 500 })) as typeof fetch;
    expect((await checkRuntime("http://127.0.0.1:1", "tok", teapot)).state).toBe("offline");
  });
  it("auto-detect tries 8088, 8090, 8787, 11434 on 127.0.0.1, localhost, [::1] and keeps the first online/unauthorized hit", async () => {
    const tried: string[] = [];
    const fetchFn = (async (url: string) => {
      tried.push(url);
      return url.startsWith("http://localhost:8787/") ? new Response("no", { status: 403 }) : Promise.reject(new TypeError("refused"));
    }) as typeof fetch;
    const hit = await detectRuntime("tok", fetchFn);
    expect(hit).toMatchObject({ state: "unauthorized", baseUrl: "http://localhost:8787/v1" });
    expect(tried.slice(0, 6)).toEqual(["http://127.0.0.1:8088/v1/models", "http://localhost:8088/v1/models", "http://[::1]:8088/v1/models", "http://127.0.0.1:8090/v1/models", "http://localhost:8090/v1/models", "http://[::1]:8090/v1/models"]);
    expect(await detectRuntime("tok", (async () => { throw new Error("x"); }) as typeof fetch)).toBeNull();
  });
});

describe("pickModel", () => {
  it("pins an explicit route, else a listed Nemotron, else meterless/deep — meterless/auto only when it is all there is", () => {
    expect(pickModel(["meterless/auto"], "meterless/fast")).toBe("meterless/fast");
    expect(pickModel(["meterless/auto", "nvidia/nemotron-3-ultra-550b-a55b", "nvidia/nemotron-3-nano"])).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(pickModel(["meterless/auto", "meterless/fast", "meterless/deep"])).toBe("meterless/deep");
    expect(pickModel(["meterless/auto", "meterless/fast"])).toBe("meterless/fast");
    expect(pickModel(["meterless/auto"])).toBe("meterless/auto");
    expect(pickModel(["meterless/auto", "llama-x"])).toBe("llama-x");
  });
});

describe("NightshiftClient", () => {
  it("sends bearer token, meterless-app and meterless-scope on chat, and records the requested AND the handling model", async () => {
    const rt = runtime({ handled: "nvidia/nemotron-3-ultra-550b-a55b" });
    const r = await new NightshiftClient("tok", { fetchFn: rt.fetchFn, model: "meterless/deep" }).chat(REQ);
    const chat = rt.seen.find((s) => s.url.endsWith("/chat/completions"))!;
    expect(chat.url).toBe("http://127.0.0.1:8088/v1/chat/completions");
    expect(chat.headers).toMatchObject({ authorization: "Bearer tok", "meterless-app": "querydoc", "meterless-scope": "user" });
    expect(chat.body?.model).toBe("meterless/deep");
    expect(r).toMatchObject({ provider: "nightshift", requestedModel: "meterless/deep", handledModel: "nvidia/nemotron-3-ultra-550b-a55b", content: '{"a":1}', reasoning: "r", completionTokens: 3 });
  });
  it("discovery requests carry the token and meterless-app, resolve a Nemotron route when none is pinned, and never pick meterless/auto", async () => {
    const rt = runtime();
    const r = await new NightshiftClient("tok", { fetchFn: rt.fetchFn }).chat(REQ);
    const models = rt.seen.find((s) => s.url.endsWith("/v1/models"))!;
    expect(models.headers).toMatchObject({ authorization: "Bearer tok", "meterless-app": "querydoc" });
    expect(r.requestedModel).toBe("nvidia/nemotron-3-ultra-550b-a55b");
  });
  it("labels the handling model honestly: a non-Nemotron answer is reported as such, a missing one as null", async () => {
    const other = await new NightshiftClient("tok", { fetchFn: runtime({ handled: "some-other/model" }).fetchFn, model: "meterless/deep" }).chat(REQ);
    expect(other.handledModel).toBe("some-other/model");
    const silent = (async (url: string) => (url.endsWith("/models") ? new Response("{}", { status: 200 }) : new Response(JSON.stringify({ choices: [{ message: { content: "x" }, finish_reason: "stop" }] }), { status: 200 }))) as typeof fetch;
    expect((await new NightshiftClient("tok", { fetchFn: silent, model: "meterless/deep" }).chat(REQ)).handledModel).toBeNull();
  });
  it("a wrong token raises an unauthorized error (not offline) and is not retried", async () => {
    const rt = runtime();
    await expect(new NightshiftClient("wrong", { fetchFn: rt.fetchFn, model: "meterless/deep", backoffMs: 1 }).chat(REQ)).rejects.toMatchObject({ name: "NightshiftError", state: "unauthorized", status: 401 });
    expect(rt.seen.filter((s) => s.url.endsWith("/chat/completions")).length).toBe(1);
    await expect(new NightshiftClient("wrong", { fetchFn: rt.fetchFn }).chat(REQ)).rejects.toMatchObject({ state: "unauthorized" }); // discovery path too
  });
  it("an unreachable runtime raises an offline error", async () => {
    const dead = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    await expect(new NightshiftClient("tok", { fetchFn: dead }).chat(REQ)).rejects.toMatchObject({ state: "offline" });
  });
  it("retries 429/5xx, drops chat_template_kwargs once on a 400, and reports a timeout as timedOut", async () => {
    let n = 0;
    const flaky = (async (url: string, init: RequestInit) => (++n === 1 ? new Response("slow", { status: 429 }) : runtime().fetchFn(url, init))) as typeof fetch;
    expect((await new NightshiftClient("tok", { fetchFn: flaky, model: "meterless/deep", backoffMs: 1 }).chat(REQ)).content).toBe('{"a":1}');
    const picky = runtime({ reject400OnKwargs: true });
    expect((await new NightshiftClient("tok", { fetchFn: picky.fetchFn, model: "meterless/deep", backoffMs: 1 }).chat(REQ)).content).toBe('{"a":1}');
    expect(picky.seen.filter((s) => s.url.endsWith("/chat/completions")).map((s) => "chat_template_kwargs" in (s.body ?? {}))).toEqual([true, false]);
    const slow = (async () => { throw new DOMException("x", "TimeoutError"); }) as typeof fetch;
    await expect(new NightshiftClient("tok", { fetchFn: slow, model: "meterless/deep" }).chat(REQ)).rejects.toMatchObject({ timedOut: true });
    await expect(new NightshiftClient("tok", { fetchFn: runtime({ chatStatus: 400 }).fetchFn, model: "meterless/deep", backoffMs: 1 }).chat(REQ)).rejects.toThrow(NightshiftError);
  });
});

describe("provider selection", () => {
  it("Nightshift is the default; the rt-local placeholder and an NVIDIA key alone give no live model; LLM_PROVIDER=nim is the declared fallback", () => {
    expect(llmClientFromEnv({ METERLESS_RUNTIME_TOKEN: "real" })?.provider).toBe("nightshift");
    expect(llmClientFromEnv({ METERLESS_RUNTIME_TOKEN: "rt-local" })).toBeNull();
    expect(llmClientFromEnv({ NVIDIA_API_KEY: "nvapi-x" })).toBeNull();
    expect(llmClientFromEnv({})).toBeNull();
    expect(llmClientFromEnv({ LLM_PROVIDER: "nim", NVIDIA_API_KEY: "nvapi-x" })?.provider).toBe("nim");
    expect(llmClientFromEnv({ LLM_PROVIDER: "nim" })).toBeNull();
    const c = nightshiftClientFromEnv({ METERLESS_RUNTIME_TOKEN: "t", METERLESS_BASE_URL: "127.0.0.1:8090/v1/models", METERLESS_MODEL: "meterless/fast" })!;
    expect([c.baseUrl, c.model]).toEqual(["http://127.0.0.1:8090/v1", "meterless/fast"]);
  });
});

describe("nightshiftCheck", () => {
  it("passes connection, authorization, discovery and one real text request, naming the handling model", async () => {
    const rt = runtime({ handled: "nvidia/nemotron-3-ultra-550b-a55b" });
    const r = await nightshiftCheck({ METERLESS_RUNTIME_TOKEN: "tok", METERLESS_BASE_URL: "http://127.0.0.1:8088" }, rt.fetchFn);
    expect(r).toMatchObject({ connection: "online", authorization: "ok", pinnedModel: "nvidia/nemotron-3-ultra-550b-a55b", textRequest: { ok: true, handledModel: "nvidia/nemotron-3-ultra-550b-a55b" } });
  });
  it("a wrong token fails authorization without a text request; offline is reported as offline", async () => {
    const wrong = await nightshiftCheck({ METERLESS_RUNTIME_TOKEN: "wrong", METERLESS_BASE_URL: "http://127.0.0.1:8088" }, runtime().fetchFn);
    expect(wrong).toMatchObject({ connection: "unauthorized", authorization: "unauthorized", textRequest: { ok: false } });
    const down = await nightshiftCheck({ METERLESS_RUNTIME_TOKEN: "tok", METERLESS_BASE_URL: "http://127.0.0.1:1" }, (async () => { throw new TypeError("x"); }) as typeof fetch);
    expect(down).toMatchObject({ connection: "offline", authorization: "unknown", textRequest: { ok: false } });
  });
});

describe("gateway through Nightshift", () => {
  it("records provider + requested + handled model in the outcome, the trace sponsor_call and the llm-cache entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qd-ns-"));
    const client = new NightshiftClient("tok", { fetchFn: runtime({ handled: "nvidia/nemotron-3-ultra-550b-a55b" }).fetchFn, model: "meterless/deep" });
    const gw = new LlmGateway({ client, cacheDir: dir, cacheWrite: true });
    expect(gw.provider).toBe("nightshift");
    const r = await gw.call("t", { k: 1 }, REQ, (raw) => raw as { a: number });
    expect(r).toMatchObject({ source: "live", provider: "nightshift", requestedModel: "meterless/deep", handledModel: "nvidia/nemotron-3-ultra-550b-a55b" });
    expect(llmSponsorCall(r, 12)).toEqual({ service: "nightshift", name: "chat_completions", latency_ms: 12, provider: "nightshift", requested_model: "meterless/deep", handled_model: "nvidia/nemotron-3-ultra-550b-a55b" });
    const file = readdirSync(dir)[0]!;
    expect(JSON.parse(readFileSync(join(dir, file), "utf8"))).toMatchObject({ provider: "nightshift", model: "nvidia/nemotron-3-ultra-550b-a55b" });
    // keyless replay of the same key: llm-cache, no provider
    const hit = await new LlmGateway({ client: null, cacheDir: dir }).call("t", { k: 1 }, REQ, (raw) => raw as { a: number });
    expect(hit).toMatchObject({ source: "llm-cache", provider: null, handledModel: null });
    expect(hit.recordedModel).toBe("nvidia/nemotron-3-ultra-550b-a55b");
    expect(llmSponsorCall(hit, 0)).toEqual({ service: "llm-cache", name: "chat_completions", latency_ms: 0, recorded_model: "nvidia/nemotron-3-ultra-550b-a55b" });
  });
});

describe("gateway degrades to the cache when Nightshift is down or rejects the token", () => {
  const seed = async () => {
    const dir = mkdtempSync(join(tmpdir(), "qd-ns-"));
    await new LlmGateway({ client: new NightshiftClient("tok", { fetchFn: runtime().fetchFn, model: "meterless/deep" }), cacheDir: dir, cacheWrite: true }).call("t", { k: 1 }, REQ, (raw) => raw as { a: number });
    return dir;
  };
  it("offline and unauthorized serve the recorded entry as llm-cache, and a miss is SampleModeNoLLM (never a live label)", async () => {
    const dir = await seed();
    const dead = (async () => { throw new TypeError("fetch failed"); }) as typeof fetch;
    for (const fetchFn of [dead, runtime({ token: "other" }).fetchFn]) {
      const gw = new LlmGateway({ client: new NightshiftClient("tok", { fetchFn, model: "meterless/deep", retries: 0 }), cacheDir: dir });
      expect(await gw.call("t", { k: 1 }, REQ, (raw) => raw as { a: number })).toMatchObject({ out: { a: 1 }, source: "llm-cache", provider: null });
      expect(gw.lastServed).toBe("cache"); // the case label comes from here: a cache answer is never reported as nightshift
      await expect(gw.call("t", { k: 2 }, REQ, (raw) => raw)).rejects.toThrow(/needs a live model/);
    }
  });
});
