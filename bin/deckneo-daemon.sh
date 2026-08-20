#!/bin/zsh
# launchd entry point: runs the daemon in the foreground (so launchd's KeepAlive
# supervises the real process) and handles the Elgato claim-order dance around it.
#
# Strategy: start the daemon optimistically — at login we usually beat the Elgato
# app to the Neo and nothing needs quitting. Only if the claim hasn't landed after
# a few seconds AND the Elgato app is running do we bounce the app (it reopens by
# itself a few seconds later and keeps driving the XL/pedal; it just can't grab
# the Neo back).

set -u

# launchd provides a bare PATH: pin node (hermes install), homebrew (tmux — the
# daemon spawns it for the action keys), and ~/.local/bin (where the Claude Code
# CLI's official installer puts `claude` — the +NEW command tmux runs). Without
# it, `tmux new-session -d` still reports success (it doesn't wait for the exec),
# so a missing `claude` fails completely silently: the session spins up and
# self-destructs the instant the pane's command can't be found.
# `.hermes/node` is this machine's install layout, not a requirement. Point these at
# wherever your own `node` and `claude` live (`which node`, `which claude`), or +NEW
# will silently do nothing.
export PATH="$HOME/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

REPO="${0:A:h:h}"
LOG="$HOME/.deck-neo/daemon.log"
mkdir -p "$HOME/.deck-neo"

cd "$REPO"
npx tsx daemon/src/index.ts > "$LOG" 2>&1 &
DAEMON_PID=$!

# The Elgato claim-dance runs in a background subshell. Reap it on exit so a
# crash-looping daemon (launchd KeepAlive) can't leave an orphan that fires
# `killall "Stream Deck"` seconds into the NEXT run and races its claim.
FIXER_PID=""
cleanup() { [ -n "$FIXER_PID" ] && kill "$FIXER_PID" 2>/dev/null; }
trap cleanup EXIT INT TERM

(
  sleep 5
  if ! grep -q "device connected" "$LOG" 2>/dev/null; then
    if pgrep -f "Elgato Stream Deck.app/Contents/MacOS" >/dev/null 2>&1; then
      killall "Stream Deck" 2>/dev/null || true
      for _ in {1..15}; do
        sleep 1
        grep -q "device connected" "$LOG" 2>/dev/null && break
      done
      open -a "Elgato Stream Deck" || true
    fi
  fi
) &
FIXER_PID=$!

wait "$DAEMON_PID"
