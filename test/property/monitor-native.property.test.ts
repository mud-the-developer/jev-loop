import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { expect, it } from "vitest";
import { MonitorManager } from "../../src/monitor-manager.js";
import type { MonitorEntry } from "../../src/types.js";
import { createMockPi } from "../helpers/mock-pi.js";
import { propertyOptions } from "./config.js";

const scriptCase = fc.record({
  action: fc.constantFrom("cancel-before", "cancel-during", "complete", "timeout-before"),
  term: fc.constantFrom("default", "zero", "nonzero"),
  exitTrap: fc.constantFrom("none", "status", "zero"),
  bodyCode: fc.constantFrom(0, 1),
  noise: fc.boolean(),
});
type ScriptCase = typeof scriptCase extends fc.Arbitrary<infer Value> ? Value : never;
type PhysicalClose = { code: number | null; signal: NodeJS.Signals | null };
const nativeIt = process.platform === "win32" ? it.skip : it;
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const tuple = (entry: MonitorEntry) => ({
  status: entry.status, exitCode: entry.exitCode, signal: entry.signal,
  stopReason: entry.stopReason, completedAt: entry.completedAt,
});

async function guarded<T>(promise: Promise<T>, milestone: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Native fixture watchdog: ${milestone}`)), 5000);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function cleanupAll(primary: Error | undefined, jobs: Array<() => void | Promise<void>>): Promise<void> {
  const failures: unknown[] = [];
  for (const job of jobs) {
    try { await job(); } catch (error) { failures.push(error); }
  }
  if (failures.length > 0) {
    const errors = primary ? [primary, ...failures] : failures;
    throw new AggregateError(errors, errors.map(error => error instanceof Error ? error.stack : String(error)).join("\n"));
  }
}

async function runNative(config: ScriptCase) {
  const dir = mkdtempSync(join(tmpdir(), "pi-loop-native-"));
  const start = join(dir, "start");
  const finish = join(dir, "finish");
  const work = join(dir, "work");
  const command = [
    config.exitTrap === "status" ? "trap 'rc=$?; printf \"ENGINEERING_GATE_EXIT %s\\n\" \"$rc\"' EXIT" :
      config.exitTrap === "zero" ? "trap 'printf \"ENGINEERING_GATE_EXIT 0\\n\"' EXIT" : ":",
    config.term === "zero" ? "trap 'exit 0' TERM" : config.term === "nonzero" ? "trap 'exit 143' TERM" : ":",
    config.noise ? "printf 'untrusted noise\\n' >&2" : ":",
    "printf 'NATIVE_READY\\n'",
    `while [ ! -f ${quote(start)} ]; do sleep 0.01; done`,
    "printf 'ENGINEERING_GATE_START\\n'",
    `while [ ! -f ${quote(finish)} ]; do sleep 0.01; done`,
    `printf 'fixture body only\\n' > ${quote(work)}`,
    "printf 'ENGINEERING_GATE_SUMMARY fixture-body-complete\\n'",
    `exit ${config.bodyCode}`,
  ].join("\n");
  const { pi, emittedEvents } = createMockPi();
  let child: ChildProcess | undefined;
  let stdout = "";
  let stderr = "";
  let spawnError: string | undefined;
  let physical: PhysicalClose | undefined;
  let resolveClose!: (value: PhysicalClose) => void;
  const closed = new Promise<PhysicalClose>(resolve => { resolveClose = resolve; });
  const observers: Array<() => void> = [];
  const manager = new MonitorManager(pi, (binary, args, options) => {
    // Observe an ordinary native spawn without fabricating or reordering its events.
    child = spawn(binary, args, options);
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
      for (const observer of observers) observer();
    });
    child.stderr?.on("data", (data: Buffer) => { stderr += data.toString("utf8"); });
    child.on("error", error => { spawnError = error.message; });
    child.on("close", (code, signal) => {
      physical = { code, signal };
      resolveClose(physical);
    });
    return child;
  });
  let primaryError: Error | undefined;
  const waitFor = (marker: string) => guarded(new Promise<void>(resolve => {
    const check = () => { if (stdout.includes(marker)) resolve(); };
    observers.push(check);
    check();
  }), marker);
  try {
    const entry = manager.create(command, "native shell fixture", config.action === "timeout-before" ? 1000 : 0);
    const completions: MonitorEntry[] = [];
    const terminals: MonitorEntry[] = [];
    let resolveTerminal!: () => void;
    const terminal = new Promise<void>(resolve => { resolveTerminal = resolve; });
    manager.onComplete(entry.id, value => completions.push(value));
    manager.onTerminal(entry.id, value => { terminals.push(value); resolveTerminal(); });
    await waitFor("NATIVE_READY\n");
    if (config.action === "complete" || config.action === "cancel-during") {
      writeFileSync(start, "go");
      await waitFor("ENGINEERING_GATE_START\n");
    }
    if (config.action === "complete") writeFileSync(finish, "go");
    else if (config.action !== "timeout-before") expect(await manager.stop(entry.id)).toBe(true);
    await guarded(terminal, "terminal receipt");
    const nativeClose = await guarded(closed, "native close");
    expect(spawnError).toBeUndefined();
    const current = manager.get(entry.id)!;
    const natural = config.action === "complete";
    const status = natural ? (config.bodyCode === 0 ? "completed" : "error") : "stopped";
    const reason = natural ? undefined : config.action === "timeout-before" ? "timeout" : "manual";
    const expected = { status, exitCode: natural ? config.bodyCode : undefined, signal: undefined, stopReason: reason, completedAt: current.completedAt };
    expect(typeof current.completedAt).toBe("number");
    expect(Number.isFinite(current.completedAt)).toBe(true);
    expect(tuple(current)).toEqual(expected);
    expect(terminals).toHaveLength(1);
    expect(completions).toHaveLength(natural || reason === "timeout" ? 1 : 0);
    for (const receipt of [...terminals, ...completions]) expect(tuple(receipt)).toEqual(expected);
    const finished = emittedEvents.filter(event => event.name === "monitor:finished");
    expect(finished).toHaveLength(1);
    expect(finished[0]?.payload.monitorId).toBe(entry.id);
    expect(finished[0]?.payload.status).toBe(status);
    expect(finished[0]?.payload.exitCode).toBe(natural ? config.bodyCode : undefined);
    expect(finished[0]?.payload.signal).toBeUndefined();
    expect(finished[0]?.payload.reason).toBe(reason);
    // Short ASCII fixture lines fit the buffer; inter-stream ordering is not promised.
    const rawLines = [...stdout.split("\n"), ...stderr.split("\n")].filter(Boolean).sort();
    expect([...current.outputBuffer].sort()).toEqual(rawLines);
    expect(emittedEvents.filter(event => event.name === "monitor:done")).toHaveLength(status === "completed" ? 1 : 0);
    expect(existsSync(work)).toBe(natural);
    expect(stdout.includes("ENGINEERING_GATE_START\n")).toBe(config.action === "complete" || config.action === "cancel-during");
    expect(stdout.includes("ENGINEERING_GATE_SUMMARY ")).toBe(natural);
    if (natural) expect(nativeClose).toEqual({ code: config.bodyCode, signal: null });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(tuple(manager.get(entry.id)!)).toEqual(expected);
    return {
      config, command, stdout, stderr, physical: nativeClose, outcome: expected,
      markerWithoutStart: stdout.includes("ENGINEERING_GATE_EXIT 0\n") && !stdout.includes("ENGINEERING_GATE_START\n"),
      workPerformed: existsSync(work), nativePid: child?.pid,
    };
  } catch (error) {
    const trace = { config, command, stdout, stderr, physical, nativePid: child?.pid, monitors: manager.list().map(tuple) };
    primaryError = new Error(`${error instanceof Error ? error.stack : String(error)}\nNative fixture trace: ${JSON.stringify(trace)}`, { cause: error });
    throw primaryError;
  } finally {
    await cleanupAll(primaryError, [
      () => manager.shutdown(),
      async () => { if (child && !physical) await guarded(closed, "cleanup close"); },
      () => rmSync(dir, { recursive: true, force: true }),
    ]);
  }
}

it("preserves the primary native trace and attempts remaining cleanup after a cleanup failure", async () => {
  const primary = new Error("original assertion; native trace");
  const cleanup = new Error("cleanup failed");
  const attempted: number[] = [];
  const error = await cleanupAll(primary, [
    () => { attempted.push(1); throw cleanup; },
    () => { attempted.push(2); },
  ]).catch(value => value);
  expect(attempted).toEqual([1, 2]);
  expect(error).toBeInstanceOf(AggregateError);
  expect(error.errors).toEqual([primary, cleanup]);
  expect(error.stack).toContain(primary.message);
  expect(error.stack).toContain(cleanup.message);
  await expect(cleanupAll(primary, [() => { attempted.push(3); }])).resolves.toBeUndefined();
});

nativeIt("keeps native pre-gate TERM exit-zero output distinct from manual cancellation", async () => {
  const result = await runNative({ action: "cancel-before", term: "zero", exitTrap: "status", bodyCode: 0, noise: false });
  expect(result.markerWithoutStart).toBe(true);
  expect(result.workPerformed).toBe(false);
  expect(result.physical).toEqual({ code: 0, signal: null });
  console.info(`native-monitor-witness: ${JSON.stringify(result)}`);
}, 15_000);

nativeIt("records normal native gate-body completion separately from cancellation", async () => {
  const result = await runNative({ action: "complete", term: "default", exitTrap: "status", bodyCode: 0, noise: false });
  expect(result.markerWithoutStart).toBe(false);
  expect(result.workPerformed).toBe(true);
}, 15_000);

nativeIt("models bounded generated POSIX producer patterns without trusting their exit markers", async () => {
  const options = { ...propertyOptions(8, 64), seed: Number.parseInt(process.env.FC_SEED ?? "155921", 10), interruptAfterTimeLimit: 120_000 };
  const requestedRuns = Number.parseInt(process.env.FC_NUM_RUNS ?? "8", 10);
  if (requestedRuns > options.numRuns) console.warn(`monitor-native: capped ${requestedRuns} requested runs to ${options.numRuns}`);
  const observations: Awaited<ReturnType<typeof runNative>>[] = [];
  let executions = 0;
  const details = await fc.check(fc.asyncProperty(scriptCase, async config => {
    executions++;
    observations.push(await runNative(config));
  }), options);
  const error = details.failed ? (details.errorInstance instanceof Error ? details.errorInstance.stack : String(details.errorInstance)) : undefined;
  const report = {
    platform: process.platform, node: process.version, options, requestedRuns, maxNumRuns: 64,
    executions, completedObservations: observations.length, numRuns: details.numRuns, numShrinks: details.numShrinks,
    failed: details.failed, interrupted: details.interrupted, counterexample: details.counterexample,
    counterexamplePath: details.counterexamplePath, error,
    failedTraceCoverage: "final shrunk error only; not every failed attempt",
    witnesses: observations.filter(value => value.markerWithoutStart), observations,
  };
  if (process.env.NATIVE_MONITOR_REPORT) writeFileSync(process.env.NATIVE_MONITOR_REPORT, `${JSON.stringify(report, null, 2)}\n`);
  console.info(`monitor-native: runs=${details.numRuns} executions=${executions} witnesses=${report.witnesses.length} interrupted=${details.interrupted}`);
  expect(details.interrupted, "Native campaign interrupted; coverage is incomplete").toBe(false);
  expect(details.failed, error).toBe(false);
}, 180_000);
