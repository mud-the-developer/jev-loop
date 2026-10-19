import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  createTask,
  deleteTask,
  type TaskBacklogResult,
  type TaskMutationContext,
  taskMutationRejectionMessage,
  updateTask,
} from "../runtime/task-mutations.js";
import type { TaskStore } from "../task-store.js";
import { type CommandScope, createCommandGuard } from "./command-scope.js";

export interface TasksCommandOptions {
  pi: ExtensionAPI;
  getNativeTaskStore: () => TaskStore | undefined;
  getGeneration?: () => number;
  isContextCurrent?: (ctx: ExtensionCommandContext) => boolean;
  evaluateTaskBacklog: (taskStore: TaskStore, pendingCount: number) => Promise<TaskBacklogResult>;
  updateWidget: () => void;
}

export function registerTasksCommand(options: TasksCommandOptions): void {
  const { pi, getNativeTaskStore, evaluateTaskBacklog, updateWidget } = options;
  const capture = createCommandGuard({ ...options, getStore: getNativeTaskStore });

  function mutationContext(taskStore: TaskStore): TaskMutationContext {
    return { pi, taskStore, evaluateTaskBacklog, updateWidget };
  }

  async function createNativeTaskInteractively(ui: ExtensionUIContext, scope: CommandScope) {
    if (!scope.current()) return;
    const taskStore = getNativeTaskStore();
    if (!taskStore) {
      ui.notify("Native tasks are unavailable while pi-tasks is active", "warning");
      return;
    }

    const subject = await ui.input("Task subject", undefined, { signal: scope.signal });
    if (!scope.current() || !subject) return;
    const description = await ui.input("Task description", undefined, { signal: scope.signal });
    if (!scope.current() || description === undefined) return;
    const created = await createTask(mutationContext(taskStore), { subject, description: description || subject });
    if (!scope.current()) return;
    ui.notify(`Task #${created.entry.id} created`, "info");
    if (created.backlog.created && created.backlog.entry) {
      ui.notify(`Backlog worker loop #${created.backlog.entry.id} created`, "info");
    }
  }

  async function viewNativeTasks(ui: ExtensionUIContext, scope: CommandScope): Promise<void> {
    if (!scope.current()) return;
    const taskStore = getNativeTaskStore();
    if (!taskStore) {
      ui.notify("Native tasks are unavailable while pi-tasks is active", "warning");
      return;
    }

    const tasks = taskStore.list();
    const choices = tasks.map((task) => {
      const icon = task.status === "in_progress" ? ">" : task.status === "completed" ? "ok" : task.status === "closed" ? "x" : "*";
      return `${icon} #${task.id} [${task.status}] ${task.subject.slice(0, 60)}`;
    });
    choices.unshift("+ Create task");
    choices.push("< Back");

    const selected = await ui.select("Tasks", choices, { signal: scope.signal });
    if (!scope.current() || !selected || selected === "< Back") return;
    if (!choices.includes(selected)) { ui.notify("Task selection changed; reopen /tasks before retrying.", "warning"); return; }
    if (selected === "+ Create task") {
      await createNativeTaskInteractively(ui, scope);
      return viewNativeTasks(ui, scope);
    }

    const taskId = selected.match(/#(\d+)/)?.[1];
    if (!taskId) return viewNativeTasks(ui, scope);

    const task = taskStore.get(taskId);
    if (!task) return viewNativeTasks(ui, scope);

    const actions = ["x Delete"];
    if (task.status === "pending") {
      actions.unshift("x Close without completing");
      actions.unshift("ok Complete");
      actions.unshift("> Start");
    } else if (task.status === "in_progress") {
      actions.unshift("x Close without completing");
      actions.unshift("ok Complete");
    } else {
      actions.unshift("* Reopen");
    }
    actions.push("< Back");

    const action = await ui.select(`#${task.id}: ${task.subject}\n\n${task.description}`, actions, { signal: scope.signal });
    if (!scope.current()) return;
    if (!action || action === "< Back") return viewNativeTasks(ui, scope);
    if (!actions.includes(action)) { ui.notify("Unrecognized task action; no change was applied.", "warning"); return; }

    const claimId = task.claim ? await ui.input("Claim token required", undefined, { signal: scope.signal }) : undefined;
    if (!scope.current()) return;
    if (task.claim && !claimId) {
      ui.notify(`Task #${task.id} unchanged: claim token required`, "warning");
      return viewNativeTasks(ui, scope);
    }

    let changed = false;
    let rejection: string | undefined;
    if (action === "x Delete") {
      const result = await deleteTask(mutationContext(taskStore), { id: task.id, claimId });
      changed = result.applied;
      if (!result.applied) rejection = taskMutationRejectionMessage(task.id, result);
    } else {
      const status = action === "> Start"
        ? "in_progress"
        : action === "ok Complete"
          ? "completed"
          : action === "x Close without completing"
            ? "closed"
            : action === "* Reopen"
              ? "pending"
              : undefined;
      if (status) {
        const result = await updateTask(mutationContext(taskStore), { id: task.id, status, claimId });
        changed = result.applied;
        if (!result.applied) rejection = taskMutationRejectionMessage(task.id, result);
      }
    }

    if (!scope.current()) return;
    if (!changed) {
      ui.notify(`Task #${task.id} unchanged: ${rejection ?? "operation rejected"}`, "warning");
      return viewNativeTasks(ui, scope);
    }
    const pastTense = action === "x Delete" ? "deleted"
      : action === "> Start" ? "started"
        : action === "ok Complete" ? "completed"
          : action === "x Close without completing" ? "closed without completing"
            : "reopened";
    ui.notify(`Task #${task.id} ${pastTense}`, "info");
    return viewNativeTasks(ui, scope);
  }

  pi.registerCommand("tasks", {
    description: "View or manage native pi-loop tasks when pi-tasks is not installed",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const scope = capture(ctx);
      if (!scope.current()) return;
      const trimmed = args.trim();
      const taskStore = getNativeTaskStore();
      if (!taskStore) {
        ctx.ui.notify("Native tasks are unavailable while pi-tasks is active", "warning");
        return;
      }
      if (trimmed) {
        const created = await createTask(mutationContext(taskStore), { subject: trimmed.slice(0, 80), description: trimmed });
        if (!scope.current()) return;
        ctx.ui.notify(`Task #${created.entry.id} created`, "info");
        if (created.backlog.created && created.backlog.entry) {
          ctx.ui.notify(`Backlog worker loop #${created.backlog.entry.id} created`, "info");
        }
        return;
      }
      await viewNativeTasks(ctx.ui, scope);
    },
  });
}
