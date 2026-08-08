import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { SessionFile } from '../../src/contracts.js';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const adapterScript = join(repoRoot, 'hooks/codex-notify.mjs');
export const cxScript = join(repoRoot, 'bin/cx');

/** Directories created by the helpers; every suite removes them in afterAll. */
export const scratch: string[] = [];

export async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return realpath(dir);
}

export async function cleanScratch(): Promise<void> {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
}

/** A throwaway directory whose basename is `name` — the cwd-derived identity. */
export async function projectDir(name: string): Promise<string> {
  const root = await tmpDir('deckneo-cxproj-');
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** A PATH entry holding a `tmux` that reports `name` for `display-message -p '#S'`. */
export async function tmuxNameShim(name: string): Promise<string> {
  const dir = await tmpDir('deckneo-cxtmux-');
  await writeFile(join(dir, 'tmux'), `#!/bin/sh\ncat <<'EOF'\n${name}\nEOF\n`);
  await chmod(join(dir, 'tmux'), 0o755);
  return dir;
}

/** A program that records its argv to `capture`, optionally after sleeping. */
export async function argvShim(
  opts: { dirPrefix?: string; fileName?: string; sleepSeconds?: number } = {},
): Promise<{ program: string; capture: string }> {
  const dir = await tmpDir(opts.dirPrefix ?? 'deckneo-cxfwd-');
  const program = join(dir, opts.fileName ?? 'forward-target');
  const capture = join(dir, 'argv.txt');
  const sleep = opts.sleepSeconds ? `sleep ${opts.sleepSeconds}\n` : '';
  await writeFile(program, `#!/bin/sh\n${sleep}printf '%s\\n' "$@" > "${capture}"\n`);
  await chmod(program, 0o755);
  return { program, capture };
}

export interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface RunOpts {
  home: string;
  cwd?: string;
  /** Prepended to PATH — used to install the tmux shim. */
  pathDir?: string;
  /** Set to make the adapter believe it runs inside tmux. */
  tmux?: string;
}

/** Spawns the real adapter script with HOME (and optionally cwd/TMUX) redirected. */
export function runAdapter(args: string[], opts: RunOpts): Promise<Run> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: opts.home };
  delete env.TMUX; // the test runner itself may live in tmux
  if (opts.tmux) env.TMUX = opts.tmux;
  if (opts.pathDir) env.PATH = `${opts.pathDir}:${process.env.PATH}`;

  const started = Date.now();
  const child = spawn(process.execPath, [adapterScript, ...args], {
    env,
    cwd: opts.cwd ?? repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));

  return new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', (code) => res({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

export const turnComplete = (message = 'all done'): string =>
  JSON.stringify({
    type: 'agent-turn-complete',
    'turn-id': 'turn-1',
    'input-messages': ['hi'],
    'last-assistant-message': message,
  });

/**
 * The richer turn-end payload newer codex builds send. Field names are the
 * kebab-case set the codex binary carries for its notify program (`thread-id`,
 * `turn-id`, `cwd`, `client`, `input-messages`, `last-assistant-message`);
 * `turnComplete` above is the older shape, which carries no identity at all.
 */
export const appTurnComplete = (
  opts: { threadId?: string; cwd?: string; turnId?: string; message?: string } = {},
): string => {
  const payload: Record<string, unknown> = {
    type: 'agent-turn-complete',
    'turn-id': opts.turnId ?? 'turn-1',
    client: 'app',
    'input-messages': ['hi'],
    'last-assistant-message': opts.message ?? 'all done',
  };
  if (opts.threadId !== undefined) payload['thread-id'] = opts.threadId;
  if (opts.cwd !== undefined) payload.cwd = opts.cwd;
  return JSON.stringify(payload);
};

export const sessionsDirOf = (home: string): string => join(home, '.deck-neo/sessions');

export const readSession = async (home: string, id: string): Promise<SessionFile> =>
  JSON.parse(await readFile(join(sessionsDirOf(home), `${id}.json`), 'utf8')) as SessionFile;

export const readLog = async (home: string): Promise<string> => {
  try {
    return await readFile(join(home, '.deck-neo/hook.log'), 'utf8');
  } catch {
    return '';
  }
};

export async function waitForFile(path: string, timeoutMs = 6000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}
