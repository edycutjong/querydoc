import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../config.js";

// The LLM gateway (live provider call or the keyless `llm-cache`) and the DECLARED FALLBACK provider: direct NVIDIA NIM chat
// completions for Nemotron 3 Ultra (integrate.api.nvidia.com), used only when LLM_PROVIDER=nim. The primary provider is Meterless
// Nightshift (nightshift.ts). The NIM key comes from NVIDIA_API_KEY in the process environment (src/env.ts loads ~/.config/querydoc/nvidia.env); it is never
// logged or written. `reasoning_content` is kept out of the JSON parse: only `content` is parsed, the reasoning is returned
// separately for the trace. Nothing here produces a verdict or a number.

export const NIM_BASE_URL = "https://integrate.api.nvidia.com/v1";
export const NIM_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";

export type ReasoningMode = "on" | "off";

export interface ChatRequest {
  system: string;
  user: string;
  reasoning: ReasoningMode;
  maxTokens?: number;
  temperature?: number; // the model card recommends 1.0 / top_p 0.95; callers pass it explicitly
  timeoutMs?: number;
}

export type LlmProvider = "nightshift" | "nim";

export interface ChatResult {
  content: string;
  reasoning: string;
  latencyMs: number;
  completionTokens: number | null;
  finishReason: string;
  provider: LlmProvider;
  requestedModel: string; // the model id we asked for
  handledModel: string | null; // the `model` the response reports: which model actually handled the request (null = not reported)
}

// What the gateway needs from a live model provider. Nightshift (src/adapters/nightshift.ts) is the primary one; NimClient below
// is the declared fallback (LLM_PROVIDER=nim).
export interface LlmClient {
  readonly provider: LlmProvider;
  readonly model: string;
  chat(req: ChatRequest): Promise<ChatResult>;
}

// Raised when no key is available and the cache has no entry. Never answered with a canned reply.
export class SampleModeNoLLM extends Error {
  constructor(readonly task: string) {
    super(`needs a live model (Meterless Nightshift: METERLESS_RUNTIME_TOKEN), or pass candidate_sql (llm-cache miss for ${task})`);
    this.name = "SampleModeNoLLM";
  }
}

export class LlmError extends Error {
  constructor(message: string, readonly status: number | null = null, readonly timedOut = false) {
    super(message);
    this.name = "LlmError";
  }
}

// The provider cannot be used at all (not running, or rejecting our credentials), as opposed to a bad answer or a slow one.
export const providerUnreachable = (e: unknown): boolean => (e as { unreachable?: boolean } | null)?.unreachable === true;

export class NimError extends LlmError {
  constructor(message: string, status: number | null = null, timedOut = false) {
    super(message, status, timedOut);
    this.name = "NimError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class NimClient implements LlmClient {
  readonly provider = "nim" as const;
  constructor(
    private readonly apiKey: string,
    private readonly opts: { baseUrl?: string; model?: string; fetchFn?: typeof fetch; retries?: number; backoffMs?: number } = {},
  ) {}

  get model(): string {
    return this.opts.model ?? NIM_MODEL;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const retries = this.opts.retries ?? 2;
    const body = {
      model: this.model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxTokens ?? 4000,
      temperature: req.temperature ?? 1.0,
      top_p: 0.95,
      // The only reasoning switch this endpoint honours (probed 2026-10-25, docs/DX-REPORT.md): enable_thinking.
      chat_template_kwargs: { enable_thinking: req.reasoning === "on" },
    };
    let lastErr: Error = new NimError("no attempt made");
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep((this.opts.backoffMs ?? 1500) * 2 ** (attempt - 1));
      const t0 = performance.now();
      try {
        const res = await fetchFn(`${this.opts.baseUrl ?? NIM_BASE_URL}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(req.timeoutMs ?? 120_000),
        });
        if (!res.ok) {
          const text = (await res.text()).slice(0, 300);
          const err = new NimError(`NIM ${res.status}: ${text}`, res.status);
          if (res.status === 429 || res.status >= 500) {
            lastErr = err;
            continue; // transient
          }
          throw err;
        }
        const data = (await res.json()) as {
          choices?: { message?: { content?: string | null; reasoning_content?: string | null }; finish_reason?: string }[];
          usage?: { completion_tokens?: number };
          model?: string;
        };
        const choice = data.choices?.[0];
        if (!choice?.message) throw new NimError("NIM: response has no choices[0].message");
        return {
          content: choice.message.content ?? "",
          reasoning: choice.message.reasoning_content ?? "",
          latencyMs: performance.now() - t0,
          completionTokens: data.usage?.completion_tokens ?? null,
          finishReason: choice.finish_reason ?? "unknown",
          provider: "nim",
          requestedModel: this.model,
          handledModel: data.model ?? null,
        };
      } catch (e) {
        if (e instanceof NimError && e.status !== null && e.status < 500 && e.status !== 429) throw e;
        // A timeout is not retried here with the same settings (a reasoning call that ran past its budget will do it again): the
        // gateway retries it once with reasoning off.
        if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") throw new NimError(`NIM timed out after ${req.timeoutMs ?? 120_000} ms (reasoning ${req.reasoning})`, null, true);
        lastErr = e as Error; // network error: retry
      }
    }
    throw lastErr instanceof NimError ? lastErr : new NimError(`NIM request failed after ${retries + 1} attempts: ${lastErr.message}`);
  }
}

// First JSON object in a model reply (tolerates a ```json fence or a sentence around it). Throws on none.
export function extractJson(content: string): unknown {
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fenced?.[1] ?? content;
  const start = text.indexOf("{");
  if (start < 0) throw new Error("no JSON object in the reply");
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error("unterminated JSON object in the reply");
}

// --- llm-cache -------------------------------------------------------------------------------------------------------------
// Key = SHA-256 of a normalised object (task + the fields that determine the answer), never of the rendered prompt: timings and
// memory ids live in prompts and must not break a hit (architecture §Playbook write semantics → llm-cache protocol).

export const normalisedKey = (task: string, fields: Record<string, unknown>): string =>
  createHash("sha256").update(JSON.stringify({ ...sortKeys(fields), task })).digest("hex");

function sortKeys(v: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)));
}

// Candidate-origin rule (architecture §llm-cache protocol): a Rewriter/revise response whose state key holds a rejected attempt that
// came from a supplied candidate_sql is never written to the cache, whoever set cacheWrite — the canonical pass records only the
// agents' own path. carryoverKey() lists each rejected attempt as [n, origin, hypothesis, reason, detail, sql sha, first_diff sha].
export function hasCandidateOrigin(keyFields: Record<string, unknown>): boolean {
  if (typeof keyFields.carryover !== "string") return false;
  try {
    const k = JSON.parse(keyFields.carryover) as { rejected?: unknown[][] };
    return !!k.rejected?.some((r) => r[1] === "candidate_sql");
  } catch {
    return false;
  }
}

export interface LlmOutcome {
  value: unknown; // the parsed JSON object
  source: "live" | "llm-cache";
  latencyMs: number;
  reasoningChars: number;
  provider: LlmProvider | null; // live calls only
  requestedModel: string | null;
  handledModel: string | null; // the model the response reports (null = cache hit or not reported)
  recordedModel?: string | null; // cache hits only: the model the replayed response came from when it was recorded
}

// A keyless replay: the parsed value plus the model the entry says produced it (never reported as a live handling model).
function cacheHit<T>(file: string, parse: (raw: unknown) => T): { out: T } & Omit<LlmOutcome, "value"> {
  const entry = JSON.parse(readFileSync(file, "utf8")) as { value: unknown; model?: unknown };
  return { out: parse(entry.value), source: "llm-cache", latencyMs: 0, reasoningChars: 0, provider: null, requestedModel: null, handledModel: null, recordedModel: typeof entry.model === "string" ? entry.model : null };
}

// The trace's sponsor_call for one gateway outcome: live calls name the provider and the model that handled the request; cache hits say
// llm-cache, with the model the replayed response was recorded from.
export function llmSponsorCall(r: Omit<LlmOutcome, "value">, latencyMs: number) {
  if (r.source === "llm-cache" || !r.provider) return { service: "llm-cache" as const, name: "chat_completions", latency_ms: Math.round(latencyMs), ...(r.recordedModel ? { recorded_model: r.recordedModel } : {}) };
  return { service: r.provider, name: "chat_completions", latency_ms: Math.round(latencyMs), provider: r.provider, requested_model: r.requestedModel ?? "", handled_model: r.handledModel };
}

export interface GatewayOptions {
  client?: LlmClient | null; // null = keyless
  cacheDir?: string;
  cacheWrite?: boolean; // record.ts turns this on; trap N-repeat runs and A/B arms keep it off
}

export class LlmGateway {
  private readonly dir: string;
  constructor(private readonly o: GatewayOptions = {}) {
    this.dir = o.cacheDir ?? join(ROOT, "llm-cache");
  }

  get live(): boolean {
    return !!this.o.client;
  }

  get provider(): LlmProvider | null {
    return this.o.client?.provider ?? null;
  }

  // What served the most recent call: the live provider, or "cache" (keyless, or a provider that was down). The case-level label
  // comes from here, so a cache answer is never reported as live.
  lastServed: LlmProvider | "cache" | null = null;
  // Everything that served calls since resetServed(): the case label is built from this (a live provider, the cache, or both).
  private served = new Set<LlmProvider | "cache">();
  resetServed(): void {
    this.served = new Set();
  }
  servedLabel(): "nightshift" | "nim" | "cache" | "mixed" | "none" {
    const live = [...this.served].filter((s): s is LlmProvider => s !== "cache");
    if (live.length && this.served.has("cache")) return "mixed";
    if (live.length) return live[0]!;
    return this.served.has("cache") ? "cache" : "none";
  }

  // Run one structured call. `parse` validates (zod); a validation failure is retried once with the error appended (the model
  // sees what was wrong), then rethrown. Keyless: cache lookup, else SampleModeNoLLM.
  async call<T>(task: string, keyFields: Record<string, unknown>, req: ChatRequest, parse: (raw: unknown) => T): Promise<{ out: T } & Omit<LlmOutcome, "value">> {
    let out: { out: T } & Omit<LlmOutcome, "value">;
    try {
      out = await this.callInner(task, keyFields, req, parse);
    } catch (e) {
      if (this.o.client && !(e instanceof SampleModeNoLLM)) this.served.add(this.o.client.provider); // a live call was made and failed
      throw e;
    }
    this.lastServed = out.source === "live" ? (out.provider ?? "cache") : "cache";
    this.served.add(this.lastServed);
    return out;
  }

  private async callInner<T>(task: string, keyFields: Record<string, unknown>, req: ChatRequest, parse: (raw: unknown) => T): Promise<{ out: T } & Omit<LlmOutcome, "value">> {
    const key = normalisedKey(task, keyFields);
    const file = join(this.dir, `${key}.json`);
    const client = this.o.client;
    if (!client) {
      if (!existsSync(file)) throw new SampleModeNoLLM(task);
      return cacheHit(file, parse);
    }
    let user = req.user;
    let reasoning = req.reasoning;
    // Sample-mode promise (Hub: "runs without Zetaris, Nightshift or live credentials"): a provider that is down or rejects its token
    // degrades to the recorded cache; the outcome says llm-cache, never live. No cache entry = SampleModeNoLLM, as keyless.
    const unreachable = (): { out: T } & Omit<LlmOutcome, "value"> => {
      if (!existsSync(file)) throw new SampleModeNoLLM(task);
      return cacheHit(file, parse);
    };
    let lastErr = "";
    for (let tryN = 0; tryN < 2; tryN++) {
      let r: ChatResult;
      try {
        r = await client.chat({ ...req, user, reasoning, timeoutMs: reasoning === "on" ? (req.timeoutMs ?? 90_000) : Math.min(req.timeoutMs ?? 90_000, 60_000) });
      } catch (e) {
        if (providerUnreachable(e)) return unreachable();
        if (e instanceof LlmError && e.timedOut) dumpCall(task, req, reasoning, user, null);
        if (!(e instanceof LlmError && e.timedOut) || tryN > 0 || reasoning === "off") throw e; // already off: nothing cheaper to try
        lastErr = e.message;
        reasoning = "off"; // the reasoning call ran past its budget; answer directly
        continue;
      }
      dumpCall(task, req, reasoning, user, r);
      try {
        // Reasoning tokens count against max_tokens: a long think can cut the JSON off. That is a truncation, not a bad answer.
        if (r.finishReason === "length") throw new Error(`reply truncated at max_tokens (finish_reason length, ${r.completionTokens ?? "?"} tokens, reasoning ${r.reasoning.length} chars)`);
        const raw = extractJson(r.content);
        const out = parse(raw);
        if (this.o.cacheWrite && !hasCandidateOrigin(keyFields)) {
          mkdirSync(this.dir, { recursive: true });
          writeFileSync(file, JSON.stringify({ task, provider: r.provider, model: r.handledModel, requested_model: r.requestedModel, key_fields: keyFields, value: raw }, null, 2) + "\n");
        }
        return { out, source: "live", latencyMs: r.latencyMs, reasoningChars: r.reasoning.length, provider: r.provider, requestedModel: r.requestedModel, handledModel: r.handledModel };
      } catch (e) {
        lastErr = (e as Error).message.slice(0, 400);
        user = `${req.user}\n\nYour previous reply was rejected: ${lastErr}\nReply again with ONLY the JSON object, exactly in the requested shape. Be brief.`;
        if (r.finishReason === "length") reasoning = "off"; // the retry answers directly so it fits
      }
    }
    throw new LlmError(`${task}: no valid reply after 2 calls (${lastErr})`);
  }
}

// QUERYDOC_DUMP_DIR=<dir>: write each model call (prompt, reply head, finish reason, latency) for debugging a stalled prompt. Never the key.
function dumpCall(task: string, req: ChatRequest, reasoning: ReasoningMode, user: string, r: ChatResult | null): void {
  const dir = process.env.QUERYDOC_DUMP_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
  const name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${task}-${reasoning}.json`;
  writeFileSync(join(dir, name), JSON.stringify({ task, reasoning, system: req.system, user, timed_out: r === null, latency_ms: r ? Math.round(r.latencyMs) : null, finish: r?.finishReason ?? null, completion_tokens: r?.completionTokens ?? null, reasoning_chars: r?.reasoning.length ?? null, content_head: r?.content.slice(0, 600) ?? null }, null, 2) + "\n");
  } catch {
    // debug aid only: an unwritable dump directory never fails a call
  }
}

export function nimClientFromEnv(env: NodeJS.ProcessEnv = process.env): NimClient | null {
  const key = env.NVIDIA_API_KEY?.trim();
  return key ? new NimClient(key) : null;
}
