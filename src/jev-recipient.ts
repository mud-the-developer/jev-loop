import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { completionPacket } from "./jev-completion.js";

export type JevToolOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;
export type JevRecipientScope = { readonly signal: AbortSignal; readonly current: () => boolean };
const closed = { additionalProperties: false };
const recipient = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const common = { kind: Type.Literal("jev_capabilities"), protocolVersion: Type.Literal(1), fencedDecision: Type.Literal(true),
  delegationFencing: Type.Literal(false), grantsAuthority: Type.Literal(false), liveVerified: Type.Literal(false) };
const capabilitySchema = Type.Union([
  Type.Object({ ...common, available: Type.Literal(true), recipient }, closed),
  Type.Object({ ...common, available: Type.Literal(false), recipient: Type.Null() }, closed),
]);
export type JevCapabilities = Static<typeof capabilitySchema>;
const capabilityError = "JEV capability metadata is unsupported or inconsistent; inspect current native provider support before proceeding.";
const requestError = "JEV recipient request failed; no automatic retry or fallback. Inspect the provider before explicitly reauthorizing.";

// Metadata and transport helpers only; this module does not activate or issue access.
export function readJevCapabilities(outcome: JevToolOutcome): JevCapabilities {
  try {
    const info: unknown = outcome?.result?.details;
    if (outcome?.isError !== false || !Value.Check(capabilitySchema, info)) throw new Error();
    const content = outcome.result.content;
    if (content.length !== 1 || content[0]?.type !== "text" || content[0].text.length > 1024) throw new Error();
    if (JSON.stringify(JSON.parse(content[0].text)) !== JSON.stringify(info)) throw new Error();
    return structuredClone(info);
  } catch { throw new Error(capabilityError); }
}
function check(scope: JevRecipientScope): void {
  let current = false;
  try { current = scope.current(); } catch { /* Unknown context is not a live scope. */ }
  if (scope.signal.aborted || !current) throw new Error("JEV recipient scope was cancelled or changed; no further effects are authorized.");
}
function supports(ctx: ExtensionToolContext, name: string): boolean {
  return typeof ctx.executeTool === "function" && ctx.tools?.some(tool => tool.name === name) === true;
}
async function call(ctx: ExtensionToolContext, name: string, args: Record<string, unknown>, scope: JevRecipientScope, error: string): Promise<JevToolOutcome> {
  check(scope); if (!supports(ctx, name)) throw new Error(error);
  let result: JevToolOutcome;
  try { result = await ctx.executeTool(name, args, { signal: scope.signal }); }
  catch { check(scope); throw new Error(error); }
  check(scope); if (result.isError !== false) throw new Error(error);
  return result;
}
export async function inspectJevRecipient(ctx: ExtensionToolContext, scope: JevRecipientScope): Promise<JevCapabilities> {
  check(scope); if (!supports(ctx, "jev_decide")) throw new Error(capabilityError);
  const info = readJevCapabilities(await call(ctx, "jev_capabilities", {}, scope, capabilityError)); check(scope);
  if (!info.available) throw new Error("JEV capability support is unavailable; do not activate Full or retry through another provider.");
  return info;
}
export async function decideAtJevRecipient(ctx: ExtensionToolContext, packet: ReturnType<typeof completionPacket>, expectedRecipient: string, scope: JevRecipientScope): Promise<JevToolOutcome> {
  check(scope); if (!Value.Check(recipient, expectedRecipient)) throw new Error("JEV recipient metadata is invalid; no decision was requested.");
  return call(ctx, "jev_decide", { ...structuredClone(packet), expectedRecipient }, scope, requestError);
}
