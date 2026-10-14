import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { EXIT_CLOSE_GRACE_MS, MONITOR_RETENTION_MS, MonitorManager } from "../../src/monitor-manager.js";
import type { MonitorEntry } from "../../src/types.js";
import { createMockPi } from "../helpers/mock-pi.js";
import { propertyOptions } from "./config.js";

type CallbackMode = "passive" | "throw" | "forge-success" | "forge-failure";
type Kind = "stdout" | "stderr" | "exit" | "close" | "error" | "stop" | "timeout" | "completion" | "terminal" | "advance" | "shutdown";
interface Action {
  kind: Kind;
  code: number | null;
  mode: CallbackMode;
  chunk: string;
  elapsed: number;
  flush: boolean;
}
type Outcome = Pick<MonitorEntry, "status" | "exitCode" | "signal" | "stopReason" | "completedAt">;
interface Receipt { kind: "completion" | "terminal"; snapshots: Outcome[]; retired: boolean }

const kinds: Kind[] = ["stdout", "stderr", "exit", "close", "error", "stop", "timeout", "completion", "terminal", "advance", "shutdown"];
const output = fc.oneof(
  fc.constantFrom("ENGINEERING_GATE_EXIT 0\n", "ENGINEERING_GATE_START\n", "ENGINEERING_GATE_EX", "IT 0\r\n", '{"progress":{"current":1}}\n', "\n", ""),
  fc.string({ maxLength: 80 }),
);
function actionArbitrary(consumers: boolean): fc.Arbitrary<Action> {
  return fc.record({
    kind: fc.constantFrom(...kinds), code: fc.constantFrom(0, 1, null),
    mode: fc.constantFrom<CallbackMode>(...(consumers ? ["passive", "throw", "forge-success", "forge-failure"] as const : ["passive", "throw"] as const)),
    chunk: output,
    elapsed: fc.constantFrom(0, 1, EXIT_CLOSE_GRACE_MS - 1, EXIT_CLOSE_GRACE_MS, 4999, 5000, MONITOR_RETENTION_MS - 1, MONITOR_RETENTION_MS),
    flush: fc.boolean(),
  });
}
function outcome(entry: MonitorEntry): Outcome {
  return { status: entry.status, exitCode: entry.exitCode, signal: entry.signal, stopReason: entry.stopReason, completedAt: entry.completedAt };
}
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// No PID or auto-reap: generated close/timer operations own every settlement.
function controllableChild() {
  const events = new EventEmitter();
  const child = Object.assign(events, { pid: undefined, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true }) as unknown as ChildProcess;
  return child;
}

interface Counters { executions: number; commands: number; operations: Record<string, number> }
const reports: unknown[] = [];
async function campaign(name: string, consumers: boolean): Promise<void> {
  const counters: Counters = { executions: 0, commands: 0, operations: {} };
  const options = propertyOptions(100, 1000);
  const requestedRuns = Number.parseInt(process.env.FC_NUM_RUNS ?? "100", 10);
  if (requestedRuns > options.numRuns) console.warn(`monitor-runtime ${name}: capped ${requestedRuns} requested runs to ${options.numRuns}`);
  const started = Date.now();
  const details = await fc.check(fc.asyncProperty(fc.array(actionArbitrary(consumers), { maxLength: 40 }), async (actions) => {
    counters.executions++;
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { pi, emittedEvents } = createMockPi();
    const child = controllableChild();
    const manager = new MonitorManager(pi, () => child);
    const entry = manager.create("generic command", "generated monitor", 0);
    const receipts: Receipt[] = [];
    const stops: Array<{ promise: Promise<boolean>; expected: boolean }> = [];
    let expected: Outcome | undefined;
    let pruneAt: number | undefined;
    let removed = false;
    let closed = false;
    let exited: { code: number | null; at: number } | undefined;
    let terminalReady = false;
    let visibleSettlement = false;
    const flushReady = () => {
      if (expected?.status === "stopped" && (closed || Date.now() >= expected.completedAt! + 5000)) terminalReady = true;
    };
    const signal = (code: number | null) => code === null ? "SIGTERM" as const : undefined;
    const complete = (code: number | null, at: number) => {
      expected = { status: code === 0 ? "completed" : "error", exitCode: code ?? undefined, signal: code === 0 ? undefined : signal(code), stopReason: undefined, completedAt: at };
      pruneAt = at + MONITOR_RETENTION_MS;
      terminalReady = true;
      visibleSettlement = true;
    };
    const check = () => {
      const actual = manager.get(entry.id);
      if (removed) expect(actual).toBeUndefined();
      else {
        expect(actual).toBeDefined();
        expect(outcome(actual!)).toEqual(expected ?? { status: "running", exitCode: undefined, signal: undefined, stopReason: undefined, completedAt: undefined });
        expect(actual!.id).toBe(entry.id);
        expect(actual!.outputBuffer.length).toBeLessThanOrEqual(200);
      }
      for (const receipt of receipts) {
        const eligible = expected && (receipt.kind === "terminal" ? terminalReady : expected.status === "completed" || expected.status === "error" || expected.stopReason === "timeout");
        expect(receipt.snapshots).toHaveLength(eligible && !receipt.retired ? 1 : 0);
        for (const snapshot of receipt.snapshots) expect(snapshot).toEqual(expected);
      }
      const finished = emittedEvents.filter(event => event.name === "monitor:finished");
      expect(finished).toHaveLength(visibleSettlement ? 1 : 0);
      if (visibleSettlement) {
        expect(finished[0]?.payload.status).toBe(expected?.status);
        expect(finished[0]?.payload.exitCode).toBe(expected?.exitCode);
        expect(finished[0]?.payload.signal).toBe(expected?.signal);
        if (expected?.status === "stopped") expect(finished[0]?.payload.reason).toBe(expected.stopReason);
      }
      const done = emittedEvents.filter(event => event.name === "monitor:done");
      expect(done).toHaveLength(expected?.status === "completed" ? 1 : 0);
    };
    try {
      for (const action of actions) {
        counters.commands++;
        counters.operations[action.kind] = (counters.operations[action.kind] ?? 0) + 1;
        const now = Date.now();
        switch (action.kind) {
          case "stdout": case "stderr":
            child[action.kind]?.emit("data", Buffer.from(action.chunk));
            break;
          case "exit":
            if (!closed && !exited) {
              exited = { code: action.code, at: now };
              child.emit("exit", action.code, signal(action.code));
            }
            break;
          case "close":
            if (!closed) {
              closed = true;
              const code = exited ? exited.code : action.code;
              if (!expected && !removed) complete(code, now);
              child.emit("close", code, signal(code));
            }
            break;
          case "error":
            if (!expected && !removed) {
              expected = { status: "error", exitCode: undefined, signal: undefined, stopReason: undefined, completedAt: now };
              pruneAt = now + MONITOR_RETENTION_MS;
              terminalReady = true;
              visibleSettlement = true;
            }
            child.emit("error", new Error("generated spawn error"));
            break;
          case "stop": case "timeout": {
            const accepted = !expected && !removed;
            if (accepted) {
              expected = { status: "stopped", exitCode: undefined, signal: undefined, stopReason: action.kind === "stop" ? "manual" : "timeout", completedAt: now };
              pruneAt = now + MONITOR_RETENTION_MS;
              visibleSettlement = true;
            }
            stops.push({ promise: manager.stop(entry.id, action.kind === "stop" ? "manual" : "timeout"), expected: accepted });
            break;
          }
          case "completion": case "terminal": {
            const receipt: Receipt = { kind: action.kind, snapshots: [], retired: false };
            const callback = (argument: MonitorEntry) => {
              receipt.snapshots.push(outcome(argument));
              if (action.mode === "throw") throw new Error("generated consumer failure");
              if (action.mode === "forge-success") {
                argument.status = "completed";
                argument.exitCode = 0;
                argument.outputBuffer.push("ENGINEERING_GATE_EXIT 0");
              }
              if (action.mode === "forge-failure") {
                argument.status = "error";
                argument.exitCode = 1;
              }
            };
            const accepted = action.kind === "terminal" ? manager.onTerminal(entry.id, callback) : manager.onComplete(entry.id, callback);
            expect(accepted).toBe(!removed && (action.kind === "terminal" || expected === undefined || expected.status === "completed" || expected.status === "error"));
            if (accepted) receipts.push(receipt);
            break;
          }
          case "advance": {
            const target = now + action.elapsed;
            if (!expected && !removed && exited && target >= exited.at + EXIT_CLOSE_GRACE_MS) complete(exited.code, exited.at + EXIT_CLOSE_GRACE_MS);
            if (pruneAt !== undefined && target >= pruneAt) removed = true;
            await vi.advanceTimersByTimeAsync(action.elapsed);
            flushReady();
            break;
          }
          case "shutdown": {
            if (!expected && !removed) expected = { status: "stopped", exitCode: undefined, signal: undefined, stopReason: "manual", completedAt: now };
            for (const receipt of receipts) {
              if (receipt.kind === "terminal" ? !terminalReady : expected?.stopReason === "manual") receipt.retired = true;
            }
            const pending = manager.shutdown();
            await vi.advanceTimersByTimeAsync(5000);
            await pending;
            removed = true;
            break;
          }
        }
        if (action.flush) { await settle(); flushReady(); }
        check();
      }
      await vi.advanceTimersByTimeAsync(5000);
      if (!expected && !removed && exited) complete(exited.code, exited.at + EXIT_CLOSE_GRACE_MS);
      if (pruneAt !== undefined && Date.now() >= pruneAt) removed = true;
      await settle();
      flushReady();
      check();
      for (const stop of stops) expect(await stop.promise).toBe(stop.expected);
    } finally {
      const pending = manager.shutdown();
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
      errors.mockRestore();
      vi.useRealTimers();
    }
  }), options);
  const error = details.failed ? (details.errorInstance instanceof Error ? details.errorInstance.stack : String(details.errorInstance)) : undefined;
  const report = { name, options, requestedRuns, maxNumRuns: 1000, maxCommands: 40, elapsedMs: Date.now() - started, failed: details.failed, seed: details.seed, numRuns: details.numRuns, numShrinks: details.numShrinks, counterexamplePath: details.counterexamplePath, counterexample: details.counterexample, error, counters };
  reports.push(report);
  if (process.env.MONITOR_FUZZ_REPORT) writeFileSync(process.env.MONITOR_FUZZ_REPORT, `${JSON.stringify(reports, null, 2)}\n`);
  console.info(`monitor-runtime ${name}: ${JSON.stringify(report)}`);
  expect(details.failed, error ?? `seed=${details.seed} path=${details.counterexamplePath}`).toBe(false);
}

describe("generic monitor runtime model", () => {
  it("preserves authoritative outcomes through fault-injected cancellation, output, timers and shutdown", () => campaign("lifecycle", false), 120_000);
  it("isolates generated callback consumers from authoritative outcomes and later receipts", () => campaign("consumer-isolation", true), 120_000);
});
