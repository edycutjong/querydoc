import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/types.ts", "src/engine/types.ts"],
      reporter: ["text-summary", "json-summary"],
      // every product file, not just the total: a new file without tests fails CI
      thresholds: { perFile: true, lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
