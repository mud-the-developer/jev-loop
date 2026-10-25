import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { VERIFICATION_SUPPORTED } from "../completion-verifier.js";
import { parseLoopDurationMs } from "../loop-expiry.js";
import type { createLoopAccessRuntime } from "../runtime/loop-access-runtime.js";
import type { LoopEntry } from "../types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { textResult } from "./tool-result.js";

type Access = ReturnType<typeof createLoopAccessRuntime>;
export function registerLoopAccessTool(options: {
  pi: ExtensionAPI; getAccess: () => Access | undefined; getStore: () => { get(id: string): LoopEntry | undefined };
  recover: (entry: LoopEntry, ctx: ExtensionToolContext, signal?: AbortSignal) => Promise<string>; updateWidget: () => void;
}) {
  const closed = { additionalProperties: false };
  options.pi.registerTool({
    name: "LoopAccess", label: "LoopAccess", renderCall: renderToolCall("LoopAccess", args => String(toolArg(args, "action") ?? "status")), renderResult: renderToolResult,
    description: "Loop access: native Full/reviewed revoke/status/review_goal recovery. Finite session scope; args/status/intents are not grants. No workers or sandbox; hard limits never reset.",
    parameters: Type.Union([
      Type.Object({ action: Type.Literal("status") }, closed),
      Type.Object({ action: Type.Literal("reviewed") }, closed),
      Type.Object({ action: Type.Literal("full"), maxFires: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description: "Per-goal hard fire ceiling." }), expiresIn: Type.String({ minLength: 1, maxLength: 64, description: "Per-goal hard lifetime ceiling, e.g. 2h." }) }, closed),
      Type.Object({ action: Type.Literal("review_goal"), id: Type.String({ minLength: 1, maxLength: 128 }) }, closed),
    ]),
    async execute(_id, params, signal, _update, ctx) {
      const owner = options.getAccess();
      try {
        if (params.action === "status") return textResult(`Loop access (local, not remote health): ${JSON.stringify(owner?.status(ctx) ?? { phase: "reviewed", applicable: false, fullSupported: false })}`);
        if (params.action === "reviewed") {
          await owner?.revoke(); options.updateWidget();
          return textResult(owner ? "Loop access is Reviewed; this owner's Full work has drained. Existing Reviewed goals and JEV delegation authority are unchanged."
            : "Loop access is Reviewed; no live Full owner is available. Saved intent is not authority and no external quiescence is asserted.");
        }
        if (!VERIFICATION_SUPPORTED) return textResult("JEV verification currently requires POSIX process-group cleanup; no native activation or recovery was started.");
        if (params.action === "review_goal") {
          const entry = options.getStore().get(params.id); if (!entry) return textResult("Loop not found; no recovery was started.");
          const message = await options.recover(entry, ctx, signal); options.updateWidget(); return textResult(message);
        }
        if (!owner) return textResult("Loop Full native event/context support is unavailable; requested access is not authority. No fallback was started.");
        const accepted = await owner.enable(ctx, { maxFires: params.maxFires, maxLifetimeMs: parseLoopDurationMs(params.expiresIn) }, signal);
        options.updateWidget();
        return textResult(accepted ? "Loop Full active for this exact live session scope. Only new bounded recurring idle JEV goals with requestedAccess=full may use it; existing goals are not adopted."
          : "Loop Full was not enabled; no goal or execution was authorized. A fresh explicit request is required before another activation attempt.");
      } catch (error) {
        return textResult(error instanceof Error ? error.message : "Loop access action could not be confirmed; no retry or fallback was authorized.");
      }
    },
  });
}
