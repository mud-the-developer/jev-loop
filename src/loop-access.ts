import { type Static, Type } from "typebox";
import { Value } from "typebox/value";

const closed = { additionalProperties: false };
const id = Type.String({ minLength: 1, maxLength: 128, pattern: "^(?=.*\\S)[^\\x00-\\x1f\\x7f]+$" });
const positive = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
export const LoopAccessBindingSchema = Type.Object({
  sessionId: id, cwd: Type.String({ minLength: 1, maxLength: 4096, pattern: "^[^\\x00]+$" }),
  storeId: id, generation: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), judgeFence: id,
}, closed);
export const LoopAccessCeilingsSchema = Type.Object({ maxFires: positive, maxLifetimeMs: positive }, closed);
export type LoopAccessBinding = Readonly<Static<typeof LoopAccessBindingSchema>>;
export type LoopAccessCeilings = Readonly<Static<typeof LoopAccessCeilingsSchema>>;
type Bound = { readonly id: string; readonly epoch: number; readonly binding: LoopAccessBinding; readonly ceilings: LoopAccessCeilings };
export type LoopAccessState = { readonly phase: "reviewed"; readonly epoch: number }
  | { readonly phase: "closed"; readonly epoch: number }
  | (Bound & { readonly phase: "awaiting_ack" })
  | (Bound & { readonly phase: "full" })
  | { readonly phase: "revoking"; readonly epoch: number; readonly close: boolean };
export type LoopAccessEvent = { readonly type: "request"; readonly id: string; readonly binding: LoopAccessBinding; readonly ceilings: LoopAccessCeilings }
  | { readonly type: "reply"; readonly id: string; readonly epoch: number; readonly binding: LoopAccessBinding; readonly accepted: unknown }
  | { readonly type: "authorize"; readonly id: string; readonly epoch: number; readonly binding: LoopAccessBinding;
      readonly action: "create" | "verify" | "advice"; readonly budget: LoopAccessCeilings }
  | { readonly type: "revoke" | "close" }
  | { readonly type: "drained"; readonly epoch: number };
export type LoopAccessEffect = { readonly type: "confirm"; readonly id: string; readonly epoch: number; readonly binding: LoopAccessBinding; readonly ceilings: LoopAccessCeilings }
  | { readonly type: "cancel_and_drain"; readonly id: string; readonly epoch: number }
  | { readonly type: "authorized"; readonly id: string; readonly epoch: number; readonly source: "session_full_access" };

function sameBinding(a: LoopAccessBinding, b: LoopAccessBinding): boolean {
  return a.sessionId === b.sessionId && a.cwd === b.cwd && a.storeId === b.storeId
    && a.generation === b.generation && a.judgeFence === b.judgeFence;
}

// Native effect owners supply these events; no public tool or persisted grant is wired here.
export function reduceLoopAccess(state: LoopAccessState, event: LoopAccessEvent): { state: LoopAccessState; effects: readonly LoopAccessEffect[] } {
  const stay = () => ({ state, effects: [] });
  if (state.phase === "closed") return stay();
  const revoke = (close: boolean): { state: LoopAccessState; effects: readonly LoopAccessEffect[] } => {
    if (state.phase === "reviewed") return close ? { state: { phase: "closed", epoch: state.epoch + 1 }, effects: [] } : stay();
    if (state.phase === "revoking") return close && !state.close ? { state: { ...state, close: true }, effects: [] } : stay();
    return { state: { phase: "revoking", epoch: state.epoch + 1, close }, effects: [{ type: "cancel_and_drain", id: state.id, epoch: state.epoch + 1 }] };
  };
  if (event.type === "revoke" || event.type === "close") return revoke(event.type === "close");
  if (state.phase === "revoking") return event.type === "drained" && event.epoch === state.epoch
    ? { state: { phase: state.close ? "closed" : "reviewed", epoch: state.epoch }, effects: [] } : stay();
  if (event.type === "request" && state.phase === "reviewed") {
    if (!Value.Check(id, event.id) || !Value.Check(LoopAccessBindingSchema, event.binding) || !Value.Check(LoopAccessCeilingsSchema, event.ceilings)) return stay();
    const binding = { ...event.binding }, ceilings = { ...event.ceilings }, epoch = state.epoch + 1;
    return { state: { phase: "awaiting_ack", id: event.id, epoch, binding, ceilings },
      effects: [{ type: "confirm", id: event.id, epoch, binding: { ...binding }, ceilings: { ...ceilings } }] };
  }
  if ((state.phase !== "awaiting_ack" && state.phase !== "full") || !("id" in event)
    || event.id !== state.id || !("epoch" in event) || event.epoch !== state.epoch
    || !Value.Check(LoopAccessBindingSchema, event.binding)) return stay();
  if (!sameBinding(state.binding, event.binding)) return revoke(false);
  if (event.type === "reply" && state.phase === "awaiting_ack") return {
    state: event.accepted === true ? { ...state, phase: "full" } : { phase: "reviewed", epoch: state.epoch }, effects: [],
  };
  if (event.type === "authorize" && state.phase === "full" && ["create", "verify", "advice"].includes(event.action)
    && Value.Check(LoopAccessCeilingsSchema, event.budget)
    && event.budget.maxFires <= state.ceilings.maxFires && event.budget.maxLifetimeMs <= state.ceilings.maxLifetimeMs) {
    return { state, effects: [{ type: "authorized", id: state.id, epoch: state.epoch, source: "session_full_access" }] };
  }
  return stay();
}
