import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { runStartupProfile } from "../benchmarks/profile-startup.js";
import { pairedStartupSummary, preserveStartupCleanup, startupOptions, summarizeDurations } from "../benchmarks/startup-report.js";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

describe("startup profiling expectations", () => {
  it("rejects raw Windows drive preloads while an existing file URL loads", () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-loader-"));
    try {
      const preload = join(dir, "preload space é #.mjs");
      writeFileSync(preload, "process.stdout.write('owned preload loaded');\n");
      const rejected = spawnSync(process.execPath, ["--import", String.raw`C:\owned\preload.mjs`, "--eval", ""], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
      expect(rejected.status).toBe(1);
      expect(rejected.signal).toBeNull();
      expect(rejected.stderr).toContain("ERR_UNSUPPORTED_ESM_URL_SCHEME");
      expect(rejected.stderr).toContain("c:");
      expect(rejected.stdout).not.toContain("owned preload loaded");
      const loaded = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "--eval", ""], { encoding: "utf8", timeout: 5000, maxBuffer: 1024 * 1024 });
      expect(loaded.status).toBe(0);
      expect(loaded.signal).toBeNull();
      expect(loaded.stderr).toBe("");
      expect(loaded.stdout).toBe("owned preload loaded");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("passes file URLs for every actual metrics and CPU preload", async () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-profile-argv-"));
    try {
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "control-only" }));
      const cli = join(dir, "bin/cli.mjs");
      writeFileSync(cli, `import {pathToFileURL} from 'node:url'; const i=process.argv.indexOf('-e'); if(i>=0)await(await import(pathToFileURL(process.argv[i+1]).href)).default({});\n`);
      const entry = join(dir, "entry space é #.mjs");
      writeFileSync(entry, "export default function() {}\n");
      vi.mocked(spawnSync).mockClear();
      const result = await runStartupProfile(["--cli", cli, "--baseline", entry, "--rounds", "3", "--warmups", "0", "--profiles", "--out", join(dir, "out")]);
      expect(result.metadata.complete).toBe(true);
      expect(result.metadata.samples).toHaveLength(9);
      expect(result.metadata.profileSamples).toHaveLength(3);
      expect(result.metadata.profiles).toHaveLength(3);
      const children = vi.mocked(spawnSync).mock.calls.filter(([binary]) => binary === process.execPath);
      expect(children).toHaveLength(12);
      let preloads = 0;
      for (const [, args] of children) {
        for (let i = 0; i < (args?.length ?? 0); i++) {
          if (args?.[i] !== "--import") continue;
          preloads++;
          expect(args[i + 1]).toMatch(/^file:\/\//);
        }
      }
      expect(preloads).toBe(15);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("requires affirmative factory receipts despite a zero-exit CLI swallowing load errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-profile-control-"));
    try {
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "control-only" }));
      const cli = join(dir, "bin/cli.mjs");
      writeFileSync(cli, `import {pathToFileURL} from 'node:url'; const i=process.argv.indexOf('-e'); try {if(i>=0)await(await import(pathToFileURL(process.argv[i+1]).href)).default({});} catch {}\n`);
      const entry = join(dir, "entry.mjs");
      const args = (out: string) => ["--cli", cli, "--baseline", entry, "--rounds", "3", "--warmups", "0", "--out", join(dir, out)];
      writeFileSync(entry, "export default function() {}\n");
      const normal = await runStartupProfile(args("normal"));
      expect(normal.metadata.complete).toBe(true);
      expect(normal.metadata.samples).toHaveLength(9);
      writeFileSync(entry, "export default function() { throw new Error('throwing factory control'); }\n");
      await expect(runStartupProfile(args("throwing"))).rejects.toThrow();
      const output = join(dir, "throwing", readdirSync(join(dir, "throwing"))[0]!, "report.json");
      const failed = JSON.parse(readFileSync(output, "utf8"));
      expect(failed.complete).toBe(false);
      expect(failed.samples).toHaveLength(3);
      expect(failed.samples[2]).toMatchObject({ name: "baseline", exitCode: 0, signal: null });
      expect(failed.failure).toContain("loaded.json");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("retains physical child observations when metrics parsing fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "startup-profile-metrics-"));
    try {
      mkdirSync(join(dir, "bin"));
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "control-only" }));
      const cli = join(dir, "bin/cli.mjs");
      writeFileSync(cli, `import {writeFileSync} from 'node:fs'; process.once('exit',()=>writeFileSync(process.env.PI_LOOP_STARTUP_METRICS,'invalid metrics'));\n`);
      const entry = join(dir, "entry.mjs");
      writeFileSync(entry, "export default function() {}\n");
      const root = join(dir, "out");
      await expect(runStartupProfile(["--cli", cli, "--baseline", entry, "--rounds", "3", "--warmups", "0", "--out", root])).rejects.toThrow();
      const report = JSON.parse(readFileSync(join(root, readdirSync(root)[0]!, "report.json"), "utf8"));
      expect(report.complete).toBe(false);
      expect(report.samples).toEqual([expect.objectContaining({ name: "none", exitCode: 0, signal: null, metrics: null })]);
      expect(report.failure).toBeTruthy();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("retains primary failure when owned-directory cleanup also fails", () => {
    const primary = new Error("primary assertion");
    const cleanup = new Error("cleanup");
    expect(() => preserveStartupCleanup(primary, () => { throw cleanup; })).toThrow(AggregateError);
    try { preserveStartupCleanup(primary, () => { throw cleanup; }); }
    catch (error) { expect((error as AggregateError).errors).toEqual([primary, cleanup]); }
    expect(() => preserveStartupCleanup(primary, () => {})).not.toThrow();
    expect(() => preserveStartupCleanup(undefined, () => { throw cleanup; })).toThrow(cleanup);
  });
  it("validates bounded options without partially parsing numbers", () => {
    expect(startupOptions([])).toMatchObject({ rounds: 15, warmups: 3, profiles: false });
    for (const value of ["0", "-1", "2x", "1.5", "101", "Infinity"]) {
      expect(() => startupOptions(["--rounds", value])).toThrow();
    }
    expect(() => startupOptions(["--warmups", "11"])).toThrow();
    expect(() => startupOptions(["--unknown"])).toThrow();
    expect(startupOptions(["--rounds", "3", "--warmups", "0", "--profiles"])).toMatchObject({ rounds: 3, warmups: 0, profiles: true });
  });

  it("keeps all observations and computes even medians and quantiles", () => {
    expect(summarizeDurations([4, 1, 3, 2])).toMatchObject({ n: 4, medianMs: 2.5, minMs: 1, maxMs: 4 });
    expect(() => summarizeDurations([])).toThrow();
    expect(() => summarizeDurations([Number.NaN])).toThrow();
  });

  it("excludes warmup rounds and pairs observed results, not requested counts", () => {
    const samples = [
      { round: 0, warmup: true, name: "baseline", wallMs: 999, exitCode: 0, signal: null },
      { round: 0, warmup: true, name: "candidate", wallMs: 1, exitCode: 0, signal: null },
      ...Array.from({ length: 5 }, (_, i) => [
        { round: i + 1, warmup: false, name: "baseline", wallMs: 120 + i, exitCode: 0, signal: null },
        { round: i + 1, warmup: false, name: "candidate", wallMs: 100 + i, exitCode: 0, signal: null },
      ]).flat(),
    ];
    const result = pairedStartupSummary(samples);
    expect(result).toMatchObject({ completePairs: 5, medianImprovementMs: 20, bootstrap95Ms: [20, 20] });
    expect(result.pairs.every(pair => pair.improvementMs === 20)).toBe(true);
    expect(samples[0]?.wallMs).toBe(999);
  });

  it("rejects missing, duplicate or failed observations rather than declaring improvement", () => {
    const baseline = { round: 1, warmup: false, name: "baseline", wallMs: 120, exitCode: 0, signal: null };
    const candidate = { ...baseline, name: "candidate", wallMs: 100 };
    expect(() => pairedStartupSummary([baseline])).toThrow(/pair/);
    expect(() => pairedStartupSummary([baseline, baseline, candidate])).toThrow(/duplicate/);
    expect(() => pairedStartupSummary([baseline, { ...candidate, exitCode: 1 }])).toThrow(/failed/);
    expect(() => pairedStartupSummary([baseline, { ...candidate, signal: "SIGTERM" }])).toThrow(/failed/);
    expect(() => pairedStartupSummary([baseline, { ...candidate, error: "spawn failed" }])).toThrow(/failed/);
  });
});
