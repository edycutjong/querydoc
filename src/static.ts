import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { ROOT } from "./config.js";

// Serves web/ (the Report UI: plain HTML/CSS/JS, self-hosted fonts, no build step). "/" is the UI for a browser (Accept: text/html)
// and the JSON endpoint list for everything else, so curl and the Hub validator still see the API root. Only GET files that live
// under web/ are served; a path that leaves it is a 404.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2", ".svg": "image/svg+xml", ".png": "image/png", ".txt": "text/plain; charset=utf-8", ".json": "application/json",
};

export function staticHandler(root = join(ROOT, "web")) {
  return (url: URL, res: ServerResponse, accept: string): boolean => {
    let rel: string;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return false;
    }
    if (rel === "/") {
      if (!accept.includes("text/html")) return false;
      rel = "/index.html";
    } else if (!rel.startsWith("/web/")) return false;
    else rel = rel.slice(4);
    const file = normalize(join(root, rel));
    if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) return false;
    const body = readFileSync(file);
    res.writeHead(200, {
      "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-length": body.length,
      "cache-control": extname(file) === ".woff2" ? "public, max-age=86400" : "no-cache",
    });
    res.end(body);
    return true;
  };
}
