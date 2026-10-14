import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import type { WorkflowDefinition } from "../src/types.js";

const definition: WorkflowDefinition = { version: 1, initialState: "work", states: {
  work: { prompt: "Inspect effects before continuing", task: { subject: "Work", description: "Explicitly recover" }, on: { finish: "done" } },
  done: { prompt: "Done", terminal: "completed" },
} };
const fixture = fileURLToPath(new URL("./fixtures/workflow-crash-child.ts", import.meta.url));
const owner = { sessionId: "killed-child-session", runtimeId: "child-owner" };

function snapshots(path: string) {
  return [readFileSync(path, "utf8"), existsSync(`${path}.prev`) ? readFileSync(`${path}.prev`, "utf8") : undefined];
}

describe("real process interruption at persistence boundaries", () => {
  it.each(["owner", "previous", "current"])("recovers a SIGKILLed child at %s without treating death as a workflow lease release", async (checkpoint) => {
    const dir = mkdtempSync(join(tmpdir(), "pi-loop-process-crash-"));
    const path = join(dir, "loops.json");
    const now = Date.now();
    let clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const store = new LoopStore(path);
    store.create({ type: "dynamic" }, "Crash test", { recurring: true, workflow: definition, actor: owner });
    clock.mockRestore();
    const original = snapshots(path);
    const child = spawn(process.execPath, ["--import", "tsx", fixture, path, checkpoint, String(now + 1000)], { stdio: ["ignore", "pipe", "pipe"] });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    let diagnostics = "";
    child.stderr.on("data", (chunk) => { diagnostics = (diagnostics + String(chunk)).slice(-8192); });
    try {
      const reached = await new Promise<{ checkpoint: string; pid: number }>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(() => reject(new Error(`Fixture checkpoint timeout: ${diagnostics}`)), 15000);
        child.once("error", (error) => { clearTimeout(timer); reject(error); });
        child.once("exit", () => { clearTimeout(timer); reject(new Error(`Fixture exited before checkpoint: ${diagnostics}`)); });
        child.stdout.on("data", (chunk) => {
          output += String(chunk);
          if (!output.includes("\n")) return;
          clearTimeout(timer);
          try { resolve(JSON.parse(output.split("\n")[0]!)); } catch (error) { reject(error); }
        });
      });
      expect(reached).toEqual({ checkpoint, pid: child.pid });
      const claims = readdirSync(`${path}.lock`);
      expect(claims).toHaveLength(1);
      expect(readFileSync(join(`${path}.lock`, claims[0]!), "utf8")).toMatch(new RegExp(`^${child.pid}:[0-9a-f-]+$`));
      if (checkpoint === "owner") {
        // Real elapsed time, not a frozen clock: lock retries busy-wait.
        expect(() => new LoopStore(path).claimWorkflowExecution("1", owner, 60)).toThrow(/acquire lock/);
        expect(snapshots(path)).toEqual(original);
        expect(child.exitCode).toBeNull();
        expect(readFileSync(join(`${path}.lock`, claims[0]!), "utf8")).toMatch(new RegExp(`^${child.pid}:`));
      }
      expect(child.kill("SIGKILL")).toBe(true);
      const death = await exited;
      expect(death.signal).toBe("SIGKILL");
      expect(existsSync(`${path}.lock`)).toBe(true);
      const persisted = snapshots(path);
      if (checkpoint !== "current") expect(persisted[0]).toBe(original[0]);
      if (checkpoint !== "owner") expect(persisted[1]).toBe(original[0]);
      const recovered = new LoopStore(path);
      const run = structuredClone(recovered.get("1")!.workflow!);
      expect(run.currentState).toBe("work");
      expect(run.transitionSeq).toBe(0);
      expect(run.activeExecution?.id).toBe("work:0");
      expect(run.attemptsByState).toEqual({ work: 1 });
      expect(run.activeExecution?.lease?.heartbeatAt).toBe(checkpoint === "current" ? now + 1000 : now);
      expect(run.activeExecution?.lease?.expiresAt).toBe(checkpoint === "current" ? now + 61000 : now + 1800000);
      const fresh = { sessionId: owner.sessionId, runtimeId: "fresh-runtime" };
      clock = vi.spyOn(Date, "now").mockReturnValue(now + 1001);
      expect(recovered.claimWorkflowExecution("1", fresh, 60)).toMatchObject({ claimed: false, error: "Workflow execution is leased to another active runtime" });
      expect(snapshots(path)).toEqual(persisted);
      expect(existsSync(`${path}.lock`)).toBe(false);
      clock.mockReturnValue(run.activeExecution!.lease!.expiresAt);
      expect(recovered.claimWorkflowExecution("1", fresh, 60).claimed).toBe(true);
      const expected = { currentState: "work", transitionSeq: 0, definitionRevision: 1, activeExecutionId: "work:0" };
      const claimed = snapshots(path);
      expect(recovered.transitionWorkflow("1", { outcome: "finish", actor: owner }, expected).applied).toBe(false);
      expect(snapshots(path)).toEqual(claimed);
      expect(recovered.transitionWorkflow("1", { outcome: "finish", actor: fresh }, expected)).toMatchObject({ applied: true, terminal: "completed" });
      expect(new LoopStore(path).get("1")).toBeUndefined();
    } finally {
      clock.mockRestore();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited.catch(() => {});
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
});
