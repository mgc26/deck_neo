// Transparent `claude`/`codex` wrappers + nested-tmux guards.
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const execFileP = promisifyExec();
function promisifyExec() {
  return (cmd: string, args: string[], opts: object = {}) =>
    new Promise<{ stdout: string }>((res, rej) => {
      execFile(cmd, args, opts, (err, stdout) => (err ? rej(err) : res({ stdout: String(stdout) })));
    });
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const bin = (name: string): string => join(repoRoot, 'bin', name);
const scratch: string[] = [];

afterAll(async () => {
  for (const d of scratch.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A shim dir with argv-capturing fakes for the given commands. */
async function shims(...names: string[]): Promise<{ dir: string; captureOf: (n: string) => string }> {
  const dir = await mkdtemp(join(tmpdir(), 'deckneo-wrap-'));
  scratch.push(dir);
  for (const n of names) {
    const capture = join(dir, `${n}.argv`);
    await writeFile(join(dir, n), `#!/bin/sh\nprintf '%s\\n' ${JSON.stringify(n)} "$@" >> "${capture}"\nif [ "$1" = "has-session" ]; then exit 1; fi\n`);
    await chmod(join(dir, n), 0o755);
  }
  return { dir, captureOf: (n) => join(dir, `${n}.argv`) };
}

async function run(script: string, args: string[], shimDir: string, extraEnv: Record<string, string | undefined> = {}): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), 'deckneo-wrapcwd-'));
  scratch.push(cwd);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${shimDir}:${process.env.PATH}`, ...extraEnv };
  delete env.TMUX;
  if (extraEnv.TMUX) env.TMUX = extraEnv.TMUX;
  delete env.DECKNEO_CLAUDE_ARGS;
  delete env.DECKNEO_CODEX_ARGS;
  if (extraEnv.DECKNEO_CLAUDE_ARGS) env.DECKNEO_CLAUDE_ARGS = extraEnv.DECKNEO_CLAUDE_ARGS;
  await execFileP('zsh', [script, ...args], { cwd, env });
}

const argvOf = async (capture: string): Promise<string[]> =>
  (await readFile(capture, 'utf8')).trim().split('\n');

describe('claude-wrapped', () => {
  it('passes a bare-word subcommand straight to the real claude', async () => {
    const { dir, captureOf } = await shims('claude', 'tmux');
    await run(bin('claude-wrapped'), ['mcp', 'list'], dir);
    expect(await argvOf(captureOf('claude'))).toEqual(['claude', 'mcp', 'list']);
  });

  it('routes flags-only invocations through cc into tmux', async () => {
    const { dir, captureOf } = await shims('claude', 'tmux');
    await run(bin('claude-wrapped'), ['--dangerously-skip-permissions'], dir);
    const tmuxArgv = await argvOf(captureOf('tmux'));
    // cc probes has-session first, then creates; the flag rides through to claude.
    expect(tmuxArgv).toContain('new-session');
    expect(tmuxArgv).toContain('--dangerously-skip-permissions');
  });
});

describe('codex-wrapped', () => {
  it('passes a bare-word subcommand straight to the real codex', async () => {
    const { dir, captureOf } = await shims('codex', 'tmux', 'node');
    await run(bin('codex-wrapped'), ['resume', '--last'], dir);
    expect(await argvOf(captureOf('codex'))).toEqual(['codex', 'resume', '--last']);
  });
});

describe('nested-tmux guard', () => {
  it('cc inside tmux runs the real claude with standing args, no nesting', async () => {
    const { dir, captureOf } = await shims('claude', 'tmux');
    await run(bin('cc'), ['--resume'], dir, {
      TMUX: '/tmp/tmux-1/default,1,0',
      DECKNEO_CLAUDE_ARGS: '--dangerously-skip-permissions',
    });
    expect(await argvOf(captureOf('claude'))).toEqual([
      'claude', '--dangerously-skip-permissions', '--resume',
    ]);
    // tmux was never invoked.
    await expect(readFile(captureOf('tmux'), 'utf8')).rejects.toThrow();
  });
});

describe('wrapper non-interactive passthrough and positional prompt', () => {
  it('passes -p/--print/--version/--help straight to the real binary (needs no TTY)', async () => {
    for (const flag of ['-p', '--print', '--version', '--help']) {
      const { dir, captureOf } = await shims('claude', 'tmux');
      await run(bin('claude-wrapped'), [flag, 'x'], dir);
      const claudeArgv = await argvOf(captureOf('claude'));
      expect(claudeArgv[0]).toBe('claude');
      expect(claudeArgv).toContain(flag);
      await expect(readFile(captureOf('tmux'), 'utf8')).rejects.toThrow(); // never tmux
    }
  });

  it('routes a positional prompt into a tmux session, preserving the prompt', async () => {
    const { dir, captureOf } = await shims('claude', 'tmux');
    await run(bin('claude-wrapped'), ['fix the login bug'], dir);
    const tmuxArgv = await argvOf(captureOf('tmux'));
    expect(tmuxArgv).toContain('new-session');
    expect(tmuxArgv).toContain('fix the login bug'); // prompt reached claude, not eaten as a name
  });

  it('passes known subcommands through (mcp, resume)', async () => {
    const c = await shims('claude', 'tmux');
    await run(bin('claude-wrapped'), ['mcp', 'list'], c.dir);
    expect(await argvOf(c.captureOf('claude'))).toEqual(['claude', 'mcp', 'list']);
    const x = await shims('codex', 'tmux', 'node');
    await run(bin('codex-wrapped'), ['resume', '--last'], x.dir);
    expect(await argvOf(x.captureOf('codex'))).toEqual(['codex', 'resume', '--last']);
  });
});
