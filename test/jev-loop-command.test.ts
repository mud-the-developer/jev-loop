import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { LoopStore } from "../src/store.js";
import { deferred, outcome, policy, recommendation } from "./helpers/jev-loop-fixture.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.unstubAllEnvs(); });

async function setup(fileBacked = false, startSession = true) {
  const cwd = mkdtempSync(join(tmpdir(), "jev-command-"));
  const path = join(cwd, "loops.json");
  vi.stubEnv("PI_LOOP_SCOPE", "memory");
  if (fileBacked) vi.stubEnv("PI_LOOP", path); else vi.stubEnv("PI_LOOP", "off");
  const h = createMockPi();
  h.pi.getAllTools = vi.fn(() => [{ name: "jev_decide", exposure: "direct" }]);
  h.pi.getActiveTools = vi.fn(() => ["jev_decide"]);
  extension(h.pi);
  let idle = true;
  let session = "command-session";
  const abort = new AbortController();
  const base = createCtx({ cwd });
  const select = vi.fn(async (..._args: any[]): Promise<string | undefined> => undefined);
  const input = vi.fn(async (..._args: any[]): Promise<string | undefined> => undefined);
  const confirm = vi.fn(async (..._args: any[]) => true);
  const notify = vi.fn();
  const waitForIdle = vi.fn(async () => { idle = true; });
  const executeTool = vi.fn(async () => outcome(recommendation()));
  const ctx = { ...base, hasUI: true, signal: abort.signal, isIdle: () => idle, waitForIdle,
    sessionManager: { getSessionId: () => session }, ui: { ...base.ui, select, input, confirm, notify },
    tools: [{ name: "jev_decide" }], executeTool };
  const shutdown = async () => { await h.emitExtension("session_shutdown", {}, ctx); };
  cleanups.push(async () => { await shutdown(); rmSync(cwd, { recursive: true, force: true }); });
  if (startSession) await h.emitExtension("session_start", {}, ctx);
  const command = (args: string) => h.commandMap.get("jev-loop")!.handler!(args, ctx);
  const call = (name: string, args: unknown) => h.toolMap.get(name)!.execute!("command", args, undefined, undefined, ctx);
  const create = (completion: unknown = policy) => call("LoopCreate", { trigger: "idle", triggerType: "idle", prompt: "Fixture user goal", completion: completion === null ? undefined : completion, maxFires: 5, expiresIn: "1h" });
  const listed = async () => String((await call("LoopList", {})).content[0].text);
  return { ...h, ctx, path, command, call, create, listed, notify, confirm, select, input, waitForIdle, executeTool, abort, shutdown,
    setIdle: (value: boolean) => { idle = value; },
    switchSession: async () => { session = "replacement-session"; await h.emitExtension("session_switch", { reason: "resume" }, ctx); },
  };
}

it("registers the new and ordinary commands before session_start, without starting work", async () => {
  const h = await setup(false, false);
  expect(h.commandMap.has("loop")).toBe(true);
  expect(h.commandMap.has("jev-loop")).toBe(true);
  expect(h.sentUserMessages).toEqual([]);
});

it.skipIf(process.platform !== "win32")("Windows goal startup fails before a message or approval", async () => {
  const h = await setup(); await h.command("Check the fixture");
  expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("POSIX"), "warning");
  expect(h.sentUserMessages).toEqual([]); expect(h.confirm).not.toHaveBeenCalled();
});

describe("platform-independent command inspection", () => {
  it("opens a read-only native dashboard for a blank TUI command", async () => {
    const h = await setup(); Object.assign(h.ctx, { mode: "tui" });
    const custom = vi.fn(async () => ({ type: "close" })); Object.assign(h.ctx.ui, { custom });
    await h.command("");
    expect(custom).toHaveBeenCalledTimes(1); expect(h.select).not.toHaveBeenCalled();
    expect(h.sentUserMessages).toEqual([]); expect(h.confirm).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
    expect(await h.listed()).toContain("No loops");
  });
  it("the actual TUI factory renders peer goals and recovery without effects", async () => {
    const h = await setup(true); const store = new LoopStore(h.path);
    store.create({ type: "dynamic" }, "Fixture rendered goal", { recurring: true, maxFires: 5, completion: policy, completionCwd: h.ctx.cwd });
    const before = structuredClone(store.list()); Object.assign(h.ctx, { mode: "tui" });
    const custom = vi.fn(async (factory: any) => {
      let result: unknown;
      const component = factory({ terminal: { rows: 40 }, requestRender() {} }, { fg: (_token: string, text: string) => text, bold: (text: string) => text }, {}, (action: unknown) => { result = action; });
      const rendered = component.render(120).join("\n");
      expect(rendered).toContain("ACCEPTANCE CRITERIA"); expect(rendered).toContain(policy.criteria[0]); expect(rendered).toContain("RECOVERY");
      component.handleInput("\u001b"); component.dispose(); return result;
    });
    Object.assign(h.ctx.ui, { custom }); await h.command("");
    expect(store.list()).toEqual(before); expect(h.confirm).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled(); expect(h.sentUserMessages).toEqual([]);
  });
  it("dashboard cancel requires confirmation and uses the observed controller identity", async () => {
    const h = await setup(true); const store = new LoopStore(h.path);
    const entry = store.create({ type: "dynamic" }, "Fixture", { recurring: true, maxFires: 5, completion: policy, completionCwd: h.ctx.cwd });
    Object.assign(h.ctx, { mode: "tui" }); Object.assign(h.ctx.ui, { custom: vi.fn(async () => ({ type: "cancel", entry: structuredClone(entry) })) });
    h.confirm.mockResolvedValueOnce(false); await h.command(""); expect(store.get("1")).toBeDefined();
    h.confirm.mockResolvedValueOnce(true); await h.command(""); expect(store.get("1")).toBeUndefined();
    expect(h.confirm).toHaveBeenCalledTimes(2); expect(h.sentUserMessages).toEqual([]); expect(h.executeTool).not.toHaveBeenCalled();
  });
  it("retains the native menu for RPC rather than opening an unsupported custom screen", async () => {
    const h = await setup(); Object.assign(h.ctx, { mode: "rpc" });
    const custom = vi.fn(); Object.assign(h.ctx.ui, { custom }); await h.command("");
    expect(custom).not.toHaveBeenCalled(); expect(h.select).toHaveBeenCalledWith("JEV loop", ["Start a goal", "Status", "Cancel a loop"], expect.any(Object));
  });
  it.each(["status nope", "cancel nope", "status 1 2", "cancel 1 2"])("rejects invalid controls: %s", async args => {
    const h = await setup(); await h.command(args);
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Use /jev-loop"), "warning");
    expect(h.sentUserMessages).toEqual([]); expect(h.executeTool).not.toHaveBeenCalled();
  });
  it("status and absent cancellation do not create work or claim it is running", async () => {
    const h = await setup(); await h.command("status"); await h.command("status 99"); await h.command("cancel 99");
    expect(h.sentUserMessages).toEqual([]); expect(h.confirm).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
    expect(await h.listed()).toContain("No loops");
    expect(h.notify.mock.calls.some(([text]) => String(text).includes("No JEV controllers"))).toBe(true);
  });
  it("menu cancellation and missing input have no side effects", async () => {
    const h = await setup(); await h.command("");
    h.select.mockResolvedValueOnce("Start a goal"); await h.command("");
    h.select.mockResolvedValueOnce("Status"); await h.command("");
    h.select.mockResolvedValueOnce("Cancel a loop"); await h.command("");
    expect(h.sentUserMessages).toEqual([]); expect(h.confirm).not.toHaveBeenCalled();
  });
  it("unknown menu values do not fall through into goal input", async () => {
    const h = await setup(); h.select.mockResolvedValueOnce("invented"); await h.command("");
    expect(h.input).not.toHaveBeenCalled(); expect(h.sentUserMessages).toEqual([]);
  });
  it("oversized controls do not echo unbounded input into the UI", async () => {
    const h = await setup(); await h.command(`status ${"9".repeat(4000)}`);
    expect(h.notify.mock.calls.every(([text]) => String(text).length < 500)).toBe(true);
    expect(h.sentUserMessages).toEqual([]);
  });
  it("headless mode does not silently approve or send a request", async () => {
    const h = await setup(); h.ctx.hasUI = false; await h.command("A goal");
    expect(h.sentUserMessages).toEqual([]); expect(h.confirm).not.toHaveBeenCalled();
  });
});

describe.skipIf(process.platform === "win32")("goal-first POSIX command acceptance", () => {
  it.each(["x Delete", "- Pause"])("legacy /loop %s drains the owned verifier before acknowledgement", async action => {
    const h = await setup(); const pidPath = join(h.ctx.cwd, "owned-verifier.pid");
    await h.create({ ...policy, verification: { command: process.execPath,
      args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(pidPath)}, String(process.pid)); setInterval(() => {}, 1000);`],
      description: "A fixed owned process used only to verify cancellation cleanup" } });
    const reviewing = h.call("LoopUpdate", { id: "1", status: "completed", completionEvidence: "The fixed cancellation fixture is ready for review." });
    try {
      await vi.waitFor(() => expect(existsSync(pidPath)).toBe(true), { timeout: 5000 });
      const pid = Number(readFileSync(pidPath, "utf8")); let selected = false;
      expect(Number.isSafeInteger(pid)).toBe(true);
      h.select.mockImplementation(async (title, choices) => {
        if (title === "Loop") return "View loops";
        if (title === "Loops" && !selected) { selected = true; return choices.find((value: string) => value.includes("#1")); }
        if (String(title).startsWith("#1:")) return action;
        return undefined;
      });
      await h.commandMap.get("loop")!.handler!("", h.ctx);
      expect(() => process.kill(pid, 0)).toThrow();
      expect(await h.listed()).toContain(action === "x Delete" ? "No loops" : "paused");
      expect(h.executeTool).not.toHaveBeenCalled();
    } finally { await h.shutdown(); await reviewing; }
  });

  it("hands a Korean goal to the parent, not JEV or the store, with bounded English-policy instructions", async () => {
    const h = await setup(); const goal = "문서 링크가 모두 유효해질 때까지 개선해줘";
    await h.command(goal);
    expect(h.sentUserMessages).toHaveLength(1);
    const request = h.sentUserMessages[0]!;
    expect(request.message).toContain(JSON.stringify({ goal }));
    for (const part of ["English", "LoopCreate", "completion", "maxFires=5", 'expiresIn="1h"', "NOT execution approval", "ordered workflow", "LoopUpdate", "completionEvidence"]) expect(request.message).toContain(part);
    expect(request.options).toEqual({ expandPromptTemplates: false });
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled(); expect(await h.listed()).toContain("No loops");
  });
  it("the native goal menu uses the same handoff without an extra approval", async () => {
    const h = await setup(); h.select.mockResolvedValueOnce("Start a goal"); h.input.mockResolvedValueOnce("Check the fixture goal");
    await h.command(""); expect(h.sentUserMessages).toHaveLength(1); expect(h.confirm).not.toHaveBeenCalled();
  });
  it("rejects an oversized goal without starting a turn", async () => {
    const h = await setup(); await h.command("x".repeat(2001)); expect(h.sentUserMessages).toEqual([]);
  });
  it.each(["missing", "hidden", "model-only", "inactive"])("unavailable JEV (%s) cannot fall back or start a goal", async state => {
    const h = await setup();
    if (state === "missing") h.pi.getAllTools.mockReturnValue([]);
    else if (state === "inactive") h.pi.getActiveTools.mockReturnValue([]);
    else h.pi.getAllTools.mockReturnValue([{ name: "jev_decide", exposure: state }]);
    await h.command("A fixture goal"); expect(h.sentUserMessages).toEqual([]); expect(h.confirm).not.toHaveBeenCalled();
  });
  it.each(["codemode", "deferred"])("callable %s JEV does not require changing active tools", async exposure => {
    const h = await setup(); h.pi.getAllTools.mockReturnValue([{ name: "jev_decide", exposure }]); h.pi.getActiveTools.mockReturnValue([]);
    await h.command("A fixture goal"); expect(h.sentUserMessages).toHaveLength(1);
  });
  it("busy setup waits in memory, is inspectable, and sends only when idle", async () => {
    const h = await setup(); const ready = deferred<void>(); h.setIdle(false); h.waitForIdle.mockReturnValueOnce(ready.promise);
    const pending = h.command("First goal"); await Promise.resolve();
    expect(h.sentUserMessages).toEqual([]); await h.command("status"); await h.command("Second goal");
    expect(h.notify.mock.calls.some(([text]) => String(text).includes("Setup waiting"))).toBe(true);
    h.setIdle(true); ready.resolve(); await pending;
    expect(h.sentUserMessages).toHaveLength(1); expect(h.sentUserMessages[0]!.message).toContain("First goal");
  });
  it("an idle race does not queue an uncancelable follow-up", async () => {
    const h = await setup(); h.setIdle(false); h.waitForIdle.mockImplementationOnce(async () => {});
    await h.command("A goal"); expect(h.sentUserMessages).toEqual([]);
    await h.command("status"); expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("No setup waiting"), "info");
  });
  it("pending cancellation prevents the late idle handoff without claiming a controller was canceled", async () => {
    const h = await setup(); const ready = deferred<void>(); h.setIdle(false); h.waitForIdle.mockReturnValueOnce(ready.promise);
    const pending = h.command("A waiting goal"); await Promise.resolve(); await h.command("cancel");
    h.setIdle(true); ready.resolve(); await pending;
    expect(h.sentUserMessages).toEqual([]); expect(await h.listed()).toContain("No loops");
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Pending setup canceled"), "info");
  });
  it.each(["session", "shutdown", "abort", "cwd"])("%s invalidation suppresses a delayed setup", async boundary => {
    const h = await setup(); const ready = deferred<void>(); h.setIdle(false); h.waitForIdle.mockReturnValueOnce(ready.promise);
    const pending = h.command("Stale goal"); await Promise.resolve();
    if (boundary === "session") await h.switchSession();
    else if (boundary === "shutdown") await h.shutdown();
    else if (boundary === "abort") h.abort.abort();
    else h.ctx.cwd = join(h.ctx.cwd, "replacement");
    h.setIdle(true); ready.resolve(); await pending; expect(h.sentUserMessages).toEqual([]);
  });
  it("a stale input dialog cannot create a setup", async () => {
    const h = await setup(); const input = deferred<string | undefined>();
    h.select.mockResolvedValueOnce("Start a goal"); h.input.mockReturnValueOnce(input.promise);
    const command = h.command(""); await vi.waitFor(() => expect(h.input).toHaveBeenCalled());
    await h.switchSession(); input.resolve("Too late"); await command; expect(h.sentUserMessages).toEqual([]);
  });
  it("idle delivery refusal does not retry or queue follow-up messages", async () => {
    const h = await setup(); h.pi.sendUserMessage = vi.fn(() => { throw new Error("Delivery refused"); });
    await h.command("A fixture goal"); expect(h.pi.sendUserMessage).toHaveBeenCalledTimes(1); expect(await h.listed()).toContain("No loops");
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("Delivery refused"), "error");
  });
  it("status exposes criteria and cancellation affects only JEV controllers", async () => {
    const h = await setup(); await h.create(); await h.create(null);
    const approvals = h.confirm.mock.calls.length; const before = await h.listed();
    await h.command("status 1"); expect(await h.listed()).toBe(before);
    expect(h.notify.mock.calls.some(([text]) => String(text).includes(policy.criteria[0]!))).toBe(true);
    await h.command("cancel 2"); expect(await h.listed()).toContain("#2");
    await h.command("cancel 1"); const after = await h.listed(); expect(after).not.toContain("#1"); expect(after).toContain("#2");
    expect(h.confirm).toHaveBeenCalledTimes(approvals); expect(h.executeTool).not.toHaveBeenCalled();
  });
  it("ordinary finite-loop control still delivers its committed final wake", async () => {
    const h = await setup(); h.setIdle(false); await h.emitExtension("agent_start", {}, h.ctx);
    await h.call("LoopCreate", { trigger: "idle", triggerType: "idle", prompt: "Ordinary bounded goal", maxFires: 1, expiresIn: "1h" });
    expect(h.sentMessages).toHaveLength(0);
    h.setIdle(true); await h.emitExtension("agent_end", {}, h.ctx);
    expect(h.sentMessages).toHaveLength(1);
    expect(h.sentMessages[0]!.message.content).toContain("Ordinary bounded goal");
  });
  it("canceling a capped controller drops its final queued wake", async () => {
    const h = await setup(); h.setIdle(false); await h.emitExtension("agent_start", {}, h.ctx);
    await h.call("LoopCreate", { trigger: "idle", triggerType: "idle", prompt: "A capped JEV goal", completion: policy, maxFires: 1, expiresIn: "1h" });
    expect(h.sentMessages).toHaveLength(0);
    await h.command("cancel 1");
    h.setIdle(true); await h.emitExtension("agent_end", {}, h.ctx);
    expect(h.sentMessages).toHaveLength(0);
    expect(await h.listed()).toContain("No loops");
  });
  it("a file-backed stale selection cannot cancel replacement work or rotate its snapshot", async () => {
    const h = await setup(true); await h.create(); const selection = deferred<string | undefined>(); h.select.mockReturnValueOnce(selection.promise);
    const cancel = h.command("cancel"); await vi.waitFor(() => expect(h.select).toHaveBeenCalled());
    const peer = new LoopStore(h.path); peer.delete("1"); peer.create({ type: "dynamic" }, "Replacement work", { recurring: true });
    const before = readFileSync(h.path, "utf8"); selection.resolve("#1 Fixture user goal"); await cancel;
    expect(readFileSync(h.path, "utf8")).toBe(before); expect(peer.get("2")?.prompt).toBe("Replacement work");
    expect(h.notify).toHaveBeenCalledWith(expect.stringContaining("changed"), "warning");
  });
});
