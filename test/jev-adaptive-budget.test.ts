import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { canResumeFromInspection, formatLoopLifecycle } from "../src/ui/lifecycle-presentation.js";
import { deferred, fixture, outcome, policy, text } from "./helpers/jev-loop-fixture.js";

const sessions: ReturnType<typeof fixture>[] = [];
const directories: string[] = [];
afterEach(async () => { for (const h of sessions.splice(0)) await h.shutdown(); vi.restoreAllMocks(); vi.useRealTimers(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const adaptivePolicy = { ...policy, budgetRange: { minFires: 3, minExpiresIn: "30m" } };
const createParams = { maxFires: 30, expiresIn: "4h", completion: adaptivePolicy };
function setup(path?: string) { const h = fixture(path); sessions.push(h); return h; }
function storage() { const dir = mkdtempSync(join(tmpdir(), "adaptive-budget-")); directories.push(dir); return join(dir, "loops.json"); }
function choose(packet: any, last = false) {
  const options = packet.options; const selected = last ? options.at(-1) : options[0];
  return outcome({ status: "recommended", advisoryOnly: true, option: selected,
    reply: { choice: selected.id, confidence: 0.8, probabilities: Object.fromEntries(options.map((value: any) => [value.id, value.id === selected.id ? 0.8 : 0.2])), model: "budget-fixture", usage: { inputTokens: 1, outputTokens: 1 } } });
}

describe.skipIf(process.platform === "win32")("approved adaptive JEV budget envelope", () => {
  it("keeps legacy fixed setup unchanged and does not add budget requests", async () => {
    const h = setup(); expect(text(await h.create())).toContain("created");
    expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.executeTool).not.toHaveBeenCalled();
    expect(h.store.get("1")?.maxFires).toBe(3);
  });

  it("approves the range once, chooses an initial allocation and anchors hard lifetime after consent", async () => {
    vi.useFakeTimers(); const h = setup(); const approval = deferred<boolean>(); h.confirm.mockReturnValueOnce(approval.promise);
    h.executeTool.mockImplementation(async (_name, packet) => choose(packet));
    const pending = h.create(createParams); await vi.advanceTimersByTimeAsync(600_000);
    expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.executeTool).not.toHaveBeenCalled(); expect(h.store.list()).toEqual([]);
    const consentAt = Date.now(); approval.resolve(true);
    expect(text(await pending)).toContain("created");
    const entry = h.store.get("1")!;
    expect(entry.maxFires).toBe(30); expect(entry.expiresAt).toBe(consentAt + 4 * 3_600_000);
    expect(entry.adaptiveBudget).toMatchObject({ startedAt: consentAt, fireLimit: 3, expiresAt: consentAt + 1_800_000, revision: 0, lastReviewedFireCount: 0 });
    expect(h.executeTool).toHaveBeenCalledTimes(4); expect(h.exec).not.toHaveBeenCalled();
    expect(h.confirm.mock.calls[0]![1]).toMatch(/range|adaptive/i);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("renews within the hard envelope after a fire without replaying approval or raw local progress", async () => {
    vi.useFakeTimers(); const h = setup(); let extend = false;
    h.executeTool.mockImplementation(async (_name, packet) => choose(packet, extend));
    expect(text(await h.create(createParams))).toContain("created");
    const before = structuredClone(h.store.get("1")!); const initialCalls = h.executeTool.mock.calls.length;
    h.store.fire("1"); extend = true;
    const result = await h.call("LoopUpdate", { id: "1", status: "continue", state: "비공개 로컬 진행", metrics: "PRIVATE LOCAL METRICS", budgetEvidence: "Independent checks show additional authorized work remains." });
    expect(text(result)).toMatch(/updated|continued/);
    const entry = h.store.get("1")!;
    expect(entry).toMatchObject({ maxFires: before.maxFires, expiresAt: before.expiresAt, completion: before.completion, completionId: before.completionId, fireCount: 1 });
    expect(entry.adaptiveBudget).toMatchObject({ startedAt: before.adaptiveBudget!.startedAt, fireLimit: 30, expiresAt: before.expiresAt, revision: 1, lastReviewedFireCount: 1 });
    expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.executeTool.mock.calls.length).toBe(initialCalls + 4);
    const calls = h.executeTool.mock.calls.length;
    await h.call("LoopUpdate", { id: "1", status: "continue", nextInterval: "1m" });
    expect(h.executeTool).toHaveBeenCalledTimes(calls); expect(h.confirm).toHaveBeenCalledTimes(1);
    for (const call of h.executeTool.mock.calls) {
      const packet = JSON.stringify(call[1]);
      expect(packet).not.toContain("비공개"); expect(packet).not.toContain("PRIVATE LOCAL METRICS");
      expect(packet).not.toContain(h.ctx.cwd); expect(packet).not.toContain(policy.verification.command);
      expect(packet).not.toContain(policy.verification.args[0]);
    }
  });

  it.each([
    { minFires: 31, minExpiresIn: "30m" },
    { minFires: 0, minExpiresIn: "30m" },
    { minFires: 3, minExpiresIn: "5h" },
    { minFires: 3, minExpiresIn: "never" },
  ])("rejects invalid approved ranges without UI or JEV effects: %j", async budgetRange => {
    const h = setup(); await h.create({ ...createParams, completion: { ...policy, budgetRange } });
    expect(h.store.list()).toEqual([]); expect(h.confirm).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
  });

  it("rejects a malformed initial choice without creating a controller or falling back", async () => {
    const h = setup(); h.executeTool.mockResolvedValueOnce(outcome({ status: "failed" }, true));
    expect(text(await h.create(createParams))).toMatch(/failed|held|budget|invalid/i);
    expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.executeTool).toHaveBeenCalledTimes(1);
    expect(h.store.list()).toEqual([]); expect(h.exec).not.toHaveBeenCalled(); expect(h.activate).not.toHaveBeenCalled();
  });

  it("keeps a renewal provider failure state preserving instead of extending or retrying", async () => {
    const h = setup(); h.executeTool.mockImplementation(async (_name, packet) => choose(packet));
    expect(text(await h.create(createParams))).toContain("created"); h.store.fire("1");
    const before = structuredClone(h.store.get("1")); const count = h.executeTool.mock.calls.length;
    h.executeTool.mockResolvedValueOnce(outcome({ status: "failed" }, true));
    await h.call("LoopUpdate", { id: "1", status: "continue", budgetEvidence: "Further work remains." });
    expect(h.executeTool).toHaveBeenCalledTimes(count + 1); expect(h.store.get("1")).toEqual(before);
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });

  it("holds an exhausted operating slice and renews it only with a new authorized assessment", async () => {
    const h = setup(); let extend = false; h.executeTool.mockImplementation(async (_name, packet) => choose(packet, extend));
    await h.create(createParams); const original = structuredClone(h.store.get("1")!);
    h.store.fire("1"); h.store.fire("1"); h.store.fire("1");
    const held = await h.call("LoopUpdate", { id: "1", status: "continue", budgetEvidence: "The current allocation remains appropriate." });
    expect(text(held)).toMatch(/checkpoint|exhausted/);
    expect(h.store.get("1")?.pause?.kind).toBe("budget_limit"); expect(h.store.resume("1")).toBeUndefined();
    expect(canResumeFromInspection(h.store.get("1")!)).toBe(false);
    const inspection = formatLoopLifecycle(h.store.get("1")!).join("\n");
    expect(inspection).toContain("Operating allocation"); expect(inspection).toContain("Hard envelope");
    expect(inspection).toContain("budgetEvidence"); expect(inspection).toContain("not restored execution authority");
    const before = structuredClone(h.store.get("1")); const count = h.executeTool.mock.calls.length;
    await h.call("LoopUpdate", { id: "1", status: "continue", budgetEvidence: "The current allocation remains appropriate." });
    expect(h.executeTool).toHaveBeenCalledTimes(count); expect(h.store.get("1")).toEqual(before);
    extend = true;
    await h.call("LoopUpdate", { id: "1", status: "continue", budgetEvidence: "New independent observations show additional authorized work is needed." });
    expect(h.store.get("1")?.status).toBe("active"); expect(h.store.get("1")?.adaptiveBudget?.fireLimit).toBe(30);
    expect(h.store.get("1")).toMatchObject({ expiresAt: original.expiresAt, maxFires: original.maxFires, fireCount: 3 });
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });

  it("shows operating and hard limits without mutating or claiming a live assessment", async () => {
    const h = setup(); h.executeTool.mockImplementation(async (_name, packet) => choose(packet)); await h.create(createParams);
    const before = structuredClone(h.store.get("1")); const calls = h.executeTool.mock.calls.length;
    const result = text(await h.call("LoopList", {}));
    expect(result).toMatch(/operating:0\/3/); expect(result).toMatch(/hard:30 total/);
    expect(result).toContain("stored intent, not restored authority");
    expect(h.store.get("1")).toEqual(before); expect(h.executeTool).toHaveBeenCalledTimes(calls);
  });

  it("does not renew an administrative pause, hard fire cap or hard expiry", async () => {
    vi.useFakeTimers(); const h = setup(); h.executeTool.mockImplementation(async (_name, packet) => choose(packet));
    await h.create(createParams); await h.call("LoopDelete", { id: "1", action: "pause" });
    const before = structuredClone(h.store.get("1")); const count = h.executeTool.mock.calls.length;
    await h.call("LoopUpdate", { id: "1", status: "continue", budgetEvidence: "Work remains." });
    expect(h.store.get("1")).toEqual(before); expect(h.executeTool).toHaveBeenCalledTimes(count);
    expect(h.confirm).toHaveBeenCalledTimes(1);
    const capped = setup(); capped.executeTool.mockImplementation(async (_name, packet) => choose(packet));
    await capped.create(createParams); for (let index = 0; index < 30; index++) capped.store.fire("1");
    const final = structuredClone(capped.store.get("1")); const calls = capped.executeTool.mock.calls.length;
    await capped.call("LoopUpdate", { id: "1", status: "continue", budgetEvidence: "Work remains." });
    expect(capped.store.get("1")).toEqual(final); expect(capped.executeTool).toHaveBeenCalledTimes(calls);
    const expired = setup(); expired.executeTool.mockImplementation(async (_name, packet) => choose(packet)); await expired.create(createParams);
    const deadline = expired.store.get("1")!.expiresAt; await vi.advanceTimersByTimeAsync(deadline - Date.now());
    const old = structuredClone(expired.store.get("1")); const oldCalls = expired.executeTool.mock.calls.length;
    await expired.call("LoopUpdate", { id: "1", status: "continue", budgetEvidence: "Work remains." });
    expect(expired.store.get("1")).toEqual(old); expect(expired.executeTool).toHaveBeenCalledTimes(oldCalls);
  });

  it("requires fresh native range approval after restart even when this fire was already reviewed", async () => {
    const path = storage(); const original = setup(path); original.executeTool.mockImplementation(async (_name, packet) => choose(packet));
    await original.create(createParams); const before = structuredClone(original.store.get("1")!); await original.shutdown();
    const restarted = setup(path);
    await restarted.call("LoopUpdate", { id: "1", status: "continue", state: "Work resumed with fresh native authority." });
    expect(restarted.confirm).toHaveBeenCalledTimes(1); expect(restarted.executeTool).not.toHaveBeenCalled();
    expect(restarted.store.get("1")).toMatchObject({ maxFires: before.maxFires, expiresAt: before.expiresAt, adaptiveBudget: before.adaptiveBudget });
  });

  it("does not overwrite a file-backed peer mutation during renewal", async () => {
    const path = storage(); const h = setup(path); h.executeTool.mockImplementation(async (_name, packet) => choose(packet)); await h.create(createParams); h.store.fire("1");
    const count = h.executeTool.mock.calls.length;
    h.executeTool.mockImplementationOnce(async (_name, packet) => {
      new LoopStore(path).continueDynamic("1", { dynamic: { state: "Peer progress", iteration: 8 } }); return choose(packet, true);
    });
    await h.call("LoopUpdate", { id: "1", status: "continue", budgetEvidence: "Further work remains." });
    expect(h.store.get("1")?.dynamic?.state).toBe("Peer progress"); expect(h.store.get("1")?.adaptiveBudget?.revision).toBe(0);
    expect(h.executeTool).toHaveBeenCalledTimes(count + 1);
  });

  it("creates an already-elapsed initial operating slice as a budget checkpoint, not runnable work", async () => {
    vi.useFakeTimers(); const h = setup(); let calls = 0;
    h.executeTool.mockImplementation(async (_name, packet) => { if (++calls === 4) vi.setSystemTime(Date.now() + 2000); return choose(packet); });
    await h.create({ maxFires: 30, expiresIn: "10s", completion: { ...policy, budgetRange: { minFires: 3, minExpiresIn: "1s" } } });
    expect(h.store.get("1")?.status).toBe("paused"); expect(h.store.get("1")?.pause?.kind).toBe("budget_limit");
    expect(h.activate).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
  });

  it("uses the sole allowed allocation deterministically without a fabricated JEV choice", async () => {
    const h = setup(); await h.create({ maxFires: 3, expiresIn: "30m", completion: adaptivePolicy });
    expect(h.store.get("1")?.adaptiveBudget?.fireLimit).toBe(3); expect(h.executeTool).not.toHaveBeenCalled();
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });

  it("cannot renew a legacy capped controller through adaptive evidence", async () => {
    const h = setup(); await h.create({ maxFires: 1 }); h.store.fire("1"); const before = structuredClone(h.store.get("1"));
    expect(text(await h.call("LoopUpdate", { id: "1", status: "continue", budgetEvidence: "Please do more work." }))).toMatch(/fire cap|budget/i);
    expect(h.store.get("1")).toEqual(before); expect(h.executeTool).not.toHaveBeenCalled();
  });

  it("rejects late initial selection after caller cancellation without another request", async () => {
    const h = setup(); const selected = deferred<ReturnType<typeof outcome>>(); const abort = new AbortController();
    h.executeTool.mockReturnValueOnce(selected.promise); const pending = h.create(createParams, abort.signal);
    await Promise.resolve(); await Promise.resolve(); abort.abort();
    const result = await pending; expect(text(result)).not.toContain("created");
    selected.resolve(outcome({ status: "failed" }, true)); await Promise.resolve();
    expect(h.store.list()).toEqual([]); expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
