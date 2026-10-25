import type { ChatRequest, ChatResult, LlmClient } from "./nim.js";
import { LlmError } from "./nim.js";

// Meterless Nightshift: the primary AI provider (Meterless Runtime, an OpenAI-compatible local API; provider contract v4).
// NVIDIA Nemotron is reached THROUGH it: the NVIDIA key lives in Nightshift's Providers tab, never in this project. We pin a
// Nemotron route from GET /v1/models, send it explicitly (never `meterless/auto`, which may route to a non-NVIDIA model), and record
// the `model` the response reports as the handling model on every call. Nothing here produces a verdict or a number.

export const NIGHTSHIFT_DEFAULT_BASE_URL = "http://127.0.0.1:8088/v1";
export const NIGHTSHIFT_APP_ID = "querydoc";
export const NIGHTSHIFT_TIMEOUT_MS = 180_000; // a model load can take minutes
const DETECT_PORTS = [8088, 8090, 8787, 11434] as const;
const DETECT_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;

export class NightshiftError extends LlmError {
  constructor(message: string, status: number | null = null, timedOut = false, readonly state: RuntimeState | null = null) {
    super(message, status, timedOut);
    this.name = "NightshiftError";
  }

  get unreachable(): boolean {
    return this.state === "offline" || this.state === "unauthorized";
  }
}

export type RuntimeState = "online" | "unauthorized" | "offline";

// Accepts a pasted URL with or without a scheme, /v1, /v1/chat/completions, /v1/models, /healthz or a connect link and returns
// `<origin>/v1`. Never `/v1/v1`.
export function normaliseBaseUrl(input: string): string {
  let s = input.trim();
  if (!s) return NIGHTSHIFT_DEFAULT_BASE_URL;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `http://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new NightshiftError(`not a usable Nightshift URL: ${input.slice(0, 80)}`);
  }
  let path = u.pathname.replace(/\/+$/, "");
  path = path.replace(/\/(healthz|connect)$/, "").replace(/\/chat\/completions$/, "").replace(/\/models$/, "");
  while (/\/v1$/.test(path)) path = path.replace(/\/v1$/, "");
  return `${u.origin}${path}/v1`;
}

// http://<host>:<port>/connect#k=<key> → base URL from the origin, key from `k`. The key is never logged.
export function parseConnectLink(link: string): { baseUrl: string; token: string } | null {
  try {
    const u = new URL(link.trim());
    if (!u.pathname.replace(/\/+$/, "").endsWith("/connect")) return null;
    const k = new URLSearchParams(u.hash.replace(/^#/, "")).get("k");
    return k ? { baseUrl: `${u.origin}/v1`, token: k } : null;
  } catch {
    return null;
  }
}

const headers = (token: string, chat: boolean): Record<string, string> => ({
  Authorization: `Bearer ${token}`,
  "meterless-app": NIGHTSHIFT_APP_ID,
  ...(chat ? { "meterless-scope": "user", "Content-Type": "application/json" } : {}),
});

export interface RuntimeCheck {
  state: RuntimeState;
  status: number | null;
  baseUrl: string;
  models: string[];
}

// GET /healthz only proves the process is up; GET /v1/models decides: 401/403 unauthorized, 200 online, anything else offline.
export async function checkRuntime(baseUrl: string, token: string, fetchFn: typeof fetch = fetch, timeoutMs = 5_000): Promise<RuntimeCheck> {
  const base = normaliseBaseUrl(baseUrl);
  try {
    const res = await fetchFn(`${base}/models`, { headers: headers(token, false), signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 || res.status === 403) return { state: "unauthorized", status: res.status, baseUrl: base, models: [] };
    if (res.status !== 200) return { state: "offline", status: res.status, baseUrl: base, models: [] };
    const data = (await res.json().catch(() => ({}))) as { data?: { id?: unknown }[] };
    return { state: "online", status: 200, baseUrl: base, models: (data.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string") };
  } catch {
    return { state: "offline", status: null, baseUrl: base, models: [] };
  }
}

// Auto Detect: 8088, 8090, 8787, 11434 on 127.0.0.1, localhost and [::1]; the first online or unauthorized hit wins.
export async function detectRuntime(token: string, fetchFn: typeof fetch = fetch): Promise<RuntimeCheck | null> {
  for (const port of DETECT_PORTS) {
    for (const host of DETECT_HOSTS) {
      const c = await checkRuntime(`http://${host}:${port}/v1`, token, fetchFn, 1_500);
      if (c.state !== "offline") return c;
    }
  }
  return null;
}

// Pin a route: an explicit pick wins; else a listed Nemotron id; else meterless/deep. `meterless/auto` is a routing mode that may
// land on a non-NVIDIA model, so it is only ever used when it is the sole thing listed.
export function pickModel(models: string[], pinned?: string): string {
  if (pinned?.trim()) return pinned.trim();
  const nemo = models.find((m) => /nemotron/i.test(m) && /ultra/i.test(m)) ?? models.find((m) => /nemotron/i.test(m));
  if (nemo) return nemo;
  if (models.includes("meterless/deep")) return "meterless/deep";
  return models.find((m) => m.startsWith("meterless/") && m !== "meterless/auto") ?? models[0] ?? "meterless/deep";
}

export interface NightshiftOptions {
  baseUrl?: string;
  model?: string; // pinned; unset = resolved from GET /v1/models on first use
  fetchFn?: typeof fetch;
  retries?: number;
  backoffMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class NightshiftClient implements LlmClient {
  readonly provider = "nightshift" as const;
  private pinned: string | undefined;
  private readonly base: string;

  constructor(
    private readonly token: string,
    private readonly opts: NightshiftOptions = {},
  ) {
    this.base = normaliseBaseUrl(opts.baseUrl ?? NIGHTSHIFT_DEFAULT_BASE_URL);
    this.pinned = opts.model?.trim() || undefined;
  }

  get baseUrl(): string {
    return this.base;
  }

  // The requested route; "(resolved on first call)" until /v1/models has been read when none was pinned.
  get model(): string {
    return this.pinned ?? "(resolved on first call)";
  }

  private async resolveModel(): Promise<string> {
    if (this.pinned) return this.pinned;
    const c = await checkRuntime(this.base, this.token, this.opts.fetchFn);
    if (c.state === "unauthorized") throw new NightshiftError(`Nightshift rejected the runtime token (HTTP ${c.status}); paste the token from the Nightshift Console`, c.status, false, "unauthorized");
    if (c.state === "offline") throw new NightshiftError(`Nightshift is not reachable at ${this.base}`, c.status, false, "offline");
    this.pinned = pickModel(c.models);
    return this.pinned;
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const fetchFn = this.opts.fetchFn ?? fetch;
    const retries = this.opts.retries ?? 2;
    const model = await this.resolveModel();
    const timeoutMs = req.timeoutMs ?? NIGHTSHIFT_TIMEOUT_MS;
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxTokens ?? 4000,
      temperature: req.temperature ?? 1.0,
      top_p: 0.95,
      // The Nemotron reasoning switch; forwarded by Nightshift when the lane supports it. Dropped once if the runtime rejects it.
      chat_template_kwargs: { enable_thinking: req.reasoning === "on" },
    };
    let lastErr: Error = new NightshiftError("no attempt made");
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep((this.opts.backoffMs ?? 1500) * 2 ** (attempt - 1));
      const t0 = performance.now();
      try {
        const res = await fetchFn(`${this.base}/chat/completions`, {
          method: "POST",
          headers: headers(this.token, true),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          const text = (await res.text()).slice(0, 300);
          if (res.status === 401 || res.status === 403) throw new NightshiftError(`Nightshift unauthorized (HTTP ${res.status}): check METERLESS_RUNTIME_TOKEN`, res.status, false, "unauthorized");
          if (res.status === 400 && "chat_template_kwargs" in body) {
            delete body.chat_template_kwargs; // the lane does not take the thinking switch: ask again without it
            lastErr = new NightshiftError(`Nightshift 400: ${text}`, 400);
            attempt--;
            continue;
          }
          const err = new NightshiftError(`Nightshift ${res.status}: ${text}`, res.status);
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
        if (!choice?.message) throw new NightshiftError("Nightshift: response has no choices[0].message");
        return {
          content: choice.message.content ?? "",
          reasoning: choice.message.reasoning_content ?? "",
          latencyMs: performance.now() - t0,
          completionTokens: data.usage?.completion_tokens ?? null,
          finishReason: choice.finish_reason ?? "unknown",
          provider: "nightshift",
          requestedModel: model,
          handledModel: data.model ?? null,
        };
      } catch (e) {
        if (e instanceof NightshiftError && e.status !== null && e.status < 500 && e.status !== 429) throw e;
        if ((e as Error).name === "TimeoutError" || (e as Error).name === "AbortError") throw new NightshiftError(`Nightshift timed out after ${timeoutMs} ms (reasoning ${req.reasoning})`, null, true);
        lastErr = e as Error; // network error: retry
      }
    }
    throw lastErr instanceof NightshiftError ? lastErr : new NightshiftError(`Nightshift request failed after ${retries + 1} attempts: ${lastErr.message}`, null, false, "offline");
  }
}

// Env (names from the Participant Setup Guide): METERLESS_BASE_URL, METERLESS_RUNTIME_TOKEN, METERLESS_MODEL. No token = no live
// model (sample mode serves the llm-cache). `rt-local` is the runtime's placeholder and is rejected.
export function nightshiftClientFromEnv(env: NodeJS.ProcessEnv = process.env, fetchFn?: typeof fetch): NightshiftClient | null {
  const token = env.METERLESS_RUNTIME_TOKEN?.trim();
  if (!token || token === "rt-local") return null;
  return new NightshiftClient(token, { baseUrl: env.METERLESS_BASE_URL?.trim() || NIGHTSHIFT_DEFAULT_BASE_URL, ...(env.METERLESS_MODEL?.trim() ? { model: env.METERLESS_MODEL.trim() } : {}), ...(fetchFn ? { fetchFn } : {}) });
}

export interface NightshiftCheckReport {
  baseUrl: string;
  connection: RuntimeState;
  authorization: "ok" | "unauthorized" | "unknown";
  models: string[];
  pinnedModel: string | null;
  textRequest: { ok: boolean; handledModel: string | null; latencyMs: number | null; error?: string };
}

// `npm run nightshift:check`: the connection, authorization, model-discovery and text-request checks the guide asks for.
export async function nightshiftCheck(env: NodeJS.ProcessEnv = process.env, fetchFn: typeof fetch = fetch): Promise<NightshiftCheckReport> {
  const token = env.METERLESS_RUNTIME_TOKEN?.trim() ?? "";
  const explicit = env.METERLESS_BASE_URL?.trim();
  const found = explicit ? await checkRuntime(explicit, token, fetchFn) : ((await detectRuntime(token, fetchFn)) ?? (await checkRuntime(NIGHTSHIFT_DEFAULT_BASE_URL, token, fetchFn)));
  const report: NightshiftCheckReport = {
    baseUrl: found.baseUrl,
    connection: found.state,
    authorization: found.state === "online" ? "ok" : found.state === "unauthorized" ? "unauthorized" : "unknown",
    models: found.models,
    pinnedModel: found.state === "online" ? pickModel(found.models, env.METERLESS_MODEL) : null,
    textRequest: { ok: false, handledModel: null, latencyMs: null },
  };
  if (found.state !== "online" || !token || token === "rt-local") {
    report.textRequest.error = found.state === "online" ? "no real runtime token (METERLESS_RUNTIME_TOKEN)" : `runtime ${found.state}`;
    return report;
  }
  try {
    const client = new NightshiftClient(token, { baseUrl: found.baseUrl, model: report.pinnedModel ?? undefined, fetchFn, retries: 0 });
    const r = await client.chat({ system: "Reply with the single word: ok", user: "ping", reasoning: "off", maxTokens: 32, temperature: 0.2, timeoutMs: NIGHTSHIFT_TIMEOUT_MS });
    report.textRequest = { ok: typeof r.content === "string" && r.content.length > 0, handledModel: r.handledModel, latencyMs: Math.round(r.latencyMs) };
  } catch (e) {
    report.textRequest.error = (e as Error).message;
  }
  return report;
}
