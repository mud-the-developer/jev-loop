import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { VERIFICATION_SUPPORTED } from "../completion-verifier.js";
import type { CompletionReviewPhase } from "../runtime/jev-loop-runtime.js";
import type { LoopStorageScope } from "../runtime/scope.js";
import type { LoopStore } from "../store.js";
import type { LoopEntry } from "../types.js";
import { goalText, showGoalDashboard } from "../ui/goal-dashboard.js";
import { formatLoopLifecycle } from "../ui/lifecycle-presentation.js";
import { createCommandGuard } from "./command-scope.js";

interface Options {
  pi: ExtensionAPI;
  getStore: () => Pick<LoopStore, "get" | "list">;
  getGeneration: () => number;
  isContextCurrent: (ctx: ExtensionCommandContext) => boolean;
  cancelLoop: (entry: LoopEntry) => Promise<boolean>;
  getStorageScope: () => LoopStorageScope;
  getNextFire: (id: string) => number | undefined;
  getReviewPhase?: (entry: LoopEntry) => CompletionReviewPhase | undefined;
}

function setupMessage(goal: string): string {
  return [
    "Set up one bounded JEV-assisted dynamic goal loop for the user goal below. This request is NOT execution approval.",
    "First inspect LoopList to avoid a duplicate. Prepare a concise non-sensitive English completion.goal, criteria and verification.description; keep the original user goal in prompt. Never send the original goal, source, paths, argv, logs, history or secrets to JEV.",
    'Use LoopCreate with trigger="idle", triggerType="idle", recurring=true, and completion={goal,criteria,verification:{command,args,description},budgetRange:{minFires,minExpiresIn}} for adaptive budgets. Propose finite maxFires/expiresIn as total HARD upper bounds and budgetRange as the lower bounds; the user approves that range once, then JEV chooses the initial operating allocation and keep/extend after each fire only inside it. Hard lifetime starts once at genuine approval, not after each extension. Do not silently pick unlimited ranges or renew an old controller. If fixed limits were explicitly requested, omit budgetRange and preserve fixed behavior. Choose a known verifier, never an invented check; clarify the goal, verifier or finite range if needed.',
    "Before LoopCreate succeeds, only inspect read-only context needed for setup; do not edit files, execute the verifier, or begin goal work. Use the existing exact native setup approval; do not duplicate it or bypass mandatory permissions. If setup is declined, canceled or expired, stop without resubmitting. Do not start an ordinary loop without completion, a worker batch, or a competing controller. If ordered workflow routing is required, explain that this JEV entrypoint does not support workflow completion rather than misrouting the work.",
    "Work within the approved scope. For adaptive goals, supply optional separately authored non-sensitive English budgetEvidence in LoopUpdate, or let safe numeric facts describe the budget request; never forward raw local state/metrics. Inspect operating versus hard limits, and treat a budget checkpoint as distinct from administrative pause or exhausted hard authority. Persist unfinished work with LoopUpdate continue. When ready, request LoopUpdate completed with separate non-sensitive English completionEvidence. Let it run verification and JEV; do not call JEV separately or delete the loop to claim completion. Only met/unmet are completion outcomes; missing evidence is unmet. Unmet diagnoses deficient criteria and continues the same goal within the original bounds. Inspect that diagnosis, find the missing fact or failing behavior with authorized checks, then collect or repair real evidence before another review. Do not pause solely for uncertainty or repeat unchanged advice. Genuine missing authority, cancellation, expiry and failures grant no retry/fallback or extra authority. Report progress in the user's language.",
    "Original user goal (local data; translate its semantics before any JEV request):",
    JSON.stringify({ goal }),
  ].join("\n\n");
}

export function registerJevLoopCommand(options: Options): void {
  const { pi, getStore } = options;
  let pending: { goal: string; current: () => boolean } | undefined;
  const capture = createCommandGuard(options, () => { pending = undefined; });

  function hasJev(): boolean {
    const tool = pi.getAllTools().find(item => item.name === "jev_decide");
    return !!tool && tool.exposure !== "hidden" && tool.exposure !== "model-only"
      && (tool.exposure === "codemode" || tool.exposure === "deferred" || pi.getActiveTools().includes("jev_decide"));
  }

  async function start(goal: string, ctx: ExtensionCommandContext, current: () => boolean) {
    if (!goal.trim() || goal.length > 2000) {
      ctx.ui.notify("Enter a goal of 1–2000 characters with /jev-loop <goal>.", "warning"); return;
    }
    if (!VERIFICATION_SUPPORTED) { ctx.ui.notify("JEV completion currently requires POSIX verification; use ordinary /loop on this platform.", "warning"); return; }
    if (pending?.current()) { ctx.ui.notify("A setup is waiting for idle. Wait or use /jev-loop cancel before submitting another.", "warning"); return; }
    const request = { goal, current };
    pending = request;
    try {
      if (!ctx.isIdle()) {
        ctx.ui.notify("Setup waiting for the agent to become idle; no loop has been created. /jev-loop cancel revokes this pending request.", "info");
        await ctx.waitForIdle();
      }
      if (!current() || pending !== request) return;
      if (!ctx.isIdle()) { ctx.ui.notify("Agent is still busy; retry /jev-loop when idle. No request was sent.", "warning"); return; }
      if (!hasJev()) { ctx.ui.notify("Enable the public callable jev_decide tool first, then retry /jev-loop. No backend is installed or changed automatically.", "warning"); return; }
      pending = undefined;
      // No deliverAs fallback: a new busy turn must reject instead of queuing an uncancelable follow-up.
      pi.sendUserMessage(setupMessage(goal), { expandPromptTemplates: false });
      ctx.ui.notify("Setup request sent to the agent. A loop exists only after LoopCreate and native approval.", "info");
    } finally { if (pending === request) pending = undefined; }
  }

  function status(ctx: ExtensionCommandContext, id?: string) {
    const entries = getStore().list().filter(entry => entry.completion);
    const heading = pending?.current() ? `Setup waiting for idle (not a controller): ${pending.goal.slice(0, 100)}` : "No setup waiting for idle.";
    if (!id) {
      const rows = entries.map(entry => `#${entry.id} ${entry.status} · fires ${entry.fireCount ?? 0}/${entry.maxFires} · ${entry.dynamic?.awaitingUpdate ? "awaiting progress/review" : "inspect next fire"} · ${entry.prompt.replace(/\s+/g, " ").slice(0, 80)}`);
      ctx.ui.notify([heading, ...rows, rows.length ? "Use /jev-loop status <id> for criteria and recovery; reservations are not proof of execution." : "No JEV controllers. Reject any ongoing setup approval or abort its agent turn if needed."].join("\n"), "info");
      return;
    }
    const entry = entries.find(item => item.id === id);
    if (!entry) { ctx.ui.notify(`JEV loop #${id} not found. Inspect /jev-loop status; use /loop for other controller types.`, "warning"); return; }
    ctx.ui.notify([
      `JEV loop #${id}: ${entry.prompt.slice(0, 200)}`,
      ...formatLoopLifecycle(entry, { storageScope: options.getStorageScope(), nextFireAt: options.getNextFire(id) }),
      `English goal: ${entry.completion!.goal}`,
      `Criteria: ${JSON.stringify(entry.completion!.criteria)}`,
      `Verifier coverage: ${entry.completion!.verification.description}`,
      ...(entry.completionReview ? ["A review reservation exists; it does not prove local or remote execution."] : []),
    ].join("\n"), "info");
  }

  async function cancel(ctx: ExtensionCommandContext, current: () => boolean, signal: AbortSignal, id?: string) {
    if (!id && pending?.current()) {
      pending = undefined;
      ctx.ui.notify("Pending setup canceled; no controller was created by this pending request.", "info"); return;
    }
    const entries = getStore().list().filter(entry => entry.completion);
    let entry = id ? entries.find(item => item.id === id) : undefined;
    if (!id && entries.length) {
      const choices = entries.map(item => `#${item.id} ${item.prompt.replace(/\s+/g, " ").slice(0, 80)}`);
      const selected = await ctx.ui.select("Cancel a JEV loop", choices, { signal });
      if (!current() || selected === undefined) return;
      entry = entries[choices.indexOf(selected)];
    }
    if (!entry) { ctx.ui.notify("No matching JEV controller. Inspect /jev-loop status; reject an ongoing setup approval or abort its turn if no controller exists yet.", "warning"); return; }
    if (!current()) return;
    const canceled = await options.cancelLoop(entry);
    if (current()) ctx.ui.notify(canceled
      ? `JEV loop #${entry.id} canceled; owned local review drained. Remote service quiescence is not inferred.`
      : `JEV loop #${entry.id} changed; inspect /jev-loop status before canceling.`, canceled ? "info" : "warning");
  }

  pi.registerCommand("jev-loop", {
    description: "Start a JEV-assisted goal: /jev-loop <goal>. Inspect with status [id], cancel with cancel [id], or open the native dashboard (RPC menu). Setup is not approval.",
    handler: async (args, ctx) => {
      const { current, signal } = capture(ctx);
      if (!current()) return;
      if (!ctx.hasUI) { ctx.ui.notify("/jev-loop requires native TUI or RPC UI. No setup was sent.", "warning"); return; }
      try {
        const input = args.trim();
        if (input.length > 2000) { ctx.ui.notify("Use at most 2000 characters for /jev-loop goals or controls.", "warning"); return; }
        const control = input.match(/^(status|cancel)(?:\s+(\d+))?$/);
        if (control) {
          if (control[1] === "status") status(ctx, control[2]);
          else await cancel(ctx, current, signal, control[2]);
          return;
        }
        if (/^(status|cancel)(?:\s|$)/.test(input)) { ctx.ui.notify("Use /jev-loop status [id] or /jev-loop cancel [id].", "warning"); return; }
        let goal = input;
        if (!goal && ctx.mode === "tui") {
          const action = await showGoalDashboard(ctx, { entries: () => getStore().list().filter(entry => entry.completion),
            pendingGoal: () => pending?.current() ? pending.goal : undefined, phase: entry => options.getReviewPhase?.(entry),
            storageScope: options.getStorageScope, nextFire: options.getNextFire, current, signal });
          if (!current() || !action || action.type === "close") return;
          if (action.type === "cancel") {
            const accepted = await ctx.ui.confirm(`Cancel JEV loop #${action.entry.id}?`, `Cancel only this observed controller and drain its owned local review?\n${goalText(action.entry.prompt).slice(0, 200)}`, { signal });
            if (!current() || !accepted) return;
            const canceled = await options.cancelLoop(action.entry);
            if (current()) ctx.ui.notify(canceled ? `JEV loop #${action.entry.id} canceled; owned local review drained.` : "Controller changed; inspect /jev-loop before canceling again.", canceled ? "info" : "warning");
            return;
          }
          goal = (await ctx.ui.input("Goal (your language; the agent prepares English JEV policy)", undefined, { signal }))?.trim() ?? "";
          if (!current() || !goal) return;
        }
        if (!goal) {
          const action = await ctx.ui.select("JEV loop", ["Start a goal", "Status", "Cancel a loop"], { signal });
          if (!current() || action === undefined) return;
          if (action === "Status") { status(ctx); return; }
          if (action === "Cancel a loop") { await cancel(ctx, current, signal); return; }
          if (action !== "Start a goal") { ctx.ui.notify("Choose an offered /jev-loop menu action.", "warning"); return; }
          goal = (await ctx.ui.input("Goal (your language; the agent prepares English JEV policy)", undefined, { signal }))?.trim() ?? "";
          if (!current() || !goal) return;
        }
        await start(goal, ctx, current);
      } catch (error) {
        if (current()) ctx.ui.notify(`${error instanceof Error ? error.message.slice(0, 500) : "JEV command failed."} Inspect /jev-loop status before retrying.`, "error");
      }
    },
  });
}
