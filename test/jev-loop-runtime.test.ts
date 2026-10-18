import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { evidence, outcome, policy, recommendation } from "./helpers/jev-loop-fixture.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

const directories: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true }); });

// Real extension wiring and executable; JEV and native UI are controlled fixtures.
describe.skipIf(process.platform === "win32")("JEV dynamic-loop runtime wiring", () => {
  it("delivers the final capped iteration with completion guidance and accepts its verified completion", async () => {
    vi.stubEnv("PI_LOOP_SCOPE", "memory");
    const cwd = mkdtempSync(join(tmpdir(), "jev-loop-runtime-")); directories.push(cwd);
    const mock = createMockPi();
    extension(mock.pi);
    const confirm = vi.fn(async () => true);
    const executeTool = vi.fn(async () => outcome(recommendation()));
    const ctx = { ...createCtx({ cwd }), hasUI: true, tools: [{ name: "jev_decide" }], executeTool };
    Object.assign(ctx.ui, { confirm });
    await mock.emitExtension("session_start", {}, ctx);
    const call = (name: string, args: unknown) => mock.toolMap.get(name)!.execute!("runtime", args, undefined, undefined, ctx);
    try {
      await call("LoopCreate", {
        trigger: "idle", triggerType: "idle", prompt: "검증하고 완료해", maxFires: 1, expiresIn: "1h",
        completion: { ...policy, verification: { command: process.execPath, args: ["-e", "process.exit(0)"], description: "The fixed fixture check passes" } },
      });
      await vi.waitFor(() => expect(mock.sentMessages).toHaveLength(1));
      const wake = mock.sentMessages[0]!.message.content;
      expect(wake).toContain("completionEvidence");
      expect(wake).toContain("fire cap");
      expect(wake).toContain("no continue/resume");
      expect((await call("LoopList", {})).content[0].text).toContain("controller_limit");
      expect(executeTool).not.toHaveBeenCalled();
      const result = await call("LoopUpdate", { id: "1", status: "completed", completionEvidence: evidence });
      expect(result.content[0].text).toContain("completed and deleted");
      expect((await call("LoopList", {})).content[0].text).toContain("No loops");
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(executeTool).toHaveBeenCalledTimes(1);
    } finally { await mock.emitExtension("session_shutdown", {}, ctx); }
  });
});
