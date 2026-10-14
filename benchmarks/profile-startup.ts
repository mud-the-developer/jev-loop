import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { pairedStartupSummary, preserveStartupCleanup, type StartupSample, startupOptions, summarizeDurations } from "./startup-report.js";

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
function readJson<T>(path: string, decode: (value: unknown) => T): T {
  try { return decode(JSON.parse(readFileSync(path, "utf8"))); }
  catch (cause) { throw new Error(`Cannot read profiling JSON: ${path}`, { cause }); }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected JSON object");
  return value as Record<string, unknown>;
}
function readVersion(path: string): string {
  return readJson(path, value => {
    const version = object(value).version;
    if (typeof version !== "string" || !version) throw new Error("Missing package version");
    return version;
  });
}
interface StartupMetrics { node: string; exec: string; cpuUserMicros: number; cpuSystemMicros: number; maxRssKiB: number; rssBytes: number }
function readMetrics(path: string): StartupMetrics {
  return readJson(path, value => {
    const data = object(value);
    const resources = object(data.resources);
    const memory = object(data.memory);
    if (typeof data.node !== "string" || typeof data.exec !== "string") throw new Error("Missing observed child identity");
    const number = (value: unknown) => {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error("Invalid resource measurement");
      return value;
    };
    return { node: data.node, exec: data.exec, cpuUserMicros: number(resources.userCPUTime), cpuSystemMicros: number(resources.systemCPUTime), maxRssKiB: number(resources.maxRSS), rssBytes: number(memory.rss) };
  });
}

export async function staticModuleInventory(entry: string) {
  const workingDirectory = dirname(resolve(entry));
  const result = await build({ absWorkingDir: workingDirectory, entryPoints: [resolve(entry)], bundle: true, platform: "node", format: "esm", packages: "external", write: false, metafile: true, logLevel: "silent" });
  const inputs = result.metafile!.inputs;
  const visited = new Set<string>();
  const files: Array<{ path: string; bytes: number; sha256: string }> = [];
  const external = new Set<string>();
  const dynamic: string[] = [];
  const visit = (key: string) => {
    if (visited.has(key)) return;
    visited.add(key);
    const input = inputs[key];
    if (!input) throw new Error(`Missing module inventory input: ${key}`);
    const path = resolve(workingDirectory, key);
    const data = readFileSync(path);
    files.push({ path, bytes: data.length, sha256: sha256(data) });
    for (const dependency of input.imports) {
      if (dependency.external) external.add(dependency.path);
      else if (dependency.kind === "import-statement") visit(dependency.path);
      else dynamic.push(`${key}: ${dependency.kind} ${dependency.path}`);
    }
  };
  const entryKey = Object.keys(inputs).find(key => resolve(workingDirectory, key) === resolve(entry));
  if (!entryKey) throw new Error("Entry absent from module inventory");
  visit(entryKey);
  return { kind: "static relative ESM graph, not observed runtime loading", modules: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0), files, external: [...external].sort(), dynamic };
}

export async function runStartupProfile(args: string[]) {
  const options = startupOptions(args);
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cli = resolve(options.cli ?? join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"));
  const baseline = resolve(options.baseline ?? join(root, "dist/index.js"));
  const candidate = options.candidate ? resolve(options.candidate) : undefined;
  for (const path of [cli, baseline, ...(candidate ? [candidate] : [])]) if (!existsSync(path)) throw new Error(`Missing startup input: ${path}`);
  const graph = { baseline: await staticModuleInventory(baseline), ...(candidate ? { candidate: await staticModuleInventory(candidate) } : {}) };
  const sdkVersion = readVersion(join(dirname(cli), "../package.json"));
  const packageVersion = readVersion(join(root, "package.json"));
  const outputRoot = resolve(options.out);
  mkdirSync(outputRoot, { recursive: true });
  const output = mkdtempSync(join(outputRoot, "run-"));
  const workspace = mkdtempSync(join(tmpdir(), "pi-loop-startup-"));
  const noop = join(workspace, "noop.mjs");
  const probe = join(workspace, "metrics.mjs");
  const profiler = join(workspace, "profiler.mjs");
  const targets: Record<string, string> = { noop, baseline, ...(candidate ? { candidate } : {}) };
  const wrappers = Object.fromEntries(Object.keys(targets).map(name => [name, join(workspace, `${name}-wrapper.mjs`)]));
  const common = [cli, "--no-extensions", "--no-mcp", "--list-models"];
  const cases: Record<string, string[]> = { none: common, ...Object.fromEntries(Object.keys(targets).map(name => [name, [...common, "-e", wrappers[name]!]])) };
  const env: NodeJS.ProcessEnv = { ...process.env, PI_CODING_AGENT_DIR: join(workspace, "config"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", PI_LOOP: "off", PI_LOOP_SCOPE: "memory" };
  for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL", "NODE_OPTIONS", "PI_LOOP_STARTUP_RECEIPT", "PI_LOOP_STARTUP_PROFILE"])  delete env[key as keyof typeof env];
  const metadata = {
    schemaVersion: 1, node: process.version, platform: process.platform, arch: process.arch,
    sdk: sdkVersion,
    packageVersion,
    sourceRevision: spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout?.trim() || null,
    mode: "CLI list-models; fresh processes with warm OS caches; not TUI first render or first-request latency",
    options, graph, loaderEvidence: "Owned wrapper records only successful factory return/resolution; absent/invalid receipt rejects the run. Shared wrapper I/O adds instrumentation, not uninstrumented CLI/TUI performance.", maximumProfileBytes: 64 * 1024 * 1024,
    requestedTimingChildren: (options.rounds + options.warmups) * Object.keys(cases).length,
    samples: [] as Array<StartupSample & { stdoutHash: string; stderrHash: string; metrics: StartupMetrics | null }>,
    profileSamples: [] as Array<StartupSample & { stdoutHash: string; stderrHash: string; metrics: StartupMetrics | null }>,
    profiles: [] as Array<{ name: string; path: string; sha256: string; bytes: number }>, complete: false,
    summaries: {} as Record<string, ReturnType<typeof summarizeDurations>>, paired: null as ReturnType<typeof pairedStartupSummary> | null,
    failure: null as string | null,
  };
  const save = () => writeFileSync(join(output, "report.json"), `${JSON.stringify(metadata, null, 2)}\n`);
  const execute = (name: string, round: number, profile = false) => {
    const label = `${profile ? "profile" : "timing"}-${round}-${name}`;
    const metricsPath = join(output, `${label}.metrics.json`);
    const profileDir = join(output, "cpu");
    const profilePath = join(profileDir, `${label}.cpuprofile`);
    const receiptPath = join(output, `${label}.loaded.json`);
    if (profile) mkdirSync(profileDir, { recursive: true });
    const childArgs = ["--import", pathToFileURL(probe).href, ...(profile ? ["--import", pathToFileURL(profiler).href] : []), ...cases[name]!];
    const start = performance.now();
    const child = spawnSync(process.execPath, childArgs, { cwd: workspace, env: { ...env, PI_LOOP_STARTUP_METRICS: metricsPath, PI_LOOP_STARTUP_RECEIPT: receiptPath, PI_LOOP_STARTUP_PROFILE: profilePath }, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
    const wallMs = performance.now() - start;
    const stdout = child.stdout ?? "";
    const stderr = child.stderr ?? "";
    const extensionError = /failed to load|error loading extension/i.test(stderr);
    const sample = { round, warmup: round < options.warmups, name, wallMs, exitCode: child.status, signal: child.signal, ...(child.error ? { error: child.error.message } : extensionError ? { error: "Extension loader reported failure" } : {}), stdoutHash: sha256(stdout), stderrHash: sha256(stderr), metrics: null as StartupMetrics | null };
    (profile ? metadata.profileSamples : metadata.samples).push(sample);
    // Persist physical observations before secondary output/metrics parsing can fail.
    save();
    writeFileSync(join(output, `${label}.stdout.log`), stdout);
    writeFileSync(join(output, `${label}.stderr.log`), stderr);
    sample.metrics = existsSync(metricsPath) ? readMetrics(metricsPath) : null;
    save();
    if (name !== "none") readJson(receiptPath, value => {
      const row = object(value);
      if (row.target !== pathToFileURL(targets[name]!).href || row.phase !== "factory-returned" || row.node !== process.version) throw new Error(`${label}: extension load receipt invalid`);
      return row;
    });
    if (child.status !== 0 || child.signal || child.error || extensionError || !sample.metrics) throw new Error(`${label} incomplete: ${JSON.stringify(sample)}`);
    if (profile) {
      const path = profilePath;
      const data = readFileSync(path);
      readJson(path, value => {
        const nodes = object(value).nodes;
        if (!Array.isArray(nodes) || !nodes.length) throw new Error(`Empty CPU profile: ${label}`);
        return { nodeCount: nodes.length };
      });
      metadata.profiles.push({ name, path, sha256: sha256(data), bytes: statSync(path).size });
      save();
    }
  };
  let operationError: unknown;
  try {
    writeFileSync(noop, "export default function () {}\n");
    writeFileSync(probe, `import {writeFileSync} from 'node:fs'; process.once('exit',()=>writeFileSync(process.env.PI_LOOP_STARTUP_METRICS,JSON.stringify({node:process.version,exec:process.execPath,resources:process.resourceUsage(),memory:process.memoryUsage()})));\n`);
    writeFileSync(profiler, `import {Session} from 'node:inspector'; import {writeFileSync} from 'node:fs'; const s=new Session(); s.connect(); const post=m=>new Promise((r,j)=>s.post(m,(e,v)=>e?j(e):r(v))); await post('Profiler.enable'); await post('Profiler.start'); process.once('exit',()=>s.post('Profiler.stop',(e,v)=>{if(e)throw e; const raw=JSON.stringify(v.profile); if(Buffer.byteLength(raw)>${metadata.maximumProfileBytes}) throw new Error('Startup CPU profile exceeds byte limit'); writeFileSync(process.env.PI_LOOP_STARTUP_PROFILE,raw,{flag:'wx'}); s.disconnect();}));\n`);
    for (const [name, target] of Object.entries(targets)) {
      const href = pathToFileURL(target).href;
      writeFileSync(wrappers[name]!, `import factory from ${JSON.stringify(href)}; import {writeFileSync} from 'node:fs'; export default function(pi){if(typeof factory!=='function')throw new Error('No extension factory'); const value=factory(pi); const receipt=()=>writeFileSync(process.env.PI_LOOP_STARTUP_RECEIPT,JSON.stringify({target:${JSON.stringify(href)},phase:'factory-returned',node:process.version}),{flag:'wx'}); if(value&&typeof value.then==='function')return Promise.resolve(value).then(result=>{receipt();return result;}); receipt();return value;}\n`);
    }
    save();
    for (let round = 0; round < options.rounds + options.warmups; round++) {
      const names = Object.keys(cases);
      if (round % 2) names.reverse();
      for (const name of names) execute(name, round);
      console.info(JSON.stringify({ progress: { current: round + 1, total: options.rounds + options.warmups, message: "startup timing round" } }));
    }
    for (const name of Object.keys(cases)) metadata.summaries[name] = summarizeDurations(metadata.samples.filter(s => !s.warmup && s.name === name).map(s => s.wallMs));
    if (candidate) metadata.paired = pairedStartupSummary(metadata.samples);
    // CPU instrumentation changes timings; these observations never enter the paired statistics.
    if (options.profiles) for (const name of Object.keys(cases)) execute(name, -1, true);
    metadata.complete = true;
    save();
    console.info(JSON.stringify({ output, complete: true, summaries: metadata.summaries, paired: metadata.paired }));
  } catch (error) {
    metadata.failure = error instanceof Error ? error.stack ?? error.message : String(error);
    operationError = error;
    try { save(); }
    catch (reportError) { operationError = new AggregateError([error, reportError], "Startup failure and report write failure"); }
    throw operationError;
  } finally {
    preserveStartupCleanup(operationError, () => rmSync(workspace, { recursive: true, force: true }));
  }
  return { output, metadata };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await runStartupProfile(process.argv.slice(2));
