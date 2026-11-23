// Agent resume, as the Herdr TUI does it. herdr-core gives a lost terminal (a reboot, a
// core crash) a plain shell and never reruns its program. So every Claude running in a
// Herdr terminal is recorded on it as labels: agent-resume.session and agent-resume.cwd
// (read from Claude's own ~/.claude/sessions/<pid>.json) and agent-resume.holder (the core
// holder that holds the terminal). When that holder is gone, the terminal was lost: its fresh shell
// gets `cd <cwd> && claude --resume <session>`, once. A session ended on purpose (its
// terminal back at the shell while the same holder lives) is forgotten.

import { hc, terminals, notify, readTextFile, home } from "herdr";

const SHELLS = new Set(["zsh", "bash", "sh", "dash", "ksh", "fish", "nu", "pwsh", "powershell"]);
const LABELS = ["agent-resume.session", "agent-resume.cwd", "agent-resume.holder"];
// A fresh shell after recovery shows its prompt and a few startup lines; more means it was used.
const FRESH_LINES = 8;
// An agent ended on purpose is forgotten after its terminal stays at the shell this long.
const ENDED_MS = 20000;

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
async function hcJson(args) {
  const r = await hc(args);
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}
const forget = (address) => hc(["label", address, ...LABELS.map((k) => `${k}=`)]);

export class AgentResume {
  constructor() {
    this.atShell = {}; // address -> when it was first seen back at the shell
    this.busy = false;
  }

  // The session the terminal's Claude runs, from the file Claude keeps per process.
  async record(address, labels, pid, holder) {
    if (!pid || !holder) return;
    let s;
    try { s = JSON.parse(await readTextFile(`${home()}/.claude/sessions/${pid}.json`) ?? "null"); } catch { return; }
    if (!s?.sessionId) return;
    if (labels["agent-resume.session"] === s.sessionId && labels["agent-resume.holder"] === holder) return;
    await hc(["label", address, `agent-resume.session=${s.sessionId}`, `agent-resume.cwd=${s.cwd ?? ""}`, `agent-resume.holder=${holder}`]);
    delete this.atShell[address];
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const status = await hcJson(["server", "status"]);
      const live = new Set([...(status?.holders ?? []).map((h) => h.instance), status?.holder?.instance].filter(Boolean));
      if (!live.size) return;
      const resumed = [];
      const holder = status?.holder?.instance;
      for (const t of terminals()) {
        const labels = t.labels ?? {};
        // Only this computer's terminals that Herdr shows.
        if (!labels["herdr.space"] || String(t.address).includes("/")) continue;
        const info = await hcJson(["get", t.address, "--json"]);
        if (!info || info.state !== "live") continue;
        const program = String(info.foreground?.argv?.[0] ?? "").split("/").pop().replace(/^-/, "");
        if (program === "claude") { await this.record(t.address, labels, info.foreground.pid, holder); continue; }
        const session = labels["agent-resume.session"];
        if (!session) continue;
        const atShell = SHELLS.has(program);
        if (!live.has(labels["agent-resume.holder"])) {
          // Lost since the session was recorded: decide once.
          if (atShell) {
            const screen = (await hcJson(["read", t.address, "--json"]))?.text ?? "";
            const lines = screen.split("\n").filter((l) => l.trim());
            if (!lines.length) continue; // the shell is still starting: look again next time
            if (lines.length <= FRESH_LINES) {
              const cwd = labels["agent-resume.cwd"] || info.cwd;
              await hc(["send", t.address, `cd ${quote(cwd)} && claude --resume ${quote(session)}`]);
              resumed.push(labels.where ?? t.address);
            }
          }
          // The resumed Claude records itself again; anything else is not resumed later.
          await forget(t.address);
          delete this.atShell[t.address];
        } else if (atShell) {
          const since = (this.atShell[t.address] ??= Date.now());
          if (Date.now() - since > ENDED_MS) { await forget(t.address); delete this.atShell[t.address]; }
        } else {
          delete this.atShell[t.address];
        }
      }
      if (resumed.length) notify({ title: `Resumed ${resumed.length} agent${resumed.length > 1 ? "s" : ""}`, body: resumed.join(", "), level: "info", timeout: 6000 });
    } catch {
      // A core away or a malformed answer: the next tick tries again.
    } finally {
      this.busy = false;
    }
  }
}
