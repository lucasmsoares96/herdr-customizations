// Agent resume after a restart, following the Herdr TUI's rules (herdr.dev, "Session state and
// restore"): with [session] resume_agents_on_restore (default true) in ~/.config/herdr/config.toml,
// every supported agent pane that had a native session comes back in it, startup_per_agent_delay_ms
// (default 100) apart; missing, stale or duplicated session references stay plain shells.
//
// herdr-core gives a lost terminal (reboot, core crash) a shell in its folder and never reruns its
// program. So while an agent runs, its session reference is kept on its terminal as labels
// (agent-resume.agent / .session / .cwd / .holder, the core holder holding the terminal). When that
// holder is gone, the terminal was lost and its fresh shell gets the agent's resume command, once.
// An agent that exits back to the shell while the holder lives drops its reference, as in the TUI.
//
// Session references come from what each agent writes itself, no hooks:
//   claude    ~/.claude/sessions/<pid>.json                    claude --resume <id>
//   codex     its newest top-level rollout for the folder          codex resume <id>
//   opencode  its newest top-level session for the folder        opencode --session <id>
//   pi        the session file it holds open (~/.pi/agent)       pi --session <path>

import { hc, exec, terminals, notify, readTextFile, home } from "herdr";

const SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh", "fish", "nu", "pwsh", "powershell"]);
const LABELS = ["agent-resume.agent", "agent-resume.session", "agent-resume.cwd", "agent-resume.holder"];
const AGENTS = {
  claude: { names: ["claude", "claude-code"], argv: (s) => ["claude", "--resume", s] },
  codex: { names: ["codex"], argv: (s) => ["codex", "resume", s] },
  opencode: { names: ["opencode"], argv: (s) => ["opencode", "--session", s] },
  pi: { names: ["pi"], argv: (s) => ["pi", "--session", s] },
};
const agentOf = (name) => Object.keys(AGENTS).find((k) => AGENTS[k].names.includes(name)) ?? null;
// A recovered shell shows its prompt and a few startup lines; more means someone used it.
const FRESH_LINES = 8;

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const pause = (ms) => exec("sleep", [String(ms / 1000)]).catch(() => null);
async function hcJson(args) {
  const r = await hc(args);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}
async function sh(script, ...args) {
  try { const r = await exec("sh", ["-c", script, "sh", ...args]); return r.code === 0 ? r.stdout.trim() : ""; } catch { return ""; }
}

// The TUI's [session] keys, from its own config file.
async function settings() {
  const text = (await readTextFile(`${home()}/.config/herdr/config.toml`).catch(() => null)) ?? "";
  const section = /^\[session\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(text)?.[1] ?? "";
  const value = (key) => new RegExp(`^\\s*${key}\\s*=\\s*([^#\\n]+)`, "m").exec(section)?.[1]?.trim();
  const delay = Number(value("startup_per_agent_delay_ms"));
  return { enabled: value("resume_agents_on_restore") !== "false", delay: Number.isFinite(delay) && delay >= 0 ? delay : 100 };
}

// The session a running agent is in, from files the agent writes itself.
async function sessionOf(agent, pid, cwd) {
  if (agent === "claude") {
    const s = JSON.parse((await readTextFile(`${home()}/.claude/sessions/${pid}.json`).catch(() => null)) ?? "null");
    return s?.sessionId ? { session: s.sessionId, cwd: s.cwd || cwd } : null;
  }
  if (agent === "codex") {
    // Codex runs threads in a shared daemon, so the folder tells them apart: the newest
    // top-level rollout (subagent threads say so on their first line) started there.
    const files = (await sh(`ls -t "$HOME"/.codex/sessions/*/*/*/rollout-*.jsonl 2>/dev/null | head -n 40`)).split("\n").filter(Boolean);
    for (const f of files) {
      try {
        const p = JSON.parse(await sh(`head -n 1 "$1"`, f)).payload ?? {};
        if (p.id && !p.source?.subagent && p.cwd === cwd) return { session: p.id, cwd };
      } catch {}
    }
    return null;
  }
  if (agent === "pi") {
    const f = (await sh(`lsof -p "$1" -Fn 2>/dev/null | sed -n 's/^n//p' | grep '/.pi/agent/sessions/.*\\.jsonl$' | head -n 1`, String(pid)));
    return f ? { session: f, cwd } : null;
  }
  if (agent === "opencode") {
    const db = `${home()}/.local/share/opencode/opencode.db`;
    const id = await sh(`sqlite3 -readonly "$1" "select id from session where directory = '$(printf %s "$2" | sed "s/'/''/g")' and parent_id is null and time_archived is null order by time_updated desc limit 1"`, db, cwd);
    return id ? { session: id, cwd } : null;
  }
  return null;
}

// Whether a session reference still points at a session (stale ones stay shells).
async function exists(agent, session) {
  if (agent === "claude") return Boolean(await sh(`ls "$HOME"/.claude/projects/*/"$1".jsonl 2>/dev/null | head -n 1`, session));
  if (agent === "codex") return Boolean(await sh(`ls "$HOME"/.codex/sessions/*/*/*/rollout-*-"$1".jsonl 2>/dev/null | head -n 1`, session));
  if (agent === "pi") return Boolean(await sh(`[ -f "$1" ] && echo y`, session));
  if (agent === "opencode") return Boolean(await sh(`sqlite3 -readonly "$HOME/.local/share/opencode/opencode.db" "select 1 from session where id = '$1'"`, session.replace(/[^A-Za-z0-9_]/g, "")));
  return false;
}

export class AgentResume {
  constructor() { this.busy = false; }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const config = await settings();
      const status = await hcJson(["server", "status"]);
      const holder = status?.holder?.instance;
      const live = new Set([...(status?.holders ?? []).map((h) => h.instance), holder].filter(Boolean));
      if (!holder) return;
      const lost = [], seen = [];
      for (const t of terminals()) {
        const labels = t.labels ?? {};
        // Only this computer's terminals that Herdr shows.
        if (!labels["herdr.space"] || String(t.address).includes("/")) continue;
        const hinted = agentOf(t.program?.key) ?? agentOf(t.agent) ?? agentOf(t.report?.app);
        if (!hinted && !labels["agent-resume.session"]) continue;
        const info = await hcJson(["get", t.address, "--json"]);
        if (!info || info.state !== "live") continue;
        const program = String(info.foreground?.argv?.[0] ?? "").split("/").pop().replace(/^-/, "");
        const running = agentOf(program) ?? (hinted && !SHELLS.has(program) ? hinted : null);
        if (running) { seen.push({ t, labels, info, running }); continue; }
        if (!labels["agent-resume.session"]) continue;
        // Back at the shell while the same holder lives: the agent exited, its reference goes.
        if (live.has(labels["agent-resume.holder"])) { if (SHELLS.has(program)) await this.forget(t.address); continue; }
        if (SHELLS.has(program)) lost.push({ t, labels });
        else await this.forget(t.address);
      }
      // Record running agents. Codex and opencode are matched by folder: two of the same agent
      // in one folder can't be told apart, so neither keeps a reference.
      const byFolder = {};
      for (const x of seen) if (x.running === "opencode" || x.running === "codex") byFolder[`${x.running}|${x.info.cwd}`] = (byFolder[`${x.running}|${x.info.cwd}`] ?? 0) + 1;
      for (const { t, labels, info, running } of seen) {
        const ref = byFolder[`${running}|${info.cwd}`] > 1 ? null : await sessionOf(running, info.foreground.pid, info.cwd);
        if (!ref) { if (labels["agent-resume.session"]) await this.forget(t.address); continue; }
        if (labels["agent-resume.session"] !== ref.session || labels["agent-resume.holder"] !== holder || labels["agent-resume.agent"] !== running)
          await hc(["label", t.address, `agent-resume.agent=${running}`, `agent-resume.session=${ref.session}`, `agent-resume.cwd=${ref.cwd}`, `agent-resume.holder=${holder}`]);
      }
      if (!lost.length) return;
      // Duplicated references stay plain shells.
      const count = {};
      for (const { labels } of lost) count[labels["agent-resume.session"]] = (count[labels["agent-resume.session"]] ?? 0) + 1;
      const resumed = [];
      for (const { t, labels } of lost) {
        const agent = labels["agent-resume.agent"] || "claude";
        const session = labels["agent-resume.session"];
        const screen = (await hcJson(["read", t.address, "--json"]))?.text ?? "";
        const lines = screen.split("\n").filter((l) => l.trim()).length;
        if (!lines) continue; // the shell is still starting: decide next time
        await this.forget(t.address); // decided once, resumed or not
        if (!config.enabled || !AGENTS[agent] || count[session] > 1 || lines > FRESH_LINES || !(await exists(agent, session))) continue;
        const cwd = labels["agent-resume.cwd"] || ".";
        await hc(["send", t.address, `cd ${quote(cwd)} && ${AGENTS[agent].argv(session).map(quote).join(" ")}`]);
        resumed.push(labels.where ?? t.address);
        if (config.delay) await pause(config.delay);
      }
      if (resumed.length) notify({ title: `Resumed ${resumed.length} agent${resumed.length > 1 ? "s" : ""}`, body: resumed.join(", "), level: "info", timeout: 6000 });
    } catch {
      // A core away or a malformed answer: the next tick tries again.
    } finally {
      this.busy = false;
    }
  }

  forget(address) { return hc(["label", address, ...LABELS.map((k) => `${k}=`)]); }
}
