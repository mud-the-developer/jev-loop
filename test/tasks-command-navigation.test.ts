import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerTasksCommand } from "../src/commands/tasks-command.js";
import { TaskStore } from "../src/task-store.js";
import { deferred } from "./helpers/jev-loop-fixture.js";

// Public SDK navigation, controlled late UI replies; no model or network calls.
describe("standalone task dialog ownership", () => {
  for (const route of ["menu", "subject", "description", "start", "complete", "close", "reopen", "delete", "claim-token"]) {
    it.each([false, true])(`${route} acts only when navigation is vetoed (veto=%s)`, async veto => {
      const cwd = mkdtempSync(join(tmpdir(), "tasks-navigation-")); const store = new TaskStore();
      const manager = SessionManager.inMemory(cwd); const answer = deferred<string | undefined>(); const entered = deferred<void>();
      let optionsAtWait: any; let selected = false;
      const wait = (options: unknown) => { optionsAtWait = options; entered.resolve(); return answer.promise; };
      const action = route === "start" ? "> Start" : route === "complete" || route === "claim-token" ? "ok Complete"
        : route === "close" ? "x Close without completing" : route === "reopen" ? "* Reopen" : "x Delete";
      const input = vi.fn(async (title: string, _placeholder?: string, options?: unknown) => {
        if (title === "Claim token required") return wait(options);
        if (title === "Task subject") return route === "subject" ? wait(options) : "Fixture task";
        return route === "description" ? wait(options) : "Fixture description";
      });
      const select = vi.fn(async (title: string, choices: string[], options?: unknown): Promise<string | undefined> => {
        if (title === "Tasks" && !selected) {
          selected = true;
          if (route === "menu") return wait(options);
          return route === "subject" || route === "description" ? "+ Create task" : choices.find(choice => choice.includes("#1"));
        }
        if (title.startsWith("#1:")) return route === "claim-token" ? action : wait(options);
        return undefined;
      });
      const notify = vi.fn(); const evaluate = vi.fn(async () => ({ created: false })); const widget = vi.fn(); const agentStart = vi.fn();
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
      const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
        extensionFactories: [pi => {
          registerTasksCommand({ pi, getNativeTaskStore: () => store, evaluateTaskBacklog: evaluate, updateWidget: widget });
          pi.on("agent_start", agentStart);
          if (veto) pi.on("session_before_tree", () => ({ cancel: true }));
        }],
      });
      let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined; let command: Promise<void> | undefined;
      try {
        await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
        const runtime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
        ({ session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader: loader, modelRuntime: runtime, settingsManager, sessionManager: manager, noTools: "builtin" }));
        await session.bindExtensions({ uiContext: { input, select, notify, setStatus() {}, setWidget() {} } as any });
        const target = manager.appendCustomEntry("fixture.tasks", { base: true }); const oldLeaf = manager.appendCustomEntry("fixture.tasks", { old: true });
        if (!["menu", "subject", "description"].includes(route)) {
          store.create("Fixture task", "Fixture description");
          if (route === "reopen") store.close("1");
          if (route === "claim-token") store.claim("1", { claimId: "fixture-token", ownerSessionId: "fixture", ownerRuntimeId: "runtime", leaseMs: 60000 });
        }
        const before = structuredClone(store.list()); const sessionId = manager.getSessionId();
        command = session.prompt("/tasks"); await entered.promise; expect(session.isStreaming).toBe(false);
        const navigation = await session.navigateTree(target, { summarize: false });
        expect(navigation.cancelled).toBe(veto); expect(manager.getSessionId()).toBe(sessionId); expect(manager.getLeafId()).toBe(veto ? oldLeaf : target);
        answer.resolve(route === "menu" ? "+ Create task" : route === "subject" ? "Old branch task" : route === "description" ? "Old description" : route === "claim-token" ? "fixture-token" : action);
        await command;
        if (veto) {
          expect(store.list()).not.toEqual(before); expect(optionsAtWait?.signal?.aborted ?? false).toBe(false);
          if (route === "delete") expect(store.get("1")).toBeUndefined();
          else expect(store.get("1")?.status).toBe(route === "complete" || route === "claim-token" ? "completed" : route === "close" ? "closed" : route === "start" ? "in_progress" : "pending");
        } else {
          expect(store.list()).toEqual(before); expect(notify).not.toHaveBeenCalled(); expect(evaluate).not.toHaveBeenCalled(); expect(widget).not.toHaveBeenCalled();
          expect(optionsAtWait?.signal).toBeInstanceOf(AbortSignal); expect(optionsAtWait.signal.aborted).toBe(true);
          await session.prompt("/tasks Fresh branch task"); expect(store.list()).toHaveLength(before.length + 1); expect(store.list().at(-1)?.subject).toBe("Fresh branch task");
        }
        expect(agentStart).not.toHaveBeenCalled();
      } finally { answer.resolve(undefined); await command; session?.dispose(); rmSync(cwd, { recursive: true, force: true }); }
    });
  }
});
