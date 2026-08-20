#!/bin/zsh
# Generate ~/Library/LaunchAgents/com.deckneo.daemon.plist from the repo's template,
# substituting the repo path and $HOME in place of manually editing placeholders
# (launchd plists can't expand ~ or $HOME, so the substitution has to happen somewhere).
#
# Safe to run repeatedly — it just regenerates the file. Does not bootstrap the job;
# run the launchctl command it prints afterward (or after `git pull`, if the repo moved).

set -eu

REPO="${0:A:h:h}"
TEMPLATE="$REPO/launchd/com.deckneo.daemon.plist"
DEST="$HOME/Library/LaunchAgents/com.deckneo.daemon.plist"

mkdir -p "$HOME/Library/LaunchAgents"
sed -e "s|/path/to/deck_neo|$REPO|g" -e "s|/Users/YOU|$HOME|g" "$TEMPLATE" > "$DEST"

echo "Wrote $DEST"
echo "Run: launchctl bootstrap \"gui/\$(id -u)\" \"$DEST\""
