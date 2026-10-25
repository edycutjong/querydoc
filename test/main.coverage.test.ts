import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadQuerydocEnv = vi.fn();
const listen = vi.fn();
const createApp = vi.fn();
const staticFn = vi.fn();
const staticHandler = vi.fn();
const resolveMode = vi.fn();
const close = vi.fn();

vi.mock("../src/env.js", () => ({ loadQuerydocEnv: () => loadQuerydocEnv() }));
vi.mock("../src/server.js", () => ({ createApp: (...a: unknown[]) => createApp(...a) }));
vi.mock("../src/static.js", () => ({ staticHandler: () => staticHandler() }));
vi.mock("../src/service.js", () => ({
  QueryDocService: class {
    resolveMode(m: unknown) { return resolveMode(m); }
    close() { return close(); }
  },
}));

const saved = { PORT: process.env.PORT, HOST: process.env.HOST };
let handlers: Record<string, () => void>;

beforeEach(() => {
  vi.resetModules();
  for (const m of [loadQuerydocEnv, listen, createApp, staticFn, staticHandler, resolveMode, close]) m.mockReset();
  staticHandler.mockReturnValue(staticFn);
  createApp.mockReturnValue({ listen });
  resolveMode.mockReturnValue({ engine: "sample" });
  close.mockResolvedValue(undefined);
  delete process.env.PORT;
  delete process.env.HOST;
  handlers = {};
  vi.spyOn(process, "on").mockImplementation(((sig: string, fn: () => void) => {
    handlers[sig] = fn;
    return process;
  }) as never);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe("main entry point", () => {
  it("loads env, then listens on 127.0.0.1:8000 by default with the static handler", async () => {
    await import("../src/main.js");
    expect(loadQuerydocEnv).toHaveBeenCalledOnce();
    expect(createApp).toHaveBeenCalledWith(expect.anything(), staticFn);
    expect(listen).toHaveBeenCalledWith(8000, "127.0.0.1", expect.any(Function));
  });

  it("uses PORT and HOST from the environment", async () => {
    process.env.PORT = "9123";
    process.env.HOST = "0.0.0.0";
    await import("../src/main.js");
    expect(listen).toHaveBeenCalledWith(9123, "0.0.0.0", expect.any(Function));
  });

  it("falls back to loopback when HOST is empty", async () => {
    process.env.HOST = "";
    await import("../src/main.js");
    expect(listen.mock.calls[0]![1]).toBe("127.0.0.1");
  });

  it("logs the default engine without a banner", async () => {
    await import("../src/main.js");
    (listen.mock.calls[0]![2] as () => void)();
    expect(resolveMode).toHaveBeenCalledWith(undefined);
    expect(console.log).toHaveBeenCalledWith("querydoc listening on 127.0.0.1:8000 — default engine sample");
  });

  it("logs the mode banner when one is present", async () => {
    resolveMode.mockReturnValue({ engine: "live", banner: "keyless" });
    await import("../src/main.js");
    (listen.mock.calls[0]![2] as () => void)();
    expect(console.log).toHaveBeenCalledWith("querydoc listening on 127.0.0.1:8000 — default engine live (keyless)");
  });

  it.each(["SIGINT", "SIGTERM"])("closes the service and exits 0 on %s", async (sig) => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await import("../src/main.js");
    expect(Object.keys(handlers).sort()).toEqual(["SIGINT", "SIGTERM"]);
    handlers[sig]!();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(close).toHaveBeenCalledOnce();
  });
});
