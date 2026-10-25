import { createEventBus, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import fc from "fast-check";
import { expect, it } from "vitest";
import { createLoopAccessRuntime, type LoopAccessLease } from "../../src/runtime/loop-access-runtime.js";
import { propertyOptions } from "./config.js";

it("keeps native acknowledgement, drift, closed-state and old-lease fencing through generated owned-effect traces", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.constantFrom("enable", "decline", "authorize", "drift", "notify", "revoke", "close"), { maxLength: 40 }), async actions => {
    let store: object = {}, accepted = true, model: "reviewed" | "full" | "closed" = "reviewed", valid = false;
    const leases: LoopAccessLease[] = []; const ceilings = { maxFires: 10, maxLifetimeMs: 100000 };
    let revision = 0;
    let info = { kind: "jev_capabilities", protocolVersion: 2, recipientInvalidationEvent: "jev:recipient:invalidated", available: true, recipient: "opaque-a", fencedDecision: true,
      delegationFencing: false, grantsAuthority: false, liveVerified: false };
    const ctx = { hasUI: true, cwd: "/workspace", sessionManager: { getSessionId: () => "session-a" }, tools: [{ name: "jev_capabilities" }, { name: "jev_decide" }],
      executeTool: async () => ({ isError: false, result: { details: info, content: [{ type: "text", text: JSON.stringify(info) }] } }) } as unknown as ExtensionToolContext;
    const events = createEventBus();
    const owner = createLoopAccessRuntime({ events, getStore: () => store, getGeneration: () => 1, getStorageScope: () => "session", isContextCurrent: () => true,
      confirm: async () => accepted, drain: async () => {} });
    for (const action of actions) {
      if (action === "enable" || action === "decline") {
        accepted = action === "enable";
        if (model === "reviewed") {
          expect(await owner.enable(ctx, ceilings)).toBe(accepted); if (accepted) { model = "full"; valid = true; }
        } else await expect(owner.enable(ctx, ceilings)).rejects.toThrow();
      } else if (action === "authorize") {
        const request = owner.authorize(ctx, "verify", { maxFires: 1, maxLifetimeMs: 1000 });
        if (model === "full" && valid) { const lease = await request; expect(lease.current()).toBe(true); leases.push(lease); }
        else {
          await expect(request).rejects.toThrow();
          if (model === "full") { await owner.revoke(); model = "reviewed"; valid = false; }
        }
      } else if (action === "drift") { store = {}; valid = false; }
      else if (action === "notify") {
        const recipient = info.recipient; info = { ...info, recipient: `opaque-${++revision}` };
        events.emit("jev:recipient:invalidated", { kind: "jev_recipient_invalidated", protocolVersion: 2, recipient });
        if (model === "full") { await owner.revoke(); model = "reviewed"; valid = false; }
      }
      else if (action === "close") { await owner.close(); model = "closed"; valid = false; }
      else { await owner.revoke(); if (model !== "closed") model = "reviewed"; valid = false; }
      expect(owner.status(ctx)).toMatchObject({ phase: model, applicable: model === "full" && valid });
      for (const lease of leases) {
        if (model !== "full" || !valid || lease.signal.aborted) expect(lease.current()).toBe(false);
      }
    }
    await owner.close(); for (const lease of leases) expect(lease.current()).toBe(false);
  }), propertyOptions());
});
