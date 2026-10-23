import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { type BudgetBounds, budgetBounds, budgetEvidenceHash, budgetPacket, budgetTiers, operatingBudgetExhausted } from "../adaptive-budget.js";
import { VERIFICATION_SUPPORTED, type VerificationOptions, type VerificationResult, verifyCompletion } from "../completion-verifier.js";
import { COMPLETION_CONTEXT_LIMIT, COMPLETION_EVIDENCE_LIMIT, type CompletionPolicy, completionPacket, completionPolicyFitsPacket, englishSummary, readCompletionAdvice, VERIFICATION_TIMEOUT_MS, validateCompletionPolicy } from "../jev-completion.js";
import { atMaxFires } from "../loop-reducer.js";
import type { AdaptiveBudgetState, LoopEntry } from "../types.js";
import { confirmCompletionApproval } from "../ui/completion-approval.js";

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface CompletionStore {
  get(id: string): LoopEntry | undefined;
  reserveCompletionReview?(id: string, snapshot: string, review: NonNullable<LoopEntry["completionReview"]>): LoopEntry | undefined;
  releaseCompletionReview?(id: string, reviewId: string): void;
  updateAdaptiveBudget?(id: string, snapshot: string, budget: AdaptiveBudgetState): LoopEntry | undefined;
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
class BudgetDecisionError extends Error {}
export interface CompletionReviewResult {
  completed: boolean;
  message: string;
  reworkScope?: () => void;
  askUser?: Extract<ReturnType<typeof readCompletionAdvice>, { status: "needs_user" }>["askUser"];
}

interface BudgetApproval { bounds: BudgetBounds; startedAt?: number }
interface SetupBudget { maxFires: number; expiresAt: number; adaptive?: BudgetBounds; startedAt?: number }
function approvalText(policy: CompletionPolicy, cwd: string, maxFires: number, expiresAt: number, adaptive?: BudgetApproval): string {
  return [
    "Approve this exact JEV-assisted loop setup for this live session only?",
    JSON.stringify({ goal: policy.goal, criteria: policy.criteria, verification: policy.verification, cwd, maxFires,
      ...(adaptive ? { adaptiveBudgetRange: adaptive.bounds, approvalRequestExpiresAt: new Date(expiresAt).toISOString(),
        hardWindowStart: adaptive.startedAt ?? "Once at this genuine approval; waiting does not consume execution lifetime",
        hardExecutionLifetimeMs: adaptive.bounds.maxLifetimeMs } : { expiresAt: new Date(expiresAt).toISOString() }) }, null, 2),
    `Verifier timeout: ${VERIFICATION_TIMEOUT_MS} ms. Approval and completion review wait until ${adaptive ? "the shown deadline" : "loop expiry"} or cancellation; there is no separate 120-second limit. ${adaptive ? "JEV selects and may extend operating allocations only inside this immutable total envelope. The original execution start, hard deadline and total fire cap never reset. Budget advice uses goal/criteria, safe numeric facts and a separate English budget summary; at most four binary comparisons initially and after each fire. No raw state/metrics or private artifacts are sent." : "Expiry and fire budgets are never extended."}`,
    `Disclosure to public jev_decide: English goal, ALL criteria, verifier description, actual exit outcome, and a separate untrusted English progress summary of at most ${COMPLETION_EVIDENCE_LIMIT} characters (packet at most ${COMPLETION_CONTEXT_LIMIT}). One overall binary assessment; if unmet, up to ${policy.criteria.length} focused criterion diagnoses with the same full context. Diagnosis is advisory, never consent. Unmet work continues only within the original scope and budget.`,
    "Caller must supply non-sensitive English prose only: no original prompts, source/code, paths, argv, logs, history or secrets. Local state/metrics and raw verifier output are never collected for JEV.",
    "The command is not sandboxed and inherits the process environment; approve its side effects. Existing tool/permission/transmission gates still apply. JEV is advisory, never permission or proof. Completion requires passed verification AND supported met advice. Nonzero verifier exits permit repair within scope without another setup approval. Provider errors, invalid execution, cancellation and restart require fresh approval.",
  ].join("\n\n");
}
function available(ctx: ExtensionToolContext): boolean {
  return typeof ctx?.executeTool === "function" && ctx.tools?.some(tool => tool.name === "jev_decide");
}
function fingerprint(entry: LoopEntry): string {
  return JSON.stringify([entry.id, entry.createdAt, entry.completionId, entry.completionCwd, entry.completion, entry.maxFires, entry.expiresAt, ...(entry.adaptiveBudget ? [entry.adaptiveBudget.startedAt] : [])]);
}
function cancellable<T>(promise: Promise<T>, signal: AbortSignal, interruption: () => Error): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(interruption());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export type CompletionReviewPhase = "checking" | "approval" | "verification" | "advice";

export function createJevLoopRuntime(options: Options) {
  let epoch = 0;
  let closed = false;
  const approvals = new Map<string, { store: CompletionStore; scope: string; id: string }>();
  const busy = new Set<string>();
  const previous = new Map<string, string>();
  const owned = new Set<AbortController>();
  const processes = new Set<Promise<unknown>>();
  const reviews = new Map<string, { abort: () => void; done: Promise<void>; phase: CompletionReviewPhase;
    reviewId: string; store: CompletionStore; epoch: number; generation: number | undefined; signal: AbortSignal }>();

  function getReviewPhase(entry: LoopEntry): CompletionReviewPhase | undefined {
    const local = reviews.get(fingerprint(entry));
    if (!local || closed || local.signal.aborted || local.epoch !== epoch || local.generation !== options.getGeneration?.()
      || local.store !== options.getStore() || entry.completionReview?.id !== local.reviewId) return undefined;
    return local.phase;
  }

  function scope(ctx: ExtensionToolContext, expiresAt: number, caller?: AbortSignal) {
    const store = options.getStore();
    const generation = options.getGeneration?.();
    const startedEpoch = epoch;
    const cwd = ctx.cwd;
    const session = ctx.sessionManager.getSessionId();
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, ...[caller, ctx.signal].filter((value): value is AbortSignal => !!value)]);
    const deadline = expiresAt;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Node/Bun truncate very long timer delays; re-arm against the actual expiry.
    function scheduleExpiry() {
      const scheduled = setTimeout(() => {
        if (timer !== scheduled) return;
        timer = undefined;
        if (signal.aborted) return;
        if (Date.now() < deadline) { scheduleExpiry(); return; }
        controller.abort();
      }, Math.min(Math.max(1, deadline - Date.now()), MAX_TIMER_DELAY_MS));
      timer = scheduled;
    }
    scheduleExpiry();
    owned.add(controller);
    const key = JSON.stringify([epoch, generation, session, cwd]);
    function interruption() {
      let cause = "JEV approval/review cancelled by the caller or active context";
      if (closed || startedEpoch !== epoch) cause = "JEV approval/review cancelled because the session ended or changed";
      else if (Date.now() >= expiresAt) cause = "Loop lifetime expired during JEV approval/review";
      return new Error(`${cause}; no retry or completion was authorized. A fresh explicit user request and approval are required for another attempt.`);
    }
    function check() {
      if (signal.aborted || Date.now() >= deadline) throw new StaleCompletionScopeError(interruption().message);
      if (closed || startedEpoch !== epoch || generation !== options.getGeneration?.() || store !== options.getStore()
        || ctx.cwd !== cwd || ctx.sessionManager.getSessionId() !== session || options.isContextCurrent?.(ctx) === false) {
        throw new StaleCompletionScopeError("Stale or cancelled completion scope; inspect LoopList and resubmit in the current session.");
      }
    }
    return { store, cwd, signal, deadline, key, check, interruption, abort: () => controller.abort(), dispose: () => { clearTimeout(timer); timer = undefined; owned.delete(controller); } };
  }

  async function confirm(ctx: ExtensionToolContext, policy: CompletionPolicy, budget: SetupBudget, operation: ReturnType<typeof scope>) {
    operation.check();
    if (!ctx.hasUI || !available(ctx)) throw new Error("Completion needs native UI and public jev_decide; enable them before resubmitting.");
    const reportAttention = ctx.mode === "tui";
    // Host attention is a display signal, never consent or execution authority.
    if (reportAttention) options.pi.events.emit("herdr:blocked", { active: true, label: "Waiting for user response" });
    try {
      const accepted = await cancellable(confirmCompletionApproval(ctx, approvalText(policy, operation.cwd, budget.maxFires, budget.expiresAt, budget.adaptive ? { bounds: budget.adaptive, startedAt: budget.startedAt } : undefined), operation), operation.signal, operation.interruption);
      operation.check();
      if (!accepted) throw new Error("Completion setup declined or dismissed; stop. A fresh explicit user request is required before another approval.");
      if (!available(ctx)) throw new Error("Public jev_decide unavailable; enable it before a fresh explicit setup request.");
    } finally {
      if (reportAttention) options.pi.events.emit("herdr:blocked", { active: false });
    }
  }

  async function selectBudget(ctx: ExtensionToolContext, input: { policy: CompletionPolicy; bounds: BudgetBounds; current?: AdaptiveBudgetState; fireCount: number; evidence: string; operation: ReturnType<typeof scope>; check: () => void }) {
    const { policy, bounds, current, fireCount, evidence, operation, check } = input;
    let assessments = 0;
    async function chooseAxis(axis: "fires" | "lifetime", minimum: number, maximum: number) {
      const tiers = budgetTiers(minimum, maximum);
      let chosen = tiers[0]!;
      for (const higher of tiers.slice(1)) {
        check();
        if (!available(ctx)) throw new BudgetDecisionError("Public JEV budget decision unavailable; no retry or fallback.");
        const packet = budgetPacket(policy, bounds, current, fireCount, evidence, axis, chosen, higher);
        let advice: ReturnType<typeof readCompletionAdvice>;
        try {
          const answer = await cancellable(ctx.executeTool("jev_decide", packet, { signal: operation.signal }), operation.signal, operation.interruption);
          advice = readCompletionAdvice(answer, packet.options);
        } catch {
          check();
          throw new BudgetDecisionError("JEV budget decision failed, was blocked or malformed; no extension, retry or fallback.");
        }
        check();
        if (advice.status === "needs_user") throw new BudgetDecisionError(`needs_user: pass askUser unchanged to ask_user; if unavailable stop.\n${JSON.stringify(advice.askUser)}`);
        assessments++;
        if (advice.reply.choice === "budget_higher") chosen = higher;
      }
      return chosen;
    }
    const fireLimit = await chooseAxis("fires", current?.fireLimit ?? bounds.minFires, bounds.maxFires);
    const lifetimeMs = await chooseAxis("lifetime", current ? current.expiresAt - current.startedAt : bounds.minLifetimeMs, bounds.maxLifetimeMs);
    check();
    return { fireLimit, lifetimeMs, assessments };
  }

  async function setup(ctx: ExtensionToolContext, policy: CompletionPolicy, budget: SetupBudget, caller?: AbortSignal) {
    validateCompletionPolicy(policy);
    if (!completionPolicyFitsPacket(policy)) throw new Error("Completion policy cannot fit the JEV packet bound with even minimum evidence; shorten the English goal, criteria or verifier description before setup approval.");
    if (!VERIFICATION_SUPPORTED) throw new Error("JEV verification currently requires POSIX process-group cleanup.");
    let expiresAt = budget.expiresAt;
    let operation = scope(ctx, expiresAt, caller);
    try {
      for (const [key, approval] of approvals) {
        const current = approval.store === operation.store ? operation.store.get(approval.id) : undefined;
        if (!current || fingerprint(current) !== key) {
          approvals.delete(key);
          previous.delete(key);
        }
      }
      await confirm(ctx, policy, budget, operation);
      operation.check();
      let adaptiveBudget: AdaptiveBudgetState | undefined;
      if (budget.adaptive) {
        const startedAt = Date.now();
        expiresAt = startedAt + budget.adaptive.maxLifetimeMs;
        if (!Number.isSafeInteger(expiresAt)) throw new Error("Adaptive hard deadline exceeds the safe time range.");
        operation.dispose();
        operation = scope(ctx, expiresAt, caller);
        const selected = await selectBudget(ctx, { policy, bounds: budget.adaptive, fireCount: 0, evidence: "Initial allocation after exact native range approval.", operation, check: operation.check });
        adaptiveBudget = { startedAt, fireLimit: selected.fireLimit, expiresAt: startedAt + selected.lifetimeMs, revision: 0, lastReviewedFireCount: 0 };
      }
      return {
        expiresAt,
        adaptiveBudget,
        check: operation.check,
        remember(entry: LoopEntry) {
          operation.check();
          approvals.set(fingerprint(entry), { store: operation.store, scope: operation.key, id: entry.id });
        },
      };
    } finally { operation.dispose(); }
  }

  async function adjustBudget(entry: LoopEntry, evidence: unknown, ctx: ExtensionToolContext, caller?: AbortSignal): Promise<{ entry?: LoopEntry; check?: () => void; message: string }> {
    const current = entry.adaptiveBudget;
    if (!current || !entry.completion?.budgetRange) return { entry, message: "Fixed budget unchanged." };
    const summary = evidence === undefined ? "No additional progress evidence supplied." : evidence;
    if (!englishSummary(summary, COMPLETION_EVIDENCE_LIMIT)) return { message: "Supply separate bounded non-sensitive English budgetEvidence; local state/metrics are never used." };
    const hash = budgetEvidenceHash(summary);
    if (Date.now() >= entry.expiresAt || atMaxFires(entry)
      || (entry.status !== "active" && entry.pause?.kind !== "budget_limit")) return { message: "Adaptive budget held: hard limit, expiry or administrative pause cannot be renewed." };
    if (busy.has(entry.id)) return { message: "A review is already in progress; no duplicate budget assessment." };
    const policy = entry.completion;
    const bounds = budgetBounds(policy, entry.maxFires!, entry.expiresAt - current.startedAt)!;
    budgetPacket(policy, bounds, current, entry.fireCount ?? 0, summary, "fires", current.fireLimit, bounds.maxFires);
    const operation = scope(ctx, entry.expiresAt, caller); const key = fingerprint(entry); const reviewId = randomUUID();
    let snapshot = ""; let retainApproval = false; let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    busy.add(entry.id);
    const observation = { abort: operation.abort, done, phase: "checking" as CompletionReviewPhase, reviewId,
      store: operation.store, epoch, generation: options.getGeneration?.(), signal: operation.signal };
    reviews.set(key, observation);
    const check = () => { operation.check(); if (JSON.stringify(operation.store.get(entry.id)) !== snapshot) throw new StaleCompletionScopeError("Controller changed during budget review; inspect LoopList."); };
    try {
      operation.check();
      if (entry.completionCwd !== operation.cwd || !available(ctx)) return { message: "Budget held: use the original working directory and public JEV tool." };
      const reserved = operation.store.reserveCompletionReview?.(entry.id, JSON.stringify(entry), { id: reviewId, expiresAt: entry.expiresAt });
      if (!reserved) return { message: "Budget held: another review or controller change owns this attempt." };
      snapshot = JSON.stringify(reserved);
      const approval = approvals.get(key);
      if (approval?.store !== operation.store || approval.scope !== operation.key) {
        observation.phase = "approval";
        try { await confirm(ctx, policy, { maxFires: entry.maxFires!, expiresAt: entry.expiresAt, adaptive: bounds, startedAt: current.startedAt }, operation); }
        catch (error) { check(); return { message: error instanceof Error ? error.message : "Budget approval was not granted; no retry." }; }
        check(); approvals.set(key, { store: operation.store, scope: operation.key, id: entry.id });
      }
      if (current.lastReviewedFireCount === (entry.fireCount ?? 0) && (evidence === undefined || current.evidenceHash === hash)) {
        retainApproval = true;
        return operatingBudgetExhausted(entry) ? { message: "Operating budget checkpoint remains exhausted; supply genuinely new budget evidence or inspect it. No unchanged review." } : { entry, check: operation.check, message: "This fire's budget was already assessed; allocation unchanged." };
      }
      observation.phase = "advice";
      const selected = await selectBudget(ctx, { policy, bounds, current, fireCount: entry.fireCount ?? 0, evidence: summary, operation, check });
      check();
      const updated = operation.store.updateAdaptiveBudget?.(entry.id, snapshot, { ...current, fireLimit: selected.fireLimit,
        expiresAt: current.startedAt + selected.lifetimeMs, revision: current.revision + 1,
        lastReviewedFireCount: entry.fireCount ?? 0, evidenceHash: hash });
      if (!updated) return { message: "Budget held: controller changed before allocation commit; no extension acknowledged." };
      retainApproval = true;
      return { entry: updated, check: operation.check, message: selected.assessments === 0 ? "Only one authorized allocation remains; no JEV budget assessment was needed and the hard envelope is unchanged." : operatingBudgetExhausted(updated) ? "JEV retained the exhausted operating allocation; hard envelope unchanged." : "JEV operating allocation selected inside the unchanged hard envelope." };
    } catch (error) {
      if (error instanceof BudgetDecisionError || error instanceof StaleCompletionScopeError) return { message: error.message };
      throw error;
    } finally {
      if (!retainApproval) { approvals.delete(key); previous.delete(key); }
      try { operation.store.releaseCompletionReview?.(entry.id, reviewId); }
      finally { reviews.delete(key); busy.delete(entry.id); operation.dispose(); finished(); }
    }
  }

  async function review(entry: LoopEntry, evidence: unknown, ctx: ExtensionToolContext, caller?: AbortSignal): Promise<CompletionReviewResult> {
    const held = (message: string) => ({ completed: false, message });
    const rework = (message: string) => ({ completed: false, reworkScope: () => operation.check(), message: `unmet: ${message} ${atMaxFires(entry) ? "Fire cap exhausted; no continue/resume." : "Inspect the actual local evidence, identify the missing fact or failing behavior, then collect or repair within the approved scope. Continue this goal; do not pause solely because it is unmet or repeat unchanged advice."}` });
    if (!VERIFICATION_SUPPORTED) return held("JEV verification currently requires POSIX process-group cleanup.");
    if (!englishSummary(evidence, COMPLETION_EVIDENCE_LIMIT)) return held("Supply separate English completionEvidence of 1–1024 characters, without private data; completion held.");
    const progressSummary = evidence;
    if (busy.has(entry.id)) return held("A completion review is already in progress; wait for its result.");
    const policy = entry.completion!;
    validateCompletionPolicy(policy);
    if (!completionPolicyFitsPacket(policy)) return held("Completion held: the immutable policy cannot fit the JEV packet bound. Explicitly cancel and recreate with shorter English goal, criteria or verifier description; shortening evidence alone cannot fix this policy.");
    // Reject oversize escaping before approval or a process can start.
    completionPacket(policy, evidence, 0);
    const key = fingerprint(entry);
    const attempt = evidence;
    if (previous.get(key) === attempt) return held("Completion held; supply additional evidence rather than repeating unchanged advice.");
    const operation = scope(ctx, entry.expiresAt, caller);
    const reviewId = randomUUID();
    let snapshot = "";
    let retainApproval = false;
    busy.add(entry.id);
    let finished!: () => void;
    const done = new Promise<void>(resolve => { finished = resolve; });
    const observation = { abort: operation.abort, done, phase: "checking" as CompletionReviewPhase, reviewId,
      store: operation.store, epoch, generation: options.getGeneration?.(), signal: operation.signal };
    reviews.set(key, observation);
    function check() {
      operation.check();
      if (JSON.stringify(operation.store.get(entry.id)) !== snapshot) throw new StaleCompletionScopeError("Controller changed during review; inspect LoopList and resubmit.");
    }
    try {
      operation.check();
      if (entry.completionCwd !== operation.cwd || !available(ctx)
        || (entry.status !== "active" && !(entry.pause?.kind === "controller_limit" && atMaxFires(entry)) && !(entry.pause?.kind === "budget_limit" && entry.adaptiveBudget))) {
        return held("Completion held; use the original working directory and public jev_decide, and inspect the pause before resubmitting.");
      }
      const reserved = operation.store.reserveCompletionReview?.(entry.id, JSON.stringify(entry), { id: reviewId, expiresAt: entry.expiresAt });
      if (!reserved) return held("Completion review already in progress or controller changed; inspect LoopList and wait before resubmitting.");
      snapshot = JSON.stringify(reserved);
      const approval = approvals.get(key);
      if (approval?.store !== operation.store || approval.scope !== operation.key) {
        observation.phase = "approval";
        try { await confirm(ctx, policy, { maxFires: entry.maxFires!, expiresAt: entry.expiresAt,
          ...(entry.adaptiveBudget ? { adaptive: budgetBounds(policy, entry.maxFires!, entry.expiresAt - entry.adaptiveBudget.startedAt), startedAt: entry.adaptiveBudget.startedAt } : {}) }, operation); }
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
        observation.phase = "verification";
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
        previous.set(key, attempt);
        return rework(`The fixed verification exited with code ${verified.code}. Inspect the approved check locally and repair its underlying failure; no speculative JEV call or new setup approval is needed.`);
      }
      if (!available(ctx)) return held("Public jev_decide unavailable; restore it and explicitly resubmit with approval.");
      const verificationCode = verified.code;
      async function assess(criterionIndex?: number) {
        check();
        if (!available(ctx)) return undefined;
        let answer: ReturnType<typeof readCompletionAdvice>;
        try {
          const result = await cancellable(ctx.executeTool("jev_decide", completionPacket(policy, progressSummary, verificationCode, criterionIndex), { signal: operation.signal }), operation.signal, operation.interruption);
          answer = readCompletionAdvice(result);
        } catch {
          check();
          return undefined;
        }
        check();
        return answer;
      }
      observation.phase = "advice";
      const advice = await assess();
      if (!advice) return held("Completion held: the JEV decision was unavailable, blocked or malformed. Inspect provider availability and tool permissions; do not retry automatically.");
      if (advice.status === "needs_user") {
        return { completed: false, message: `needs_user: pass askUser unchanged to ask_user; if unavailable stop.\n${JSON.stringify(advice.askUser)}`, askUser: advice.askUser };
      }
      if (advice.reply.choice === "unmet") {
        const deficient: string[] = [];
        for (let index = 0; index < policy.criteria.length; index++) {
          const diagnosis = await assess(index);
          if (!diagnosis) return held("Completion held: a criterion diagnosis was unavailable, blocked or malformed. Inspect locally; no continuation or automatic retry was authorized.");
          if (diagnosis.status === "needs_user") return { completed: false, message: `needs_user: pass askUser unchanged to ask_user; if unavailable stop.\n${JSON.stringify(diagnosis.askUser)}`, askUser: diagnosis.askUser };
          if (diagnosis.reply.choice === "unmet") deficient.push(`Unmet criterion ${index + 1}: ${policy.criteria[index]}`);
        }
        retainApproval = true;
        previous.set(key, attempt);
        return rework(deficient.length ? deficient.join("\n") : "The aggregate and criterion-level assessments conflict. Reconcile combined goal coverage and current observations; individual met diagnoses do not override the aggregate unmet result.");
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
  function recordProgress(before: LoopEntry, after: LoopEntry) {
    const key = fingerprint(after);
    // Control versions also change on wakes; only declared work progress renews evidence.
    if (fingerprint(before) === key && (before.dynamic?.state !== after.dynamic?.state || before.dynamic?.metrics !== after.dynamic?.metrics)) previous.delete(key);
  }
  return { setup, adjustBudget, review, cancel, shutdown, getReviewPhase, recordProgress };
}
