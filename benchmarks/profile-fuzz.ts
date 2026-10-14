import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type CampaignSummary, type ChildStatus, collectProfiles, decideOutcome, readArtifact, sha256, summarizeCampaign, summarizeVitest, type TestSummary } from "./fuzz-profile-report.js";

export const SUITES = {
  "monitor-runtime": {
    reportEnv: "MONITOR_FUZZ_REPORT", maximumRuns: 1000,
    properties: [
      "generic monitor runtime model preserves authoritative outcomes through fault-injected cancellation, output, timers and shutdown",
      "generic monitor runtime model isolates generated callback consumers from authoritative outcomes and later receipts",
    ],
  },
  "monitor-inactivity": {
    reportEnv: "MONITOR_INACTIVITY_REPORT", maximumRuns: 1000,
    properties: ["models generated inactivity renewal and timeout followed by zero close without success inference"],
  },
  "monitor-native": {
    reportEnv: "NATIVE_MONITOR_REPORT", maximumRuns: 64,
    properties: ["models bounded generated POSIX producer patterns without trusting their exit markers"],
  },
  "workflow-restart": {
    reportEnv: "PI_LOOP_RESTART_FUZZ_REPORT", maximumRuns: 1000,
    properties: ["file-backed workflow restart sequence properties preserves ownership/CAS on reload and permits eligible recovery without resetting work"],
  },
} as const;
export type Suite = keyof typeof SUITES;
const NATIVE_CONTROLS = [
  "preserves the primary native trace and attempts remaining cleanup after a cleanup failure",
  "keeps native pre-gate TERM exit-zero output distinct from manual cancellation",
  "records normal native gate-body completion separately from cancellation",
];
export const GLOBAL_MAXIMUM_RUNS = 1000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;

function positiveInteger(name: string, value: string): number {
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error(`${name} must be a positive safe integer`);
  return Number(value);
}

export function parseProfileArgs(args: string[]) {
  const { values } = parseArgs({ args, strict: true, allowPositionals: false, options: {
    suite: { type: "string", default: "monitor-runtime" }, runs: { type: "string", default: "100" },
    seed: { type: "string" }, path: { type: "string" }, test: { type: "string" },
    out: { type: "string", default: ".artifacts/profiles/fuzz" }, "timeout-ms": { type: "string", default: "600000" },
  } });
  if (!values.suite || !Object.hasOwn(SUITES, values.suite)) throw new Error(`Unknown suite: ${values.suite}`);
  const suite = values.suite as Suite;
  const requestedRuns = positiveInteger("--runs", values.runs ?? "100");
  const seed = positiveInteger("--seed", values.seed ?? "130363");
  const timeoutMs = positiveInteger("--timeout-ms", values["timeout-ms"] ?? "600000");
  if (timeoutMs > 600000) throw new Error("--timeout-ms must not exceed 600000");
  if (!values.out) throw new Error("--out must not be empty");
  const pattern = values.test === undefined ? undefined : new RegExp(values.test);
  if (values.test === "") throw new Error("--test must not be empty");
  const selectedProperties = SUITES[suite].properties.filter(name => !pattern || pattern.test(name));
  if (!selectedProperties.length) throw new Error("--test must select a known property in the selected suite");
  const selectedTests = [...SUITES[suite].properties, ...(suite === "monitor-native" ? NATIVE_CONTROLS : [])].filter(name => !pattern || pattern.test(name));
  if (values.path !== undefined) {
    if (values.seed === undefined) throw new Error("--path requires an explicit --seed");
    if (values.test === undefined) throw new Error("--path requires --test");
    if (!/^[0-9]+(?::[0-9]+)*$/.test(values.path)) throw new Error("--path must be a nonempty fast-check replay path");
    if (selectedProperties.length !== 1 || selectedTests.length !== 1) throw new Error("--path must select exactly one property and no control tests");
  }
  const maximumRuns = SUITES[suite].maximumRuns;
  const runs = Math.min(requestedRuns, GLOBAL_MAXIMUM_RUNS, maximumRuns);
  return { suite, requestedRuns, runs, maximumRuns, globalMaximumRuns: GLOBAL_MAXIMUM_RUNS, clipped: requestedRuns > runs, seed, seedExplicit: values.seed !== undefined, path: values.path, replay: values.path !== undefined, test: values.test, selectedProperties, selectedTests, out: values.out, timeoutMs };
}
export type ProfileOptions = ReturnType<typeof parseProfileArgs>;

export function buildChildPlan(options: ProfileOptions, cwd: string, dir: string, inherited: NodeJS.ProcessEnv = process.env) {
  const env = { ...inherited };
  for (const key of Object.keys(env)) {
    if (key.startsWith("FC_") || key.startsWith("PI_LOOP_FUZZ_") || Object.values(SUITES).some(suite => suite.reportEnv === key) || key === "NODE_OPTIONS") delete env[key];
  }
  Object.assign(env, { FC_NUM_RUNS: String(options.runs), FC_SEED: String(options.seed), PI_LOOP: "off", PI_LOOP_SCOPE: "memory", TZ: "UTC", PI_LOOP_FUZZ_PROFILE_DIR: dir, [SUITES[options.suite].reportEnv]: join(dir, "campaign.json") });
  if (options.path !== undefined) env.FC_PATH = options.path;
  const file = `test/property/${options.suite}.property.test.ts`;
  return {
    binary: process.execPath,
    args: [join(cwd, "node_modules/vitest/vitest.mjs"), "run", file, "--maxWorkers=1", "--no-file-parallelism", "--reporter=default", "--reporter=json", `--outputFile.json=${join(dir, "vitest.json")}`, ...(options.test === undefined ? [] : ["--testNamePattern", options.test])],
    file, env, cwd,
  };
}
export type ChildPlan = ReturnType<typeof buildChildPlan>;

export interface ChildResult extends ChildStatus {
  wallTimeMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  stdoutSHA256: string;
  stderrSHA256: string;
  resourceCoverage: string;
}

// Retain bounded prefixes while hashing the entire observed streams.
export function outputCollector(limit = MAX_OUTPUT_BYTES) {
  const hash = createHash("sha256");
  let bytes = 0;
  let retained = 0;
  const chunks: Buffer[] = [];
  return {
    add(chunk: Buffer) {
      hash.update(chunk);
      bytes += chunk.length;
      const part = chunk.subarray(0, Math.max(0, limit - retained));
      if (part.length) chunks.push(part);
      retained += part.length;
    },
    finish() {
      let text = Buffer.concat(chunks).toString("utf8");
      // A clipped multibyte sequence must not make the saved UTF-8 prefix exceed the cap.
      while (Buffer.byteLength(text) > limit) text = text.slice(0, -1);
      return { text, bytes, truncated: bytes > limit, sha256: hash.digest("hex") };
    },
  };
}

export function runChild(plan: ChildPlan, timeoutMs: number, spawnChild: typeof spawn = spawn): Promise<ChildResult> {
  return new Promise(resolveResult => {
    const started = process.hrtime.bigint();
    const stdout = outputCollector();
    const stderr = outputCollector();
    let child: ReturnType<typeof spawn>;
    let error: string | null = null;
    let timedOut = false;
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (exitCode: number | null, signal: string | null) => {
      if (done) return;
      done = true;
      clearTimeout(timeout); clearTimeout(escalation); clearTimeout(deadline);
      const out = stdout.finish();
      const err = stderr.finish();
      resolveResult({ exitCode, signal, error, timedOut, wallTimeMs: Number(process.hrtime.bigint() - started) / 1e6,
        stdout: out.text, stderr: err.text, stdoutBytes: out.bytes, stderrBytes: err.bytes,
        stdoutTruncated: out.truncated, stderrTruncated: err.truncated, stdoutSHA256: out.sha256, stderrSHA256: err.sha256,
        resourceCoverage: "Worker metadata only; coordinator CPU/RSS unknown. Native descendant CPU/RSS and detached-process termination unobserved.",
      });
    };
    try {
      child = spawnChild(plan.binary, plan.args, { cwd: plan.cwd, env: plan.env, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (cause) { error = String(cause); finish(null, null); return; }
    child.stdout?.on("data", (chunk: Buffer) => { if (!done) stdout.add(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { if (!done) stderr.add(chunk); });
    child.on("error", cause => { error = cause.message; });
    child.on("close", (code, signal) => finish(code, signal));
    const terminate = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch (cause) { error ??= `Termination: ${String(cause)}`; }
    };
    timeout = setTimeout(() => {
      timedOut = true;
      terminate("SIGTERM");
      escalation = setTimeout(() => terminate("SIGKILL"), 1000);
      deadline = setTimeout(() => {
        error ??= "Child close unobserved after bounded termination";
        child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
        finish(null, null);
      }, 2000);
    }, timeoutMs);
  });
}

// Hash the actual logic, not just the property fixture or a possibly dirty revision label.
function sourceManifest(cwd: string) {
  const files: Array<{ file: string; sha256: string }> = [];
  let bytes = 0;
  const visit = (dir: string) => {
    for (const entry of readdirSync(join(cwd, dir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const raw = readFileSync(join(cwd, file));
        bytes += raw.length;
        if (files.length >= 1000 || bytes > 16 * 1024 * 1024) throw new Error("Source manifest exceeds bounds");
        files.push({ file, sha256: sha256(raw) });
      }
    }
  };
  try { visit("src"); return { complete: true, sha256: sha256(JSON.stringify(files)), files }; }
  catch (error) { return { complete: false, sha256: null, files, error: String(error) }; }
}

interface Dependencies {
  runChild?: (plan: ChildPlan, timeoutMs: number) => Promise<ChildResult>;
  writeSummary?: (path: string, content: string) => void;
}

export async function runProfile(options: ProfileOptions, cwd = process.cwd(), dependencies: Dependencies = {}) {
  const root = resolve(cwd, options.out);
  mkdirSync(root, { recursive: true });
  const artifactDir = mkdtempSync(join(root, `${options.suite}-`));
  const plan = buildChildPlan(options, cwd, artifactDir);
  const errors: string[] = [];
  const startedAt = new Date().toISOString();
  const child = await (dependencies.runChild ?? runChild)(plan, options.timeoutMs);
  // Save the primary evidence before attempting any secondary parsing/reporting.
  for (const stream of ["stdout", "stderr"] as const) {
    try { writeFileSync(join(artifactDir, `${stream}.log`), child[stream], { flag: "wx" }); }
    catch (error) { errors.push(`Saving ${stream}: ${String(error)}`); }
  }
  let campaign: CampaignSummary = [];
  let tests: TestSummary | null = null;
  let campaignArtifact: Omit<ReturnType<typeof readArtifact>, "value"> | null = null;
  let testArtifact: Omit<ReturnType<typeof readArtifact>, "value"> | null = null;
  try {
    const { value, ...artifact } = readArtifact(join(artifactDir, "campaign.json"));
    campaignArtifact = artifact;
    if (artifact.parseError) throw new Error(artifact.parseError);
    campaign = summarizeCampaign(value, options.suite);
    if (campaign.length !== options.selectedProperties.length) errors.push("Campaign report does not cover exactly the selected properties");
    if (campaign.some(row => row.actualRuns === null && row.completed === null)) errors.push("Campaign has no observed completion/run evidence");
  } catch (error) { errors.push(`Campaign report: ${String(error)}`); }
  try {
    const { value, ...artifact } = readArtifact(join(artifactDir, "vitest.json"));
    testArtifact = artifact;
    if (artifact.parseError) throw new Error(artifact.parseError);
    tests = summarizeVitest(value, options.selectedTests);
    for (const property of options.selectedProperties) {
      if (!tests.properties.some(row => row.name === property)) errors.push(`Vitest did not observe selected property: ${property}`);
    }
    if (options.replay && (tests.properties.length !== 1 || tests.properties[0]?.name !== options.selectedProperties[0])) errors.push("Replay selection was not unambiguous in the actual worker");
    if (tests.properties.length !== options.selectedTests.length) errors.push("Vitest selection differs from the allowlisted test inventory");
  } catch (error) { errors.push(`Vitest report: ${String(error)}`); }
  const { profiles, errors: profileErrors } = collectProfiles(artifactDir, join(cwd, plan.file));
  errors.push(...profileErrors);
  const sourceHashes: Record<string, string | null> = {};
  for (const file of [plan.file, "test/property/config.ts", "vitest.config.ts", "benchmarks/fuzz-profile-setup.ts", "package.json", "package-lock.json"]) {
    try { sourceHashes[file] = sha256(readFileSync(join(cwd, file))); }
    catch { sourceHashes[file] = null; errors.push(`Required source identity unavailable: ${file}`); }
  }
  const manifest = sourceManifest(cwd);
  if (!manifest.complete) errors.push(`Source manifest incomplete: ${manifest.error}`);
  const result = {
    schemaVersion: 1, kind: "fuzz-worker-cpu-profile", artifactDir, startedAt,
    runtime: { node: process.version, execPath: process.execPath, platform: process.platform, arch: process.arch },
    sourceHashes, sourceManifest: manifest, options, command: { binary: plan.binary, args: plan.args, cwd: plan.cwd, shell: false },
    controlledEnvironmentKeys: ["FC_NUM_RUNS", "FC_SEED", ...(options.replay ? ["FC_PATH"] : []), "PI_LOOP", "PI_LOOP_SCOPE", "TZ", "PI_LOOP_FUZZ_PROFILE_DIR", SUITES[options.suite].reportEnv],
    child: { exitCode: child.exitCode, signal: child.signal, error: child.error, timedOut: child.timedOut, wallTimeMs: child.wallTimeMs, resourceCoverage: child.resourceCoverage },
    output: {
      maximumRetainedBytesPerStream: MAX_OUTPUT_BYTES,
      stdout: { path: join(artifactDir, "stdout.log"), observedBytes: child.stdoutBytes, truncated: child.stdoutTruncated, observedSHA256: child.stdoutSHA256, retainedSHA256: sha256(child.stdout) },
      stderr: { path: join(artifactDir, "stderr.log"), observedBytes: child.stderrBytes, truncated: child.stderrTruncated, observedSHA256: child.stderrSHA256, retainedSHA256: sha256(child.stderr) },
    },
    campaignArtifact, testArtifact, campaign, tests, profiles, profileCount: profiles.length,
    profileStatus: child.timedOut || child.signal || child.exitCode === null ? "unknown/incomplete" : profiles.length ? "worker-profile-present" : "missing", errors,
    coverage: "Property worker suite hooks only; not coordinator, startup or native descendant attribution. Unknown counters are null. Abnormal exit may leave incomplete profiles/reports. No retries.",
    outcome: decideOutcome({ child, campaign, tests, profileCount: profiles.length, errors }),
  };
  try { (dependencies.writeSummary ?? ((path, content) => writeFileSync(path, content, { flag: "wx" })))(join(artifactDir, "summary.json"), `${JSON.stringify(result, null, 2)}\n`); }
  catch (error) { errors.push(`Summary reporting: ${String(error)}`); result.outcome = "FAIL"; }
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const result = await runProfile(parseProfileArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.outcome === "PASS" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Fuzz profiling failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = 1;
  }
}
