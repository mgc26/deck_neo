import { execFile } from 'node:child_process';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  tmuxListSessions,
  tmuxNewSession,
  tmuxSendKeys,
  tmuxSendText,
} from '../../src/system/tmux.js';

const execFileP = promisify(execFile);

/** tmux present on this machine? The whole suite skips cleanly when it is not. */
async function tmuxAvailable(): Promise<boolean> {
  try {
    await execFileP('tmux', ['-V']);
    return true;
  } catch {
    return false;
  }
}
const hasTmux = await tmuxAvailable();

/**
 * Every session lives on a private tmux server (own TMUX_TMPDIR socket dir), so the
 * user's real sessions are never listed, touched, or killed by these tests.
 */
let socketDir: string;
let emptySocketDir: string;
let workDir: string;
const created: string[] = [];
let seq = 0;
const nextName = () => {
  const name = `deckneo-test-${process.pid}-${seq++}`;
  created.push(name);
  return name;
};

beforeAll(async () => {
  if (!hasTmux) return;
  socketDir = await mkdtemp(join(tmpdir(), 'deckneo-sock-'));
  emptySocketDir = await mkdtemp(join(tmpdir(), 'deckneo-nosrv-'));
  workDir = await realpath(await mkdtemp(join(tmpdir(), 'deckneo-cwd-')));
  process.env.TMUX_TMPDIR = socketDir;
  delete process.env.TMUX; // never inherit an outer tmux client
});

afterEach(async () => {
  for (const name of created.splice(0)) {
    await execFileP('tmux', ['kill-session', '-t', name]).catch(() => {});
  }
});

afterAll(async () => {
  if (!hasTmux) return;
  await execFileP('tmux', ['kill-server']).catch(() => {});
  await rm(socketDir, { recursive: true, force: true });
  await rm(emptySocketDir, { recursive: true, force: true });
  await rm(workDir, { recursive: true, force: true });
});

async function startScratch(): Promise<string> {
  const name = nextName();
  await execFileP('tmux', ['new-session', '-d', '-s', name, 'cat']);
  return name;
}

async function capture(session: string): Promise<string> {
  const { stdout } = await execFileP('tmux', ['capture-pane', '-p', '-t', session]);
  return stdout;
}

describe.skipIf(!hasTmux)('tmux executor', () => {
  it('sendText delivers literal text plus Enter', async () => {
    const s = await startScratch();
    await tmuxSendText(s, 'hello; $world `whoami` "quoted"');
    const pane = await capture(s);
    expect(pane).toContain('hello; $world `whoami` "quoted"');
  });

  it('sendText leaves hostile characters unexpanded (no shell interpolation)', async () => {
    const s = await startScratch();
    await tmuxSendText(s, '$(touch /tmp/deckneo-should-not-exist) && echo pwned');
    const pane = await capture(s);
    expect(pane).toContain('$(touch /tmp/deckneo-should-not-exist) && echo pwned');
  });

  it('sendText types dash-prefixed text literally, not as send-keys flags', async () => {
    const s = await startScratch();
    await tmuxSendText(s, '-X not-a-flag');
    const pane = await capture(s);
    expect(pane).toContain('-X not-a-flag');
  });

  it('sendKeys sends named keys', async () => {
    const s = await startScratch();
    await tmuxSendKeys(s, ['h', 'i']);
    await tmuxSendKeys(s, ['Enter']);
    const pane = await capture(s);
    expect(pane).toContain('hi');
  });

  it('sendKeys rejects an unknown session', async () => {
    await expect(tmuxSendKeys('deckneo-test-nope-0', ['Enter'])).rejects.toThrow();
  });

  it('listSessions includes the scratch session, reported detached', async () => {
    const s = await startScratch();
    const sessions = await tmuxListSessions();
    expect(sessions).toContainEqual({ name: s, attached: false });
  });

  it('listSessions parses a session name containing spaces intact', async () => {
    const name = `deckneo test ${process.pid} spaced`;
    created.push(name);
    await execFileP('tmux', ['new-session', '-d', '-s', name, 'cat']);
    const sessions = await tmuxListSessions();
    expect(sessions).toContainEqual({ name, attached: false });
  });

  it('listSessions returns [] when no server is running', async () => {
    const prev = process.env.TMUX_TMPDIR;
    process.env.TMUX_TMPDIR = emptySocketDir;
    try {
      await expect(tmuxListSessions()).resolves.toEqual([]);
    } finally {
      process.env.TMUX_TMPDIR = prev;
    }
  });

  it('newSession creates a detached session with the requested cwd', async () => {
    const name = nextName();
    await tmuxNewSession(name, workDir, 'cat');
    expect((await tmuxListSessions()).map((s) => s.name)).toContain(name);
    const { stdout } = await execFileP('tmux', [
      'display-message',
      '-p',
      '-t',
      name,
      '#{pane_current_path}',
    ]);
    expect(stdout.trim()).toBe(workDir);
  });

  it('newSession does not attach the caller (stays detached)', async () => {
    const name = nextName();
    await tmuxNewSession(name, workDir, 'cat');
    const { stdout } = await execFileP('tmux', [
      'list-sessions',
      '-F',
      '#{session_name} #{session_attached}',
    ]);
    expect(stdout).toContain(`${name} 0`);
  });
});
