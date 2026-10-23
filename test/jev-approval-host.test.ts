import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, fixture, policy, text } from "./helpers/jev-loop-fixture.js";

const sessions: ReturnType<typeof fixture>[] = [];
afterEach(async () => { for (const h of sessions.splice(0)) await h.shutdown(); vi.useRealTimers(); });
function host() {
  const h = fixture(); sessions.push(h);
  const wait = deferred<boolean>();
  const custom = vi.fn(() => wait.promise);
  const emit = vi.spyOn(h.pi.events, "emit");
  Object.assign(h.ctx, { mode: "tui", ui: { confirm: h.confirm, custom } });
  return { h, wait, custom, emit };
}
function untouched(h: ReturnType<typeof fixture>) {
  expect(h.store.list()).toEqual([]); expect(h.activate).not.toHaveBeenCalled();
  expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
}
const waiting = { active: true, label: "Waiting for user response" };

describe.skipIf(process.platform === "win32")("approval host attention is not consent", () => {
  it("announces TUI attention before opening the dialog without disclosing the setup", async () => {
    const s = host();
    s.h.pi.events.on("herdr:blocked", () => ({ approved: true }));
    const pending = s.h.create();
    expect(s.emit).toHaveBeenCalledWith("herdr:blocked", waiting);
    expect(s.emit.mock.invocationCallOrder[0]).toBeLessThan(s.custom.mock.invocationCallOrder[0]!);
    const events = JSON.stringify(s.emit.mock.calls);
    for (const privateValue of [policy.goal, ...policy.criteria, policy.verification.command, ...policy.verification.args, s.h.ctx.cwd, "원래"]) expect(events).not.toContain(privateValue);
    await Promise.resolve(); untouched(s.h);
    s.wait.resolve(false); expect(text(await pending)).toMatch(/declined or dismissed/);
    expect(s.emit.mock.calls).toEqual([["herdr:blocked", waiting], ["herdr:blocked", { active: false }]]);
    untouched(s.h);
  });

  it.each(["decline", "accept", "ui-error", "caller", "long-expiry", "expiry", "shutdown"])("releases only its attention wait on %s", async mode => {
    vi.useFakeTimers(); const s = host(); const abort = new AbortController();
    if (mode === "ui-error") s.custom.mockRejectedValueOnce(new Error("Fixture UI failure"));
    const pending = s.h.create({ expiresIn: mode === "expiry" ? "1s" : mode === "long-expiry" ? "121s" : "1h" }, abort.signal);
    expect(s.emit).toHaveBeenCalledWith("herdr:blocked", waiting);
    if (mode === "accept" || mode === "decline") s.wait.resolve(mode === "accept");
    else if (mode === "caller") abort.abort();
    else if (mode === "shutdown") await s.h.shutdown();
    else if (mode !== "ui-error") await vi.advanceTimersByTimeAsync(mode === "expiry" ? 1_000 : 121_000);
    await pending;
    expect(s.emit.mock.calls).toEqual([["herdr:blocked", waiting], ["herdr:blocked", { active: false }]]);
    s.wait.resolve(true); await Promise.resolve();
    expect(s.h.store.list()).toHaveLength(mode === "accept" ? 1 : 0);
    expect(s.h.exec).not.toHaveBeenCalled(); expect(s.h.executeTool).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not clear another pending human interaction", async () => {
    const s = host(); let blocked = 0;
    s.h.pi.events.on("herdr:blocked", data => { blocked += (data as { active: boolean }).active ? 1 : -1; });
    s.h.pi.events.emit("herdr:blocked", { active: true, label: "Other human interaction" });
    const pending = s.h.create(); expect(blocked).toBe(2);
    s.wait.resolve(false); await pending; expect(blocked).toBe(1);
    untouched(s.h);
    s.h.pi.events.emit("herdr:blocked", { active: false }); expect(blocked).toBe(0);
  });

  it("does not announce host attention for RPC native confirmation", async () => {
    const s = host(); Object.assign(s.h.ctx, { mode: "rpc" });
    s.h.confirm.mockResolvedValueOnce(false);
    expect(text(await s.h.create())).toMatch(/declined or dismissed/);
    expect(s.h.confirm).toHaveBeenCalledTimes(1); expect(s.custom).not.toHaveBeenCalled();
    expect(s.emit).not.toHaveBeenCalled(); untouched(s.h);
  });

  it.each(["no-ui", "no-provider", "aborted"])("does not announce a dialog rejected before display: %s", async mode => {
    const s = host(); const abort = new AbortController();
    if (mode === "no-ui") s.h.ctx.hasUI = false;
    if (mode === "no-provider") Object.assign(s.h.ctx, { tools: [] });
    if (mode === "aborted") abort.abort();
    await s.h.create({}, abort.signal);
    expect(s.emit).not.toHaveBeenCalled(); expect(s.custom).not.toHaveBeenCalled(); untouched(s.h);
  });
});
