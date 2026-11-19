// Right-click menu for spaces, worktrees and branches, and the dialogs it opens.
// Props: { space? } (a space row), { folder, on? } (a checkout), or
// { folder, branch, on? } (a branch of the repo `folder` is in). With
// { action: "rename" | "move" | "delete-branch" | "delete-worktree", ... } it is
// the dialog for that action instead of the menu.
// Never touches the main checkout's branch or folder, and never the remote.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, spaces, panes, exec, home, setShared } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s, ps = panes()) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const inside = (p, dir) => Boolean(p) && (p === dir || p.startsWith(dir + "/"));
const tilde = (p) => (p && p.startsWith(home()) ? `~${p.slice(home().length)}` : p);

async function git(cwd, args, on, timeout) {
  const r = await exec("git", args, { cwd, on, ...(timeout ? { timeout } : {}) });
  return { ok: r.code === 0, out: (r.stdout ?? "").trim(), err: (r.stderr || r.stdout || "").trim() };
}

// The repo a folder is in and all of its checkouts: { main, top, linked, trees: [{ path, branch, main }] }.
async function repoOf(folder, on) {
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  const common = await git(folder, ["rev-parse", "--path-format=absolute", "--git-common-dir"], on);
  if (!top.ok || !common.ok || !common.out.endsWith("/.git")) return null;
  const main = common.out.slice(0, -5);
  const list = await git(main, ["worktree", "list", "--porcelain"], on);
  const trees = [];
  for (const block of list.out.split(/\n\n+/)) {
    const lines = block.split("\n");
    const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
    if (!path || lines.some((l) => l === "bare")) continue;
    const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "") ?? null;
    trees.push({ path, branch, main: trees.length === 0 });
  }
  return { main, top: top.out, linked: top.out !== main, trees };
}

// Spaces whose terminals are in this checkout (not in a checkout nested inside it).
function spacesIn(path, on, trees) {
  const ps = panes();
  const nested = trees.map((c) => c.path).filter((p) => p !== path && inside(p, path));
  return spaces().filter((s) => {
    if ((s.machine ?? null) !== (on ?? null)) return false;
    const at = place(s, ps);
    return inside(at, path) && !nested.some((n) => inside(at, n));
  });
}

const managed = (path) => /\/\.loopy\/|\/\.claude\/worktrees\//.test(path ?? "")
  ? `${path.includes("/.loopy/") ? "loopy" : "Claude Code"} made this worktree and may still expect it.` : null;

const ICON = { rename: "square-pen", move: "folder", delete: "x", copy: "files", space: "square-pen", new: "plus", open: "git-branch", close: "x" };
const DIALOG = { width: 460, height: 250 };

export default class GitMenu extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
    this.space = p.space ? spaces().find((s) => s.id === p.space) : null;
    this.on = p.on ?? this.space?.machine ?? null;
    this.facts = undefined; // undefined: looking; null: not in git
    this.action = p.action ?? null;
    this.busy = false;
    this.error = "";
    this.confirm = null; // a second Enter forces: "force-branch" | "force-worktree"
    if (this.action === "rename" || this.action === "move") {
      this.input = InputState.new({ value: this.action === "rename" ? p.branch : p.path, placeholder: this.action === "rename" ? "new branch name" : "new folder" });
      this.input.on("submit", (_e, cx) => this.go(cx));
      this.input.on("change", (_e, cx) => { this.error = ""; cx.notify(); });
    }
    cx.spawn(async (cx) => {
      try {
        const folder = p.folder ?? (this.space ? place(this.space) : null);
        const repo = folder ? await repoOf(folder, this.on) : null;
        if (!repo) { this.facts = null; cx.notify(); return; }
        // What the menu is about: the branch asked for, else the checkout of the folder.
        let branch = p.branch ?? null, tree = null;
        if (branch) tree = repo.trees.find((c) => c.branch === branch) ?? null;
        else {
          tree = repo.trees.filter((c) => inside(repo.top, c.path)).sort((a, b) => b.path.length - a.path.length)[0] ?? null;
          branch = tree?.branch ?? null;
        }
        const protectedBranch = repo.trees[0]?.branch ?? null;
        this.facts = { repo, branch, tree, protectedBranch, open: tree ? spacesIn(tree.path, this.on, repo.trees) : [] };
        if (this.action === "delete-worktree" && tree) {
          const status = await git(tree.path, ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain"], this.on);
          this.dirty = status.ok && status.out !== "";
        }
      } catch (e) { this.facts = null; this.error = String(e.message ?? e); }
      cx.notify();
      if (this.input) cx.timer.after(60, () => this.input.focus());
    });
  }

  close() { closeOverlay(props()?.overlay); }

  // [label, icon, run] for the menu; separators are null.
  items() {
    const s = this.space, f = this.facts;
    const out = [];
    if (s) {
      out.push(["Rename space", "space", () => run("space.rename", { id: s.id })]);
      if (f) {
        out.push(["New worktree", "new", () => openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: s.id, action: "new" } })]);
        out.push(["Open worktree", "open", () => openOverlay({ mod: "worktree", kind: "dialog", width: 560, height: 480, props: { space: s.id, action: "open" } })]);
      }
    }
    if (f) {
      const { repo, branch, tree, protectedBranch, open } = f;
      const isMain = Boolean(tree?.main);
      const base = { folder: repo.main, on: this.on, branch, path: tree?.path ?? null };
      const dialog = (action, extra = {}) => () => openOverlay({ mod: "git-menu", kind: "dialog", ...DIALOG, props: { ...base, action, ...extra } });
      const git = [];
      if (branch) git.push(["Copy branch name", "copy", (cx) => cx.write_to_clipboard(branch)]);
      if (branch && branch !== protectedBranch) git.push(["Rename branch…", "rename", dialog("rename")]);
      if (tree && !isMain && open.length === 0) git.push(["Move worktree folder…", "move", dialog("move")]);
      if (tree && !isMain) {
        git.push(null);
        git.push(["Delete worktree", "delete", dialog("delete-worktree")]);
        if (branch && branch !== protectedBranch) git.push(["Delete worktree and branch", "delete", dialog("delete-worktree", { withBranch: true })]);
      } else if (!tree && branch && branch !== protectedBranch) {
        git.push(null);
        git.push(["Delete branch", "delete", dialog("delete-branch")]);
      }
      if (git.length) { if (out.length) out.push(null); out.push(...git); }
    }
    if (s) { out.push(null); out.push(["Close space", "close", () => run("space.close", { id: s.id })]); }
    return out.filter((it, i, all) => it || (i > 0 && i < all.length - 1 && all[i - 1]));
  }

  choose(i, cx) {
    const it = this.items().filter(Boolean)[i];
    if (!it) return;
    this.close();
    it[2](cx);
  }

  // ---- dialogs ----

  go(cx) {
    if (this.busy || !this.facts) return;
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try { this.error = await this.work(); }
      catch (e) { this.error = String(e.message ?? e); }
      this.busy = false;
      if (!this.error) { setShared("git.changed", Date.now()); this.close(); }
      cx.notify();
    });
  }

  async work() {
    const p = props(), { repo, branch, tree, open } = this.facts, on = this.on;
    if (this.action === "rename") {
      const name = this.input.value().trim();
      if (!name || name === branch) return "Type a new name.";
      if (!(await git(repo.main, ["check-ref-format", "--branch", name], on)).ok) return `"${name}" isn't a valid branch name.`;
      const r = await git(repo.main, ["branch", "-m", branch, name], on);
      return r.ok ? "" : r.err;
    }
    if (this.action === "move") {
      const to = this.input.value().trim().replace(/^~(?=\/|$)/, home());
      if (!to || to === tree.path) return "Type a new folder.";
      if (spacesIn(tree.path, on, repo.trees).length) return "A space is open in it: close it first.";
      const r = await git(repo.main, ["worktree", "move", tree.path, to], on, 120000);
      return r.ok ? "" : r.err;
    }
    if (this.action === "delete-worktree") {
      if (!tree || tree.main) return "This is the repository's main checkout.";
      for (const s of open) run("space.close", { id: s.id, confirmed: true });
      const force = this.dirty || this.confirm === "force-worktree";
      const r = await git(repo.main, ["worktree", "remove", ...(force ? ["--force"] : []), tree.path], on, 600000);
      if (!r.ok) {
        // git refuses worktrees with submodules (their history goes with them) unless forced.
        if (!force && /submodule/i.test(r.err)) { this.confirm = "force-worktree"; return "It has submodules whose history goes with it. Enter again deletes it anyway."; }
        return r.err || "git worktree remove failed.";
      }
      if (!p.withBranch) return "";
      this.facts = { ...this.facts, tree: null, open: [] };
      this.action = "delete-branch";
    }
    // delete-branch (also the second half of "delete worktree and branch")
    const force = this.confirm === "force-branch";
    const r = await git(repo.main, ["branch", force ? "-D" : "-d", branch], on);
    if (r.ok) return "";
    if (!force && /not fully merged/i.test(r.err)) {
      const lost = await git(repo.main, ["log", "--oneline", "-n", "8", branch, "--not", `--exclude=refs/heads/${branch}`, "--branches", "--remotes"], on);
      this.lost = lost.ok ? lost.out.split("\n").filter(Boolean) : [];
      this.confirm = "force-branch";
      return `${branch} has commits that are on no other branch. Enter again deletes them too.`;
    }
    return r.err || "git branch -d failed.";
  }

  dialog(t) {
    const p = props(), f = this.facts, a = this.action;
    const branch = f?.branch ?? p.branch, path = f?.tree?.path ?? p.path;
    const title = a === "rename" ? `Rename branch ${branch}` : a === "move" ? "Move worktree folder"
      : a === "delete-worktree" ? (p.withBranch ? `Delete worktree and branch ${branch}?` : `Delete worktree ${tilde(path)}?`)
      : `Delete branch ${branch}?`;
    const detail = f === undefined ? "…" : f === null ? "This folder isn't in a git repository."
      : a === "rename" ? `Renames the branch${f.tree ? ` checked out in ${tilde(f.tree.path)}` : ""}. Its folder and spaces stay; a remote branch of the old name stays too.`
      : a === "move" ? `Moves ${tilde(path)}.`
      : a === "delete-worktree" ? `${f.open.length ? `Closes ${f.open.map((s) => s.name).join(", ")} and deletes` : "Deletes"} ${tilde(path)}.${p.withBranch ? ` Then deletes branch ${branch}.` : " The branch stays."}`
      : `Deletes the local branch. The remote one, if any, stays.`;
    const warn = [
      a === "delete-worktree" && this.dirty ? "It has uncommitted changes: they will be lost." : null,
      (a === "delete-worktree" || a === "move") ? managed(path) : null,
    ].filter(Boolean);
    const blocked = !f || (a !== "rename" && a !== "delete-branch" && (!f.tree || f.tree.main));
    const verb = a === "rename" ? "rename" : a === "move" ? "move" : "delete";
    return v_flex().id("git-dialog").track_focus(this.handle).size_full().p(16).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") return this.close();
        if (e.key === "enter" && !this.input && !blocked) this.go(cx);
      })
      .child(div().font_semibold().text_color(t.foreground).child(title))
      .child(div().text_color(t.muted).child(detail))
      .children(warn.map((w) => div().text_color(t.blocked).child(w)))
      .when(Boolean(this.input) && !blocked, (el) => el.child(Input.new(this.input).h(32).px(10).items_center().rounded(6)
        .border(1).border_color(t.input).bg(t.background).text_color(t.foreground)))
      .when(Boolean(this.error), (el) => el.child(div().text_color(t.blocked).child(this.error)))
      .when((this.lost ?? []).length > 0, (el) => el.child(v_flex().gap(2).text_size(11.5).text_color(t.muted)
        .children(this.lost.map((l) => div().truncate().child(l)))))
      .child(div().flex_1())
      .child(h_flex().justify_end().gap(8).items_center()
        .when(this.busy, (el) => el.child(div().text_size(11).text_color(t.dim).frames(["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], 90)))
        .child(div().id("cancel").h(28).px(12).flex().items_center().rounded(6).text_size(12).cursor_pointer().bg(t.raised).text_color(t.foreground)
          .hover((s) => s.bg(t.hover)).on_click(() => this.close()).child("Cancel"))
        .when(!blocked, (el) => el.child(div().id("ok").h(28).px(12).flex().items_center().rounded(6).text_size(12).cursor_pointer()
          .bg(verb === "delete" ? t.ansi1 : t.solid).text_color(verb === "delete" ? "#ffffff" : t.solid_foreground)
          .on_click((_e, cx) => this.go(cx))
          .child(this.busy ? "Working…" : this.confirm ? `${verb[0].toUpperCase()}${verb.slice(1)} anyway` : `${verb[0].toUpperCase()}${verb.slice(1)}`))));
  }

  render() {
    const t = theme();
    if (this.action) return this.dialog(t);
    const list = this.items();
    const flat = list.filter(Boolean);
    let n = -1;
    return v_flex().id("git-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (!flat.length) return;
        if (e.key === "down") this.at = (this.at + 1) % flat.length;
        else if (e.key === "up") this.at = (this.at + flat.length - 1) % flat.length;
        else if (e.key === "enter") this.choose(this.at, cx);
        else if (e.key === "escape") this.close();
        else return;
        cx.notify();
      })
      .when(this.facts === undefined && !this.space, (el) => el.child(div().px(8).h(31).flex().items_center().text_color(t.dim).child("…")))
      .when(this.facts === null && !this.space, (el) => el.child(div().px(8).h(31).flex().items_center().text_color(t.dim).child("Not in a git repository")))
      .children(list.map((it) => {
        if (!it) return div().mx(7).my(4).h(1).bg(t.border);
        const i = ++n;
        return h_flex().id(`gm-${i}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(it[1] === "delete" ? t.ansi1 : t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.choose(i, cx))
          .child(svg(`mods/workspace-chrome/${ICON[it[1]] ?? "terminal"}.svg`).size(14).flex_none().text_color(it[1] === "delete" ? t.ansi1 : t.muted))
          .child(div().flex_1().child(it[0]));
      }))
      .when(this.facts === undefined && Boolean(this.space), (el) => el.child(div().px(8).h(24).flex().items_center().text_size(11).text_color(t.dim).child("…")));
  }
}
