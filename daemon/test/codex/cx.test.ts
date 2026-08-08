import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanScratch,
  cxScript,
  projectDir,
  readSession,
  runAdapter,
  sessionsDirOf,
  tmpDir,
  tmuxNameShim,
  turnComplete,
} from './helpers.js';

const execFileP = promisify(execFile);

let home: string;

beforeEach(async () => {
  home = await tmpDir('deckneo-cxhome-');
});

afterAll(cleanScratch);

/**
 * A `tmux` on PATH that records its argv instead of starting anything.
 * `has-session` answers per `sessionExists` so both cx branches are testable.
 */
async function tmuxArgvShim(sessionExists = false): Promise<{ dir: string; capture: string }> {
  const dir = await tmpDir('deckneo-cxtmuxargv-');
  const capture = join(dir, 'argv.txt');
  const hasSessionRc = sessionExists ? 0 : 1;
  // display-message reports 0 attached, so an existing session reads as unattached
  // (the reconnect path) rather than empty (which fail-closed treats as attached).
  await writeFile(
    join(dir, 'tmux'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${capture}"\nif [ "$1" = "has-session" ]; then exit ${hasSessionRc}; fi\nif [ "$1" = "display-message" ]; then printf 0; exit 0; fi\n`,
  );
  await chmod(join(dir, 'tmux'), 0o755);
  return { dir, capture };
}

async function runCx(args: string[], cwd: string, shimDir: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.TMUX;
  env.PATH = `${shimDir}:${dirname(process.execPath)}:${process.env.PATH}`;
  await execFileP('zsh', [cxScript, ...args], { cwd, env });
}

const tmuxArgv = async (capture: string): Promise<string[]> =>
  (await readFile(capture, 'utf8')).trim().split('\n');

describe('bin/cx', () => {
  it('is an executable zsh script', async () => {
    const s = await stat(cxScript);
    expect(s.mode & 0o111).toBeGreaterThan(0);
    expect(await readFile(cxScript, 'utf8')).toMatch(/^#!.*zsh/);
  });

  it('passes a zsh syntax check', async () => {
    await expect(execFileP('zsh', ['-n', cxScript])).resolves.toBeTruthy();
  });

  const createThenAttach = (name: string): string[] => [
    'has-session', '-t', `=${name}`,
    'new-session', '-d', '-s', name, 'codex',
    'attach-session', '-t', `=${name}`,
  ];

  it('defaults the session name to the current directory basename', async () => {
    const cwd = await projectDir('myproj');
    const { dir, capture } = await tmuxArgvShim();
    await runCx([], cwd, dir);

    expect(await tmuxArgv(capture)).toEqual(createThenAttach('myproj'));
  });

  it('uses an explicit session name when given one', async () => {
    const cwd = await projectDir('myproj');
    const { dir, capture } = await tmuxArgvShim();
    await runCx(['api-2'], cwd, dir);

    expect(await tmuxArgv(capture)).toEqual(createThenAttach('api-2'));
  });

  it('keeps a name with spaces as a single argument', async () => {
    const cwd = await projectDir('myproj');
    const { dir, capture } = await tmuxArgvShim();
    await runCx(['two words'], cwd, dir);

    expect(await tmuxArgv(capture)).toEqual(createThenAttach('two words'));
  });

  it('sanitizes . and : out of the session name — tmux cannot target them with -t', async () => {
    const cwd = await projectDir('deck.neo');
    const { dir, capture } = await tmuxArgvShim();
    await runCx([], cwd, dir);
    expect(await tmuxArgv(capture)).toEqual(createThenAttach('deck_neo'));
    expect((await readSession(home, 'codex-deck_neo')).tmux).toBe('deck_neo');

    const explicit = await tmuxArgvShim();
    await runCx(['a.b:c'], cwd, explicit.dir);
    expect(await tmuxArgv(explicit.capture)).toEqual(createThenAttach('a_b_c'));
  });

  it('re-attaches to an unattached existing session without re-registering', async () => {
    const cwd = await projectDir('myproj');
    // has-session says exists; display-message reports 0 attached (unattached).
    const { dir, capture } = await tmuxArgvShim(true);
    await runCx([], cwd, dir);

    expect(await tmuxArgv(capture)).toEqual([
      'has-session', '-t', '=myproj',
      'display-message', '-p', '-t', '=myproj:', '#{session_attached}',
      'attach-session', '-t', '=myproj',
    ]);
    // No register call happened: nothing was written.
    const entries = existsSync(sessionsDirOf(home)) ? await readdir(sessionsDirOf(home)) : [];
    expect(entries).toEqual([]);
  });

  it('a tmux failure aborts before registration — no phantom key', async () => {
    const cwd = await projectDir('myproj');
    const dir = await tmpDir('deckneo-cxfailtmux-');
    await writeFile(join(dir, 'tmux'), '#!/bin/sh\nexit 1\n');
    await chmod(join(dir, 'tmux'), 0o755);

    await expect(runCx([], cwd, dir)).rejects.toThrow(); // cx must exit non-zero
    // No sessions dir, or an empty one — either way, nothing was registered.
    const entries = existsSync(sessionsDirOf(home)) ? await readdir(sessionsDirOf(home)) : [];
    expect(entries).toEqual([]);
  });

  it('registers the session before starting tmux, so the key lights immediately', async () => {
    const cwd = await projectDir('myproj');
    const { dir } = await tmuxArgvShim();
    await runCx([], cwd, dir);

    const f = await readSession(home, 'codex-myproj');
    expect(f).toMatchObject({
      session_id: 'codex-myproj',
      cwd,
      project: 'myproj',
      state: 'idle',
      kind: 'codex',
      tmux: 'myproj',
    });
  });

  it('registers under the explicit name, not the directory', async () => {
    const cwd = await projectDir('myproj');
    const { dir } = await tmuxArgvShim();
    await runCx(['api-2'], cwd, dir);

    expect(await readdir(sessionsDirOf(home))).toEqual(['codex-api-2.json']);
    expect((await readSession(home, 'codex-api-2')).tmux).toBe('api-2');
  });

  it('registers the identity the notify events will later derive inside tmux', async () => {
    const cwd = await projectDir('myproj');
    const { dir } = await tmuxArgvShim();
    await runCx(['api-2'], cwd, dir);
    const afterRegister = await readdir(sessionsDirOf(home));

    // What codex's notify program sees once it runs inside the session cx created.
    const pathDir = await tmuxNameShim('api-2');
    await runAdapter([turnComplete()], {
      home,
      cwd,
      pathDir,
      tmux: '/private/tmp/tmux-1000/default,1234,0',
    });

    expect(await readdir(sessionsDirOf(home))).toEqual(afterRegister);
    expect((await readSession(home, 'codex-api-2')).state).toBe('done');
  });

  it('still attaches even if registration fails', async () => {
    const cwd = await projectDir('myproj');
    const { dir, capture } = await tmuxArgvShim();
    // A `node` that always fails, shadowing the real one.
    await writeFile(join(dir, 'node'), '#!/bin/sh\nexit 3\n');
    await chmod(join(dir, 'node'), 0o755);
    await runCx([], cwd, dir);

    expect(await tmuxArgv(capture)).toEqual(createThenAttach('myproj'));
  });
});

describe('bin/cx flag passthrough', () => {
  it('treats a leading dash argument as codex flags, not a session name', async () => {
    const cwd = await projectDir('myproj');
    const { dir, capture } = await tmuxArgvShim();
    await runCx(['--sandbox', 'read-only'], cwd, dir);
    expect(await tmuxArgv(capture)).toEqual([
      'has-session', '-t', '=myproj',
      'new-session', '-d', '-s', 'myproj', 'codex', '--sandbox', 'read-only',
      'attach-session', '-t', '=myproj',
    ]);
  });
});

describe('bin/cx multi-session', () => {
  it('starts a fresh -2 codex session when the base is already attached', async () => {
    const cwd = await projectDir('myproj');
    const dir = await tmpDir('deckneo-cxstate-');
    const state = join(dir, 'sess');
    await import('node:fs/promises').then((fs) => fs.mkdir(state));
    await import('node:fs/promises').then((fs) => fs.writeFile(join(state, 'myproj'), '1')); // attached
    const capture = join(dir, 'argv.txt');
    await writeFile(
      join(dir, 'tmux'),
      [
        '#!/bin/sh',
        `printf '%s\\n' "$@" >> "${capture}"`,
        `state=${state}`,
        'cmd=$1; shift; rawt=""',
        'while [ $# -gt 0 ]; do if [ "$1" = "-t" ] || [ "$1" = "-s" ]; then rawt=$2; fi; shift; done',
        'name=${rawt#=}; name=${name%:}',
        'case "$cmd" in',
        '  has-session) [ -f "$state/$name" ] && exit 0 || exit 1 ;;',
        // pane-level: only a colon-suffixed target resolves (models real tmux).
        '  display-message) case "$rawt" in *:) cat "$state/$name" 2>/dev/null || printf 0;; *) : ;; esac; exit 0 ;;',
        '  new-session) printf 0 > "$state/$name"; exit 0 ;;',
        'esac; exit 0',
      ].join('\n'),
    );
    await chmod(join(dir, 'tmux'), 0o755);
    await runCx([], cwd, dir);

    const argv = (await readFile(capture, 'utf8')).trim().split('\n');
    expect(argv).toContain('myproj-2');
    // fresh -2 was registered
    expect((await readSession(home, 'codex-myproj-2')).tmux).toBe('myproj-2');
  });
});
