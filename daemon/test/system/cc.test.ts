import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const execFileP = promisify(execFile);
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const cc = join(repoRoot, 'bin/cc');

const scratch: string[] = [];

/**
 * A `claude` on PATH that refuses to be the real one. cc only ever execs claude
 * directly on its inside-tmux branch; every other path hands the string
 * "claude" to tmux, which here is a shim that never runs it. So reaching this
 * script means cc took that branch — under the real CLI that would talk to the
 * API, block on stdin until the test times out, and fire report-state hooks
 * into the user's ~/.deck-neo. Failing loudly with the argv keeps that
 * misrouting a one-line test failure instead of a silent side effect.
 */
async function writeClaudeGuard(dir: string): Promise<void> {
  const guard = join(dir, 'claude');
  await writeFile(
    guard,
    `#!/bin/sh\nprintf 'cc.test: claude was executed directly (cc took its inside-tmux branch): %s\\n' "$*" >&2\nexit 97\n`,
  );
  await chmod(guard, 0o755);
}

/**
 * A `tmux` on PATH that records argv and answers `has-session` as "nothing
 * exists" (exit 1) so the no-name path takes the fresh-create branch. Records
 * every call (append) so multi-call sequences are visible.
 */
async function makeTmuxShim(): Promise<{ dir: string; capture: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'deckneo-ccshim-'));
  scratch.push(dir);
  const capture = join(dir, 'argv.txt');
  await writeFile(
    join(dir, 'tmux'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> ${capture}\nif [ "$1" = "has-session" ]; then exit 1; fi\n`,
  );
  await chmod(join(dir, 'tmux'), 0o755);
  await writeClaudeGuard(dir);
  return { dir, capture };
}

/**
 * A stateful `tmux` fake backed by a dir of session files, so has-session /
 * display-message / new-session / attach-session behave across multiple cc
 * runs. `attachedNames` are reported as having a client (session_attached=1).
 */
async function makeStatefulTmux(existing: { name: string; attached: boolean }[]): Promise<{
  dir: string;
  capture: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), 'deckneo-ccstate-'));
  scratch.push(dir);
  const state = join(dir, 'sessions');
  await mkdir(state);
  for (const s of existing) await writeFile(join(state, s.name), s.attached ? '1' : '0');
  const capture = join(dir, 'argv.txt');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$@" >> ${capture}`,
    `state=${state}`,
    'cmd=$1; shift',
    'rawt=""',
    'while [ $# -gt 0 ]; do if [ "$1" = "-t" ] || [ "$1" = "-s" ]; then rawt=$2; fi; shift; done',
    // Model real tmux target resolution: a session-level command (has-session,
    // attach) accepts "=NAME"; a pane-level one (display-message, send-keys)
    // needs "=NAME:" and returns EMPTY for a bare "=NAME". This is the exact
    // distinction that let the fail-closed-always bug through before.
    'name=${rawt#=}',
    'case "$cmd" in',
    '  has-session) [ -f "$state/${name%:}" ] && exit 0 || exit 1 ;;',
    '  display-message) case "$rawt" in *:) cat "$state/${name%:}" 2>/dev/null || printf "0";; *) : ;; esac; exit 0 ;;',
    '  new-session) printf 0 > "$state/${name%:}"; exit 0 ;;',
    '  attach-session) exit 0 ;;',
    'esac',
    'exit 0',
  ].join('\n');
  await writeFile(join(dir, 'tmux'), script);
  await chmod(join(dir, 'tmux'), 0o755);
  await writeClaudeGuard(dir);
  return { dir, capture };
}

const lastCall = (argv: string[]): string[] => {
  // Split the flat argv log back into calls by tmux verbs.
  const verbs = new Set(['has-session', 'display-message', 'new-session', 'attach-session']);
  const calls: string[][] = [];
  for (const tok of argv) {
    if (verbs.has(tok)) calls.push([tok]);
    else calls[calls.length - 1]?.push(tok);
  }
  return calls[calls.length - 1] ?? [];
};

/**
 * The environment a cc run gets. cc is a real zsh script that reads the ambient
 * environment, so inheriting the developer's shell wholesale means measuring
 * that shell instead of cc. Each of these is scrubbed because it silently
 * rewrites what cc does:
 *   TMUX/TMUX_PANE      set for anyone running the suite from inside tmux (the
 *                       normal way to use Deck Neo), which sends cc down its
 *                       inside-tmux branch: it execs claude and never calls
 *                       tmux at all, so no argv is captured.
 *   DECKNEO_CLAUDE_ARGS standing flags a Deck Neo user really does export; they
 *                       get spliced into every expected tmux argv. The one test
 *                       that cares passes it explicitly.
 *   HOME/ZDOTDIR        zsh reads $ZDOTDIR/.zshenv (else $HOME/.zshenv) even for
 *                       a non-interactive script, and that file may rewrite PATH
 *                       out from under the shims. HOME also keeps any hook that
 *                       does run away from the real ~/.deck-neo.
 *   TMUX_TMPDIR         pinned at a scratch dir, so a tmux that somehow escaped
 *                       the shim starts a private server instead of talking to
 *                       the user's live one.
 */
function ccEnv(shimDir: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.TMUX;
  delete env.TMUX_PANE;
  delete env.DECKNEO_CLAUDE_ARGS;
  delete env.ZDOTDIR;
  return {
    ...env,
    HOME: testHome,
    TMUX_TMPDIR: tmuxTmpdir,
    PATH: `${shimDir}:${process.env.PATH}`,
    ...extra,
  };
}

async function runCc(
  args: string[],
  cwd: string,
  shimDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<void> {
  // Below vitest's testTimeout so a cc that blocks reports its own stderr
  // rather than an anonymous suite-level timeout.
  await execFileP('zsh', [cc, ...args], { cwd, env: ccEnv(shimDir, extraEnv), timeout: 10_000 });
}

let projectDir: string;
let testHome: string;
let tmuxTmpdir: string;

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), 'deckneo-cc-'));
  scratch.push(root);
  projectDir = join(root, 'myproj');
  await mkdir(projectDir);
  testHome = join(root, 'home');
  await mkdir(testHome);
  // mkdtemp gives 0700, which is what tmux demands of a socket dir.
  tmuxTmpdir = await mkdtemp(join(tmpdir(), 'deckneo-ccsock-'));
  scratch.push(tmuxTmpdir);
});

afterAll(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('bin/cc', () => {
  it('is an executable zsh script', async () => {
    const s = await stat(cc);
    expect(s.mode & 0o111).toBeGreaterThan(0);
    expect(await readFile(cc, 'utf8')).toMatch(/^#!.*zsh/);
  });

  it('passes a zsh syntax check', async () => {
    await expect(execFileP('zsh', ['-n', cc])).resolves.toBeTruthy();
  });

  it('defaults the session name to the current directory basename (fresh create, no -A)', async () => {
    const { dir, capture } = await makeTmuxShim();
    await runCc([], projectDir, dir);
    const argv = (await readFile(capture, 'utf8')).trim().split('\n');
    expect(argv.slice(0, 3)).toEqual(['has-session', '-t', '=myproj']);
    expect(lastCall(argv)).toEqual(['new-session', '-s', 'myproj', 'claude']);
  });

  it('uses an explicit session name when given one', async () => {
    const { dir, capture } = await makeTmuxShim();
    await runCc(['api'], projectDir, dir);
    expect((await readFile(capture, 'utf8')).trim().split('\n')).toEqual([
      'new-session',
      '-A',
      '-s',
      'api',
      'claude',
    ]);
  });

  it('keeps a name with spaces as a single argument', async () => {
    const { dir, capture } = await makeTmuxShim();
    await runCc(['two words'], projectDir, dir);
    expect((await readFile(capture, 'utf8')).trim().split('\n')).toEqual([
      'new-session',
      '-A',
      '-s',
      'two words',
      'claude',
    ]);
  });
});

describe('bin/cc session-name sanitization', () => {
  it('replaces . and : — tmux cannot target such names with -t', async () => {
    const { dir, capture } = await makeTmuxShim();
    await runCc(['deck.neo:x'], projectDir, dir);
    expect((await readFile(capture, 'utf8')).trim().split('\n')).toEqual([
      'new-session', '-A', '-s', 'deck_neo_x', 'claude',
    ]);
  });
});

describe('bin/cc flag passthrough', () => {
  it('treats a leading dash argument as claude flags, not a session name', async () => {
    const { dir, capture } = await makeTmuxShim();
    await runCc(['--dangerously-skip-permissions'], projectDir, dir);
    expect(lastCall((await readFile(capture, 'utf8')).trim().split('\n'))).toEqual([
      'new-session', '-s', 'myproj', 'claude', '--dangerously-skip-permissions',
    ]);
  });

  it('passes flags after an explicit name through to claude', async () => {
    const { dir, capture } = await makeTmuxShim();
    await runCc(['scratch', '--model', 'opus'], projectDir, dir);
    expect((await readFile(capture, 'utf8')).trim().split('\n')).toEqual([
      'new-session', '-A', '-s', 'scratch', 'claude', '--model', 'opus',
    ]);
  });
});

describe('bin/cc inside an existing tmux session', () => {
  // Also the harness's own alarm: this is the single branch on which cc execs
  // claude, and the guard shim is what stands between it and the real CLI. If
  // an inherited TMUX ever reaches cc again, every other test lands here too —
  // and gets exit 97 with an explanation instead of quietly running claude for
  // real and writing into ~/.deck-neo.
  it('runs claude in place, and PATH resolution reaches the shim rather than the real CLI', async () => {
    const { dir, capture } = await makeTmuxShim();
    await expect(
      runCc(['--model', 'opus'], projectDir, dir, { TMUX: '/tmp/deckneo-fake/default,1,0' }),
    ).rejects.toMatchObject({
      code: 97,
      stderr: expect.stringContaining('--model opus'),
    });
    // No nesting: cc must not have gone anywhere near tmux.
    await expect(readFile(capture, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('bin/cc standing args (DECKNEO_CLAUDE_ARGS)', () => {
  it('inserts standing flags before per-invocation args', async () => {
    const { dir, capture } = await makeTmuxShim();
    await runCc(['scratch', '--model', 'opus'], projectDir, dir, {
      DECKNEO_CLAUDE_ARGS: '--dangerously-skip-permissions',
    });
    expect((await readFile(capture, 'utf8')).trim().split('\n')).toEqual([
      'new-session', '-A', '-s', 'scratch',
      'claude', '--dangerously-skip-permissions', '--model', 'opus',
    ]);
  });

  it('is a no-op when the variable is unset or empty', async () => {
    const { dir, capture } = await makeTmuxShim();
    // Explicitly empty; ccEnv already drops any inherited value, so this run
    // covers the empty case and the surrounding tests cover unset.
    await runCc([], projectDir, dir, { DECKNEO_CLAUDE_ARGS: '' });
    expect(lastCall((await readFile(capture, 'utf8')).trim().split('\n'))).toEqual([
      'new-session', '-s', 'myproj', 'claude',
    ]);
  });
});

describe('bin/cc multi-session (the reported "second cc re-views the first" bug)', () => {
  it('starts a fresh -2 session when the base is already attached', async () => {
    const { dir, capture } = await makeStatefulTmux([{ name: 'myproj', attached: true }]);
    await runCc([], projectDir, dir);
    expect(lastCall((await readFile(capture, 'utf8')).trim().split('\n'))).toEqual([
      'new-session', '-s', 'myproj-2', 'claude',
    ]);
  });

  it('reconnects to the base when it exists but is unattached', async () => {
    const { dir, capture } = await makeStatefulTmux([{ name: 'myproj', attached: false }]);
    await runCc([], projectDir, dir);
    expect(lastCall((await readFile(capture, 'utf8')).trim().split('\n'))).toEqual([
      'attach-session', '-t', '=myproj',
    ]);
  });

  it('skips an attached -2 to a fresh -3', async () => {
    const { dir, capture } = await makeStatefulTmux([
      { name: 'myproj', attached: true },
      { name: 'myproj-2', attached: true },
    ]);
    await runCc([], projectDir, dir);
    expect(lastCall((await readFile(capture, 'utf8')).trim().split('\n'))).toEqual([
      'new-session', '-s', 'myproj-3', 'claude',
    ]);
  });

  it('an explicit name still attaches-or-creates that exact session (-A)', async () => {
    const { dir, capture } = await makeStatefulTmux([{ name: 'myproj', attached: true }]);
    await runCc(['myproj'], projectDir, dir);
    expect((await readFile(capture, 'utf8')).trim().split('\n')).toEqual([
      'new-session', '-A', '-s', 'myproj', 'claude',
    ]);
  });
});

describe('bin/cc reconnect to an unattached session (F-A regression)', () => {
  it('reconnects to the base when it exists and is UNATTACHED (not a fresh -2)', async () => {
    const { dir, capture } = await makeStatefulTmux([{ name: 'myproj', attached: false }]);
    await runCc([], projectDir, dir);
    // Must attach to myproj, NOT create myproj-2 — proves attached() reads the
    // real count via the =NAME: pane target instead of failing-closed-always.
    const argv = (await readFile(capture, 'utf8')).trim().split('\n');
    expect(argv).toContain('attach-session');
    expect(lastCall(argv)).toEqual(['attach-session', '-t', '=myproj']);
    expect(argv).not.toContain('myproj-2');
    // The attached-check used a colon-suffixed pane target.
    expect(argv).toContain('=myproj:');
  });
})
