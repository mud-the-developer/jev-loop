import { afterAll, beforeAll, expect } from "vitest";
import { profileText } from "./fuzz-profile-report.js";

// The config does not load this module unless profiling was explicitly requested.
const directory = process.env.PI_LOOP_FUZZ_PROFILE_DIR;
const clock = process.hrtime.bigint.bind(process.hrtime);
const usage = process.resourceUsage.bind(process);
let session: import("node:inspector").Session | undefined;
let started: bigint | undefined;
let initialUsage: NodeJS.ResourceUsage | undefined;
let sourceFile: string | undefined;
let setupError: unknown;

function post(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (!session) { reject(new Error("Worker inspector session is absent")); return; }
    session.post(method, params, (error, result) => error ? reject(error) : resolve(result as Record<string, unknown>));
  });
}

if (directory) {
  beforeAll(async () => {
    try {
      const { Session } = await import("node:inspector");
      sourceFile = expect.getState().testPath;
      if (!sourceFile) throw new Error("Worker profile requires a test source file");
      session = new Session();
      session.connect();
      await post("Profiler.enable");
      await post("Profiler.setSamplingInterval", { interval: 1000 });
      initialUsage = usage();
      started = clock();
      await post("Profiler.start");
    } catch (error) { setupError = error; throw error; }
  });

  afterAll(async () => {
    let metadataPath: string | undefined;
    try {
      const [{ writeFileSync }, { join }, { createHash, randomUUID }] = await Promise.all([import("node:fs"), import("node:path"), import("node:crypto")]);
      const base = join(directory, `worker-${process.pid}-${randomUUID()}`);
      metadataPath = `${base}.meta.json`;
      if (setupError || !started || !initialUsage) throw setupError ?? new Error("Worker profiler did not start");
      const { profile } = await post("Profiler.stop");
      const finished = clock();
      const resources = usage();
      const raw = profileText(profile);
      writeFileSync(`${base}.cpuprofile`, raw, { flag: "wx" });
      writeFileSync(metadataPath, JSON.stringify({
        schemaVersion: 1, role: "property-worker", complete: true,
        sourceFile, pid: process.pid, node: process.version,
        wallTimeMs: Number(finished - started) / 1e6,
        resources: { userCPUTimeMicros: resources.userCPUTime - initialUsage.userCPUTime, systemCPUTimeMicros: resources.systemCPUTime - initialUsage.systemCPUTime, maxRSSKiB: resources.maxRSS },
        resourceCoverage: "CPU delta during suite hooks; RSS is process lifetime high-water mark. Coordinator and native descendants excluded.",
        sha256: createHash("sha256").update(raw).digest("hex"), sizeBytes: Buffer.byteLength(raw),
      }, null, 2), { flag: "wx" });
    } catch (error) {
      // Hook errors remain secondary to assertions in Vitest's raw log/report.
      console.error("Worker CPU profiling/reporting failed:", error);
      if (metadataPath) {
        try {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(metadataPath, JSON.stringify({ role: "property-worker", complete: false, sourceFile, pid: process.pid, error: String(error) }), { flag: "wx" });
        } catch { /* The parent also treats absent metadata/profile as incomplete. */ }
      }
      throw error;
    } finally { session?.disconnect(); }
  });
}
