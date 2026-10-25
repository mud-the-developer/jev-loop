import { describe, expect, it } from "vitest";
import { type LoopAccessBinding, type LoopAccessEvent, type LoopAccessState, reduceLoopAccess } from "../src/loop-access.js";

const binding: LoopAccessBinding = { sessionId: "session-a", cwd: "/workspace", storeId: "store-a", generation: 1, judgeFence: "judge-a" };
const ceilings = { maxFires: 20, maxLifetimeMs: 3600000 };
const reviewed = (): LoopAccessState => ({ phase: "reviewed", epoch: 0 });
const pending = (): LoopAccessState => ({ phase: "awaiting_ack", epoch: 1, id: "ack-a", binding: structuredClone(binding), ceilings: { ...ceilings } });
const full = (): LoopAccessState => ({ ...pending(), phase: "full" } as LoopAccessState);
const request = { type: "request", id: "ack-a", binding, ceilings } as const;
const authorize = { type: "authorize", id: "ack-a", epoch: 1, binding, action: "create", budget: { maxFires: 10, maxLifetimeMs: 1800000 } } as const;

// These controlled reducer events are feature tests, never native consent or a live grant.
describe("Loop access authority state expectations", () => {
  it("keeps Reviewed unprivileged and does not derive a grant from a full request flag", () => {
    const state = reviewed(); expect(reduceLoopAccess(state, authorize)).toEqual({ state, effects: [] });
  });

  it("requests one bounded native acknowledgement without becoming Full", () => {
    const state = reviewed(); const before = structuredClone(state); const event = structuredClone(request);
    const next = reduceLoopAccess(state, event);
    expect(next.state).toEqual(pending()); expect(next.effects).toEqual([{ type: "confirm", id: "ack-a", epoch: 1, binding, ceilings }]);
    expect(state).toEqual(before); Object.defineProperty(event.binding, "judgeFence", { value: "changed" }); Object.defineProperty(event.ceilings, "maxFires", { value: 1 });
    expect(next.state).toEqual(pending()); expect(next.effects[0]).toMatchObject({ binding, ceilings });
  });

  it("accepts only the matching literal native acknowledgement", () => {
    expect(reduceLoopAccess(pending(), { type: "reply", id: "ack-a", epoch: 1, binding, accepted: true })).toEqual({ state: full(), effects: [] });
  });

  it.each([false, "yes", 1, undefined, null])("does not turn non-true acknowledgement %s into authority", accepted => {
    expect(reduceLoopAccess(pending(), { type: "reply", id: "ack-a", epoch: 1, binding, accepted })).toEqual({ state: { phase: "reviewed", epoch: 1 }, effects: [] });
  });

  it.each([{ id: "stale", epoch: 1 }, { id: "ack-a", epoch: 0 }])("ignores stale native acknowledgement %s", identity => {
    const state = pending(); expect(reduceLoopAccess(state, { type: "reply", ...identity, binding, accepted: true })).toEqual({ state, effects: [] });
  });

  it.each(["create", "verify", "advice"] as const)("authorizes bounded %s only from the matching live scope", action => {
    const state = full(); expect(reduceLoopAccess(state, { ...authorize, action })).toEqual({ state, effects: [{ type: "authorized", id: "ack-a", epoch: 1, source: "session_full_access" }] });
  });

  it.each([
    { maxFires: 0, maxLifetimeMs: 1 }, { maxFires: 1.5, maxLifetimeMs: 1 }, { maxFires: 21, maxLifetimeMs: 1 },
    { maxFires: Number.NaN, maxLifetimeMs: 1 }, { maxFires: Infinity, maxLifetimeMs: 1 },
    { maxFires: 1, maxLifetimeMs: 3600001 }, { maxFires: 1, maxLifetimeMs: -1 },
  ])("rejects invalid or out-of-envelope goal budget without altering live scope: %s", budget => {
    const state = full(); const before = structuredClone(state); expect(reduceLoopAccess(state, { ...authorize, budget })).toEqual({ state, effects: [] }); expect(state).toEqual(before);
  });

  it.each([
    { sessionId: "session-b" }, { cwd: "/other" }, { storeId: "store-b" }, { generation: 2 }, { judgeFence: "judge-b" },
  ])("revokes on actual owner binding drift %s before another effect", drift => {
    const state = full(); const next = reduceLoopAccess(state, { ...authorize, binding: { ...binding, ...drift } });
    expect(next).toEqual({ state: { phase: "revoking", epoch: 2, close: false }, effects: [{ type: "cancel_and_drain", id: "ack-a", epoch: 2 }] });
    expect(reduceLoopAccess(pending(), { type: "reply", id: "ack-a", epoch: 1, binding: { ...binding, ...drift }, accepted: true })).toEqual(next);
  });

  it.each([
    { ...request, id: "" }, { ...request, id: " " }, { ...request, id: "x".repeat(129) },
    { ...request, binding: { ...binding, cwd: "" } }, { ...request, binding: { ...binding, cwd: "\u0000" } },
    { ...request, binding: { ...binding, cwd: "/".repeat(4097) } }, { ...request, binding: { ...binding, generation: -1 } },
    { ...request, ceilings: { maxFires: Number.MAX_SAFE_INTEGER + 1, maxLifetimeMs: 1 } },
    { ...request, binding: { ...binding, extra: "UNTRUSTED_EXTRA" } }, { ...request, ceilings: { maxFires: 0, maxLifetimeMs: 1 } },
  ])("rejects malformed activation data before acknowledgement", event => {
    const state = reviewed(); expect(reduceLoopAccess(state, event)).toEqual({ state, effects: [] });
  });

  it("accepts the finite safe-integer ceiling without rounding it or creating extra authority", () => {
    const budget = { maxFires: Number.MAX_SAFE_INTEGER, maxLifetimeMs: Number.MAX_SAFE_INTEGER };
    const state: LoopAccessState = { ...full(), phase: "full", id: "ack-a", binding, epoch: 1, ceilings: budget };
    expect(reduceLoopAccess(state, { ...authorize, budget }).effects).toHaveLength(1);
    expect(reduceLoopAccess(state, { ...authorize, budget: { ...budget, maxFires: Number.MAX_SAFE_INTEGER + 1 } })).toEqual({ state, effects: [] });
  });

  it("denies unknown actions and malformed binding data without new effects", () => {
    for (const event of [{ ...authorize, action: "install" }, { ...authorize, binding: { ...binding, judgeFence: "" } }]) {
      const state = full(); expect(reduceLoopAccess(state, event as LoopAccessEvent)).toEqual({ state, effects: [] });
    }
  });

  it("uses a new epoch for revocation and requires its own drain acknowledgement", () => {
    const next = reduceLoopAccess(full(), { type: "revoke" });
    expect(next).toEqual({ state: { phase: "revoking", epoch: 2, close: false }, effects: [{ type: "cancel_and_drain", id: "ack-a", epoch: 2 }] });
    for (const event of [request, authorize, { type: "drained", epoch: 1 }] as LoopAccessEvent[]) expect(reduceLoopAccess(next.state, event)).toEqual({ state: next.state, effects: [] });
    expect(reduceLoopAccess(next.state, { type: "drained", epoch: 2 })).toEqual({ state: { phase: "reviewed", epoch: 2 }, effects: [] });
  });

  it("does not let an old drain close a newer revocation", () => {
    const state: LoopAccessState = { phase: "revoking", epoch: 4, close: true };
    expect(reduceLoopAccess(state, { type: "drained", epoch: 2 })).toEqual({ state, effects: [] });
    expect(reduceLoopAccess(state, { type: "drained", epoch: 4 })).toEqual({ state: { phase: "closed", epoch: 4 }, effects: [] });
  });

  it("closes only after draining active ownership and never reopens closed state", () => {
    const active = reduceLoopAccess(full(), { type: "close" });
    expect(active.state).toEqual({ phase: "revoking", epoch: 2, close: true });
    expect(reduceLoopAccess({ phase: "revoking", epoch: 2, close: false }, { type: "close" })).toEqual({ state: active.state, effects: [] });
    const closed = reduceLoopAccess(active.state, { type: "drained", epoch: 2 });
    expect(closed.state).toEqual({ phase: "closed", epoch: 2 }); expect(reduceLoopAccess(closed.state, request)).toEqual(closed);
    expect(reduceLoopAccess(reviewed(), { type: "close" })).toEqual({ state: { phase: "closed", epoch: 1 }, effects: [] });
  });
});
