import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { readJevCapabilities } from "../src/jev-recipient.js";
import { LoopStore } from "../src/store.js";
import { registerLoopTools } from "../src/tools/loop-tools.js";

// Synthetic local metadata/UI denial, actual SDK nested dispatch. No credentials, service or positive grant.
it.skipIf(process.platform === "win32").each([false, true])("retains SDK outcome and host-deny boundaries before a controlled native decline (blocked=%s)", async blocked => {
  const cwd = mkdtempSync(join(tmpdir(), "jev-full-sdk-abi-")), store = new LoopStore(join(cwd, "loops.json"));
  const manager = SessionManager.create(cwd, join(cwd, "sessions")), select = vi.fn(async () => "No — cancel");
  const info = { kind: "jev_capabilities", protocolVersion: 2, recipientInvalidationEvent: "jev:recipient:invalidated", available: true,
    recipient: "sdk-current", fencedDecision: true, delegationFencing: false, grantsAuthority: false, liveVerified: false };
  const cap = vi.fn(async () => ({ content: [{ type: "text" as const, text: JSON.stringify(info) }], details: info }));
  const decide = vi.fn(async () => { throw new Error("No public decision permitted in this offline diagnostic"); });
  const observations: unknown[] = []; let runtime: ReturnType<typeof registerLoopTools> | undefined;
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [pi => {
      pi.on("tool_call", event => event.toolName === "jev_capabilities" && blocked ? { block: true, reason: "Offline SDK fixture host deny" } : undefined);
      runtime = registerLoopTools({ pi, getStore: () => store, getStorageScope: () => "session", getGeneration: () => 0, isContextCurrent: () => true,
        getTriggerSystem: () => ({ add() {}, remove() {} }), getScheduler: () => ({ nextFire: () => undefined }), getMonitorManager: () => ({ get: () => undefined }),
        updateWidget() {}, maybeBootstrapTaskLoop: async () => false, isTaskSystemReady: () => true });
      pi.registerTool({ name: "jev_capabilities", label: "Offline capability", description: "Controlled local protocol metadata", parameters: Type.Object({}), execute: cap });
      pi.registerTool({ name: "jev_decide", label: "Forbidden decision", description: "No service call permitted", parameters: Type.Object({}), execute: decide });
      pi.registerTool({ name: "ProbeFull", label: "SDK ABI probe", description: "Read actual nested outcome then reach a synthetic No only", parameters: Type.Object({}),
        async execute(_id, _input, signal, _update, ctx) {
          const metadata = await ctx.executeTool("jev_capabilities", {}, { signal }); observations.push(readJevCapabilities(metadata));
          const result = await ctx.executeTool("LoopAccess", { action: "full", maxFires: 3, expiresIn: "5m" }, { signal }); return result.result;
        } });
    }] });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await resourceLoader.reload(); expect(resourceLoader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: join(cwd, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
    await modelRuntime.setRuntimeApiKey("openai", "synthetic-no-network"); const model = modelRuntime.getModel("openai", "gpt-4o-mini")!;
    ({ session } = await createAgentSession({ cwd, agentDir: cwd, resourceLoader, modelRuntime, model, settingsManager, sessionManager: manager, noTools: "builtin" }));
    await session.bindExtensions({ mode: "rpc", uiContext: { select, notify() {}, setStatus() {}, setWidget() {} } as any });
    let phase = 0; session.agent.streamFunction = () => {
      const active = phase++ === 0; const message: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: active ? "toolUse" : "stop",
        content: active ? [{ type: "toolCall", id: "offline-sdk-probe", name: "ProbeFull", arguments: {} }] : [{ type: "text", text: "Offline diagnostic ended." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const stream = createAssistantMessageEventStream(); stream.push({ type: "start", partial: message }); stream.push({ type: "done", reason: active ? "toolUse" : "stop", message }); stream.end(message); return stream;
    };
    let settle!: () => void; const settled = new Promise<void>(resolve => { settle = resolve; }); const off = session.subscribe(event => { if (event.type === "agent_settled") settle(); });
    try { await session.prompt("Run only the offline nested metadata ABI diagnostic."); await settled; } finally { off(); }
    expect(observations).toEqual(blocked ? [] : [info]); expect(select).toHaveBeenCalledTimes(blocked ? 0 : 1); expect(cap).toHaveBeenCalledTimes(blocked ? 0 : 2); expect(decide).not.toHaveBeenCalled();
    expect(runtime!.getAccessStatus({ cwd, hasUI: true, sessionManager: manager } as any)?.phase).toBe("reviewed"); expect(store.list()).toEqual([]);
  } finally { await session?.abort(); await runtime?.shutdown(); session?.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});
