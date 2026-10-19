import { describe, expect, it, vi } from "vitest";
import { registerTasksCommand } from "../src/commands/tasks-command.js";
import { TaskStore } from "../src/task-store.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

function setup(evaluateTaskBacklog = vi.fn(async () => ({ created: false })), overrides: Record<string, unknown> = {}) {
  const { pi, commandMap, emittedEvents } = createMockPi();
  const taskStore = new TaskStore(); // memory mode, no file I/O
  const updateWidget = vi.fn();
  registerTasksCommand({
    pi,
    getNativeTaskStore: () => taskStore,
    evaluateTaskBacklog,
    updateWidget,
    ...overrides,
  });
  const registered = commandMap.get("tasks")!;
  const command = { ...registered, handler: (args: string, ctx: any) => {
    const defaults = createCtx();
    if (!("cwd" in ctx)) ctx.cwd = defaults.cwd;
    if (!("sessionManager" in ctx)) ctx.sessionManager = defaults.sessionManager;
    return registered.handler!(args, ctx);
  } };
  return { taskStore, updateWidget, evaluateTaskBacklog, emittedEvents, command };
}

describe("registerTasksCommand", () => {
  it("registers a tasks command with a description", () => {
    const h = setup();
    expect(h.command).toBeDefined();
    expect(h.command.description).toContain("native pi-loop tasks");
  });

  it("warns when native tasks are unavailable (pi-tasks active)", async () => {
    const { pi, commandMap } = createMockPi();
    registerTasksCommand({
      pi,
      getNativeTaskStore: () => undefined,
      evaluateTaskBacklog: vi.fn(async () => ({ created: false })),
      updateWidget: vi.fn(),
    });
    const command = commandMap.get("tasks")!;
    const ctx = createCtx();

    await command.handler!("", ctx);

    expect(ctx.notifications).toEqual([
      { message: "Native tasks are unavailable while pi-tasks is active", level: "warning" },
    ]);
  });

  it("creates a task from a free-text argument string and emits tasks:created", async () => {
    const h = setup();
    const ctx = createCtx();

    await h.command.handler!("fix the flaky test", ctx);

    expect(h.taskStore.list()).toHaveLength(1);
    const entry = h.taskStore.get("1");
    expect(entry?.subject).toBe("fix the flaky test");
    expect(entry?.description).toBe("fix the flaky test");
    expect(h.emittedEvents.some((e) => e.name === "tasks:created" && e.payload.taskId === "1")).toBe(true);
    expect(h.updateWidget).toHaveBeenCalledTimes(1);
    expect(ctx.notifications).toContainEqual({ message: "Task #1 created", level: "info" });
  });

  it("truncates the subject to 80 chars but keeps the full description", async () => {
    const h = setup();
    const long = "x".repeat(120);
    await h.command.handler!(long, createCtx());

    const entry = h.taskStore.get("1");
    expect(entry?.subject).toHaveLength(80);
    expect(entry?.description).toBe(long);
  });

  it("surfaces the backlog-worker note when evaluateTaskBacklog reports a created loop", async () => {
    const h = setup(vi.fn(async () => ({ created: true, entry: { id: "5" } })));
    const ctx = createCtx();

    await h.command.handler!("do the thing", ctx);

    expect(ctx.notifications).toContainEqual({ message: "Task #1 created", level: "info" });
    expect(ctx.notifications).toContainEqual({ message: "Backlog worker loop #5 created", level: "info" });
  });

  it("does not surface a backlog note when evaluateTaskBacklog reports created: false", async () => {
    const h = setup(vi.fn(async () => ({ created: false })));
    const ctx = createCtx();

    await h.command.handler!("do the thing", ctx);

    expect(ctx.notifications).toHaveLength(1);
    expect(ctx.notifications[0].message).toBe("Task #1 created");
  });

  it("no-args invocation lists 0 tasks with a Create option and no other entries", async () => {
    const h = setup();
    const ui = {
      select: vi.fn(async () => undefined),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(ui.select).toHaveBeenCalledWith("Tasks", ["+ Create task", "< Back"], { signal: expect.any(AbortSignal) });
  });

  it("no-args invocation lists a mixed-status backlog with status icons", async () => {
    const h = setup();
    h.taskStore.create("pending task", "d");
    const t2 = h.taskStore.create("in progress task", "d");
    h.taskStore.start(t2.id);
    const t3 = h.taskStore.create("done task", "d");
    h.taskStore.start(t3.id);
    h.taskStore.complete(t3.id);

    const ui = {
      select: vi.fn(async () => undefined),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(ui.select).toHaveBeenCalledWith("Tasks", [
      "+ Create task",
      "* #1 [pending] pending task",
      "> #2 [in_progress] in progress task",
      "ok #3 [completed] done task",
      "< Back",
    ], { signal: expect.any(AbortSignal) });
  });

  it("no-args '+ Create task' prompts for subject/description and creates a task", async () => {
    const h = setup();
    const ui = {
      select: vi.fn()
        .mockResolvedValueOnce("+ Create task")
        .mockResolvedValueOnce(undefined), // stop the recursive re-render
      input: vi.fn()
        .mockResolvedValueOnce("New subject")
        .mockResolvedValueOnce("New description"),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.taskStore.list()).toHaveLength(1);
    const entry = h.taskStore.get("1");
    expect(entry?.subject).toBe("New subject");
    expect(entry?.description).toBe("New description");
    expect(ui.notify).toHaveBeenCalledWith("Task #1 created", "info");
  });

  it("no-args '+ Create task' defaults description to the subject when left blank", async () => {
    const h = setup();
    const ui = {
      select: vi.fn()
        .mockResolvedValueOnce("+ Create task")
        .mockResolvedValueOnce(undefined),
      input: vi.fn()
        .mockResolvedValueOnce("Just a subject")
        .mockResolvedValueOnce(""), // blank description falls back to subject
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    const entry = h.taskStore.get("1");
    expect(entry?.description).toBe("Just a subject");
  });

  it("canceling description creates no task, event, widget update or backlog", async () => {
    const h = setup();
    const ui = { select: vi.fn().mockResolvedValueOnce("+ Create task").mockResolvedValueOnce(undefined),
      input: vi.fn().mockResolvedValueOnce("Canceled fixture").mockResolvedValueOnce(undefined), notify: vi.fn() };
    await h.command.handler("", { ui });
    expect(h.taskStore.list()).toEqual([]); expect(h.emittedEvents).toEqual([]);
    expect(h.updateWidget).not.toHaveBeenCalled(); expect(h.evaluateTaskBacklog).not.toHaveBeenCalled(); expect(ui.notify).not.toHaveBeenCalled();
  });

  it("description from a replaced task provider cannot create into its new store", async () => {
    const original = new TaskStore(); const replacement = new TaskStore(); let current = original;
    const h = setup(undefined, { getNativeTaskStore: () => current });
    const ui = { select: vi.fn().mockResolvedValueOnce("+ Create task").mockResolvedValueOnce(undefined),
      input: vi.fn(async (title: string) => { if (title === "Task subject") return "Old provider task"; current = replacement; return "Old description"; }), notify: vi.fn() };
    await h.command.handler("", { ui });
    expect(original.list()).toEqual([]); expect(replacement.list()).toEqual([]);
    expect(h.emittedEvents).toEqual([]); expect(h.evaluateTaskBacklog).not.toHaveBeenCalled(); expect(ui.notify).not.toHaveBeenCalled();
  });

  it("an unlisted task row cannot select an existing task by a forged ID label", async () => {
    const h = setup(); h.taskStore.create("Fixture", "Description"); const before = structuredClone(h.taskStore.get("1"));
    const ui = { select: vi.fn().mockResolvedValueOnce("invented #1").mockResolvedValueOnce("x Delete").mockResolvedValueOnce(undefined), input: vi.fn(), notify: vi.fn() };
    await h.command.handler("", { ui });
    expect(h.taskStore.get("1")).toEqual(before); expect(ui.select).toHaveBeenCalledTimes(1);
    expect(ui.input).not.toHaveBeenCalled(); expect(h.emittedEvents).toEqual([]);
  });

  it("an unlisted task action never asks for a claim token", async () => {
    const h = setup(); h.taskStore.create("Claimed fixture", "Fixture description");
    h.taskStore.claim("1", { claimId: "fixture-token", ownerSessionId: "fixture", ownerRuntimeId: "runtime", leaseMs: 60000 });
    const before = structuredClone(h.taskStore.get("1"));
    const ui = { select: vi.fn().mockResolvedValueOnce("> #1 [in_progress] Claimed fixture").mockResolvedValueOnce("invented action").mockResolvedValueOnce(undefined), input: vi.fn(), notify: vi.fn() };
    await h.command.handler("", { ui });
    expect(ui.input).not.toHaveBeenCalled(); expect(h.taskStore.get("1")).toEqual(before); expect(h.emittedEvents).toEqual([]);
  });

  it("committed creation remains valid but stale backlog acknowledgement is suppressed", async () => {
    let generation = 0; let release!: (value: { created: boolean }) => void;
    const wait = new Promise<{ created: boolean }>(resolve => { release = resolve; });
    const evaluate = vi.fn(async () => wait); const h = setup(evaluate, { getGeneration: () => generation }); const ctx = createCtx();
    const operation = h.command.handler("Authorized task", ctx);
    expect(h.taskStore.list()).toHaveLength(1); generation++; release({ created: false }); await operation;
    expect(h.taskStore.list()).toHaveLength(1); expect(h.emittedEvents).toHaveLength(1); expect(ctx.notifications).toEqual([]);
  });

  it("selecting a task and choosing Complete transitions it and emits tasks:completed", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");

    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Tasks") {
          return h.taskStore.get("1")?.status === "pending" ? "* #1 [pending] subject" : "< Back";
        }
        if (title.startsWith("#1")) return "ok Complete";
        return "< Back";
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.taskStore.get("1")?.status).toBe("completed");
    expect(h.emittedEvents.some((e) => e.name === "tasks:completed" && e.payload.taskId === "1")).toBe(true);
    expect(h.updateWidget).toHaveBeenCalled();
    expect(h.evaluateTaskBacklog).toHaveBeenCalledWith(h.taskStore, h.taskStore.pendingCount());
    expect(ui.notify).toHaveBeenCalledWith("Task #1 completed", "info");
  });

  it("selecting a task and choosing Close without completing transitions it and emits tasks:closed", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");

    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Tasks") {
          return h.taskStore.get("1")?.status === "pending" ? "* #1 [pending] subject" : "< Back";
        }
        if (title.startsWith("#1")) return "x Close without completing";
        return "< Back";
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.taskStore.get("1")?.status).toBe("closed");
    const event = h.emittedEvents.find((e) => e.name === "tasks:closed" && e.payload.taskId === "1");
    expect(event).toBeDefined();
    expect(event?.payload.previousStatus).toBe("pending");
    expect(ui.notify).toHaveBeenCalledWith("Task #1 closed without completing", "info");
  });

  it("does not report deletion success when a claimed task lacks its token", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");
    h.taskStore.claim("1", {
      claimId: "claim-1",
      ownerSessionId: "session-a",
      ownerRuntimeId: "runtime-a",
      leaseMs: 60_000,
    });
    let taskVisits = 0;
    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Tasks") return taskVisits++ === 0 ? "> #1 [in_progress] subject" : "< Back";
        if (title.startsWith("#1")) return "x Delete";
        return "< Back";
      }),
      input: vi.fn(async () => ""),
      notify: vi.fn(),
    };

    await h.command.handler!("", { ui } as any);

    expect(h.taskStore.get("1")).toBeDefined();
    expect(h.emittedEvents.some((event) => event.name === "tasks:deleted")).toBe(false);
    expect(ui.notify).toHaveBeenCalledWith("Task #1 unchanged: claim token required", "warning");
  });

  it("selecting a task and choosing Delete removes it and emits tasks:deleted", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");

    const ui = {
      select: vi.fn(async (title: string) => {
        if (title === "Tasks") {
          return h.taskStore.get("1") ? "* #1 [pending] subject" : "< Back";
        }
        if (title.startsWith("#1")) return "x Delete";
        return "< Back";
      }),
      input: vi.fn(),
      notify: vi.fn(),
    };
    const ctx = { ui } as any;

    await h.command.handler!("", ctx);

    expect(h.taskStore.get("1")).toBeUndefined();
    expect(h.emittedEvents.some((e) => e.name === "tasks:deleted" && e.payload.taskId === "1")).toBe(true);
    expect(ui.notify).toHaveBeenCalledWith("Task #1 deleted", "info");
  });
});
