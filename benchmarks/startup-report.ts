import { parseArgs } from "node:util";

export function preserveStartupCleanup(primary: unknown, cleanup: () => void): void {
  try { cleanup(); }
  catch (error) {
    if (primary !== undefined) throw new AggregateError([primary, error], "Startup failure and cleanup failure");
    throw error;
  }
}

export interface StartupSample {
  round: number;
  warmup: boolean;
  name: string;
  wallMs: number;
  exitCode: number | null;
  signal: string | null;
  error?: string;
}

function integer(value: string, name: string, minimum: number, maximum: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return result;
}

export function startupOptions(args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: {
    rounds: { type: "string", default: "15" }, warmups: { type: "string", default: "3" },
    baseline: { type: "string" }, candidate: { type: "string" }, cli: { type: "string" },
    out: { type: "string", default: ".artifacts/profiles/startup" }, profiles: { type: "boolean", default: false },
  } });
  return { ...values, rounds: integer(values.rounds, "rounds", 3, 100), warmups: integer(values.warmups, "warmups", 0, 10) };
}

function percentile(sorted: number[], fraction: number): number {
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  return sorted[lower]! + (sorted[Math.ceil(index)]! - sorted[lower]!) * (index - lower);
}

export function summarizeDurations(values: number[]) {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) {
    throw new Error("Durations must contain finite nonnegative observations");
  }
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, medianMs: percentile(sorted, 0.5), minMs: sorted[0]!, maxMs: sorted.at(-1)!, p25Ms: percentile(sorted, 0.25), p75Ms: percentile(sorted, 0.75) };
}

export function pairedStartupSummary(samples: StartupSample[]) {
  const groups = new Map<number, Map<string, StartupSample>>();
  for (const sample of samples) {
    if (sample.warmup || !["baseline", "candidate"].includes(sample.name)) continue;
    if (sample.exitCode !== 0 || sample.signal || sample.error) throw new Error("Startup child failed; timing comparison incomplete");
    summarizeDurations([sample.wallMs]);
    let group = groups.get(sample.round);
    if (!group) { group = new Map(); groups.set(sample.round, group); }
    if (group.has(sample.name)) throw new Error("Startup round has duplicate observations");
    group.set(sample.name, sample);
  }
  if (!groups.size) throw new Error("No complete startup pairs");
  const pairs = [...groups].map(([round, group]) => {
    const baseline = group.get("baseline");
    const candidate = group.get("candidate");
    if (!baseline || !candidate) throw new Error("Missing startup pair");
    return { round, baselineMs: baseline.wallMs, candidateMs: candidate.wallMs, improvementMs: baseline.wallMs - candidate.wallMs };
  });
  const differences = pairs.map(pair => pair.improvementMs).sort((a, b) => a - b);
  // Fixed bootstrap seed makes report regeneration reproducible, not timings deterministic.
  let state = 104729;
  const medians: number[] = [];
  for (let iteration = 0; iteration < 2000; iteration++) {
    const resample = differences.map(() => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return differences[state % differences.length]!;
    }).sort((a, b) => a - b);
    medians.push(percentile(resample, 0.5));
  }
  medians.sort((a, b) => a - b);
  return { completePairs: pairs.length, pairs, medianImprovementMs: percentile(differences, 0.5), bootstrap95Ms: [percentile(medians, 0.025), percentile(medians, 0.975)], bootstrapSeed: 104729, bootstrapResamples: 2000 };
}
