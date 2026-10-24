import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, fixture, outcome, recommendation, text } from "./helpers/jev-loop-fixture.js";

const sessions: ReturnType<typeof fixture>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const h of sessions.splice(0)) await h.shutdown();
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function session(path?: string) {
  const h = fixture(path); sessions.push(h); Object.assign(h.ctx, { mode: "rpc" }); return h;
}

describe.skipIf(process.platform === "win32")("approval and review use the original loop lifetime", () => {
  it("accepts an initial approval after 120 seconds without extending expiry or starting work", async () => {
    vi.useFakeTimers(); const start = Date.now(); const h = session(); const approval = deferred<boolean>();
    h.confirm.mockReturnValueOnce(approval.promise); const pending = h.create();
    await vi.advanceTimersByTimeAsync(121_000);
    expect(h.store.list()).toEqual([]); expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
    approval.resolve(true);
    expect(text(await pending)).toContain("Loop #1 created");
    expect(h.store.get("1")?.expiresAt).toBe(start + 3_600_000);
    expect(h.confirm).toHaveBeenCalledWith("Approve JEV loop", expect.stringContaining("loop expiry or cancellation"), { signal: expect.any(AbortSignal), timeout: 3_600_000 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still rejects late initial approval at the exact loop expiry", async () => {
    vi.useFakeTimers(); const h = session(); const approval = deferred<boolean>();
    h.confirm.mockReturnValueOnce(approval.promise); const pending = h.create({ expiresIn: "121s" });
    await vi.advanceTimersByTimeAsync(121_000);
    expect(text(await pending)).toMatch(/loop lifetime expired/i);
    approval.resolve(true); await Promise.resolve();
    expect(h.store.list()).toEqual([]); expect(h.activate).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a live advice review beyond 120 seconds and its verifier bound at 30 seconds", async () => {
    vi.useFakeTimers(); const h = session(); await h.create(); const advice = deferred<ReturnType<typeof outcome>>();
    h.executeTool.mockReturnValueOnce(advice.promise); const pending = h.complete();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.exec).toHaveBeenCalledWith(expect.any(String), expect.any(Array), expect.objectContaining({ timeout: 30_000 }));
    expect(h.executeTool).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(121_000);
    expect(h.runtime.getReviewPhase(h.store.get("1")!)).toBe("advice");
    expect(h.store.get("1")?.completionReview?.expiresAt).toBe(h.store.get("1")?.expiresAt);
    advice.resolve(outcome(recommendation()));
    expect(text(await pending)).toContain("completed and deleted");
    expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.executeTool).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["expiry", "caller", "shutdown"])("holds an in-flight review on %s and rejects late met advice", async mode => {
    vi.useFakeTimers(); const h = session(); await h.create({ expiresIn: "121s" });
    const before = structuredClone(h.store.get("1")); const advice = deferred<ReturnType<typeof outcome>>(); const abort = new AbortController();
    h.executeTool.mockReturnValueOnce(advice.promise); const pending = h.complete({}, abort.signal);
    await vi.advanceTimersByTimeAsync(0);
    if (mode === "expiry") await vi.advanceTimersByTimeAsync(121_000);
    else if (mode === "caller") abort.abort();
    else await h.shutdown();
    expect(text(await pending)).toMatch(/held/);
    advice.resolve(outcome(recommendation())); await Promise.resolve();
    expect(h.store.get("1")).toMatchObject({ status: before!.status, fireCount: before!.fireCount, dynamic: before!.dynamic });
    expect(h.store.get("1")?.completionReview).toBeUndefined();
    expect(h.executeTool).toHaveBeenCalledTimes(1); expect(h.runtime.getReviewPhase(h.store.get("1")!)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retains a file-backed review reservation throughout a long fresh approval", async () => {
    vi.useFakeTimers(); const dir = mkdtempSync(join(tmpdir(), "jev-review-lifetime-")); directories.push(dir);
    const path = join(dir, "loops.json"); const original = session(path); await original.create(); await original.shutdown();
    const h = session(path); const approval = deferred<boolean>(); h.confirm.mockReturnValueOnce(approval.promise);
    const pending = h.complete(); await vi.advanceTimersByTimeAsync(121_000);
    expect(h.runtime.getReviewPhase(h.store.get("1")!)).toBe("approval");
    expect(h.store.get("1")?.completionReview?.expiresAt).toBe(h.store.get("1")?.expiresAt);
    expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
    const peer = session(path); expect(text(await peer.complete())).toMatch(/in progress|changed/);
    expect(peer.confirm).not.toHaveBeenCalled(); expect(peer.exec).not.toHaveBeenCalled(); expect(peer.executeTool).not.toHaveBeenCalled();
    approval.resolve(true); expect(text(await pending)).toContain("completed and deleted");
    expect(h.confirm).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it("does not overflow long native approval deadlines or renew the loop lifetime", async () => {
    vi.useFakeTimers(); const start = Date.now(); const h = session(); const approval = deferred<boolean>();
    const timers = vi.spyOn(globalThis, "setTimeout"); h.confirm.mockReturnValueOnce(approval.promise);
    const pending = h.create({ expiresIn: "30d" });
    expect(timers).toHaveBeenCalledWith(expect.any(Function), 2_147_483_647);
    expect(h.confirm.mock.calls[0]![2]).toEqual({ signal: expect.any(AbortSignal) });
    await vi.advanceTimersByTimeAsync(2_147_483_648);
    expect(h.store.list()).toEqual([]);
    approval.resolve(true); expect(text(await pending)).toContain("Loop #1 created");
    expect(h.store.get("1")?.expiresAt).toBe(start + 30 * 86_400_000);
    expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0); timers.mockRestore();
  });
});
