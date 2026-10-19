import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerLoopCommand } from "../src/commands/loop-command.js";
import { LoopStore } from "../src/store.js";
import { deferred } from "./helpers/jev-loop-fixture.js";

// Public SDK navigation with controlled, deliberately late UI replies; no model/network.
describe("legacy /loop dialog ownership", () => {
  for (const route of ["menu", "scheduled-prompt", "scheduled-interval", "event-prompt", "event-source", "delete", "pause", "resume"]) {
    it.each([false, true])(`${route} acts only if navigation is vetoed (veto=%s)`, async veto => {
      const cwd = mkdtempSync(join(tmpdir(), "loop-navigation-"));
      const store = new LoopStore(); const manager = SessionManager.inMemory(cwd);
      const answer = deferred<string | undefined>(); const entered = deferred<void>();
      let dialogOptions: any; let selected = false;
      const pending = (options: unknown) => { dialogOptions = options; entered.resolve(); return answer.promise; };
      const input = vi.fn(async (title: string, _placeholder?: string, options?: unknown) => {
        if (title.startsWith("Interval")) return route === "scheduled-interval" ? pending(options) : "5m";
        if (title.startsWith("Pi event source")) return route === "event-source" ? pending(options) : "tool_execution_start";
        return route === "scheduled-prompt" || route === "event-prompt" ? pending(options) : "Fixture work";
      });
      const select = vi.fn(async (title: string, choices: string[], options?: unknown): Promise<string | undefined> => {
        if (title === "Loop") {
          if (route === "menu") return pending(options);
          if (route.startsWith("scheduled")) return "Create scheduled loop";
          if (route.startsWith("event")) return "Create event-triggered loop";
          return "View loops";
        }
        if (title === "Loops" && !selected) { selected = true; return choices.find(choice => choice.includes("#1")); }
        if (title.startsWith("#1:")) return pending(options);
        return undefined;
      });
      const notify = vi.fn(); const agentStart = vi.fn();
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const loader = new DefaultResourceLoader({
        cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noContextFiles: true, noPromptTemplates: true,
        extensionFactories: [pi => {
          registerLoopCommand({ pi, getStore: () => store, getTriggerSystem: () => ({ add() {}, remove() {} }), updateWidget() {} });
          pi.on("agent_start", agentStart);
          if (veto) pi.on("session_before_tree", () => ({ cancel: true }));
        }],
      });
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
      let command: Promise<void> | undefined;
      try {
        await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
        const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
        ({ session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader: loader, modelRuntime, settingsManager, sessionManager: manager, noTools: "builtin" }));
        await session.bindExtensions({ uiContext: { select, input, notify, setStatus() {}, setWidget() {} } as any });
        const target = manager.appendCustomEntry("fixture.navigation", { base: true });
        const oldLeaf = manager.appendCustomEntry("fixture.navigation", { oldBranch: true });
        const managed = ["delete", "pause", "resume"].includes(route);
        if (managed) {
          store.create({ type: "cron", schedule: "*/5 * * * *" }, "Old branch work", { recurring: true });
          if (route === "resume") store.pause("1");
        }
        const before = structuredClone(store.list()); const sessionId = manager.getSessionId();
        command = session.prompt("/loop"); await entered.promise;
        expect(session.isStreaming).toBe(false);
        const navigation = await session.navigateTree(target, { summarize: false });
        expect(navigation.cancelled).toBe(veto); expect(manager.getSessionId()).toBe(sessionId);
        expect(manager.getLeafId()).toBe(veto ? oldLeaf : target);
        const reply = route === "menu" ? "Create scheduled loop" : route === "delete" ? "x Delete" : route === "pause" ? "- Pause"
          : route === "resume" ? "* Resume" : route === "scheduled-interval" ? "5m" : route === "event-source" ? "tool_execution_start" : "Old branch work";
        answer.resolve(reply); await command;
        if (veto) {
          expect(store.list()).not.toEqual(before);
          expect(dialogOptions?.signal?.aborted ?? false).toBe(false);
          if (!managed) expect(store.get("1")?.trigger.type).toBe(route.startsWith("event") ? "event" : "cron");
          else if (route === "delete") expect(store.get("1")).toBeUndefined();
          else expect(store.get("1")?.status).toBe(route === "pause" ? "paused" : "active");
        } else {
          expect(store.list()).toEqual(before); expect(notify).not.toHaveBeenCalled();
          expect(dialogOptions?.signal).toBeInstanceOf(AbortSignal); expect(dialogOptions.signal.aborted).toBe(true);
          await session.prompt("/loop 5m Fresh branch request");
          expect(store.list()).toHaveLength(before.length + 1);
          expect(store.list().at(-1)?.prompt).toBe("Fresh branch request");
        }
        expect(agentStart).not.toHaveBeenCalled();
      } finally {
        answer.resolve(undefined); await command; session?.dispose(); rmSync(cwd, { recursive: true, force: true });
      }
    });
  }
});
