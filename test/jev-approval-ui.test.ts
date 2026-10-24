import { type Component, stripTerminalSequences, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, fixture, policy, text } from "./helpers/jev-loop-fixture.js";

type View = Component & { dispose?(): void };
const sessions: ReturnType<typeof fixture>[] = [];
afterEach(async () => { for (const h of sessions.splice(0)) await h.shutdown(); vi.useRealTimers(); });

function screen(columns = 100, rows = 30) {
  const h = fixture(); sessions.push(h);
  const terminal = { columns, rows };
  const requestRender = vi.fn();
  let view: View | undefined;
  const custom = vi.fn((factory: (...args: any[]) => View) => new Promise<boolean>(resolve => {
    view = factory({ terminal, requestRender }, { fg: (_token: string, value: string) => value }, {}, (value: boolean) => {
      view?.dispose?.(); resolve(value);
    });
  }));
  Object.assign(h.ctx, { mode: "tui", ui: { confirm: h.confirm, custom } });
  return { h, custom, terminal, requestRender,
    get view() { if (!view) throw new Error("Expected the bounded approval view"); return view; },
    render() { return this.view.render(terminal.columns - 2).map(stripTerminalSequences); },
  };
}

function untouched(h: ReturnType<typeof fixture>) {
  expect(h.store.list()).toEqual([]); expect(h.activate).not.toHaveBeenCalled();
  expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
}

describe.skipIf(process.platform === "win32")("bounded JEV approval presentation", () => {
  it.each([[100, 30], [160, 60], [48, 16], [90, 45]])("pins choices and countdown inside a %i by %i terminal", async (columns, rows) => {
    vi.useFakeTimers(); const s = screen(columns, rows); const pending = s.h.create();
    expect(s.custom).toHaveBeenCalledTimes(1); expect(s.h.confirm).not.toHaveBeenCalled();
    const lines = s.render(); const rendered = lines.join("\n");
    expect(lines.length).toBeLessThanOrEqual(rows - 2);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(columns - 2);
    expect(rendered).toMatch(/Approve JEV loop.*3600s/);
    for (const label of ["Yes", "No", "Enter", "Esc"]) expect(rendered).toContain(label);
    untouched(s.h);
    s.view.handleInput!("\u001b"); await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps all exact setup values and disclosures reachable by keyboard scrolling", async () => {
    const s = screen(); const pending = s.h.create({ completion: { ...policy, verification: { ...policy.verification, args: [...policy.verification.args, "--label=한글界🙂"] } } });
    expect(s.custom).toHaveBeenCalledTimes(1);
    const pages: string[] = [];
    for (let i = 0; i < 12; i++) {
      const lines = s.render();
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(98);
      pages.push(lines.join("\n")); s.view.handleInput!("\u001b[6~");
    }
    const all = pages.join("\n");
    for (const value of [policy.goal, ...policy.criteria, policy.verification.command, ...policy.verification.args, policy.verification.description, "한글界🙂", s.h.ctx.cwd, "expiresAt", "maxFires", "not sandboxed", "require fresh approval"]) expect(all).toContain(value);
    expect(all).not.toContain("원래 사용자 요청");
    s.view.handleInput!("\u001b[H"); expect(s.render().join("\n")).toContain(policy.goal);
    s.view.handleInput!("\u001b[F"); expect(s.render().join("\n")).toContain("require fresh approval");
    untouched(s.h); s.view.handleInput!("\u001b"); await pending;
  });

  it("defaults Enter to No without creating work", async () => {
    const s = screen(); const pending = s.h.create(); expect(s.custom).toHaveBeenCalledTimes(1);
    s.render(); s.view.handleInput!("\r");
    expect(text(await pending)).toMatch(/declined or dismissed/); untouched(s.h);
  });

  it("requires an explicit Yes and preserves verification, advice and one approval", async () => {
    vi.useFakeTimers(); const s = screen(); const pending = s.h.create(); expect(s.custom).toHaveBeenCalledTimes(1);
    s.render(); untouched(s.h); s.view.handleInput!("\t"); s.view.handleInput!("\r");
    expect(text(await pending)).toContain("Loop #1 created");
    expect(s.h.exec).not.toHaveBeenCalled(); expect(s.h.executeTool).not.toHaveBeenCalled();
    expect(text(await s.h.complete())).toContain("completed and deleted");
    expect(s.custom).toHaveBeenCalledTimes(1); expect(s.h.confirm).not.toHaveBeenCalled();
    expect(s.h.exec).toHaveBeenCalledTimes(1); expect(s.h.executeTool).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([false, true])("preserves an explicit mouse choice without starting verification (approve=%s)", async approve => {
    vi.useFakeTimers(); const s = screen(); const pending = s.h.create(); expect(s.custom).toHaveBeenCalledTimes(1);
    const row = s.render().findIndex(line => line.includes(approve ? "Yes — approve" : "No — cancel"));
    expect(row).toBeGreaterThan(0);
    const event: TuiMouseEvent = { type: "press", button: "left", x: 3, y: row, screenX: 3, screenY: row, width: 98, height: 28, shift: false, alt: false, ctrl: false };
    s.view.handleMouse!(event); s.view.handleMouse!({ ...event, type: "click" });
    expect(text(await pending)).toMatch(approve ? /Loop #1 created/ : /declined or dismissed/);
    expect(s.h.store.list()).toHaveLength(approve ? 1 : 0);
    expect(s.h.exec).not.toHaveBeenCalled(); expect(s.h.executeTool).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves scroll and pinned choices across mouse-wheel routing and invalidation", async () => {
    vi.useFakeTimers(); const s = screen(); const pending = s.h.create();
    const before = s.render(); const event: TuiMouseEvent = { type: "wheel", button: "none", x: 3, y: 3, screenX: 3, screenY: 3, width: 98, height: 28, shift: false, alt: false, ctrl: false, wheelDelta: 3 };
    const routed = s.view.handleMouse!(event);
    expect(routed?.handled).toBe(true); expect(routed?.focusTarget).toBe(s.view);
    const scrolled = s.render(); expect(scrolled[2]).not.toBe(before[2]);
    s.view.invalidate(); expect(s.render()).toEqual(scrolled);
    expect(scrolled.join("\n")).toContain("Yes — approve"); expect(scrolled.join("\n")).toContain("No — cancel");
    untouched(s.h); s.view.handleInput!("\u001b"); await pending;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps controls visible for maximum-length argument lists without discarding the details", async () => {
    const s = screen(); const pending = s.h.create({ completion: { ...policy, verification: { ...policy.verification, args: Array<string>(32).fill("x".repeat(1024)) } } });
    expect(s.custom).toHaveBeenCalledTimes(1);
    for (const key of ["\u001b[F", "\u001b[H"]) {
      s.view.handleInput!(key); const lines = s.render();
      expect(lines.length).toBeLessThanOrEqual(28);
      expect(lines.join("\n")).toContain("Yes — approve"); expect(lines.join("\n")).toContain("No — cancel");
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(98);
    }
    untouched(s.h); s.view.handleInput!("\u001b"); await pending;
  });

  it("cleans up an abort that arrives before the custom factory returns", async () => {
    vi.useFakeTimers(); const s = screen(); const abort = new AbortController(); const original = s.custom.getMockImplementation()!;
    s.custom.mockImplementationOnce(factory => { abort.abort(); return original(factory); });
    expect(text(await s.h.create({}, abort.signal))).toMatch(/cancelled/);
    untouched(s.h); expect(vi.getTimerCount()).toBe(0);
  });

  it("reflows on resize without losing fixed controls or resetting the loop expiry", async () => {
    vi.useFakeTimers(); const s = screen(160, 60); const pending = s.h.create({ expiresIn: "121s" }); expect(s.custom).toHaveBeenCalledTimes(1);
    s.render(); s.view.handleInput!("\u001b[F");
    await vi.advanceTimersByTimeAsync(1_000);
    s.terminal.columns = 100; s.terminal.rows = 30;
    const lines = s.render(); expect(lines.length).toBeLessThanOrEqual(28);
    expect(lines.join("\n")).toMatch(/120s/); expect(lines.join("\n")).toContain("Yes");
    expect(s.requestRender).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(text(await pending)).toMatch(/loop lifetime expired/i); untouched(s.h);
    s.view.handleInput!("\t"); s.view.handleInput!("\r"); untouched(s.h);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["\u001b", "\u0003"])("declines on cancellation input %j", async key => {
    vi.useFakeTimers(); const s = screen(); const pending = s.h.create(); expect(s.custom).toHaveBeenCalledTimes(1);
    s.render(); s.view.handleInput!(key); expect(text(await pending)).toMatch(/declined or dismissed/);
    untouched(s.h); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["caller", "shutdown", "expiry"])("closes and cleans the view on %s without late approval", async mode => {
    vi.useFakeTimers(); const s = screen(); const abort = new AbortController();
    const pending = s.h.create(mode === "expiry" ? { expiresIn: "1s" } : {}, abort.signal);
    expect(s.custom).toHaveBeenCalledTimes(1); s.render();
    if (mode === "caller") abort.abort();
    else if (mode === "shutdown") await s.h.shutdown();
    else await vi.advanceTimersByTimeAsync(1_000);
    expect(text(await pending)).toMatch(mode === "expiry" ? /lifetime expired/ : /cancelled/);
    s.view.handleInput!("\t"); s.view.handleInput!("\r"); untouched(s.h);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never accepts an affirmative choice after the terminal becomes unreadable", async () => {
    const s = screen(); const pending = s.h.create(); expect(s.custom).toHaveBeenCalledTimes(1);
    s.render(); s.view.handleInput!("\t");
    s.terminal.columns = 20; s.terminal.rows = 6;
    const lines = s.render(); expect(lines.length).toBeLessThanOrEqual(4);
    expect(lines.join("\n")).toMatch(/resize/i);
    s.view.handleInput!("\r"); expect(text(await pending)).toMatch(/declined or dismissed/); untouched(s.h);
  });

  it("does not fall back to the clipped native dialog after a custom UI failure", async () => {
    const s = screen(); s.custom.mockRejectedValueOnce(new Error("Fixture custom UI failure"));
    expect(text(await s.h.create())).toContain("Fixture custom UI failure");
    untouched(s.h); expect(s.h.confirm).not.toHaveBeenCalled();
  });

  it.each([
    { mode: "loop-expiry", expiresIn: "1h", elapsed: 3_600_000, reason: /loop lifetime expired/i },
    { mode: "expiry", expiresIn: "1s", elapsed: 1_000, reason: /lifetime expired/ },
    { mode: "caller", expiresIn: "1h", elapsed: 1_000, reason: /caller or active context/ },
    { mode: "shutdown", expiresIn: "1h", elapsed: 1_000, reason: /session ended or changed/ },
  ])("identifies RPC approval interruption without echoing arbitrary reasons: $mode", async ({ mode, expiresIn, elapsed, reason }) => {
    vi.useFakeTimers(); const s = screen(); Object.assign(s.h.ctx, { mode: "rpc" });
    const wait = deferred<boolean>(); const abort = new AbortController(); s.h.confirm.mockReturnValueOnce(wait.promise);
    const pending = s.h.create({ expiresIn }, abort.signal);
    await vi.advanceTimersByTimeAsync(elapsed);
    if (mode === "caller") abort.abort("PRIVATE CANCELLATION REASON");
    if (mode === "shutdown") await s.h.shutdown();
    const result = text(await pending);
    expect(result).toMatch(reason); expect(result).not.toContain("PRIVATE");
    wait.resolve(true); await Promise.resolve(); untouched(s.h);
    expect(s.h.confirm).toHaveBeenCalledTimes(1); expect(s.custom).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the native confirmation and exact deadline for RPC clients", async () => {
    vi.useFakeTimers(); const s = screen(); Object.assign(s.h.ctx, { mode: "rpc" });
    expect(text(await s.h.create())).toContain("Loop #1 created");
    expect(s.custom).not.toHaveBeenCalled(); expect(s.h.confirm).toHaveBeenCalledWith("Approve JEV loop", expect.stringContaining(policy.verification.command), { signal: expect.any(AbortSignal), timeout: 3_600_000 });
    expect(vi.getTimerCount()).toBe(0);
  });
});
