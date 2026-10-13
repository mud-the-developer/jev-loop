import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { resolveLoopStorePath, resolveTaskStorePath } from "../src/runtime/scope.js";
import { LoopStore } from "../src/store.js";
import { TaskStore } from "../src/task-store.js";
import { createMockPi } from "./helpers/mock-pi.js";

const definition = JSON.stringify({
  version: 1,
  initialState: "work",
  states: {
    work: {
      prompt: "Inspect prior effects, then finish this work.",
      task: { subject: "Resume work", description: "Do not automatically repeat ambiguous effects." },
      on: { done: "done" },
    },
    done: { prompt: "Report verified completion.", terminal: "completed" },
  },
});

// Fresh factories reopen the same file without teardown first. This models
// runtime loss, not actual OS death or proof that external work stopped.
describe("workflow crash/continue ownership controls", () => {
  let cwd: string;
  let originalCwd: string;
  const harnesses: { emitExtension: ReturnType<typeof createMockPi>["emitExtension"]; ctx: unknown }[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    vi.stubEnv("PI_LOOP_SCOPE", "session");
    vi.stubEnv("PI_LOOP", undefined);
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "pi-loop-crash-resume-"));
    process.chdir(cwd);
  });

  afterEach(async () => {
    for (const h of harnesses.splice(0)) await h.emitExtension("session_shutdown", null, h.ctx);
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  async function start() {
    const h = createMockPi();
    extension(h.pi as any);
    const sessionId = "crash-resume";
    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => sessionId },
    };
    const result = {
      ...h, ctx,
      loopPath: resolveLoopStorePath({ loopScope: "session", cwd }, sessionId)!,
      taskPath: resolveTaskStorePath({ loopScope: "session", cwd }, sessionId)!,
    };
    harnesses.push(result);
    await h.emitExtension("session_start", null, ctx);
    return result;
  }

  it("reclaims an expired execution through the resumed tool and drives the existing phase", async () => {
    const previous = await start();
    await previous.toolMap.get("WorkflowCreate")!.execute!("create", { goal: "Resume interrupted work", definition });
    const before = new LoopStore(previous.loopPath).get("1")!;
    const oldExecution = before.workflow!.activeExecution!;
    vi.setSystemTime(oldExecution.lease!.expiresAt + 1);
    const resumed = await start();
    expect(resumed.loopPath).toBe(previous.loopPath);

    const claim = await resumed.toolMap.get("WorkflowClaim")!.execute!("claim", { id: "1" });
    expect(claim.content[0].text).toContain("lease active until");
    const recovered = new LoopStore(resumed.loopPath).get("1")!.workflow!;
    expect(recovered.activeExecution?.id).toBe(oldExecution.id);
    expect(recovered.activeExecution?.lease?.ownerSessionId).toBe(oldExecution.lease!.ownerSessionId);
    expect(recovered.activeExecution?.lease?.ownerRuntimeId).not.toBe(oldExecution.lease!.ownerRuntimeId);
    expect(recovered.transitionSeq).toBe(before.workflow!.transitionSeq);
    expect(recovered.attemptsByState).toEqual(before.workflow!.attemptsByState);
    expect(new TaskStore(resumed.taskPath).list()).toEqual([]);
    const claimedBytes = [readFileSync(resumed.loopPath, "utf8"), readFileSync(`${resumed.loopPath}.prev`, "utf8")];
    const stale = await previous.toolMap.get("WorkflowTransition")!.execute!("stale", {
      id: "1", outcome: "done", evidence: "Obsolete runtime must not settle recovered work.",
    });
    expect(stale.content[0].text).toContain("did not transition");
    expect(stale.content[0].text).toContain("leased to another active runtime");
    expect([readFileSync(resumed.loopPath, "utf8"), readFileSync(`${resumed.loopPath}.prev`, "utf8")]).toEqual(claimedBytes);

    const done = await resumed.toolMap.get("WorkflowTransition")!.execute!("done", {
      id: "1", outcome: "done", evidence: "Inspected prior effects; work is complete.",
    });
    expect(done.content[0].text).toContain("completed and deleted");
    expect(new LoopStore(resumed.loopPath).get("1")).toBeUndefined();
    expect(new TaskStore(resumed.taskPath).list()).toEqual([]);
  });

  it("rejects a second runtime while the first lease is live without changing snapshots", async () => {
    const previous = await start();
    await previous.toolMap.get("WorkflowCreate")!.execute!("create", { goal: "Do not duplicate work", definition });
    const owner = new LoopStore(previous.loopPath).get("1")!.workflow!.activeExecution!.lease!;
    const peer = await start();
    const bytes = [readFileSync(peer.loopPath, "utf8"), readFileSync(`${peer.loopPath}.prev`, "utf8")];
    const claim = await peer.toolMap.get("WorkflowClaim")!.execute!("foreign", { id: "1" });
    expect(claim.content[0].text).toContain("leased to another active runtime");
    expect(new LoopStore(peer.loopPath).get("1")?.workflow?.activeExecution?.lease).toEqual(owner);
    expect([readFileSync(peer.loopPath, "utf8"), readFileSync(`${peer.loopPath}.prev`, "utf8")]).toEqual(bytes);
    vi.setSystemTime(owner.acquiredAt + 1000);
    const renewal = await previous.toolMap.get("WorkflowClaim")!.execute!("renew", { id: "1" });
    expect(renewal.content[0].text).toContain("lease active until");
    const renewed = new LoopStore(peer.loopPath).get("1")!.workflow!.activeExecution!.lease!;
    expect(renewed.ownerSessionId).toBe(owner.ownerSessionId);
    expect(renewed.ownerRuntimeId).toBe(owner.ownerRuntimeId);
    expect(renewed.acquiredAt).toBe(owner.acquiredAt);
    expect(renewed.heartbeatAt).toBe(Date.now());
    expect(renewed.attempt).toBe(owner.attempt);
    expect(renewed.expiresAt).toBeGreaterThan(owner.expiresAt);
    expect(new TaskStore(peer.taskPath).list()).toEqual([]);
  });
});
