import { createEventBus, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { createLoopAccessRuntime } from "../src/runtime/loop-access-runtime.js";

const ceilings = { maxFires: 20, maxLifetimeMs: 3600000 };
const budget = { maxFires: 3, maxLifetimeMs: 600000 };
const info = { kind: "jev_capabilities", protocolVersion: 2, recipientInvalidationEvent: "jev:recipient:invalidated", available: true, recipient: "opaque-a", fencedDecision: true,
  delegationFencing: false, grantsAuthority: false, liveVerified: false } as const;
function result(value: Record<string, unknown> = info) { return { isError: false, result: { content: [{ type: "text", text: JSON.stringify(value) }], details: value } }; }
function fixture() {
  let store: object = {}, generation = 1, current = true, storage = "session", session = "session-a";
  const execute = vi.fn(async () => result()); const confirm = vi.fn(async (..._args: unknown[]) => true as unknown); const drain = vi.fn(async (_id: string) => {});
  const ctx = { cwd: "/workspace", hasUI: true, sessionManager: { getSessionId: () => session },
    tools: [{ name: "jev_capabilities" }, { name: "jev_decide" }], executeTool: execute } as unknown as ExtensionToolContext;
  const events = createEventBus();
  const owner = createLoopAccessRuntime({ events, getStore: () => store, getGeneration: () => generation, getStorageScope: () => storage,
    isContextCurrent: () => current, confirm, drain });
  return { ctx, execute, confirm, drain, owner, events, changeStore: () => { store = {}; }, changeGeneration: () => { generation++; },
    changeSession: () => { session = "session-b"; }, stale: () => { current = false; }, project: () => { storage = "project"; } };
}

// All acknowledgements here are controlled fixtures, not real Full activation evidence.
it("keeps an unexposed owner Reviewed until actual matching native acknowledgement", async () => {
  const h = fixture(); expect(h.owner.status(h.ctx)).toMatchObject({ phase: "reviewed", applicable: false });
  await expect(h.owner.authorize(h.ctx, "create", budget)).rejects.toThrow("Full"); expect(h.execute).not.toHaveBeenCalled();
  expect(await h.owner.enable(h.ctx, ceilings)).toBe(true); expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.execute).toHaveBeenCalledTimes(2);
  expect(h.owner.status(h.ctx)).toMatchObject({ phase: "full", applicable: true, ceilings });
  const packet = h.confirm.mock.calls[0]![1]; expect(packet).toContain('"judgeRecipient": "opaque-a"'); expect(packet).toContain("same-OS-user"); expect(packet).toContain("not a filesystem sandbox");
  expect(packet).toContain("inherit the process environment"); expect(packet).toContain("outside this directory");
  for (const action of ["create", "verify", "advice"] as const) {
    const lease = await h.owner.authorize(h.ctx, action, budget); expect(lease.current()).toBe(true); expect(lease.binding.judgeFence).toBe("opaque-a");
  }
  expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.drain).not.toHaveBeenCalled();
});

it("matches the live grant independently of a completed operation's caller signal and rejects old epochs", async () => {
  const h = fixture(); await h.owner.enable(h.ctx, ceilings); const caller = new AbortController();
  const lease = await h.owner.authorize(h.ctx, "verify", budget, caller.signal); caller.abort();
  expect(lease.current()).toBe(false); expect(h.owner.matches(h.ctx, lease)).toBe(true); const calls = h.execute.mock.calls.length;
  expect(h.owner.matches(h.ctx, { ...lease, epoch: lease.epoch + 1 })).toBe(false); expect(h.execute).toHaveBeenCalledTimes(calls);
  await h.owner.revoke(); await h.owner.enable(h.ctx, ceilings); expect(h.owner.matches(h.ctx, lease)).toBe(false);
});

it("invalidates the matching grant synchronously on the public deny-only event before owned draining", async () => {
  const h = fixture(); await h.owner.enable(h.ctx, ceilings); const lease = await h.owner.authorize(h.ctx, "verify", budget);
  try {
    h.events.emit("jev:recipient:invalidated", { kind: "jev_recipient_invalidated", protocolVersion: 2, recipient: "opaque-a" });
    expect(lease.signal.aborted).toBe(true); expect(lease.current()).toBe(false); expect(h.owner.status(h.ctx).phase).toBe("revoking");
  } finally { await h.owner.close(); }
});

it("ignores wrong-token, unknown-version, malformed and authority-shaped event packets", async () => {
  const h = fixture(); await h.owner.enable(h.ctx, ceilings); const lease = await h.owner.authorize(h.ctx, "verify", budget);
  const event = { kind: "jev_recipient_invalidated", protocolVersion: 2, recipient: "opaque-a" };
  for (const packet of [undefined, { ...event, recipient: "other" }, { ...event, protocolVersion: 1 }, { ...event, full: true }]) h.events.emit("jev:recipient:invalidated", packet);
  expect(lease.current()).toBe(true); expect(h.owner.status(h.ctx).phase).toBe("full"); expect(h.drain).not.toHaveBeenCalled(); await h.owner.close();
});

it("cancels a pending native acknowledgement if its bound recipient is invalidated", async () => {
  const h = fixture(); let entered!: () => void; let dialog!: AbortSignal; const ready = new Promise<void>(resolve => { entered = resolve; });
  h.confirm.mockImplementationOnce(async (_ctx, _packet, options) => {
    dialog = (options as { signal: AbortSignal }).signal; entered();
    return new Promise<boolean>(resolve => { dialog.addEventListener("abort", () => resolve(false), { once: true }); });
  });
  const pending = h.owner.enable(h.ctx, ceilings); await ready;
  try { h.events.emit("jev:recipient:invalidated", { kind: "jev_recipient_invalidated", protocolVersion: 2, recipient: "opaque-a" }); expect(dialog.aborted).toBe(true); }
  finally { await h.owner.close(); expect(await pending).toBe(false); }
});

it("keeps status read-only and its ceiling snapshot independent of the live grant", async () => {
  const h = fixture(); await h.owner.enable(h.ctx, ceilings); const calls = h.execute.mock.calls.length; const snapshot = h.owner.status(h.ctx);
  Object.defineProperty(snapshot.ceilings!, "maxFires", { value: 100000 });
  expect(h.owner.status(h.ctx).ceilings?.maxFires).toBe(20); expect(h.execute).toHaveBeenCalledTimes(calls); expect(h.drain).not.toHaveBeenCalled();
});

it.each([false, undefined, "yes", 1])("does not convert a non-true native result %s to authority", async reply => {
  const h = fixture(); h.confirm.mockResolvedValueOnce(reply); expect(await h.owner.enable(h.ctx, ceilings)).toBe(false);
  expect(h.owner.status(h.ctx)).toMatchObject({ phase: "reviewed", applicable: false }); await expect(h.owner.authorize(h.ctx, "verify", budget)).rejects.toThrow("Full");
});

it("checks storage, ceilings and context before query or UI", async () => {
  for (const failure of ["project", "stale", "ceilings"]) {
    const h = fixture(); if (failure === "project") h.project(); if (failure === "stale") h.stale();
    await expect(h.owner.enable(h.ctx, failure === "ceilings" ? { maxFires: 0, maxLifetimeMs: 1 } : ceilings)).rejects.toThrow();
    expect(h.execute).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled(); expect(h.drain).not.toHaveBeenCalled();
  }
});

it("cannot replace the recipient after the native packet was accepted", async () => {
  const h = fixture(); h.execute.mockResolvedValueOnce(result()).mockResolvedValueOnce(result({ ...info, recipient: "opaque-b" }));
  expect(await h.owner.enable(h.ctx, ceilings)).toBe(false); await h.owner.revoke();
  expect(h.owner.status(h.ctx).phase).toBe("reviewed"); expect(h.drain).toHaveBeenCalledTimes(1);
});

it("does not let concurrent activation requests start a second native review", async () => {
  const h = fixture(); let release!: (value: ReturnType<typeof result>) => void;
  h.execute.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const first = h.owner.enable(h.ctx, ceilings); await expect(h.owner.enable(h.ctx, ceilings)).rejects.toThrow("pending");
  expect(h.confirm).not.toHaveBeenCalled(); release(result()); expect(await first).toBe(true); expect(h.confirm).toHaveBeenCalledTimes(1);
});

it.each(["store", "generation", "session", "cwd", "context"])("revokes binding drift %s before authorizing another effect", async change => {
  const h = fixture(); await h.owner.enable(h.ctx, ceilings); const lease = await h.owner.authorize(h.ctx, "verify", budget);
  if (change === "store") h.changeStore(); if (change === "generation") h.changeGeneration(); if (change === "session") h.changeSession();
  if (change === "cwd") Object.defineProperty(h.ctx, "cwd", { value: "/other" }); if (change === "context") h.stale();
  expect(lease.current()).toBe(false); expect(h.owner.status(h.ctx).applicable).toBe(false);
  await expect(h.owner.authorize(h.ctx, "advice", budget)).rejects.toThrow(); await h.owner.revoke(); expect(h.drain).toHaveBeenCalledTimes(1);
});

it("revokes a changed peer instead of refreshing the accepted grant", async () => {
  const h = fixture(); await h.owner.enable(h.ctx, ceilings); h.execute.mockResolvedValueOnce(result({ ...info, recipient: "opaque-b" }));
  await expect(h.owner.authorize(h.ctx, "advice", budget)).rejects.toThrow(); await h.owner.revoke();
  expect(h.owner.status(h.ctx).phase).toBe("reviewed"); expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.drain).toHaveBeenCalledTimes(1);
});

it("does not query, widen or revoke a live grant for an oversized goal", async () => {
  const h = fixture(); await h.owner.enable(h.ctx, ceilings); const calls = h.execute.mock.calls.length;
  await expect(h.owner.authorize(h.ctx, "create", { ...budget, maxFires: 21 })).rejects.toThrow("ceiling");
  expect(h.execute).toHaveBeenCalledTimes(calls); expect(h.owner.status(h.ctx).phase).toBe("full"); expect(h.drain).not.toHaveBeenCalled();
});

it("keeps cancellation local to the initial dialog, not the accepted live grant", async () => {
  const h = fixture(); const caller = new AbortController(); await h.owner.enable(h.ctx, ceilings, caller.signal); caller.abort();
  expect((await h.owner.authorize(h.ctx, "verify", budget)).current()).toBe(true);
});

it("blocks reactivation while owned draining is unresolved and invalidates old leases immediately", async () => {
  const h = fixture(); await h.owner.enable(h.ctx, ceilings); const lease = await h.owner.authorize(h.ctx, "verify", budget);
  let release!: () => void; h.drain.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const revoking = h.owner.revoke(); expect(lease.signal.aborted).toBe(true); expect(lease.current()).toBe(false);
  expect(h.owner.status(h.ctx).phase).toBe("revoking"); await expect(h.owner.enable(h.ctx, ceilings)).rejects.toThrow();
  await Promise.resolve(); release(); await revoking; expect(h.owner.status(h.ctx).phase).toBe("reviewed");
});

it("keeps revoking until its own pending authorization query has actually settled", async () => {
  const h = fixture(); await h.owner.enable(h.ctx, ceilings); let release!: (value: ReturnType<typeof result>) => void;
  h.execute.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
  const authorizing = h.owner.authorize(h.ctx, "verify", budget); let settled = false; const revoking = h.owner.revoke().then(() => { settled = true; });
  try {
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(settled).toBe(false); expect(h.owner.status(h.ctx).phase).toBe("revoking");
  } finally { release(result()); await expect(authorizing).rejects.toThrow(); await revoking; }
  expect(h.owner.status(h.ctx).phase).toBe("reviewed");
});

it("does not claim Reviewed or retry automatically after uncertain cleanup", async () => {
  const h = fixture(); await h.owner.enable(h.ctx, ceilings); h.drain.mockRejectedValueOnce(new Error("PRIVATE_CLEANUP"));
  await expect(h.owner.revoke()).rejects.toThrow("unconfirmed"); expect(h.owner.status(h.ctx).phase).toBe("revoking");
  await expect(h.owner.enable(h.ctx, ceilings)).rejects.toThrow(); expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.drain).toHaveBeenCalledTimes(1);
});

it("closing a pending native review cancels and settles it without later authority", async () => {
  const h = fixture(); let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
  h.confirm.mockImplementationOnce(async (_ctx, _packet, options) => {
    entered(); return new Promise<boolean>(resolve => { (options as { signal: AbortSignal }).signal.addEventListener("abort", () => resolve(false), { once: true }); });
  });
  const enabling = h.owner.enable(h.ctx, ceilings); expect(await Promise.race([ready.then(() => true), enabling.then(() => false)])).toBe(true); const closing = h.owner.close();
  expect(await enabling).toBe(false); await closing; expect(h.owner.status(h.ctx).phase).toBe("closed");
  await expect(h.owner.enable(h.ctx, ceilings)).rejects.toThrow(); expect(h.confirm).toHaveBeenCalledTimes(1);
});
