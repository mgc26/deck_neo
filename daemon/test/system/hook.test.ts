import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { SessionFile } from '../../src/contracts.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const script = join(repoRoot, 'hooks/report-state.mjs');

interface HookRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Spawns the real hook script with HOME redirected at a throwaway dir. */
function runHook(
  event: string,
  stdinPayload: unknown,
  home: string,
  extraEnv: Record<string, string> = {},
): Promise<HookRun> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ...extraEnv };
  delete env.TMUX;
  if (extraEnv.TMUX) env.TMUX = extraEnv.TMUX;

  const started = Date.now();
  const child = spawn(process.execPath, [script, event], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  child.stdin.end(typeof stdinPayload === 'string' ? stdinPayload : JSON.stringify(stdinPayload));

  return new Promise((res, rej) => {
    child.on('error', rej);
    child.on('close', (code) => res({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

let home: string;
const scratch: string[] = [];
const tmpDir = async (prefix: string): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
const sessionsDir = () => join(home, '.deck-neo/sessions');
const readSession = async (id: string): Promise<SessionFile> =>
  JSON.parse(await readFile(join(sessionsDir(), `${id}.json`), 'utf8')) as SessionFile;
const readLog = async (): Promise<string> => {
  try {
    return await readFile(join(home, '.deck-neo/hook.log'), 'utf8');
  } catch {
    return '';
  }
};

beforeEach(async () => {
  home = await tmpDir('deckneo-home-');
});

afterAll(async () => {
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe('report-state hook', () => {
  it('SessionStart writes an idle state file', async () => {
    const run = await runHook('SessionStart', { session_id: 'abc', cwd: '/tmp/myproj' }, home);
    expect(run.code).toBe(0);
    const f = await readSession('abc');
    expect(f).toMatchObject({
      session_id: 'abc',
      cwd: '/tmp/myproj',
      project: 'myproj',
      state: 'idle',
    });
    expect(typeof f.ts).toBe('number');
    expect(f.ts).toBeGreaterThan(Date.now() - 60_000);
    expect(f.tmux).toBeUndefined();
  });

  it('maps every hook event to its state', async () => {
    const cases: Array<[string, SessionFile['state']]> = [
      ['SessionStart', 'idle'],
      ['UserPromptSubmit', 'working'],
      ['Notification', 'needs-input'],
      ['Stop', 'done'],
      ['SessionEnd', 'ended'],
    ];
    for (const [event, state] of cases) {
      const run = await runHook(event, { session_id: 'ev', cwd: '/tmp/myproj' }, home);
      expect(run.code).toBe(0);
      expect((await readSession('ev')).state).toBe(state);
    }
  });

  it('Notification carries the message as needs-input', async () => {
    await runHook(
      'Notification',
      { session_id: 'n1', cwd: '/tmp/myproj', message: 'permission: Bash(npm test)' },
      home,
    );
    const f = await readSession('n1');
    expect(f.state).toBe('needs-input');
    expect(f.message).toBe('permission: Bash(npm test)');
  });

  it('drops a stale message once the session moves on', async () => {
    await runHook('Notification', { session_id: 'n2', cwd: '/tmp/myproj', message: 'approve?' }, home);
    await runHook('Stop', { session_id: 'n2' }, home);
    const f = await readSession('n2');
    expect(f.state).toBe('done');
    expect(f.message).toBeUndefined();
  });

  it('records the tmux session name when running inside tmux', async () => {
    const shim = await tmpDir('deckneo-shim-');
    await writeFile(join(shim, 'tmux'), '#!/bin/sh\necho fake-tmux-session\n');
    await chmod(join(shim, 'tmux'), 0o755);
    const run = await runHook('SessionStart', { session_id: 't1', cwd: '/tmp/myproj' }, home, {
      TMUX: '/private/tmp/tmux-1000/default,123,0',
      PATH: `${shim}:${process.env.PATH}`,
    });
    expect(run.code).toBe(0);
    expect((await readSession('t1')).tmux).toBe('fake-tmux-session');
  });

  it('preserves tmux, cwd and project from earlier events', async () => {
    const shim = await tmpDir('deckneo-shim-');
    await writeFile(join(shim, 'tmux'), '#!/bin/sh\necho fake-tmux-session\n');
    await chmod(join(shim, 'tmux'), 0o755);
    await runHook('SessionStart', { session_id: 'm1', cwd: '/tmp/myproj' }, home, {
      TMUX: '/private/tmp/tmux-1000/default,123,0',
      PATH: `${shim}:${process.env.PATH}`,
    });
    // Later event, outside tmux and without cwd: earlier facts must survive.
    await runHook('UserPromptSubmit', { session_id: 'm1' }, home);
    const f = await readSession('m1');
    expect(f).toMatchObject({
      state: 'working',
      tmux: 'fake-tmux-session',
      cwd: '/tmp/myproj',
      project: 'myproj',
    });
  });

  it('exits 0 and logs on garbage stdin, writing no state file', async () => {
    const run = await runHook('Stop', 'not json at all {{{', home);
    expect(run.code).toBe(0);
    expect(await readdir(sessionsDir()).catch(() => [])).toEqual([]);
    expect(await readLog()).toMatch(/Stop/);
  });

  it('exits 0 and logs on an unknown event name', async () => {
    const run = await runHook('PreToolUse', { session_id: 'u1', cwd: '/tmp/myproj' }, home);
    expect(run.code).toBe(0);
    expect(await readdir(sessionsDir()).catch(() => [])).toEqual([]);
    expect(await readLog()).toMatch(/PreToolUse/);
  });

  it('exits 0 when session_id is missing', async () => {
    const run = await runHook('Stop', { cwd: '/tmp/myproj' }, home);
    expect(run.code).toBe(0);
    expect(await readdir(sessionsDir()).catch(() => [])).toEqual([]);
    expect(await readLog()).toMatch(/session_id/);
  });

  it('writes nothing to stdout and leaves no temp files behind', async () => {
    const run = await runHook('SessionStart', { session_id: 'clean', cwd: '/tmp/myproj' }, home);
    expect(run.stdout).toBe('');
    expect(await readdir(sessionsDir())).toEqual(['clean.json']);
  });

  it('rejects a session_id that would escape the sessions directory', async () => {
    const run = await runHook('SessionStart', { session_id: '../../escape', cwd: '/tmp/x' }, home);
    expect(run.code).toBe(0);
    expect(await readdir(sessionsDir()).catch(() => [])).toEqual([]);
    expect(await readLog()).toMatch(/session_id/);
  });

  it('completes well inside the hook budget', async () => {
    const run = await runHook('UserPromptSubmit', { session_id: 'p1', cwd: '/tmp/myproj' }, home);
    expect(run.code).toBe(0);
    // Generous bound: includes node process startup, which dominates the script itself.
    expect(run.ms).toBeLessThan(1500);
  });
});

describe('subagent tracking (running agents must keep the light blue)', () => {
  it('SubagentStart marks the session working and counts agents', async () => {
    await runHook('SessionStart', { session_id: 's', cwd: '/tmp/p' }, home);
    await runHook('SubagentStart', { session_id: 's' }, home);
    const f = await readSession('s');
    expect(f.state).toBe('working');
    expect(f.agents).toBe(1);
  });

  it('Stop with live agents stays working; the last SubagentStop lands done', async () => {
    await runHook('SessionStart', { session_id: 's', cwd: '/tmp/p' }, home);
    await runHook('UserPromptSubmit', { session_id: 's' }, home);
    await runHook('SubagentStart', { session_id: 's' }, home);
    await runHook('SubagentStart', { session_id: 's' }, home);
    await runHook('Stop', { session_id: 's' }, home);
    expect((await readSession('s')).state).toBe('working'); // agents still out
    await runHook('SubagentStop', { session_id: 's' }, home);
    expect((await readSession('s')).state).toBe('working'); // one agent left
    await runHook('SubagentStop', { session_id: 's' }, home);
    expect((await readSession('s')).state).toBe('done'); // all home, main idle
  });

  it('SubagentStop while the main loop still runs stays working', async () => {
    await runHook('SessionStart', { session_id: 's', cwd: '/tmp/p' }, home);
    await runHook('UserPromptSubmit', { session_id: 's' }, home);
    await runHook('SubagentStart', { session_id: 's' }, home);
    await runHook('SubagentStop', { session_id: 's' }, home);
    expect((await readSession('s')).state).toBe('working');
  });

  it('needs-input survives subagent churn, message intact', async () => {
    await runHook('SessionStart', { session_id: 's', cwd: '/tmp/p' }, home);
    await runHook('SubagentStart', { session_id: 's' }, home);
    await runHook('Notification', { session_id: 's', message: 'permission' }, home);
    await runHook('SubagentStop', { session_id: 's' }, home);
    const f = await readSession('s');
    expect(f.state).toBe('needs-input');
    expect(f.message).toBe('permission');
  });

  it('the counter never goes negative and SessionStart resets a leak', async () => {
    await runHook('SessionStart', { session_id: 's', cwd: '/tmp/p' }, home);
    await runHook('SubagentStop', { session_id: 's' }, home);
    expect((await readSession('s')).agents ?? 0).toBe(0);
    await runHook('SubagentStart', { session_id: 's' }, home);
    await runHook('SessionStart', { session_id: 's', cwd: '/tmp/p' }, home);
    expect((await readSession('s')).agents ?? 0).toBe(0);
  });
});

describe('idle-nag demotion (waiting-for-input is Ready, not amber)', () => {
  it('maps the idle notification to done, dropping the message', async () => {
    await runHook('SessionStart', { session_id: 's', cwd: '/tmp/p' }, home);
    await runHook('UserPromptSubmit', { session_id: 's' }, home);
    await runHook('Stop', { session_id: 's' }, home);
    await runHook('Notification', { session_id: 's', message: 'Claude is waiting for your input' }, home);
    const f = await readSession('s');
    expect(f.state).toBe('done'); // ready — not blinking amber
    expect(f.message).toBeUndefined();
  });

  it('keeps the idle notification blue while subagents are still out', async () => {
    await runHook('SessionStart', { session_id: 's', cwd: '/tmp/p' }, home);
    await runHook('SubagentStart', { session_id: 's' }, home);
    await runHook('Notification', { session_id: 's', message: 'Claude is waiting for your input' }, home);
    expect((await readSession('s')).state).toBe('working');
  });

  it('still goes amber for permission and question notifications', async () => {
    await runHook('SessionStart', { session_id: 's', cwd: '/tmp/p' }, home);
    for (const message of ['Claude needs your permission to use Bash', 'Claude has a question for you']) {
      await runHook('Notification', { session_id: 's', message }, home);
      const f = await readSession('s');
      expect(f.state).toBe('needs-input');
      expect(f.message).toBe(message);
      await runHook('UserPromptSubmit', { session_id: 's' }, home); // reset
    }
  });
});

describe('idle-nag must not clear a pending prompt', () => {
  it('keeps a pending permission prompt amber when the idle nag arrives', async () => {
    await runHook('SessionStart', { session_id: 's', cwd: '/tmp/p' }, home);
    await runHook('Notification', { session_id: 's', message: 'Claude needs your permission to use Bash' }, home);
    expect((await readSession('s')).state).toBe('needs-input');
    await runHook('Notification', { session_id: 's', message: 'Claude is waiting for your input' }, home);
    const f = await readSession('s');
    expect(f.state).toBe('needs-input'); // still blocked on you, not cleared to green
  });

  it('still demotes the idle nag to done from a non-pending state', async () => {
    await runHook('SessionStart', { session_id: 's', cwd: '/tmp/p' }, home);
    await runHook('Stop', { session_id: 's' }, home);
    await runHook('Notification', { session_id: 's', message: 'Claude is waiting for your input' }, home);
    expect((await readSession('s')).state).toBe('done');
  });
});

describe('idle nag preserves the pending prompt message (F2 residual)', () => {
  it('keeps the permission message when the idle nag lands on a pending prompt', async () => {
    await runHook('SessionStart', { session_id: 's', cwd: '/tmp/p' }, home);
    await runHook('Notification', { session_id: 's', message: 'Claude needs your permission to use Bash' }, home);
    await runHook('Notification', { session_id: 's', message: 'Claude is waiting for your input' }, home);
    const f = await readSession('s');
    expect(f.state).toBe('needs-input');
    expect(f.message).toBe('Claude needs your permission to use Bash'); // not overwritten by the nag
  });
});
