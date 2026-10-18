import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { vi } from "vitest";
import { LoopStore } from "../../src/store.js";
import { registerLoopTools } from "../../src/tools/loop-tools.js";

export const policy = {
  goal: "Make the checks pass",
  criteria: ["All required checks pass", "The observed behavior matches the requested behavior"],
  verification: { command: "/local/private/verifier", args: ["--private-argument"], description: "Checks required behavior and regressions" },
};
export const evidence = "The required behavior was exercised and all checks passed.";
export const candidates = [
  { id: "met", title: "All criteria met", description: "Every criterion is supported by adequate evidence and the required verification passed." },
  { id: "unmet", title: "Criteria unmet", description: "At least one criterion is demonstrably unmet or required verification failed." },
  { id: "unknown", title: "Insufficient evidence", description: "Evidence is missing, conflicting, or inadequate for any criterion. Exit zero alone proves no extra facts." },
];
export function recommendation(choice = "met") {
  return {
    status: "recommended", advisoryOnly: true,
    option: candidates.find(option => option.id === choice),
    reply: { choice, confidence: 0.8, probabilities: Object.fromEntries(candidates.map(option => [option.id, option.id === choice ? 0.8 : 0.1])), model: "fixture", usage: { inputTokens: 1, outputTokens: 1 } },
  };
}
export function outcome(details: unknown, isError = false) {
  return { result: { content: [{ type: "text" as const, text: JSON.stringify(details) }], details }, isError };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
export function fixture(path?: string) {
  let store = new LoopStore(path);
  const toolMap = new Map<string, ToolDefinition<any>>();
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const exec = vi.fn(async (_command: string, _args: string[], _options?: any) => ({ code: 0, killed: false, stdout: "PRIVATE RAW OUTPUT", stderr: "PRIVATE ERROR" }));
  const confirm = vi.fn(async (..._args: any[]) => true);
  const executeTool = vi.fn(async (..._args: any[]) => outcome(recommendation()));
  const ctx = {
    cwd: "/private/workspace", hasUI: true,
    sessionManager: { getSessionId: () => "fixture-session" },
    ui: { confirm }, executeTool, tools: [{ name: "jev_decide" }],
  } as unknown as ExtensionToolContext;
  const pi = {
    registerTool: (tool: ToolDefinition<any>) => toolMap.set(tool.name, tool), exec,
    getAllTools: () => ctx.tools,
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
  } as unknown as ExtensionAPI;
  const trigger = { add: vi.fn(), remove: vi.fn() };
  const activate = vi.fn();
  registerLoopTools({ pi, getStore: () => store, getTriggerSystem: () => trigger,
    getScheduler: () => ({ nextFire: () => undefined }), getMonitorManager: () => ({ get: () => undefined }),
    updateWidget: vi.fn(), maybeBootstrapTaskLoop: async () => false, isTaskSystemReady: () => true,
    onDynamicLoopActivated: activate, verify: exec });
  const call = (name: string, args: any, signal?: AbortSignal) => toolMap.get(name)!.execute("fixture", args, signal, undefined, ctx);
  return {
    get store() { return store; }, replaceStore: (next: LoopStore) => { store = next; },
    pi, ctx, toolMap, exec, confirm, executeTool, trigger, activate, call,
    create: (extra: Record<string, unknown> = {}, signal?: AbortSignal) => call("LoopCreate", { trigger: "idle", triggerType: "idle", prompt: "원래 사용자 요청", completion: structuredClone(policy), maxFires: 3, expiresIn: "1h", ...extra }, signal),
    complete: (extra: Record<string, unknown> = {}, signal?: AbortSignal) => call("LoopUpdate", { id: "1", status: "completed", completionEvidence: evidence, ...extra }, signal),
    shutdown: async () => { for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx); },
  };
}
export function text(result: { content: unknown[] }): string {
  return result.content.map(block => (block as { text?: string }).text ?? "").join("\n");
}
