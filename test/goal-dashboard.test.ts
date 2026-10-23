import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { GoalDashboard, type GoalDashboardData, goalText, renderGoalSummary } from "../src/ui/goal-dashboard.js";
import { policy } from "./helpers/jev-loop-fixture.js";

const views: GoalDashboard[] = [];
const theme = { fg: (_token: string, text: string) => text, bold: (text: string) => text } as Theme;
beforeEach(() => { initTheme("dark", false); vi.useFakeTimers(); });
afterEach(() => { for (const view of views.splice(0)) view.dispose(); vi.useRealTimers(); });
function setup(count = 1, rows = 40) {
  const store = new LoopStore();
  for (let i = 0; i < count; i++) store.create({ type: "dynamic" }, `Goal ${i + 1} 문서 품질 🙂`, { recurring: true, maxFires: 5, completion: policy, completionCwd: process.cwd(), dynamic: { goal: `Goal ${i + 1}`, iteration: 2 } });
  const abort = new AbortController(); const done = vi.fn(); const render = vi.fn(); let current = true;
  const data: GoalDashboardData = { entries: () => store.list(), pendingGoal: () => undefined, phase: () => undefined,
    storageScope: () => "memory", nextFire: () => undefined, current: () => current, signal: abort.signal };
  const view = new GoalDashboard(data, { terminal: { rows } as any, requestRender: render } as any, theme, done, false); views.push(view);
  return { store, abort, done, render, data, view, invalidate: () => { current = false; } };
}

it.each([48, 80, 120])("bounds native layout at %s columns without mutating goals or implying review execution", width => {
  const h = setup(25); const before = structuredClone(h.store.list()); const lines = h.view.render(width); const content = lines.join("\n");
  expect(lines.length).toBeLessThanOrEqual(36); expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
  expect(content).toContain("#1"); expect(content).toContain("WAITING"); expect(content).toContain("fires"); expect(content).toContain("Esc close");
  expect(content).not.toContain("VERIFYING"); expect(content).not.toContain("WAITING FOR ADVICE"); expect(h.store.list()).toEqual(before);
});

it.each([48, 80, 120])("keeps selected identity, budget and exit visible in a short terminal at %s columns", width => {
  const h = setup(3, 16); const lines = h.view.render(width); const text = lines.join("\n");
  expect(lines.length).toBeLessThanOrEqual(12); expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
  expect(text).toContain("#1"); expect(text).toContain("fires"); expect(text).toContain("Esc close"); expect(text).toContain("Resize");
});
it("does not clip the distinct hard fire ceiling from the narrow editor summary", () => {
  const h = setup(); const fixed = renderGoalSummary(h.store.list(), () => undefined, theme, 48).join("\n");
  expect(fixed).toContain("5 fires");
  const now = Date.now(); const entry = structuredClone(h.store.get("1")!);
  Object.assign(entry, { maxFires: 97, expiresAt: now + 4 * 3600000,
    completion: { ...policy, budgetRange: { minFires: 3, minExpiresIn: "30m" } },
    adaptiveBudget: { startedAt: now, fireLimit: 3, expiresAt: now + 30 * 60000, revision: 0, lastReviewedFireCount: 0 } });
  expect(renderGoalSummary([entry], () => undefined, theme, 48).join("\n")).toMatch(/\b97\b/);
});

it.each([48, 80, 120])("keeps adaptive counts and both time limits on distinct readable rows at %s columns", width => {
  const now = Date.now();
  for (const rows of [16, 40]) {
    const h = setup(1, rows); const entry = structuredClone(h.store.get("1")!);
    Object.assign(entry, { fireCount: 1, maxFires: 30, expiresAt: now + 4 * 3600000,
      completion: { ...policy, budgetRange: { minFires: 3, minExpiresIn: "30m" } },
      adaptiveBudget: { startedAt: now, fireLimit: 3, expiresAt: now + 30 * 60000, revision: 0, lastReviewedFireCount: 0 } });
    h.data.entries = () => [entry]; const before = structuredClone(entry);
    for (const lines of [h.view.render(width), renderGoalSummary([entry], () => undefined, theme, width, now)]) {
      expect(lines.every(line => visibleWidth(line) <= width)).toBe(true);
      const fires = lines.find(line => line.includes("Fires")); const time = lines.find(line => line.includes("Time"));
      expect(fires).toContain("1 used / 3 run"); expect(fires).toContain("30 hard");
      expect(time).toContain("30m 0s run"); expect(time).toContain("4h 0m hard");
      expect(fires).not.toBe(time);
    }
    expect(h.view.render(width).join("\n")).toContain("Esc close"); expect(entry).toEqual(before);
  }
});

it("emphasizes the actual budget values instead of dimming the whole summary", () => {
  vi.stubEnv("TERM", "xterm-256color"); vi.stubEnv("NO_COLOR", "");
  try {
    const h = setup(); const bold = { ...theme, bold: (value: string) => `\u001b[1m${value}\u001b[22m` } as Theme;
    const lines = renderGoalSummary(h.store.list(), () => undefined, bold, 48);
    expect(lines.find(line => line.includes("Fires"))).toContain("\u001b[1m0 used / 5 fires\u001b[22m");
  } finally { vi.unstubAllEnvs(); }
});

it("NO_COLOR removes styling from list, panels and compact summary", () => {
  vi.stubEnv("NO_COLOR", "1");
  try {
    const h = setup(); const painted = { fg: (_token: string, text: string) => `\u001b[31m${text}\u001b[0m`, bold: (text: string) => text } as Theme;
    expect(h.view.render(80).join("\n")).not.toContain("\u001b");
    expect(renderGoalSummary(h.store.list(), () => undefined, painted, 80).join("\n")).not.toContain("\u001b");
  } finally { vi.unstubAllEnvs(); }
});
it("shows a persisted reservation as unobserved, not running", () => {
  const h = setup(); const entry = h.store.get("1")!;
  h.store.reserveCompletionReview("1", JSON.stringify(entry), { id: "reservation", expiresAt: Date.now() + 60000 });
  const text = h.view.render(120).join("\n"); expect(text).toContain("reservation"); expect(text).toContain("unobserved"); expect(text).not.toContain("RUNNING");
});
it("selects another goal with the native list and focuses/scrolls details", () => {
  const h = setup(3); h.view.render(120); h.view.handleInput("\u001b[B"); h.view.render(120); h.view.handleInput("x");
  expect(h.done).toHaveBeenCalledWith(expect.objectContaining({ type: "cancel", entry: expect.objectContaining({ id: "2" }) }));
  expect(h.store.list()).toHaveLength(3); expect(vi.getTimerCount()).toBe(0);
});
it("keeps start intent and escape read-only, and abort closes a stale view", () => {
  const h = setup(0); expect(h.view.render(48).join("\n")).toContain("Ready for"); h.view.handleInput("g"); expect(h.done).toHaveBeenCalledWith({ type: "start" });
  const next = setup(); next.view.render(80); next.abort.abort(); next.view.handleInput("x");
  expect(next.done).toHaveBeenCalledTimes(1); expect(next.done).toHaveBeenCalledWith({ type: "close" }); expect(next.store.list()).toHaveLength(1);
});
it("motion off produces stable frames and leaves no view timer after close", () => {
  const h = setup(); const now = Date.now(); const before = h.view.render(80);
  vi.advanceTimersByTime(3000); vi.setSystemTime(now); expect(h.view.render(80)).toEqual(before);
  h.view.handleInput("m"); h.view.handleInput("m"); h.view.handleInput("\u001b"); expect(h.done).toHaveBeenCalledWith({ type: "close" });
  expect(vi.getTimerCount()).toBe(0); const calls = h.render.mock.calls.length; vi.advanceTimersByTime(3000); expect(h.render).toHaveBeenCalledTimes(calls);
});
it("removes terminal and bidi controls from untrusted display text", () => {
  expect(goalText("\u001b[31mGoal\u001b[0m\u202e\n title")).toBe("Goal title");
  const h = setup(); h.store.get("1")!.prompt = "\u001b]52;c;payload\u0007No clipboard\u202e";
  expect(h.view.render(80).join("\n")).not.toContain("payload");
});
it("summary uses actual phase only, never a success percentage or persisted grant", () => {
  const h = setup(); const text = renderGoalSummary(h.store.list(), () => "verification", theme, 48).join("\n");
  expect(text).toContain("VERIFYING"); expect(text).toContain("fires"); expect(text).not.toContain("%"); expect(text).not.toContain("approved");
});
