import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const cwd = fileURLToPath(new URL("..", import.meta.url));
const args = ["--import", "tsx", "test/e2e/jev-loop-operator.mjs"];

it("operator acceptance without an explicit client is SKIP, never an automatic approval or live pass", async () => {
  const result = await promisify(execFile)(process.execPath, args, { cwd });
  expect(result.stdout).toContain("SKIP:");
  expect(result.stdout).not.toContain('"status":"passed"');
});

it.skipIf(process.platform === "win32").each(["decline", "oversize-ascii", "oversize-utf8", "truncated", "stale", "malformed"])("operator %s input grants no verification, fixture work, or JEV call", async mode => {
  const child = spawn(process.execPath, [...args, "--operator-bridge"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const frames: any[] = [];
  const writeErrors: Error[] = [];
  let buffer = "";
  // Aborting malformed input can close the pipe before the client flushes it.
  child.stdin.on("error", error => writeErrors.push(error));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const end = buffer.indexOf("\n");
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let frame: any;
      try { frame = JSON.parse(line); }
      catch { child.kill("SIGTERM"); return; }
      frames.push(frame);
      if (frame.type === "extension_ui_request") {
        const response = { type: "extension_ui_response", id: frame.id, confirmed: false };
        if (mode === "truncated") child.stdin.end(JSON.stringify(response).slice(0, -1));
        else if (mode === "malformed") child.stdin.write("{invalid-json}\n");
        else if (mode === "stale") child.stdin.write(`${JSON.stringify({ ...response, id: "stale-request" })}\n${JSON.stringify(response)}\n`);
        else if (mode.startsWith("oversize")) child.stdin.write(`${JSON.stringify({ ...response, padding: mode === "oversize-ascii" ? "x".repeat(33000) : "한".repeat(11000) })}\n`);
        else child.stdin.write(`${JSON.stringify(response)}\n`);
      }
      if (frame.type === "jev_decision_request") {
        child.stdin.write(`${JSON.stringify({ type: "jev_decision_response", id: frame.id, error: "Unexpected request after refusal" })}\n`);
      }
    }
  });
  // Consume stderr so backpressure cannot masquerade as a lifecycle failure.
  child.stderr.resume();
  try {
    const [code] = await once(child, "close");
    expect(code).toBe(1);
    if (mode === "decline") expect(writeErrors).toEqual([]);
    expect(frames.filter(frame => frame.type === "extension_ui_request")).toHaveLength(1);
    expect(frames.find(frame => frame.type === "operator_result")).toMatchObject({ status: mode === "decline" ? "approval_declined" : "held", approvals: 0, verificationCodes: [], jevCalls: 0 });
    expect(frames.some(frame => frame.type === "jev_decision_request")).toBe(false);
  } finally {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "close"); }
  }
});
