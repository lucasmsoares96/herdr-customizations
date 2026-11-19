// Issues and pull requests of the repo the selected space is in, from its forge's
// REST API: GitHub (github.com, or a host `gh` is logged in to) or Forgejo (any
// other host). Read-only: it never writes to the forge. Tokens: GitHub uses
// $GH_TOKEN / $GITHUB_TOKEN (github.com only), else `gh auth token`; Forgejo uses
// $FORGEJO_TOKEN, else the one `fj auth login` saved. A token only goes to its forge.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView } from "gpui-base";
import { spaces, panes, exec, readTextFile, theme, home, run, openOverlay, checking, window } from "herdr";

const PAGE = 50;
const MAX_PAGES = 40; // at most 2,000 per list
const POLL = 120000;
const FJ_KEYS = "Library/Application Support/Cyborus.forgejo-cli/keys.json";

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

// ssh://git@host[:port]/owner/repo.git, git@host:owner/repo.git, https://host/owner/repo
function parseRemote(url) {
  let host, path;
  const u = url.trim();
  if (/^[a-z+]+:\/\//i.test(u)) {
    const rest = u.replace(/^[a-z+]+:\/\//i, "").replace(/^[^@/]+@/, "");
    host = rest.split("/")[0].replace(/:\d+$/, "");
    path = rest.slice(rest.indexOf("/") + 1);
  } else {
    const rest = u.replace(/^[^@]+@/, "");
    host = rest.split(":")[0];
    path = rest.slice(host.length + 1);
  }
  const [owner, repo] = path.replace(/\.git$/, "").replace(/\/+$/, "").split("/").slice(-2);
  return host && owner && repo ? { host, owner, repo } : null;
}

// What differs between the forges: where the API is, how it is asked, and what
// GitHub's issue list mixes in (its /issues also returns pull requests).
const FORGES = {
  github: {
    name: "GitHub",
    api: (host, owner, repo) => `${host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`}/repos/${owner}/${repo}`,
    headers: (token) => ({ Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "herdr-forge-panel" }),
    list: (kind, state, page) => kind === "pulls"
      ? `/pulls?state=${state}&per_page=${PAGE}&page=${page}&sort=updated&direction=desc`
      : `/issues?state=${state}&per_page=${PAGE}&page=${page}`,
    keep: (kind, i) => kind === "pulls" || !i.pull_request,
    blockers: (n) => `/issues/${n}/dependencies/blocked_by`,
    branches: (page) => `/branches?per_page=${PAGE}&page=${page}`,
    blocks: (n) => `/issues/${n}/dependencies/blocking`,
    runPages: 1,
    runs: (page) => `/actions/runs?per_page=${PAGE}&page=${page}`,
    runsOf: (json) => (json?.workflow_runs ?? []).map((r) => ({
      id: r.id, number: r.run_number, title: r.display_title || r.name, workflow: (r.path ?? "").split("/").pop() || r.name, event: r.event,
      branch: r.head_branch, state: ghState(r.status, r.conclusion), url: r.html_url,
      created_at: r.created_at, updated_at: r.updated_at, jobs: null,
    })),
    jobs: (run) => `/actions/runs/${run.id}/jobs?per_page=100`,
    jobsOf: (json) => (json?.jobs ?? []).map((j) => ({ name: j.name, state: ghState(j.status, j.conclusion), url: j.html_url })),
    login: (host) => `run gh auth login${host === "github.com" ? "" : ` --hostname ${host}`}`,
  },
  forgejo: {
    name: "Forgejo",
    api: (host, owner, repo) => `https://${host}/api/v1/repos/${owner}/${repo}`,
    headers: (token) => ({ Authorization: `token ${token}`, Accept: "application/json" }),
    list: (kind, state, page) => kind === "pulls"
      ? `/pulls?state=${state}&limit=${PAGE}&page=${page}&sort=recentupdate`
      : `/issues?type=issues&state=${state}&limit=${PAGE}&page=${page}`,
    keep: () => true,
    blockers: (n) => `/issues/${n}/dependencies`,
    branches: (page) => `/branches?limit=${PAGE}&page=${page}`,
    blocks: (n) => `/issues/${n}/blocks`,
    // Forgejo lists jobs ("tasks"), newest first; a run is the jobs sharing a run number.
    runPages: 3,
    runs: (page) => `/actions/tasks?limit=${PAGE}&page=${page}`,
    runsOf: (json) => {
      const runs = new Map();
      for (const t of json?.workflow_runs ?? []) {
        const r = runs.get(t.run_number) ?? { id: t.run_number, number: t.run_number, title: t.display_title, workflow: t.workflow_id,
          event: t.event, branch: t.head_branch, url: t.url, created_at: t.created_at, updated_at: t.updated_at, jobs: [] };
        r.jobs.push({ name: t.name, state: FJ_STATE[t.status] ?? "waiting", url: t.url });
        if (t.created_at < r.created_at) r.created_at = t.created_at;
        if (t.updated_at > r.updated_at) r.updated_at = t.updated_at;
        runs.set(t.run_number, r);
      }
      return [...runs.values()];
    },
    jobs: null,
    login: () => "set FORGEJO_TOKEN or run fj auth login",
  },
};
const forgeOf = (repo) => FORGES[repo?.forge] ?? FORGES.forgejo;

// Run and job states, the same words for both forges.
const RUN_ORDER = ["running", "waiting", "failure", "cancelled", "success", "skipped"];
const FJ_STATE = { success: "success", failure: "failure", cancelled: "cancelled", skipped: "skipped", running: "running", waiting: "waiting", blocked: "waiting", unknown: "waiting" };
function ghState(status, conclusion) {
  if (status !== "completed") return status === "in_progress" ? "running" : "waiting";
  if (["failure", "timed_out", "startup_failure", "action_required"].includes(conclusion)) return "failure";
  if (conclusion === "cancelled" || conclusion === "stale") return "cancelled";
  if (conclusion === "skipped") return "skipped";
  return "success";
}
// A run is as bad as its worst job: running first, then waiting, failure, cancelled.
const runState = (r) => r.state ?? RUN_ORDER.find((s) => (r.jobs ?? []).some((j) => j.state === s)) ?? "waiting";
const KEEP_RUNS = 60;

// Label colors come as "e11d21" or "#e11d21".
const hex = (c) => `#${(c ?? "888888").replace(/^#/, "").slice(0, 6)}`;
const ago = (iso) => {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (!(d >= 0)) return "";
  return d < 3600 ? `${Math.max(1, Math.round(d / 60))}m` : d < 86400 ? `${Math.round(d / 3600)}h` : d < 86400 * 60 ? `${Math.round(d / 86400)}d` : `${Math.round(d / 86400 / 30)}mo`;
};
// A child issue opens with "Parte de #<parent>." (the repo's convention).
const parentOf = (body) => Number(/^\s*Parte de #(\d+)/m.exec(body ?? "")?.[1]) || null;

// The forge answers slowly (0.7 s a call, seconds for a list), so everything shown
// comes from a cache kept in localStorage first and is refreshed in the background.
const KEEP_DETAILS = 120; // issues/PRs whose full detail stays cached
const KEEP_PLACES = 100; // folders remembered with their repo
const PREFETCH = 10; // newest issues and PRs whose detail is read ahead
function stored(name, fallback) {
  try { const v = JSON.parse(localStorage.getItem(name) ?? "null"); return v && typeof v === "object" ? v : fallback; } catch { return fallback; }
}
function store(name, value) {
  try { localStorage.setItem(name, JSON.stringify(value)); } catch {}
}
// What the panel draws, not the API's whole answer (which is mostly repo objects).
const person = (u) => (u ? { login: u.login } : null);
const slim = (i, body = false) => ({
  number: i.number, title: i.title, state: i.state, draft: i.draft, merged: i.merged ?? Boolean(i.merged_at),
  html_url: i.html_url, created_at: i.created_at, updated_at: i.updated_at, comments: i.comments,
  user: person(i.user), assignees: (i.assignees ?? []).map(person),
  labels: (i.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
  milestone: i.milestone ? { title: i.milestone.title } : null,
  pull_request: i.pull_request ? {} : null,
  head: i.head ? { ref: i.head.ref, label: i.head.label, repo: { full_name: i.head.repo?.full_name } } : undefined,
  base: i.base ? { ref: i.base.ref, repo: { full_name: i.base.repo?.full_name } } : undefined,
  ...(body ? { body: i.body } : {}),
});
const slimRef = (n) => ({ number: n.number, title: n.title, state: n.state });
const slimComment = (c) => ({ id: c.id, body: c.body, created_at: c.created_at, updated_at: c.updated_at, user: person(c.user) });

export default class Repository extends View {
  init(_props, cx) {
    this.kind = "issues"; // "issues" | "pulls" | "branches" | "actions"
    this.state = "open";
    this.label = null;
    this.items = { issues: [], pulls: [] };
    this.more = { issues: false, pulls: false };
    this.detail = null; // { number, item, pull, comments, blockers, blocks, loading, cached }
    this.trail = []; // details opened before this one (Back returns there)
    this.branches = {}; // branch -> worktree path, for PR rows
    this.tokens = {};
    this.inflight = new Map(); // detail key -> its pending read, shared by prefetch and open
    this.folders = stored("folders", {}); // JSON [machine, folder] -> its repo (never the token)
    try { localStorage.removeItem("places"); } catch {}
    this.lists = stored("lists", {}); // `${api}|${state}` -> first page of issues and PRs
    this.trees = stored("branches", {}); // api -> branch -> worktree path
    this.remotes = stored("remotes", {}); // api -> the forge's branch names
    this.seen = stored("details", {}); // detail key -> when it was last read (the LRU order)
    this.actions = stored("actions", {}); // api -> recent workflow runs, newest first
    this.expanded = new Set(); // run ids whose jobs are shown
    this.jobsLoading = new Set(); // run ids whose jobs are being read
    this.workflow = null; // the Actions tab's workflow filter
    if (checking()) return;
    this.refresh(cx);
    cx.timer.every(POLL, (cx) => { if (!this.detail) this.refresh(cx, true); });
    // While a run is going, the Actions tab follows it more closely.
    cx.timer.every(15000, (cx) => {
      const r = this.repo;
      if (r && this.kind === "actions" && !this.detail && (this.actions[r.api] ?? []).some((x) => ["running", "waiting"].includes(runState(x))))
        this.loadActions(r, () => this.repo?.api === r.api, cx).catch(() => {});
    });
  }

  // The repo a location was last seen in: its first folder inside a known repo
  // folder (the deepest one wins). A guess, confirmed in the background.
  guess({ places, on }) {
    for (const place of places ?? []) {
      let best = null, length = -1;
      for (const [k, repo] of Object.entries(this.folders)) {
        const [m, folder] = JSON.parse(k);
        if ((m ?? null) !== (on ?? null)) continue;
        if ((place === folder || place.startsWith(folder + "/")) && folder.length > length) { best = repo; length = folder.length; }
      }
      if (best) return best;
    }
    return null;
  }

  remember(repo) {
    const place = { ...repo };
    delete place.token;
    delete place.from;
    for (const folder of new Set([repo.top, repo.from].filter(Boolean))) {
      const k = JSON.stringify([repo.on ?? null, folder]);
      delete this.folders[k];
      this.folders[k] = place;
    }
    for (const old of Object.keys(this.folders).slice(0, -KEEP_PLACES)) delete this.folders[old];
    store("folders", this.folders);
  }

  // What the cache holds for the shown repo and state; false when it has nothing.
  fromCache() {
    const entry = this.repo ? this.lists[`${this.repo.api}|${this.state}`] : null;
    this.items = { issues: entry?.issues ?? [], pulls: entry?.pulls ?? [] };
    this.more = entry?.more ?? { issues: false, pulls: false };
    this.branches = (this.repo && this.trees[this.repo.api]) || {};
    this.cached = Boolean(entry);
    return this.cached;
  }

  // The repo for the selected space: its origin remote, the forge's API and a token.
  async resolve(context) {
    const { places, on } = JSON.parse(context);
    if (!places?.length) throw new Error("No folder");
    let top = null;
    for (const cwd of places) {
      const r = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      if (r.code === 0) { top = r; top.from = cwd; break; }
    }
    if (!top) throw new Error("Not a git repository");
    const cwd = top.stdout.trim();
    const remote = await exec("git", ["remote", "get-url", "origin"], { cwd, on });
    if (remote.code !== 0) throw new Error("This repository has no origin remote");
    const r = parseRemote(remote.stdout);
    if (!r) throw new Error(`Can't read the origin remote: ${remote.stdout.trim()}`);
    const host = await this.realHost(r.host);
    const forge = await this.detect(host);
    const token = await this.token(forge, host);
    if (!token) throw new Error(`No ${FORGES[forge].name} token for ${host}: ${FORGES[forge].login(host)}`);
    return { ...r, host, forge, top: top.stdout.trim(), from: top.from, on, token, web: `https://${host}/${r.owner}/${r.repo}`, api: FORGES[forge].api(host, r.owner, r.repo) };
  }

  // An ssh remote may name a Host alias from ~/.ssh/config (github.com-work): its
  // real HostName is where the web and the API are.
  async realHost(host) {
    if (/^[\d.]+$/.test(host) || host === "github.com") return host;
    try {
      const r = await exec("ssh", ["-G", host]);
      const name = r.code === 0 ? /^hostname (\S+)$/m.exec(r.stdout)?.[1] : null;
      return name || host;
    } catch { return host; }
  }

  // github.com is GitHub; a host Forgejo's CLI knows is Forgejo; a host `gh` is
  // logged in to is GitHub Enterprise; anything else is taken for Forgejo.
  async detect(host) {
    this.forges ??= {};
    if (host in this.forges) return this.forges[host];
    let forge = "forgejo";
    if (host === "github.com") forge = "github";
    else if (!(await this.fjToken(host))) {
      try { if ((await exec("gh", ["auth", "token", "--hostname", host])).code === 0) forge = "github"; } catch {}
    }
    this.forges[host] = forge;
    return forge;
  }

  async env(name) {
    try {
      const r = await exec("sh", ["-c", `printf %s "$${name}"`]);
      return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    } catch { return null; }
  }

  async fjToken(host) {
    try {
      const raw = await readTextFile(`${home()}/${FJ_KEYS}`);
      return (raw && JSON.parse(raw)?.hosts?.[host]?.token) || null;
    } catch { return null; }
  }

  async token(forge, host) {
    const k = `${forge}|${host}`;
    if (k in this.tokens) return this.tokens[k];
    let token = null;
    if (forge === "github") {
      if (host === "github.com") token = (await this.env("GH_TOKEN")) || (await this.env("GITHUB_TOKEN"));
      if (!token) {
        try {
          const r = await exec("gh", ["auth", "token", "--hostname", host]);
          if (r.code === 0 && r.stdout.trim()) token = r.stdout.trim();
        } catch {}
      }
    } else {
      token = (await this.env("FORGEJO_TOKEN")) || (await this.fjToken(host));
    }
    this.tokens[k] = token;
    return token;
  }

  async get(path) {
    const r = this.repo;
    if (!r) throw new Error("No repository");
    const f = forgeOf(r);
    // A repo from the cache has no token yet: it is never stored.
    if (!r.token) r.token = await this.token(r.forge ?? "forgejo", r.host);
    if (!r.token) throw new Error(`No ${f.name} token for ${r.host}: ${f.login(r.host)}`);
    // A dropped connection (the forge busy or restarting, a network blip) is tried
    // again twice before it counts; an HTTP answer is never retried here.
    let res;
    for (let attempt = 1; ; attempt++) {
      try { res = await fetch(`${r.api}${path}`, { headers: f.headers(r.token) }); break; }
      catch (e) {
        if (attempt < 3) continue;
        const err = new Error(`Couldn't reach ${r.host}. Retrying…`);
        err.network = true;
        throw err;
      }
    }
    if (!res.ok) {
      let why = "";
      try { why = JSON.parse(await res.text())?.message ?? ""; } catch {}
      if (res.status === 401) { delete this.tokens[`${r.forge ?? "forgejo"}|${r.host}`]; r.token = null; throw new Error(`${f.name} refused the token (401)`); }
      if (res.status === 404) throw new Error(`${f.name} can't find this repository (404)`);
      // 403 is also GitHub's rate limit: the token stays.
      throw new Error(`${f.name} answered ${res.status}${why ? `: ${why}` : ""}`);
    }
    return res.json();
  }

  listPath(kind, page) {
    return forgeOf(this.repo).list(kind, this.state, page);
  }

  // quiet: a background poll, which keeps what is shown until the answer comes.
  refresh(cx, quiet = false) {
    const context = key();
    if (context !== this.context) {
      this.context = context; this.error = null; this.detail = null; this.trail = []; this.label = null;
      this.confirmed = false;
      const known = this.guess(JSON.parse(context));
      this.repo = known ? { ...known, token: this.tokens[`${known.forge ?? "forgejo"}|${known.host}`] ?? null } : null;
      this.fromCache();
    }
    // Only the latest load writes: one still running for a space you left (or a
    // poll) must neither show its answer nor keep the new one from starting.
    const gen = this.gen = (this.gen ?? 0) + 1;
    const current = () => this.gen === gen;
    const state = this.state;
    this.syncing = true;
    this.loading = !this.cached; // "Loading…" only when there is nothing to show yet
    cx.spawn(async (cx) => {
      try {
        if (!this.confirmed) {
          const repo = await this.resolve(context);
          if (!current()) return;
          const moved = repo.api !== this.repo?.api;
          this.repo = repo;
          this.confirmed = true;
          this.remember(repo);
          // The guess was another repo (or none): show what the cache has for this one.
          if (moved) { this.fromCache(); this.loading = !this.cached; cx.notify(); }
        }
        const repo = this.repo;
        const listKey = `${repo.api}|${state}`;
        // Every page, read one after another in the background. A complete list from
        // the cache stays up until the new one is whole (no shrinking to 50 and back);
        // otherwise rows appear page by page.
        const before = this.lists[listKey];
        const complete = Boolean(before) && !before.more?.issues && !before.more?.pulls;
        const all = { issues: [], pulls: [] }, more = { issues: true, pulls: true };
        const publish = (final) => {
          if (!final && complete) return;
          const entry = { issues: all.issues, pulls: all.pulls, more: { ...more } };
          this.lists[listKey] = entry;
          store("lists", this.lists);
          this.items = { issues: entry.issues, pulls: entry.pulls };
          this.more = entry.more;
          this.cached = true;
          this.error = null;
          this.loading = false;
          cx.notify();
        };
        let firsts = 0;
        const pages = async (kind) => {
          for (let p = 1; p <= MAX_PAGES && more[kind]; p++) {
            const got = await this.get(this.listPath(kind, p));
            if (!current()) return;
            const seen = new Set(all[kind].map((i) => i.number));
            all[kind].push(...got.filter((i) => !seen.has(i.number) && forgeOf(repo).keep(kind, i)).map((i) => slim(i)));
            more[kind] = got.length === PAGE;
            publish(false);
            // The newest rows are known once both first pages are in: read their details ahead.
            if (p === 1 && ++firsts === 2) this.prefetch(gen, cx);
          }
        };
        const branches = this.readBranches().then(() => {
          if (!current()) return;
          this.trees[repo.api] = this.branches;
          store("branches", this.trees);
          cx.notify();
        });
        const remote = (async () => {
          const names = [];
          for (let p = 1; p <= MAX_PAGES; p++) {
            const got = await this.get(forgeOf(repo).branches(p));
            if (!current()) return;
            names.push(...got.map((b) => b.name));
            if (got.length < PAGE) break;
          }
          this.remotes[repo.api] = names;
          store("remotes", this.remotes);
          cx.notify();
        })().catch(() => {});
        const actions = this.loadActions(repo, current, cx).catch(() => {});
        await Promise.all([pages("issues"), pages("pulls"), branches, remote, actions]);
        if (!current()) return;
        publish(true);
      } catch (e) {
        if (current()) {
          this.error = String(e.message ?? e);
          if (!this.cached) { this.items = { issues: [], pulls: [] }; this.more = { issues: false, pulls: false }; }
          // Unreachable: look again soon instead of waiting for the next poll.
          if (e.network) cx.timer.after(10000, (cx) => { if (this.gen === gen) { this.refresh(cx, true); cx.notify(); } });
        }
      }
      finally { if (current()) { this.loading = false; this.syncing = false; cx.notify(); } }
    });
    // No cx.notify() here: render() calls this when the selected space or its folder changes,
    // and notifying during render is refused. Callers in event handlers notify.
  }

  // ---- details: cached per issue, read ahead for the newest ones ----

  detailKey(n) { return `${this.repo?.api}#${n}`; }

  cachedDetail(n) {
    return this.repo ? stored(`detail:${this.detailKey(n)}`, null) : null;
  }

  // Whether a cached detail is behind the list: the forge bumps updated_at on edits
  // and comments.
  stale(i) {
    const c = this.cachedDetail(i.number);
    return !c || c.item?.updated_at !== i.updated_at;
  }

  // isPull: true/false when the list says, undefined when unknown (asks the issue).
  fetchDetail(n, isPull) {
    const k = this.detailKey(n);
    if (this.inflight.has(k)) return this.inflight.get(k);
    const read = (async () => {
      const [item, comments, blockers, blocks, early] = await Promise.all([
        this.get(`/issues/${n}`),
        this.get(`/issues/${n}/comments`),
        this.get(forgeOf(this.repo).blockers(n)).catch(() => []),
        this.get(forgeOf(this.repo).blocks(n)).catch(() => []),
        isPull === true ? this.get(`/pulls/${n}`).catch(() => null) : Promise.resolve(undefined),
      ]);
      let pull = early;
      if (pull === undefined) pull = isPull !== false && item.pull_request ? await this.get(`/pulls/${n}`).catch(() => null) : null;
      const d = { item: slim(item, true), pull: pull ? slim(pull) : null, comments: comments.map(slimComment), blockers: blockers.map(slimRef), blocks: blocks.map(slimRef) };
      store(`detail:${k}`, d);
      this.seen[k] = Date.now();
      const order = Object.keys(this.seen).sort((a, b) => this.seen[b] - this.seen[a]);
      for (const old of order.slice(KEEP_DETAILS)) {
        delete this.seen[old];
        try { localStorage.removeItem(`detail:${old}`); } catch {}
      }
      store("details", this.seen);
      return d;
    })();
    this.inflight.set(k, read);
    read.then(() => this.inflight.delete(k), () => this.inflight.delete(k));
    return read;
  }

  // The newest issues and PRs whose cached detail is missing or behind, two at a time,
  // stopping as soon as another load starts (a different space, a poll).
  prefetch(gen, cx) {
    const todo = [
      ...this.items.issues.slice(0, PREFETCH).map((i) => [i, false]),
      ...this.items.pulls.slice(0, PREFETCH).map((i) => [i, true]),
    ].filter(([i]) => this.stale(i));
    let next = 0;
    for (let w = 0; w < 2; w++) cx.spawn(async () => {
      while (next < todo.length && this.gen === gen) {
        const [i, pr] = todo[next++];
        await this.fetchDetail(i.number, pr).catch(() => {});
      }
    });
  }

  // Hovering a row starts its read, so the click usually finds it ready.
  warm(i, pr, cx) {
    if (!this.repo || !this.stale(i)) return;
    cx.spawn(async () => { await this.fetchDetail(i.number, pr).catch(() => {}); });
  }


  // Which PR branches already have a worktree here.
  async readBranches() {
    const r = this.repo;
    const list = await exec("git", ["worktree", "list", "--porcelain"], { cwd: r.top, on: r.on });
    const out = {};
    if (list.code === 0) for (const block of list.stdout.split(/\n\n+/)) {
      const lines = block.split("\n");
      const path = lines.find((l) => l.startsWith("worktree "))?.slice(9);
      const branch = lines.find((l) => l.startsWith("branch "))?.slice(7).replace(/^refs\/heads\//, "");
      if (path && branch) out[branch] = path;
    }
    this.branches = out;
  }

  // The space whose first terminal is in this checkout (or below it).
  spaceAt(path) {
    const ps = panes();
    const inside = (p) => p === path || p?.startsWith(path + "/");
    const nested = Object.values(this.branches).filter((p) => p !== path && p.startsWith(path + "/"));
    return spaces().find((s) => {
      if ((s.machine ?? null) !== (this.repo?.on ?? null)) return false;
      const tabs = new Set((s.tabs ?? []).map((t) => t.id));
      const at = ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
      return inside(at) && !nested.some((n) => at === n || at.startsWith(n + "/"));
    });
  }

  open(number, cx, back = true) {
    if (back && this.detail) this.trail.push(this.detail.number);
    const known = [...this.items.issues, ...this.items.pulls].find((i) => i.number === number);
    const cached = this.cachedDetail(number);
    const isPull = this.items.pulls.some((i) => i.number === number) || Boolean(cached?.pull)
      ? true : this.items.issues.some((i) => i.number === number) ? false : undefined;
    const context = this.context;
    // The cached copy shows at once; the read below replaces it when it lands.
    this.detail = cached
      ? { number, ...cached, loading: true, cached: true }
      : { number, item: known ?? null, pull: null, comments: [], blockers: [], blocks: [], loading: true, cached: false };
    cx.spawn(async (cx) => {
      try {
        const d = await this.fetchDetail(number, isPull);
        if (context !== this.context || this.detail?.number !== number) return;
        this.detail = { number, ...d, loading: false, cached: true };
      } catch (e) {
        if (this.detail?.number === number) this.detail = { ...this.detail, loading: false, error: String(e.message ?? e) };
      }
      cx.notify();
    });
    cx.notify();
  }

  back(cx) {
    const prev = this.trail.pop();
    if (prev) this.open(prev, cx, false);
    else this.detail = null;
    cx.notify();
  }

  browse(url) {
    const p = window()?.platform;
    if (p === "windows") exec("cmd", ["/c", "start", "", url]);
    else exec(p === "macos" ? "open" : "xdg-open", [url]);
  }

  // A PR's branch: go to its space, open one at its worktree, or make the worktree
  // (fetching the branch first so the shipped dialog checks it out instead of a new one).
  workOn(pull, cx) {
    const ref = pull.head?.ref;
    if (!ref || !this.repo) return;
    const path = this.branches[ref];
    if (path) {
      const s = this.spaceAt(path);
      if (s) run("space.select", { id: s.id });
      else run("space.new", { folder: path, machine: this.repo.on ?? "" });
      return;
    }
    const r = this.repo;
    this.note = `Fetching ${ref}…`;
    cx.spawn(async (cx) => {
      const fetched = await exec("git", ["fetch", "origin", `${ref}:${ref}`], { cwd: r.top, on: r.on, timeout: 120000 });
      const local = await exec("git", ["show-ref", "--verify", "--quiet", `refs/heads/${ref}`], { cwd: r.top, on: r.on });
      if (local.code !== 0) { this.note = `Couldn't fetch ${ref}: ${(fetched.stderr || fetched.stdout).trim()}`; cx.notify(); return; }
      this.note = null;
      const space = spaces().find((s) => s.active);
      openOverlay({ mod: "worktree", kind: "dialog", width: 440, height: 260, props: { space: space?.id, folder: r.top, action: "new", branch: ref } });
      cx.spawn(async (cx) => { await this.readBranches().catch(() => {}); cx.notify(); });
      cx.notify();
    });
    cx.notify();
  }

  chip(label, t) {
    const c = hex(label.color);
    return div().flex_none().px(5).h(16).flex().items_center().rounded(4).text_size(10)
      .border_1().border_color(c + "88").bg(c + "26").text_color(t.foreground).child(label.name);
  }

  shown() {
    const all = this.items[this.kind] ?? [];
    return this.label ? all.filter((i) => (i.labels ?? []).some((l) => l.name === this.label)) : all;
  }

  item(i, t, cx) {
    const pr = this.kind === "pulls";
    const ref = pr ? i.head?.ref : null;
    const tree = ref ? this.branches[ref] : null;
    const space = tree ? this.spaceAt(tree) : null;
    const who = (i.assignees ?? []).map((a) => a.login).join(", ") || i.user?.login || "";
    return v_flex().id(`item-${i.number}`).flex_none().px(8).py(6).gap(4).rounded(7).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(i.number, cx))
      .on_hover((hovered, cx) => { if (hovered) this.warm(i, pr, cx); })
      .child(h_flex().gap(6).items_start()
        .child(div().flex_none().text_color(t.dim).child(`#${i.number}`))
        .child(div().flex_1().min_w(0).child(i.title))
        .when(pr && i.draft, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("draft"))))
      .child(h_flex().gap(4).items_center().flex_wrap().text_size(10.5).text_color(t.dim)
        .children((i.labels ?? []).map((l) => this.chip(l, t)))
        .when(Boolean(ref), (el) => el.child(h_flex().gap(3).items_center().min_w(0)
          .child(svg("mods/workspace-chrome/git-branch.svg").size(11).flex_none())
          .child(div().max_w(180).truncate().child(ref))
          .when(Boolean(space), (el) => el.child(div().flex_none().text_color(t.accent).child(`· ${space.name}`)))
          .when(Boolean(tree) && !space, (el) => el.child(div().flex_none().child("· worktree")))))
        .child(div().flex_1())
        .when(Boolean(who), (el) => el.child(div().flex_none().max_w(110).truncate().child(who)))
        .when(i.comments > 0, (el) => el.child(div().flex_none().child(`${i.comments} ◦`)))
        .child(div().flex_none().child(ago(i.updated_at))));
  }

  ref(n, title, t, cx) {
    return h_flex().id(`ref-${n}`).gap(6).px(6).h(22).items_center().rounded(5).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.open(n.number ?? n, cx))
      .child(div().flex_none().text_color(n.state === "closed" ? t.dim : t.foreground).child(`#${n.number ?? n}`))
      .child(div().flex_1().min_w(0).truncate().text_color(n.state === "closed" ? t.dim : t.foreground).child(title ?? n.title ?? ""))
      .when(Boolean(n.state), (el) => el.child(div().flex_none().text_size(10).text_color(n.state === "closed" ? t.ansi2 : t.blocked).child(n.state)));
  }

  section(title, t) {
    return div().pt(10).pb(3).text_size(10.5).font_semibold().text_color(t.dim).child(title);
  }

  button(id, label, t, action, primary = false) {
    return div().id(id).h(26).px(10).flex().flex_none().items_center().rounded(6).text_size(11.5).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground)
      .hover((s) => s.bg(primary ? t.solid : t.hover)).on_click(action).child(label);
  }

  detailView(t, cx) {
    const d = this.detail, i = d.item, pull = d.pull;
    const parent = parentOf(i?.body);
    const openBlockers = d.blockers.filter((b) => b.state === "open");
    const ref = pull?.head?.ref;
    const sameRepo = pull && pull.head?.repo?.full_name === pull.base?.repo?.full_name;
    const tree = ref ? this.branches[ref] : null;
    const space = tree ? this.spaceAt(tree) : null;
    return v_flex().flex_1().min_h(0)
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().id("back").px(6).h(24).flex().items_center().rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.back(cx)).child("← Back"))
        .child(div().flex_1())
        .when(Boolean(i), (el) => el
          .child(this.button("copy", "Copy #", t, (_e, cx) => cx.write_to_clipboard(`#${i.number}`)))
          .child(this.button("browser", "Open in browser", t, () => this.browse(i.html_url)))))
      .child(div().flex_1().min_h(0).relative()
        .child(v_flex().id("repository-detail").absolute().inset_0().overflow_y_scroll().px(14).py(10).gap(2)
          .when(!i, (el) => el.child(div().text_color(t.dim).child(d.error || "Loading…")))
          .when(Boolean(i), (el) => el
            .child(h_flex().gap(6).items_start().text_size(14).font_semibold()
              .child(div().flex_none().text_color(t.dim).child(`#${i.number}`))
              .child(div().flex_1().min_w(0).child(i.title)))
            .child(h_flex().pt(4).gap(6).items_center().flex_wrap().text_size(11).text_color(t.dim)
              .child(div().px(6).h(18).flex().items_center().rounded(9).text_size(10.5)
                .bg(pull?.merged ? t.ansi5 + "33" : i.state === "open" ? t.ansi2 + "33" : t.raised)
                .child(pull?.merged ? "merged" : i.state))
              .child(div().child(`${i.user?.login ?? ""} · ${ago(i.created_at)}`))
              .when((i.assignees ?? []).length > 0, (el) => el.child(div().child(`→ ${(i.assignees ?? []).map((a) => a.login).join(", ")}`)))
              .when(Boolean(i.milestone), (el) => el.child(div().child(`◇ ${i.milestone.title}`))))
            .when((i.labels ?? []).length > 0, (el) => el.child(h_flex().pt(6).gap(4).flex_wrap().children(i.labels.map((l) => this.chip(l, t)))))
            .when(Boolean(pull), (el) => el.child(v_flex().mt(10).p(8).gap(6).rounded(7).border_1().border_color(t.border)
              .child(h_flex().gap(6).items_center().text_size(11.5)
                .child(svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none().text_color(t.dim))
                .child(div().min_w(0).truncate().child(`${pull.head?.label ?? ref} → ${pull.base?.ref ?? ""}`)))
              .when(sameRepo && Boolean(ref) && !pull.merged, (el) => el.child(h_flex().gap(6).items_center()
                .child(this.button("work", space ? `Go to ${space.name}` : tree ? "Open space at worktree" : "Create worktree", t, (_e, cx) => this.workOn(pull, cx), true))
                .when(Boolean(this.note), (el) => el.child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).child(this.note)))))))
            .when(Boolean(parent), (el) => el.child(this.section("PART OF", t)).child(this.ref(parent, null, t, cx)))
            .when(d.blockers.length > 0, (el) => el
              .child(this.section(openBlockers.length ? `BLOCKED BY · ${openBlockers.length} open` : "BLOCKED BY · all closed", t))
              .children(d.blockers.map((b) => this.ref(b, null, t, cx))))
            .when(d.blocks.length > 0, (el) => el.child(this.section("BLOCKS", t)).children(d.blocks.map((b) => this.ref(b, null, t, cx))))
            .child(div().mt(12).pt(10).border_t(1).border_color(t.border).text_size(12.5)
              .child(i.body?.trim() ? TextView.markdown(`body-${i.number}-${i.updated_at}`, i.body).w_full() : div().text_color(t.dim).child("No description.")))
            .when(d.loading && !d.cached, (el) => el.child(div().pt(10).text_color(t.dim).child("Loading comments…")))
            .when(Boolean(d.error) && Boolean(i), (el) => el.child(div().pt(10).text_size(11).text_color(t.ansi1).child(d.error)))
            .when(d.comments.length > 0, (el) => el.child(this.section(`COMMENTS · ${d.comments.length}`, t))
              .children(d.comments.map((c) => v_flex().mt(6).p(8).gap(4).rounded(7).border_1().border_color(t.border).text_size(12.5)
                .child(div().text_size(11).text_color(t.dim).child(`${c.user?.login ?? ""} · ${ago(c.created_at)}`))
                .child(TextView.markdown(`comment-${c.id}-${c.updated_at}`, c.body ?? "").w_full()))))))
        .child(Scrollbar.vertical("repository-detail").absolute().inset_0()));
  }

  // ---- actions ----

  async loadActions(repo, alive, cx) {
    const f = forgeOf(repo);
    let json = { workflow_runs: [] };
    try {
      for (let p = 1; p <= f.runPages; p++) {
        const got = await this.get(f.runs(p));
        if (!alive()) return;
        json.workflow_runs.push(...(got?.workflow_runs ?? []));
        if ((got?.workflow_runs ?? []).length < PAGE) break;
      }
    } catch (e) {
      if (!alive()) return;
      this.actionsError = /404/.test(String(e.message)) ? "Actions aren't enabled for this repository" : String(e.message ?? e);
      cx.notify();
      return;
    }
    const before = new Map((this.actions[repo.api] ?? []).map((r) => [r.id, r]));
    // Newest first by time: GitHub numbers runs per workflow, not per repository.
    const runs = f.runsOf(json).sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "") || b.number - a.number).slice(0, KEEP_RUNS).map((r) => {
      // Jobs read on demand (GitHub) stay while the run hasn't changed.
      const old = before.get(r.id);
      return r.jobs === null && old?.jobs && old.updated_at === r.updated_at ? { ...r, jobs: old.jobs } : r;
    });
    this.actions[repo.api] = runs;
    for (const old of Object.keys(this.actions).slice(0, -20)) delete this.actions[old];
    store("actions", this.actions);
    this.actionsError = null;
    // Expanded runs whose jobs are not known yet (GitHub) are read now.
    for (const r of runs) if (this.expanded.has(r.id) && r.jobs === null) this.loadJobs(r, cx);
    cx.notify();
  }

  loadJobs(run, cx) {
    const r = this.repo, f = forgeOf(r);
    if (!f.jobs || this.jobsLoading.has(run.id)) return;
    this.jobsLoading.add(run.id);
    cx.spawn(async (cx) => {
      try {
        const jobs = f.jobsOf(await this.get(f.jobs(run)));
        const list = this.actions[r.api] ?? [];
        const same = list.find((x) => x.id === run.id);
        if (same) { same.jobs = jobs; store("actions", this.actions); }
      } catch {}
      this.jobsLoading.delete(run.id);
      cx.notify();
    });
  }

  toggleRun(run, cx) {
    if (this.expanded.has(run.id)) this.expanded.delete(run.id);
    else { this.expanded.add(run.id); if (run.jobs === null) this.loadJobs(run, cx); }
    cx.notify();
  }

  stateMark(state, t, size = 12) {
    if (state === "running") return svg("mods/workspace-chrome/spinner.svg").size(size).flex_none().text_color(t.working).spin(900);
    const glyph = { success: "✓", failure: "✕", cancelled: "⊘", skipped: "–", waiting: "○" }[state] ?? "○";
    const color = { success: t.ansi2, failure: t.ansi1, waiting: t.blocked }[state] ?? t.dim;
    return div().w(size).flex_none().text_size(size).text_color(color).child(glyph);
  }

  actionsView(t) {
    const r = this.repo, runs = (r && this.actions[r.api]) || [];
    const shown = this.workflow ? runs.filter((x) => x.workflow === this.workflow) : runs;
    const prs = (r && this.lists[`${r.api}|open`]?.pulls) || [];
    return v_flex().id("repository-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
      .children(shown.map((run) => {
        const state = runState(run), open = this.expanded.has(run.id);
        // Forgejo names a PR run's branch "#518"; GitHub gives the branch, matched to an open PR.
        const prNumber = /^#(\d+)$/.exec(run.branch ?? "")?.[1] ?? prs.find((p) => p.head?.ref === run.branch)?.number;
        const pr = prNumber ? Number(prNumber) : null;
        const branch = pr && /^#/.test(run.branch ?? "") ? prs.find((p) => p.number === pr)?.head?.ref ?? null : run.branch;
        const tree = branch ? this.branches[branch] : null;
        const space = tree ? this.spaceAt(tree) : null;
        return v_flex().id(`run-${run.id}`).flex_none().rounded(7)
          .child(v_flex().id(`run-head-${run.id}`).px(8).py(6).gap(3).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => this.toggleRun(run, cx))
            .child(h_flex().gap(7).items_center()
              .child(this.stateMark(state, t))
              .child(div().flex_1().min_w(0).truncate().child(run.title ?? run.workflow))
              .child(div().flex_none().text_size(10.5).text_color(t.dim).child(`#${run.number}`))
              .child(div().id(`run-web-${run.id}`).flex_none().px(4).rounded(4).text_size(11).text_color(t.dim)
                .hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip("Open in browser")
                .on_click((_e, cx) => { cx.stop_propagation(); this.browse(run.url); }).child("↗")))
            .child(h_flex().pl(19).gap(6).items_center().text_size(10.5).text_color(t.dim)
              .child(div().flex_none().max_w(110).truncate().child(run.workflow ?? ""))
              .child(div().flex_none().child(run.event ?? ""))
              .when(Boolean(branch), (el) => el.child(div().flex_1().min_w(0).truncate().child(branch)))
              .when(!branch, (el) => el.child(div().flex_1()))
              .when(Boolean(space), (el) => el.child(div().flex_none().max_w(90).truncate().text_color(t.accent).child(space.name)))
              .when(Boolean(pr), (el) => el.child(div().id(`run-pr-${run.id}`).flex_none().px(5).h(16).flex().items_center().rounded(4)
                .bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover))
                .on_click((_e, cx) => { cx.stop_propagation(); this.open(pr, cx); }).child(`#${pr}`)))
              .child(div().flex_none().child(ago(run.updated_at)))))
          .when(open, (el) => el.child(v_flex().pl(27).pr(8).pb(6).gap(1)
            .when(run.jobs === null, (el) => el.child(div().h(22).flex().items_center().text_size(11).text_color(t.dim).child("Loading jobs…")))
            .children((run.jobs ?? []).map((j, i) => h_flex().id(`job-${run.id}-${i}`).h(24).px(6).gap(7).items_center().rounded(5)
              .text_size(11.5).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("Open in browser")
              .on_click(() => this.browse(j.url))
              .child(this.stateMark(j.state, t, 11))
              .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(j.name))))));
      }))
      .when(!shown.length, (el) => el.child(div().p(8).text_color(this.actionsError ? t.ansi1 : t.dim)
        .child(this.actionsError || (this.syncing ? "Loading…" : "No workflow runs"))));
  }

  // The forge's branches: each with its open PR and, when checked out here, its worktree's space.
  remoteView(t) {
    const r = this.repo, names = (r && this.remotes[r.api]) || [];
    const prs = ((r && this.lists[`${r.api}|open`]?.pulls) || []);
    const prOf = (name) => prs.find((p) => p.head?.ref === name);
    const rows = names.map((name) => ({ name, pr: prOf(name), tree: this.branches[name] }))
      .sort((a, b) => Number(Boolean(b.pr)) - Number(Boolean(a.pr)) || a.name.localeCompare(b.name));
    return v_flex().id("repository-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
      .children(rows.map(({ name, pr, tree }) => {
        const space = tree ? this.spaceAt(tree) : null;
        return h_flex().id(`rb-${name}`).flex_none().h(30).px(8).gap(6).items_center().rounded(7).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .tooltip(pr ? `#${pr.number} ${pr.title}` : space ? `Go to ${space.name}` : tree ? "Open a space at its worktree" : "Make a worktree for it")
          .on_click((_e, cx) => this.workOn({ head: { ref: name } }, cx))
          .child(svg("mods/workspace-chrome/git-branch.svg").size(12).flex_none().text_color(tree ? t.accent : t.dim))
          .child(div().flex_1().min_w(0).truncate().child(name))
          .when(Boolean(space), (el) => el.child(div().flex_none().max_w(100).truncate().text_size(10.5).text_color(t.accent).child(space.name)))
          .when(Boolean(pr), (el) => el.child(div().id(`rb-pr-${name}`).flex_none().px(5).h(18).flex().items_center().rounded(4).text_size(10.5)
            .bg(t.raised).text_color(t.foreground).hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); this.open(pr.number, cx); }).child(`#${pr.number}`)));
      }))
      .when(!rows.length, (el) => el.child(div().p(8).text_color(t.dim).child(this.syncing ? "Loading…" : "No branches")));
  }

  listView(t, cx) {
    const other = this.kind === "branches" || this.kind === "actions";
    const shown = other ? [] : this.shown();
    const runs = (this.repo && this.actions[this.repo.api]) || [];
    const running = runs.filter((x) => runState(x) === "running").length;
    const workflows = [...new Set(runs.map((x) => x.workflow).filter(Boolean))].sort();
    const labels = [...new Set((this.items[this.kind] ?? []).flatMap((i) => (i.labels ?? []).map((l) => l.name)))].sort();
    const colorOf = Object.fromEntries((this.items[this.kind] ?? []).flatMap((i) => (i.labels ?? []).map((l) => [l.name, l.color])));
    // Tabs only on the first row (scrolling sideways when the panel is narrower);
    // open/closed moves down to the filter row.
    const tab = (id, label, count, extra) => {
      const on = this.kind === id;
      return h_flex().id(`kind-${id}`).h(26).px(7).gap(4).flex_none().items_center().rounded(6).cursor_pointer().text_size(12)
        .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.kind = id; this.label = null; cx.notify(); })
        .child(label)
        .when(count !== null, (el) => el.child(div().text_size(10.5).text_color(t.dim).child(`${count}${this.more[id] ? "+" : ""}`)))
        .when(Boolean(extra), extra);
    };
    const segment = (id) => {
      const on = this.state === id;
      return div().id(`state-${id}`).px(7).h_full().flex().items_center().text_size(10.5).cursor_pointer()
        .bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.dim).hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => { if (this.state !== id) { this.state = id; this.label = null; this.fromCache(); this.refresh(cx); cx.notify(); } })
        .child(id);
    };
    return v_flex().flex_1().min_h(0)
      .child(h_flex().id("kinds").h(38).flex_none().px(6).gap(2).items_center().overflow_x_scroll().border_b(1).border_color(t.border)
        .child(tab("issues", "Issues", this.items.issues.length))
        .child(tab("pulls", "Pull requests", this.items.pulls.length))
        .child(tab("branches", "Branches", ((this.repo && this.remotes[this.repo.api]) || []).length))
        .child(tab("actions", "Actions", null, (el) => el.when(running > 0, (el) => el
          .child(svg("mods/workspace-chrome/spinner.svg").size(10).text_color(t.working).spin(900))
          .child(div().text_size(10.5).text_color(t.dim).child(String(running)))))))
      .when(!other, (el) => el.child(h_flex().flex_none().px(8).py(6).gap(4).flex_wrap().items_center().border_b(1).border_color(t.border)
        .child(h_flex().h(20).flex_none().rounded(5).overflow_hidden().border_1().border_color(t.border)
          .child(segment("open")).child(div().w(1).h_full().bg(t.border)).child(segment("closed")))
        .when(labels.length > 0, (el) => el.child(div().w(1).h(14).mx(2).flex_none().bg(t.border)))
        .children(labels.map((name) => {
          const on = this.label === name, c = hex(colorOf[name]);
          return div().id(`label-${name}`).px(6).h(18).flex().items_center().rounded(4).text_size(10.5).cursor_pointer()
            .border_1().border_color(on ? c : t.border).bg(on ? c + "33" : t.background).text_color(on ? t.foreground : t.muted)
            .hover((s) => s.border_color(c)).on_click((_e, cx) => { this.label = on ? null : name; cx.notify(); }).child(name);
        }))))
      .when(this.kind === "actions" && workflows.length > 1, (el) => el.child(h_flex().flex_none().px(8).py(6).gap(4).flex_wrap().border_b(1).border_color(t.border)
        .children(workflows.map((name) => {
          const on = this.workflow === name;
          return div().id(`wf-${name}`).px(6).h(18).flex().items_center().rounded(4).text_size(10.5).cursor_pointer()
            .border_1().border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background).text_color(on ? t.foreground : t.muted)
            .hover((s) => s.border_color(t.accent)).on_click((_e, cx) => { this.workflow = on ? null : name; cx.notify(); }).child(name);
        }))))
      .child(div().flex_1().min_h(0).relative()
        .when(this.kind === "branches", (el) => el.child(this.remoteView(t)))
        .when(this.kind === "actions", (el) => el.child(this.actionsView(t)))
        .when(!other, (el) => el.child(v_flex().id("repository-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1)
          .children(shown.map((i) => this.item(i, t, cx)))
          .when(!shown.length, (el) => el.child(div().p(8).text_color(this.error && !/^(Not a git repository|No folder)$/.test(this.error) ? t.ansi1 : t.dim)
            .child(this.error || (this.loading ? "Loading…" : this.label ? `Nothing labelled ${this.label} here` : `No ${this.state} ${this.kind === "pulls" ? "pull requests" : "issues"}`))))
          .when(this.more[this.kind] && this.syncing && shown.length > 0, (el) => el.child(h_flex().mt(4).h(28).gap(6).items_center().justify_center()
            .text_size(11.5).text_color(t.dim)
            .child(svg("mods/workspace-chrome/spinner.svg").size(11).spin(900)).child("Loading the rest…")))))
        .child(Scrollbar.vertical("repository-list").absolute().inset_0()));
  }

  render(cx) {
    if (!checking() && key() !== this.context) this.refresh(cx);
    const t = theme(), r = this.repo;
    return v_flex().id("repository").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(12.5)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Repository"))
        .when(Boolean(r), (el) => el.child(div().id("repo").min_w(0).px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).truncate()
          .cursor_pointer().on_click(() => this.browse(`${r.web}/${this.kind === "pulls" ? "pulls" : this.kind === "actions" ? "actions" : this.kind === "branches" ? "branches" : "issues"}`)).child(`${forgeOf(r).name} · ${r.owner}/${r.repo}`)))
        .child(div().flex_1())
        .when(this.error && Boolean(r), (el) => el.child(div().flex_none().max_w(140).truncate().text_size(10.5).text_color(t.ansi1).child(this.error)))
        .child(div().id("reload").size(24).flex().flex_none().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => { this.tokens = {}; this.forges = {}; if (this.repo) this.repo.token = null; if (this.detail) this.open(this.detail.number, cx, false); this.refresh(cx); cx.notify(); })
          .tooltip(this.syncing || this.detail?.loading ? "Updating from Forgejo…" : "Reload")
          .child(this.syncing || this.detail?.loading ? svg("mods/workspace-chrome/spinner.svg").size(12).spin(900) : "↻")))
      .child(this.detail ? this.detailView(t, cx) : this.listView(t, cx));
  }
}
