// Raise the editor window that belongs to a project, so pressing a session key on the
// Neo also brings that session's terminal to the front.
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

export interface FocusOptions {
  /** Application to search; overridable so tests can target an app that cannot exist. */
  appName?: string;
}

/**
 * Activates the editor and raises the first window whose title contains `project`.
 * Resolves false — never throws — when the app is not running, no window title matches,
 * or macOS denies the automation/accessibility permission.
 */
export async function focusCursorWindow(project: string, opts: FocusOptions = {}): Promise<boolean> {
  const appName = opts.appName ?? 'Cursor';
  try {
    const { stdout } = await execFileP('osascript', ['-e', SCRIPT, project, appName], {
      timeout: OSASCRIPT_TIMEOUT_MS,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}
