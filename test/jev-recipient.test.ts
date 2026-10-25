import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { completionPacket } from "../src/jev-completion.js";
import { decideAtJevRecipient, inspectJevRecipient, type JevToolOutcome, readJevCapabilities } from "../src/jev-recipient.js";
import { policy } from "./helpers/jev-loop-fixture.js";

const capabilities = { kind: "jev_capabilities", protocolVersion: 1, available: true, recipient: "opaque-current",
  fencedDecision: true, delegationFencing: false, grantsAuthority: false, liveVerified: false } as const;
function outcome(details: unknown): JevToolOutcome {
  const copy = structuredClone(details);
  return { isError: false, result: { content: [{ type: "text", text: JSON.stringify(copy) }], details: copy } } as JevToolOutcome;
}
function fixture() {
  const controller = new AbortController(); let current = true;
  const execute = vi.fn(async (_name: string, _args: unknown, _options: unknown) => outcome(capabilities));
  const ctx = { executeTool: execute, tools: [{ name: "jev_capabilities" }, { name: "jev_decide" }] } as unknown as ExtensionToolContext;
  return { ctx, execute, controller, scope: { signal: controller.signal, current: () => current }, stale: () => { current = false; } };
}

it("reads bounded matching metadata as information without manufacturing a grant", () => {
  const original = outcome(capabilities); const read = readJevCapabilities(original);
  expect(read).toEqual(capabilities); expect(read.grantsAuthority).toBe(false); expect(read.liveVerified).toBe(false);
  Object.defineProperty(original.result.details!, "recipient", { value: "poisoned" }); expect(read.recipient).toBe("opaque-current");
  expect(readJevCapabilities(outcome({ ...capabilities, available: false, recipient: null })).available).toBe(false);
});

it.each([
  { ...capabilities, protocolVersion: 2 }, { ...capabilities, grantsAuthority: true }, { ...capabilities, liveVerified: true },
  { ...capabilities, delegationFencing: true }, { ...capabilities, recipient: "" }, { ...capabilities, recipient: " " },
  { ...capabilities, available: true, recipient: null }, { ...capabilities, available: false, recipient: "opaque" },
  { ...capabilities, endpoint: "PRIVATE_UNEXPECTED_METADATA" },
])("fails closed on unsupported, contradictory or extra capability data %s", info => {
  expect(() => readJevCapabilities(outcome(info))).toThrow("capability");
});

it("rejects error, conflicting or oversized metadata without echoing raw values", () => {
  const error = outcome(capabilities); Object.defineProperty(error, "isError", { value: true }); expect(() => readJevCapabilities(error)).toThrow("capability");
  const conflict = outcome(capabilities); conflict.result.content = [{ type: "text", text: JSON.stringify({ ...capabilities, recipient: "other" }) }];
  expect(() => readJevCapabilities(conflict)).toThrow("capability");
  const long = outcome(capabilities); long.result.content = [{ type: "text", text: "PRIVATE_".repeat(200) }];
  expect(() => readJevCapabilities(long)).toThrow(/^JEV capability metadata/);
});

it("queries the public capability tool once with no private input and the scoped signal", async () => {
  const h = fixture(); expect(await inspectJevRecipient(h.ctx, h.scope)).toEqual(capabilities);
  expect(h.execute).toHaveBeenCalledExactlyOnceWith("jev_capabilities", {}, { signal: h.controller.signal });
});

it("does not query a missing protocol or a cancelled/stale scope", async () => {
  const missing = fixture(); Object.defineProperty(missing.ctx, "tools", { value: [{ name: "jev_decide" }] });
  await expect(inspectJevRecipient(missing.ctx, missing.scope)).rejects.toThrow("capability"); expect(missing.execute).not.toHaveBeenCalled();
  for (const stop of ["abort", "stale"]) {
    const h = fixture(); if (stop === "abort") h.controller.abort(); else h.stale();
    await expect(inspectJevRecipient(h.ctx, h.scope)).rejects.toThrow("scope"); expect(h.execute).not.toHaveBeenCalled();
  }
});

it("denies an unknown context without exposing its error or starting a request", async () => {
  const h = fixture(); const scope = { ...h.scope, current: () => { throw new Error("PRIVATE_CONTEXT"); } };
  await expect(inspectJevRecipient(h.ctx, scope)).rejects.toThrow(/^JEV recipient scope/); expect(h.execute).not.toHaveBeenCalled();
});

it("does not turn unconfigured metadata or a late query result into access", async () => {
  const unavailable = fixture(); unavailable.execute.mockResolvedValueOnce(outcome({ ...capabilities, available: false, recipient: null }));
  await expect(inspectJevRecipient(unavailable.ctx, unavailable.scope)).rejects.toThrow("unavailable"); expect(unavailable.execute).toHaveBeenCalledTimes(1);
  const stale = fixture(); stale.execute.mockImplementationOnce(async () => { stale.stale(); return outcome(capabilities); });
  await expect(inspectJevRecipient(stale.ctx, stale.scope)).rejects.toThrow("scope"); expect(stale.execute).toHaveBeenCalledTimes(1);
});

it("adds only the bound recipient to a decision packet without refreshing or modifying it", async () => {
  const h = fixture(); const packet = completionPacket(policy, "The fixed fixture passed.", 0); const before = structuredClone(packet);
  const result = outcome({ untouched: true }); h.execute.mockResolvedValueOnce(result);
  expect(await decideAtJevRecipient(h.ctx, packet, "opaque-current", h.scope)).toBe(result);
  expect(h.execute).toHaveBeenCalledExactlyOnceWith("jev_decide", { ...before, expectedRecipient: "opaque-current" }, { signal: h.controller.signal }); expect(packet).toEqual(before);
});

it("snapshots nested packet fields before the asynchronous tool boundary", async () => {
  const h = fixture(); const packet = completionPacket(policy, "The immutable fixture packet passed.", 0); const before = structuredClone(packet);
  h.execute.mockImplementationOnce(async () => { packet.options[0]!.description = "caller mutation"; return outcome({ untouched: true }); });
  await decideAtJevRecipient(h.ctx, packet, "opaque-current", h.scope);
  expect(h.execute.mock.calls[0]![1]).toEqual({ ...before, expectedRecipient: "opaque-current" });
});

it("does not downgrade a mandatory human handoff to an ordinary decision", async () => {
  const h = fixture(); const packet = { ...completionPacket(policy, "A mandatory choice remains human-owned.", 0), requiresHuman: true };
  await decideAtJevRecipient(h.ctx, packet, "opaque-current", h.scope);
  expect(h.execute).toHaveBeenCalledExactlyOnceWith("jev_decide", { ...packet, expectedRecipient: "opaque-current" }, { signal: h.controller.signal });
});

it("cannot refresh a failed recipient, retry a failed tool or expose provider errors", async () => {
  const h = fixture(); h.execute.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_VALUE"));
  const packet = completionPacket(policy, "The fixture needs evaluation.", 0);
  await expect(decideAtJevRecipient(h.ctx, packet, "opaque-current", h.scope)).rejects.toThrow(/^JEV recipient request failed/);
  expect(h.execute).toHaveBeenCalledTimes(1); expect(h.execute.mock.calls[0]![0]).toBe("jev_decide");
});

it("rejects invalid recipients before a decision and stale results after it", async () => {
  const packet = completionPacket(policy, "The fixture passed.", 0);
  const invalid = fixture(); await expect(decideAtJevRecipient(invalid.ctx, packet, "", invalid.scope)).rejects.toThrow("recipient"); expect(invalid.execute).not.toHaveBeenCalled();
  const stale = fixture(); stale.execute.mockImplementationOnce(async () => { stale.stale(); return outcome({ ignored: true }); });
  await expect(decideAtJevRecipient(stale.ctx, packet, "opaque-current", stale.scope)).rejects.toThrow("scope"); expect(stale.execute).toHaveBeenCalledTimes(1);
});
