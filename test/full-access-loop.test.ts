import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, fixture, outcome, policy, recommendation, text } from "./helpers/jev-loop-fixture.js";

const sessions: ReturnType<typeof fixture>[] = [], roots: string[] = [];
afterEach(async () => { for (const h of sessions.splice(0)) await h.shutdown(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.useRealTimers(); });
const info = { kind: "jev_capabilities", protocolVersion: 2, recipientInvalidationEvent: "jev:recipient:invalidated", available: true,
  recipient: "opaque-full-fixture", fencedDecision: true, delegationFencing: false, grantsAuthority: false, liveVerified: false };
function session(path?: string) {
  if (!path) { const root = mkdtempSync(join(tmpdir(), "jev-full-goals-")); roots.push(root); path = join(root, "loops.json"); }
  const h = fixture(path); sessions.push(h); const select = vi.fn(async () => "Yes — approve"); Object.assign(h.ctx.ui, { select });
  Object.defineProperty(h.ctx, "tools", { value: [{ name: "jev_capabilities" }, { name: "jev_decide" }] });
  h.executeTool.mockImplementation(async (name: string) => outcome(name === "jev_capabilities" ? info : recommendation()));
  return { h, select, path };
}
async function access(h: ReturnType<typeof fixture>, params: Record<string, unknown>) {
  expect(h.toolMap.has("LoopAccess")).toBe(true); return h.call("LoopAccess", params);
}
const full = (h: ReturnType<typeof fixture>) => access(h, { action: "full", maxFires: 20, expiresIn: "2h" });

// These file-backed tool/UI callbacks are controlled acceptance fixtures, not genuine operator consent.
describe.skipIf(process.platform === "win32")("explicit new-goal Full admission expectations", () => {
  it("keeps native mode schemas static and rejects missing, unbounded or authority-shaped fields", async () => {
    const { h } = session(); const mode = h.toolMap.get("LoopAccess")!, create = h.toolMap.get("LoopCreate")!;
    const schema = mode.parameters, createSchema = create.parameters;
    const theme = { fg: (_token: string, value: string) => value, bold: (value: string) => value };
    expect(mode.renderCall!({ action: "status" }, theme as any, {} as any).render(48).join("\n")).toContain("status");
    for (const value of [{ action: "status" }, { action: "reviewed" }, { action: "full", maxFires: 20, expiresIn: "2h" }, { action: "review_goal", id: "1" }]) expect(Value.Check(schema, value)).toBe(true);
    for (const value of [{ action: "full" }, { action: "full", maxFires: Infinity, expiresIn: "2h" }, { action: "status", full: true }, { action: "restore", id: "saved" }]) expect(Value.Check(schema, value)).toBe(false);
    await full(h); await access(h, { action: "reviewed" }); expect(mode.parameters).toBe(schema); expect(create.parameters).toBe(createSchema);
  });

  it("starts a new Reviewed owner after session shutdown/start instead of restoring a saved Full grant", async () => {
    const { h, select } = session(); await full(h); await h.create({ requestedAccess: "full" }); const expiry = h.store.get("1")!.expiresAt;
    await h.shutdown(); await h.startSession(); expect(h.runtime.getAccessStatus(h.ctx)?.phase).toBe("reviewed");
    expect(text(await h.create({ requestedAccess: "full" }))).toMatch(/not active|native activation/i);
    expect(text(await h.complete())).toMatch(/explicit.*Reviewed|recover/i); expect(h.store.get("1")!.expiresAt).toBe(expiry);
    expect(select).toHaveBeenCalledTimes(1); expect(h.confirm).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
  });

  it("does not execute or recover an expired Full goal or reset its hard window", async () => {
    vi.useFakeTimers(); const { h } = session(); await full(h); await h.create({ requestedAccess: "full", expiresIn: "1s" });
    const original = structuredClone(h.store.get("1")!); await vi.advanceTimersByTimeAsync(1001);
    expect(text(await h.complete())).toMatch(/expired|held|cancelled/i);
    expect(text(await access(h, { action: "review_goal", id: "1" }))).toMatch(/expired|exhausted/i);
    expect(h.store.get("1")?.expiresAt).toBe(original.expiresAt); expect(h.exec).not.toHaveBeenCalled(); expect(h.confirm).not.toHaveBeenCalled();
  });

  it("preserves missing requestedAccess as Reviewed with the original one-goal native review", async () => {
    const { h, select } = session(); expect(text(await h.create())).toContain("Loop #1 created");
    expect(h.confirm).toHaveBeenCalledTimes(1); expect(select).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
  });

  it("does not turn a Full argument into authority or surprise Reviewed fallback", async () => {
    const { h, select } = session(); const result = await h.create({ requestedAccess: "full" });
    expect(text(result)).toMatch(/Full.*(active|activation|native)/i); expect(h.store.list()).toEqual([]);
    expect(h.confirm).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled(); expect(h.activate).not.toHaveBeenCalled();
  });

  it("rejects Full on non-completion or non-idle work without creating it", async () => {
    const { h } = session();
    for (const extra of [{ completion: undefined }, { trigger: "5m", triggerType: "cron" }]) {
      expect(text(await h.create({ requestedAccess: "full", ...extra }))).toMatch(/Full|recurring idle/i);
      expect(h.store.list()).toEqual([]);
    }
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.activate).not.toHaveBeenCalled();
  });

  it("admits two new bounded goals under one matching native mode activation", async () => {
    const { h, select } = session(); await full(h);
    for (let index = 1; index <= 2; index++) expect(text(await h.create({ requestedAccess: "full" }))).toContain(`Loop #${index} created`);
    expect(h.store.list().map(entry => entry.requestedAccess)).toEqual(["full", "full"]);
    expect(select).toHaveBeenCalledTimes(1); expect(h.confirm).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled();
  });

  it.each([{ requestedAccess: "reviewed" }, { maxFires: 100 }, { expiresIn: "1d" }])("rejects intent/hard-envelope replacement without progress or metadata effects: %j", async patch => {
    const { h } = session(); await full(h); await h.create({ requestedAccess: "full" }); const before = structuredClone(h.store.get("1")); const calls = h.executeTool.mock.calls.length;
    expect(text(await h.call("LoopUpdate", { id: "1", status: "continue", ...patch }))).toMatch(/immutable/i);
    expect(h.store.get("1")).toEqual(before); expect(h.executeTool).toHaveBeenCalledTimes(calls);
  });

  it("denies an oversized goal without widening or ending the native mode grant", async () => {
    const { h, select } = session(); await full(h);
    expect(text(await h.create({ requestedAccess: "full", maxFires: 21 }))).toMatch(/ceiling/i);
    expect(text(await h.create({ requestedAccess: "full", expiresIn: "3h" }))).toMatch(/ceiling/i);
    expect(h.store.list()).toEqual([]); expect(select).toHaveBeenCalledTimes(1); expect(h.confirm).not.toHaveBeenCalled();
    expect(text(await access(h, { action: "status" }))).toMatch(/full/i);
  });

  it("does not adopt explicit or default Reviewed goals after Full was enabled", async () => {
    const { h, select } = session(); await full(h); await h.create({ requestedAccess: "reviewed" }); await h.create();
    expect(h.confirm).toHaveBeenCalledTimes(2); expect(select).toHaveBeenCalledTimes(1);
  });

  it("revokes and pauses only owned Full goals while a Reviewed completion remains usable", async () => {
    const { h } = session(); await full(h); await h.create({ requestedAccess: "full" }); await h.create();
    const reviewed = h.store.get("2")!; await access(h, { action: "reviewed" });
    expect(h.store.get("1")?.status).toBe("paused"); expect(h.store.get("2")).toEqual(reviewed);
    expect(text(await h.complete({ id: "2" }))).toContain("completed and deleted"); expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.executeTool.mock.calls.filter(call => call[0] === "jev_decide").every(call => !(call[1] as Record<string, unknown>).expectedRecipient)).toBe(true);
  });

  it("fences verification/advice at the bound recipient without inventing a Reviewed receipt", async () => {
    const { h, select } = session(); await full(h); await h.create({ requestedAccess: "full" });
    expect(text(await h.complete())).toContain("completed and deleted"); expect(h.exec).toHaveBeenCalledTimes(1);
    const decisions = h.executeTool.mock.calls.filter(call => call[0] === "jev_decide"); expect(decisions).toHaveLength(1);
    expect(decisions[0]?.[1]).toMatchObject({ expectedRecipient: info.recipient }); expect(select).toHaveBeenCalledTimes(1); expect(h.confirm).not.toHaveBeenCalled();
  });

  it("pauses owned goals after public recipient invalidation without authorizing a provider switch", async () => {
    const { h } = session(); await full(h); await h.create({ requestedAccess: "full" });
    h.pi.events.emit("jev:recipient:invalidated", { kind: "jev_recipient_invalidated", protocolVersion: 2, recipient: info.recipient });
    await access(h, { action: "reviewed" }); expect(h.store.get("1")?.status).toBe("paused"); expect(h.exec).not.toHaveBeenCalled();
  });

  it.each(["reviewed", "full"] as const)("invalidates %s verification immediately and waits for owned physical settlement", async kind => {
    const { h } = session(); await full(h); await h.create({ requestedAccess: kind });
    const ready = deferred<void>(), finished = deferred<{ code: number; killed: boolean; stdout: string; stderr: string }>(); let verifierSignal!: AbortSignal;
    h.exec.mockImplementationOnce(async (_command, _args, options) => { verifierSignal = options.signal; ready.resolve(undefined); return finished.promise; });
    const pending = h.complete(); await ready.promise; let settled = false;
    const stopping = (kind === "full" ? access(h, { action: "reviewed" }) : h.shutdown()).then(() => { settled = true; });
    try {
      expect(verifierSignal.aborted).toBe(true);
      for (let index = 0; index < 8; index++) await Promise.resolve(); expect(settled).toBe(false);
    } finally { finished.resolve({ code: 143, killed: true, stdout: "", stderr: "" }); await pending; await stopping; }
    expect(h.store.get("1")).toBeDefined(); if (kind === "full") expect(h.store.get("1")?.status).toBe("paused");
    expect(h.executeTool.mock.calls.filter(call => call[0] === "jev_decide")).toHaveLength(0);
  });

  it("keeps revoking until the owned nested advice callback settles, even when it ignores cancellation", async () => {
    const { h } = session(); await full(h); await h.create({ requestedAccess: "full" });
    const ready = deferred<void>(), response = deferred<ReturnType<typeof outcome>>();
    h.executeTool.mockImplementation(async name => { if (name === "jev_capabilities") return outcome(info); ready.resolve(undefined); return response.promise; });
    const pending = h.complete(); await ready.promise; let settled = false;
    const stopping = access(h, { action: "reviewed" }).then(() => { settled = true; });
    try { for (let index = 0; index < 20; index++) await Promise.resolve(); expect(settled).toBe(false); expect(h.runtime.getAccessStatus(h.ctx)?.phase).toBe("revoking"); }
    finally { response.resolve(outcome(recommendation())); await pending; await stopping; }
    expect(h.store.get("1")?.status).toBe("paused");
  });

  it("holds explicit recovery until canceled callbacks settle and then keeps its Reviewed source separate", async () => {
    const { h } = session(); await full(h); await h.create({ requestedAccess: "full" });
    const ready = deferred<void>(), response = deferred<ReturnType<typeof outcome>>(), caller = new AbortController();
    h.executeTool.mockImplementation(async name => { if (name === "jev_capabilities") return outcome(info); ready.resolve(undefined); return response.promise; });
    const pending = h.complete({}, caller.signal); await ready.promise; caller.abort(); await pending;
    try {
      expect(text(await access(h, { action: "review_goal", id: "1" }))).toMatch(/callbacks.*not settled|held/i); expect(h.confirm).not.toHaveBeenCalled();
    } finally { response.resolve(outcome(recommendation())); for (let index = 0; index < 20; index++) await Promise.resolve(); }
    expect(text(await access(h, { action: "review_goal", id: "1" }))).toMatch(/recovery approved/i);
    expect(h.confirm).toHaveBeenCalledTimes(1); await access(h, { action: "reviewed" }); expect(h.store.get("1")?.status).toBe("active");
  });

  it("retains a created Full goal paused when revocation races its post-write admission", async () => {
    const { h } = session(); await full(h); const original = h.store.create.bind(h.store); let stopping: Promise<unknown> | undefined;
    vi.spyOn(h.store, "create").mockImplementation((...args) => { const entry = original(...args); stopping = access(h, { action: "reviewed" }); return entry; });
    const result = await h.create({ requestedAccess: "full" }); await stopping;
    expect(text(result)).toMatch(/created loop.*held|held.*retained/i); expect(h.store.get("1")?.status).toBe("paused");
    expect(h.store.get("1")?.fireCount).toBe(0); expect(h.activate).not.toHaveBeenCalled(); expect(h.trigger.add).not.toHaveBeenCalled();
  });

  it("repairs a failed fixed verifier inside the same Full envelope without a repeated native review", async () => {
    const { h, select } = session(); await full(h); await h.create({ requestedAccess: "full" }); const before = structuredClone(h.store.get("1")!);
    h.exec.mockResolvedValueOnce({ code: 7, killed: false, stdout: "PRIVATE", stderr: "PRIVATE" });
    expect(text(await h.complete({ completionEvidence: "The authorized fixed check exposed a local failure." }))).toMatch(/unmet|exited with code 7/);
    expect(h.executeTool.mock.calls.filter(call => call[0] === "jev_decide")).toHaveLength(0);
    expect(h.store.get("1")).toMatchObject({ maxFires: before.maxFires, expiresAt: before.expiresAt, completionId: before.completionId });
    expect(text(await h.complete({ completionEvidence: "The scoped repair now passes the unchanged fixed check." }))).toContain("completed and deleted");
    expect(h.confirm).not.toHaveBeenCalled(); expect(select).toHaveBeenCalledTimes(1);
  });

  it("captures Full hard origin before capability and initial budget awaits, never caller timestamps", async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00Z")); const { h } = session(); await full(h); const admittedAt = Date.now();
    h.executeTool.mockImplementation(async (name, packet) => {
      await vi.advanceTimersByTimeAsync(10000); if (name === "jev_capabilities") return outcome(info);
      const choices = packet.options as Array<{ id: string; title: string; description: string }>, selected = choices[0]!;
      return outcome({ status: "recommended", advisoryOnly: true, option: selected, reply: { choice: selected.id, confidence: 0.8,
        probabilities: Object.fromEntries(choices.map(choice => [choice.id, choice.id === selected.id ? 0.8 : 0.2])), model: "fixture", usage: { inputTokens: 1, outputTokens: 1 } } });
    });
    const result = await h.create({ requestedAccess: "full", maxFires: 20, startedAt: 123, completion: { ...policy, budgetRange: { minFires: 3, minExpiresIn: "15m" } } });
    expect(text(result)).toContain("created"); expect(Date.now()).toBeGreaterThan(admittedAt);
    expect(h.store.get("1")?.expiresAt).toBe(admittedAt + 3600000); expect(h.store.get("1")?.adaptiveBudget?.startedAt).toBe(admittedAt);
    expect(h.confirm).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });

  it("requires explicit Reviewed recovery after restart, without adopting a saved Full intent or resetting expiry", async () => {
    const first = session(); await full(first.h); await first.h.create({ requestedAccess: "full" }); const expiry = first.h.store.get("1")!.expiresAt;
    await access(first.h, { action: "reviewed" }); await first.h.shutdown(); const next = session(first.path);
    expect(text(await next.h.complete())).toMatch(/explicit.*Reviewed|recover/i); expect(next.h.confirm).not.toHaveBeenCalled(); expect(next.h.exec).not.toHaveBeenCalled();
    await full(next.h); expect(text(await next.h.complete())).toMatch(/explicit.*Reviewed|recover/i);
    await access(next.h, { action: "review_goal", id: "1" }); expect(next.h.confirm).toHaveBeenCalledTimes(1);
    expect(text(await next.h.call("LoopUpdate", { id: "1", status: "continue" }))).toMatch(/resumed|updated/);
    expect(next.h.store.get("1")!.expiresAt).toBe(expiry); expect(text(await next.h.complete())).toContain("completed and deleted");
  });
});
