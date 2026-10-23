import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { completionCandidates } from "../src/jev-completion.js";
import type { CompletionReviewReceipt } from "../src/runtime/jev-loop-runtime.js";
import { deferred, evidence, fixture, outcome, policy, recommendation, text } from "./helpers/jev-loop-fixture.js";

const sessions: ReturnType<typeof fixture>[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(h => h.shutdown())); vi.useRealTimers(); });
function setup() { const h = fixture(); sessions.push(h); return h; }
function receipt(result: Awaited<ReturnType<ReturnType<typeof fixture>["complete"]>>) { return (result.details as { completionReview?: CompletionReviewReceipt } | undefined)?.completionReview; }

// Feature expectations: preserve bounded observations, never new authority or raw payloads.
describe.skipIf(process.platform === "win32")("completion assessment receipts", () => {
  it("keeps actual verification and normalized overall advice in the registered tool result", async () => {
    const h = setup(); await h.create(); const result = await h.complete();
    const packet = h.executeTool.mock.calls[0]![1];
    expect(text(result)).toContain("completed and deleted");
    expect(receipt(result)).toEqual({
      verifier: { coverage: policy.verification.description, code: 0, killed: false },
      assessments: [{ criterion: "all", contextLength: packet.context.length,
        contextSha256: createHash("sha256").update(packet.context).digest("hex"), status: "recommended",
        reply: { choice: "met", confidence: 0.8, probabilities: { met: 0.8, unmet: 0.2 }, model: "fixture" } }],
    });
    const recorded = JSON.stringify(receipt(result));
    for (const privateValue of [h.ctx.cwd, policy.verification.command, ...policy.verification.args, "PRIVATE RAW OUTPUT", "PRIVATE ERROR", evidence, "원래 사용자 요청"]) expect(recorded).not.toContain(privateValue);
    expect(h.executeTool).toHaveBeenCalledTimes(1); expect(h.store.get("1")).toBeUndefined();
  });

  it("retains all bounded focused observations without changing candidates or completion rules", async () => {
    const h = setup(); const criteria = Array.from({ length: 8 }, (_, i) => `Required observed criterion ${i + 1}`);
    await h.create({ completion: { ...policy, criteria } }); h.executeTool.mockResolvedValue(outcome(recommendation("unmet")));
    const result = await h.complete(); const observed = receipt(result);
    expect(text(result)).toContain("Unmet criterion 8");
    expect(observed?.assessments.map((item: any) => item.criterion)).toEqual(["all", 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(observed?.assessments.every((item: any) => item.status === "recommended" && item.reply.choice === "unmet")).toBe(true);
    expect(new Set(observed?.assessments.map((item: any) => item.contextSha256)).size).toBe(1);
    for (const call of h.executeTool.mock.calls) expect(call[1].options).toEqual(completionCandidates);
    expect(h.executeTool).toHaveBeenCalledTimes(9); expect(h.store.get("1")?.status).toBe("active");
    expect(h.store.get("1")?.dynamic?.iteration).toBe(1); expect(h.store.get("1")?.maxFires).toBe(3);
  });

  it("records failed verification without inferring an advisory observation", async () => {
    const h = setup(); await h.create(); h.exec.mockResolvedValueOnce({ code: 7, killed: false, stdout: "PRIVATE", stderr: "PRIVATE" });
    const result = await h.complete();
    expect(receipt(result)).toEqual({ verifier: { coverage: policy.verification.description, code: 7, killed: false }, assessments: [] });
    expect(text(result)).toContain("code 7"); expect(h.executeTool).not.toHaveBeenCalled();
    expect(h.store.get("1")?.dynamic?.iteration).toBe(1);
  });

  it("preserves prior observations when a focused request is unavailable, without retry", async () => {
    const h = setup(); await h.create();
    h.executeTool.mockResolvedValueOnce(outcome(recommendation("unmet"))).mockRejectedValueOnce(new Error("PRIVATE PROVIDER FAILURE"));
    const result = await h.complete(); const observed = receipt(result);
    expect(text(result)).toContain("criterion diagnosis was unavailable");
    expect(observed?.verifier?.code).toBe(0);
    expect(observed?.assessments.map((item: any) => [item.criterion, item.status])).toEqual([["all", "recommended"], [1, "unobserved"]]);
    expect(observed?.assessments[1].reply).toBeUndefined(); expect(JSON.stringify(observed)).not.toContain("PRIVATE PROVIDER FAILURE");
    expect(h.executeTool).toHaveBeenCalledTimes(2); expect(h.store.get("1")?.dynamic?.iteration).toBe(0);
  });

  it("keeps the exact user handoff with observations but no invented recommendation", async () => {
    const h = setup(); await h.create();
    const askUser = { question: "Which supported outcome should be inspected?", context: "Independent review is required.",
      options: [{ title: "Inspect", description: "Inspect the observed result." }, { title: "Stop", description: "Do not execute more work." }], allowMultiple: false, allowFreeform: true };
    h.executeTool.mockResolvedValueOnce(outcome({ status: "needs_user", advisoryOnly: true, askUser }));
    const result = await h.complete();
    expect(result.details).toMatchObject({ askUser });
    expect(receipt(result)?.assessments[0]).toMatchObject({ criterion: "all", status: "needs_user" });
    expect(receipt(result)?.assessments[0].reply).toBeUndefined();
    expect(h.executeTool).toHaveBeenCalledTimes(1); expect(h.store.get("1")?.dynamic?.iteration).toBe(0);
  });

  it("does not infer execution when a stale context is rejected before verification", async () => {
    const h = setup(); await h.create(); Object.assign(h.ctx, { cwd: "/another/private/workspace" });
    const result = await h.complete();
    expect(receipt(result)).toEqual({ assessments: [] });
    expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled(); expect(h.store.get("1")).toBeDefined();
  });

  it("does not record a late canceled response as accepted advice or mutate the returned receipt", async () => {
    const h = setup(); await h.create(); const pending = deferred<ReturnType<typeof outcome>>();
    h.executeTool.mockReturnValueOnce(pending.promise); const abort = new AbortController(); const reviewing = h.complete({}, abort.signal);
    await vi.waitFor(() => expect(h.executeTool).toHaveBeenCalledTimes(1)); abort.abort();
    const result = await reviewing; const observed = receipt(result); const snapshot = structuredClone(observed);
    expect(observed?.assessments[0].status).toBe("unobserved"); expect(observed?.assessments[0].reply).toBeUndefined();
    pending.resolve(outcome(recommendation())); await Promise.resolve(); await Promise.resolve();
    expect(receipt(result)).toEqual(snapshot); expect(h.store.get("1")).toBeDefined();
  });
});
