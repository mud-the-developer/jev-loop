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

it.skipIf(process.platform === "win32")("operator refusal performs no verification, fixture work, or JEV call", async () => {
  const child = spawn(process.execPath, [...args, "--operator-bridge"], { cwd, stdio: ["pipe", "pipe", "pipe"] });
  const frames: any[] = [];
  let buffer = "";
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
        child.stdin.write(`${JSON.stringify({ type: "extension_ui_response", id: frame.id, confirmed: false })}\n`);
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
    expect(frames.filter(frame => frame.type === "extension_ui_request")).toHaveLength(1);
    expect(frames.find(frame => frame.type === "operator_result")).toMatchObject({ status: "approval_declined", approvals: 0, verificationCodes: [], jevCalls: 0 });
    expect(frames.some(frame => frame.type === "jev_decision_request")).toBe(false);
  } finally {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGTERM"); await once(child, "close"); }
  }
});
