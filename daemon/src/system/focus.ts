// Raise the app window that belongs to a project (Cursor by default; any app whose
// window title contains the project name works, e.g. iTerm2 or Terminal), so pressing
// a session key on the Neo also brings that session's window to the front.
//
// AppleScript is passed to osascript as a single -e argument with the project name and
// app name delivered as run-arguments — never string-concatenated into the script, since
// a project name can contain quotes.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const OSASCRIPT_TIMEOUT_MS = 5000;

// System Events is used for both the lookup and the activation: `tell application X to
// activate` would *launch* the app when it is not running, and a focus key should never
// do that.
const SCRIPT = `on run argv
  set projectName to item 1 of argv
  set appName to item 2 of argv
  tell application "System Events"
    if not (exists process appName) then return "false"
    tell process appName
      repeat with w in windows
        if (name of w as string) contains projectName then
          perform action "AXRaise" of w
          set frontmost to true
          return "true"
        end if
      end repeat
    end tell
  end tell
  return "false"
end run`;

// iTerm2's own window chrome title (what System Events above reads) is static — whatever
// command originally opened the window — and never updates to reflect the tmux session
// running inside it. Its per-session *display name* (visible via iTerm2's own scripting
// dictionary, not System Events) is dynamic, but it reflects tmux's automatic window
// rename (the last-run foreground command), not the session name — so two tabs running
// the same command end up with identical, project-less names. The one property that is
// both live and unique is the pane's tty, which we already know from `tmux list-clients`
// on the session the focus key addressed. So iTerm2 gets matched by tty; the name-based
// script below is only a fallback for when no tmux session is known (e.g. a window opened
// outside deck_neo's tmux sessions entirely).
const ITERM_TTY_SCRIPT = `on run argv
  set targetTty to item 1 of argv
  tell application "System Events"
    if not (exists process "iTerm2") then return "false"
  end tell
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (tty of s as string) is targetTty then
            select s
            select t
            select w
            return "true"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "false"
end run`;

const ITERM_NAME_SCRIPT = `on run argv
  set projectName to item 1 of argv
  tell application "System Events"
    if not (exists process "iTerm2") then return "false"
  end tell
  tell application "iTerm2"
    repeat with w in windows
      repeat with t in tabs of w
        repeat with s in sessions of t
          if (name of s as string) contains projectName then
            select s
            select t
            select w
            return "true"
          end if
        end repeat
      end repeat
    end repeat
  end tell
  return "false"
end run`;

// `+ NEW` starts the tmux session detached — nothing else ever opens a terminal
// window for it, so the focus scripts above have nothing to raise until one exists.
// This gives iTerm2 users that window: unlike SCRIPT/ITERM_TTY_SCRIPT/ITERM_NAME_SCRIPT,
// it deliberately `activate`s (launches iTerm2 if needed) rather than checking first,
// since opening a window is the entire point of the call.
//
// The profile's "command" runs outside a login shell — no .zprofile/.zshrc, so
// Homebrew's PATH additions (tmux normally lives in /opt/homebrew/bin) never get
// applied and a bare `tmux attach` silently fails to find `tmux`, closing the
// window instantly (iTerm2 closes sessions whose command exits by default).
// Routing through `zsh -lc` forces a login shell so it re-derives PATH the same
// way the user's own interactive terminal would.
// `quoted form of` is AppleScript's shell-quoting primitive, applied twice here
// (once for the tmux target, once for the whole thing passed to zsh -lc) since
// the session name — already sanitized upstream (no '.'/':' — see appController's
// `launch` effect) — still has to survive two nested shell contexts.
const ITERM_OPEN_SCRIPT = `on run argv
  set sessionName to item 1 of argv
  set tmuxCmd to "tmux attach -t " & quoted form of sessionName
  set cmd to "/bin/zsh -lc " & quoted form of tmuxCmd
  tell application "iTerm2"
    activate
    create window with default profile command cmd
  end tell
  return "true"
end run`;

async function openItermWindow(session: string): Promise<boolean> {
  return runOsascript(['-e', ITERM_OPEN_SCRIPT, session]);
}

// Terminal.app has a native scripting verb for this (`do script`) — no need for
// iTerm2's "create window with ... command" workaround — but the login-shell
// wrapping is required for the same reason: `do script` runs outside a login
// shell too, so a bare `tmux attach` still can't see Homebrew's PATH additions.
const TERMINAL_OPEN_SCRIPT = `on run argv
  set sessionName to item 1 of argv
  set tmuxCmd to "tmux attach -t " & quoted form of sessionName
  set cmd to "/bin/zsh -lc " & quoted form of tmuxCmd
  tell application "Terminal"
    activate
    do script cmd
  end tell
  return "true"
end run`;

async function openTerminalWindow(session: string): Promise<boolean> {
  return runOsascript(['-e', TERMINAL_OPEN_SCRIPT, session]);
}

/** Whether `openAppWindow` knows how to open a window for this focus target. */
export function supportsWindowOpen(appName: string): boolean {
  const name = appName.toLowerCase();
  return name.includes('iterm') || name.includes('terminal');
}

/**
 * Opens a new window attached to the given tmux session, for the apps that support
 * it (iTerm2, Terminal — see `supportsWindowOpen`). Resolves false — never throws —
 * for any other app, or when the target app can't be launched/controlled (e.g.
 * Automation denied).
 */
export async function openAppWindow(session: string, appName: string): Promise<boolean> {
  const name = appName.toLowerCase();
  if (name.includes('iterm')) return openItermWindow(session);
  if (name.includes('terminal')) return openTerminalWindow(session);
  return false;
}

export interface FocusOptions {
  /** Application to search; config.focus.appName overrides the 'Cursor' default (e.g. 'iTerm2', 'Terminal'). */
  appName?: string;
  /** tmux session name backing this project, when known — lets the iTerm2 path match
   * by the attached client's tty instead of iTerm2's rename-prone tab/session name. */
  tmuxSession?: string;
}

async function runOsascript(args: string[]): Promise<boolean> {
  try {
    const { stdout } = await execFileP('osascript', args, { timeout: OSASCRIPT_TIMEOUT_MS });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** tty of the client attached to `session`, or null if it has none (or tmux errors). */
async function resolveTmuxTty(session: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'tmux',
      ['list-clients', '-t', `=${session}`, '-F', '#{client_tty}'],
      { timeout: OSASCRIPT_TIMEOUT_MS },
    );
    return stdout.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Activates the configured app and raises the window that belongs to `project`. Resolves
 * false — never throws — when the app is not running, no window matches, or macOS denies
 * the automation/accessibility permission.
 */
export async function focusAppWindow(project: string, opts: FocusOptions = {}): Promise<boolean> {
  const appName = opts.appName ?? 'Cursor';
  const isIterm = appName.toLowerCase().includes('iterm');

  if (isIterm) {
    const tty = opts.tmuxSession ? await resolveTmuxTty(opts.tmuxSession) : null;
    if (tty) return runOsascript(['-e', ITERM_TTY_SCRIPT, tty]);
    return runOsascript(['-e', ITERM_NAME_SCRIPT, project]);
  }

  return runOsascript(['-e', SCRIPT, project, appName]);
}
