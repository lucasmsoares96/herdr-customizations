# Herdr customizations

Personal layout and mods for the [Herdr app](https://herdr.dev), kept in the
Herdr home folder (`~/.config/herdr-app`). Only the files listed in
`.gitignore` are tracked; the rest of the folder belongs to Herdr.

## What is here

| Path | What it does |
|---|---|
| `layouts/my-main.json` | Clone of the shipped `main` layout, wired to the mods below. |
| `mods/my-spaces/` | Clone of `spaces`: lists every git worktree of a repo, also those without a space (dimmed; a click opens one), and nests a worktree under another when its folder is inside that one's. Right-click opens `git-menu`. |
| `mods/my-tabs/` | Clone of `tabs`: adds the Branches and Repository panel buttons, keeps the most-recently-used agent order for Ctrl+Tab, and toggles focus mode (Cmd+Shift+Enter: sidebar to its rail, side panel hidden, focused pane zoomed in a split tab). |
| `mods/repository/` | Repository panel: Issues, Pull requests, Branches and Actions of the space's repo, from Forgejo or GitHub, cached and refreshed in the background. Read-only. |
| `mods/branches/` | Branches panel: local branches from git, with worktree, space, ahead/behind and remote state. |
| `mods/git-menu/` | Right-click menu and dialogs: rename branch, move worktree folder, delete worktree and/or branch. Never touches the main checkout or the remote. |
| `mods/agent-switcher/` | Firefox-style Ctrl+Tab switcher across every space's agents. |
| `keys.json` | Key bindings; `layout:my-main` binds Ctrl+Tab / Ctrl+Shift+Tab to the switcher and Cmd+Shift+Enter to focus mode. |

## Install on another machine

1. Copy these files into `~/.config/herdr-app/` (or clone this repo there:
   `git clone <url> /tmp/hc && cp -R /tmp/hc/. ~/.config/herdr-app/`).
2. Check each mod: `herdr-app check ~/.config/herdr-app/mods/<name>`.
3. Switch to the layout: `herdr-app do layout.switch --name my-main`.

Copy `mod.json` together with each mod folder: a mod folder without it is docked
into the shown layout by Herdr on first sight.

## Tokens

- GitHub: `$GH_TOKEN` / `$GITHUB_TOKEN`, else `gh auth token`.
- Forgejo: `$FORGEJO_TOKEN`, else the token `fj auth login` saved.

Tokens are read at run time and never written to the cache.

## License

`mods/my-spaces` and `mods/my-tabs` are modified copies of Herdr's shipped mods
(Apache License 2.0).
