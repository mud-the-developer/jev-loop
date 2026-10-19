import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StoreCorruptionError } from "../src/reducer-backed-store.js";
import { LoopStore } from "../src/store.js";
import { policy } from "./helpers/jev-loop-fixture.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function snapshot(completion = true) {
  const directory = mkdtempSync(join(tmpdir(), "jev-persistence-")); directories.push(directory);
  const path = join(directory, "loops.json");
  const store = new LoopStore(path);
  store.create({ type: "dynamic" }, "Fixture goal", { recurring: true, maxFires: 5,
    ...(completion ? { completion: policy, completionCwd: directory } : {}) });
  const bytes = readFileSync(path, "utf8");
  let data: any;
  try { data = JSON.parse(bytes); } catch (error) { throw new Error("Invalid store fixture", { cause: error }); }
  return { path, bytes, data, entry: data.loops[0] };
}
function corrupt(h: ReturnType<typeof snapshot>, previous: string) {
  const bytes = JSON.stringify(h.data);
  writeFileSync(h.path, bytes); writeFileSync(`${h.path}.prev`, previous || bytes);
  return bytes;
}

describe("completion persistence boundaries", () => {
  it("keeps ordinary legacy controllers and intact completion identities readable", () => {
    for (const enabled of [false, true]) {
      const h = snapshot(enabled);
      expect(new LoopStore(h.path).get("1")).toMatchObject({ prompt: "Fixture goal", ...(enabled ? { completion: policy, completionId: h.entry.completionId } : {}) });
      expect(readFileSync(h.path, "utf8")).toBe(h.bytes);
    }
  });

  it.each([
    { id: { value: "1" } }, { createdAt: { value: 1 } }, { updatedAt: "unknown" }, { expiresAt: "unknown" },
    { completionId: 17 }, { completionId: { value: "identity" } }, { completionId: "\0" },
    { completionCwd: 17 }, { completionCwd: { path: "not a string" } }, { completionCwd: "\0" },
    { completionVersion: -1 },
    { completionReview: null }, { completionReview: [] }, { completionReview: "lease" }, { completionReview: {} },
    { completionReview: { id: 7, expiresAt: 1 } }, { completionReview: { id: "", expiresAt: 1 } },
    { completionReview: { id: "review", expiresAt: "1" } }, { completionReview: { id: "review", expiresAt: 1.5 } },
    { completionReview: { id: "review", expiresAt: Number.MAX_SAFE_INTEGER } },
  ])("fails visibly if both snapshots contain malformed metadata: %j", fields => {
    const h = snapshot(); Object.assign(h.entry, fields); const bad = corrupt(h, "");
    expect(() => new LoopStore(h.path)).toThrow(StoreCorruptionError);
    expect(readFileSync(h.path, "utf8")).toBe(bad);
    expect(readFileSync(`${h.path}.prev`, "utf8")).toBe(bad);
  });

  it("recovers the previous intact identity rather than accepting a malformed current one", () => {
    const h = snapshot(); const identity = h.entry.completionId; h.entry.completionId = { invalid: true }; corrupt(h, h.bytes);
    const recovered = new LoopStore(h.path).get("1")!;
    expect(recovered.completionId).toBe(identity);
    expect(readFileSync(h.path, "utf8")).toBe(h.bytes);
  });

  it.each([17, { path: "not a string" }, "\0"])("rejects malformed creation cwd before mutation: %j", cwd => {
    const store = new LoopStore();
    expect(() => Reflect.apply(store.create, store, [{ type: "dynamic" }, "Fixture", { recurring: true, maxFires: 5, completion: policy, completionCwd: cwd }])).toThrow();
    expect(store.list()).toEqual([]);
  });

  it("retains an expired but well-formed reservation without treating it as authority", () => {
    const h = snapshot();
    h.entry.completionReview = { id: "expired-review", expiresAt: h.entry.createdAt - 1 };
    corrupt(h, "");
    const store = new LoopStore(h.path); const entry = store.get("1")!;
    expect(entry.completionReview?.id).toBe("expired-review");
    expect(store.reserveCompletionReview("1", JSON.stringify(entry), { id: "fresh-reservation", expiresAt: Math.min(Date.now() + 1000, entry.expiresAt) })).toBeDefined();
  });

  it.each(["completionId", "completionCwd", "completionVersion", "completionReview"])("rejects orphaned %s on an ordinary controller", field => {
    const h = snapshot(false); h.entry[field] = field === "completionVersion" ? 0 : "orphan"; corrupt(h, "");
    expect(() => new LoopStore(h.path)).toThrow(StoreCorruptionError);
  });
});
