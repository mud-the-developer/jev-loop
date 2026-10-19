import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../../src/store.js";
import { propertyOptions } from "./config.js";

const completion = {
  goal: "Complete the requested checks",
  criteria: ["All required checks pass"],
  verification: { command: "node", args: ["--version"], description: "Check that the expected runtime is available" },
};
afterEach(() => vi.restoreAllMocks());

describe("JEV completion ownership and budget properties", () => {
  it("never extends a fire budget, changes approved intent, or accepts unreviewed completion", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    fc.assert(fc.property(fc.integer({ min: 1, max: 8 }), fc.array(fc.constantFrom("fire", "pause", "resume", "continue", "weaken"), { maxLength: 80 }), (maxFires, actions) => {
      const store = new LoopStore();
      store.create({ type: "dynamic" }, "User goal", { recurring: true, maxFires, completion, completionCwd: process.cwd() });
      for (const action of actions) {
        if (action === "fire") store.fire("1");
        else if (action === "pause") store.pause("1");
        else if (action === "resume") store.resume("1");
        else if (action === "continue") store.continueDynamic("1", { dynamic: { state: "Progress", iteration: 1 } });
        else {
          const before = structuredClone(store.get("1"));
          expect(store.continueDynamic("1", { prompt: "Weakened goal", dynamic: { doneCriteria: "Always done" } })).toBeUndefined();
          expect(store.get("1")).toEqual(before);
        }
        const entry = structuredClone(store.get("1")!);
        expect(entry.completion).toEqual(completion);
        expect(entry.fireCount).toBeLessThanOrEqual(maxFires);
        expect(store.stopDynamic("1", "completed", { status: entry.status, iteration: entry.dynamic!.iteration, updatedAt: entry.updatedAt })).toBe(false);
        expect(store.get("1")).toEqual(entry);
        if (entry.fireCount === maxFires) {
          expect(store.resume("1")).toBeUndefined();
          expect(store.continueDynamic("1", { dynamic: { state: "Beyond budget" } })).toBeUndefined();
          expect(store.get("1")).toEqual(entry);
        }
      }
    }), propertyOptions());
  });

  it("same-millisecond pause/resume ABA never validates an old review receipt", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    fc.assert(fc.property(fc.integer({ min: 1, max: 30 }), changes => {
      const store = new LoopStore();
      const entry = store.create({ type: "dynamic" }, "User goal", { recurring: true, maxFires: 5, completion, completionCwd: process.cwd() });
      const reserved = store.reserveCompletionReview(entry.id, JSON.stringify(entry), { id: "old-review", expiresAt: 2000 })!;
      const snapshot = JSON.stringify(reserved);
      for (let index = 0; index < changes; index++) { store.pause(entry.id); store.resume(entry.id); }
      const before = structuredClone(store.get(entry.id));
      expect(store.stopDynamic(entry.id, "completed", { status: reserved.status, iteration: reserved.dynamic!.iteration, updatedAt: reserved.updatedAt, completionSnapshot: snapshot })).toBe(false);
      expect(store.get(entry.id)).toEqual(before);
    }), propertyOptions());
  });

  it("wrong creation identity cannot pause/cancel work or change its state", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    fc.assert(fc.property(fc.string({ maxLength: 32 }), suffix => {
      const store = new LoopStore();
      const entry = store.create({ type: "dynamic" }, "User goal", { recurring: true, maxFires: 5, completion, completionCwd: process.cwd() });
      const before = structuredClone(entry);
      expect(store.delete(entry.id, { createdAt: entry.createdAt, completionId: `stale:${suffix}` })).toBe(false);
      expect(store.pause(entry.id, "administrative", undefined, { createdAt: entry.createdAt, completionId: `stale:${suffix}` })).toBeUndefined();
      expect(store.get(entry.id)).toEqual(before);
      expect(store.delete(entry.id, { createdAt: entry.createdAt, completionId: entry.completionId })).toBe(true);
    }), propertyOptions());
  });
});
