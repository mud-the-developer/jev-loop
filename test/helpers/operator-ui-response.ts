export type OperatorUIRequest = { readonly id: string; readonly method: "confirm" }
  | { readonly id: string; readonly method: "select"; readonly options: readonly string[] };

// Framing only: a parsed reply is not an access grant or a substitute for native consent.
export function readOperatorUIResponse(value: unknown, request: OperatorUIRequest): boolean | string | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const frame = value as Record<string, unknown>, keys = Object.keys(frame);
    if (frame.type !== "extension_ui_response" || frame.id !== request.id || keys.length !== 3) throw new Error();
    if (frame.cancelled === true && keys.includes("cancelled")) return undefined;
    if (request.method === "select" && keys.includes("value")) {
      const selected = frame.value;
      if (typeof selected === "string" && request.options.includes(selected)) return selected;
    }
    if (request.method === "confirm" && keys.includes("confirmed")) {
      const confirmed = frame.confirmed; if (typeof confirmed === "boolean") return confirmed;
    }
    throw new Error();
  } catch { throw new Error("Invalid current native UI response; no authority, coercion or replay is permitted."); }
}
