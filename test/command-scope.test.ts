import { expect, it, vi } from "vitest";
import { createCommandGuard } from "../src/commands/command-scope.js";
import { createCtx, createMockPi } from "./helpers/mock-pi.js";

it.each(["generation", "cwd", "session", "context", "abort"])("an invalid %s is rejected before resolving another store", boundary => {
  const { pi } = createMockPi(); const store = {}; const getStore = vi.fn(() => store);
  let generation = 0; let session = "first"; let current = true;
  const abort = new AbortController(); const ctx = { ...createCtx(), signal: abort.signal, sessionManager: { getSessionId: () => session } };
  const capture = createCommandGuard({ pi, getStore, getGeneration: () => generation, isContextCurrent: () => current });
  const scope = capture(ctx as any); expect(scope.current()).toBe(true); getStore.mockClear();
  if (boundary === "generation") generation++;
  else if (boundary === "cwd") ctx.cwd += "/new-context";
  else if (boundary === "session") session = "second";
  else if (boundary === "context") current = false;
  else abort.abort();
  expect(scope.current()).toBe(false); expect(getStore).not.toHaveBeenCalled();
});
