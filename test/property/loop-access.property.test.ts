import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type LoopAccessEvent, type LoopAccessState, reduceLoopAccess } from "../../src/loop-access.js";
import { propertyOptions } from "./config.js";

const binding = { sessionId: "session-a", cwd: "/workspace", storeId: "store-a", generation: 1, judgeFence: "judge-a" };
const ceilings = { maxFires: 20, maxLifetimeMs: 3600000 };
const choices = ["request", "ack", "reject", "authorize", "over", "drift", "stale", "revoke", "close", "drained", "stale-drain"] as const;
function eventFor(action: typeof choices[number], state: LoopAccessState, index: number): LoopAccessEvent {
  const identity = { id: "id" in state ? state.id : "no-grant", epoch: state.epoch, binding };
  if (action === "request") return { type: "request", id: `ack-${index}`, binding, ceilings };
  if (action === "ack" || action === "reject" || action === "stale") return { type: "reply", ...identity, ...(action === "stale" ? { id: "stale" } : {}), accepted: action !== "reject" };
  if (action === "revoke" || action === "close") return { type: action };
  if (action === "drained" || action === "stale-drain") return { type: "drained", epoch: state.epoch - (action === "stale-drain" ? 1 : 0) };
  return { type: "authorize", ...identity, action: "verify", binding: action === "drift" ? { ...binding, judgeFence: `changed-${index}` } : binding,
    budget: { maxFires: action === "over" ? ceilings.maxFires + 1 : 1, maxLifetimeMs: 1000 } };
}

describe("volatile Loop access properties", () => {
  it("never authorizes outside an approved finite goal ceiling", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1, max: 10000000 }), fc.integer({ min: 0, max: 100001 }), fc.integer({ min: 0, max: 10000001 }), (maxFires, maxLifetimeMs, fires, lifetime) => {
      const state: LoopAccessState = { phase: "full", id: "ack", epoch: 1, binding, ceilings: { maxFires, maxLifetimeMs } };
      const result = reduceLoopAccess(state, { type: "authorize", id: "ack", epoch: 1, binding, action: "create", budget: { maxFires: fires, maxLifetimeMs: lifetime } });
      expect(result.state).toEqual(state);
      expect(result.effects.some(effect => effect.type === "authorized")).toBe(fires > 0 && lifetime > 0 && fires <= maxFires && lifetime <= maxLifetimeMs);
    }), propertyOptions());
  });

  it("preserves epoch, acknowledgement, drain and closed-state fencing through generated traces", () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...choices), { maxLength: 100 }), actions => {
      let state: LoopAccessState = { phase: "reviewed", epoch: 0 };
      actions.forEach((action, index) => {
        const event = eventFor(action, state, index), before = structuredClone(state), oldEvent = structuredClone(event);
        const next = reduceLoopAccess(state, event);
        expect(state).toEqual(before); expect(event).toEqual(oldEvent); expect(next.state.epoch).toBeGreaterThanOrEqual(state.epoch);
        if (state.phase === "closed") expect(next).toEqual({ state, effects: [] });
        if (next.state.phase === "full" && state.phase !== "full") {
          expect(state.phase).toBe("awaiting_ack"); expect(event.type).toBe("reply");
          if (event.type === "reply" && "id" in state) { expect(event.accepted).toBe(true); expect(event.id).toBe(state.id); expect(event.epoch).toBe(state.epoch); expect(event.binding).toEqual(state.binding); }
        }
        if (state.phase === "revoking" && next.state.phase !== "revoking") {
          expect(event).toEqual({ type: "drained", epoch: state.epoch }); expect(next.state.phase).toBe(state.close ? "closed" : "reviewed");
        }
        for (const effect of next.effects) {
          if (effect.type === "authorized") {
            expect(state.phase).toBe("full"); expect(next.state).toEqual(state); expect(event.type).toBe("authorize");
            if (event.type === "authorize" && state.phase === "full") {
              expect(event.id).toBe(state.id); expect(event.epoch).toBe(state.epoch); expect(event.binding).toEqual(state.binding);
              expect(event.budget.maxFires).toBeLessThanOrEqual(state.ceilings.maxFires); expect(event.budget.maxLifetimeMs).toBeLessThanOrEqual(state.ceilings.maxLifetimeMs);
            }
          } else if (effect.type === "confirm") { expect(state.phase).toBe("reviewed"); expect(next.state.phase).toBe("awaiting_ack"); }
          else { expect(["full", "awaiting_ack"]).toContain(state.phase); expect(next.state).toMatchObject({ phase: "revoking", epoch: state.epoch + 1 }); }
        }
        state = next.state;
      });
    }), propertyOptions());
  });

  it("copies validated acknowledgement scope independently of caller and effect payloads", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 100000 }), fc.integer({ min: 1, max: 100000 }), (fires, lifetime) => {
      const request = { type: "request", id: "ack", binding: { ...binding }, ceilings: { maxFires: fires, maxLifetimeMs: lifetime } } as const;
      const next = reduceLoopAccess({ phase: "reviewed", epoch: 0 }, request); const snapshot = structuredClone(next.state);
      Object.defineProperty(request.binding, "judgeFence", { value: "poisoned" });
      Object.defineProperty(request.ceilings, "maxFires", { value: fires + 1 });
      expect(next.state).toEqual(snapshot);
      const effect = next.effects[0]; expect(effect?.type).toBe("confirm");
      if (effect?.type === "confirm") {
        expect(effect.binding).toEqual(binding); expect(effect.ceilings.maxFires).toBe(fires);
        Object.defineProperty(effect.binding, "judgeFence", { value: "effect-poisoned" });
        Object.defineProperty(effect.ceilings, "maxFires", { value: 0 }); expect(next.state).toEqual(snapshot);
      }
    }), propertyOptions());
  });
});
