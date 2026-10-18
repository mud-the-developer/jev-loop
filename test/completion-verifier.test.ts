import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VERIFICATION_SUPPORTED, verifyCompletion } from "../src/completion-verifier.js";

const directories: string[] = [];
function directory() {
  const cwd = mkdtempSync(join(tmpdir(), "jev-verifier-"));
  directories.push(cwd);
  return cwd;
}
afterEach(() => { for (const cwd of directories.splice(0)) rmSync(cwd, { recursive: true, force: true }); });

// This is real POSIX child execution, not evidence about a live JEV model or Windows.
describe.skipIf(!VERIFICATION_SUPPORTED)("fixed verifier process boundary", () => {
  it.each([0, 7])("retains the actual exit code %i without collecting output", async code => {
    const result = await verifyCompletion(process.execPath, ["-e", `console.log('PRIVATE'); process.exit(${code})`], {
      cwd: directory(), signal: new AbortController().signal, timeout: 2000,
    });
    expect(result).toEqual({ code, signal: null, killed: false });
    expect(result).not.toHaveProperty("stdout");
  });

  it("cannot treat spontaneous signal termination as exit zero", async () => {
    const result = await verifyCompletion(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")'], {
      cwd: directory(), signal: new AbortController().signal, timeout: 2000,
    });
    expect(result.code).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("passes literal arguments and the approved working directory without a shell", async () => {
    const cwd = directory();
    const literal = "$(touch MUST_NOT_EXIST); * ' 한글";
    const exact = await verifyCompletion(process.execPath, ["-e", `process.exit(process.cwd() === process.argv[1] && process.argv[2] === ${JSON.stringify(literal)} ? 0 : 9)`, cwd, literal], {
      cwd, signal: new AbortController().signal, timeout: 2000,
    });
    expect(exact.code).toBe(0);
    expect(existsSync(join(cwd, "MUST_NOT_EXIST"))).toBe(false);
  });

  it("does not spawn for an already cancelled request", async () => {
    const cwd = directory(); const controller = new AbortController(); controller.abort();
    const result = await verifyCompletion(process.execPath, ["-e", 'require("node:fs").writeFileSync("MUST_NOT_EXIST", "bad")'], { cwd, signal: controller.signal, timeout: 1000 });
    expect(result.killed).toBe(true);
    expect(existsSync(join(cwd, "MUST_NOT_EXIST"))).toBe(false);
  });

  it("rejects an unavailable executable", async () => {
    const cwd = directory();
    await expect(verifyCompletion(join(cwd, "absent"), [], { cwd, signal: new AbortController().signal, timeout: 1000 })).rejects.toThrow("could not start");
  });

  it("times out rather than accepting a hung verifier", async () => {
    const result = await verifyCompletion(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: directory(), signal: new AbortController().signal, timeout: 150,
    });
    expect(result.killed).toBe(true);
    expect(result.code).not.toBe(0);
  });

  it("kills descendants in its process group when their verifier leader exits", async () => {
    const cwd = directory();
    const descendant = 'const fs = require("node:fs"); fs.writeFileSync("ready", "yes"); setInterval(() => fs.appendFileSync("ticks", "."), 30); setTimeout(() => process.exit(0), 1500)';
    const leader = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" }); const fs = require("node:fs"); setInterval(() => { if (fs.existsSync("ticks")) process.exit(0); }, 10); setTimeout(() => process.exit(8), 3000)`;
    const result = await verifyCompletion(process.execPath, ["-e", leader], { cwd, signal: new AbortController().signal, timeout: 4000 });
    expect(result.code).toBe(0);
    const stopped = readFileSync(join(cwd, "ticks"), "utf8");
    await new Promise(resolve => setTimeout(resolve, 180));
    expect(readFileSync(join(cwd, "ticks"), "utf8")).toBe(stopped);
  });

  it("escalates cancellation when a started verifier ignores SIGTERM", async () => {
    const cwd = directory(); const controller = new AbortController();
    const pending = verifyCompletion(process.execPath, ["-e", 'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync("ready", "yes"); setTimeout(() => process.exit(17), 6000)'], { cwd, signal: controller.signal, timeout: 4000 });
    try {
      await vi.waitFor(() => expect(existsSync(join(cwd, "ready"))).toBe(true));
      const started = performance.now(); controller.abort();
      const result = await pending;
      expect(result).toMatchObject({ killed: true, code: null, signal: "SIGKILL" });
      expect(performance.now() - started).toBeLessThan(2000);
    } finally { controller.abort(); await pending; }
  });
});
