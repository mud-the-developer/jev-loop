import { describe, expect, it } from "vitest";
import { LoopStore } from "../src/store.js";
import { deferred, fixture, outcome, recommendation } from "./helpers/jev-loop-fixture.js";

describe.skipIf(process.platform === "win32")("read-only local review observations", () => {
  it("reports verifier/advice only while the matching local effect is owned, then clears it", async () => {
    const h = fixture(); await h.create();
    const verifier = deferred<any>(); const advice = deferred<any>(); h.exec.mockReturnValueOnce(verifier.promise); h.executeTool.mockReturnValueOnce(advice.promise);
    const review = h.complete();
    try {
      await Promise.resolve(); await Promise.resolve();
      const entry = h.store.get("1")!; const before = structuredClone(entry);
      expect(h.runtime.getReviewPhase(entry)).toBe("verification"); expect(h.runtime.getReviewPhase(entry)).toBe("verification");
      expect(h.store.get("1")).toEqual(before); expect(h.exec).toHaveBeenCalledTimes(1); expect(h.executeTool).not.toHaveBeenCalled();
      verifier.resolve({ code: 0, killed: false, stdout: "", stderr: "" });
      for (let i = 0; i < 8; i++) await Promise.resolve();
      expect(h.runtime.getReviewPhase(h.store.get("1")!)).toBe("advice");
      advice.resolve(outcome(recommendation())); await review;
      expect(h.runtime.getReviewPhase(before)).toBeUndefined();
    } finally { verifier.resolve({ code: 0, killed: true }); advice.resolve(outcome(recommendation())); await review; await h.shutdown(); }
  });
  it("does not reconstruct execution from a persisted reservation or a replacement store", async () => {
    const h = fixture(); await h.create(); const entry = h.store.get("1")!;
    const reserved = h.store.reserveCompletionReview("1", JSON.stringify(entry), { id: "not-local", expiresAt: Date.now() + 60000 })!;
    const before = structuredClone(reserved); expect(h.runtime.getReviewPhase(reserved)).toBeUndefined(); expect(h.store.get("1")).toEqual(before);
    h.replaceStore(new LoopStore()); expect(h.runtime.getReviewPhase(reserved)).toBeUndefined(); await h.shutdown();
  });
});
