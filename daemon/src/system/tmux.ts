// tmux executor. Every call goes through execFile with an argument array — command
// strings are never assembled, because the text we forward (canned commands, prompts)
// can contain shell metacharacters.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { TmuxSession } from '../contracts.js';

const execFileP = promisify(execFile);

/** Longest we wait on any single tmux invocation before treating it as failed. */
const TMUX_TIMEOUT_MS = 5000;

async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileP('tmux', args, { timeout: TMUX_TIMEOUT_MS });
  return stdout;
}

/**
 * Exact-match pane target for send-keys: the `=` prefix disables tmux's
 * prefix/glob resolution and the trailing `:` selects that session's active
 * pane (a bare `=name` is read as a pane spec and fails). So a session named
 * `deck` can never resolve to a different session `deck_neo`.
 */
const target = (session: string): string => `=${session}:`;

/** `tmux send-keys -t <session> <...keys>` — keys are tmux key names, e.g. ['Enter']. */
export async function tmuxSendKeys(session: string, keys: string[]): Promise<void> {
  await tmux(['send-keys', '-t', target(session), ...keys]);
}

/**
 * Sends `text` literally (-l, so nothing is interpreted as a key name), then a separate
 * Enter. Two calls: with -l tmux would type the word "Enter" instead of pressing it.
 */
export async function tmuxSendText(session: string, text: string): Promise<void> {
  // `--` terminates option parsing: text beginning with '-' (a command like
  // "-foo") is typed literally instead of being read as send-keys flags.
  await tmux(['send-keys', '-t', target(session), '-l', '--', text]);
  await tmux(['send-keys', '-t', target(session), 'Enter']);
}

function isNoServer(err: unknown): boolean {
  const e = err as { code?: unknown; stderr?: unknown };
  if (e?.code === 'ENOENT') return true; // tmux not installed -> no sessions exist
  const stderr = typeof e?.stderr === 'string' ? e.stderr : '';
  return /no server running|error connecting to|no current client/i.test(stderr);
}

/**
 * Live sessions with their attachment state. Resolves [] when no tmux server is
 * running (or tmux is absent); other failures reject, so a transient tmux error
 * is never mistaken for "every session died" by the caller's GC pass.
 */
export async function tmuxListSessions(): Promise<TmuxSession[]> {
  try {
    // Client count first: session names may contain spaces, so the name must be
    // the line's tail, split on the first space only.
    const stdout = await tmux(['list-sessions', '-F', '#{session_attached} #{session_name}']);
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.includes(' '))
      .map((line) => {
        const cut = line.indexOf(' ');
        return { name: line.slice(cut + 1), attached: Number(line.slice(0, cut)) > 0 };
      });
  } catch (err) {
    if (isNoServer(err)) return [];
    throw err;
  }
}

/**
 * `tmux new-session -d -s <name> -c <cwd> <command> [args...]` — detached.
 * command + args are passed as SEPARATE argv elements: tmux only shell-interprets
 * a session command when it is a single string, so keeping them split means a
 * hostile arg (e.g. from config `launch.claudeArgs`) can never reach a shell.
 */
export async function tmuxNewSession(
  name: string,
  cwd: string,
  command: string,
  args: string[] = [],
): Promise<void> {
  await tmux(['new-session', '-d', '-s', name, '-c', cwd, command, ...args]);
}
