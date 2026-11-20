// Issues and pull requests of the repo the selected space is in, from its forge's
// REST API: GitHub (github.com, or a host `gh` is logged in to) or Forgejo (any
// other host). Read-only: it never writes to the forge. Tokens: GitHub uses
// $GH_TOKEN / $GITHUB_TOKEN (github.com only), else `gh auth token`; Forgejo uses
// $FORGEJO_TOKEN, else the one `fj auth login` saved. A token only goes to its forge.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView, InputState, Input, ScrollHandle } from "gpui-base";
import { spaces, panes, exec, readTextFile, theme, home, run, openOverlay, checking, window, notify } from "herdr";

// A space whose folder was deleted (a removed worktree): a plain message, not exec's error.
const GONE = "This space's folder was deleted";
const friendly = (e) => { const m = String(e?.message ?? e); return /cannot run git: No such file or directory|cannot change to/i.test(m) ? GONE : m; };

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
// Time tracking: a clock for a running timer, a duration for tracked time.
const pad = (n) => String(n).padStart(2, "0");
const clock = (s) => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`; };
const duration = (s) => { s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60); return h ? `${h}h ${pad(m)}m` : m ? `${m}m` : `${s}s`; };

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
    // Issue timers, kept here until they are finished and sent to the forge as tracked time:
    // `${api}#${n}` -> { key, api, host, forge, number, title, first, started, acc, error }.
    this.timers = stored("timers", {});
    this.sending = new Set();
    // Search across the shown tab: open with the magnifier, Esc closes it.
    this.query = "";
    this.searching = false;
    this.search = InputState.new({ placeholder: "Search" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value(); cx.notify(); });
    this.search.on("submit", (_e, cx) => this.enterList(cx));
    // Keyboard selection in the shown list: -1 is none; the list holds the keyboard while >= 0.
    this.cursor = -1;
    this.listHandle = cx.focus_handle();
    this.detailHandle = cx.focus_handle();
    this.listScroll = ScrollHandle.new();
    this.expanded = new Set(); // run ids whose jobs are shown
    this.jobsLoading = new Set(); // run ids whose jobs are being read
    this.workflow = null; // the Actions tab's workflow filter
    if (checking()) return;
    // A running timer's clock (data, not animation): once a second, only while one runs.
    cx.timer.every(1000, (cx) => { if (Object.values(this.timers).some((x) => x.started)) cx.notify(); });
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
      try {
        res = await fetch(`${r.api}${path}`, { headers: f.headers(r.token) });
        // A renewed login (gh auth / fj auth) leaves the remembered token stale: read it again once.
        if (res.status === 401 && attempt === 1) {
          const k = `${r.forge ?? "forgejo"}|${r.host}`, old = r.token;
          delete this.tokens[k];
          r.token = await this.token(r.forge ?? "forgejo", r.host);
          if (r.token && r.token !== old) continue;
        }
        break;
      }
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
          this.error = friendly(e);
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
      const times = this.repo?.forge === "forgejo" ? await this.get(`/issues/${n}/times`).catch(() => null) : null;
      let pull = early;
      if (pull === undefined) pull = isPull !== false && item.pull_request ? await this.get(`/pulls/${n}`).catch(() => null) : null;
      const spent = {};
      for (const x of times ?? []) spent[x.user_name ?? "?"] = (spent[x.user_name ?? "?"] ?? 0) + (x.time ?? 0);
      const d = { item: slim(item, true), pull: pull ? slim(pull) : null, comments: comments.map(slimComment), blockers: blockers.map(slimRef), blocks: blocks.map(slimRef),
        spent: times ? Object.entries(spent).map(([user, seconds]) => ({ user, seconds })).sort((a, b) => b.seconds - a.seconds) : null };
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
    else {
      this.detail = null;
      if (this.cursor >= 0) cx.timer.after(30, () => this.listHandle.focus());
    }
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

  // Every word of the search must appear in one of the item's fields.
  matches(...fields) {
    const words = this.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const text = fields.flat().filter((x) => x !== null && x !== undefined).join(" ").toLowerCase();
    return words.every((w) => text.includes(w.replace(/^#(?=\d)/, "")));
  }

  shown() {
    const all = this.items[this.kind] ?? [];
    const labelled = this.label ? all.filter((i) => (i.labels ?? []).some((l) => l.name === this.label)) : all;
    return labelled.filter((i) => this.matches(`#${i.number}`, String(i.number), i.title, (i.labels ?? []).map((l) => l.name),
      i.user?.login, (i.assignees ?? []).map((a) => a.login), i.head?.ref, i.milestone?.title));
  }

  // What Enter does for each row of the shown list, in order.
  visible() {
    if (this.kind === "branches") return this.branchRows().map((b) => (cx) => this.workOn({ head: { ref: b.name } }, cx));
    if (this.kind === "actions") return this.actionRows().map((run) => (cx) => this.toggleRun(run, cx));
    return this.shown().map((i) => (cx) => { this.open(i.number, cx); cx.timer.after(30, () => this.detailHandle.focus()); });
  }

  // Enter or Down in the search: highlight the first row and give the list the keyboard.
  enterList(cx) {
    if (!this.visible().length) return;
    this.cursor = 0;
    this.listHandle.focus();
    this.listScroll.scroll_to_item(0);
    cx.notify();
  }

  moveCursor(dir) {
    const n = this.visible().length;
    if (!n) { this.cursor = -1; return; }
    if (dir < 0 && this.cursor <= 0) { this.cursor = -1; if (this.searching) this.search.focus(); return; }
    this.cursor = Math.min(Math.max(this.cursor + dir, 0), n - 1);
    this.listScroll.scroll_to_item(this.cursor);
  }

  listBox(el) {
    return el.track_focus(this.listHandle).track_scroll(this.listScroll).on_key_down((e, cx) => {
      if (this.cursor < 0) return;
      if (e.key === "down" || e.key === "up") this.moveCursor(e.key === "down" ? 1 : -1);
      else if (e.key === "enter") { cx.stop_propagation(); this.visible()[this.cursor]?.(cx); cx.notify(); return; }
      else if (e.key === "escape") { this.cursor = -1; if (this.searching) this.search.focus(); }
      else return;
      cx.stop_propagation();
      cx.notify();
    });
  }

  closeSearch(cx) {
    this.searching = false; this.query = ""; this.search.set_value("");
    cx.notify();
  }

  // ---- time tracking (Forgejo) ----

  tracks() { return this.repo?.forge === "forgejo"; }
  timerKey(n, api = this.repo?.api) { return `${api}#${n}`; }
  elapsed(x) { return (x.acc ?? 0) + (x.started ? (Date.now() - x.started) / 1000 : 0); }
  saveTimers() { store("timers", this.timers); }

  // One timer runs at a time: starting another pauses the one running.
  startTimer(i, cx) {
    const r = this.repo;
    if (!r) return;
    const now = Date.now();
    for (const x of Object.values(this.timers)) if (x.started) { x.acc = this.elapsed(x); x.started = null; }
    const k = this.timerKey(i.number);
    const x = this.timers[k] ?? { key: k, api: r.api, host: r.host, forge: r.forge ?? "forgejo", web: r.web, number: i.number, title: i.title, first: now, acc: 0 };
    x.started = now; x.error = null; x.title = i.title ?? x.title;
    this.timers[k] = x;
    this.saveTimers();
    cx.notify();
  }

  pauseTimer(k, cx) {
    const x = this.timers[k];
    if (!x?.started) return;
    x.acc = this.elapsed(x); x.started = null;
    this.saveTimers();
    cx.notify();
  }

  discardTimer(k, cx) {
    delete this.timers[k];
    this.saveTimers();
    cx.notify();
  }

  // Stop it and send its whole time to the issue as one tracked-time entry.
  finishTimer(k, cx) {
    const x = this.timers[k];
    if (!x || this.sending.has(k)) return;
    if (x.started) { x.acc = this.elapsed(x); x.started = null; }
    const seconds = Math.round(x.acc);
    this.saveTimers();
    if (seconds < 1) { this.discardTimer(k, cx); return; }
    this.sending.add(k);
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const send = async (token) => fetch(`${x.api}/issues/${x.number}/times`, {
          method: "POST",
          headers: { ...FORGES.forgejo.headers(token), "Content-Type": "application/json" },
          body: JSON.stringify({ time: seconds, created: new Date(x.first).toISOString() }),
        });
        let token = await this.token(x.forge, x.host);
        if (!token) throw new Error(`No Forgejo token for ${x.host}`);
        let res = await send(token);
        if (res.status === 401) {
          delete this.tokens[`${x.forge}|${x.host}`];
          const fresh = await this.token(x.forge, x.host);
          if (fresh && fresh !== token) res = await send(fresh);
        }
        if (!res.ok) {
          let why = "";
          try { why = JSON.parse(await res.text())?.message ?? ""; } catch {}
          throw new Error(`Forgejo answered ${res.status}${why ? `: ${why}` : ""}`);
        }
        delete this.timers[k];
        this.saveTimers();
        notify({ title: `${duration(seconds)} sent to #${x.number}`, body: x.title, level: "success", timeout: 4000 });
        // The issue's tracked time on screen catches up.
        if (this.detail?.number === x.number && this.repo?.api === x.api) this.open(x.number, cx, false);
      } catch (e) {
        if (this.timers[k]) { this.timers[k].error = String(e.message ?? e); this.saveTimers(); }
      }
      this.sending.delete(k);
      cx.notify();
    });
  }

  iconButton(id, icon, tip, color, t, action) {
    return div().id(id).size(22).flex().flex_none().items_center().justify_center().rounded(5).cursor_pointer().text_color(color)
      .hover((s) => s.bg(t.raised)).tooltip(tip)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); action(cx); })
      .child(svg(icon.includes("/") ? icon : `mods/repository/${icon}.svg`).size(12));
  }

  // ▶ for an issue with no timer; clock with ⏸/▶ and ■ for one that has.
  timerControls(i, t, idp) {
    const k = this.timerKey(i.number), x = this.timers[k];
    if (!x) return h_flex().flex_none().child(this.iconButton(`${idp}-start`, "play", "Start tracking time", t.dim, t, (cx) => this.startTimer(i, cx)));
    const sending = this.sending.has(k);
    return h_flex().flex_none().gap(1).items_center()
      .child(div().flex_none().px(4).text_size(11).font_family("JetBrains Mono").text_color(x.error ? t.ansi1 : x.started ? t.accent : t.muted)
        .tooltip(x.error ? `Not sent: ${x.error}` : x.started ? "Tracking" : "Paused").child(sending ? "sending…" : clock(this.elapsed(x))))
      .child(x.started
        ? this.iconButton(`${idp}-pause`, "pause", "Pause", t.accent, t, (cx) => this.pauseTimer(k, cx))
        : this.iconButton(`${idp}-resume`, "play", "Resume", t.muted, t, (cx) => this.startTimer(i, cx)))
      .child(this.iconButton(`${idp}-stop`, "stop", "Stop and send the time to Forgejo", t.ansi1, t, (cx) => this.finishTimer(k, cx)));
  }

  // Every timer, from any repo, so one left running elsewhere is never forgotten.
  timerStrip(t) {
    const list = Object.values(this.timers).sort((a, b) => Number(Boolean(b.started)) - Number(Boolean(a.started)) || b.first - a.first);
    if (!list.length) return null;
    return v_flex().flex_none().px(8).py(4).gap(1).border_b(1).border_color(t.border).bg(t.chrome)
      .children(list.map((x) => {
        const here = this.repo?.api === x.api;
        const repoName = x.api.split("/repos/")[1] ?? "";
        return h_flex().id(`tm-${x.key}`).h(26).px(4).gap(6).items_center().rounded(5)
          .when(here, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(x.number, cx)))
          .child(div().size(6).flex_none().rounded(3).bg(x.error ? t.ansi1 : x.started ? t.accent : t.dim))
          .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${x.number}`))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).child(x.title ?? ""))
          .when(!here, (el) => el.child(div().flex_none().max_w(110).truncate().text_size(10.5).text_color(t.dim).child(repoName)))
          .child(this.timerControls({ number: x.number, title: x.title }, t, `strip-${x.number}`))
          .when(!x.started, (el) => el.child(this.iconButton(`tm-x-${x.number}-${repoName}`, "mods/workspace-chrome/x.svg", "Discard without sending", t.dim, t, (cx) => this.discardTimer(x.key, cx))));
      }));
  }

  item(i, t, cx, n = -1) {
    const pr = this.kind === "pulls";
    const ref = pr ? i.head?.ref : null;
    const tree = ref ? this.branches[ref] : null;
    const space = tree ? this.spaceAt(tree) : null;
    const who = (i.assignees ?? []).map((a) => a.login).join(", ") || i.user?.login || "";
    return v_flex().id(`item-${i.number}`).flex_none().px(8).py(6).gap(4).rounded(7).cursor_pointer()
      .when(n === this.cursor, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => this.open(i.number, cx))
      .on_hover((hovered, cx) => { if (hovered) this.warm(i, pr, cx); })
      .child(h_flex().gap(6).items_start()
        .child(div().flex_none().text_color(t.dim).child(`#${i.number}`))
        .child(div().flex_1().min_w(0).child(i.title))
        .when(pr && i.draft, (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child("draft")))
        .when(!pr && this.tracks(), (el) => el.child(this.timerControls(i, t, `row-${i.number}`))))
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
    return v_flex().flex_1().min_h(0).track_focus(this.detailHandle)
      .on_key_down((e, cx) => { if (e.key === "escape") { cx.stop_propagation(); this.back(cx); } })
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().id("back").px(6).h(24).flex().items_center().rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
          .on_click((_e, cx) => this.back(cx)).child("← Back"))
        .child(div().flex_1())
        .when(Boolean(i) && !pull && this.tracks() && !i.pull_request, (el) => el.child(this.timerControls(i, t, `detail-${i.number}`)))
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
            .when(Boolean(d.spent?.length), (el) => el.child(h_flex().pt(6).gap(6).items_center().flex_wrap().text_size(11).text_color(t.dim)
              .child(div().flex_none().child(`Spent ${duration(d.spent.reduce((n, x) => n + x.seconds, 0))}`))
              .when(d.spent.length > 1 || d.spent[0].user, (el) => el.children(d.spent.map((x) => div().flex_none().text_color(t.muted).child(`${x.user} ${duration(x.seconds)}`))))))
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

  actionRows() {
    const r = this.repo, runs = (r && this.actions[r.api]) || [];
    return (this.workflow ? runs.filter((x) => x.workflow === this.workflow) : runs)
      .filter((x) => this.matches(x.title, x.workflow, x.branch, x.event, `#${x.number}`, String(x.number), (x.jobs ?? []).map((j) => j.name)));
  }

  actionsView(t) {
    const r = this.repo, shown = this.actionRows();
    const prs = (r && this.lists[`${r.api}|open`]?.pulls) || [];
    return this.listBox(v_flex().id("repository-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1))
      .children(shown.map((run, n) => {
        const state = runState(run), open = this.expanded.has(run.id);
        // Forgejo names a PR run's branch "#518"; GitHub gives the branch, matched to an open PR.
        const prNumber = /^#(\d+)$/.exec(run.branch ?? "")?.[1] ?? prs.find((p) => p.head?.ref === run.branch)?.number;
        const pr = prNumber ? Number(prNumber) : null;
        const branch = pr && /^#/.test(run.branch ?? "") ? prs.find((p) => p.number === pr)?.head?.ref ?? null : run.branch;
        const tree = branch ? this.branches[branch] : null;
        const space = tree ? this.spaceAt(tree) : null;
        return v_flex().id(`run-${run.id}`).flex_none().rounded(7).when(n === this.cursor, (el) => el.bg(t.selected))
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
        .child(this.actionsError || (this.query.trim() ? "Nothing matches the search" : this.syncing ? "Loading…" : "No workflow runs"))));
  }

  // The forge's branches: each with its open PR and, when checked out here, its worktree's space.
  branchRows() {
    const r = this.repo, names = (r && this.remotes[r.api]) || [];
    const prs = ((r && this.lists[`${r.api}|open`]?.pulls) || []);
    const prOf = (name) => prs.find((p) => p.head?.ref === name);
    return names.map((name) => ({ name, pr: prOf(name), tree: this.branches[name] }))
      .filter(({ name, pr, tree }) => this.matches(name, pr ? [`#${pr.number}`, pr.title] : null, tree ? this.spaceAt(tree)?.name : null))
      .sort((a, b) => Number(Boolean(b.pr)) - Number(Boolean(a.pr)) || a.name.localeCompare(b.name));
  }

  remoteView(t) {
    const rows = this.branchRows();
    return this.listBox(v_flex().id("repository-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1))
      .children(rows.map(({ name, pr, tree }, n) => {
        const space = tree ? this.spaceAt(tree) : null;
        return h_flex().id(`rb-${name}`).flex_none().h(30).px(8).gap(6).items_center().rounded(7).cursor_pointer()
          .when(n === this.cursor, (el) => el.bg(t.selected))
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
      .when(!rows.length, (el) => el.child(div().p(8).text_color(t.dim).child(this.query.trim() ? "Nothing matches the search" : this.syncing ? "Loading…" : "No branches")));
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
          .child(div().text_size(10.5).text_color(t.dim).child(String(running))))))
        .child(div().flex_1())
        .child(div().id("search-toggle").size(26).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer()
          .bg(this.searching ? t.selected : t.background).text_color(this.searching || this.query ? t.foreground : t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Search")
          .on_click((_e, cx) => {
            if (this.searching) return this.closeSearch(cx);
            this.searching = true;
            cx.timer.after(30, () => this.search.focus());
            cx.notify();
          })
          .child(svg("mods/workspace-chrome/search.svg").size(14))))
      .when(this.searching, (el) => el.child(h_flex().flex_none().px(8).py(6).gap(6).items_center().border_b(1).border_color(t.border)
        .on_key_down((e, cx) => {
          if (e.key === "escape") { cx.stop_propagation(); this.closeSearch(cx); }
          else if (e.key === "down") { cx.stop_propagation(); this.enterList(cx); }
        })
        .child(h_flex().id("search-box").flex_1().min_w(0).h(28).px(8).gap(6).items_center().rounded(6).border_1().border_color(t.accent).bg(t.background)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(svg("mods/workspace-chrome/search.svg").size(12).flex_none().text_color(t.dim))
          .child(Input.new(this.search).flex_1().h_full().text_size(12).text_color(t.foreground)))
        .child(div().id("search-close").size(22).flex().flex_none().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close search (Esc)")
          .on_click((_e, cx) => this.closeSearch(cx))
          .child(svg("mods/workspace-chrome/x.svg").size(12)))))
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
        .when(!other, (el) => el.child(this.listBox(v_flex().id("repository-list").absolute().inset_0().overflow_y_scroll().p(6).gap(1))
          .children(shown.map((i, n) => this.item(i, t, cx, n)))
          .when(!shown.length, (el) => el.child(div().p(8).text_color(this.error && !/^(Not a git repository|No folder|This space's folder was deleted)$/.test(this.error) ? t.ansi1 : t.dim)
            .child(this.error || (this.loading ? "Loading…" : this.query.trim() ? "Nothing matches the search" : this.label ? `Nothing labelled ${this.label} here` : `No ${this.state} ${this.kind === "pulls" ? "pull requests" : "issues"}`))))
          .when(this.more[this.kind] && this.syncing && shown.length > 0, (el) => el.child(h_flex().mt(4).h(28).gap(6).items_center().justify_center()
            .text_size(11.5).text_color(t.dim)
            .child(svg("mods/workspace-chrome/spinner.svg").size(11).spin(900)).child("Loading the rest…")))))
        .child(Scrollbar.vertical("repository-list").absolute().inset_0()));
  }

  render(cx) {
    if (!checking() && key() !== this.context) this.refresh(cx);
    const listKey = [this.kind, this.state, this.label, this.workflow, this.query, this.repo?.api].join("|");
    if (listKey !== this.listKey) { this.listKey = listKey; this.cursor = -1; }
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
      .when(Object.keys(this.timers).length > 0, (el) => el.child(this.timerStrip(t)))
      .child(this.detail ? this.detailView(t, cx) : this.listView(t, cx));
  }
}
