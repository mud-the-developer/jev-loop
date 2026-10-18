import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { registerJevLoopCommand } from "../src/commands/jev-loop-command.js";
import { LoopStore } from "../src/store.js";
import { registerLoopTools } from "../src/tools/loop-tools.js";
import { deferred, policy } from "./helpers/jev-loop-fixture.js";

// Real SDK navigation and contexts, controlled UI/handoff. No model or verifier calls.
describe("SDK tree-navigation fences", () => {
  for (const operation of ["goal", "cancel"] as const) {
    it.skipIf(operation === "goal" && process.platform === "win32").each([false, true])(`fences ${operation} dialogs only after committed navigation (veto=%s)`, async veto => {
      const cwd = mkdtempSync(join(tmpdir(), "jev-navigation-"));
      const store = new LoopStore();
      const manager = SessionManager.inMemory(cwd);
      const answer = deferred<string | undefined>();
      const sent = vi.fn();
      const confirm = vi.fn(async () => false);
      const input = vi.fn(async (..._args: any[]) => answer.promise);
      const select = vi.fn(async (..._args: any[]) => operation === "goal" ? "Start a goal" : answer.promise);
      let runtime: ReturnType<typeof registerLoopTools> | undefined;
      const cancelLoop = vi.fn(async (entry: ReturnType<LoopStore["create"]>) => runtime!.cancelLoop(entry));
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const loader = new DefaultResourceLoader({
        cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
        extensionFactories: [pi => {
          runtime = registerLoopTools({ pi, getStore: () => store, getTriggerSystem: () => ({ add() {}, remove() {} }),
            getScheduler: () => ({ nextFire: () => undefined }), getMonitorManager: () => ({ get: () => undefined }),
            updateWidget() {}, maybeBootstrapTaskLoop: async () => false, isTaskSystemReady: () => true });
          registerJevLoopCommand({ pi: { ...pi, sendUserMessage: sent }, getStore: () => store, getGeneration: () => 0,
            isContextCurrent: () => true, cancelLoop, getStorageScope: () => "memory", getNextFire: () => undefined });
          pi.registerTool({ name: "jev_decide", label: "Unused JEV fixture", description: "Metadata only", parameters: Type.Object({}),
            async execute() { throw new Error("Navigation must not invoke JEV"); } });
          if (veto) pi.on("session_before_tree", () => ({ cancel: true }));
        }],
      });
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      let command: Promise<void> | undefined;
      try {
        await loader.reload();
        const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
        ({ session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader: loader, modelRuntime, settingsManager,
          sessionManager: manager, noTools: "builtin" }));
        await session.bindExtensions({ uiContext: { select, input, confirm, notify() {}, setStatus() {}, setWidget() {} } as any });
        const target = manager.appendCustomEntry("navigation-fixture", { point: "base" });
        const oldLeaf = manager.appendCustomEntry("navigation-fixture", { point: "old-branch" });
        const sessionId = manager.getSessionId();
        if (operation === "cancel") store.create({ type: "dynamic" }, "Existing JEV goal", { recurring: true, maxFires: 5, completion: policy, completionCwd: cwd });
        const before = structuredClone(store.list());
        expect(session.getActiveToolNames()).toContain("jev_decide");
        command = session.prompt(operation === "goal" ? "/jev-loop" : "/jev-loop cancel");
        await vi.waitFor(() => expect(operation === "goal" ? input : select).toHaveBeenCalled());
        expect(session.isStreaming).toBe(false);
        const navigation = await session.navigateTree(target, { summarize: false });
        expect(navigation.cancelled).toBe(veto);
        expect(manager.getSessionId()).toBe(sessionId);
        expect(manager.getLeafId()).toBe(veto ? oldLeaf : target);
        expect(session.getActiveToolNames()).toContain("jev_decide");
        const dialog = operation === "goal" ? input : select;
        expect(dialog.mock.calls[0]![2]?.signal).toBeInstanceOf(AbortSignal);
        expect(dialog.mock.calls[0]![2].signal.aborted).toBe(!veto);
        answer.resolve(operation === "goal" ? "Old branch goal" : "#1 Existing JEV goal");
        await command;
        expect(sent).toHaveBeenCalledTimes(operation === "goal" && veto ? 1 : 0);
        expect(cancelLoop).toHaveBeenCalledTimes(operation === "cancel" && veto ? 1 : 0);
        expect(confirm).not.toHaveBeenCalled();
        if (!veto) expect(store.list()).toEqual(before);
        if (operation === "cancel" && veto) expect(store.list()).toEqual([]);
        if (operation === "goal" && !veto) {
          await session.prompt("/jev-loop A fresh goal in the new branch");
          expect(sent).toHaveBeenCalledTimes(1);
          expect(sent.mock.calls[0]![0]).toContain("A fresh goal in the new branch");
        }
      } finally {
        answer.resolve(undefined);
        await command;
        await runtime?.shutdown();
        session?.dispose();
        rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});
