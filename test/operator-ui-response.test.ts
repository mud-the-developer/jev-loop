import { expect, it } from "vitest";
import { readOperatorUIResponse } from "./helpers/operator-ui-response.js";

const select = { id: "fresh-request", method: "select", options: ["No — cancel", "Yes — approve"] } as const;
const confirm = { id: "fresh-confirm", method: "confirm" } as const;
it("relays only the current explicit native offered value or literal confirmation", () => {
  expect(readOperatorUIResponse({ type: "extension_ui_response", id: select.id, value: "Yes — approve" }, select)).toBe("Yes — approve");
  expect(readOperatorUIResponse({ type: "extension_ui_response", id: select.id, value: "No — cancel" }, select)).toBe("No — cancel");
  for (const accepted of [false, true]) expect(readOperatorUIResponse({ type: "extension_ui_response", id: confirm.id, confirmed: accepted }, confirm)).toBe(accepted);
});
it("preserves cancellation without turning it into a positive reply", () => {
  expect(readOperatorUIResponse({ type: "extension_ui_response", id: select.id, cancelled: true }, select)).toBeUndefined();
  expect(readOperatorUIResponse({ type: "extension_ui_response", id: confirm.id, cancelled: true }, confirm)).toBeUndefined();
});
it.each([
  { type: "extension_ui_response", id: "old-request", value: "Yes — approve" },
  { type: "extension_ui_response", id: select.id, value: "not-offered" },
  { type: "extension_ui_response", id: select.id, confirmed: true },
  { type: "extension_ui_response", id: select.id, value: "Yes — approve", full: true },
  { type: "extension_ui_response", id: select.id, cancelled: true, value: "Yes — approve" },
  { type: "extension_ui_response", id: select.id, cancelled: false },
  { type: "authorize", id: select.id, value: "Yes — approve" },
  "PRIVATE_RAW_REPLY", undefined,
])("rejects stale, contradictory, authority-shaped or malformed operator frames %s", packet => {
  expect(() => readOperatorUIResponse(packet, select)).toThrow(/^Invalid current native UI response/);
});
it("does not coerce a confirmation string, reuse a selection frame or echo private failures", () => {
  for (const packet of [
    { type: "extension_ui_response", id: confirm.id, confirmed: "true" },
    { type: "extension_ui_response", id: confirm.id, value: "Yes — approve" },
    Object.defineProperty({ type: "extension_ui_response", id: confirm.id }, "confirmed", { get() { throw new Error("PRIVATE_GETTER"); } }),
  ]) expect(() => readOperatorUIResponse(packet, confirm)).toThrow(/^Invalid current native UI response/);
});
