import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { canResumeFromInspection } from "../src/ui/lifecycle-presentation.js";
import { candidates, deferred, evidence, fixture, outcome, policy, recommendation, text } from "./helpers/jev-loop-fixture.js";

const directories: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function file() { const dir = mkdtempSync(join(tmpdir(), "jev-loops-")); directories.push(dir); return join(dir, "loops.json"); }

it.skipIf(process.platform !== "win32")("rejects unsupported Windows completion before approval or process effects", async () => {
  const h = fixture();
  expect(text(await h.create())).toContain("POSIX");
  expect(h.store.list()).toEqual([]);
  expect(h.confirm).not.toHaveBeenCalled();
  expect(h.exec).not.toHaveBeenCalled();
  expect(h.executeTool).not.toHaveBeenCalled();
});

describe.skipIf(process.platform === "win32")("opt-in JEV loop public-tool acceptance (product hypothesis)", () => {
  it("ordinary-loop control completes without approval, verification, or JEV", async () => {
    const h = fixture();
    await h.create({ completion: undefined });
    expect(text(await h.complete({ completionEvidence: undefined }))).toContain("completed and deleted");
    expect(h.store.list()).toEqual([]);
    expect(h.confirm).not.toHaveBeenCalled(); expect(h.exec).not.toHaveBeenCalled(); expect(h.executeTool).not.toHaveBeenCalled();
  });

  it("the published README setup example creates the intended bounded policy", async () => {
    const markdown = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const match = markdown.match(/## JEV-assisted completion[\s\S]*?```json\n([\s\S]*?)\n```/)!;
    const example = JSON.parse(match[1]!);
    const h = fixture();
    expect(text(await h.call("LoopCreate", example))).toContain("Loop #1 created");
    expect(h.store.get("1")).toMatchObject({ trigger: { type: "dynamic" }, maxFires: 5, completion: example.completion });
    expect(h.exec).not.toHaveBeenCalled();
  });

  it("approves the exact immutable setup once, then requires real verification and supported advice", async () => {
    const h = fixture(); await h.create();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    const approval = JSON.stringify(h.confirm.mock.calls[0]);
    for (const value of [policy.goal, ...policy.criteria, policy.verification.command, ...policy.verification.args, policy.verification.description, h.ctx.cwd, "3", "English", "1024"]) expect(approval).toContain(value);
    expect(h.store.get("1")).toMatchObject({ completion: policy });
    expect(h.exec).not.toHaveBeenCalled();
    expect(text(await h.complete({ state: "PRIVATE STATE", metrics: "PRIVATE METRICS" }))).toContain("completed and deleted");
    expect(h.exec).toHaveBeenCalledWith(policy.verification.command, policy.verification.args, expect.objectContaining({ cwd: h.ctx.cwd, timeout: 30_000, signal: expect.any(AbortSignal) }));
    expect(h.executeTool).toHaveBeenCalledTimes(1);
    const [name, packet] = h.executeTool.mock.calls[0]!;
    expect(name).toBe("jev_decide"); expect(packet.requiresHuman).toBe(false); expect(packet.options).toEqual(candidates);
    expect(packet.context.length).toBeLessThanOrEqual(4000);
    for (const value of [policy.goal, ...policy.criteria, policy.verification.description, evidence, "untrusted", "0"]) expect(packet.context).toContain(value);
    for (const value of ["원래", "PRIVATE", h.ctx.cwd, policy.verification.command, ...policy.verification.args]) expect(JSON.stringify(packet)).not.toContain(value);
    expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.store.list()).toEqual([]);
  });

  it.each([
    { maxFires: undefined }, { maxFires: Infinity }, { maxFires: 0 }, { maxFires: 1.5 },
    { trigger: "5m", triggerType: "cron" }, { trigger: "custom", triggerType: "event" },
    { trigger: "5m", triggerType: "hybrid" }, { autoTask: true }, { taskBacklog: true }, { recurring: false },
    { expiresIn: "forever" },
  ])("rejects unsupported setup without mutation or effects: %j", async extra => {
    const h = fixture(); await h.create(extra);
    expect(h.store.list()).toEqual([]); expect(h.confirm).not.toHaveBeenCalled(); expect(h.activate).not.toHaveBeenCalled();
  });

  it.each(["decline", "no-ui", "no-provider", "abort"])("creates nothing on %s", async mode => {
    const h = fixture(); const abort = new AbortController();
    if (mode === "decline") h.confirm.mockResolvedValue(false);
    if (mode === "no-ui") h.ctx.hasUI = false;
    if (mode === "no-provider") Object.assign(h.ctx, { tools: [] });
    if (mode === "abort") abort.abort();
    await h.create({}, abort.signal);
    expect(h.store.list()).toEqual([]); expect(h.exec).not.toHaveBeenCalled(); expect(h.activate).not.toHaveBeenCalled();
  });

  it.each(["한국어", '"한국어"', "```text\n한국어\n```", "Русский", "日本語"])("rejects non-Latin prose even when quoted/fenced: %s", async prose => {
    for (const completion of [{ ...policy, goal: prose }, { ...policy, criteria: [prose] }, { ...policy, verification: { ...policy.verification, description: prose } }]) {
      const h = fixture(); await h.create({ completion }); expect(h.store.list()).toEqual([]); expect(h.confirm).not.toHaveBeenCalled();
    }
    const h = fixture(); await h.create(); const before = structuredClone(h.store.get("1"));
    await h.complete({ completionEvidence: prose }); expect(h.store.get("1")).toEqual(before); expect(h.exec).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "a".repeat(1025)])("requires bounded separate evidence: %s", async completionEvidence => {
    const h = fixture(); await h.create(); const before = structuredClone(h.store.get("1"));
    await h.complete({ completionEvidence }); expect(h.store.get("1")).toEqual(before); expect(h.exec).not.toHaveBeenCalled();
  });

  it.each(["unmet", "unknown"])("holds %s without stopping or scheduling and does not repeat approval within scope", async choice => {
    const h = fixture(); await h.create(); const before = structuredClone(h.store.get("1"));
    h.executeTool.mockResolvedValue(outcome(recommendation(choice)));
    const result = await h.complete(); expect(text(result)).toContain(choice); expect(h.store.get("1")).toEqual(before);
    expect(h.trigger.add).toHaveBeenCalledTimes(1);
    h.executeTool.mockResolvedValue(outcome(recommendation()));
    await h.complete({ completionEvidence: "Additional checks now support every criterion." });
    expect(h.confirm).toHaveBeenCalledTimes(1); expect(h.store.list()).toEqual([]);
  });

  it("cancelled verification cannot complete even with met advice; retry requires fresh approval", async () => {
    const h = fixture(); await h.create();
    h.exec.mockResolvedValueOnce({ code: 0, killed: true, stdout: "PRIVATE", stderr: "PRIVATE" });
    await h.complete(); expect(h.store.get("1")).toBeDefined();
    await h.call("LoopUpdate", { id: "1", status: "continue", state: "Repairing" });
    expect(h.store.get("1")?.dynamic?.iteration).toBe(1);
    await h.complete({ completionEvidence: "The previously failing behavior is now repaired and tested." });
    expect(h.confirm).toHaveBeenCalledTimes(2); expect(h.store.list()).toEqual([]);
  });

  it("ordinary verification failure permits repair without repeating setup approval", async () => {
    const h = fixture(); await h.create();
    h.exec.mockResolvedValueOnce({ code: 1, killed: false, stdout: "PRIVATE", stderr: "PRIVATE" });
    expect(text(await h.complete())).toContain("unmet");
    expect(h.executeTool).not.toHaveBeenCalled();
    expect(h.store.get("1")).toBeDefined();
    await h.call("LoopUpdate", { id: "1", status: "continue", state: "Repairing within scope" });
    await h.complete({ completionEvidence: "The failing behavior has been repaired and verified." });
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.exec).toHaveBeenCalledTimes(2);
    expect(h.store.list()).toEqual([]);
  });

  it("signal termination cannot complete even if an execution adapter reports exit zero", async () => {
    const h = fixture(); await h.create();
    h.exec.mockResolvedValueOnce({ code: 0, killed: false, signal: "SIGTERM", stdout: "", stderr: "" } as any);
    await h.complete();
    expect(h.store.get("1")).toBeDefined();
    expect(h.executeTool).not.toHaveBeenCalled();
  });

  it.each([
    undefined, { status: "recommended", advisoryOnly: true },
    { ...recommendation(), advisoryOnly: false },
    { ...recommendation(), option: candidates[1] },
    { ...recommendation(), reply: { ...recommendation().reply, choice: "invented" } },
    { ...recommendation(), reply: { ...recommendation().reply, probabilities: { met: 0.4, unmet: 0.5, unknown: 0.1 } } },
    { ...recommendation(), reply: { ...recommendation().reply, probabilities: { met: 0.8 } } },
    { ...recommendation(), reply: { ...recommendation().reply, probabilities: { met: 0.34, unmet: 0.33, unknown: 0.33 } } },
    { status: "failed", error: "fixture" }, { status: "cancelled" },
  ])("holds malformed/missing/failed advice and revokes cached approval: %j", async details => {
    const h = fixture(); await h.create(); const before = structuredClone(h.store.get("1"));
    h.executeTool.mockResolvedValueOnce(outcome(details)); await h.complete(); expect(h.store.get("1")).toEqual(before);
    await h.complete({ completionEvidence: "New evidence supports all criteria." }); expect(h.confirm).toHaveBeenCalledTimes(2);
  });

  it("malformed result JSON cannot complete despite a valid-looking details object", async () => {
    const h = fixture(); await h.create();
    const before = structuredClone(h.store.get("1"));
    const reply = outcome(recommendation()); reply.result.content[0]!.text = "{invalid";
    h.executeTool.mockResolvedValue(reply);
    await h.complete();
    expect(h.store.get("1")).toEqual(before);
  });

  it("a capped loop remains non-resumable in inspection after an explicit pause", async () => {
    const h = fixture(); await h.create({ maxFires: 1 }); h.store.fire("1");
    await h.call("LoopUpdate", { id: "1", status: "paused" });
    const entry = h.store.get("1")!;
    expect(entry.pause?.kind).toBe("administrative");
    expect(canResumeFromInspection(entry)).toBe(false);
    expect(h.store.resume("1")).toBeUndefined();
    expect(h.exec).not.toHaveBeenCalled();
  });

  it("honors real Pi AgentToolCallOutcome isError, never treating a blocked nested call as advice", async () => {
    const h = fixture(); await h.create(); h.executeTool.mockResolvedValue(outcome(recommendation(), true));
    await h.complete(); expect(h.store.get("1")).toBeDefined();
  });

  it("preserves exact needs_user askUser handoff, with no automatic ask_user or completion", async () => {
    const h = fixture(); await h.create();
    const askUser = { question: "Choose", context: "Exact context\nnot rewritten", options: [{ title: "Wait", description: "Exact" }, { title: "Inspect", description: "More" }], allowMultiple: false, allowFreeform: true };
    h.executeTool.mockResolvedValue(outcome({ status: "needs_user", advisoryOnly: true, askUser }));
    const result = await h.complete(); expect(result.details).toMatchObject({ askUser }); expect(text(result)).toContain(JSON.stringify(askUser));
    expect(h.store.get("1")).toBeDefined(); expect(h.executeTool).toHaveBeenCalledTimes(1);
  });

  it.each([{ prompt: "Changed goal" }, { doneCriteria: "Changed criteria" }, { completion: { ...policy, goal: "Changed goal" } }])("rejects goal/policy changes %j", async extra => {
    const h = fixture(); await h.create(); const before = structuredClone(h.store.get("1"));
    await h.complete(extra); expect(h.store.get("1")).toEqual(before); expect(h.exec).not.toHaveBeenCalled();
    await h.call("LoopUpdate", { id: "1", status: "continue", ...extra }); expect(h.store.get("1")).toEqual(before);
  });

  it("keeps final cap inspectable, forbids continue/resume, but accepts verified final completion", async () => {
    const h = fixture(); await h.create({ maxFires: 1 }); h.store.fire("1");
    expect(h.store.get("1")).toMatchObject({ status: "paused", pause: { kind: "controller_limit" } });
    const before = structuredClone(h.store.get("1"));
    expect(text(await h.call("LoopList", {}))).toContain("controller_limit");
    await h.call("LoopUpdate", { id: "1", status: "continue" }); expect(h.store.resume("1")).toBeUndefined(); expect(h.store.get("1")).toEqual(before);
    await h.complete(); expect(h.store.list()).toEqual([]);
  });

  it("cancellation stops and drains owned verification before acknowledgement", async () => {
    const h = fixture(); await h.create();
    const wait = deferred<Awaited<ReturnType<typeof h.exec>>>(); h.exec.mockReturnValueOnce(wait.promise);
    const reviewing = h.complete();
    await vi.waitFor(() => expect(h.exec).toHaveBeenCalledTimes(1));
    let acknowledged = false;
    const cancelling = h.call("LoopDelete", { id: "1" }).then(result => { acknowledged = true; return result; });
    try {
      await Promise.resolve();
      expect(h.exec.mock.calls[0]![2].signal.aborted).toBe(true);
      expect(acknowledged).toBe(false);
      expect(h.store.get("1")).toBeUndefined();
    } finally {
      wait.resolve({ code: 0, killed: true, stdout: "", stderr: "" });
      await Promise.all([reviewing, cancelling]);
    }
    expect(acknowledged).toBe(true);
    expect(h.executeTool).not.toHaveBeenCalled();
  });

  it("conditional cancellation rejects the wrong creation identity without mutation", async () => {
    const path = file(); const h = fixture(path); await h.create(); const before = structuredClone(h.store.get("1")!);
    const bytes = readFileSync(path, "utf8");
    expect(Reflect.apply(h.store.delete, h.store, ["1", { createdAt: before.createdAt, completionId: "stale-controller" }])).toBe(false);
    expect(h.store.get("1")).toEqual(before);
    expect(readFileSync(path, "utf8")).toBe(bytes);
    expect(Reflect.apply(h.store.delete, h.store, ["1", { createdAt: before.createdAt, completionId: before.completionId }])).toBe(true);
    expect(h.store.get("1")).toBeUndefined();
  });

  it("a late provider reply cannot resurrect canceled work", async () => {
    const h = fixture(); await h.create(); const reply = deferred<any>(); h.executeTool.mockReturnValueOnce(reply.promise);
    const reviewing = h.complete(); await vi.waitFor(() => expect(h.executeTool).toHaveBeenCalledTimes(1));
    await h.call("LoopDelete", { id: "1" });
    expect(h.executeTool.mock.calls[0]![2].signal.aborted).toBe(true);
    reply.resolve(outcome(recommendation())); await reviewing;
    expect(h.store.get("1")).toBeUndefined(); expect(h.executeTool).toHaveBeenCalledTimes(1);
  });

  it("rejects concurrent review before duplicate verifier or provider effects", async () => {
    const h = fixture(); await h.create(); const wait = deferred<Awaited<ReturnType<typeof h.exec>>>();
    h.exec.mockReturnValueOnce(wait.promise); const first = h.complete();
    await vi.waitFor(() => expect(h.exec).toHaveBeenCalledTimes(1));
    expect(text(await h.complete())).toMatch(/in progress|already.*review/i); expect(h.exec).toHaveBeenCalledTimes(1);
    wait.resolve({ code: 0, killed: false, stdout: "", stderr: "" }); await first; expect(h.executeTool).toHaveBeenCalledTimes(1);
  });

  it.each(["approval", "verification", "JEV"])("generation switch during %s prevents later effects and completion", async boundary => {
    const h = fixture(); const wait = deferred<any>();
    if (boundary === "approval") h.confirm.mockReturnValueOnce(wait.promise);
    else { await h.create(); if (boundary === "verification") h.exec.mockReturnValueOnce(wait.promise); else h.executeTool.mockReturnValueOnce(wait.promise); }
    const pending = boundary === "approval" ? h.create() : h.complete();
    await vi.waitFor(() => expect(boundary === "approval" ? h.confirm : boundary === "verification" ? h.exec : h.executeTool).toHaveBeenCalledTimes(1));
    const shutdown = h.shutdown();
    if (boundary === "verification") expect(h.exec.mock.calls[0]![2].signal.aborted).toBe(true);
    wait.resolve(boundary === "approval" ? true : boundary === "verification" ? { code: 0, killed: false, stdout: "", stderr: "" } : outcome(recommendation()));
    await pending; await shutdown;
    if (boundary === "approval") expect(h.store.list()).toEqual([]); else expect(h.store.get("1")).toBeDefined();
    if (boundary !== "JEV") expect(h.executeTool).not.toHaveBeenCalled();
  });

  it("file-backed peer mutation during JEV fails closed; restart never restores approval", async () => {
    const path = file(); const h = fixture(path); await h.create();
    const wait = deferred<any>(); h.executeTool.mockReturnValueOnce(wait.promise); const pending = h.complete();
    await vi.waitFor(() => expect(h.executeTool).toHaveBeenCalledTimes(1));
    const peer = new LoopStore(path); peer.pause("1"); const before = structuredClone(peer.get("1"));
    wait.resolve(outcome(recommendation())); await pending; expect(peer.get("1")).toEqual(before);
    peer.resume("1");
    const restarted = fixture(path); restarted.confirm.mockResolvedValue(false); await restarted.complete();
    expect(restarted.confirm).toHaveBeenCalledTimes(1); expect(restarted.exec).not.toHaveBeenCalled(); expect(restarted.store.get("1")).toBeDefined();
    expect(readFileSync(path, "utf8")).not.toMatch(/approved|approvalToken/);
  });

  it("inspection exposes immutable completion criteria without starting effects", async () => {
    const h = fixture(); await h.create();
    const before = structuredClone(h.store.get("1"));
    const listed = text(await h.call("LoopList", {}));
    expect(listed).toContain("JEV completion");
    for (const value of [policy.goal, ...policy.criteria, policy.verification.description]) expect(listed).toContain(value);
    expect(h.store.get("1")).toEqual(before);
    expect(h.exec).not.toHaveBeenCalled();
    expect(h.executeTool).not.toHaveBeenCalled();
  });

  it("expiry and inspection never grant completion or verification authority", async () => {
    vi.useFakeTimers(); const h = fixture(); await h.create({ expiresIn: "1s" }); const before = structuredClone(h.store.get("1"));
    await h.call("LoopList", {}); expect(h.store.get("1")).toEqual(before); expect(h.exec).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1001); await h.complete(); expect(h.store.get("1")).toEqual(before); expect(h.exec).not.toHaveBeenCalled();
  });
});
