import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { MonitorManager } from "../src/monitor-manager.js";
import { LoopStore } from "../src/store.js";
import { registerMonitorTools } from "../src/tools/monitor-tools.js";
import type { MonitorEntry, WorkflowDefinition } from "../src/types.js";
import { createMockPi } from "./helpers/mock-pi.js";
import { createMockChildProcess, createSequentialSpawn } from "./helpers/mock-spawn.js";

const actor = { sessionId: "race-session", runtimeId: "owner-runtime" };
const definition: WorkflowDefinition = { version: 1, initialState: "gate", states: {
  gate: { prompt: "Run gate", task: { subject: "Gate", description: "Inspect actual results" }, on: { next: "review" } },
  review: { prompt: "Review", task: { subject: "Review", description: "Inspect gate evidence" }, on: { finish: "done" } },
  done: { prompt: "Done", terminal: "completed" },
} };
function snapshots(path: string) {
  return [readFileSync(path, "utf8"), existsSync(`${path}.prev`) ? readFileSync(`${path}.prev`, "utf8") : undefined];
}
function fixture(interleave: "none" | "future-revision" | "reissue" | "transition", stop?: () => Promise<boolean>, rebind?: "manager" | "store" | "actor") {
  const dir = mkdtempSync(join(tmpdir(), "pi-loop-monitor-race-"));
  const path = join(dir, "loops.json");
  const store = new LoopStore(path);
  store.create({ type: "dynamic" }, "Gate report", { recurring: true, workflow: definition, actor });
  const { pi, toolMap } = createMockPi();
  const remove = vi.fn();
  const wait = vi.fn();
  const widget = vi.fn();
  let committed: ReturnType<typeof structuredClone>;
  let committedBytes: ReturnType<typeof snapshots>;
  const entry: MonitorEntry = { id: "1", command: "test-command", status: "running", startedAt: Date.now(), timeout: 0, outputLines: 0, outputBuffer: [] };
  let rebound = false;
  const replacementStore = new LoopStore(path);
  const replacementManager = { list: () => [], create: vi.fn(() => entry), stop: vi.fn(async () => true), updateProgress: () => undefined };
  const manager = {
    list: () => [],
    create: vi.fn(() => {
      const peer = new LoopStore(path);
      if (interleave === "future-revision" || interleave === "reissue") {
        expect(peer.reviseWorkflow("1", { expectedRevision: 1, expectedState: "gate", expectedTransitionSeq: 0, reason: "Controlled concurrent revision", changes: interleave === "future-revision"
          ? [{ op: "revise_state", stateId: "review", prompt: "New future review" }]
          : [{ op: "reissue_state", stateId: "gate", prompt: "Replacement gate instructions", task: { subject: "Replacement", description: "Inspect before repeating" } }],
        }, actor).applied).toBe(true);
      } else if (interleave === "transition") {
        expect(peer.transitionWorkflow("1", { outcome: "next", actor }, { currentState: "gate", transitionSeq: 0, definitionRevision: 1, activeExecutionId: "gate:0" }).applied).toBe(true);
      }
      committed = structuredClone(peer.get("1"));
      committedBytes = snapshots(path);
      rebound = true;
      return entry;
    }),
    stop: vi.fn(stop ?? (async () => true)),
    updateProgress: () => undefined,
  };
  registerMonitorTools({ pi, getStore: () => rebound && rebind === "store" ? replacementStore : store,
    getMonitorManager: () => rebound && rebind === "manager" ? replacementManager : manager,
    getTriggerSystem: () => ({ remove }), getActor: () => rebound && rebind === "actor" ? { ...actor, runtimeId: "replacement-runtime" } : actor,
    updateWidget: widget, handleMonitorDoneLoop: vi.fn(), handleWorkflowMonitorWait: wait });
  return { store, manager, replacementManager, path, remove, wait, widget,
    committed: () => committed, committedBytes: () => committedBytes,
    create: async () => await toolMap.get("MonitorCreate")!.execute!("race", { command: "test-command", workflowId: "1" }),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

beforeAll(() => initTheme("dark"));

describe("workflow monitor attachment interleavings", () => {
  it("attaches unchanged owned execution and suppresses only its cadence", async () => {
    const h = fixture("none");
    try {
      const result = await h.create();
      expect(result.content[0].text).toContain("waiting on monitor #1");
      expect(h.store.get("1")?.workflow?.waitingMonitor).toMatchObject({ monitorId: "1", stateId: "gate", transitionSeq: 0 });
      expect(h.remove).toHaveBeenCalledExactlyOnceWith("1");
      expect(h.wait).toHaveBeenCalledTimes(1);
      expect(h.manager.stop).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });

  it.each(["reissue", "transition"] as const)("retains current CAS refusal for %s and does not attach/cancel cadence for replacement work", async (change) => {
    const h = fixture(change);
    try {
      const result = await h.create();
      expect(result.content[0].text).toContain("changed before ownership could be attached");
      expect(result.details).toMatchObject({ tone: "error" });
      expect(h.manager.stop).toHaveBeenCalledExactlyOnceWith("1");
      expect(h.store.get("1")).toEqual(h.committed());
      expect(h.store.get("1")?.workflow?.waitingMonitor).toBeUndefined();
      expect(h.remove).not.toHaveBeenCalled();
      expect(h.wait).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });

  it("does not rotate workflow recovery snapshots when stale attachment is rejected", async () => {
    const h = fixture("reissue");
    try {
      await h.create();
      expect(snapshots(h.path)).toEqual(h.committedBytes());
    } finally { h.cleanup(); }
  });

  it("does not report confirmed cancellation before the stop promise settles", async () => {
    let confirm!: (stopped: boolean) => void;
    const stopped = new Promise<boolean>((resolve) => { confirm = resolve; });
    const h = fixture("reissue", () => stopped);
    let resolved = false;
    const creating = h.create().then((result) => { resolved = true; return result; });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(h.manager.stop).toHaveBeenCalledExactlyOnceWith("1");
      expect(resolved).toBe(false);
      confirm(true);
      expect((await creating).content[0].text).toContain("stopped");
    } finally { confirm(true); await creating; h.cleanup(); }
  });
  it("re-resolves one future-state revision for the same owned execution without rerunning the command", async () => {
    const h = fixture("future-revision");
    const attach = vi.spyOn(h.store, "attachWorkflowMonitor");
    try {
      const result = await h.create();
      expect(result.content[0].text).toContain("waiting on monitor #1");
      expect(h.manager.create).toHaveBeenCalledTimes(1);
      expect(h.manager.stop).not.toHaveBeenCalled();
      expect(attach).toHaveBeenCalledTimes(2);
      expect(attach.mock.calls.map((call) => call[2])).toEqual([
        { stateId: "gate", transitionSeq: 0, definitionRevision: 1, activeExecutionId: "gate:0" },
        { stateId: "gate", transitionSeq: 0, definitionRevision: 2, activeExecutionId: "gate:0" },
      ]);
      expect(h.store.get("1")?.workflow?.waitingMonitor?.monitorId).toBe("1");
      expect(h.store.get("1")?.workflow?.activeExecution?.id).toBe("gate:0");
      expect(h.remove).toHaveBeenCalledExactlyOnceWith("1");
      expect(h.wait).toHaveBeenCalledTimes(1);
    } finally { attach.mockRestore(); h.cleanup(); }
  });

  it("keeps strict stale-revision CAS in the store even when execution identity is unchanged", () => {
    const h = fixture("future-revision");
    try {
      h.manager.create();
      expect(h.store.attachWorkflowMonitor("1", "1", { stateId: "gate", transitionSeq: 0, definitionRevision: 1, activeExecutionId: "gate:0" }, actor)).toBeUndefined();
      expect(snapshots(h.path)).toEqual(h.committedBytes());
    } finally { h.cleanup(); }
  });

  it("does not retry again if replacement occurs between re-read and second attachment", async () => {
    const h = fixture("future-revision");
    const original = h.store.attachWorkflowMonitor.bind(h.store);
    let calls = 0;
    const attach = vi.spyOn(h.store, "attachWorkflowMonitor").mockImplementation((id, monitorId, expected, caller) => {
      if (++calls === 2) {
        expect(new LoopStore(h.path).reviseWorkflow("1", { expectedRevision: 2, expectedState: "gate", expectedTransitionSeq: 0,
          reason: "Replace during second attach", changes: [{ op: "reissue_state", stateId: "gate", prompt: "New work", task: { subject: "New", description: "No implicit retry" } }],
        }, actor).applied).toBe(true);
      }
      return original(id, monitorId, expected, caller);
    });
    try {
      expect((await h.create()).details).toMatchObject({ tone: "error" });
      expect(calls).toBe(2);
      expect(h.store.get("1")?.workflow?.activeExecution?.id).toBe("gate:0:r3");
      expect(h.store.get("1")?.workflow?.waitingMonitor).toBeUndefined();
      expect(h.manager.create).toHaveBeenCalledTimes(1);
      expect(h.manager.stop).toHaveBeenCalledExactlyOnceWith("1");
      expect(h.remove).not.toHaveBeenCalled();
      expect(h.wait).not.toHaveBeenCalled();
    } finally { attach.mockRestore(); h.cleanup(); }
  });

  it.each(["manager", "store", "actor"] as const)("cancels through creating manager after %s rebinding, without attaching current work", async (rebind) => {
    const h = fixture("future-revision", undefined, rebind);
    try {
      expect((await h.create()).details).toMatchObject({ tone: "error" });
      expect(h.manager.stop).toHaveBeenCalledExactlyOnceWith("1");
      expect(h.replacementManager.stop).not.toHaveBeenCalled();
      expect(h.store.get("1")?.workflow?.waitingMonitor).toBeUndefined();
      expect(snapshots(h.path)).toEqual(h.committedBytes());
      expect(h.remove).not.toHaveBeenCalled();
      expect(h.wait).not.toHaveBeenCalled();
    } finally { h.cleanup(); }
  });

  it.each(["expired", "foreign"] as const)("rejects %s lease at the second locked attachment without rewriting snapshots", async (mode) => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.UTC(2026, 0, 1));
    const h = fixture("future-revision");
    const deadline = h.store.get("1")!.workflow!.activeExecution!.lease!.expiresAt;
    const original = h.store.attachWorkflowMonitor.bind(h.store);
    let calls = 0;
    let beforeDenied: ReturnType<typeof snapshots> | undefined;
    const attach = vi.spyOn(h.store, "attachWorkflowMonitor").mockImplementation((id, monitorId, expected, caller) => {
      if (++calls === 2) {
        clock.mockReturnValue(deadline);
        if (mode === "foreign") expect(new LoopStore(h.path).claimWorkflowExecution("1", { sessionId: actor.sessionId, runtimeId: "foreign-owner" }, 60).claimed).toBe(true);
        beforeDenied = snapshots(h.path);
      }
      return original(id, monitorId, expected, caller);
    });
    try {
      expect((await h.create()).details).toMatchObject({ tone: "error" });
      expect(calls).toBe(2);
      expect(beforeDenied).toBeDefined();
      expect(snapshots(h.path)).toEqual(beforeDenied);
      expect(h.store.get("1")?.workflow?.activeExecution?.id).toBe("gate:0");
      expect(h.store.get("1")?.workflow?.activeExecution?.lease?.ownerRuntimeId).toBe(mode === "foreign" ? "foreign-owner" : actor.runtimeId);
      expect(h.store.get("1")?.workflow?.waitingMonitor).toBeUndefined();
      expect(h.manager.create).toHaveBeenCalledTimes(1);
      expect(h.manager.stop).toHaveBeenCalledExactlyOnceWith("1");
      expect(h.remove).not.toHaveBeenCalled();
      expect(h.wait).not.toHaveBeenCalled();
    } finally { attach.mockRestore(); clock.mockRestore(); h.cleanup(); }
  });

  it.each([false, "error"] as const)("reports unconfirmed cleanup rather than stopped when cleanup returns %s", async (outcome) => {
    const h = fixture("reissue", async () => { if (outcome === "error") throw new Error("reap refused"); return false; });
    try {
      const result = await h.create();
      expect(result.content[0].text).toContain("cleanup could not be confirmed");
      expect(result.content[0].text).not.toContain("Monitor #1 stopped");
      expect(result.details).toMatchObject({ tone: "error" });
      expect(h.wait).not.toHaveBeenCalled();
      expect(h.widget).toHaveBeenCalledTimes(1);
    } finally { h.cleanup(); }
  });
});

describe("cancellation is not successful command execution", () => {
  it("keeps stopped/manual and no successful exit for late close(0), even with forged gate stdout", async () => {
    const { pi } = createMockPi();
    const child = createMockChildProcess({ exitCode: null });
    const manager = new MonitorManager(pi, createSequentialSpawn(child));
    const entry = manager.create("test-command", undefined, 0);
    const completion = vi.fn();
    const terminal = vi.fn();
    manager.onComplete(entry.id, completion);
    manager.onTerminal(entry.id, terminal);
    pi.events.emit.mockClear();
    const stopping = manager.stop(entry.id);
    child.stdout?.emit("data", Buffer.from("ENGINEERING_GATE_EXIT 0\n"));
    child.emit("close", 0);
    expect(await stopping).toBe(true);
    expect(manager.get(entry.id)).toMatchObject({ status: "stopped", stopReason: "manual", outputBuffer: ["ENGINEERING_GATE_EXIT 0"] });
    expect(manager.get(entry.id)?.exitCode).toBeUndefined();
    expect(completion).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledTimes(1);
    expect(terminal.mock.calls[0]![0]).toMatchObject({ status: "stopped", stopReason: "manual" });
    expect(pi.events.emit.mock.calls.filter(([name]: unknown[]) => name === "monitor:done")).toEqual([]);
    expect(pi.events.emit.mock.calls.filter(([name]: unknown[]) => name === "monitor:finished")).toEqual([["monitor:finished", { monitorId: entry.id, status: "stopped", reason: "manual", outputLines: 0 }]]);
    await manager.shutdown();
    expect(manager.list()).toEqual([]);
  });

  it("reports a normally completed zero-exit command separately; stdout still is not gate certification", async () => {
    const { pi } = createMockPi();
    const child = createMockChildProcess({ exitCode: null });
    const manager = new MonitorManager(pi, createSequentialSpawn(child));
    const entry = manager.create("test-command", undefined, 0);
    const completion = vi.fn();
    manager.onComplete(entry.id, completion);
    child.emit("close", 0);
    expect(manager.get(entry.id)).toMatchObject({ status: "completed", exitCode: 0 });
    expect(completion).toHaveBeenCalledTimes(1);
    expect(pi.events.emit.mock.calls.some(([name]: unknown[]) => name === "monitor:done")).toBe(true);
    await manager.shutdown();
  });
});
