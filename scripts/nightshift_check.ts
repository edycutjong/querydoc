// npm run nightshift:check — the four checks the Participant Setup Guide asks of an app: connection, authorization, model discovery
// and one real text request through Meterless Nightshift. Reads METERLESS_BASE_URL / METERLESS_RUNTIME_TOKEN / METERLESS_MODEL from the
// environment (~/.config/querydoc/nightshift.env is loaded). The token is never printed. Exit 0 only if a text request returned.
import { nightshiftCheck } from "../src/adapters/nightshift.js";
import { loadQuerydocEnv } from "../src/env.js";

loadQuerydocEnv();
const r = await nightshiftCheck();
const mark = (ok: boolean) => (ok ? "PASS" : "FAIL");
console.log(`Meterless Nightshift · ${r.baseUrl}`);
console.log(`${mark(r.connection !== "offline")}  connection        ${r.connection}`);
console.log(`${mark(r.authorization === "ok")}  authorization     ${r.authorization}`);
console.log(`${mark(r.models.length > 0)}  model discovery   ${r.models.length} model(s)${r.models.length ? `: ${r.models.slice(0, 8).join(", ")}${r.models.length > 8 ? ", …" : ""}` : ""}`);
console.log(`      pinned route      ${r.pinnedModel ?? "—"}  (never meterless/auto unless it is the only one listed)`);
console.log(`${mark(r.textRequest.ok)}  text request      ${r.textRequest.ok ? `ok in ${r.textRequest.latencyMs} ms, handled by ${r.textRequest.handledModel ?? "(model not reported)"}` : (r.textRequest.error ?? "failed")}`);
process.exit(r.textRequest.ok ? 0 : 1);
