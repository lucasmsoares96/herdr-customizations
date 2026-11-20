// Changes panel, VS Code style, for the selected space's repo. The top group lists
// uncommitted files (or, with a commit selected below, that commit's files); the
// bottom group lists the branch's commits. Picking a file shows its diff in the
// space's "Diff" tab (the diff-view mod), opened once and reused.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list } from "gpui-base";
import { spaces, panes, exec, watchFolder, theme, run, shared, setShared, checking } from "herdr";

// A space whose folder was deleted (a removed worktree): a plain message, not exec's error.
const GONE = "This space's folder was deleted";
const friendly = (e) => { const m = String(e?.message ?? e); return /cannot run git: No such file or directory|cannot change to/i.test(m) ? GONE : m; };

// The selected space, where it is now: its first terminal's live folder.
function location() {
  const space = spaces().find((s) => s.active);
  if (!space) return { cwd: null, on: null };
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  const at = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder;
  return { space: space.id, cwd: at ?? null, on: space.machine ?? null };
}
const key = () => JSON.stringify(location());
// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the folder watch would see it, and every refresh would start the next one.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const SEP = "\u001f";
const COMMITS = 200;
// Fixed row heights: the lists are virtual (only rows on screen are drawn), so a repo with
// hundreds of changed files doesn't make every frame build all of them.
const FILE_ROW = 27;
const COMMIT_ROW = 48;
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  if (!(d >= 0)) return "";
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};
const letter = (xy) => {
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "U";
  return xy.includes("D") ? "D" : xy === "??" || xy.includes("A") ? "A" : "M";
};

// "+3\t-1\tpath\0" records into { path: { add, del, binary } }.
function numstat(text, into = {}) {
  for (const entry of text.split("\0")) {
    const [a, d, ...parts] = entry.split("\t");
    if (!parts.length) continue;
    const path = parts.join("\t"), old = into[path] ?? { add: 0, del: 0 };
    into[path] = { add: old.add + (Number(a) || 0), del: old.del + (Number(d) || 0), binary: a === "-" };
  }
  return into;
}

export default class MyChanges extends View {
  init(_props, cx) {
    this.files = []; this.commits = []; this.sel = null; this.commitFiles = []; this.picked = null;
    this.message = ""; this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Commit message" });
    this.input.on("change", (_e, cx) => {
      const had = Boolean(this.message.trim());
      this.message = this.input.value();
      if (had !== Boolean(this.message.trim())) cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.commit(cx));
    this.input.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
    this.input.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === root) {
          await watchFolder(root);
          if (this.watched === root) this.refresh(cx);
        }
      } catch { this.watched = null; }
    });
  }

  git(args) { return exec("git", [...READ, ...args], { cwd: this.root, on: this.on }); }

  refresh(cx) {
    // A read that never came back (a reloaded script, a machine away) must not block the next one.
    if ((this.loading && Date.now() - this.loadingAt < 30000) || this.busy) return;
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.root = null; this.files = []; this.commits = []; this.sel = null; this.commitFiles = [];
      this.picked = null; this.message = ""; this.input.set_value(""); this.error = null; this.note = null; this.watched = null;
    }
    if (!cwd) { this.error = "No folder"; return; }
    this.loading = true; this.loadingAt = Date.now();
    cx.spawn(async (cx) => {
      try {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
        if (key() !== context) return;
        if (top.code !== 0) { this.root = null; this.files = []; this.commits = []; this.error = "Not a git repository"; return; }
        this.root = top.stdout.trim(); this.on = on;
        const [status, head, upstream] = await Promise.all([
          this.git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
          this.git(["rev-parse", "--verify", "-q", "HEAD"]),
          this.git(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]),
        ]);
        if (status.code !== 0) throw new Error(status.stderr);
        this.hasHead = head.code === 0;
        const stats = this.hasHead
          ? numstat((await this.git(["diff", "HEAD", "--numstat", "-z", "--no-renames"])).stdout)
          : numstat((await this.git(["diff", "--numstat", "-z", "--no-renames"])).stdout, numstat((await this.git(["diff", "--cached", "--numstat", "-z", "--no-renames"])).stdout));
        const entries = status.stdout.split("\0").filter(Boolean);
        const files = entries.slice(0, 1000).map((entry) => {
          const xy = entry.slice(0, 2), path = entry.slice(3);
          return { path, status: letter(xy), fresh: xy === "??", ...(stats[path] ?? { add: 0, del: 0 }) };
        });
        let commits = [];
        if (this.hasHead) {
          const up = upstream.code === 0 ? upstream.stdout.trim() : null;
          const [log, ahead] = await Promise.all([
            this.git(["log", `-n${COMMITS}`, `--format=%H${SEP}%h${SEP}%s${SEP}%an${SEP}%ct${SEP}%D${SEP}%P`]),
            up ? this.git(["rev-list", `${up}..HEAD`]) : Promise.resolve({ code: 1, stdout: "" }),
          ]);
          const unpushed = new Set(ahead.code === 0 ? ahead.stdout.split("\n").filter(Boolean) : []);
          commits = log.stdout.split("\n").filter(Boolean).map((line) => {
            const [sha, short, subject, author, at, refs, parents] = line.split(SEP);
            return { sha, short, subject, author, at: Number(at) || 0, merge: (parents ?? "").split(" ").filter(Boolean).length > 1,
              refs: (refs ?? "").split(", ").filter(Boolean).map((r) => r.replace(/^HEAD -> /, "")).filter((r) => r !== "HEAD"),
              unpushed: unpushed.has(sha) };
          });
          this.upstream = up;
        }
        if (key() !== context) return;
        this.files = files; this.commits = commits; this.limited = entries.length > 1000; this.error = null;
        // A selected commit that left the branch (a rebase, a reset) goes back to the working tree.
        if (this.sel && !commits.some((c) => c.sha === this.sel.sha)) { this.sel = null; this.commitFiles = []; }
        this.watch(this.root, cx);
        this.syncDiff();
      } catch (e) { if (key() === context) this.error = friendly(e); }
      finally { this.loading = false; cx.notify(); }
    });
  }

  // The files a commit changed, against its first parent (root commits against nothing).
  pickCommit(c, cx) {
    if (this.sel?.sha === c.sha) { this.sel = null; this.commitFiles = []; this.picked = null; cx.notify(); return; }
    this.sel = c; this.commitFiles = null; this.picked = null;
    const context = this.context;
    cx.spawn(async (cx) => {
      const base = ["diff-tree", "-r", "--root", "-m", "--first-parent", "--no-commit-id", "--no-renames", "-z"];
      const [names, stats] = await Promise.all([this.git([...base, "--name-status", c.sha]), this.git([...base, "--numstat", c.sha])]);
      if (context !== this.context || this.sel?.sha !== c.sha) return;
      const counts = numstat(stats.stdout), parts = names.stdout.split("\0").filter(Boolean), files = [];
      for (let i = 0; i + 1 < parts.length; i += 2) {
        const path = parts[i + 1];
        files.push({ path, status: parts[i][0] === "D" ? "D" : parts[i][0] === "A" ? "A" : "M", ...(counts[path] ?? { add: 0, del: 0 }) });
      }
      this.commitFiles = files;
      cx.notify();
    });
    cx.notify();
  }

  // Show a file's diff in the space's Diff tab: the one already open, else a new one.
  pickFile(f) {
    const space = spaces().find((s) => s.active);
    if (!space || !this.root) return;
    this.picked = { sha: this.sel?.sha ?? null, path: f.path };
    setShared("changes.diff", {
      root: this.root, on: this.on ?? null, path: f.path, status: f.status, fresh: Boolean(f.fresh), hasHead: this.hasHead,
      add: f.add, del: f.del, binary: Boolean(f.binary),
      commit: this.sel ? { sha: this.sel.sha, short: this.sel.short, subject: this.sel.subject } : null, at: Date.now(),
    });
    const tabs = new Set((space.tabs ?? []).map((t) => t.id));
    const open = panes().find((p) => p.mod === "diff-view" && tabs.has(p.tab));
    if (open) run("tab.select", { id: open.tab });
    else run("tab.new", { space: space.id, name: "Diff", mod: "diff-view", props: {} });
  }

  // A working-tree diff on show follows edits; a file that is no longer changed clears it.
  syncDiff() {
    const d = shared("changes.diff");
    if (!d || d.commit || d.root !== this.root) return;
    const f = this.files.find((x) => x.path === d.path);
    if (!f) { if (!d.gone) setShared("changes.diff", { ...d, gone: true, at: Date.now() }); return; }
    if (d.gone || f.add !== d.add || f.del !== d.del || f.status !== d.status)
      setShared("changes.diff", { ...d, gone: false, status: f.status, fresh: Boolean(f.fresh), add: f.add, del: f.del, at: Date.now() });
  }

  commit(cx) {
    if (!this.message.trim() || !this.root || this.busy || this.loading || this.sel) return;
    const root = this.root, on = this.on, context = this.context, message = this.message.trim();
    this.busy = true; this.note = null;
    cx.spawn(async (cx) => {
      try {
        for (const args of [["add", "-A"], ["commit", "-m", message]]) {
          const r = await exec("git", args, { cwd: root, on });
          if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
        }
        if (key() === context) { this.message = ""; this.input.set_value(""); }
      } catch (e) { if (key() === context) this.note = `Commit failed: ${e.message ?? e}`; }
      finally { this.busy = false; this.refresh(cx); cx.notify(); }
    });
    cx.notify();
  }

  fileRow(f, t) {
    const parts = f.path.split("/"), name = parts.pop();
    const on = this.picked?.path === f.path && this.picked?.sha === (this.sel?.sha ?? null);
    const color = f.status === "A" ? t.ansi2 : f.status === "D" || f.status === "U" ? t.ansi1 : t.blocked;
    return h_flex().id(`cf-${f.path}`).h(FILE_ROW - 1).flex_none().mx(4).px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover))
      .on_click(() => this.pickFile(f))
      .child(div().w(12).flex_none().text_size(11).text_color(color).child(f.status))
      .child(h_flex().flex_1().min_w(0).gap(6)
        .child(div().flex_none().max_w(200).truncate().text_color(f.status === "D" ? t.dim : t.foreground).child(name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(parts.join("/"))))
      .when(f.add > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi2).child(`+${f.add}`)))
      .when(f.del > 0, (e) => e.child(div().flex_none().text_size(10.5).text_color(t.ansi1).child(`−${f.del}`)));
  }

  commitRow(c, t) {
    const on = this.sel?.sha === c.sha;
    return v_flex().id(`cm-${c.sha}`).h(COMMIT_ROW - 2).flex_none().mx(4).px(8).gap(2).justify_center().rounded(6).cursor_pointer()
      .when(on, (e) => e.bg(t.selected)).hover((s) => s.bg(on ? t.selected : t.hover))
      .on_click((_e, cx) => this.pickCommit(c, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().size(7).flex_none().rounded(4).border_1().border_color(c.unpushed ? t.accent : t.dim).when(c.unpushed, (e) => e.bg(t.accent)))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(c.subject)))
      .child(h_flex().pl(13).gap(6).items_center().text_size(10.5).text_color(t.dim)
        .child(div().flex_none().font_family("JetBrains Mono").child(c.short))
        .children(c.refs.slice(0, 3).map((r) => div().flex_none().max_w(120).truncate().px(4).rounded(3).border_1().border_color(t.border)
          .text_color(r.startsWith("origin/") ? t.dim : t.muted).child(r)))
        .child(div().flex_1().min_w(0).truncate().child(c.author))
        .when(c.unpushed, (e) => e.child(div().flex_none().text_color(t.accent).child("not pushed")))
        .child(div().flex_none().child(ago(c.at))));
  }

  section(label, count, t, extra) {
    return h_flex().h(28).flex_none().px(12).gap(6).items_center().text_size(10.5).font_semibold().text_color(t.dim)
      .border_b(1).border_color(t.border).bg(t.chrome)
      .child(div().flex_none().child(label)).child(div().flex_none().font_normal().child(count === null ? "" : String(count)))
      .child(div().flex_1())
      .when(Boolean(extra), extra);
  }

  render(cx) {
    if (!checking() && key() !== this.context) this.refresh(cx);
    const t = theme();
    const files = this.sel ? this.commitFiles ?? [] : this.files;
    const add = files.reduce((n, f) => n + f.add, 0), del = files.reduce((n, f) => n + f.del, 0);
    const enabled = Boolean(this.message.trim() && this.root && !this.busy && !this.loading);
    const empty = this.error || (this.sel ? (this.commitFiles === null ? "Loading…" : "No file changes") : this.loading && !this.root ? "Loading…" : "No uncommitted changes");
    return v_flex().id("my-changes").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(12.5).track_focus(this.handle)
      .on_key_down((e, cx) => { if (e.key === "escape" && this.typing) { this.typing = false; this.handle.focus(); cx.stop_propagation(); cx.notify(); } })
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Changes"))
        .child(div().flex_1())
        .when(add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)))
        .when(del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))))
      // Top group: the working tree, or the selected commit's files.
      .child(this.sel
        ? this.section("COMMIT", null, t, (el) => el
          .child(div().flex_none().font_normal().font_family("JetBrains Mono").text_color(t.muted).child(this.sel.short))
          .child(div().id("back-to-tree").flex_none().px(6).h(20).flex().items_center().rounded(4).font_normal().cursor_pointer()
            .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { this.sel = null; this.commitFiles = []; this.picked = null; cx.notify(); }).child("← Working tree")))
        : this.section("CHANGES", this.files.length, t))
      .when(Boolean(this.sel), (el) => el.child(div().flex_none().px(12).pt(6).text_size(11.5).text_color(t.muted).truncate().child(this.sel.subject)))
      .child(div().flex_1().min_h(60).relative()
        .when(files.length > 0, (el) => el
          .child(div().absolute().inset_0().pt(4).child(v_virtual_list("cf-list", files.length, FILE_ROW, (i) => files[i].path,
            (range) => files.slice(range.start, range.end).map((f) => this.fileRow(f, t))).size_full()))
          .child(Scrollbar.vertical("cf-list").viewport_from_layout().absolute().inset_0()))
        .when(!files.length, (e) => e.child(div().p(12).text_color(this.error && !/^(Not a git repository|No folder|This space's folder was deleted)$/.test(this.error) ? t.ansi1 : t.dim).child(empty))))
      .when(this.limited && !this.sel, (el) => el.child(div().px(12).py(4).text_size(11).text_color(t.dim).child("Showing the first 1,000 changed files")))
      .when(Boolean(this.note), (e) => e.child(div().px(10).pb(6).text_size(11).text_color(t.ansi1).child(this.note)))
      .when(!this.sel && Boolean(this.root), (el) => el.child(h_flex().flex_none().p(8).gap(8).border_t(1).border_color(t.border)
        .child(div().id("commit-message").flex_1().min_w(0).h(30).px(10).flex().items_center().rounded(7).border_1()
          .border_color(this.typing ? t.accent : t.border).cursor_text().on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("commit").h(30).px(12).flex().items_center().rounded(7).bg(enabled ? t.solid : t.raised)
          .text_color(enabled ? t.solid_foreground : t.dim).text_size(12).when(enabled, (e) => e.cursor_pointer())
          .on_click((_e, cx) => this.commit(cx)).child(this.busy ? "Committing…" : "Commit"))))
      // Bottom group: the branch's commits, newest first.
      .when(Boolean(this.root) && this.hasHead, (el) => el
        .child(div().h(1).flex_none().bg(t.border))
        .child(this.section("COMMITS", this.commits.length >= COMMITS ? `${COMMITS}+` : this.commits.length, t,
          (el) => el.when(Boolean(this.upstream), (el) => el.child(div().flex_none().font_normal().max_w(160).truncate().child(`vs ${this.upstream}`)))))
        .child(div().flex_1().min_h(60).relative()
          .child(div().absolute().inset_0().pt(4).child(v_virtual_list("cm-list", this.commits.length, COMMIT_ROW, (i) => this.commits[i].sha,
            (range) => this.commits.slice(range.start, range.end).map((c) => this.commitRow(c, t))).size_full()))
          .child(Scrollbar.vertical("cm-list").viewport_from_layout().absolute().inset_0())));
  }
}
