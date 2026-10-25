// Entry point of the container / `npm start`: loads ~/.config/querydoc/*.env when present (never inside the image), starts the API.
import { loadQuerydocEnv } from "./env.js";
import { createApp } from "./server.js";
import { QueryDocService } from "./service.js";

loadQuerydocEnv();
const port = Number(process.env.PORT ?? 8000);
const svc = new QueryDocService();
const server = createApp(svc);
server.listen(port, "0.0.0.0", () => {
  const mode = svc.resolveMode(undefined);
  console.log(`querydoc listening on :${port} — default engine ${mode.engine}${mode.banner ? ` (${mode.banner})` : ""}`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void svc.close().finally(() => process.exit(0)));
