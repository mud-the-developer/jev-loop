import type { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { collectProfiles, decideOutcome, profileText, summarizeCampaign, summarizeVitest } from "../benchmarks/fuzz-profile-report.js";
import { buildChildPlan, outputCollector, parseProfileArgs, runChild, runProfile } from "../benchmarks/profile-fuzz.js";
import config from "../vitest.config.js";

// Feature expectations: no production defect/red-reproduction claim.
describe("opt-in fuzz profiling feature", () => {
  it("bounds UTF-8 profile bytes before any artifact write", () => {
    const value = { name: "é" };
    const expected = JSON.stringify(value);
    expect(profileText(value, Buffer.byteLength(expected))).toBe(expected);
    expect(() => profileText(value, Buffer.byteLength(expected) - 1)).toThrow(/exceeds/);
    expect(() => profileText(undefined)).toThrow(/absent/);
  });
  it("uses strict positive safe integers, bounded runs and explicit replay selection", () => {
    expect(parseProfileArgs([])).toMatchObject({ suite: "monitor-runtime", requestedRuns: 100, runs: 100, seed: 130363, timeoutMs: 600000 });
    for (const bad of ["0", "-1", "1.2", "3x", "1e3", "Infinity", "9007199254740992", "", " 3"]) {
      expect(() => parseProfileArgs(["--runs", bad])).toThrow();
      expect(() => parseProfileArgs(["--seed", bad])).toThrow();
    }
    expect(() => parseProfileArgs(["--suite", "../../other"])).toThrow();
    expect(() => parseProfileArgs(["--unknown"])).toThrow();
    expect(() => parseProfileArgs(["--timeout-ms", "600001"])).toThrow();
    expect(() => parseProfileArgs(["--suite", "monitor-native", "--path", "0", "--seed", "3", "--test", ".*"])).toThrow(/one/);
    expect(() => parseProfileArgs(["--path", "0", "--test", "fault-injected"])).toThrow(/seed/);
    expect(() => parseProfileArgs(["--path", "0", "--seed", "3"])).toThrow(/test/);
    expect(() => parseProfileArgs(["--path", "0", "--seed", "3", "--test", ".*"])).toThrow(/one/);
    expect(() => parseProfileArgs(["--path", "", "--seed", "3", "--test", "fault-injected"])).toThrow();
    expect(() => parseProfileArgs(["--test", "["])).toThrow();
    expect(() => parseProfileArgs(["--test", "missing-property"])).toThrow();
    expect(parseProfileArgs(["--path", "0:1", "--seed", "3", "--test", "fault-injected"])).toMatchObject({ path: "0:1", replay: true, selectedProperties: [expect.stringContaining("fault-injected")] });
  });

  it("reports global and native caps without claiming actual runs", () => {
    expect(parseProfileArgs(["--runs", "1001"])).toMatchObject({ requestedRuns: 1001, runs: 1000, maximumRuns: 1000, clipped: true });
    for (const [requested, actual] of [[63, 63], [64, 64], [65, 64], [1001, 64]] as const) {
      expect(parseProfileArgs(["--suite", "monitor-native", "--runs", String(requested)])).toMatchObject({ requestedRuns: requested, runs: actual, maximumRuns: 64, globalMaximumRuns: 1000, clipped: requested > actual });
    }
  });

  it("spawns one allowlisted file without shell and removes inherited replay/report settings", () => {
    const options = parseProfileArgs(["--suite", "monitor-inactivity", "--runs", "3"]);
    const inherited = { PATH: "/bin", FC_PATH: "stale", FC_SEED: "9", MONITOR_FUZZ_REPORT: "/user/file", NODE_OPTIONS: "--cpu-prof", PI_LOOP_FUZZ_PROFILE_DIR: "/user/profile", SECRET: "not metadata" };
    const plan = buildChildPlan(options, "/repo", "/owned", inherited);
    expect(plan.binary).toBe(process.execPath);
    expect(plan.args).toEqual(expect.arrayContaining([join("/repo", "node_modules/vitest/vitest.mjs"), "test/property/monitor-inactivity.property.test.ts", "--maxWorkers=1", "--no-file-parallelism", "--reporter=default", "--reporter=json"]));
    expect(plan.env).toMatchObject({ FC_NUM_RUNS: "3", FC_SEED: "130363", PI_LOOP: "off", PI_LOOP_SCOPE: "memory", MONITOR_INACTIVITY_REPORT: join("/owned", "campaign.json"), PI_LOOP_FUZZ_PROFILE_DIR: "/owned" });
    expect(plan.env.FC_PATH).toBeUndefined();
    expect(plan.env.MONITOR_FUZZ_REPORT).toBeUndefined();
    expect(plan.env.NODE_OPTIONS).toBeUndefined();
    expect(inherited.FC_PATH).toBe("stale");
    expect(buildChildPlan(parseProfileArgs(["--path", "0:1", "--seed", "7", "--test", "fault-injected"]), "/repo", "/owned", {}).env.FC_PATH).toBe("0:1");
  });

  it("links observed counters; unknown is not zero or requested", () => {
    expect(summarizeCampaign({ numRuns: 2, numShrinks: 1, failed: true, counters: { executions: 5, commands: 9, operations: { stop: 2 } } }, "monitor-runtime")).toEqual([expect.objectContaining({ actualRuns: 2, checks: 5, shrinks: 1, actions: 9, interrupted: null, failed: true })]);
    expect(summarizeCampaign({ completed: 3, coverage: { restart: 8 }, options: { numRuns: 100 } }, "workflow-restart")).toEqual([expect.objectContaining({ actualRuns: null, completed: 3, checks: null, shrinks: null, actions: null, actionCounts: { restart: 8 }, interrupted: null, failed: null })]);
    expect(summarizeCampaign({}, "monitor-native")[0]).toMatchObject({ actualRuns: null, interrupted: null, failed: null });
    expect(summarizeCampaign({ numRuns: 1, failed: false, interrupted: true }, "monitor-native")[0]).toMatchObject({ failed: false, interrupted: true });
    expect(() => summarizeCampaign([], "monitor-runtime")).toThrow();
  });

  it("never reports skips, missing artifacts, interruption, or abnormal child exit as PASS", () => {
    const child = { exitCode: 0, signal: null, error: null, timedOut: false };
    const campaign = summarizeCampaign({ numRuns: 3, failed: false }, "monitor-runtime");
    const tests = summarizeVitest({ success: true, testResults: [{ assertionResults: [{ status: "passed", fullName: "property" }] }] });
    const good = { child, campaign, tests, profileCount: 1, errors: [] };
    expect(decideOutcome(good)).toBe("PASS");
    expect(decideOutcome({ ...good, profileCount: 0 })).toBe("INCOMPLETE");
    expect(decideOutcome({ ...good, campaign: [] })).toBe("INCOMPLETE");
    expect(decideOutcome({ ...good, campaign: summarizeCampaign({ numRuns: 0, failed: false }, "monitor-runtime") })).toBe("INCOMPLETE");
    expect(decideOutcome({ ...good, tests: null })).toBe("INCOMPLETE");
    expect(decideOutcome({ ...good, tests: { ...tests, skipped: 1 } })).toBe("INCOMPLETE");
    expect(decideOutcome({ ...good, campaign: summarizeCampaign({ interrupted: true, failed: false }, "monitor-native") })).toBe("INTERRUPTED");
    expect(decideOutcome({ ...good, child: { ...child, timedOut: true, signal: "SIGTERM" } })).toBe("INTERRUPTED");
    expect(decideOutcome({ ...good, child: { ...child, exitCode: 1 }, campaign: summarizeCampaign({ failed: false, interrupted: true }, "monitor-native"), tests: { ...tests, failed: 1 } })).toBe("INTERRUPTED");
    expect(decideOutcome({ ...good, child: { ...child, exitCode: 1 } })).toBe("FAIL");
    expect(decideOutcome({ ...good, errors: ["profile checksum mismatch"] })).toBe("FAIL");
  });

  it("distinguishes pattern-excluded tests from skipped selected properties", () => {
    const report = { success: true, testResults: [{ assertionResults: [{ fullName: "selected", status: "passed" }, { fullName: "excluded", status: "pending" }] }] };
    expect(summarizeVitest(report, ["selected"])).toMatchObject({ passed: 1, skipped: 0, filtered: [{ name: "excluded", status: "pending" }], properties: [{ name: "selected", status: "passed" }] });
    expect(summarizeVitest(report, ["selected", "excluded"]).skipped).toBe(1);
    report.testResults[0]!.assertionResults[1]!.status = "failed";
    expect(summarizeVitest(report, ["selected"]).failed).toBe(1);
  });

  it("bounds retained output and hashes the entire observed stream even after truncation", () => {
    const collector = outputCollector(4);
    collector.add(Buffer.from("abc"));
    collector.add(Buffer.from("def"));
    expect(collector.finish()).toEqual({ text: "abcd", bytes: 6, truncated: true, sha256: createHash("sha256").update("abcdef").digest("hex") });
    const unicode = outputCollector(1);
    unicode.add(Buffer.from("é"));
    expect(Buffer.byteLength(unicode.finish().text)).toBeLessThanOrEqual(1);
  });

  it("terminates a timed-out command once, preserves output and bounds an unobserved close", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const stdout = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      const stderr = Object.assign(new EventEmitter(), { destroy: vi.fn() });
      const child = Object.assign(new EventEmitter(), { stdout, stderr, pid: undefined, kill: vi.fn(() => true), unref: vi.fn() });
      const spawnChild = vi.fn(() => child) as unknown as typeof spawn;
      const plan = buildChildPlan(parseProfileArgs(["--runs", "3"]), "/repo", "/owned", {});
      const pending = runChild(plan, 5, spawnChild);
      stdout.emit("data", Buffer.from("primary assertion"));
      stderr.emit("data", Buffer.from("original error"));
      await vi.advanceTimersByTimeAsync(2005);
      expect(await pending).toMatchObject({ exitCode: null, signal: null, timedOut: true, error: "Child close unobserved after bounded termination", stdout: "primary assertion", stderr: "original error" });
      expect(spawnChild).toHaveBeenCalledTimes(1);
      expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
      expect(stdout.destroy).toHaveBeenCalledOnce();
      expect(stderr.destroy).toHaveBeenCalledOnce();
      expect(child.unref).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("requires checksummed worker profiles and never mutates user files", () => {
    const dir = mkdtempSync(join(tmpdir(), "fuzz-profile-unit-"));
    try {
      const sourceFile = "/repo/test/property/monitor-runtime.property.test.ts";
      expect(collectProfiles(dir, sourceFile)).toMatchObject({ profiles: [], errors: [] });
      const data = JSON.stringify({ nodes: [{ id: 1, callFrame: { functionName: "campaign" } }], samples: [1] });
      writeFileSync(join(dir, "worker.cpuprofile"), data);
      const metadata = { role: "property-worker", sourceFile, pid: 12, node: process.version, sha256: createHash("sha256").update(data).digest("hex"), sizeBytes: Buffer.byteLength(data), wallTimeMs: 12, resources: { userCPUTimeMicros: 5, systemCPUTimeMicros: 3, maxRSSKiB: 99 }, complete: true };
      writeFileSync(join(dir, "worker.meta.json"), JSON.stringify(metadata));
      expect(collectProfiles(dir, sourceFile)).toMatchObject({ profiles: [expect.objectContaining({ metadata })], errors: [] });
      writeFileSync(join(dir, "worker.meta.json"), JSON.stringify({ ...metadata, role: "coordinator" }));
      expect(collectProfiles(dir, sourceFile).errors.join(" ")).toMatch(/worker/);
      writeFileSync(join(dir, "worker.meta.json"), JSON.stringify({ ...metadata, sourceFile: "/wrong.test.ts" }));
      expect(collectProfiles(dir, sourceFile).errors.join(" ")).toMatch(/worker/);
      writeFileSync(join(dir, "worker.meta.json"), JSON.stringify({ ...metadata, sha256: "bad" }));
      expect(collectProfiles(dir, sourceFile).errors.join(" ")).toMatch(/checksum/);
      expect(readFileSync(join(dir, "worker.cpuprofile"), "utf8")).toBe(data);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("preserves primary failed output and child status through reporting errors in unique owned runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fuzz-profile-cli-"));
    try {
      const options = parseProfileArgs(["--out", dir, "--runs", "3"]);
      const runChild = async () => ({ exitCode: 1, signal: null, error: null, timedOut: false, wallTimeMs: 4, stdout: "original assertion trace", stderr: "primary failure", stdoutBytes: 24, stderrBytes: 15, stdoutTruncated: false, stderrTruncated: false, stdoutSHA256: "raw", stderrSHA256: "raw", resourceCoverage: "worker-only; coordinator CPU/RSS unknown" });
      const first = await runProfile(options, "/repo", { runChild, writeSummary: () => { throw new Error("reporting failed"); } });
      const second = await runProfile(options, "/repo", { runChild });
      expect(first.artifactDir).not.toBe(second.artifactDir);
      expect(first.outcome).toBe("FAIL");
      expect(first.child.exitCode).toBe(1);
      expect(first.errors.join(" ")).toContain("reporting failed");
      expect(readFileSync(join(first.artifactDir, "stdout.log"), "utf8")).toBe("original assertion trace");
      expect(readFileSync(join(first.artifactDir, "stderr.log"), "utf8")).toBe("primary failure");
      expect(JSON.stringify(first)).not.toContain("SECRET");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("links raw campaign and reporter hashes independently of their JSON validity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fuzz-profile-links-"));
    try {
      const options = parseProfileArgs(["--suite", "monitor-inactivity", "--runs", "3", "--out", dir]);
      const runChild = async (plan: ReturnType<typeof buildChildPlan>) => {
        const owned = plan.env.PI_LOOP_FUZZ_PROFILE_DIR!;
        writeFileSync(join(owned, "campaign.json"), "malformed report");
        writeFileSync(join(owned, "vitest.json"), JSON.stringify({ success: true, testResults: [{ assertionResults: [{ status: "passed", fullName: options.selectedProperties[0] }] }] }));
        return { exitCode: 0, signal: null, error: null, timedOut: false, wallTimeMs: 4, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, stdoutSHA256: "raw", stderrSHA256: "raw", resourceCoverage: "unknown" };
      };
      const result = await runProfile(options, process.cwd(), { runChild });
      expect(result.outcome).not.toBe("PASS");
      expect(result.campaignArtifact).toMatchObject({ sha256: createHash("sha256").update("malformed report").digest("hex"), sizeBytes: 16, parseError: expect.any(String) });
      expect(result.testArtifact?.sha256).toBe(createHash("sha256").update(readFileSync(join(result.artifactDir, "vitest.json"))).digest("hex"));
      expect(result.profileStatus).toBe("missing");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("does not certify profiling evidence when required source identity is unavailable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fuzz-profile-identity-"));
    try {
      const options = parseProfileArgs(["--suite", "monitor-inactivity", "--runs", "3", "--out", dir]);
      const runChild = async (plan: ReturnType<typeof buildChildPlan>) => {
        const owned = plan.env.PI_LOOP_FUZZ_PROFILE_DIR!;
        writeFileSync(join(owned, "campaign.json"), JSON.stringify({ numRuns: 3, failed: false }));
        writeFileSync(join(owned, "vitest.json"), JSON.stringify({ success: true, testResults: [{ assertionResults: [{ status: "passed", fullName: options.selectedProperties[0] }] }] }));
        const raw = JSON.stringify({ nodes: [{ id: 1 }], samples: [1] });
        writeFileSync(join(owned, "worker.cpuprofile"), raw);
        writeFileSync(join(owned, "worker.meta.json"), JSON.stringify({ role: "property-worker", complete: true, sourceFile: join(dir, plan.file), pid: 1, node: process.version, wallTimeMs: 1, resources: { userCPUTimeMicros: 1, systemCPUTimeMicros: 1, maxRSSKiB: 1 }, sha256: createHash("sha256").update(raw).digest("hex"), sizeBytes: Buffer.byteLength(raw) }));
        return { exitCode: 0, signal: null, error: null, timedOut: false, wallTimeMs: 1, stdout: "", stderr: "", stdoutBytes: 0, stderrBytes: 0, stdoutTruncated: false, stderrTruncated: false, stdoutSHA256: "raw", stderrSHA256: "raw", resourceCoverage: "control" };
      };
      const result = await runProfile(options, dir, { runChild });
      expect(result.child.exitCode).toBe(0);
      expect(result.tests?.passed).toBe(1);
      expect(result.profileCount).toBe(1);
      expect(result.sourceManifest.complete).toBe(false);
      expect(result.errors).toEqual(expect.arrayContaining([expect.stringContaining("Required source identity"), expect.stringContaining("Source manifest incomplete")]));
      expect(result.outcome).toBe("FAIL");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("has no default setup profiling or environment/listener/resource mutations during planning", () => {
    const environment = { ...process.env };
    const resources = process.getActiveResourcesInfo().sort();
    const listeners = process.eventNames().map(name => [name, process.listenerCount(name)]);
    expect(config.test?.setupFiles).toBeUndefined();
    buildChildPlan(parseProfileArgs([]), "/repo", "/owned");
    expect(process.env).toEqual(environment);
    expect(process.getActiveResourcesInfo().sort()).toEqual(resources);
    expect(process.eventNames().map(name => [name, process.listenerCount(name)])).toEqual(listeners);
  });
});
