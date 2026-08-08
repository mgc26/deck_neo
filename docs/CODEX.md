# Deck Neo — Codex CLI sessions

Adds OpenAI Codex CLI sessions to the cockpit next to your Claude Code sessions. A codex
session takes a top-row key exactly like a Claude one: it lights up, it can be selected,
and APPROVE / STOP / CONTINUE send keys to its tmux session.

Repo path used throughout this document:

```
/path/to/deck_neo
```

Substitute your own absolute path if you cloned it elsewhere — every path in
`~/.codex/config.toml` must be absolute.

## Requirements

- The Deck Neo daemon already installed and running (see [INSTALL.md](INSTALL.md))
- Codex CLI (verified against `codex-cli 0.144.3`)
- tmux, and `codex` reachable on your PATH

## How it differs from the Claude integration

Claude Code fires seven hooks across a session's life; Codex has a single `notify` slot
and emits exactly one event type, `agent-turn-complete`, when a turn finishes. So the
adapter gets its state from two places:

| Moment | Who reports it | State |
|---|---|---|
| `cx` starts the session | `codex-notify.mjs --register` | `idle` (green) |
| a turn finishes | codex `notify` → `codex-notify.mjs` | `done` (green) |
| you send text from the deck | the daemon, optimistically | `working` (blue) |

Records are written to `~/.deck-neo/sessions/codex-<session>.json` with `kind: "codex"`,
the same directory and format the Claude hook uses.

## 1. Wire the notify program

Codex allows **one** `notify` program, and yours is already taken by the Computer Use
client:

```toml
notify = ["/Users/YOU/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient", "turn-ended"]
```

The adapter therefore installs itself *in front* of that program and forwards every event
on to it. In `~/.codex/config.toml`, replace the line above with:

```toml
notify = [
  "/path/to/node",
  "/path/to/deck_neo/hooks/codex-notify.mjs",
  "--forward",
  "/Users/YOU/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
  "turn-ended",
]
```

The shape is `--forward <program> <its args...>`: everything after `--forward` is the
command line Codex used to run before, and the adapter appends the same JSON payload
argument Codex passes it. Use an **absolute** node path (find yours with `which node`) —
notify inherits codex's environment, and a bare `node` fails silently wherever that
environment lacks your PATH. The forwarded program is spawned detached and never waited on,
so the Computer Use client behaves exactly as it did — including when the adapter cannot
make sense of a payload, in which case it still forwards and logs to
`~/.deck-neo/hook.log`.

Edit the TOML by hand. Nothing in this repo rewrites `~/.codex/config.toml`.

Note: ChatGPT desktop app updates may rewrite this line the other way around —
putting the Computer Use client first with our adapter tucked into its
`--previous-notify` argument. That arrangement works too (verified: the client
forwards the payload to whatever `--previous-notify` holds), so leave it alone
if you find it that way; the deck keeps receiving events either way.

If your `notify` slot is empty, the entry is just:

```toml
notify = ["/path/to/node", "/path/to/deck_neo/hooks/codex-notify.mjs"]
```

Codex reads `config.toml` at startup, so restart any running `codex` for the change to
take effect. Verify the adapter by hand from a project directory:

```sh
node /path/to/deck_neo/hooks/codex-notify.mjs \
  '{"type":"agent-turn-complete","turn-id":"probe"}'
cat ~/.deck-neo/sessions/codex-"${PWD##*/}".json
rm ~/.deck-neo/sessions/codex-"${PWD##*/}".json
```

## 2. Install `cx`

`cx` is to `codex` what `cc` is to `claude`: it starts (or re-attaches to) a tmux session
and registers the session with the daemon as it creates it, so the key is lit from the
first second rather than after the first turn. Re-attaching to an existing session skips
registration — its record already exists.

Install it as a shell **alias**, not on PATH — same reasoning as `cc`, an alias applies
only to interactive terminals:

```sh
# in ~/.zshrc
alias cx="/path/to/deck_neo/bin/cx"
```

Open a new terminal (or `source ~/.zshrc`), then use `cx` where you used to type `codex`:

```sh
cd ~/code/api && cx          # tmux session: api
cx api-2                     # a second codex session on the same project
```

The session name is the identity: `cx api-2` registers `codex-api-2`, which is exactly the
identity the notify events derive from `tmux display-message -p '#S'` once codex is
running inside that session, verbatim — tmux keeps `.` and `:` in session names as-is
but can never target such names with `-t` again, so `cx` replaces them with `_` when it
CREATES the session (`cx deck.neo` → session `deck_neo`); the adapter then simply
records whatever name tmux reports.

Running plain `codex` still works — the session appears on the deck after its first turn,
marked watch-only (`○`), because there is no tmux session to send keys to.

## 2b. Pull a ChatGPT-app thread onto the deck: `cxa`

Threads started in the ChatGPT desktop app's UI have no terminal, so the deck can only
watch them. But the app and the CLI share `~/.codex`, and `codex resume <id>` continues
an app thread in the terminal — `cxa` wraps that in tmux so the thread becomes a fully
controllable deck session:

```sh
cxa            # resume the most recently updated thread (named after its title)
cxa <uuid>     # resume a specific thread by session id
```

Codex may ask two one-key questions on attach (update check, which cwd to resume in);
the key is already lit by then. The app UI keeps the thread too — but drive it from one
side at a time.

Threads you drive purely from the app UI (no `cxa`) still reach the deck: the app's
codex engine is launched by LaunchServices, so it runs from `/` with no tmux, and the
adapter falls back to identity carried in the notify payload. Such a key's tile reads
as the thread's workspace directory (e.g. `api`), but its underlying session id is
hash-tagged from the stable thread id (`codex-app-<tag>`) — the tag keeps an app
thread from ever overwriting a terminal session's key that shares the directory
name. If the payload carries nothing usable either (older codex builds),
the turn lands on one shared watch-only key labelled `codex` (`codex-unidentified`)
rather than being dropped; it ages off the deck ~30 minutes after the turns stop.

## 3. Approve / reject keys

Codex's confirmation prompts are not the same keystrokes as Claude's. If yours differ,
override them per kind in `~/.deck-neo/config.json`; codex falls back to the top-level
values when `keys.codex` is absent:

```json
{
  "keys": {
    "approve": ["Enter"],
    "reject": ["Escape"],
    "codex": {
      "approve": ["y", "Enter"],
      "reject": ["n", "Enter"]
    }
  }
}
```

## Known limits (v1)

- **The deck's `+ NEW` key launches Claude sessions only** — start codex sessions with
  `cx` (or `cx <name>`) from a terminal.
- **No amber for codex.** `agent-turn-complete` is the only event Codex emits — there is
  no approval or turn-start notification — so a codex session waiting for your permission
  looks the same as one that finished: green. Amber blinking remains Claude-only.
- **Blue appears only for deck-initiated sends.** Because the adapter learns nothing when
  a turn *starts*, `working` is set optimistically by the daemon when you send text from
  the Neo. Type into the terminal directly and the key stays green until the turn ends.
- **One record per session name.** Two codex sessions in the same directory need explicit
  names (`cx api`, `cx api-2`); without them the second one shares the first one's key.
- **`codex` must be on the tmux server's PATH.** tmux inherits the environment of whatever
  started its server, so a server started before you added `~/.local/bin` to PATH will
  fail with `codex: command not found`. `tmux kill-server` and run `cx` again.

## Troubleshooting

**The key never appears.** Check `~/.deck-neo/sessions/` for a `codex-*.json`. If it is
missing, run the by-hand verification above and read `~/.deck-neo/hook.log`; every failure
the adapter survives is logged there with a `codex-notify` or `codex-register` tag.

**The key appears but APPROVE/STOP flash red.** That record has no `tmux` field — codex
was started outside tmux. Restart it with `cx`.

**Turns complete but the key never turns green.** The `notify` entry isn't reaching the
adapter. Confirm `~/.codex/config.toml` parses (`codex --version` still starts), that the
path to `codex-notify.mjs` is absolute, and that `notify[0]` is an **absolute** node
path that runs (`/path/to/node --version`) — a bare `node` fails silently wherever
codex's environment lacks your PATH.

**Computer Use stopped reacting after wiring the adapter.** The forwarded program is
spawned with its stdio ignored and is never waited on, so its own output disappears; test
it in isolation with the same argv the adapter passes:
`"<program>" turn-ended '{"type":"agent-turn-complete"}'`.
