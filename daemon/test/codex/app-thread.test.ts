// Turn-ends that arrive with no tmux and no usable cwd.
//
// The ChatGPT desktop app runs its codex engine as `.../ChatGPT.app/Contents/
// Resources/codex ... app-server`, launched by LaunchServices: its cwd is '/'
// and its environment has no TMUX (verified with `lsof -d cwd` and `ps eww` on
// the live process). Every notify program it spawns inherits that, and
// basename('/') is '' — so neither of the two identity sources the adapter
// prefers can name the session. No Codex turn may be silently dropped: an
// event that reaches the adapter has to land on some key.

import { readdir } from 'node:fs/promises';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  appTurnComplete,
  argvShim,
  cleanScratch,
  projectDir,
  readLog,
  readSession,
  runAdapter,
  sessionsDirOf,
  tmpDir,
  tmuxNameShim,
  turnComplete,
  waitForFile,
} from './helpers.js';

/** What the app-server (and anything else launched by launchd) reports as cwd. */
const APP_SERVER_CWD = '/';
const FAKE_TMUX = '/private/tmp/tmux-1000/default,1234,0';
const THREAD_A = '00000000-0000-7000-8000-000000000001';
const THREAD_B = '00000000-0000-7000-8000-000000000002';

let home: string;

beforeEach(async () => {
  home = await tmpDir('deckneo-cxhome-');
});

afterAll(cleanScratch);

const listSessions = (): Promise<string[]> => readdir(sessionsDirOf(home)).catch(() => []);
const onlySession = async (): Promise<string> => {
  const files = await listSessions();
  expect(files).toHaveLength(1);
  return files[0]!.replace(/\.json$/, '');
};

describe('a turn-end with no tmux, no cwd and no payload identity', () => {
  it('lands on a key instead of being dropped', async () => {
    const run = await runAdapter([turnComplete()], { home, cwd: APP_SERVER_CWD });

    expect(run.code).toBe(0);
    const id = await onlySession();
    const f = await readSession(home, id);
    expect(f).toMatchObject({ state: 'done', kind: 'codex' });
    expect(id).toMatch(/^codex-[A-Za-z0-9._-]+$/);
    // No tmux to send keys to: the deck can only watch this one.
    expect(f.tmux).toBeUndefined();
  });

  it('reuses that one key for every later turn rather than one key per turn', async () => {
    for (const message of ['first', 'second', 'third']) {
      await runAdapter([turnComplete(message)], { home, cwd: APP_SERVER_CWD });
    }

    expect(await listSessions()).toHaveLength(1);
    expect((await readSession(home, await onlySession())).state).toBe('done');
  });

  it('records in the log which key it fell back to, and why', async () => {
    await runAdapter([turnComplete()], { home, cwd: APP_SERVER_CWD });

    const log = await readLog(home);
    expect(log).toContain(await onlySession());
    // The old message claimed nothing was written; it must not say that now.
    expect(log).not.toMatch(/could not derive a session name/);
  });

  it('labels the fallback tile in the room a watch-only key actually has', async () => {
    await runAdapter([turnComplete()], { home, cwd: APP_SERVER_CWD });

    const f = await readSession(home, await onlySession());
    // layout.ts: MAX_LABEL_CHARS is 10 and the watch-only mark eats two of them.
    expect(f.project.length).toBeGreaterThan(0);
    expect(f.project.length).toBeLessThanOrEqual(8);
  });

  it('still hands the payload to the displaced notify program', async () => {
    const { program, capture } = await argvShim();
    const payload = turnComplete();
    const run = await runAdapter(['--forward', program, 'turn-ended', payload], {
      home,
      cwd: APP_SERVER_CWD,
    });

    expect(run.code).toBe(0);
    expect((await waitForFile(capture)).split('\n').filter(Boolean)).toEqual([
      'turn-ended',
      payload,
    ]);
    expect((await readSession(home, await onlySession())).state).toBe('done');
  });
});

describe('an app thread that carries its own identity', () => {
  it('keeps one key across turns, keyed off the thread and not the turn', async () => {
    await runAdapter([appTurnComplete({ threadId: THREAD_A, cwd: '/', turnId: 't1' })], {
      home,
      cwd: APP_SERVER_CWD,
    });
    await runAdapter([appTurnComplete({ threadId: THREAD_A, cwd: '/', turnId: 't2' })], {
      home,
      cwd: APP_SERVER_CWD,
    });

    expect(await listSessions()).toHaveLength(1);
    expect((await readSession(home, await onlySession())).state).toBe('done');
  });

  it('stays in the codex id namespace so kinds never collide', async () => {
    await runAdapter([appTurnComplete({ threadId: THREAD_A, cwd: '/' })], {
      home,
      cwd: APP_SERVER_CWD,
    });

    const id = await onlySession();
    expect(id).toMatch(/^codex-[A-Za-z0-9._-]+$/);
    expect((await readSession(home, id)).kind).toBe('codex');
  });

  it('does not share the unidentified key', async () => {
    await runAdapter([turnComplete()], { home, cwd: APP_SERVER_CWD });
    await runAdapter([appTurnComplete({ threadId: THREAD_A })], { home, cwd: APP_SERVER_CWD });

    expect(await listSessions()).toHaveLength(2);
  });

  it('gives two threads opened in the same directory two keys', async () => {
    const dir = await projectDir('deck_neo');
    await runAdapter([appTurnComplete({ threadId: THREAD_A, cwd: dir })], {
      home,
      cwd: APP_SERVER_CWD,
    });
    await runAdapter([appTurnComplete({ threadId: THREAD_B, cwd: dir })], {
      home,
      cwd: APP_SERVER_CWD,
    });

    expect(await listSessions()).toHaveLength(2);
  });

  it('never lands on the key of a tmux session in the same directory', async () => {
    // `cx` in ~/…/deck_neo registers the tmux session `deck_neo`; an app thread
    // resumed in that same directory is a DIFFERENT session and must not flip
    // its tile to done, nor inherit its send-keys target.
    const dir = await projectDir('deck_neo');
    await runAdapter(['--register', '--name', 'deck_neo'], { home, cwd: dir });
    await runAdapter([appTurnComplete({ threadId: THREAD_A, cwd: dir })], {
      home,
      cwd: APP_SERVER_CWD,
    });

    expect(await listSessions()).toHaveLength(2);
    const tmuxSession = await readSession(home, 'codex-deck_neo');
    expect(tmuxSession).toMatchObject({ state: 'idle', tmux: 'deck_neo' });
  });

  it('keeps its key when the same thread is resumed in another directory', async () => {
    // The app asks which directory to resume a thread in, so one thread can
    // report different paths on different turns — same session, same key.
    const first = await projectDir('deck_neo');
    const second = await projectDir('other-proj');
    await runAdapter([appTurnComplete({ threadId: THREAD_A, cwd: first })], {
      home,
      cwd: APP_SERVER_CWD,
    });
    await runAdapter([appTurnComplete({ threadId: THREAD_A, cwd: second, turnId: 't2' })], {
      home,
      cwd: APP_SERVER_CWD,
    });

    expect(await listSessions()).toHaveLength(1);
    expect((await readSession(home, await onlySession())).project).toBe('other-proj');
  });

  it('borrows the workspace name for the tile but keeps the key distinct', async () => {
    const dir = await projectDir('deck_neo');
    await runAdapter([appTurnComplete({ threadId: THREAD_A, cwd: dir })], {
      home,
      cwd: APP_SERVER_CWD,
    });

    const id = await onlySession();
    expect(id).not.toBe('codex-deck_neo');
    const f = await readSession(home, id);
    expect(f.project).toBe('deck_neo');
    expect(f.tmux).toBeUndefined();
  });
});

describe('the payload is only semi-trusted', () => {
  it('cannot walk the identity out of the sessions directory', async () => {
    const run = await runAdapter(
      [appTurnComplete({ threadId: '../../pwned', cwd: '/../../../etc/passwd/../../pwned' })],
      { home, cwd: APP_SERVER_CWD },
    );

    expect(run.code).toBe(0);
    for (const file of await listSessions()) expect(file).toMatch(/^codex-[A-Za-z0-9._-]+\.json$/);
    await expect(readSession(home, '../../pwned')).rejects.toThrow();
  });

  it('cannot smuggle a send-keys target into the record', async () => {
    // `tmux` is a send-keys argument: it comes from the live tmux session or
    // from a previous record, never from the payload, whoever wrote that.
    const hostile = JSON.stringify({
      type: 'agent-turn-complete',
      'thread-id': THREAD_A,
      cwd: '/tmp/x',
      tmux: 'victim-session',
      state: 'working',
      kind: 'claude',
    });
    const run = await runAdapter([hostile], { home, cwd: APP_SERVER_CWD });

    expect(run.code).toBe(0);
    const f = await readSession(home, await onlySession());
    expect(f.tmux).toBeUndefined();
    expect(f).toMatchObject({ state: 'done', kind: 'codex' });
  });
});

describe('payload identity never overrides the real thing', () => {
  it('a session running inside tmux is still named by tmux', async () => {
    const cwd = await projectDir('myproj');
    const pathDir = await tmuxNameShim('api');
    const run = await runAdapter([appTurnComplete({ threadId: THREAD_A, cwd: '/somewhere/else' })], {
      home,
      cwd,
      pathDir,
      tmux: FAKE_TMUX,
    });

    expect(run.code).toBe(0);
    expect(await listSessions()).toEqual(['codex-api.json']);
    expect(await readSession(home, 'codex-api')).toMatchObject({
      state: 'done',
      tmux: 'api',
      project: 'myproj',
    });
  });

  it('a session with a real cwd is still named by its cwd', async () => {
    const cwd = await projectDir('loose-proj');
    await runAdapter([appTurnComplete({ threadId: THREAD_A, cwd: '/somewhere/else' })], {
      home,
      cwd,
    });

    expect(await listSessions()).toEqual(['codex-loose-proj.json']);
  });
});
