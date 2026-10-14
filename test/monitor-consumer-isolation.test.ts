import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { MonitorManager } from "../src/monitor-manager.js";
import type { MonitorEntry } from "../src/types.js";
import { createMockPi } from "./helpers/mock-pi.js";
import { createMockChildProcess } from "./helpers/mock-spawn.js";

async function fixture(run: (manager: MonitorManager, child: ChildProcess, id: string, events: ReturnType<typeof createMockPi>["emittedEvents"]) => Promise<void>) {
  vi.useFakeTimers();
  const { pi, emittedEvents } = createMockPi();
  const child = createMockChildProcess({ exitCode: null });
  const manager = new MonitorManager(pi, () => child);
  const entry = manager.create("generic command", undefined, 0);
  try { await run(manager, child, entry.id, emittedEvents); }
  finally {
    const closing = manager.shutdown();
    await vi.advanceTimersByTimeAsync(5000);
    await closing;
    vi.useRealTimers();
  }
}

describe("monitor callback consumer isolation hardening", () => {
  // Seed130363 path5:4:4:4:7:7:7:7:7:7:7; mutation is a consumer-boundary injection.
  it("keeps timeout authoritative after the generated two-action callback mutation", async () => fixture(async (manager, _child, id) => {
    manager.onTerminal(id, monitor => { monitor.status = "error"; monitor.exitCode = 1; });
    const stopping = manager.stop(id, "timeout");
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stopping).toBe(true);
    expect(manager.get(id)).toMatchObject({ status: "stopped", stopReason: "timeout" });
    expect(manager.get(id)?.exitCode).toBeUndefined();
  }));

  it("cannot forge zero success or rewrite another consumer's nested receipt after cancellation", async () => fixture(async (manager, child, id, events) => {
    child.stdout?.emit("data", Buffer.from("ENGINEERING_GATE_EXIT 0\n"));
    manager.updateProgress(id, { current: 3, message: "real progress" });
    const receipts: MonitorEntry[] = [];
    manager.onTerminal(id, monitor => {
      monitor.id = "different-resource";
      monitor.status = "completed";
      monitor.exitCode = 0;
      monitor.outputBuffer[0] = "forged receipt";
      monitor.progress!.current = 99;
    });
    manager.onTerminal(id, monitor => receipts.push(structuredClone(monitor)));
    const stopping = manager.stop(id);
    child.emit("close", 0);
    expect(await stopping).toBe(true);
    expect(manager.get(id)).toMatchObject({ id, status: "stopped", stopReason: "manual", outputBuffer: ["ENGINEERING_GATE_EXIT 0"], progress: { current: 3 } });
    expect(manager.get(id)?.exitCode).toBeUndefined();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ id, status: "stopped", stopReason: "manual", outputBuffer: ["ENGINEERING_GATE_EXIT 0"], progress: { current: 3 } });
    expect(receipts[0]?.exitCode).toBeUndefined();
    expect(events.filter(event => event.name === "monitor:done")).toEqual([]);
  }));

  it.each(["manual", "timeout", "normal-zero", "nonzero-error"] as const)("preserves passive consumers and intended %s outcome", async mode => fixture(async (manager, child, id, events) => {
    const receipts: MonitorEntry[] = [];
    manager.onTerminal(id, monitor => receipts.push(structuredClone(monitor)));
    if (mode === "manual" || mode === "timeout") {
      const stopping = manager.stop(id, mode);
      child.emit("close", 0);
      expect(await stopping).toBe(true);
    } else child.emit("close", mode === "normal-zero" ? 0 : 1);
    const expected = mode === "normal-zero" ? { status: "completed", exitCode: 0 }
      : mode === "nonzero-error" ? { status: "error", exitCode: 1 }
      : { status: "stopped", stopReason: mode };
    expect(manager.get(id)).toMatchObject(expected);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject(expected);
    expect(manager.get(id)?.exitCode).toBe(mode === "normal-zero" ? 0 : mode === "nonzero-error" ? 1 : undefined);
    expect(receipts[0]?.exitCode).toBe(mode === "normal-zero" ? 0 : mode === "nonzero-error" ? 1 : undefined);
    expect(events.filter(event => event.name === "monitor:done")).toHaveLength(mode === "normal-zero" ? 1 : 0);
  }));
});
