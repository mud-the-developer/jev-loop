import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { completionPacket, validateCompletionPolicy } from "../src/jev-completion.js";
import { LoopStore } from "../src/store.js";
import { fixture, policy, text } from "./helpers/jev-loop-fixture.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const fill = (prefix: string, length: number, char: string) => prefix + char.repeat(length - prefix.length);
function largePolicy(char: string) {
  return { goal: fill("Check the fixed readiness condition. ", 384, char),
    criteria: Array.from({ length: 8 }, () => fill("The required fixture check passes. ", 192, char)),
    verification: { ...policy.verification, description: fill("The fixed readiness check is the sole coverage. ", 256, char) } };
}
function boundaryPolicy(extra = 0) {
  const completion = largePolicy('"');
  // The oversized fixture is 4140 encoded characters with the minimum evidence.
  completion.goal = completion.goal.slice(0, -70);
  if (extra) completion.goal += "x";
  return completion;
}

it("control: maximum ordinary ASCII policy and evidence preserve every criterion within the bound", () => {
  const completion = largePolicy("a"); validateCompletionPolicy(completion);
  const packet = completionPacket(completion, "e".repeat(1024), 0);
  expect(packet.context.length).toBeLessThanOrEqual(4000);
  for (const criterion of completion.criteria) expect(packet.context).toContain(criterion);
});

describe.skipIf(process.platform === "win32")("completion packet setup admission", () => {
  it("rejects an immutable policy that cannot fit even minimum evidence before approval or creation", async () => {
    const completion = largePolicy('"'); expect(() => validateCompletionPolicy(completion)).not.toThrow();
    expect(() => completionPacket(completion, "x", 0)).toThrow();
    const h = fixture(); const result = await h.create({ completion });
    expect(text(result)).toContain("policy"); expect(text(result)).toContain("shorten");
    expect(h.store.list()).toEqual([]); expect(h.confirm).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled(); expect(h.activate).not.toHaveBeenCalled();
  });

  it("maximum ordinary ASCII setup can complete with its maximum evidence summary", async () => {
    const h = fixture(); const completion = largePolicy("a");
    expect(text(await h.create({ completion }))).toContain("created");
    expect(text(await h.complete({ completionEvidence: "e".repeat(1024) }))).toContain("completed and deleted");
    expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.exec).toHaveBeenCalledTimes(1); expect(h.executeTool).toHaveBeenCalledTimes(1);
  });

  it("accepts an exact 4000-character setup and rejects the next character without truncation", async () => {
    const exact = boundaryPolicy(); const packet = completionPacket(exact, "x", 0);
    expect(packet.context.length).toBe(4000);
    const h = fixture(); expect(text(await h.create({ completion: exact }))).toContain("created");
    expect(h.store.get("1")?.completion?.criteria).toEqual(exact.criteria); expect(h.confirm).toHaveBeenCalledTimes(1);
    const bad = fixture(); await bad.create({ completion: boundaryPolicy(1) });
    expect(bad.store.list()).toEqual([]); expect(bad.confirm).not.toHaveBeenCalled();
  });

  it("keeps an existing oversized policy inspectable and cancellable, with an actionable review hold", async () => {
    const directory = mkdtempSync(join(tmpdir(), "jev-policy-budget-")); directories.push(directory);
    const path = join(directory, "loops.json"); const completion = largePolicy('"');
    const store = new LoopStore(path);
    store.create({ type: "dynamic" }, "Existing fixture intent", { recurring: true, maxFires: 3, completion, completionCwd: directory });
    const h = fixture(path); Object.assign(h.ctx, { cwd: directory }); const before = structuredClone(h.store.get("1"));
    const result = await h.complete({ completionEvidence: "x" });
    expect(text(result)).toContain("policy"); expect(text(result)).toContain("cancel and recreate");
    expect(h.store.get("1")).toEqual(before); expect(h.confirm).not.toHaveBeenCalled();
    expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
    expect(text(await h.call("LoopList", {}))).toContain("Existing fixture intent");
    await h.call("LoopDelete", { id: "1" }); expect(h.store.list()).toEqual([]);
  });

  it("oversized escaped evidence on a valid policy does not invalidate or delete that policy", async () => {
    const h = fixture(); await h.create({ completion: boundaryPolicy() }); const before = structuredClone(h.store.get("1"));
    await expect(h.complete({ completionEvidence: '"'.repeat(1024) })).rejects.toThrow("shorten");
    expect(h.store.get("1")).toEqual(before); expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
  });
});
