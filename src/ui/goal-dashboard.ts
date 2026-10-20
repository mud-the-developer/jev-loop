import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, type TUI, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { CompletionReviewPhase } from "../runtime/jev-loop-runtime.js";
import type { LoopStorageScope } from "../runtime/scope.js";
import type { LoopEntry } from "../types.js";
import { formatLoopLifecycle } from "./lifecycle-presentation.js";

type DashboardTheme = Pick<Theme, "fg" | "bold">;
function displayTheme(theme: DashboardTheme): DashboardTheme {
  return process.env.NO_COLOR || process.env.TERM === "dumb" ? { fg: (_token, text) => text, bold: text => text } : theme;
}

export type GoalDashboardAction = { type: "close" } | { type: "start" } | { type: "cancel"; entry: LoopEntry };
export interface GoalDashboardData {
  entries: () => LoopEntry[];
  pendingGoal: () => string | undefined;
  phase: (entry: LoopEntry) => CompletionReviewPhase | undefined;
  storageScope: () => LoopStorageScope;
  nextFire: (id: string) => number | undefined;
  current: () => boolean;
  signal: AbortSignal;
}
export function goalText(value: string): string {
  return stripVTControlCharacters(value).replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
}
function stateLabel(entry: LoopEntry, phase: CompletionReviewPhase | undefined, now: number): string {
  if (now >= entry.expiresAt) return "EXPIRED";
  if (phase === "verification") return "VERIFYING";
  if (phase === "advice") return "JEV ADVICE";
  if (phase === "approval") return "APPROVAL";
  if (phase) return "REVIEW";
  if (entry.status === "paused") return entry.pause?.kind === "controller_limit" ? "FIRE CAP" : "PAUSED";
  return entry.dynamic?.awaitingUpdate ? "AWAITING UPDATE" : "WAITING";
}
function identity(entry: LoopEntry): string { return `${entry.id}:${entry.completionId}:${entry.createdAt}`; }
function remaining(entry: LoopEntry, now: number): string {
  const seconds = Math.max(0, Math.ceil((entry.expiresAt - now) / 1000));
  return seconds >= 3600 ? `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function tone(entry: LoopEntry, phase?: CompletionReviewPhase) { return entry.status === "paused" ? "warning" : phase ? "accent" : "muted"; }

export function renderGoalSummary(entries: LoopEntry[], phase: GoalDashboardData["phase"], theme: DashboardTheme, width: number, now = Date.now()): string[] {
  if (!entries.length) return [];
  theme = displayTheme(theme);
  const entry = entries.find(item => phase(item)) ?? entries[0]!;
  const local = phase(entry);
  return [
    theme.fg("accent", theme.bold(`◆ JEV LOOP  ·  ${entries.length} ${entries.length === 1 ? "goal" : "goals"}`)),
    theme.fg(tone(entry, local), truncateToWidth(`#${entry.id} ${stateLabel(entry, local, now)} · ${entry.fireCount ?? 0}/${entry.maxFires} fires · ${remaining(entry, now)} left`, width)),
    theme.fg("muted", truncateToWidth(`${goalText(entry.prompt)}  ·  /jev-loop to inspect`, width)),
  ].map(line => truncateToWidth(line, width));
}

export class GoalDashboard {
  private list: SelectList | undefined;
  private signature = "";
  private selectedKey: string | undefined;
  private renderedEntries: LoopEntry[] = [];
  private detailFocus = false;
  private scroll = 0;
  private frame = 0;
  private motion: boolean;
  private timer: ReturnType<typeof setInterval> | undefined;
  private disposed = false;
  private readonly abort = () => this.finish({ type: "close" });

  constructor(private data: GoalDashboardData, private tui: Pick<TUI, "terminal" | "requestRender">, private theme: DashboardTheme,
    private done: (action: GoalDashboardAction) => void, motion = !process.env.NO_COLOR && process.env.TERM !== "dumb") {
    this.motion = motion;
    this.theme = displayTheme(this.theme);
    data.signal.addEventListener("abort", this.abort, { once: true });
    if (data.signal.aborted || !data.current()) this.finish({ type: "close" });
    else this.refreshTimer();
  }
  private refreshTimer() {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      if (!this.data.current()) { this.finish({ type: "close" }); return; }
      if (this.motion) this.frame++;
      this.tui.requestRender();
    }, this.motion ? 120 : 1000);
    this.timer.unref?.();
  }
  private finish(action: GoalDashboardAction) {
    if (this.disposed) return;
    this.dispose(); this.done(action);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.data.signal.removeEventListener("abort", this.abort);
  }
  invalidate() { this.list?.invalidate(); }
  private selected(): LoopEntry | undefined { return this.renderedEntries.find(entry => identity(entry) === this.selectedKey); }
  private syncList(maxVisible: number) {
    const entries = this.data.entries().filter(entry => entry.completion);
    const items = entries.map(entry => ({ value: identity(entry), label: `#${entry.id} ${goalText(entry.prompt)}`,
      description: stateLabel(entry, this.data.phase(entry), Date.now()) }));
    const signature = JSON.stringify([maxVisible, items]);
    if (signature !== this.signature) {
      this.signature = signature;
      this.list = new SelectList(items, maxVisible, {
        selectedPrefix: text => this.theme.fg("accent", text), selectedText: text => this.theme.fg("accent", text),
        description: text => this.theme.fg("muted", text), scrollInfo: text => this.theme.fg("dim", text), noMatch: text => this.theme.fg("muted", text),
      });
      const index = items.findIndex(item => item.value === this.selectedKey);
      this.list.setSelectedIndex(Math.max(0, index));
      this.selectedKey = this.list.getSelectedItem()?.value;
      this.list.onSelectionChange = item => { this.selectedKey = item.value; this.scroll = 0; };
    }
    // Keep the observed creation identity for actions, not a later ID-only lookup.
    this.renderedEntries = structuredClone(entries);
  }
  private panel(label: string, lines: string[], width: number, focused = false): string[] {
    const inside = Math.max(1, width - 4);
    const border = (text: string) => this.theme.fg(focused ? "accent" : "border", text);
    const title = truncateToWidth(` ${focused ? "▸ " : ""}${label} `, Math.max(1, width - 2));
    const pad = (line: string) => line + " ".repeat(Math.max(0, inside - visibleWidth(line)));
    return [border(`╭${title}${"─".repeat(Math.max(0, width - 2 - visibleWidth(title)))}╮`),
      ...lines.map(line => border("│ ") + pad(truncateToWidth(line, inside)) + border(" │")), border(`╰${"─".repeat(Math.max(0, width - 2))}╯`)];
  }
  private details(entry: LoopEntry, width: number, rows: number): string[] {
    const phase = this.data.phase(entry); const now = Date.now();
    const status = this.theme.fg(tone(entry, phase), this.theme.bold(`#${entry.id}  ${stateLabel(entry, phase, now)}`));
    const title = wrapTextWithAnsi(this.theme.bold(goalText(entry.prompt)), width).slice(0, 2);
    const budget = `${entry.fireCount ?? 0}/${entry.maxFires} fires (accounted) · ${remaining(entry, now)} left`;
    const tree = [
      "┌ Saved policy · not persisted execution authority",
      `├ Progress · iteration ${entry.dynamic?.iteration ?? 0}${entry.dynamic?.awaitingUpdate ? "; awaiting update" : "; next fire not reported as delivered"}`,
      `├ Fixed check · ${phase === "verification" ? "RUNNING (local observation)" : phase === "advice" ? "passed for this review" : "execution not observed"}`,
      `└ JEV · ${phase === "advice" ? "WAITING FOR ADVICE (local request)" : "request not observed"}`,
      ...(entry.completionReview && !phase ? ["◇ Review reservation exists; execution is unobserved."] : []),
      "", this.theme.bold("ACCEPTANCE CRITERIA"), ...entry.completion!.criteria.map((criterion, index) => `${index + 1}. ${goalText(criterion)}`),
      "", this.theme.bold("VERIFIER COVERAGE"), goalText(entry.completion!.verification.description),
      "", this.theme.bold("RECOVERY & AUTHORITY"), ...formatLoopLifecycle(entry, { storageScope: this.data.storageScope(), nextFireAt: this.data.nextFire(entry.id), now }).map(goalText),
    ].flatMap(line => wrapTextWithAnsi(line, width));
    const available = Math.max(1, rows - 3 - title.length); this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, tree.length - available)));
    return [status, ...title, truncateToWidth(budget, width), this.theme.fg("dim", `DETAIL ${this.scroll + 1}–${Math.min(tree.length, this.scroll + available)}/${tree.length} · Tab to focus`),
      ...tree.slice(this.scroll, this.scroll + available)];
  }
  render(width: number): string[] {
    if (this.disposed || !this.data.current()) return [];
    const height = Math.max(8, Math.min(34, this.tui.terminal.rows - 4));
    const wide = width >= 100; const bodyRows = height - 6; const listRows = wide ? bodyRows - 2 : Math.min(3, Math.max(1, Math.floor(bodyRows / 3)));
    this.syncList(Math.max(1, listRows));
    const header = this.theme.fg("accent", this.theme.bold("◆ JEV LOOP  /  MISSION CONTROL"));
    const phase = this.selected() && this.data.phase(this.selected()!);
    const pulse = this.motion && phase ? ["◐", "◓", "◑", "◒"][this.frame % 4] : "◇";
    const pending = this.data.pendingGoal();
    const lead = pending ? `SETUP WAITING FOR IDLE · ${goalText(pending)}` : `${this.renderedEntries.length} goal(s) · ${pulse} ${phase ? "local review observed" : "no local review observed"}`;
    const selected = this.selected();
    if (height < 18) {
      return [header, this.theme.fg("muted", truncateToWidth(lead, width)),
        selected ? `▸ #${selected.id} ${stateLabel(selected, this.data.phase(selected), Date.now())}` : "No JEV controllers",
        selected ? `${selected.fireCount ?? 0}/${selected.maxFires} fires · ${remaining(selected, Date.now())} left` : "g prepares a goal, not approval",
        selected ? goalText(selected.prompt) : "Ready for your next goal",
        "Resize for criteria & recovery", "↑↓ select · g start · x cancel", `Esc close · m motion ${this.motion ? "on" : "off"}`]
        .map(line => truncateToWidth(line, width));
    }
    let body: string[];
    const empty = [this.theme.bold("Ready for your next goal"), "No JEV controllers exist.", "Press g to prepare a goal; native setup approval still applies."];
    if (!selected) body = this.panel("GOALS", empty.flatMap(line => wrapTextWithAnsi(line, Math.max(1, width - 4))), width, true);
    else if (wide) {
      const leftWidth = Math.floor((width - 1) * 0.36); const rightWidth = width - leftWidth - 1;
      const left = this.panel("GOALS · ↑↓ select", this.list!.render(leftWidth - 4), leftWidth, !this.detailFocus);
      const right = this.panel("SELECTED GOAL", this.details(selected, rightWidth - 4, bodyRows - 2), rightWidth, this.detailFocus);
      body = Array.from({ length: Math.max(left.length, right.length) }, (_, i) => (left[i] ?? "") + " ".repeat(Math.max(0, leftWidth - visibleWidth(left[i] ?? ""))) + " " + (right[i] ?? ""));
    } else {
      const list = this.panel("GOALS · ↑↓ select", this.list!.render(width - 4).slice(0, listRows), width, !this.detailFocus);
      const remaining = Math.max(4, bodyRows - list.length);
      body = [...list, ...this.panel("SELECTED GOAL", this.details(selected, width - 4, remaining - 2), width, this.detailFocus)];
    }
    const help = ["Esc close · g start · x cancel", "↑↓ move/scroll · Tab focus · PgUp/PgDn"].flatMap(line => wrapTextWithAnsi(line, width));
    const motion = this.theme.fg("dim", `r refresh · m motion ${this.motion ? "on" : "off"} · read-only`);
    const reserved = 3 + help.length + 1;
    return [header, this.theme.fg("muted", truncateToWidth(lead, width)), "", ...body.slice(0, Math.max(1, height - reserved)), ...help.map(line => this.theme.fg("muted", line)), motion]
      .map(line => truncateToWidth(line, width));
  }
  handleInput(data: string) {
    if (this.disposed || !this.data.current()) { this.finish({ type: "close" }); return; }
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { this.finish({ type: "close" }); return; }
    if (data === "m") { this.motion = !this.motion; this.refreshTimer(); }
    else if (data === "g") { this.finish({ type: "start" }); return; }
    else if (data === "x") { const entry = this.selected(); if (entry) this.finish({ type: "cancel", entry }); return; }
    else if (matchesKey(data, Key.tab) || matchesKey(data, Key.enter)) this.detailFocus = !this.detailFocus;
    else if (this.detailFocus) {
      if (matchesKey(data, Key.down)) this.scroll++;
      else if (matchesKey(data, Key.up)) this.scroll--;
      else if (matchesKey(data, Key.pageDown)) this.scroll += 5;
      else if (matchesKey(data, Key.pageUp)) this.scroll -= 5;
    } else this.list?.handleInput(data);
    this.tui.requestRender();
  }
}

export function showGoalDashboard(ctx: ExtensionCommandContext, data: GoalDashboardData): Promise<GoalDashboardAction> {
  return ctx.ui.custom<GoalDashboardAction>((tui, theme, _keys, done) => new GoalDashboard(data, tui, theme, done),
    { overlay: true, overlayOptions: { width: "95%", maxHeight: "95%", anchor: "center", margin: 1 } });
}
