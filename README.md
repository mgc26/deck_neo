# deck_neo

A Stream Deck Neo as a dedicated physical cockpit for Claude Code sessions —
inspired by the Work Louder Codex Micro.

- **One light language:** blue = busy, amber blink = needs you *now*, green = ready,
  red = stop/can't. Bright = the key is relevant right now; dim = it isn't, though a
  selected session with a live tmux target still takes input. White border = selected;
  `○` before a name = watch-only (started without `cc`, status lights only).
- **Top row** — up to 4 sessions as live status lights. Press to select + raise its
  Cursor window.
- **Bottom row** — APPROVE (lights green) / STOP (lights red) when the selected
  session awaits you; CONTINUE (lights blue) when it's ready for a prompt; + NEW
  always available.
- **Infobar** — selected session and its latest event.
- **Touch zones** — flip to a page of 8 canned commands (`/qa`, `/handoff`, …).

How it works: Claude Code hooks write per-session state files; a TypeScript daemon
watches them and draws the Neo; key presses inject input into the exact session via
`tmux send-keys`. Sessions are started with the `cc` wrapper inside your normal
terminal (Cursor's integrated terminal included) — workflow otherwise unchanged.

## Setup

See **[docs/INSTALL.md](docs/INSTALL.md)** — hooks, config, the `cc` alias, the
Elgato-app claim-order trick, and troubleshooting.

## Run

```sh
npm start        # daemon (leave running) — or the launchd service, see INSTALL
cc               # in a project dir: tmux + claude, lights up on the Neo
cx               # same for an OpenAI Codex CLI session — see docs/CODEX.md
npm run demo     # cycle synthetic sessions on the Neo for filming — stops/restores the daemon
```

## Develop

```sh
npm test         # 381 tests: core / device / system / codex / integration
                 # (one timing-sensitive integration test trips intermittently — rerun if it does)
npm run build    # strict type-check
```

The shared types every module imports live in `daemon/src/contracts.ts`, and each
module has a `contract.test.ts` pinning the surface it exposes.
