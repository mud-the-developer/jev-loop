import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, VERSION } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { registerJevLoopCommand } from "../../src/commands/jev-loop-command.js";
import { verifyCompletion } from "../../src/completion-verifier.js";
import { LoopStore } from "../../src/store.js";
import { registerLoopTools } from "../../src/tools/loop-tools.js";

// Operator-mediated SDK acceptance, not a worker or a credential/backend client.
// No approval is synthesized: the client must relay the human's current UI choice
// and the existing public JEV tool's actual decision through bounded JSONL.
if (!process.argv.includes("--operator-bridge")) {
  console.log("SKIP: use --operator-bridge with a human UI/public JEV client. No approvals or model calls were made.");
  process.exit(0);
}
if (process.platform === "win32") throw new Error("This completion fixture requires POSIX verification.");

const emit = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const controller = new AbortController();
const pending = new Map();
let input = "";
function abort() {
  if (controller.signal.aborted) return;
  controller.abort();
  input = "";
  process.stdin.pause();
  for (const request of pending.values()) request.reject(new Error("Operator bridge canceled"));
  pending.clear();
}
function request(type, payload, signal) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    const cancel = () => { pending.delete(id); reject(new Error("Request expired or canceled")); };
    if (combined.aborted) { cancel(); return; }
    combined.addEventListener("abort", cancel, { once: true });
    pending.set(id, {
      type, reject,
      resolve: value => { combined.removeEventListener("abort", cancel); pending.delete(id); resolve(value); },
    });
    emit({ type, id, ...payload });
  });
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  if (controller.signal.aborted) return;
  input += chunk;
  if (Buffer.byteLength(input, "utf8") > 32768) { abort(); return; }
  while (input.includes("\n")) {
    const end = input.indexOf("\n");
    const line = input.slice(0, end).replace(/\r$/, ""); input = input.slice(end + 1);
    if (!line) continue;
    try {
      const response = JSON.parse(line);
      const active = pending.get(response.id);
      assert(active, "Unknown or stale bridge response");
      if (active.type === "extension_ui_request") {
        assert(response.type === "extension_ui_response" && (typeof response.confirmed === "boolean" || response.cancelled === true));
        active.resolve(response.cancelled === true ? false : response.confirmed);
      } else {
        assert(response.type === "jev_decision_response");
        if (response.error) { abort(); return; }
        active.resolve(response.decision);
      }
    } catch { abort(); return; }
  }
});
process.stdin.on("end", abort);
process.on("SIGTERM", abort);
process.on("SIGINT", abort);
const deadline = setTimeout(abort, 180000);

const cwd = await mkdtemp(join(tmpdir(), "jev-live-operator-"));
const store = new LoopStore();
const userGoal = "고정된 준비 상태 검증이 통과하도록 fixture를 완성해줘";
const completion = {
  goal: "Make the fixed readiness check pass.",
  criteria: ["The approved readiness check exits with code zero."],
  verification: {
    command: process.execPath,
    args: ["-e", 'process.exit(require("node:fs").existsSync("ready") ? 0 : 7)'],
    description: "A deterministic fixture readiness check. Its sole required criterion is the recorded exit code zero.",
  },
};
let runtime;
let session;
let phase = 0;
let approvalRequests = 0;
let approvals = 0;
let declined = false;
let jevCalls = 0;
let observed;
const verificationCodes = [];
const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const resourceLoader = new DefaultResourceLoader({
  cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [pi => {
    runtime = registerLoopTools({ pi, getStore: () => store, getTriggerSystem: () => ({ add() {}, remove() {} }),
      getScheduler: () => ({ nextFire: () => undefined }), getMonitorManager: () => ({ get: () => undefined }),
      updateWidget() {}, maybeBootstrapTaskLoop: async () => false, isTaskSystemReady: () => true,
      verify: async (...args) => { const result = await verifyCompletion(...args); verificationCodes.push(result.code); return result; },
    });
    registerJevLoopCommand({ pi, getStore: () => store, getGeneration: () => 0, isContextCurrent: () => !controller.signal.aborted,
      cancelLoop: runtime.cancelLoop, getStorageScope: () => "memory", getNextFire: () => undefined });
    pi.registerTool({ name: "jev_decide", label: "Operator JEV bridge", description: "Relay one fixed English fixture to the existing public JEV tool; no backend credentials here.", parameters: Type.Object({}),
      async execute(_id, args, signal) {
        assert.equal(++jevCalls, 1, "No duplicate JEV call or automatic retry");
        const serialized = JSON.stringify(args);
        assert(!serialized.includes(cwd) && !serialized.includes(userGoal) && !serialized.includes(process.execPath));
        observed = await request("jev_decision_request", { arguments: args }, signal);
        return { content: [{ type: "text", text: JSON.stringify(observed) }], details: observed };
      },
    });
    pi.registerTool({ name: "FixtureWork", label: "Fixed fixture work", description: "Create only the readiness marker inside this owned temporary fixture.", parameters: Type.Object({}),
      async execute() { await writeFile(join(cwd, "ready"), "ready\n"); return { content: [{ type: "text", text: "Fixture readiness marker written." }], details: undefined }; },
    });
  }],
});

let summary;
try {
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  await modelRuntime.setRuntimeApiKey("openai", "synthetic-fixture-no-network");
  const model = getModels("openai")[0];
  ({ session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader, modelRuntime, model, settingsManager,
    sessionManager: SessionManager.inMemory(cwd), noTools: "builtin" }));
  await session.bindExtensions({ uiContext: {
    confirm: async (title, message, options) => {
      approvalRequests++;
      const accepted = await request("extension_ui_request", { method: "confirm", title, message }, options?.signal);
      if (accepted) approvals++;
      else declined = true;
      return accepted;
    }, notify() {}, setStatus() {}, setWidget() {},
  } });
  const plan = [
    ["LoopCreate", { trigger: "idle", triggerType: "idle", prompt: userGoal, recurring: true, maxFires: 5, expiresIn: "1h", completion }],
    ["LoopUpdate", { id: "1", status: "completed", completionEvidence: "The fixed readiness check has not passed yet. No successful acceptance is asserted." }],
    ["LoopUpdate", { id: "1", status: "continue", state: "Repairing the readiness fixture inside the approved scope." }],
    ["FixtureWork", {}],
    ["LoopUpdate", { id: "1", status: "completed", completionEvidence: "The fixed readiness check was executed and recorded exit code zero. It is the sole required acceptance criterion; no additional requirements are asserted." }],
  ];
  session.agent.streamFunction = () => {
    const step = controller.signal.aborted || (phase > 0 && !store.get("1")) ? undefined : plan[phase++];
    const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      stopReason: step ? "toolUse" : "stop",
      content: step ? [{ type: "toolCall", id: `operator-${phase}`, name: step[0], arguments: step[1] }] : [{ type: "text", text: "Fixed operator fixture ended." }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message });
    stream.push({ type: "done", reason: step ? "toolUse" : "stop", message }); stream.end(message); return stream;
  };
  let settle;
  const settled = new Promise(resolve => { settle = resolve; });
  const unsubscribe = session.subscribe(event => { if (event.type === "agent_settled") settle(); });
  const canceled = () => { settle(); void session.abort(); };
  controller.signal.addEventListener("abort", canceled, { once: true });
  if (controller.signal.aborted) canceled();
  try { await session.prompt(`/jev-loop ${userGoal}`); await settled; }
  finally { unsubscribe(); controller.signal.removeEventListener("abort", canceled); }
  const passed = approvals === 1 && approvalRequests === 1 && !store.get("1") && jevCalls === 1
    && JSON.stringify(verificationCodes) === "[7,0]" && observed?.status === "recommended" && observed.reply?.choice === "met";
  summary = { type: "operator_result", status: passed ? "passed" : declined ? "approval_declined" : "held", approvalRequests, approvals,
    verificationCodes, jevCalls, verdict: observed?.reply?.choice, model: observed?.reply?.model, usage: observed?.reply?.usage,
    fixture: "readiness-repair-v1", sdkVersion: VERSION, nodeVersion: process.version,
    primaryModel: "synthetic", physicalTerminalAcceptance: false };
  process.exitCode = passed ? 0 : 1;
} catch {
  summary = { type: "operator_result", status: "failed", approvalRequests, approvals, verificationCodes, jevCalls, noAutomaticRetry: true };
  process.exitCode = 1;
} finally {
  abort();
  await session?.abort();
  await runtime?.shutdown();
  session?.dispose();
  clearTimeout(deadline);
  process.stdin.destroy();
  await rm(cwd, { recursive: true, force: true });
}
emit(summary);
