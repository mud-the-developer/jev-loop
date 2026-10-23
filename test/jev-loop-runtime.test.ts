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

  it("re-wakes the same adaptive goal after an in-envelope renewal with one native grant", async () => {
    vi.stubEnv("PI_LOOP_SCOPE", "memory");
    const cwd = mkdtempSync(join(tmpdir(), "jev-loop-adaptive-wake-")); directories.push(cwd);
    const mock = createMockPi(); extension(mock.pi); let idle = true; let extend = false;
    const confirm = vi.fn(async () => true);
    const executeTool = vi.fn(async (_name: string, packet: any) => {
      if (!packet.options[0].id.startsWith("budget_")) return outcome(recommendation());
      const selected = extend ? packet.options.at(-1) : packet.options[0];
      return outcome({ status: "recommended", advisoryOnly: true, option: selected, reply: { choice: selected.id, confidence: 0.8,
        probabilities: Object.fromEntries(packet.options.map((value: any) => [value.id, value.id === selected.id ? 0.8 : 0.2])), model: "adaptive-runtime-fixture", usage: { inputTokens: 1, outputTokens: 1 } } });
    });
    const ctx = { ...createCtx({ cwd }), isIdle: () => idle, hasUI: true, tools: [{ name: "jev_decide" }], executeTool };
    Object.assign(ctx.ui, { confirm }); await mock.emitExtension("session_start", {}, ctx);
    const call = (name: string, args: unknown) => mock.toolMap.get(name)!.execute!("adaptive-runtime", args, undefined, undefined, ctx);
    try {
      await call("LoopCreate", { trigger: "idle", triggerType: "idle", prompt: "Private adaptive fixture", maxFires: 3, expiresIn: "1h",
        completion: { ...policy, budgetRange: { minFires: 1, minExpiresIn: "30m" }, verification: { command: process.execPath, args: ["-e", "process.exit(0)"], description: "The fixed fixture check passes" } } });
      await vi.waitFor(() => expect(mock.sentMessages).toHaveLength(1));
      idle = false; await mock.emitExtension("agent_start", {}, ctx); extend = true;
      await call("LoopUpdate", { id: "1", status: "continue", budgetEvidence: "Another approved observation is required.", state: "Collecting that observation." });
      expect(mock.sentMessages).toHaveLength(1); expect(executeTool).toHaveBeenCalledTimes(8);
      expect((await call("LoopList", {})).content[0].text).toMatch(/operating:1\/3.*hard:3 total/);
      idle = true; await mock.emitExtension("agent_end", {}, ctx);
      await vi.waitFor(() => expect(mock.sentMessages).toHaveLength(2));
      expect(mock.sentMessages[1]!.message.content).toContain("Adaptive operating allocation");
      expect(mock.sentMessages[1]!.message.content).toContain("hard envelope 3 total");
      const completed = await call("LoopUpdate", { id: "1", status: "completed", completionEvidence: evidence });
      expect(completed.content[0].text).toContain("completed and deleted");
      expect(executeTool).toHaveBeenCalledTimes(9); expect(confirm).toHaveBeenCalledTimes(1);
    } finally { await mock.emitExtension("session_shutdown", {}, ctx); }
  });

  it("re-wakes the diagnosed goal only when idle without treating the wake as new evidence", async () => {
    vi.stubEnv("PI_LOOP_SCOPE", "memory");
    const cwd = mkdtempSync(join(tmpdir(), "jev-loop-rework-wake-")); directories.push(cwd);
    const mock = createMockPi(); extension(mock.pi); let idle = true;
    const confirm = vi.fn(async () => true);
    const executeTool = vi.fn(async () => outcome(recommendation()));
    executeTool.mockResolvedValueOnce(outcome(recommendation("unmet")))
      .mockResolvedValueOnce(outcome(recommendation("met"))).mockResolvedValueOnce(outcome(recommendation("unmet")));
    const ctx = { ...createCtx({ cwd }), isIdle: () => idle, hasUI: true, tools: [{ name: "jev_decide" }], executeTool };
    Object.assign(ctx.ui, { confirm }); await mock.emitExtension("session_start", {}, ctx);
    const call = (name: string, args: unknown) => mock.toolMap.get(name)!.execute!("rework-runtime", args, undefined, undefined, ctx);
    try {
      await call("LoopCreate", {
        trigger: "idle", triggerType: "idle", prompt: "Continue the same bounded fixture goal", maxFires: 3, expiresIn: "1h",
        completion: { ...policy, verification: { command: process.execPath, args: ["-e", "process.exit(0)"], description: "The fixed fixture check passes" } },
      });
      await vi.waitFor(() => expect(mock.sentMessages).toHaveLength(1));
      idle = false; await mock.emitExtension("agent_start", {}, ctx);
      const result = await call("LoopUpdate", { id: "1", status: "completed", completionEvidence: evidence });
      expect(result.content[0].text).toMatch(/criterion 2/i);
      expect(executeTool).toHaveBeenCalledTimes(3); expect(mock.sentMessages).toHaveLength(1);
      idle = true; await mock.emitExtension("agent_end", {}, ctx);
      await vi.waitFor(() => expect(mock.sentMessages).toHaveLength(2));
      const wake = mock.sentMessages[1]!.message.content;
      expect(wake).toContain("Iteration: 1"); expect(wake).toMatch(/criterion 2/i);
      expect(wake).toMatch(/repair evidence now|repair.*evidence now/i);
      const unchanged = await call("LoopUpdate", { id: "1", status: "completed", completionEvidence: evidence });
      expect(unchanged.content[0].text).toMatch(/additional evidence|unchanged/i);
      expect(executeTool).toHaveBeenCalledTimes(3); expect(confirm).toHaveBeenCalledTimes(1);
      const completed = await call("LoopUpdate", { id: "1", status: "completed", completionEvidence: "A new runtime observation now supports the missing criterion." });
      expect(completed.content[0].text).toContain("completed and deleted");
      expect(executeTool).toHaveBeenCalledTimes(4); expect(confirm).toHaveBeenCalledTimes(1);
    } finally { await mock.emitExtension("session_shutdown", {}, ctx); }
  });
});
