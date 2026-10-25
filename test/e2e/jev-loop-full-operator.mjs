import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readOperatorUIResponse } from "../helpers/operator-ui-response.js";

// Explicit operator-mediated SDK fixture, never an automatic approval or parent-goal worker.
const argv = process.argv.slice(2);
if (argv.length === 1 && argv[0] === "--self-check") {
  const current = { id: "fresh", method: "select", options: ["No — cancel", "Yes — approve"] };
  assert.equal(readOperatorUIResponse({ type: "extension_ui_response", id: "fresh", value: "No — cancel" }, current), "No — cancel");
  assert.throws(() => readOperatorUIResponse({ type: "extension_ui_response", id: "old", value: "Yes — approve" }, current));
  const local = await mkdtemp(join(tmpdir(), "jev-full-operator-metadata-"));
  try {
    const inventory = await ModelRuntime.create({ authPath: join(local, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    assert(inventory.getModel("openai", "gpt-4o-mini"), "Pinned local control-model metadata is unavailable");
  } finally { await rm(local, { recursive: true, force: true }); }
  console.log(JSON.stringify({ type: "structural_self_check", passed: true, approvals: 0, serviceCalls: 0, modelInference: false, liveAcceptance: false }));
  process.exit(0);
}
if (!argv.includes("--operator-bridge")) {
  console.log("SKIP: an explicit current native operator bridge is required; no approval, verifier or service call was made.");
  process.exit(0);
}
const options = new Map();
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--operator-bridge") continue;
  assert(["--peer-root", "--loop-ref", "--peer-ref", "--hard-deadline"].includes(argv[i]) && !options.has(argv[i]) && argv[i + 1], "Unknown or duplicate fixture option");
  options.set(argv[i], argv[++i]);
}
assert.equal(options.size, 4);
assert.equal(globalThis.Bun?.version, "1.4.3"); assert.equal(VERSION, "1.2.0");
assert.notEqual(process.platform, "win32", "POSIX process-group verification is required");
const loopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."), peerRoot = resolve(options.get("--peer-root"));
for (const [root, ref] of [[loopRoot, options.get("--loop-ref")], [peerRoot, options.get("--peer-ref")]]) {
  assert.match(ref, /^[a-f0-9]{40}$/);
  assert.equal(execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), ref);
  assert.equal(execFileSync("git", ["-C", root, "status", "--porcelain"], { encoding: "utf8" }).trim(), "", "Fixture source must be an exact clean reviewed ref");
}
const hardDeadline = Date.parse(options.get("--hard-deadline"));
assert(Number.isSafeInteger(hardDeadline) && hardDeadline > Date.now() && hardDeadline - Date.now() <= 86400000);
const loopFactory = (await import(pathToFileURL(join(loopRoot, "dist/index.js")).href)).default;
const { resolveLoopStorePath } = await import(pathToFileURL(join(loopRoot, "dist/api.js")).href);
const { registerJevTools } = await import(pathToFileURL(join(peerRoot, "src/index.ts")).href);
assert.equal(typeof loopFactory, "function"); assert.equal(typeof registerJevTools, "function");
const bundleSha256 = createHash("sha256").update(await readFile(join(loopRoot, "dist/index.js"))).digest("hex");
const cwd = await mkdtemp(join(tmpdir(), "jev-native-full-")); process.chdir(cwd);
process.env.PI_LOOP_SCOPE = "session"; delete process.env.PI_LOOP;
const manager = SessionManager.create(cwd, join(cwd, "sessions"));
const loopPath = resolveLoopStorePath({ loopScope: "session", cwd }, manager.getSessionId());
const controller = new AbortController(), pending = new Map();
let session, stopReason, input = "", stage = "preparing", modeApprovals = 0, recoveryApprovals = 0, serviceCalls = 0;
let hostDenials = 0, deniedHandlerRuns = 0, markerWrites = 0, cleanupConfirmed = false, originalB, modeRevoked = false, factoriesStarted = false;
const verificationCodes = [], assessments = [], seenAssessments = new Set();
const started = performance.now(); let executionDeadline, timer = setTimeout(() => abort("original_hard_deadline"), hardDeadline - Date.now());
function emit(value) { const line = JSON.stringify(value); assert(Buffer.byteLength(line) <= 65536); process.stdout.write(`${line}\n`); }
function abort(reason) {
  stopReason ??= reason; if (controller.signal.aborted) return; controller.abort(); input = ""; process.stdin.pause();
  for (const active of pending.values()) active.reject(new Error("Current operator scope canceled")); pending.clear();
  void session?.abort();
}
const trial = { fixture: "two-goal-native-full-readiness-v1", cwd, loopRef: options.get("--loop-ref"), peerRef: options.get("--peer-ref"),
  maxGoals: 2, perGoalMaxFires: 3, perGoalLifetime: "5m", verifierTimeoutMs: 30000, maxPublicDecisionCalls: 4,
  markerWrites: 1, allowedMarker: "ready", privateReloads: 1, nativeModeApprovals: 1, nativeReviewedRecoveryApprovals: 1,
  executionAfterModeYesMs: 600000, originalHardDeadline: hardDeadline, realWorkers: 0,
  parentModel: "synthetic control only", physicalTerminalAcceptance: false, globalSettingsChanged: false };
function request(method, title, choices, signal) {
  return new Promise((resolveReply, reject) => {
    const id = randomUUID(), combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const cancel = () => { pending.delete(id); reject(new Error("Native UI scope expired or canceled")); };
    if (combined.aborted) { cancel(); return; } combined.addEventListener("abort", cancel, { once: true });
    const descriptor = method === "select" ? { id, method, options: choices } : { id, method };
    pending.set(id, { descriptor, reject, resolve: value => { combined.removeEventListener("abort", cancel); pending.delete(id); resolveReply(value); } });
    emit({ type: "extension_ui_request", id, method, title, ...(choices ? { options: choices } : {}), trial, stage,
      instruction: "Relay this exact CURRENT native request and trial scope to the operator; never synthesize or reuse an answer." });
  });
}
process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => {
  if (controller.signal.aborted) return; input += chunk;
  if (Buffer.byteLength(input) > 32768) { abort("input_oversize"); return; }
  while (input.includes("\n")) {
    const end = input.indexOf("\n"), line = input.slice(0, end).replace(/\r$/, ""); input = input.slice(end + 1); if (!line) continue;
    try { const value = JSON.parse(line), active = pending.get(value.id); assert(active, "Unknown/stale response"); active.resolve(readOperatorUIResponse(value, active.descriptor)); }
    catch { abort("operator_protocol_error"); return; }
  }
});
process.stdin.on("end", () => abort(input ? "operator_protocol_error" : "input_end"));
process.on("SIGTERM", () => abort("signal_term")); process.on("SIGINT", () => abort("signal_int"));
async function snapshot() { return JSON.parse(await readFile(loopPath, "utf8")).loops; }
const userGoal = "격리된 고정 준비 상태 fixture를 승인된 범위에서 확인한다";
const completion = { goal: "Make the isolated fixed readiness check pass.", criteria: ["The unchanged readiness check records exit code zero."],
  verification: { command: process.execPath, args: ["--no-env-file", "--no-install", `--config=${join(peerRoot, "src/worker-bunfig.toml")}`, "-e", 'process.exit(require("node:fs").existsSync("ready") ? 0 : 7)'],
    description: "The deterministic readiness check's sole acceptance criterion is its observed exit code zero." } };
const create = { trigger: "idle", triggerType: "idle", recurring: true, prompt: userGoal, requestedAccess: "full", maxFires: 3, expiresIn: "5m", completion };
trial.policy = completion;
const deniedPrompt = "Known fixture host-denied attempt";
function observe(pi) {
  factoriesStarted = true;
  const wrapped = Object.create(pi), register = pi.registerTool.bind(pi);
  wrapped.registerTool = tool => register({ ...tool, async execute(id, args, signal, update, ctx) {
    try {
    if (tool.name === "LoopCreate") {
      if (args.prompt === deniedPrompt) { deniedHandlerRuns++; throw new Error("Host deny did not fence handler"); }
      assert.equal(modeApprovals, 1);
      for (const [key, value] of Object.entries(create)) assert.deepEqual(args[key], value);
      for (const key of Object.keys(args)) assert(Object.hasOwn(create, key) || ["autoTask", "taskBacklog", "readOnly"].includes(key) && args[key] === false);
    }
    if (tool.name === "jev_decide") {
      assert(modeApprovals === 1 && !controller.signal.aborted);
      assert(stage === "explicit_reviewed_recovery" ? recoveryApprovals === 1 : !modeRevoked, "No public advice after revoked/unrestored authority");
      assert(++serviceCalls <= 4);
      const serialized = JSON.stringify(args); assert(!seenAssessments.has(serialized), "No duplicate public assessment"); seenAssessments.add(serialized);
      for (const privateValue of [cwd, loopRoot, peerRoot, userGoal, process.execPath]) assert(!serialized.includes(privateValue), "Private input reached a public packet");
    }
    const result = await tool.execute(id, args, signal, update, ctx);
    const text = String(result.content?.[0]?.text);
    if (tool.name === "LoopAccess" && args.action === "full" && !text.includes("Loop Full active")) abort("mode_unavailable_or_unconfirmed");
    if (tool.name === "LoopCreate" && !text.includes("created")) abort("goal_admission_held");
    if (tool.name === "LoopAccess" && args.action === "reviewed") { if (!text.includes("is Reviewed")) abort("revocation_unconfirmed"); else modeRevoked = true; }
    if (tool.name === "LoopUpdate" && args.id === "2" && args.status === "continue" && stage === "explicit_reviewed_recovery") {
      const retained = (await snapshot()).find(loop => loop.id === "2"); assert(retained && originalB);
      for (const field of ["createdAt", "expiresAt", "maxFires", "completionId", "completion"]) assert.deepEqual(retained[field], originalB[field], "Recovery changed immutable goal data");
    }
    if (tool.name === "LoopUpdate") {
      const receipt = result.details?.completionReview;
      if (receipt?.verifier) {
        verificationCodes.push(receipt.verifier.code);
        if (args.id === "2" && (stage !== "explicit_reviewed_recovery" || recoveryApprovals !== 1)) abort("revoked_or_saved_grant_executed");
      }
      if (receipt?.assessments) for (const item of receipt.assessments) assessments.push({ criterion: item.criterion, status: item.status, choice: item.reply?.choice, model: item.reply?.model });
      if (receipt?.verifier?.code === 0 && !String(result.content?.[0]?.text).includes("completed and deleted")) abort("assessment_unmet_or_unavailable");
    }
    emit({ type: "tool_observation", tool: tool.name, stage, serviceCalls, verificationCodes: [...verificationCodes] });
    return result;
    } catch { abort("fixture_tool_failure"); throw new Error("Fixed owned fixture held; no retry or provider fallback is authorized."); }
  } }); return wrapped;
}
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [pi => loopFactory(observe(pi)), pi => registerJevTools(observe(pi)), pi => {
    pi.on("tool_call", event => { if (event.toolName === "LoopCreate" && event.input.prompt === deniedPrompt) { hostDenials++; return { block: true, reason: "Fixed owned fixture host deny" }; } });
    observe(pi).registerTool({ name: "FixtureWork", label: "Fixed marker repair", description: "Write only the approved readiness marker after the actual mode response and observed failed fixed check.", parameters: Type.Object({}, { additionalProperties: false }),
      async execute() { assert(modeApprovals === 1 && verificationCodes[0] === 7 && markerWrites === 0 && !controller.signal.aborted); await writeFile(join(cwd, "ready"), "ready\n", { flag: "wx" }); markerWrites++; return { content: [{ type: "text", text: "Fixed readiness marker written." }], details: undefined }; } });
  }] });
const uiContext = { notify() {}, setStatus() {}, setWidget() {},
  select: async (title, choices, nativeOptions) => {
    assert.equal(stage, "full_and_revoke"); assert.equal(modeApprovals, 0); assert.deepEqual(choices, ["No — cancel", "Yes — approve"]);
    const value = await request("select", title, choices, nativeOptions?.signal);
    if (value !== "Yes — approve" || controller.signal.aborted) { abort("mode_declined_or_canceled"); return undefined; }
    modeApprovals++; executionDeadline = Math.min(hardDeadline, Date.now() + 600000); clearTimeout(timer); timer = setTimeout(() => abort("execution_deadline"), executionDeadline - Date.now()); return value;
  },
  confirm: async (title, message, nativeOptions) => {
    assert.equal(stage, "explicit_reviewed_recovery"); assert.equal(recoveryApprovals, 0);
    const value = await request("confirm", `${title}\n\n${message}`, undefined, nativeOptions?.signal);
    if (value !== true || controller.signal.aborted) { abort("recovery_declined_or_canceled"); return false; } recoveryApprovals++; return true;
  },
};
const initialEvidence = "The fixed readiness check has not passed; no successful result is asserted.";
const positiveEvidence = "The unchanged fixed check was executed and recorded exit code zero. That observed numeric outcome is its sole stated criterion; no unobserved requirements are asserted.";
async function run(plan) {
  let index = 0, calls = 0;
  session.agent.streamFunction = () => {
    assert(++calls <= plan.length + 6, "No unbounded parent model loop");
    const step = controller.signal.aborted ? undefined : plan[index++];
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: step ? "toolUse" : "stop",
      content: step ? [{ type: "toolCall", id: randomUUID(), name: step[0], arguments: step[1] }] : [{ type: "text", text: "Current bounded fixture phase ended." }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: step ? "toolUse" : "stop", message }); stream.end(message); return stream;
  };
  let settle; const settled = new Promise(resolveSettled => { settle = resolveSettled; });
  const unsubscribe = session.subscribe(event => { if (event.type === "agent_settled") settle(); });
  const cancel = () => { settle(); void session.abort(); }; controller.signal.addEventListener("abort", cancel, { once: true });
  try { await session.prompt("Run only the current predeclared isolated native fixture phase."); await settled; assert(!controller.signal.aborted && index >= plan.length); }
  finally { unsubscribe(); controller.signal.removeEventListener("abort", cancel); }
}
let model, result;
try {
  await resourceLoader.reload(); assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("openai", "synthetic-control-no-model-network"); model = modelRuntime.getModel("openai", "gpt-4o-mini"); assert(model, "Pinned local synthetic-parent metadata is unavailable");
  ({ session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader, modelRuntime, model, settingsManager, sessionManager: manager, noTools: "builtin" }));
  await session.bindExtensions({ mode: "rpc", uiContext });
  emit({ type: "operator_start", trial, sdkVersion: VERSION, bunVersion: Bun.version, bundleSha256, approvalsSynthesized: false });
  stage = "full_and_revoke";
  await run([["LoopAccess", { action: "full", maxFires: 3, expiresIn: "5m" }], ["LoopCreate", { ...create, prompt: deniedPrompt }],
    ["LoopCreate", create], ["LoopUpdate", { id: "1", status: "completed", completionEvidence: initialEvidence }], ["FixtureWork", {}],
    ["LoopUpdate", { id: "1", status: "completed", completionEvidence: positiveEvidence }], ["LoopCreate", create],
    ["LoopAccess", { action: "reviewed" }], ["LoopUpdate", { id: "2", status: "completed", completionEvidence: positiveEvidence }]]);
  assert.equal(modeApprovals, 1); assert.equal(hostDenials, 1); assert.equal(deniedHandlerRuns, 0); assert.deepEqual(verificationCodes, [7, 0]);
  originalB = (await snapshot()).find(loop => loop.id === "2"); assert.equal(originalB?.status, "paused"); assert.equal((await snapshot()).length, 1);
  await session.reload(); stage = "explicit_reviewed_recovery";
  await run([["LoopAccess", { action: "status" }], ["LoopUpdate", { id: "2", status: "completed", completionEvidence: positiveEvidence }],
    ["LoopAccess", { action: "review_goal", id: "2" }], ["LoopUpdate", { id: "2", status: "continue" }], ["LoopUpdate", { id: "2", status: "completed", completionEvidence: positiveEvidence }]]);
  assert.deepEqual(verificationCodes, [7, 0, 0]); assert.equal(recoveryApprovals, 1); assert.equal((await snapshot()).length, 0);
  assert.equal(markerWrites, 1); assert(serviceCalls >= 2 && serviceCalls <= 4); assert(assessments.filter(item => item.criterion === "all" && item.choice === "met").length === 2);
  result = { status: "passed", modeApprovals, recoveryApprovals, hostDenials, deniedHandlerRuns, verificationCodes, serviceCalls, assessments, goalsAdmitted: 2,
    originalBHardExpiry: originalB.expiresAt, parentModel: "synthetic control only", physicalTerminalAcceptance: false, realWorkers: 0 };
  stopReason ??= "completed";
} catch { stopReason ??= "held_or_execution_failure"; result = { status: "held", modeApprovals, recoveryApprovals, hostDenials, deniedHandlerRuns, verificationCodes, serviceCalls, noAutomaticRetry: true }; process.exitCode = 1; }
finally {
  clearTimeout(timer); abort("cleanup"); await session?.abort();
  try { if (session) { await session.extensionRunner.emit({ type: "session_shutdown", reason: "exit" }); cleanupConfirmed = true; } else cleanupConfirmed = !factoriesStarted; } catch { process.exitCode = 1; }
  session?.dispose(); process.stdin.destroy();
  if (cleanupConfirmed) { process.chdir(loopRoot); await rm(cwd, { recursive: true, force: true }); }
}
emit({ type: "operator_result", ...result, stopReason: stopReason ?? "completed", cleanupConfirmed, trial, executionDeadline, automationElapsedMs: performance.now() - started,
  approvalsSynthesized: false, currentHostOrGlobalModeChanged: false });
