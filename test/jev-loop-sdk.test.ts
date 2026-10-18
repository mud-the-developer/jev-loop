import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { registerLoopTools } from "../src/tools/loop-tools.js";
import { evidence, policy, recommendation } from "./helpers/jev-loop-fixture.js";

// Synthetic assistant/JEV/UI, real SDK dispatch and verifier; no external model/network.
describe.skipIf(process.platform === "win32")("public Pi SDK nested-tool boundary", () => {
  it.each([false, true])("preserves tool_call permission hooks (blocked=%s)", async blocked => {
    const cwd = mkdtempSync(join(tmpdir(), "jev-sdk-"));
    const store = new LoopStore();
    const confirm = vi.fn(async () => true);
    const results: Array<{ content: unknown[] }> = [];
    const decide = vi.fn(async () => {
      const details = recommendation();
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    });
    const calls: Array<{ toolName: string; parentToolCallId?: string }> = [];
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        registerLoopTools({ pi, getStore: () => store, getTriggerSystem: () => ({ add() {}, remove() {} }),
          getScheduler: () => ({ nextFire: () => undefined }), getMonitorManager: () => ({ get: () => undefined }),
          updateWidget() {}, maybeBootstrapTaskLoop: async () => false, isTaskSystemReady: () => true });
        pi.registerTool({ name: "jev_decide", label: "Fixture JEV", description: "Controlled fixture only", parameters: Type.Object({}), execute: decide });
        pi.on("tool_call", event => {
          calls.push({ toolName: event.toolName, parentToolCallId: event.parentToolCallId });
          if (blocked && event.toolName === "jev_decide") return { block: true, reason: "Fixture permission refusal" };
        });
        pi.registerTool({ name: "FixtureDriver", label: "Driver", description: "Exercise nested public tools", parameters: Type.Object({ action: Type.String() }),
          async execute(_id, input, signal, _update, ctx) {
            const result = await ctx.executeTool(input.action === "create" ? "LoopCreate" : "LoopUpdate", input.action === "create" ? {
              trigger: "idle", triggerType: "idle", prompt: "User goal", maxFires: 3, expiresIn: "1h",
              completion: { ...policy, verification: { command: process.execPath, args: ["-e", "process.exit(0)"], description: "The fixed SDK fixture succeeds" } },
            } : { id: "1", status: "completed", completionEvidence: evidence }, { signal });
            results.push(result.result);
            return result.result;
          },
        });
      }],
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await resourceLoader.reload();
      expect(resourceLoader.getExtensions().errors).toEqual([]);
      const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json") });
      await modelRuntime.setRuntimeApiKey("openai", "fixture-only-no-network");
      const model = getModels("openai")[0]!;
      ({ session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader, modelRuntime, model, settingsManager,
        sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" }));
      await session.bindExtensions({ uiContext: { confirm, notify() {}, setStatus() {}, setWidget() {} } as any });
      let phase = 0;
      session.agent.streamFunction = () => {
        phase++;
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          stopReason: phase < 3 ? "toolUse" : "stop",
          content: phase < 3 ? [{ type: "toolCall", id: `fixture-${phase}`, name: "FixtureDriver", arguments: { action: phase === 1 ? "create" : "complete" } }] : [{ type: "text", text: "Fixture complete" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: phase < 3 ? "toolUse" : "stop", message });
        stream.end(message);
        return stream;
      };
      await session.prompt("Run the controlled fixture only.");
      expect(phase).toBe(3);
      expect(results).toHaveLength(2);
      expect(results[0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Loop #1 created") });
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(calls).toContainEqual(expect.objectContaining({ toolName: "jev_decide", parentToolCallId: expect.any(String) }));
      expect(decide).toHaveBeenCalledTimes(blocked ? 0 : 1);
      expect(results[1]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(blocked ? "held" : "completed and deleted") });
      expect(store.get("1") === undefined).toBe(!blocked);
    } finally { session?.dispose(); rmSync(cwd, { recursive: true, force: true }); }
  });
});
