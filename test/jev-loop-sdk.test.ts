import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { registerJevLoopCommand } from "../src/commands/jev-loop-command.js";
import { LoopStore } from "../src/store.js";
import { registerLoopTools } from "../src/tools/loop-tools.js";
import { evidence, policy, recommendation } from "./helpers/jev-loop-fixture.js";

// Synthetic assistant/JEV/UI, real SDK dispatch and verifier; no external model/network.
describe.skipIf(process.platform === "win32")("public Pi SDK nested-tool boundary", () => {
  it.each([
    { blocked: false, goalEntry: false }, { blocked: true, goalEntry: false },
    { blocked: false, goalEntry: true }, { blocked: true, goalEntry: true },
  ])("preserves public goal and permission boundaries (%j)", async ({ blocked, goalEntry }) => {
    const cwd = mkdtempSync(join(tmpdir(), "jev-sdk-"));
    const store = new LoopStore();
    const userGoal = "필수 fixture 검증을 통과해줘";
    const confirm = vi.fn(async () => true);
    const results: Array<{ content: unknown[] }> = [];
    const decide = vi.fn(async (..._args: any[]) => {
      const details = recommendation();
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    });
    const calls: Array<{ toolName: string; parentToolCallId?: string }> = [];
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        const runtime = registerLoopTools({ pi, getStore: () => store, getTriggerSystem: () => ({ add() {}, remove() {} }),
          getScheduler: () => ({ nextFire: () => undefined }), getMonitorManager: () => ({ get: () => undefined }),
          updateWidget() {}, maybeBootstrapTaskLoop: async () => false, isTaskSystemReady: () => true });
        registerJevLoopCommand({ pi, getStore: () => store, getGeneration: () => 0, isContextCurrent: () => true,
          cancelLoop: runtime.cancelLoop, getStorageScope: () => "memory", getNextFire: () => undefined });
        pi.registerTool({ name: "jev_decide", label: "Fixture JEV", description: "Controlled fixture only", parameters: Type.Object({}), execute: decide });
        pi.on("tool_call", event => {
          calls.push({ toolName: event.toolName, parentToolCallId: event.parentToolCallId });
          if (blocked && event.toolName === "jev_decide") return { block: true, reason: "Fixture permission refusal" };
        });
        pi.registerTool({ name: "FixtureDriver", label: "Driver", description: "Exercise nested public tools", parameters: Type.Object({ action: Type.String() }),
          async execute(_id, input, signal, _update, ctx) {
            const result = await ctx.executeTool(input.action === "create" ? "LoopCreate" : "LoopUpdate", input.action === "create" ? {
              trigger: "idle", triggerType: "idle", prompt: goalEntry ? userGoal : "User goal", maxFires: 3, expiresIn: "1h",
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
      let settle!: () => void;
      const settled = new Promise<void>(resolve => { settle = resolve; });
      const unsubscribe = session.subscribe(event => { if (event.type === "agent_settled") settle(); });
      try {
        await session.prompt(goalEntry ? `/jev-loop ${userGoal}` : "Run the controlled fixture only.");
        await settled;
      } finally { unsubscribe(); }
      if (goalEntry && !blocked) {
        expect(JSON.stringify(decide.mock.calls[0]![1])).not.toContain(userGoal);
        expect(JSON.stringify(decide.mock.calls[0]![1])).not.toContain(cwd);
      }
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
