// The diff of the file picked in the Changes panel (my-changes), shown as a tab in
// the main area. What to show comes through shared "changes.diff":
// { root, on, path, status, fresh, hasHead, commit: { sha, short, subject } | null, at }.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list } from "gpui-base";
import { exec, readTextFile, theme, settings, shared, checking } from "herdr";

const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const MAX_LINES = 20000;
const ROW = 20;

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd((s.length - 1) - (s.length - 1) % 4 + 4));

// Each diff line with its old and new line numbers, so a frame draws only what's on screen.
function diffRows(lines) {
  let old = 0, next = 0;
  return lines.map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; return { kind: "@", text: line }; }
    const kind = line[0], text = untab(line.slice(1)) || " ";
    if (kind === "-") return { kind, a: old++, text };
    if (kind === "+") return { kind, b: next++, text };
    if (kind === " ") return { kind, a: old++, b: next++, text };
    return { kind: "", text: line };
  });
}

export default class DiffView extends View {
  init(_props, cx) {
    this.rows = []; this.width = 0; this.message = null; this.shown = null;
    if (checking()) return;
    // A working-tree diff follows edits while it is open.
    cx.timer.every(4000, (cx) => { const d = shared("changes.diff"); if (d && !d.commit && !d.gone) this.load(d, cx); });
  }

  load(d, cx) {
    const at = d.at;
    cx.spawn(async (cx) => {
      let lines, message = null;
      try {
        if (d.gone) message = "This file has no uncommitted changes anymore.";
        else if (d.commit) {
          const r = await exec("git", [...READ, "show", "--format=", "--diff-merges=first-parent", "--no-ext-diff", "--no-textconv", "--no-color", d.commit.sha, "--", d.path], { cwd: d.root, on: d.on });
          if (r.code !== 0) throw new Error(r.stderr);
          lines = this.hunks(r.stdout);
          if (!lines.length) message = /Binary files/.test(r.stdout) ? "Binary file changed" : "No text changes";
        } else if (d.fresh || (!d.hasHead && d.status === "A")) {
          const text = await readTextFile(`${d.root}/${d.path}`, { on: d.on }).catch(() => null);
          if (text === null) message = "Cannot preview this file (binary, too large, or unreadable)";
          else if (text.includes("\0")) message = "Binary file";
          else {
            const body = text.replace(/\n$/, "").split("\n");
            lines = [`@@ -0,0 +1,${body.length} @@`, ...body.map((l) => `+${l}`)];
          }
        } else {
          const r = await exec("git", [...READ, "diff", ...(d.hasHead ? ["HEAD"] : []), "--no-ext-diff", "--no-textconv", "--no-color", "--", d.path], { cwd: d.root, on: d.on });
          if (r.code !== 0) throw new Error(r.stderr);
          lines = this.hunks(r.stdout);
          if (!lines.length) message = /Binary files/.test(r.stdout) ? "Binary file changed" : "No text changes";
        }
      } catch (e) { message = `Cannot show this diff: ${String(e.message ?? e).trim()}`; }
      if (shared("changes.diff")?.at !== at) return; // another file was picked meanwhile
      this.message = message;
      const all = lines ?? [];
      this.limited = all.length > MAX_LINES;
      this.rows = diffRows(all.slice(0, MAX_LINES).map((l) => (l.length > 4000 ? l.slice(0, 4000) + "… (line truncated)" : l)));
      this.width = Math.max(300, ...this.rows.map((r) => (r.text.length + 1) * 7.3 + 110));
      cx.notify();
    });
  }

  hunks(out) {
    const all = out.replace(/\n$/, "").split("\n"), first = all.findIndex((l) => l.startsWith("@@"));
    return first < 0 ? [] : all.slice(first).filter((l) => !l.startsWith("\\ No newline"));
  }

  row({ kind, a, b, text }, t) {
    if (kind === "@") return h_flex().w_full().h(ROW).flex_none().px(12).items_center().bg(t.raised).text_color(t.dim).child(div().truncate().child(text));
    const num = (n) => div().w(44).flex_none().pr(8).text_right().text_color(t.dim).child(n === undefined ? "" : String(n));
    return h_flex().w_full().h(ROW).flex_none().items_center()
      .when(kind === "+", (e) => e.bg(t.ansi2 + "1f")).when(kind === "-", (e) => e.bg(t.ansi1 + "1f"))
      .child(num(a)).child(num(b))
      .child(div().w(14).flex_none().text_color(kind === "+" ? t.ansi2 : kind === "-" ? t.ansi1 : t.dim).child(kind === " " ? "" : kind))
      .child(div().flex_1().min_w(0).child(text));
  }

  render(cx) {
    const d = shared("changes.diff");
    if (!checking() && d && d.at !== this.shown) { this.shown = d.at; this.rows = []; this.message = null; this.load(d, cx); }
    const t = theme();
    if (!d) return v_flex().size_full().items_center().justify_center().bg(t.background).text_color(t.dim).text_size(13)
      .child("Pick a file in the Changes panel to see its diff here.");
    const parts = d.path.split("/"), name = parts.pop();
    const color = d.status === "A" ? t.ansi2 : d.status === "D" || d.status === "U" ? t.ansi1 : t.blocked;
    return v_flex().id("diff-view").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_none().text_size(11).text_color(color).child(d.status))
        .child(div().flex_none().font_semibold().child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(parts.join("/")))
        .when(d.add > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`+${d.add}`)))
        .when(d.del > 0, (e) => e.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`−${d.del}`)))
        .child(div().flex_none().max_w(320).truncate().px(6).h(20).flex().items_center().rounded(4).border_1().border_color(t.border)
          .text_size(11).text_color(t.muted)
          .child(d.commit ? `${d.commit.short} · ${d.commit.subject}` : "Working tree")))
      .when(Boolean(this.message), (el) => el.child(div().p(16).text_color(t.dim).child(this.message)))
      .when(!this.message, (el) => el.child(div().flex_1().min_h(0).relative().font_family(settings().font_family ?? "JetBrains Mono").text_size(12)
        .child(div().id("diff-x").size_full().overflow_x_scrollbar()
          .child(div().w_full().min_w(this.width).h_full().child(v_virtual_list("diff-rows", this.rows.length, ROW, (i) => String(i),
            (range) => this.rows.slice(range.start, range.end).map((r) => this.row(r, t))).size_full())))
        .child(Scrollbar.vertical("diff-rows").viewport_from_layout().absolute().inset_0())))
      .when(Boolean(this.limited), (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).border_t(1).border_color(t.border)
        .child(`Showing the first ${MAX_LINES.toLocaleString()} lines`)));
  }
}
