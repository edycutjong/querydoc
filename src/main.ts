// Entry point of the container / `npm start`: loads ~/.config/querydoc/*.env when present (never inside the image), starts the API.
import { loadQuerydocEnv } from "./env.js";
import { createApp } from "./server.js";
import { QueryDocService } from "./service.js";
import { staticHandler } from "./static.js";

loadQuerydocEnv();
const port = Number(process.env.PORT ?? 8000);
// Loopback unless told otherwise: with live credentials loaded, every interface would let anyone on the network run queries on
// the user's Zetaris through this API. The image sets HOST=0.0.0.0 so `docker run -p 8000:8000` still reaches it.
const host = process.env.HOST || "127.0.0.1";
const svc = new QueryDocService();
const server = createApp(svc, staticHandler());
server.listen(port, host, () => {
  const mode = svc.resolveMode(undefined);
  console.log(`querydoc listening on ${host}:${port} — default engine ${mode.engine}${mode.banner ? ` (${mode.banner})` : ""}`);
});
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void svc.close().finally(() => process.exit(0)));
