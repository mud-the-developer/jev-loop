import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { budgetTiers } from "../../src/adaptive-budget.js";
import { LoopStore } from "../../src/store.js";
import { propertyOptions } from "./config.js";

afterEach(() => vi.restoreAllMocks());
const completion = { goal: "Finish the approved fixture", criteria: ["Required observations pass"], verification: { command: "node", args: ["--version"], description: "Check the local runtime" }, budgetRange: { minFires: 1, minExpiresIn: "1s" } };

describe("adaptive budget envelope properties", () => {
  it("only generates unique finite tiers inside the approved range", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 0, max: 100_000 }), (lower, increment) => {
      const upper = lower + increment; const tiers = budgetTiers(lower, upper);
      expect(tiers[0]).toBe(lower); expect(tiers.at(-1)).toBe(upper);
      expect(tiers.length).toBeLessThanOrEqual(3); expect(new Set(tiers).size).toBe(tiers.length);
      expect(tiers.every(value => Number.isSafeInteger(value) && value >= lower && value <= upper)).toBe(true);
    }), propertyOptions());
  });

  it("never resets hard authority or accepts malformed/stale allocation changes", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    fc.assert(fc.property(fc.integer({ min: 2, max: 40 }), fc.integer({ min: 2, max: 1000 }), fc.array(fc.constantFrom("valid", "reset", "out-of-range", "stale", "admin"), { maxLength: 35 }), (maxFires, lifetimeSeconds, actions) => {
      const lifetimeMs = lifetimeSeconds * 1000;
      const store = new LoopStore();
      store.create({ type: "dynamic" }, "Private original fixture", { recurring: true, maxFires, expiresIn: `${lifetimeSeconds}s`, completion, completionCwd: process.cwd(),
        adaptiveBudget: { startedAt: 1000, fireLimit: 1, expiresAt: 2000, revision: 0, lastReviewedFireCount: 0 } });
      for (const action of actions) {
        if (action === "admin") store.pause("1");
        const before = structuredClone(store.get("1")!);
        const reserved = store.reserveCompletionReview("1", JSON.stringify(before), { id: "budget-review", expiresAt: before.expiresAt });
        expect(reserved).toBeDefined();
        const budget = { ...reserved!.adaptiveBudget!, revision: reserved!.adaptiveBudget!.revision + 1, lastReviewedFireCount: reserved!.fireCount ?? 0,
          fireLimit: maxFires, expiresAt: reserved!.expiresAt };
        if (action === "reset") budget.startedAt--;
        if (action === "out-of-range") budget.fireLimit++;
        const snapshot = JSON.stringify(reserved);
        const result = store.updateAdaptiveBudget("1", action === "stale" ? `${snapshot} ` : snapshot, budget);
        if (action !== "valid" || before.status !== "active") {
          expect(result).toBeUndefined(); expect(store.get("1")).toEqual(reserved);
        } else expect(result).toBeDefined();
        store.releaseCompletionReview("1", "budget-review");
        expect(store.get("1")).toMatchObject({ maxFires, expiresAt: 1000 + lifetimeMs, completion, fireCount: 0 });
        expect(store.get("1")!.adaptiveBudget!.startedAt).toBe(1000);
        expect(store.get("1")!.adaptiveBudget!.fireLimit).toBeLessThanOrEqual(maxFires);
        expect(store.get("1")!.adaptiveBudget!.expiresAt).toBeLessThanOrEqual(1000 + lifetimeMs);
      }
    }), propertyOptions());
  });
});
