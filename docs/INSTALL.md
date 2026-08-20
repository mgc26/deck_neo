# Deck Neo — Install

Turns a Stream Deck Neo into a cockpit for your Claude Code sessions: live state lights,
approve/stop, canned commands, and a session launcher.

Repo path used throughout this document:

```
/path/to/deck_neo
```

Substitute your own absolute path — the hook commands must be absolute, because Claude
Code runs them from the session's working directory. Node's path matters too: the
launchd job (step 5) pins a specific node location at `bin/deckneo-daemon.sh` line ~15
(`$HOME/.hermes/node/bin` is one install layout); replace it with wherever your own
`node` lives (`which node`).

## Requirements

- macOS
- Node 22.18 or newer (`node -v`)
- Claude Code (`claude -v`) — `bin/cc` starts sessions by running `claude`
- tmux (`brew install tmux`) — Claude sessions must run inside tmux for the Neo's action
  keys to reach them
- A Stream Deck Neo, plugged in, with the Elgato Stream Deck app **quit** (see step 4)

Install dependencies once:

```sh
cd /path/to/deck_neo
npm install
```

## 1. Wire the state-reporting hooks

The daemon learns what your sessions are doing from seven Claude Code hooks. Add the
`hooks` block below to `~/.claude/settings.json`. If that file already exists, merge this
`hooks` key into it rather than replacing the file (keep your other settings).

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/node /path/to/deck_neo/hooks/report-state.mjs SessionStart"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/node /path/to/deck_neo/hooks/report-state.mjs UserPromptSubmit"
          }
        ]
      }
    ],
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/node /path/to/deck_neo/hooks/report-state.mjs Notification"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/node /path/to/deck_neo/hooks/report-state.mjs Stop"
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/node /path/to/deck_neo/hooks/report-state.mjs SessionEnd"
          }
        ]
      }
    ],
    "SubagentStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/node /path/to/deck_neo/hooks/report-state.mjs SubagentStart"
          }
        ]
      }
    ],
    "SubagentStop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/node /path/to/deck_neo/hooks/report-state.mjs SubagentStop"
          }
        ]
      }
    ]
  }
}
```

Event → light mapping. The rule for green: **green means everything is finished** — a
session whose main turn ended but still has background agents out stays blue.

| Hook event | Effect | On the key |
|---|---|---|
| `SessionStart` | `idle`, agent counter reset | green (ready), session name appears |
| `UserPromptSubmit` | `working` | blue |
| `Notification` | `needs-input` | amber, blinking |
| `Stop` | `done` — **unless agents are still running**, then `working` | green / blue |
| `SubagentStart` | counter +1, `working` (amber wins if active) | blue |
| `SubagentStop` | counter −1; `done` only when main idle and counter 0 | blue / green |
| `SessionEnd` | `ended` | slot goes dark |

The hook writes `~/.deck-neo/sessions/<session_id>.json` and always exits 0, so a broken
hook can never block a Claude turn. Anything that goes wrong is appended to
`~/.deck-neo/hook.log`.

Verify it by hand before starting the daemon:

```sh
echo '{"session_id":"probe","cwd":"'"$PWD"'"}' \
  | node /path/to/deck_neo/hooks/report-state.mjs SessionStart
cat ~/.deck-neo/sessions/probe.json
rm ~/.deck-neo/sessions/probe.json
```

## 2. Create `~/.deck-neo/config.json`

```json
{
  "projects": [
    { "name": "deck_neo", "path": "/path/to/deck_neo" },
    { "name": "api", "path": "/Users/YOU/code/api" },
    { "name": "web", "path": "/Users/YOU/code/web" },
    { "name": "notes", "path": "/Users/YOU/code/notes" }
  ],
  "commands": [
    { "label": "CONTINUE", "text": "continue" },
    { "label": "/qa", "text": "/qa" },
    { "label": "TESTS", "text": "run the tests" },
    { "label": "HANDOFF", "text": "/handoff" }
  ],
  "keys": {
    "approve": ["Enter"],
    "reject": ["Escape"]
  },
  "launch": {
    "claudeArgs": []
  },
  "focus": {
    "appName": "Cursor"
  }
}
```

- `projects` — the launcher's picker shows the **first 4**. `name` is only the label
  drawn on the picker key; the tmux session (and what the focus action matches against
  the target app's window titles) is always the **directory basename** of `path`, which
  is also what the hook reports for sessions you start yourself with `cc`.
- `commands` — page 2 shows up to 8. **`commands[0]` is also the cockpit CONTINUE key**,
  so put your most-used follow-up first.
- `keys` — optional. Both default to the values shown; they are the literal `tmux
  send-keys` arguments used for approve and reject, so you can retune them (e.g.
  `["y", "Enter"]`) without touching code.
- `launch.claudeArgs` — optional. Each entry becomes a separate Claude CLI argument
  when `+ NEW` starts a session. Keep the empty array unless you deliberately need
  standing flags on every deck-launched session.
- `focus.appName` — optional, defaults to `"Cursor"`. The app whose windows are searched
  when a session key is pressed. Set it to `"iTerm2"` or `"Terminal"` if you run `cc`
  in a standalone terminal instead of Cursor's integrated one — matching works the same
  way, by the project's directory basename appearing in the window title, so it depends
  on your terminal showing that in its title/tab (iTerm2 and Terminal do by default).

The daemon reloads this file when it changes. If an edit is malformed it keeps the last
good config and logs the parse error.

**Security note:** this file is a control plane — `commands[].text` is typed verbatim into
a live agent, and `launch.claudeArgs` becomes flags on `+ NEW` launches. Keep it
`chmod 600` (owner-only); anything that can write it can steer your agents.

## 3. Install the `cc` alias

(For OpenAI Codex CLI sessions there is a parallel `cx` wrapper — see
[CODEX.md](CODEX.md) for its alias and the notify wiring.)

Sessions must run inside tmux. `cc` starts (or re-attaches to) a tmux session named after
the current directory and runs `claude` in it.

Install it as a shell **alias**, not on PATH — `cc` is also the system C compiler, and a
PATH entry would shadow it for make/node-gyp, breaking native builds. An alias applies
only to interactive terminals, which is exactly the scope you want:

```sh
# in ~/.zshrc
alias cc="/path/to/deck_neo/bin/cc"
```

Open a **new** terminal (or `source ~/.zshrc`) for the alias to take effect; verify with
`type cc` — it must say "alias", not `/usr/bin/cc`.

Then, in Cursor's integrated terminal, use `cc` where you used to type `claude`:

```sh
cd ~/code/api && cc          # session name: api
cc scratch                   # explicit session name
```

A session started as plain `claude` (no tmux) still lights up on the Neo, but the action
keys have nowhere to send input — they flash red and the infobar says why.

## 4. Take the Neo away from the Elgato Stream Deck app

The daemon claims the Neo over USB directly. The official Stream Deck app opens every
Elgato device it sees with **exclusive** access, so while it holds the Neo the daemon's
open fails (`hid_open_path: … exclusive access and device already open`; the daemon
retries every 3 s).

macOS grants the device to whichever process opens it first, so the fix is claim order —
verified working on this machine:

1. Quit the Stream Deck app.
2. Start the daemon (step 5) — it claims the Neo and holds it.
3. Relaunch the Stream Deck app. It can no longer grab the Neo, but it drives your other
   Elgato devices (XL, pedal, …) exactly as before — the daemon opens only the device
   reporting model `neo`.

Repeat that order after a reboot or replug (the app's autolaunch usually wins the race,
so quit it, start the daemon, relaunch it). If you use the Neo only with this daemon and
have no other Elgato devices, simply disable the app's "launch at login" instead.

## 5. Start the daemon

**Recommended: install it as a login service** (auto-starts at login, auto-restarts on
crash, and performs the step-4 claim dance by itself):

`bin/install-launchd.sh` generates `~/Library/LaunchAgents/com.deckneo.daemon.plist`
from the repo's template, substituting your real repo path and home directory in place
of its `/path/to/deck_neo` and `/Users/YOU` placeholders (launchd plists can't expand
`~` or `$HOME`, so this has to happen somewhere — the script saves you the manual edit):

```sh
bin/install-launchd.sh
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.deckneo.daemon.plist
```

Re-run `bin/install-launchd.sh` any time the repo moves.

Manage it with `launchctl kickstart -k gui/$(id -u)/com.deckneo.daemon` (restart) and
`launchctl bootout gui/$(id -u)/com.deckneo.daemon` (stop). Logs: `~/.deck-neo/daemon.log`.

For development, `npm start` in the repo still runs it in the foreground (boot the
launchd job out first, or the two will fight over the device).

A third option: run `bin/deckneo-launch.sh` directly any time you want the daemon
started (or the launchd job kickstarted, if it owns the daemon instead) plus a
one-line health check of the hooks, codex notify, and shell wrapper wiring. It is
safe to run repeatedly, so it also works as your own login item.

Then `cc` into a project and the top-left key lights up.

The light language, four rules:

1. **One hue per meaning:** blue = busy · amber = needs you · green = ready/yes ·
   red = stop/can't · gray = neutral.
2. **Blink = needs you right now** (amber needs-input only).
3. **Bottom row: bright = the key is relevant right now; dim = it isn't.** APPROVE
   lights green and STOP lights red while the selected session awaits you; CONTINUE
   lights blue when it's ready for a prompt; `+ NEW` is always available. Dim is a
   signal, not a lock, a dim key still acts if the selected session has a live tmux
   target. A press that genuinely can't act (no selection, or a session with no tmux)
   answers with a brief red flash and an infobar explanation.
4. **Top-row marks:** white border = selected · `○` before the name = watch-only
   (session not started via `cc`, so the action keys can't reach it).

Cockpit layout:

```
┌─────────┬─────────┬─────────┬─────────┐
│ S1      │ S2      │ S3      │ S4      │  press = select session + focus its window
├─────────┼─────────┼─────────┼─────────┤
│ APPROVE │ STOP    │ CONTINUE│  + NEW  │  act on the selected session
└─────────┴─────────┴─────────┴─────────┘
   ◄ [ selected session ▸ last event ] ►    touch either side for the commands page
```

## Troubleshooting

**Keys never light up.** Check `~/.deck-neo/sessions/` for JSON files. Empty means the
hooks are not firing: confirm the `hooks` block in `~/.claude/settings.json` is valid JSON
(`node -e 'JSON.parse(require("fs").readFileSync(process.env.HOME + "/.claude/settings.json","utf8"))'`),
that the paths are absolute, and check `~/.deck-neo/hook.log`.

**Keys light up but APPROVE/STOP flash red.** That session has no `tmux` field — it was
started with plain `claude`. Restart it with `cc`.

**A key stays lit for a session I closed.** Slots free themselves when the session reports
`SessionEnd`, when its tmux session disappears (polled every 10 s), or when its state file
ages out. A watch-only session in `done` or `idle` expires after about 30 minutes; a
watch-only session still reporting active work can remain for up to 24 hours. Freed
sessions have their state files deleted automatically (ended sessions keep a tombstone
file for ~60 s so a straggling hook event cannot revive them). A stuck slot can always be
cleared by deleting its file from `~/.deck-neo/sessions/`.

**Pressing a session key doesn't bring the window forward.** Window raising uses
AppleScript via System Events, which needs Accessibility/Automation permission for the
process running the daemon (System Settings → Privacy & Security → Accessibility, and →
Automation). Selection still works without it; only the focus step is skipped. Sessions
launched detached by the `+ NEW` key have no window to raise until you attach with
`cc <name>`. If you run `cc` in iTerm2, Terminal, or another terminal app instead of
Cursor, set `focus.appName` in `config.json` (see above) — otherwise it keeps searching
Cursor's windows and never finds a match.

**The daemon logs `disconnected` in a loop.** The Stream Deck app is running (step 4), or
the Neo is on a hub that dropped it. Unplug/replug and check `npm start` output.
