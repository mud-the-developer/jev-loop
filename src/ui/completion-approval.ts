import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { type Component, Container, matchesKey, ScrollView, SelectList, Text } from "@earendil-works/pi-tui";

export function confirmCompletionApproval(ctx: ExtensionToolContext, message: string, options: { signal: AbortSignal; deadline: number }): Promise<boolean> {
  const { signal, deadline } = options;
  if (signal.aborted || Date.now() >= deadline) return Promise.resolve(false);
  if (ctx.mode !== "tui") {
    const remaining = Math.max(0, deadline - Date.now());
    // Long RPC deadlines rely on the scoped signal, avoiding native timer overflow.
    return ctx.ui.confirm("Approve JEV loop", message, { signal, ...(remaining <= 2_147_483_647 ? { timeout: remaining } : {}) });
  }

  return ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
    const heading = new Text("", 0, 0);
    const details = new ScrollView(new Text(message, 0, 0));
    const choices = new SelectList([{ value: "no", label: "No — cancel" }, { value: "yes", label: "Yes — approve" }], 2, {
      selectedPrefix: value => theme.fg("accent", value), selectedText: value => theme.fg("accent", value),
      description: value => theme.fg("dim", value), scrollInfo: value => theme.fg("dim", value), noMatch: value => theme.fg("dim", value),
    });
    const help = new Text("↑↓ PgUp/PgDn Home/End: scroll\nTab/←→: choice · Enter: select · Esc: cancel", 0, 0);
    const container = new Container();
    let viewportHeight = 0;
    let readable = false;
    let disposed = false;
    const viewport: Component = {
      render(width) {
        const lines = details.render(width);
        details.updateLayout(lines.length, viewportHeight, () => tui.requestRender());
        const visible = lines.slice(details.scrollTop, details.scrollTop + viewportHeight);
        return [...visible, ...Array<string>(Math.max(0, viewportHeight - visible.length)).fill("")];
      },
      invalidate() { details.invalidate(); },
      handleMouse(event) {
        if (event.type !== "wheel") return;
        details.scrollBy(event.wheelDelta ?? 0);
        return { handled: true };
      },
    };
    for (const child of [heading, new Text("", 0, 0), viewport, new Text("", 0, 0), choices, help]) container.addChild(child);

    function bodyHeight(width: number) {
      return tui.terminal.rows - 4 - heading.render(width).length - choices.render(width).length - help.render(width).length;
    }
    function dispose() {
      disposed = true;
      clearInterval(tick);
      signal.removeEventListener("abort", cancel);
    }
    function finish(accepted: boolean) {
      if (disposed) return;
      const allowed = accepted && readable && tui.terminal.columns >= 34 && bodyHeight(tui.terminal.columns - 2) >= 2 && !signal.aborted && Date.now() < deadline;
      dispose();
      done(allowed);
    }
    function cancel() { finish(false); }
    const tick = setInterval(() => { if (Date.now() >= deadline) cancel(); else tui.requestRender(); }, 1_000);
    choices.onSelect = item => finish(item.value === "yes");
    choices.onCancel = cancel;

    const component: Component & { dispose(): void } = {
      render(width) {
        heading.setText(`Approve JEV loop (${Math.max(0, Math.ceil((deadline - Date.now()) / 1_000))}s)`);
        viewportHeight = bodyHeight(Math.max(1, width));
        readable = width >= 32 && viewportHeight >= 2;
        if (!readable) return new Text("Resize terminal to review. Esc cancels.", 0, 0).render(Math.max(1, width)).slice(0, Math.max(0, tui.terminal.rows - 2));
        return container.render(width);
      },
      invalidate() { container.invalidate(); },
      handleInput(data) {
        if (disposed) return;
        if (signal.aborted || Date.now() >= deadline || matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) { cancel(); return; }
        if (matchesKey(data, "tab")) choices.setSelectedIndex(choices.getSelectedItem()?.value === "no" ? 1 : 0);
        else if (matchesKey(data, "left")) choices.setSelectedIndex(0);
        else if (matchesKey(data, "right")) choices.setSelectedIndex(1);
        else if (matchesKey(data, "up")) details.scrollBy(-1);
        else if (matchesKey(data, "down")) details.scrollBy(1);
        else if (matchesKey(data, "pageUp")) details.scrollBy(-Math.max(1, viewportHeight - 1));
        else if (matchesKey(data, "pageDown")) details.scrollBy(Math.max(1, viewportHeight - 1));
        else if (matchesKey(data, "home")) details.scrollToStart();
        else if (matchesKey(data, "end")) details.scrollToEnd();
        else choices.handleInput(data);
        tui.requestRender();
      },
      handleMouse(event) {
        if (disposed) return { handled: true };
        const result = container.handleMouse(event);
        return result ? { ...result, focusTarget: component } : undefined;
      },
      dispose,
    };
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    return component;
  }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", margin: 1 } });
}
