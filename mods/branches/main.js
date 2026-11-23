// Local branches of the repo the selected space is in, straight from git: those
// checked out in a worktree first, then the rest, newest commit first. A click
// goes to the branch's space, opens one at its worktree, or makes the worktree;
// right-click opens git-menu (rename, move, delete).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, InputState, Input } from "gpui-base";
import { spaces, panes, exec, theme, home, run, openOverlay, checking, shared, watchFolder } from "herdr";

// A space whose folder was deleted (a removed worktree): a plain message, not exec's error.
const GONE = "This space's folder was deleted";
const friendly = (e) => { const m = String(e?.message ?? e); return /cannot run git: No such file or directory|cannot change to/i.test(m) ? GONE : m; };

function location() {
  // Only the selected space, where it is now: its first terminal's live folder (the
  // same place the Spaces sidebar reads), else where it was made if it has no terminal.
  const space = spaces().find((s) => s.active);
  if (!space) return { places: [], on: null };
  const tabs = new Set((space.tabs ?? []).map((t) => t.id));
  const at = panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || space.folder;
  return { space: space.id, cwd: at ?? null, places: at ? [at] : [], on: space.machine ?? null };
}
const key = () => JSON.stringify(location());
const inside = (p, dir) => Boolean(p) && (p === dir || p.startsWith(dir + "/"));
const tilde = (p) => (p && p.startsWith(home()) ? `~${p.slice(home().length)}` : p);
const ago = (s) => {
  const d = Date.now() / 1000 - s;
  if (!(d >= 0)) return "";
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};
const SEP = "\u001f";

function stored(name, fallback) {
  try { const v = JSON.parse(localStorage.getItem(name) ?? "null"); return v && typeof v === "object" ? v : fallback; } catch { return fallback; }
}
function store(name, value) {
  try { localStorage.setItem(name, JSON.stringify(value)); } catch {}
}

async function git(cwd, args, on) {
  const r = await exec("git", args, { cwd, on });
  return { ok: r.code === 0, out: (r.stdout ?? "").replace(/\n$/, ""), err: (r.stderr || r.stdout || "").trim() };
}

export default class Branches extends View {
  init(_props, cx) {
    this.cache = stored("repos", {}); // JSON [machine, main] -> { main, on, name, base, branches }
    this.folders = stored("folders", {}); // JSON [machine, folder] -> JSON [machine, main]
    this.repo = null;
    this.filter = "";
    this.input = InputState.new({ placeholder: "filter branches" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); cx.notify(); });
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(30000, (cx) => this.refresh(cx));
  }

  // The cached repo for a location: the deepest remembered folder holding one of its places.
  guess({ places, on }) {
    for (const place of places) {
      let best = null, length = -1;
      for (const [k, repoKey] of Object.entries(this.folders)) {
        const [m, folder] = JSON.parse(k);
        if ((m ?? null) === (on ?? null) && inside(place, folder) && folder.length > length) { best = repoKey; length = folder.length; }
      }
      if (best && this.cache[best]) return this.cache[best];
    }
    return null;
  }

  refresh(cx) {
    const context = key();
    if (context !== this.context) {
      this.context = context;
      this.repo = this.guess(JSON.parse(context));
      this.error = null;
    }
    this.changed = shared("git.changed");
    const gen = this.gen = (this.gen ?? 0) + 1;
    this.syncing = true;
    cx.spawn(async (cx) => {
      try {
        const { places, on } = JSON.parse(context);
        let top = null, from = null;
        for (const cwd of places) {
          const r = await git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], on);
          if (r.ok) { top = r.out.split("\n"); from = cwd; break; }
        }
        if (this.gen !== gen) return;
        if (!top || !top[1]?.endsWith("/.git")) { this.repo = null; this.error = places.length ? "Not a git repository" : "No folder"; return; }
        const main = top[1].slice(0, -5);
        const repoKey = JSON.stringify([on ?? null, main]);
        for (const folder of new Set([top[0], from])) {
          const k = JSON.stringify([on ?? null, folder]);
          delete this.folders[k];
          this.folders[k] = repoKey;
        }
        for (const old of Object.keys(this.folders).slice(0, -100)) delete this.folders[old];
        store("folders", this.folders);
        // Compare with the remote's default branch, else the main checkout's.
        const head = await git(main, ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"], on);
        const mainBranch = await git(main, ["symbolic-ref", "-q", "--short", "HEAD"], on);
        const base = head.ok && head.out ? head.out : mainBranch.ok ? mainBranch.out : null;
        const fields = ["%(refname:short)", "%(committerdate:unix)", "%(upstream:short)", "%(upstream:track)", base ? `%(ahead-behind:${base})` : "", "%(contents:subject)"];
        const [refs, remotes, trees] = await Promise.all([
          git(main, ["for-each-ref", "--sort=-committerdate", `--format=${fields.join(SEP)}`, "refs/heads"], on),
          git(main, ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"], on),
          git(main, ["worktree", "list", "--porcelain"], on),
        ]);
        if (this.gen !== gen) return;
        if (!refs.ok) throw new Error(refs.err);
        const onRemote = new Set(remotes.out.split("\n").filter(Boolean).map((r) => r.replace(/^origin\//, "")));
        const worktree = {};
        let first = true;
        for (const block of trees.out.split(/\n\n+/)) {
          const lines = block.split("\n");
          const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
          const b = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
          if (path && b) worktree[b] = { path, main: first };
          if (path) first = false;
        }
        const branches = refs.out.split("\n").filter(Boolean).map((line) => {
          const [name, at, upstream, track, ab, subject] = line.split(SEP);
          const [ahead, behind] = (ab ?? "").split(" ").map(Number);
          return { name, at: Number(at) || 0, upstream: upstream || null, gone: track === "[gone]", ahead: ahead || 0, behind: behind || 0,
            subject, remote: onRemote.has(name), tree: worktree[name]?.path ?? null, main: Boolean(worktree[name]?.main) };
        });
        const repo = { main, on: on ?? null, name: main.split("/").pop(), base, branches };
        this.cache[repoKey] = repo;
        for (const old of Object.keys(this.cache).slice(0, -20)) delete this.cache[old];
        store("repos", this.cache);
        this.repo = repo;
        this.error = null;
        this.watch(main, on, cx);
      } catch (e) { if (this.gen === gen) this.error = friendly(e); }
      finally { if (this.gen === gen) { this.syncing = false; cx.notify(); } }
    });
  }

  // Local repos: a commit, checkout or branch change anywhere refreshes the list.
  watch(main, on, cx) {
    if (on || this.watched === main) return;
    this.watched = main;
    cx.spawn(async (cx) => {
      try {
        while (this.watched === main) {
          await watchFolder(`${main}/.git`);
          if (this.watched === main) this.refresh(cx);
        }
      } catch { if (this.watched === main) this.watched = null; }
    });
  }

  // Where each space is now, read once per frame (panes() copies every pane on each call).
  places() {
    if (this.frame) return this.frame;
    const firstCwd = {};
    for (const p of panes()) if (p.cwd && !(p.tab in firstCwd)) firstCwd[p.tab] = p.cwd;
    this.frame = spaces().map((s) => ({ s, at: (s.tabs ?? []).map((t) => firstCwd[t.id]).find(Boolean) || s.folder }));
    return this.frame;
  }

  spaceAt(path) {
    const trees = (this.repo?.branches ?? []).map((b) => b.tree).filter(Boolean);
    const nested = trees.filter((p) => p !== path && inside(p, path));
    return this.places().find(({ s, at }) => (s.machine ?? null) === (this.repo?.on ?? null)
      && inside(at, path) && !nested.some((n) => inside(at, n)))?.s;
  }

  go(b) {
    const r = this.repo;
    if (!r) return;
    if (b.tree) {
      const s = this.spaceAt(b.tree);
      if (s) run("space.select", { id: s.id });
      else run("space.new", { folder: b.tree, machine: r.on ?? "" });
    } else {
      openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { folder: r.main, machine: r.on, action: "new", branch: b.name } });
    }
  }

  menu(b) {
    const r = this.repo;
    openOverlay({ mod: "git-menu", kind: "popup", width: 240, height: 300, props: { folder: r.main, on: r.on, branch: b.name } });
  }

  row(b, t) {
    const space = b.tree ? this.spaceAt(b.tree) : null;
    const where = space ? space.name : b.tree ? (b.main ? "main checkout" : "worktree") : null;
    return v_flex().id(`br-${b.name}`).flex_none().px(8).py(5).gap(2).rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click(() => this.go(b))
      .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.menu(b); })
      .tooltip(b.tree ? `${tilde(b.tree)}\n${space ? "Click to go to its space" : "Click to open a space there"}` : "Click to make a worktree for it")
      .child(h_flex().gap(6).items_center()
        .child(svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none().text_color(b.tree ? t.accent : t.dim))
        .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(b.name))
        .when(b.main, (el) => el.child(div().flex_none().px(5).h(16).flex().items_center().rounded(4).text_size(10)
          .border_1().border_color(t.border).text_color(t.muted).tooltip("The repository's main checkout").child("main checkout")))
        .when(b.ahead > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi2).child(`↑${b.ahead}`)))
        .when(b.behind > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.ansi1).child(`↓${b.behind}`))))
      .child(h_flex().pl(18).gap(6).items_center().text_size(10.5).text_color(t.dim)
        .when(Boolean(where), (el) => el.child(div().flex_none().max_w(140).truncate().text_color(space ? t.accent : t.muted).child(where)))
        .child(div().flex_1().min_w(0).truncate().child(b.subject ?? ""))
        .when(b.gone, (el) => el.child(div().flex_none().text_color(t.blocked).child("remote gone")))
        .when(!b.gone && !b.remote, (el) => el.child(div().flex_none().child("local only")))
        .child(div().flex_none().child(ago(b.at))));
  }

  render(cx) {
    this.frame = null; // fresh spaces and panes for this frame
    if (!checking() && (key() !== this.context || shared("git.changed") !== this.changed)) this.refresh(cx);
    const t = theme(), r = this.repo;
    const f = this.filter.trim().toLowerCase();
    const all = (r?.branches ?? []).filter((b) => !f || b.name.toLowerCase().includes(f) || (b.subject ?? "").toLowerCase().includes(f));
    // Every checkout counts as a worktree; the main one is listed first, with a badge.
    const withTree = all.filter((b) => b.tree).sort((x, y) => Number(y.main) - Number(x.main)), rest = all.filter((b) => !b.tree);
    const head = (label, n) => div().px(8).pt(8).pb(3).text_size(10.5).font_semibold().text_color(t.dim).child(`${label} · ${n}`);
    return v_flex().id("branches").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Branches"))
        .when(Boolean(r), (el) => el.child(div().min_w(0).px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).truncate()
          .child(`${r.name}${r.base ? ` · vs ${r.base}` : ""}`)))
        .child(div().flex_1())
        .child(div().id("reload").size(24).flex().flex_none().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.refresh(cx); cx.notify(); })
          .child(this.syncing ? svg("mods/workspace-chrome/spinner.svg").size(12).spin(900) : "↻")))
      .child(div().flex_none().p(8).border_b(1).border_color(t.border)
        .child(div().id("filter").h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.input).bg(t.background)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).h_full().w_full().text_size(12).text_color(t.foreground))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("branch-list").absolute().inset_0().overflow_y_scroll().px(6).pb(6).gap(1)
          .when(!r, (el) => el.child(div().p(8).text_color(this.error && !/^(Not a git repository|No folder|This space's folder was deleted)$/.test(this.error) ? t.ansi1 : t.dim).child(this.error || "Loading…")))
          .when(Boolean(r) && withTree.length > 0, (el) => el.child(head("IN A WORKTREE", withTree.length)).children(withTree.map((b) => this.row(b, t))))
          .when(Boolean(r) && rest.length > 0, (el) => el.child(head("OTHER BRANCHES", rest.length)).children(rest.map((b) => this.row(b, t))))
          .when(Boolean(r) && all.length === 0, (el) => el.child(div().p(8).text_color(t.dim).child(f ? "No branch matches" : "No branches"))))
        .child(Scrollbar.vertical("branch-list").absolute().inset_0()));
  }
}
