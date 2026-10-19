import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { registerJevLoopCommand } from "../src/commands/jev-loop-command.js";
import { verifyCompletion } from "../src/completion-verifier.js";
import { LoopStore } from "../src/store.js";
import { registerLoopTools } from "../src/tools/loop-tools.js";
import { evidence, policy, recommendation } from "./helpers/jev-loop-fixture.js";

// Synthetic assistant/JEV/UI, real SDK dispatch and verifier; no external model/network.
describe.skipIf(process.platform === "win32")("public Pi SDK nested-tool boundary", () => {
  it.each([
    { blocked: false, goalEntry: false, repairFirst: false, navigate: false },
    { blocked: true, goalEntry: false, repairFirst: false, navigate: false },
    { blocked: false, goalEntry: true, repairFirst: false, navigate: false },
    { blocked: true, goalEntry: true, repairFirst: false, navigate: false },
    { blocked: false, goalEntry: true, repairFirst: true, navigate: false },
    { blocked: true, goalEntry: true, repairFirst: true, navigate: false },
    { blocked: false, goalEntry: true, repairFirst: true, navigate: true },
  ])("preserves public goal, rework and permission boundaries (%j)", async ({ blocked, goalEntry, repairFirst, navigate }) => {
    const cwd = mkdtempSync(join(tmpdir(), "jev-sdk-"));
    const store = new LoopStore();
    const manager = SessionManager.inMemory(cwd);
    const userGoal = "필수 fixture 검증을 통과해줘";
    const confirm = vi.fn(async () => true);
    const verifier = vi.fn(verifyCompletion);
    const results: Array<{ content: unknown[] }> = [];
    const decide = vi.fn(async (..._args: any[]) => {
      const details = recommendation();
      return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
    });
    const calls: Array<{ toolName: string; parentToolCallId?: string }> = [];
    const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    let runtime: ReturnType<typeof registerLoopTools> | undefined;
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => {
        runtime = registerLoopTools({ pi, getStore: () => store, getTriggerSystem: () => ({ add() {}, remove() {} }),
          getScheduler: () => ({ nextFire: () => undefined }), getMonitorManager: () => ({ get: () => undefined }),
          updateWidget() {}, maybeBootstrapTaskLoop: async () => false, isTaskSystemReady: () => true, verify: verifier });
        registerJevLoopCommand({ pi, getStore: () => store, getGeneration: () => 0, isContextCurrent: () => true,
          cancelLoop: runtime.cancelLoop, getStorageScope: () => "memory", getNextFire: () => undefined });
        pi.registerTool({ name: "jev_decide", label: "Fixture JEV", description: "Controlled fixture only", parameters: Type.Object({}), execute: decide });
        pi.on("tool_call", event => {
          calls.push({ toolName: event.toolName, parentToolCallId: event.parentToolCallId });
          if (blocked && event.toolName === "jev_decide") return { block: true, reason: "Fixture permission refusal" };
        });
        pi.registerTool({ name: "FixtureDriver", label: "Driver", description: "Run fixed SDK fixture actions", parameters: Type.Object({ action: Type.String() }),
          async execute(_id, input, signal, _update, ctx) {
            if (input.action === "repair") {
              writeFileSync(join(cwd, "ready"), "ready\n");
              const result = { content: [{ type: "text" as const, text: "Fixed fixture repaired." }], details: undefined };
              results.push(result); return result;
            }
            const args = input.action === "create" ? {
              trigger: "idle", triggerType: "idle", prompt: goalEntry ? userGoal : "User goal", maxFires: 3, expiresIn: "1h",
              completion: { ...policy, verification: { command: process.execPath,
                args: ["-e", repairFirst ? 'process.exit(require("node:fs").existsSync("ready") ? 0 : 7)' : "process.exit(0)"],
                description: "The fixed SDK readiness check must succeed" } },
            } : input.action === "continue"
              ? { id: "1", status: "continue", state: "Repairing the fixed readiness fixture." }
              : { id: "1", status: "completed", completionEvidence: evidence };
            const result = await ctx.executeTool(input.action === "create" ? "LoopCreate" : "LoopUpdate", args, { signal });
            results.push(result.result); return result.result;
          },
        });
      }],
    });
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
    try {
      await resourceLoader.reload();
      expect(resourceLoader.getExtensions().errors).toEqual([]);
      const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
      await modelRuntime.setRuntimeApiKey("openai", "fixture-only-no-network");
      const model = getModels("openai")[0]!;
      ({ session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader, modelRuntime, model, settingsManager,
        sessionManager: manager, noTools: "builtin" }));
      await session.bindExtensions({ uiContext: { confirm, notify() {}, setStatus() {}, setWidget() {} } as any });
      const target = navigate ? manager.appendCustomEntry("fixture.navigation", { point: "base" }) : undefined;
      const plan: Array<string | null> = ["create", ...(navigate ? [null] : []), ...(repairFirst ? ["complete", "continue", "repair"] : []), "complete", null];
      let phase = 0;
      session.agent.streamFunction = () => {
        const action = plan[phase++];
        const message: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          stopReason: action ? "toolUse" : "stop",
          content: action ? [{ type: "toolCall", id: `fixture-${phase}`, name: "FixtureDriver", arguments: { action } }] : [{ type: "text", text: "Fixture complete" }],
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: action ? "toolUse" : "stop", message }); stream.end(message); return stream;
      };
      const active = session;
      async function run(prompt: string) {
        let settle!: () => void;
        const settled = new Promise<void>(resolve => { settle = resolve; });
        const unsubscribe = active.subscribe(event => { if (event.type === "agent_settled") settle(); });
        try { await active.prompt(prompt); await settled; } finally { unsubscribe(); }
      }
      await run(goalEntry ? `/jev-loop ${userGoal}` : "Run the controlled fixture only.");
      if (navigate) {
        expect(store.get("1")).toBeDefined(); expect(confirm).toHaveBeenCalledTimes(1);
        const sessionId = manager.getSessionId();
        await session.navigateTree(target!, { summarize: false });
        expect(manager.getSessionId()).toBe(sessionId);
        await run("Continue the existing approved goal in this session.");
      }
      if (goalEntry && !blocked) {
        expect(JSON.stringify(decide.mock.calls[0]![1])).not.toContain(userGoal);
        expect(JSON.stringify(decide.mock.calls[0]![1])).not.toContain(cwd);
      }
      expect(phase).toBe(plan.length);
      expect(results).toHaveLength(repairFirst ? 5 : 2);
      expect(results[0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Loop #1 created") });
      expect(confirm).toHaveBeenCalledTimes(1);
      const codes = await Promise.all(verifier.mock.results.map(result => result.value));
      expect(codes.map(result => result.code)).toEqual(repairFirst ? [7, 0] : [0]);
      expect(calls).toContainEqual(expect.objectContaining({ toolName: "jev_decide", parentToolCallId: expect.any(String) }));
      expect(decide).toHaveBeenCalledTimes(blocked ? 0 : 1);
      expect(results.at(-1)!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(blocked ? "held" : "completed and deleted") });
      expect(store.get("1") === undefined).toBe(!blocked);
    } finally {
      await session?.abort(); await runtime?.shutdown(); session?.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
