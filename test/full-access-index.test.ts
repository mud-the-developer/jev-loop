import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { resolveLoopStorePath } from "../src/runtime/scope.js";
import { LoopStore } from "../src/store.js";
import { policy } from "./helpers/jev-loop-fixture.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

// Actual root/session/idle callbacks with file-backed state; no consent or provider success is fabricated.
describe("native root retained access intent", () => {
  it.each(["reviewed", "full"] as const)("keeps %s recovery semantics before consuming a scheduled idle fire", async requested => {
    const root = mkdtempSync(join(tmpdir(), "jev-full-root-")), original = process.cwd();
    vi.useFakeTimers(); vi.stubEnv("PI_LOOP_SCOPE", "session"); vi.stubEnv("PI_LOOP", ""); process.chdir(root);
    const h = createMockPi(), ctx = createCtx({ cwd: root, sessionId: "retained-full-intent" });
    try {
      const path = resolveLoopStorePath({ loopScope: "session", cwd: root }, ctx.sessionManager.getSessionId())!;
      const seed = new LoopStore(path); seed.create({ type: "dynamic" }, "Retained bounded work", { recurring: true, maxFires: 3,
        completion: policy, completionCwd: root, expiresIn: "1h", ...(requested === "full" ? { requestedAccess: "full" as const } : {}) });
      extension(h.pi); await vi.advanceTimersByTimeAsync(6100);
      await h.emitExtension("turn_start", null, ctx); await h.emitExtension("agent_end", null, ctx); await vi.advanceTimersByTimeAsync(0);
      const retained = new LoopStore(path).get("1")!;
      expect(retained.fireCount).toBe(requested === "full" ? 0 : 1);
      expect(retained.status).toBe(requested === "full" ? "paused" : "active");
      expect(h.sentMessages).toHaveLength(requested === "full" ? 0 : 1);
      if (requested === "full") expect(retained.completion).toEqual(policy);
    } finally {
      await h.emitExtension("session_shutdown", null, ctx); process.chdir(original); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true });
    }
  });
});
