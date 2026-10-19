import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export interface CommandScope {
  current: () => boolean;
  signal: AbortSignal;
}

interface Options {
  pi: ExtensionAPI;
  getStore: () => unknown;
  getGeneration?: () => number;
  isContextCurrent?: (ctx: ExtensionCommandContext) => boolean;
}

export function createCommandGuard(options: Options, onInvalidate?: () => void) {
  let lifecycle = new AbortController();
  const clear = () => {
    lifecycle.abort();
    lifecycle = new AbortController();
    onInvalidate?.();
  };
  options.pi.on("session_start", clear);
  options.pi.on("session_shutdown", clear);
  // Tree navigation retains the session ID and extension instance.
  options.pi.on("session_tree", clear);

  return (ctx: ExtensionCommandContext): CommandScope => {
    const store = options.getStore();
    const generation = options.getGeneration?.();
    const session = ctx.sessionManager.getSessionId();
    const cwd = ctx.cwd;
    const caller = ctx.signal;
    const signal = AbortSignal.any([lifecycle.signal, ...(caller ? [caller] : [])]);
    return {
      signal,
      current: () => {
        try {
          // A store resolver can bind/create state; reject stale context before calling it.
          return !signal.aborted && generation === options.getGeneration?.()
            && session === ctx.sessionManager.getSessionId() && cwd === ctx.cwd && options.isContextCurrent?.(ctx) !== false
            && store === options.getStore();
        } catch { return false; }
      },
    };
  };
}
