import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { StoreCorruptionError } from "../src/reducer-backed-store.js";
import { LoopStore } from "../src/store.js";
import { fixture, policy, text } from "./helpers/jev-loop-fixture.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function snapshot(completion = true, maxFires = 5) {
  const directory = mkdtempSync(join(tmpdir(), "jev-persistence-")); directories.push(directory);
  const path = join(directory, "loops.json");
  const store = new LoopStore(path);
  store.create({ type: "dynamic" }, "Fixture goal", { recurring: true, maxFires,
    ...(completion ? { completion: policy, completionCwd: directory } : {}) });
  const bytes = readFileSync(path, "utf8");
  let data: any;
  try { data = JSON.parse(bytes); } catch (error) { throw new Error("Invalid store fixture", { cause: error }); }
  return { path, bytes, data, entry: data.loops[0], store };
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
    { fireCount: -1 }, { fireCount: "unknown" }, { fireCount: "1" }, { fireCount: 1.5 }, { fireCount: null }, { fireCount: undefined }, { fireCount: 6 },
    { dynamic: undefined }, { dynamic: null }, { dynamic: [] }, { dynamic: "state" }, { dynamic: {} },
    { dynamic: { goal: 7, iteration: 0 } }, { dynamic: { goal: "Fixture", iteration: -1 } }, { dynamic: { goal: "Fixture", iteration: "0" } },
    { dynamic: { goal: "Fixture", iteration: 0, awaitingUpdate: "false" } },
    { dynamic: { goal: "Fixture", iteration: 0, nextWakeAt: "later" } }, { dynamic: { goal: "Fixture", iteration: 0, lastUpdatedAt: 1.5 } },
    { dynamic: { goal: "Fixture", iteration: 0, state: {} } }, { dynamic: { goal: "Fixture", iteration: 0, metrics: [] } },
    { dynamic: { goal: "Fixture", iteration: 0, doneCriteria: false } },
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

  it.each([-3, "unknown", 1.5, null, undefined, 3])("recovers a corrupt fire counter before admitting work: %j", fireCount => {
    const h = snapshot(true, 2); h.entry.fireCount = fireCount; corrupt(h, h.bytes);
    const store = new LoopStore(h.path); const restored = structuredClone(store.get("1")!);
    const restoredBytes = readFileSync(h.path, "utf8");
    let accepted = 0;
    for (let step = 0; step < 5; step++) if (store.fire("1")) accepted++;
    expect(accepted).toBe(2); expect(restored.fireCount).toBe(0); expect(restoredBytes).toBe(h.bytes);
    expect(store.get("1")).toMatchObject({ status: "paused", fireCount: 2, pause: { kind: "controller_limit" } });
  });

  it("preserves an intact exhausted cap without resuming or renewing its budget", () => {
    const h = snapshot(true, 2); h.store.fire("1"); h.store.fire("1");
    const bytes = readFileSync(h.path, "utf8"); const store = new LoopStore(h.path);
    expect(store.get("1")).toMatchObject({ status: "paused", fireCount: 2, maxFires: 2 });
    expect(readFileSync(h.path, "utf8")).toBe(bytes);
    expect(store.fire("1")).toBeUndefined(); expect(store.resume("1")).toBeUndefined();
    expect(store.get("1")?.fireCount).toBe(2);
    expect(store.get("1")?.completionId).toBe(h.entry.completionId);
  });

  it("keeps the ordinary legacy missing-counter convention", () => {
    const h = snapshot(false, 2); delete h.entry.fireCount; const bytes = corrupt(h, h.bytes);
    const store = new LoopStore(h.path);
    expect(store.get("1")?.fireCount).toBeUndefined(); expect(readFileSync(h.path, "utf8")).toBe(bytes);
    expect(store.fire("1")?.fireCount).toBe(1);
  });

  it("restores capped dynamic work so its final verified completion remains reachable", async () => {
    const h = snapshot(true, 2); h.store.fire("1"); h.store.fire("1");
    const capped = structuredClone(h.store.get("1")!); const bytes = readFileSync(h.path, "utf8");
    h.data.loops[0] = structuredClone(capped); delete h.data.loops[0].dynamic; corrupt(h, bytes);
    const store = new LoopStore(h.path);
    expect(store.get("1")?.dynamic).toEqual(capped.dynamic); expect(readFileSync(h.path, "utf8")).toBe(bytes);
    expect(store.resume("1")).toBeUndefined();
    const runtime = fixture(h.path); Object.assign(runtime.ctx, { cwd: capped.completionCwd });
    expect(text(await runtime.complete())).toContain("completed and deleted");
    expect(runtime.confirm).toHaveBeenCalledTimes(1); expect(runtime.store.get("1")).toBeUndefined();
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
