import { nightshiftClientFromEnv } from "./nightshift.js";
import { nimClientFromEnv, type LlmClient } from "./nim.js";

// Provider choice. Meterless Nightshift is the primary (and default) AI provider; NVIDIA Nemotron is reached through it.
// LLM_PROVIDER=nim is the declared fallback (direct NIM with NVIDIA_API_KEY) and is never picked implicitly: an NVIDIA key in the
// environment alone does not switch the provider. No usable credentials = null = keyless (llm-cache / candidate_sql).
export function llmClientFromEnv(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  if (env.LLM_PROVIDER?.trim().toLowerCase() === "nim") return nimClientFromEnv(env);
  return nightshiftClientFromEnv(env);
}
