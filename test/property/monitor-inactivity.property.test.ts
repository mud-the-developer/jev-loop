import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { writeFileSync } from "node:fs";
import fc from "fast-check";
import { expect, it, vi } from "vitest";
import { MonitorManager } from "../../src/monitor-manager.js";
import type { MonitorEntry } from "../../src/types.js";
import { createMockPi } from "../helpers/mock-pi.js";
import { propertyOptions } from "./config.js";

const action = fc.record({
  kind: fc.constantFrom("stdout", "stderr", "progress", "advance", "close"),
  delta: fc.constantFrom(0, 1, 999, 1000, 1001, 5000),
  chunk: fc.oneof(fc.constantFrom("", "ENGINEERING_GATE_EXIT 0\n", "partial", '{"progress":{"current":1}}\n'), fc.string({ maxLength: 80 })),
});

it("models generated inactivity renewal and timeout followed by zero close without success inference", async () => {
  const options = propertyOptions(100, 1000);
  const requestedRuns = Number.parseInt(process.env.FC_NUM_RUNS ?? "100", 10);
  if (requestedRuns > options.numRuns) console.warn(`monitor-inactivity: capped ${requestedRuns} requested runs to ${options.numRuns}`);
  let executions = 0;
  let commands = 0;
  const counts: Record<string, number> = {};
  const details = await fc.check(fc.asyncProperty(fc.constantFrom(1, 1000, 5000), fc.array(action, { maxLength: 40 }), async (timeout, actions) => {
    executions++;
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(0);
    const { pi, emittedEvents } = createMockPi();
    // No PID or automatic close: timeout grace and explicit close own settlement.
    const child = Object.assign(new EventEmitter(), { pid: undefined, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true }) as unknown as ChildProcess;
    const manager = new MonitorManager(pi, () => child);
    const entry = manager.create("generic command", "inactivity model", timeout);
    const completions: MonitorEntry[] = [];
    const terminals: MonitorEntry[] = [];
    manager.onComplete(entry.id, value => completions.push(structuredClone(value)));
    manager.onTerminal(entry.id, value => terminals.push(structuredClone(value)));
    let lastActivity = 0;
    let expected: { status: "completed" | "stopped"; completedAt: number } | undefined;
    let closed = false;
    const check = () => {
      expect(manager.get(entry.id)?.status).toBe(expected?.status ?? "running");
      expect(manager.get(entry.id)?.completedAt).toBe(expected?.completedAt);
      expect(manager.get(entry.id)?.exitCode).toBe(expected?.status === "completed" ? 0 : undefined);
      expect(manager.get(entry.id)?.stopReason).toBe(expected?.status === "stopped" ? "timeout" : undefined);
      expect(manager.get(entry.id)!.outputBuffer.length).toBeLessThanOrEqual(200);
      expect(completions).toHaveLength(expected ? 1 : 0);
      const terminalReady = expected && (expected.status === "completed" || closed || Date.now() >= expected.completedAt + 5000);
      expect(terminals).toHaveLength(terminalReady ? 1 : 0);
      for (const receipt of [...completions, ...terminals]) {
        expect({ status: receipt.status, exitCode: receipt.exitCode, stopReason: receipt.stopReason, signal: receipt.signal, completedAt: receipt.completedAt }).toEqual({
          status: expected?.status, exitCode: expected?.status === "completed" ? 0 : undefined,
          stopReason: expected?.status === "stopped" ? "timeout" : undefined, signal: undefined, completedAt: expected?.completedAt,
        });
      }
      const finished = emittedEvents.filter(event => event.name === "monitor:finished");
      expect(finished).toHaveLength(expected ? 1 : 0);
      if (expected) {
        expect(finished[0]?.payload.status).toBe(expected.status);
        expect(finished[0]?.payload.exitCode).toBe(expected.status === "completed" ? 0 : undefined);
        if (expected.status === "stopped") expect(finished[0]?.payload.reason).toBe("timeout");
      }
      expect(emittedEvents.filter(event => event.name === "monitor:done")).toHaveLength(expected?.status === "completed" ? 1 : 0);
    };
    const advance = async (delta: number) => {
      const target = Date.now() + delta;
      if (!expected && target >= lastActivity + timeout) expected = { status: "stopped", completedAt: lastActivity + timeout };
      await vi.advanceTimersByTimeAsync(delta);
      check();
    };
    try {
      for (const [index, command] of actions.entries()) {
        commands++;
        counts[command.kind] = (counts[command.kind] ?? 0) + 1;
        switch (command.kind) {
          case "stdout": case "stderr":
            if (!expected && Buffer.byteLength(command.chunk) > 0) lastActivity = Date.now();
            child[command.kind]?.emit("data", Buffer.from(command.chunk));
            break;
          case "progress":
            if (!expected) lastActivity = Date.now();
            manager.updateProgress(entry.id, { current: index, message: `step${index}` });
            break;
          case "advance":
            await advance(command.delta);
            break;
          case "close":
            if (!closed) {
              closed = true;
              expected ??= { status: "completed", completedAt: Date.now() };
              child.emit("close", 0);
            }
            break;
        }
        await Promise.resolve();
        await Promise.resolve();
        check();
      }
      await advance(timeout + 5000);
      expect(terminals).toHaveLength(1);
    } finally {
      const pending = manager.shutdown();
      await vi.advanceTimersByTimeAsync(5000);
      await pending;
      vi.useRealTimers();
    }
  }), options);
  const error = details.failed ? (details.errorInstance instanceof Error ? details.errorInstance.stack : String(details.errorInstance)) : undefined;
  const report = { options, requestedRuns, maxNumRuns: 1000, maxCommands: 40, executions, commands, counts, seed: details.seed, numRuns: details.numRuns, numShrinks: details.numShrinks, failed: details.failed, counterexamplePath: details.counterexamplePath, counterexample: details.counterexample, error };
  if (process.env.MONITOR_INACTIVITY_REPORT) writeFileSync(process.env.MONITOR_INACTIVITY_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.info(`monitor-inactivity: ${JSON.stringify(report)}`);
  expect(details.failed, error).toBe(false);
}, 120_000);
