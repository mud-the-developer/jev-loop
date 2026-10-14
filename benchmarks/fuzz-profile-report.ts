import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
export function profileText(value: unknown, maximumBytes = MAX_ARTIFACT_BYTES): string {
  const raw = JSON.stringify(value);
  if (typeof raw !== "string" || Buffer.byteLength(raw) > maximumBytes) throw new Error(`CPU profile exceeds ${maximumBytes} bytes or is absent`);
  return raw;
}
export const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const count = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
const flag = (value: unknown): boolean | null => typeof value === "boolean" ? value : null;
const canonicalPath = (path: string) => {
  try { return realpathSync(path); } catch { return resolve(path); }
};

export function readArtifact(path: string) {
  const size = statSync(path).size;
  if (size > MAX_ARTIFACT_BYTES) throw new Error(`Artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${path}`);
  const raw = readFileSync(path);
  try { return { path, sizeBytes: raw.length, sha256: sha256(raw), value: JSON.parse(raw.toString("utf8")) as unknown, parseError: null }; }
  catch (error) { return { path, sizeBytes: raw.length, sha256: sha256(raw), value: null, parseError: String(error) }; }
}

export function summarizeCampaign(value: unknown, suite: string) {
  const rows = Array.isArray(value) ? value : [value];
  if (!rows.length || rows.some(row => row === null || typeof row !== "object" || Array.isArray(row))) throw new Error("Invalid campaign report");
  return rows.map(value => {
    const row = object(value);
    const counters = object(row.counters);
    return {
      name: typeof row.name === "string" ? row.name : suite,
      actualRuns: count(row.numRuns),
      completed: count(row.completed ?? row.completedObservations),
      checks: count(row.executions ?? counters.executions),
      shrinks: count(row.numShrinks),
      actions: count(row.commands ?? counters.commands),
      actionCounts: row.coverage ?? row.counts ?? counters.operations ?? null,
      failed: flag(row.failed),
      interrupted: flag(row.interrupted),
      counterexamplePath: typeof row.counterexamplePath === "string" ? row.counterexamplePath : null,
    };
  });
}
export type CampaignSummary = ReturnType<typeof summarizeCampaign>;

export function summarizeVitest(value: unknown, selectedTests?: readonly string[]) {
  const row = object(value);
  if (typeof row.success !== "boolean" || !Array.isArray(row.testResults)) throw new Error("Invalid Vitest JSON report");
  const assertions = row.testResults.flatMap(result => {
    const rows = object(result).assertionResults;
    return Array.isArray(rows) ? rows.map(object) : [];
  });
  // Vitest retains pattern-excluded tests as pending. Do not confuse deliberate
  // selection with a selected property that was skipped or never executed.
  const filtered = assertions.filter(row => selectedTests && typeof row.fullName === "string" && !selectedTests.includes(row.fullName) && (row.status === "pending" || row.status === "skipped"));
  const selected = assertions.filter(row => !filtered.includes(row));
  return {
    success: row.success,
    passed: selected.filter(row => row.status === "passed").length,
    failed: selected.filter(row => row.status === "failed").length,
    skipped: selected.filter(row => row.status !== "passed" && row.status !== "failed").length,
    properties: selected.map(row => ({ name: row.fullName, status: row.status })),
    filtered: filtered.map(row => ({ name: row.fullName, status: row.status })),
  };
}
export type TestSummary = ReturnType<typeof summarizeVitest>;

export function collectProfiles(dir: string, expectedSource: string) {
  const profiles: Array<{ path: string; sha256: string; sizeBytes: number; metadataSHA256: string; metadata: Record<string, unknown> }> = [];
  const errors: string[] = [];
  let entries: string[];
  try { entries = readdirSync(dir); }
  catch (error) { return { profiles, errors: [`Worker profile directory: ${String(error)}`] }; }
  const names = entries.filter(name => name.endsWith(".cpuprofile"));
  if (names.length > 64) return { profiles, errors: ["Worker profile count exceeds 64"] };
  for (const name of names) {
    try {
      const profile = readArtifact(join(dir, name));
      const meta = readArtifact(join(dir, name.replace(/\.cpuprofile$/, ".meta.json")));
      const metadata = object(meta.value);
      if (metadata.sha256 !== profile.sha256 || metadata.sizeBytes !== profile.sizeBytes) throw new Error(`Worker profile checksum/size mismatch: ${name}`);
      if (metadata.role !== "property-worker" || metadata.complete !== true || typeof metadata.sourceFile !== "string" || canonicalPath(metadata.sourceFile) !== canonicalPath(expectedSource) || (count(metadata.pid) ?? 0) < 1 || typeof metadata.node !== "string" || typeof metadata.wallTimeMs !== "number" || !Number.isFinite(metadata.wallTimeMs) || metadata.wallTimeMs < 0 || !metadata.resources) throw new Error(`Incomplete or wrong worker profile metadata: ${name}`);
      const resources = object(metadata.resources);
      if (count(resources.userCPUTimeMicros) === null || count(resources.systemCPUTimeMicros) === null || count(resources.maxRSSKiB) === null) throw new Error(`Incomplete worker resource metadata: ${name}`);
      const data = object(profile.value);
      if (!Array.isArray(data.nodes) || !data.nodes.length || !Array.isArray(data.samples) || !data.samples.length) throw new Error(`Worker CPU profile has no samples: ${name}`);
      profiles.push({ path: profile.path, sha256: profile.sha256, sizeBytes: profile.sizeBytes, metadataSHA256: meta.sha256, metadata });
    } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  for (const name of entries.filter(name => name.startsWith("worker-") && name.endsWith(".meta.json"))) {
    if (!entries.includes(name.replace(/\.meta\.json$/, ".cpuprofile"))) errors.push(`Incomplete worker profile: ${name}`);
  }
  return { profiles, errors };
}

export interface ChildStatus {
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  timedOut: boolean;
}

export function decideOutcome(evidence: { child: ChildStatus; campaign: CampaignSummary; tests: TestSummary | null; profileCount: number; errors: string[] }) {
  const { child, campaign, tests, profileCount, errors } = evidence;
  if (campaign.some(row => row.failed === true)) return "FAIL";
  if (child.timedOut || child.signal || campaign.some(row => row.interrupted === true)) return "INTERRUPTED";
  if (tests?.failed || (child.exitCode !== null && child.exitCode !== 0)) return "FAIL";
  if (errors.length || child.error || tests?.success === false) return "FAIL";
  if (child.exitCode === null || !tests || tests.passed === 0 || tests.skipped > 0 || !campaign.length || campaign.some(row => (row.actualRuns ?? row.completed ?? 0) < 1) || profileCount === 0) return "INCOMPLETE";
  return "PASS";
}
