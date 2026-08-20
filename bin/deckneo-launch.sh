#!/bin/zsh
# Start the Deck Neo daemon, handling the Elgato claim-order dance, and run the
# tee-up health check: one run leaves the whole stack ready (daemon holding
# the Neo, hooks wired, codex notify wired, transparent claude/codex wrappers
# installed).
#
# Safe to run repeatedly, whether from an interactive shell or a bare-PATH
# launch context such as a login item or launch agent.

set -u

# .app launch contexts have a bare PATH: pin node (hermes install), homebrew
# (tmux — the daemon spawns it for the action keys), and ~/.local/bin (where the
# Claude Code CLI's official installer puts `claude` — the +NEW command tmux
# runs). Without it, `tmux new-session -d` still reports success (it doesn't
# wait for the exec), so a missing `claude` fails completely silently: the
# session spins up and self-destructs the instant the pane's command can't be found.
# `.hermes/node` is this machine's install layout, not a requirement. Point these at
# wherever your own `node` and `claude` live (`which node`, `which claude`), or +NEW
# will silently do nothing.
export PATH="$HOME/.hermes/node/bin:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

REPO="${0:A:h:h}"
LOG="$HOME/.deck-neo/daemon.log"
mkdir -p "$HOME/.deck-neo"

# ---- tee-up health check ------------------------------------------------
# Verifies the wiring OUTSIDE the daemon that boots tend to break: Claude
# hooks, the codex notify chain, and the shell wrappers. Repairs nothing
# destructive — it reports, so a broken piece is one glance away.
doctor() {
  local out=""
  local hooks
  # grep -c exits 1 and prints "0" on no match; `|| echo 0` would then make it
  # "0\n0" and break the numeric test. Take the first line only.
  hooks=$(grep -c "report-state.mjs" "$HOME/.claude/settings.json" 2>/dev/null)
  hooks=${hooks%%$'\n'*}
  [ -n "$hooks" ] || hooks=0
  if [ "$hooks" -ge 7 ]; then out+="hooks ✓  "; else out+="hooks: $hooks/7 wired!  "; fi

  if grep -q "codex-notify.mjs" "$HOME/.codex/config.toml" 2>/dev/null; then
    out+="codex notify ✓  "
  else
    out+="codex notify UNWIRED (see docs/CODEX.md)  "
  fi

  if grep -q "deck_neo/bin" "$HOME/.zshrc" 2>/dev/null; then
    out+="wrappers ✓"
  else
    out+="wrappers missing from ~/.zshrc"
  fi
  echo "$out"
}
HEALTH="$(doctor)"

# When the launchd agent is installed, it owns the daemon — kick it rather than
# starting a second copy that would lose the device claim and retry forever.
if [ -f "$HOME/Library/LaunchAgents/com.deckneo.daemon.plist" ]; then
  if pgrep -f "daemon/src/index.ts" >/dev/null 2>&1; then
    echo "daemon running · $HEALTH"
  else
    launchctl kickstart -k "gui/$(id -u)/com.deckneo.daemon" 2>/dev/null \
      || launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.deckneo.daemon.plist"
    echo "daemon kickstarted · $HEALTH"
  fi
  exit 0
fi

if pgrep -f "daemon/src/index.ts" >/dev/null 2>&1; then
  echo "daemon running · $HEALTH"
  exit 0
fi

ELGATO_WAS_RUNNING=0
if pgrep -f "Elgato Stream Deck.app/Contents/MacOS" >/dev/null 2>&1; then
  ELGATO_WAS_RUNNING=1
  killall "Stream Deck" 2>/dev/null || true
  sleep 2
fi

cd "$REPO"
# Fresh log per launch so "device connected" below can't match a stale line.
nohup npx tsx daemon/src/index.ts > "$LOG" 2>&1 &

CLAIMED=0
for _ in {1..12}; do
  sleep 1
  if grep -q "device connected" "$LOG" 2>/dev/null; then
    CLAIMED=1
    break
  fi
done

if [ "$ELGATO_WAS_RUNNING" = 1 ]; then
  open -a "Elgato Stream Deck" || true
fi

if [ "$CLAIMED" = 1 ]; then
  echo "daemon running (Neo claimed) · $HEALTH"
  exit 0
else
  echo "daemon started but Neo not claimed — check $LOG · $HEALTH"
  exit 1
fi
