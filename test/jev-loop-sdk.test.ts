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
    { blocked: false, goalEntry: true, repairFirst: false, navigate: false, diagnoseFirst: true },
    { blocked: true, goalEntry: true, repairFirst: false, navigate: false, diagnoseFirst: true },
    { blocked: false, goalEntry: false, repairFirst: false, navigate: false, adaptive: true },
    { blocked: true, goalEntry: false, repairFirst: false, navigate: false, adaptive: true },
  ])("preserves public goal, rework and permission boundaries (%j)", async ({ blocked, goalEntry, repairFirst, navigate, diagnoseFirst = false, adaptive = false }) => {
    const cwd = mkdtempSync(join(tmpdir(), "jev-sdk-"));
    const store = new LoopStore();
    const manager = SessionManager.inMemory(cwd);
    const userGoal = "필수 fixture 검증을 통과해줘";
    const confirm = vi.fn(async () => true);
    const verifier = vi.fn(verifyCompletion);
    const results: Array<{ content: unknown[] }> = [];
    let assessments = 0;
    const decide = vi.fn(async (..._args: any[]) => {
      const packet = _args[1];
      const budgetChoice = adaptive && packet.options[0].id.startsWith("budget_");
      const selected = budgetChoice ? ((store.get("1")?.fireCount ?? 0) > 0 ? packet.options.at(-1) : packet.options[0]) : undefined;
      const details = selected ? { status: "recommended", advisoryOnly: true, option: selected,
        reply: { choice: selected.id, confidence: 0.8, probabilities: Object.fromEntries(packet.options.map((option: any) => [option.id, option.id === selected.id ? 0.8 : 0.2])), model: "budget-sdk-fixture", usage: { inputTokens: 1, outputTokens: 1 } } }
        : recommendation(diagnoseFirst && ++assessments === 1 ? "unmet" : "met");
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
          if (blocked && event.toolName === "jev_decide" && (!diagnoseFirst || calls.filter(call => call.toolName === "jev_decide").length > 1)) return { block: true, reason: "Fixture permission refusal" };
        });
        pi.registerTool({ name: "FixtureDriver", label: "Driver", description: "Run fixed SDK fixture actions", parameters: Type.Object({ action: Type.String() }),
          async execute(_id, input, signal, _update, ctx) {
            if (input.action === "repair") {
              writeFileSync(join(cwd, "ready"), "ready\n");
              const result = { content: [{ type: "text" as const, text: "Fixed fixture repaired." }], details: undefined };
              results.push(result); return result;
            }
            if (adaptive && input.action === "continue") store.fire("1");
            const args = input.action === "create" ? {
              trigger: "idle", triggerType: "idle", prompt: goalEntry ? userGoal : "User goal", maxFires: 3, expiresIn: "1h",
              completion: { ...policy, ...(adaptive ? { budgetRange: { minFires: 1, minExpiresIn: "30m" } } : {}), verification: { command: process.execPath,
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
      const plan: Array<string | null> = adaptive ? blocked ? ["create", null] : ["create", "continue", "complete", null]
        : ["create", ...(navigate ? [null] : []), ...(repairFirst || (diagnoseFirst && !blocked) ? ["complete", "continue", "repair"] : []), "complete", null];
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
      expect(results).toHaveLength(adaptive ? blocked ? 1 : 3 : repairFirst || (diagnoseFirst && !blocked) ? 5 : 2);
      if (adaptive && blocked) expect(results[0]!.content[0]).toMatchObject({ type: "text", text: expect.stringMatching(/budget decision failed|blocked/) });
      else expect(results[0]!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Loop #1 created") });
      expect(confirm).toHaveBeenCalledTimes(1);
      const codes = await Promise.all(verifier.mock.results.map(result => result.value));
      expect(codes.map(result => result.code)).toEqual(adaptive && blocked ? [] : repairFirst ? [7, 0] : diagnoseFirst && !blocked ? [0, 0] : [0]);
      expect(calls).toContainEqual(expect.objectContaining({ toolName: "jev_decide", parentToolCallId: expect.any(String) }));
      expect(decide).toHaveBeenCalledTimes(adaptive ? blocked ? 0 : 9 : diagnoseFirst ? blocked ? 1 : 4 : blocked ? 0 : 1);
      if (diagnoseFirst && !blocked) {
        expect(decide.mock.calls[1]![1].question).toMatch(/criterion 1/);
        expect(decide.mock.calls[2]![1].question).toMatch(/criterion 2/);
        for (const call of decide.mock.calls) expect(JSON.parse(call[1].context).criteria).toEqual(policy.criteria);
      }
      expect(results.at(-1)!.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(blocked ? adaptive ? "blocked" : "held" : "completed and deleted") });
      expect(store.get("1") === undefined).toBe(adaptive && blocked || !blocked);
    } finally {
      await session?.abort(); await runtime?.shutdown(); session?.dispose();
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
