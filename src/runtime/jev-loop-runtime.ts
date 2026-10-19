import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { VERIFICATION_SUPPORTED, type VerificationOptions, type VerificationResult, verifyCompletion } from "../completion-verifier.js";
import { COMPLETION_EVIDENCE_LIMIT, type CompletionPolicy, completionPacket, englishSummary, REVIEW_TIMEOUT_MS, readCompletionAdvice, VERIFICATION_TIMEOUT_MS, validateCompletionPolicy } from "../jev-completion.js";
import { atMaxFires } from "../loop-reducer.js";
import type { LoopEntry } from "../types.js";

export interface CompletionStore {
  get(id: string): LoopEntry | undefined;
  reserveCompletionReview?(id: string, snapshot: string, review: NonNullable<LoopEntry["completionReview"]>): LoopEntry | undefined;
  releaseCompletionReview?(id: string, reviewId: string): void;
  stopDynamic(id: string, status: "completed" | "paused", expected: { status: LoopEntry["status"]; iteration: number; updatedAt: number; completionSnapshot?: string }): boolean;
}
interface Options {
  pi: ExtensionAPI;
  getStore: () => CompletionStore;
  getGeneration?: () => number;
  isContextCurrent?: (ctx: ExtensionToolContext) => boolean;
  verify?: (command: string, args: string[], options: VerificationOptions) => Promise<VerificationResult>;
}
class StaleCompletionScopeError extends Error {}

function approvalText(policy: CompletionPolicy, cwd: string, maxFires: number, expiresAt: number): string {
  return [
    "Approve this exact JEV-assisted loop setup for this live session only?",
    JSON.stringify({ goal: policy.goal, criteria: policy.criteria, verification: policy.verification, cwd, maxFires, expiresAt: new Date(expiresAt).toISOString() }, null, 2),
    `Verifier timeout: ${VERIFICATION_TIMEOUT_MS} ms. Review timeout: ${REVIEW_TIMEOUT_MS} ms; neither extends expiry or fires.`,
    `Disclosure to public jev_decide: English goal, ALL criteria, verifier description, actual exit outcome, and a separate untrusted English progress summary of at most ${COMPLETION_EVIDENCE_LIMIT} characters (packet at most 4000).`,
    "Caller must supply non-sensitive English prose only: no original prompts, source/code, paths, argv, logs, history or secrets. Local state/metrics and raw verifier output are never collected for JEV.",
    "The command is not sandboxed and inherits the process environment; approve its side effects. Existing tool/permission/transmission gates still apply. JEV is advisory, never permission or proof. Completion requires passed verification AND supported met advice. Nonzero verifier exits permit repair within scope without another setup approval. Provider errors, invalid execution, cancellation and restart require fresh approval.",
  ].join("\n\n");
}
function available(ctx: ExtensionToolContext): boolean {
  return typeof ctx?.executeTool === "function" && ctx.tools?.some(tool => tool.name === "jev_decide");
}
function fingerprint(entry: LoopEntry): string {
  return JSON.stringify([entry.id, entry.createdAt, entry.completionId, entry.completionCwd, entry.completion, entry.maxFires, entry.expiresAt]);
}
function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("Review cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export function createJevLoopRuntime(options: Options) {
  let epoch = 0;
  let closed = false;
  const approvals = new Map<string, { store: CompletionStore; scope: string; id: string }>();
  const busy = new Set<string>();
  const previous = new Map<string, string>();
  const owned = new Set<AbortController>();
  const processes = new Set<Promise<unknown>>();
  const reviews = new Map<string, { abort: () => void; done: Promise<void> }>();

  function scope(ctx: ExtensionToolContext, expiresAt: number, caller?: AbortSignal) {
    const store = options.getStore();
    const generation = options.getGeneration?.();
    const startedEpoch = epoch;
    const cwd = ctx.cwd;
    const session = ctx.sessionManager.getSessionId();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...[caller, ctx.signal].filter((value): value is AbortSignal => !!value)]);
    const timer = setTimeout(() => controller.abort(), Math.max(0, Math.min(REVIEW_TIMEOUT_MS, expiresAt - Date.now())));
    owned.add(controller);
    const key = JSON.stringify([epoch, generation, session, cwd]);
    function check() {
      if (closed || signal.aborted || startedEpoch !== epoch || generation !== options.getGeneration?.() || store !== options.getStore()
        || ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== session || options.isContextCurrent?.(ctx) === false || Date.now() >= expiresAt) {
        throw new StaleCompletionScopeError("Stale or cancelled completion scope; inspect LoopList and resubmit in the current session.");
      }
    }
    return { store, cwd, signal, key, check, abort: () => controller.abort(), dispose: () => { clearTimeout(timer); owned.delete(controller); } };
  }

  async function confirm(ctx: ExtensionToolContext, policy: CompletionPolicy, maxFires: number, expiresAt: number, operation: ReturnType<typeof scope>) {
    operation.check();
    if (!ctx.hasUI || !available(ctx)) throw new Error("Completion needs native UI and public jev_decide; enable them before resubmitting.");
    const accepted = await cancellable(ctx.ui.confirm("Approve JEV loop", approvalText(policy, operation.cwd, maxFires, expiresAt), { signal: operation.signal }), operation.signal);
    operation.check();
    if (!accepted) throw new Error("Completion setup declined; stop. A fresh explicit user request is required before another approval.");
    if (!available(ctx)) throw new Error("Public jev_decide unavailable; enable it before a fresh explicit setup request.");
  }

  async function setup(ctx: ExtensionToolContext, policy: CompletionPolicy, maxFires: number, expiresAt: number, caller?: AbortSignal) {
    validateCompletionPolicy(policy);
    if (!VERIFICATION_SUPPORTED) throw new Error("JEV verification currently requires POSIX process-group cleanup.");
    const operation = scope(ctx, expiresAt, caller);
    try {
      for (const [key, approval] of approvals) {
        const current = approval.store === operation.store ? operation.store.get(approval.id) : undefined;
        if (!current || fingerprint(current) !== key) {
          approvals.delete(key);
          previous.delete(key);
        }
      }
      await confirm(ctx, policy, maxFires, expiresAt, operation);
      operation.check();
      return {
        check: operation.check,
        remember(entry: LoopEntry) {
          operation.check();
          approvals.set(fingerprint(entry), { store: operation.store, scope: operation.key, id: entry.id });
        },
      };
    } finally { operation.dispose(); }
  }

  async function review(entry: LoopEntry, evidence: unknown, ctx: ExtensionToolContext, caller?: AbortSignal) {
    const held = (message: string) => ({ completed: false, message });
    if (!VERIFICATION_SUPPORTED) return held("JEV verification currently requires POSIX process-group cleanup.");
    if (!englishSummary(evidence, COMPLETION_EVIDENCE_LIMIT)) return held("Supply separate English completionEvidence of 1–1024 characters, without private data; completion held.");
    if (busy.has(entry.id)) return held("A completion review is already in progress; wait for its result.");
    const policy = entry.completion!;
    validateCompletionPolicy(policy);
    // Reject oversize escaping before approval or a process can start.
    completionPacket(policy, evidence, 0);
    const key = fingerprint(entry);
    const attempt = JSON.stringify([entry.completionVersion, evidence]);
    if (previous.get(key) === attempt) return held("Completion held; supply additional evidence rather than repeating unchanged advice.");
    const operation = scope(ctx, entry.expiresAt, caller);
    const reviewId = randomUUID();
    let snapshot = "";
    let retainApproval = false;
    busy.add(entry.id);
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    reviews.set(key, { abort: operation.abort, done });
    function check() {
      operation.check();
      if (JSON.stringify(operation.store.get(entry.id)) !== snapshot) throw new StaleCompletionScopeError("Controller changed during review; inspect LoopList and resubmit.");
    }
    try {
      operation.check();
      if (entry.completionCwd !== operation.cwd || !available(ctx)
        || (entry.status !== "active" && !(entry.pause?.kind === "controller_limit" && atMaxFires(entry)))) {
        return held("Completion held; use the original working directory and public jev_decide, and inspect the pause before resubmitting.");
      }
      const reserved = operation.store.reserveCompletionReview?.(entry.id, JSON.stringify(entry), { id: reviewId, expiresAt: Math.min(entry.expiresAt, Date.now() + REVIEW_TIMEOUT_MS) });
      if (!reserved) return held("Completion review already in progress or controller changed; inspect LoopList and wait before resubmitting.");
      snapshot = JSON.stringify(reserved);
      const approval = approvals.get(key);
      if (approval?.store !== operation.store || approval.scope !== operation.key) {
        try { await confirm(ctx, policy, entry.maxFires!, entry.expiresAt, operation); }
        catch {
          check();
          return held("Completion held: setup review did not finish with valid approval. Stop here; a fresh explicit user request is required before another approval.");
        }
        check();
        approvals.set(key, { store: operation.store, scope: operation.key, id: entry.id });
      }
      check();
      let verified: VerificationResult;
      try {
        const process = (options.verify ?? verifyCompletion)(policy.verification.command, [...policy.verification.args], { cwd: operation.cwd, timeout: VERIFICATION_TIMEOUT_MS, signal: operation.signal });
        processes.add(process);
        try { verified = await process; } finally { processes.delete(process); }
      } catch {
        check();
        return held("Completion held: the fixed verifier could not start or finish. Inspect its command locally; if it is wrong, cancel and recreate with the correct approved scope.");
      }
      check();
      if (verified.killed || verified.signal || verified.code === null || !Number.isInteger(verified.code)) return held("Verification cancelled or invalid; inspect locally and resubmit with fresh approval.");
      if (verified.code !== 0) {
        retainApproval = true;
        return held(`unmet: required verification failed. ${atMaxFires(entry) ? "Fire cap exhausted; inspect or cancel, never resume." : "Repair and continue within the existing fire budget; no new setup approval is needed."}`);
      }
      if (!available(ctx)) return held("Public jev_decide unavailable; restore it and explicitly resubmit with approval.");
      let advice: ReturnType<typeof readCompletionAdvice>;
      try {
        const result = await cancellable(ctx.executeTool("jev_decide", completionPacket(policy, evidence, verified.code), { signal: operation.signal }), operation.signal);
        advice = readCompletionAdvice(result);
      } catch {
        check();
        return held("Completion held: the JEV decision was unavailable, blocked or malformed. Inspect provider availability and tool permissions; do not retry automatically.");
      }
      check();
      if (advice.status === "needs_user") {
        return { completed: false, message: `needs_user: pass askUser unchanged to ask_user; if unavailable stop.\n${JSON.stringify(advice.askUser)}`, askUser: advice.askUser };
      }
      const choice = advice.reply.choice;
      if (choice !== "met") {
        retainApproval = true;
        previous.set(key, attempt);
        return held(`${choice}: completion held. ${atMaxFires(entry) ? "Fire cap exhausted; no continue/resume." : choice === "unmet" ? "Continue only within the existing budget." : "Supply permitted additional evidence for explicit review; unknown is not completion."}`);
      }
      check();
      const completed = operation.store.stopDynamic(entry.id, "completed", {
        status: reserved.status, iteration: reserved.dynamic!.iteration, updatedAt: reserved.updatedAt, completionSnapshot: snapshot,
      });
      return { completed, message: completed ? `Dynamic loop #${entry.id} completed and deleted` : "Controller changed during final completion; inspect LoopList and resubmit." };
    } catch (error) {
      // Store failures can follow a write; only known scope rejection is a clean hold.
      if (!(error instanceof StaleCompletionScopeError)) throw error;
      return held("Completion held: controller or session changed, or the review was canceled/expired. Inspect LoopList in the current session; no retry is authorized without fresh authority.");
    } finally {
      if (!retainApproval) { approvals.delete(key); previous.delete(key); }
      try { operation.store.releaseCompletionReview?.(entry.id, reviewId); }
      finally {
        reviews.delete(key);
        busy.delete(entry.id);
        operation.dispose();
        finished();
      }
    }
  }

  async function cancel(entry: LoopEntry) {
    const key = fingerprint(entry);
    approvals.delete(key); previous.delete(key);
    const review = reviews.get(key);
    review?.abort();
    await review?.done;
  }

  async function shutdown() {
    closed = true;
    epoch++;
    approvals.clear(); previous.clear();
    for (const controller of owned) controller.abort();
    await Promise.allSettled([...processes, ...[...reviews.values()].map(review => review.done)]);
  }
  options.pi.on("session_shutdown", shutdown);
  options.pi.on("session_start", () => { closed = false; epoch++; approvals.clear(); previous.clear(); });
  return { setup, review, cancel, shutdown };
}
