import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { LoopStore } from "../../src/store.js";
import { TaskStore } from "../../src/task-store.js";
import type { WorkflowDefinition, WorkflowRuntimeActor } from "../../src/types.js";
import { propertyOptions } from "./config.js";

const definition: WorkflowDefinition = {
  version: 1,
  initialState: "left",
  states: {
    left: { prompt: "Left work.", task: { subject: "Left", description: "Inspect prior effects." }, maxAttempts: 100, on: { next: "right", finish: "done" } },
    right: { prompt: "Right work.", task: { subject: "Right", description: "Inspect prior effects." }, maxAttempts: 100, on: { next: "left", finish: "done" } },
    done: { prompt: "Done.", terminal: "completed" },
  },
};

type Identity = { currentState: string; transitionSeq: number; definitionRevision: number; activeExecutionId: string };
type Lease = { actor: WorkflowRuntimeActor; acquiredAt: number; heartbeatAt: number; expiresAt: number; attempt: number };
const actions = ["restart", "claim", "boundary", "next", "reissue", "pause", "resume", "invalid", "remember", "cas"] as const;
const command = fc.record({
  action: fc.constantFrom(...actions),
  previous: fc.boolean(),
  seconds: fc.integer({ min: 60, max: 3600 }),
  edge: fc.constantFrom(-1, 0, 1),
});

function bytes(path: string) {
  // First creation has no recovery snapshot; absence itself is part of the oracle.
  return [readFileSync(path, "utf8"), existsSync(`${path}.prev`) ? readFileSync(`${path}.prev`, "utf8") : undefined];
}

describe("file-backed workflow restart sequence properties", () => {
  it("preserves ownership/CAS on reload and permits eligible recovery without resetting work", () => {
    const options = { ...propertyOptions(25, 1000), seed: propertyOptions(25, 1000).seed ?? 0x5eed };
    const coverage: Record<string, number> = {};
    let completed = 0;
    console.log(JSON.stringify({ campaign: "workflow-restart", runs: options.numRuns, seed: options.seed ?? "generated", maxCommands: 32, limits: "Store-level fresh actors; no OS death, UI, monitor, lifetime/cap exhaustion or automatic effects" }));
    fc.assert(fc.property(fc.array(command, { minLength: 8, maxLength: 32 }), (commands) => {
      const dir = mkdtempSync(join(tmpdir(), "pi-loop-restart-property-"));
      const path = join(dir, "loops.json");
      let now = Date.UTC(2026, 0, 1);
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      let runtime = 0;
      let actor: WorkflowRuntimeActor = { sessionId: "same-session", runtimeId: "runtime-0" };
      let previous = actor;
      let store = new LoopStore(path);
      let state = "left";
      let sequence = 0;
      let revision = 1;
      let executionId = "left:0";
      let paused = false;
      const attempts: Record<string, number> = { left: 1 };
      let lease: Lease | undefined = { actor, acquiredAt: now, heartbeatAt: now, expiresAt: now + 1800000, attempt: 1 };
      const identity = (): Identity => ({ currentState: state, transitionSeq: sequence, definitionRevision: revision, activeExecutionId: executionId });
      let captured = identity();
      const owns = (caller: WorkflowRuntimeActor) => !!lease && lease.actor.runtimeId === caller.runtimeId && lease.expiresAt > now;
      const advanced = () => {
        state = state === "left" ? "right" : "left";
        sequence++;
        executionId = `${state}:${sequence}`;
        attempts[state] = (attempts[state] ?? 0) + 1;
        lease = undefined;
      };
      const assertModel = () => {
        const entry = new LoopStore(path).get("1")!;
        expect(entry.status).toBe(paused ? "paused" : "active");
        const run = entry.workflow!;
        expect(run.currentState).toBe(state);
        expect(run.transitionSeq).toBe(sequence);
        expect(run.definitionRevision).toBe(revision);
        expect(run.attemptsByState).toEqual(attempts);
        expect(run.activeExecution?.id).toBe(executionId);
        expect(run.activeExecution?.status).toBe("active");
        if (lease) {
          expect(run.activeExecution?.lease).toEqual({
            ownerSessionId: lease.actor.sessionId, ownerRuntimeId: lease.actor.runtimeId,
            acquiredAt: lease.acquiredAt, heartbeatAt: lease.heartbeatAt, expiresAt: lease.expiresAt, attempt: lease.attempt,
          });
        } else expect(run.activeExecution?.lease).toBeUndefined();
        expect((run.executionHistory ?? []).every((record) => record.status !== "active" && !record.lease)).toBe(true);
        expect(new TaskStore(join(dir, "tasks.json")).list()).toEqual([]);
      };
      try {
        store.create({ type: "dynamic" }, "Recover only eligible work", { workflow: definition, actor, recurring: true, maxFires: 256 });
        assertModel();
        for (const op of commands) {
          coverage[op.action] = (coverage[op.action] ?? 0) + 1;
          const caller = op.previous ? previous : actor;
          const before = bytes(path);
          switch (op.action) {
            case "restart":
              previous = actor;
              actor = { sessionId: "same-session", runtimeId: `runtime-${++runtime}` };
              store = new LoopStore(path);
              expect(bytes(path)).toEqual(before);
              break;
            case "claim": {
              const allowed = !lease || lease.expiresAt <= now || lease.actor.runtimeId === caller.runtimeId;
              const result = store.claimWorkflowExecution("1", caller, op.seconds);
              expect(result.claimed).toBe(allowed);
              if (allowed) {
                const same: boolean = lease?.actor.runtimeId === caller.runtimeId;
                lease = { actor: caller, acquiredAt: same ? lease!.acquiredAt : now, heartbeatAt: now, expiresAt: now + op.seconds * 1000, attempt: same ? lease!.attempt : (lease?.attempt ?? 0) + 1 };
              } else expect(bytes(path)).toEqual(before);
              coverage[allowed ? "claim-accepted" : "claim-denied"] = (coverage[allowed ? "claim-accepted" : "claim-denied"] ?? 0) + 1;
              break;
            }
            case "boundary":
              if (lease) {
                now = Math.max(now, lease.expiresAt + op.edge);
                const label = `lease-edge-${now - lease.expiresAt}`;
                coverage[label] = (coverage[label] ?? 0) + 1;
              }
              break;
            case "next":
            case "cas": {
              const expected = op.action === "cas" ? captured : identity();
              const matches = JSON.stringify(expected) === JSON.stringify(identity());
              const allowed = !paused && owns(caller) && matches;
              const result = store.transitionWorkflow("1", { outcome: "next", actor: caller }, expected);
              expect(result.applied).toBe(allowed);
              if (allowed) advanced();
              else expect(bytes(path)).toEqual(before);
              break;
            }
            case "invalid":
              expect(store.transitionWorkflow("1", { outcome: "undeclared", actor: caller }, identity()).applied).toBe(false);
              expect(bytes(path)).toEqual(before);
              break;
            case "reissue": {
              const allowed = owns(caller);
              const result = store.reviseWorkflow("1", {
                expectedRevision: revision, expectedState: state, expectedTransitionSeq: sequence,
                reason: "Replace instructions, not claim authority.",
                changes: [{ op: "reissue_state", stateId: state, prompt: `Instruction ${revision + 1}.`, task: { subject: "Fresh instruction", description: "Inspect existing effects before continuing." } }],
              }, caller);
              expect(result.applied).toBe(allowed);
              if (allowed) executionId = `${state}:${sequence}:r${++revision}`;
              else expect(bytes(path)).toEqual(before);
              break;
            }
            case "pause":
              expect(store.pause("1", "administrative")).toBeDefined();
              paused = true;
              break;
            case "resume":
              expect(store.resume("1")).toBeDefined();
              paused = false;
              break;
            case "remember":
              captured = identity();
              break;
          }
          assertModel();
        }
        // Every generated prefix ends with an eligible manual recovery, not an
        // automatic retry or permission to disregard a still-live owner.
        if (paused) expect(store.resume("1")).toBeDefined();
        if (lease) now = Math.max(now, lease.expiresAt);
        const recovering = { sessionId: "same-session", runtimeId: `recovery-${runtime}` };
        store = new LoopStore(path);
        const persisted = structuredClone(store.get("1")!.workflow!);
        expect(store.claimWorkflowExecution("1", recovering, 60).claimed).toBe(true);
        const claimed = new LoopStore(path).get("1")!.workflow!;
        expect(claimed.activeExecution?.id).toBe(persisted.activeExecution?.id);
        expect(claimed.attemptsByState).toEqual(persisted.attemptsByState);
        expect(claimed.transitionSeq).toBe(persisted.transitionSeq);
        expect(store.transitionWorkflow("1", { outcome: "finish", actor: recovering, evidence: "Inspected prior effects." }, identity())).toMatchObject({ applied: true, terminal: "completed" });
        expect(new LoopStore(path).get("1")).toBeUndefined();
        completed++;
        if (completed % 100 === 0) console.log(JSON.stringify({ progress: { campaign: "workflow-restart", current: completed, total: options.numRuns } }));
      } finally {
        clock.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    }), options);
    const report = { campaign: "workflow-restart", options, requestedRuns: process.env.FC_NUM_RUNS ?? 25, maximumRuns: 1000, completed, coverage, maxCommands: 32, maximumWallTimeMs: 600000, limits: "Store-level reload only; OS kill and session recovery tested separately. No monitor recovery, external-effect replay, lifetime/cap exhaustion." };
    console.log(JSON.stringify(report));
    if (process.env.PI_LOOP_RESTART_FUZZ_REPORT) writeFileSync(process.env.PI_LOOP_RESTART_FUZZ_REPORT, JSON.stringify(report, null, 2));
  }, 600000);
});
