import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completionPacket } from "../src/jev-completion.js";
import { LoopStore } from "../src/store.js";
import { deferred, evidence, fixture, outcome, policy, recommendation, text } from "./helpers/jev-loop-fixture.js";

const sessions: ReturnType<typeof fixture>[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const h of sessions.splice(0)) await h.shutdown();
  vi.restoreAllMocks(); vi.useRealTimers();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function setup(fileBacked = false) {
  let path: string | undefined;
  if (fileBacked) { const dir = mkdtempSync(join(tmpdir(), "jev-rework-")); directories.push(dir); path = join(dir, "loops.json"); }
  const h = fixture(path); sessions.push(h); return { h, path };
}
function missingSecond(h: ReturnType<typeof fixture>) {
  h.executeTool.mockResolvedValueOnce(outcome(recommendation("unmet")))
    .mockResolvedValueOnce(outcome(recommendation("met")))
    .mockResolvedValueOnce(outcome(recommendation("unmet")));
}

describe.skipIf(process.platform === "win32")("binary completion diagnoses and bounded same-goal rework", () => {
  it("offers only met/unmet and explicitly treats inadequate evidence as unmet", () => {
    const packet = completionPacket(policy, evidence, 0);
    expect(packet.options.map(option => option.id)).toEqual(["met", "unmet"]);
    expect(packet.question).toMatch(/missing.*unmet/i);
    expect(packet.options[1]!.description).toMatch(/evidence|insufficient|missing/i);
  });

  it.each([-1, policy.criteria.length, 0.5, Number.NaN])("rejects an invalid focus index before making a diagnostic packet: %s", index => {
    expect(() => completionPacket(policy, evidence, 0, index)).toThrow(/diagnostic index/);
  });

  it("diagnoses the maximum eight criteria without dropping context or changing intent", async () => {
    const { h } = setup(); const completion = { ...policy, criteria: Array.from({ length: 8 }, (_value, index) => `Required observation ${index + 1} is supported.`) };
    await h.create({ completion }); const before = structuredClone(h.store.get("1")!);
    h.executeTool.mockResolvedValue(outcome(recommendation("unmet")));
    const result = text(await h.complete());
    expect(h.executeTool).toHaveBeenCalledTimes(9); expect(result).toContain("criterion 8");
    for (let index = 0; index < 8; index++) {
      const packet = h.executeTool.mock.calls[index + 1]![1];
      expect(packet.question).toContain(`criterion ${index + 1}`);
      expect(JSON.parse(packet.context).criteria).toEqual(completion.criteria);
      expect(packet.context.length).toBeLessThanOrEqual(4000);
    }
    expect(h.store.get("1")).toMatchObject({ completion: before.completion, expiresAt: before.expiresAt, maxFires: before.maxFires, fireCount: before.fireCount });
    expect(h.store.get("1")?.dynamic?.iteration).toBe(1); expect(h.confirm).toHaveBeenCalledTimes(1);
  });

  it("identifies the deficient criterion and automatically continues the same goal without new consent", async () => {
    const { h } = setup(); await h.create(); const original = structuredClone(h.store.get("1")!);
    missingSecond(h); const result = text(await h.complete());
    expect(h.executeTool).toHaveBeenCalledTimes(3);
    expect(h.executeTool.mock.calls[1]![1].question).toMatch(/criterion 1/i);
    expect(h.executeTool.mock.calls[2]![1].question).toMatch(/criterion 2/i);
    for (const call of h.executeTool.mock.calls) {
      const packet = call[1]; expect(JSON.parse(packet.context).criteria).toEqual(policy.criteria);
      expect(packet.context.length).toBeLessThanOrEqual(4000);
      expect(packet.options.map((option: { id: string }) => option.id)).toEqual(["met", "unmet"]);
      expect(packet.context).not.toContain(h.ctx.cwd); expect(packet.context).not.toContain(policy.verification.command);
    }
    expect(result).toMatch(/criterion 2/i); expect(result).toMatch(/continu/i);
    const current = h.store.get("1")!;
    expect(current.status).toBe("active"); expect(current.dynamic?.iteration).toBe(1);
    expect(current.dynamic?.state).toMatch(/criterion 2/i); expect(current.dynamic?.state).toMatch(/inspect|evidence|collect/i);
    expect(current.dynamic?.awaitingUpdate).toBe(false); expect(current.completionReview).toBeUndefined();
    expect(current).toMatchObject({ createdAt: original.createdAt, completionId: original.completionId, expiresAt: original.expiresAt, maxFires: original.maxFires, fireCount: original.fireCount, completion: original.completion });
    expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.trigger.add).toHaveBeenCalledTimes(2);
  });

  it("does not mistake automatic scheduling for new evidence", async () => {
    const { h } = setup(); await h.create(); missingSecond(h); await h.complete();
    expect(h.store.get("1")?.dynamic?.iteration).toBe(1);
    const checks = h.exec.mock.calls.length; const advice = h.executeTool.mock.calls.length;
    expect(text(await h.complete())).toMatch(/additional evidence|unchanged/i);
    expect(h.exec).toHaveBeenCalledTimes(checks); expect(h.executeTool).toHaveBeenCalledTimes(advice);
    await h.call("LoopUpdate", { id: "1", status: "continue", nextInterval: "1m" });
    expect(text(await h.complete())).toMatch(/additional evidence|unchanged/i);
    expect(h.exec).toHaveBeenCalledTimes(checks); expect(h.executeTool).toHaveBeenCalledTimes(advice);
    await h.call("LoopUpdate", { id: "1", status: "continue", state: "Collected an independent observation for the missing criterion." });
    expect(text(await h.complete())).toContain("completed and deleted");
    expect(h.confirm).toHaveBeenCalledTimes(1);
  });

  it("continues a nonzero fixed verification with its known cause and no speculative JEV call", async () => {
    const { h } = setup(); await h.create(); h.exec.mockResolvedValueOnce({ code: 7, killed: false, stdout: "PRIVATE", stderr: "PRIVATE" });
    const result = text(await h.complete());
    expect(result).toMatch(/7/); expect(result).toMatch(/continu/i);
    expect(h.store.get("1")?.dynamic?.iteration).toBe(1);
    expect(h.store.get("1")?.dynamic?.state).toMatch(/verif/i);
    expect(h.executeTool).not.toHaveBeenCalled(); expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(result).not.toContain("PRIVATE");
  });

  it("continues investigation of an aggregate/criterion conflict without overriding the aggregate failure", async () => {
    const { h } = setup(); await h.create();
    h.executeTool.mockResolvedValueOnce(outcome(recommendation("unmet")))
      .mockResolvedValueOnce(outcome(recommendation("met"))).mockResolvedValueOnce(outcome(recommendation("met")));
    const result = text(await h.complete());
    expect(h.executeTool).toHaveBeenCalledTimes(3); expect(result).toMatch(/aggregate|conflict|reconcile/i);
    expect(h.store.get("1")?.dynamic?.iteration).toBe(1); expect(result).not.toContain("completed and deleted");
  });

  it("diagnoses the final capped review without resuming it or renewing its budget", async () => {
    const { h } = setup(); await h.create({ maxFires: 1 }); h.store.fire("1");
    const before = structuredClone(h.store.get("1")); missingSecond(h);
    const result = text(await h.complete());
    expect(result).toMatch(/criterion 2/i); expect(result).toMatch(/fire cap|budget/i);
    expect(h.executeTool).toHaveBeenCalledTimes(3); expect(h.store.get("1")).toEqual(before);
    expect(h.trigger.add).toHaveBeenCalledTimes(1);
  });

  it("stops a diagnostic provider error without automatic rework, retry or fallback", async () => {
    const { h } = setup(); await h.create(); const before = structuredClone(h.store.get("1"));
    h.executeTool.mockResolvedValueOnce(outcome(recommendation("unmet"))).mockResolvedValueOnce(outcome({ status: "failed" }, true));
    expect(text(await h.complete())).toMatch(/held|failed|malformed|diagnos/i);
    expect(h.executeTool).toHaveBeenCalledTimes(2); expect(h.store.get("1")).toEqual(before);
    expect(h.trigger.add).toHaveBeenCalledTimes(1);
  });

  it("expires a pending diagnostic without accepting its late answer", async () => {
    vi.useFakeTimers(); const { h } = setup(); await h.create({ expiresIn: "1s" }); const wait = deferred<ReturnType<typeof outcome>>();
    h.executeTool.mockResolvedValueOnce(outcome(recommendation("unmet"))).mockReturnValueOnce(wait.promise);
    const pending = h.complete(); await vi.advanceTimersByTimeAsync(0);
    expect(h.executeTool).toHaveBeenCalledTimes(2); await vi.advanceTimersByTimeAsync(1_000);
    expect(text(await pending)).toMatch(/held|expired|canceled/);
    wait.resolve(outcome(recommendation("unmet"))); await Promise.resolve();
    expect(h.store.get("1")?.dynamic?.iteration).toBe(0); expect(h.trigger.add).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves file-backed peer progress during a diagnostic and stops further requests", async () => {
    vi.useFakeTimers(); const { h, path } = setup(true); await h.create();
    h.executeTool.mockResolvedValueOnce(outcome(recommendation("unmet"))).mockImplementationOnce(async () => {
      new LoopStore(path).continueDynamic("1", { dynamic: { state: "Peer observation", iteration: 4 } });
      return outcome(recommendation("unmet"));
    });
    expect(text(await h.complete())).toMatch(/held|changed/);
    expect(h.executeTool).toHaveBeenCalledTimes(2); expect(h.store.get("1")?.dynamic?.state).toBe("Peer observation");
    expect(h.store.get("1")?.dynamic?.iteration).toBe(4); expect(h.trigger.add).toHaveBeenCalledTimes(1);
  });

  it("rejects same-millisecond ABA progress with a full completion continuation snapshot", async () => {
    vi.useFakeTimers(); const { h } = setup(); await h.create(); const original = structuredClone(h.store.get("1")!);
    const expected = { status: original.status, iteration: original.dynamic!.iteration, updatedAt: original.updatedAt, completionSnapshot: JSON.stringify(original) };
    h.store.pause("1"); h.store.resume("1"); const before = structuredClone(h.store.get("1"));
    expect(h.store.continueDynamic("1", { dynamic: { state: "Stale overwrite", iteration: 1 } }, expected)).toBeUndefined();
    expect(h.store.get("1")).toEqual(before);
  });

  it("does not hide a post-write continuation failure or infer rollback", async () => {
    const { h } = setup(); await h.create(); missingSecond(h); const apply = h.store.continueDynamic.bind(h.store);
    vi.spyOn(h.store, "continueDynamic").mockImplementationOnce((...args) => { apply(...args); throw new Error("CONTINUATION_POST_WRITE"); });
    await expect(h.complete()).rejects.toThrow("CONTINUATION_POST_WRITE");
    expect(h.store.get("1")?.dynamic?.iteration).toBe(1); expect(h.trigger.add).toHaveBeenCalledTimes(1);
  });
});
