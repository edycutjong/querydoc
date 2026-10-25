import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Credentials live outside the repo (~/.config/querydoc/*.env by default, or QUERYDOC_ENV_DIR). They are loaded into this
// process's environment at run time and never written anywhere. Variables already set in the shell win.
export function loadQuerydocEnv(files = ["zetaris.env", "nvidia.env"]): string[] {
  const dir = process.env.QUERYDOC_ENV_DIR ?? join(homedir(), ".config", "querydoc");
  const loaded: string[] = [];
  for (const f of files) {
    const path = join(dir, f);
    if (!existsSync(path)) continue;
    for (const raw of readFileSync(path, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
      if (process.env[key] === undefined && value !== "") process.env[key] = value;
    }
    loaded.push(f);
  }
  return loaded;
}
