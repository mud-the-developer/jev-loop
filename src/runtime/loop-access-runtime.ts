import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { inspectJevRecipient, RECIPIENT_INVALIDATED_EVENT, readJevInvalidatedRecipient } from "../jev-recipient.js";
import { type LoopAccessBinding, LoopAccessBindingSchema, type LoopAccessCeilings, LoopAccessCeilingsSchema, type LoopAccessEvent, type LoopAccessState, reduceLoopAccess } from "../loop-access.js";
import { confirmLoopFullAccess } from "../ui/completion-approval.js";

export interface LoopAccessRuntimeOptions {
  events: Pick<ExtensionAPI["events"], "on">;
  getStore: () => object;
  getGeneration: () => number;
  getStorageScope: () => string;
  isContextCurrent: (ctx: ExtensionContext) => boolean;
  drain: (id: string) => Promise<void>;
  confirm?: (ctx: ExtensionToolContext, packet: string, options: { signal: AbortSignal }) => Promise<unknown>;
}
export interface LoopAccessLease {
  readonly id: string; readonly epoch: number; readonly binding: LoopAccessBinding; readonly ceilings: LoopAccessCeilings;
  readonly signal: AbortSignal; current(): boolean;
}
export interface LoopAccessStatus { readonly phase: LoopAccessState["phase"] | "checking"; readonly applicable: boolean; readonly ceilings?: LoopAccessCeilings }
type Identity = { store: object; sessionId: string; cwd: string; generation: number; storeId: string };

// Keep activation private until goal admission and owned controller/CAS cleanup are wired.
export function createLoopAccessRuntime(options: LoopAccessRuntimeOptions) {
  let state: LoopAccessState = { phase: "reviewed", epoch: 0 };
  const stores = new WeakMap<object, string>();
  const authorizations = new Set<Promise<void>>();
  let pending: { controller: AbortController; done: Promise<void> } | undefined;
  let live: { controller: AbortController; identity: Identity; id: string; epoch: number } | undefined;
  let draining: Promise<void> | undefined;
  const confirm = options.confirm ?? confirmLoopFullAccess;
  const cleanupError = "Loop Full cleanup is unconfirmed; new activation remains blocked. No automatic retry.";
  const unsubscribe = options.events.on(RECIPIENT_INVALIDATED_EVENT, payload => {
    const recipient = readJevInvalidatedRecipient(payload);
    if (recipient && (state.phase === "full" || state.phase === "awaiting_ack") && state.binding.judgeFence === recipient) invalidate();
  });

  function identity(ctx: ExtensionContext): Identity | undefined {
    try {
      if (!ctx.hasUI || !options.isContextCurrent(ctx) || options.getStorageScope() !== "session") return;
      const store = options.getStore(); if (!store || typeof store !== "object") return;
      let storeId = stores.get(store); if (!storeId) { storeId = randomUUID(); stores.set(store, storeId); }
      const result = { store, storeId, sessionId: ctx.sessionManager.getSessionId(), cwd: ctx.cwd, generation: options.getGeneration() };
      if (!Value.Check(LoopAccessBindingSchema, { sessionId: result.sessionId, cwd: result.cwd, storeId, generation: result.generation, judgeFence: "pending" })) return;
      return result;
    } catch { return; }
  }
  function current(ctx: ExtensionContext, expected: Identity): boolean {
    const found = identity(ctx);
    return !!found && found.store === expected.store && found.generation === expected.generation
      && found.sessionId === expected.sessionId && found.cwd === expected.cwd;
  }
  function binding(source: Identity, judgeFence: string): LoopAccessBinding {
    return { sessionId: source.sessionId, cwd: source.cwd, storeId: source.storeId, generation: source.generation, judgeFence };
  }
  function transition(event: LoopAccessEvent) {
    const next = reduceLoopAccess(state, event); state = next.state;
    const effect = next.effects.find(value => value.type === "cancel_and_drain");
    if (effect?.type === "cancel_and_drain") {
      pending?.controller.abort(); live?.controller.abort(); const owned = [pending?.done, ...authorizations];
      const work = Promise.resolve().then(() => options.drain(effect.id)).then(async () => {
        await Promise.all(owned);
        state = reduceLoopAccess(state, { type: "drained", epoch: effect.epoch }).state;
        live = undefined;
      }).catch(() => { /* Keep revoking: failed cleanup cannot authorize new work. */ });
      draining = work;
      void work.then(() => { if (draining === work) draining = undefined; });
    }
    return next;
  }
  function invalidate(close = false) {
    pending?.controller.abort(); live?.controller.abort(); transition({ type: close ? "close" : "revoke" });
  }
  function active(ctx: ExtensionContext, id: string, epoch: number): boolean {
    return state.phase === "full" && state.id === id && state.epoch === epoch && !!live
      && !live.controller.signal.aborted && current(ctx, live.identity);
  }
  async function settle(close = false): Promise<void> {
    invalidate(close); if (close) unsubscribe(); const pendingDone = pending?.done, work = draining;
    await Promise.all([pendingDone, work]);
    if (state.phase === "revoking") throw new Error(cleanupError);
  }

  return {
    matches(ctx: ExtensionContext, lease: Pick<LoopAccessLease, "id" | "epoch">): boolean { return active(ctx, lease.id, lease.epoch); },
    status(ctx: ExtensionContext): LoopAccessStatus {
      return { phase: pending && state.phase === "reviewed" ? "checking" : state.phase,
        applicable: state.phase === "full" && active(ctx, state.id, state.epoch),
        ...(state.phase === "full" ? { ceilings: { ...state.ceilings } } : {}) };
    },
    async enable(ctx: ExtensionToolContext, ceilings: LoopAccessCeilings, caller?: AbortSignal): Promise<boolean> {
      if (pending || draining || state.phase !== "reviewed") throw new Error("Loop Full activation is pending, active, revoking or closed; no new review.");
      if (!Value.Check(LoopAccessCeilingsSchema, ceilings)) throw new Error("Loop Full requires valid finite goal ceilings.");
      const captured = identity(ctx); if (!captured) throw new Error("Loop Full requires current UI/session storage context.");
      const controller = new AbortController(); let finish!: () => void;
      const operation = { controller, done: new Promise<void>(resolve => { finish = resolve; }) }; pending = operation;
      const signal = AbortSignal.any([controller.signal, ...[caller, ctx.signal].filter((s): s is AbortSignal => !!s)]);
      const scope = { signal, current: () => current(ctx, captured) };
      try {
        const info = await inspectJevRecipient(ctx, scope); const id = randomUUID(); const selected = binding(captured, info.recipient!);
        const requested = transition({ type: "request", id, binding: selected, ceilings });
        const review = requested.effects.find(effect => effect.type === "confirm");
        if (review?.type !== "confirm") throw new Error("Loop Full native review is unavailable.");
        const packet = [
          "Enable Loop Full Access for this live session and working directory only?",
          JSON.stringify({ session: captured.sessionId, cwd: captured.cwd, judgeRecipient: review.binding.judgeFence, recipientLiveVerified: false,
            actions: ["create bounded JEV goals", "fixed verification", "fenced public advice"], perGoalCeilings: review.ceilings }, null, 2),
          "Each new goal captures its trusted admission time once before budget advice. No extension resets its start, hard deadline or total fire cap; existing Reviewed goals are not migrated.",
          "This is same-OS-user execution, not a filesystem sandbox. Host tool/permission gates remain. No JEV delegation grant, secret disclosure, global installation or unapproved release/destructive operation is included.",
          "New goals may select different fixed verifier programs and arguments. They inherit the process environment and may have effects outside this directory under OS-user permissions. Enable this execution class only for authorized work; keep Reviewed for per-goal command review. This is not a tool/file sandbox.",
          "Only concise non-sensitive English policy/evidence is sent to JEV; never original goals, source, paths, argv, logs, history or credentials. JEV advice and capability metadata are not proof or permission.",
          "Access is memory-only; revocation or context change blocks new work and drains owned operations. Restart never restores it. Cancellation is not rollback; uncertain cleanup stays blocked.",
        ].join("\n\n");
        const accepted = await confirm(ctx, packet, { signal });
        if (signal.aborted || !current(ctx, captured)) throw new Error("Loop Full review context changed.");
        if (accepted !== true) { transition({ type: "reply", id, epoch: review.epoch, binding: selected, accepted }); return false; }
        const after = await inspectJevRecipient(ctx, scope);
        const replied = transition({ type: "reply", id, epoch: review.epoch, binding: binding(captured, after.recipient!), accepted });
        if (replied.state.phase !== "full") return false;
        // Dialog cancellation must not become the accepted grant's lifetime signal.
        live = { controller: new AbortController(), identity: captured, id, epoch: review.epoch };
        return true;
      } catch {
        const interrupted = signal.aborted; invalidate();
        if (interrupted) return false;
        throw new Error("Loop Full activation could not be confirmed in the current scope; inspect support before an explicit new request.");
      } finally {
        controller.abort(); if (pending === operation) pending = undefined; finish();
      }
    },
    async authorize(ctx: ExtensionToolContext, action: "create" | "verify" | "advice", budget: LoopAccessCeilings, caller?: AbortSignal): Promise<LoopAccessLease> {
      const captured = state;
      if (captured.phase !== "full" || !live) throw new Error("Loop Full access is not active; native activation is required.");
      if (!active(ctx, captured.id, captured.epoch)) { invalidate(); throw new Error("Loop Full context changed; owned draining has started."); }
      const selected = transition({ type: "authorize", id: captured.id, epoch: captured.epoch, binding: binding(live.identity, captured.binding.judgeFence), action, budget });
      if (!selected.effects.some(effect => effect.type === "authorized")) throw new Error("Goal is outside the live Loop Full ceiling or supported action.");
      const grantIdentity = live.identity;
      const signal = AbortSignal.any([live.controller.signal, ...[caller, ctx.signal].filter((s): s is AbortSignal => !!s)]);
      const scope = { signal, current: () => active(ctx, captured.id, captured.epoch) };
      let finish!: () => void; const operation = new Promise<void>(resolve => { finish = resolve; }); authorizations.add(operation);
      try {
        const peer = await inspectJevRecipient(ctx, scope);
        if (peer.recipient !== captured.binding.judgeFence) { transition({ type: "authorize", id: captured.id, epoch: captured.epoch, binding: { ...captured.binding, judgeFence: peer.recipient! }, action, budget }); throw new Error(); }
        if (!active(ctx, captured.id, captured.epoch) || signal.aborted) throw new Error();
        return { id: captured.id, epoch: captured.epoch, binding: { ...captured.binding }, ceilings: { ...captured.ceilings }, signal,
          current: () => !signal.aborted && active(ctx, captured.id, captured.epoch) };
      } catch {
        if (!signal.aborted || !current(ctx, grantIdentity)) invalidate();
        throw new Error("Loop Full request is no longer authorized; inspect the current scope before an explicit new request.");
      } finally { authorizations.delete(operation); finish(); }
    },
    revoke: () => settle(),
    close: () => settle(true),
  };
}
