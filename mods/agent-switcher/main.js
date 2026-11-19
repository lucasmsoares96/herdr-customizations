// Ctrl+Tab switcher, as in Firefox: opened by my-tabs with props { list, at } (agent
// addresses, most recent first). While Ctrl is held, Tab / Shift+Tab only move the
// highlight; releasing Ctrl shows the highlighted agent. Esc cancels, a click picks.
// Steps that arrive as key bindings come through shared "agent-switcher.step".

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, agents, run, shared, setShared } from "herdr";

const STATUS = { working: "working", blocked: "blocked", done: "done", idle: "idle" };

export default class AgentSwitcher extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.list = p.list ?? [];
    this.at = Math.min(p.at ?? 1, Math.max(0, this.list.length - 1));
    this.seenStep = shared("agent-switcher.step")?.seq ?? 0;
    this.done = false;
    this.handle = cx.focus_handle();
    this.handle.focus();
    setShared("agent-switcher.open", p.overlay ?? true);
  }

  move(dir) {
    const n = this.list.length;
    if (n) this.at = (this.at + dir + n) % n;
  }

  finish(pick) {
    if (this.done) return;
    this.done = true;
    setShared("agent-switcher.open", null);
    closeOverlay(props().overlay);
    if (!pick) return;
    const a = agents().find((x) => x.address === this.list[this.at]);
    if (a?.pane) run("pane.focus", { pane: a.pane });
  }

  async close() {
    if (!this.done) setShared("agent-switcher.open", null);
  }

  render(cx) {
    // Steps sent by the Ctrl+Tab binding while this is open.
    const step = shared("agent-switcher.step");
    if (step && step.seq > this.seenStep) {
      // The same Tab may also reach on_key_down below: count it once.
      if (Date.now() - (this.localAt ?? 0) > 150) {
        for (let s = this.seenStep + 1; s <= step.seq; s++) this.move(step.dirs?.[s] ?? 1);
        this.sharedAt = Date.now();
      }
      this.seenStep = step.seq;
    }
    const t = theme();
    const byAddress = Object.fromEntries(agents().map((a) => [a.address, a]));
    const rows = this.list.map((address) => byAddress[address]).filter(Boolean);
    return v_flex().id("agent-switcher").track_focus(this.handle).size_full().p(6).gap(2).bg(t.popover).text_size(13)
      .on_modifiers_changed((e, cx) => { if (!e.modifiers.control) this.finish(true); })
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); return this.finish(false); }
        if (e.key === "enter") { cx.stop_propagation(); return this.finish(true); }
        if (e.key === "tab") {
          if (Date.now() - (this.sharedAt ?? 0) > 150) { this.move(e.modifiers.shift ? -1 : 1); this.localAt = Date.now(); }
          cx.stop_propagation(); cx.notify();
        }
        else if (e.key === "down" || e.key === "up") { this.move(e.key === "down" ? 1 : -1); cx.stop_propagation(); cx.notify(); }
      })
      .children(rows.map((a, i) => {
        const on = i === this.at;
        const prog = a.program;
        const name = a.pane_name || (a.title || "").replace(/^[^\p{L}\p{N}]+/u, "").trim() || prog?.name || a.address;
        return h_flex().id(`as-${a.address}`).h(40).flex_none().px(10).gap(10).items_center().rounded(8)
          .bg(on ? t.selected : t.popover).hover((s) => s.bg(on ? t.selected : t.hover))
          .on_click(() => { this.at = i; this.finish(true); })
          .child(prog?.icon ? (prog.tint ? svg(prog.icon).size(16).flex_none().text_color(t.muted) : image(prog.icon).size(16).flex_none()) : div().size(16).flex_none())
          .child(v_flex().flex_1().min_w(0)
            .child(div().truncate().text_color(t.foreground).child(name))
            .child(div().truncate().text_size(11).text_color(t.dim).child(`${a.space_name} · ${a.tab_name || `tab ${a.tab_index + 1}`}`)))
          .child(div().size(7).flex_none().rounded(4).bg(t[STATUS[a.status]] ?? t.unknown));
      }))
      .when(!rows.length, (el) => el.child(div().p(10).text_color(t.dim).child("No agents")));
  }
}
