import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { SessionFile } from '../../src/contracts.js';
import {
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

const FAKE_TMUX = '/private/tmp/tmux-1000/default,1234,0';

let home: string;

beforeEach(async () => {
  home = await tmpDir('deckneo-cxhome-');
});

afterAll(cleanScratch);

const listSessions = (): Promise<string[]> => readdir(sessionsDirOf(home)).catch(() => []);
const readOnlySession = async (): Promise<SessionFile> => {
  const files = await listSessions();
  expect(files).toHaveLength(1);
  return JSON.parse(await readFile(join(sessionsDirOf(home), files[0]), 'utf8')) as SessionFile;
};

describe('--register (bin/cx lights the key before codex starts)', () => {
  it('writes an idle codex record under the explicit session name', async () => {
    const cwd = await projectDir('myproj');
    const run = await runAdapter(['--register', '--name', 'api'], { home, cwd });

    expect(run.code).toBe(0);
    const f = await readSession(home, 'codex-api');
    expect(f).toMatchObject({
      session_id: 'codex-api',
      cwd,
      project: 'myproj',
      state: 'idle',
      kind: 'codex',
      tmux: 'api',
    });
    expect(typeof f.ts).toBe('number');
    expect(f.ts).toBeGreaterThan(Date.now() - 60_000);
  });

  it('falls back to the cwd basename when no name is given', async () => {
    const cwd = await projectDir('fallback-proj');
    const run = await runAdapter(['--register'], { home, cwd });

    expect(run.code).toBe(0);
    const f = await readSession(home, 'codex-fallback-proj');
    expect(f.state).toBe('idle');
    expect(f.kind).toBe('codex');
    // Registering outside tmux has no session name to send keys to yet.
    expect(f.tmux).toBeUndefined();
  });

  it('prefers an explicit --name over the surrounding tmux session', async () => {
    const cwd = await projectDir('myproj');
    const pathDir = await tmuxNameShim('outer-session');
    const run = await runAdapter(['--register', '--name', 'api-2'], {
      home,
      cwd,
      pathDir,
      tmux: FAKE_TMUX,
    });

    expect(run.code).toBe(0);
    expect(await listSessions()).toEqual(['codex-api-2.json']);
    expect((await readSession(home, 'codex-api-2')).tmux).toBe('api-2');
  });

  it('uses the surrounding tmux session when --name is absent', async () => {
    const cwd = await projectDir('myproj');
    const pathDir = await tmuxNameShim('outer-session');
    await runAdapter(['--register'], { home, cwd, pathDir, tmux: FAKE_TMUX });

    expect((await readSession(home, 'codex-outer-session')).tmux).toBe('outer-session');
  });
});

describe('notify mode', () => {
  it('agent-turn-complete marks the session done', async () => {
    const cwd = await projectDir('myproj');
    const pathDir = await tmuxNameShim('api');
    const run = await runAdapter([turnComplete()], { home, cwd, pathDir, tmux: FAKE_TMUX });

    expect(run.code).toBe(0);
    const f = await readSession(home, 'codex-api');
    expect(f).toMatchObject({ state: 'done', kind: 'codex', tmux: 'api', project: 'myproj', cwd });
  });

  it('identifies the session by cwd basename when codex runs outside tmux', async () => {
    const cwd = await projectDir('loose-proj');
    const run = await runAdapter([turnComplete()], { home, cwd });

    expect(run.code).toBe(0);
    const f = await readSession(home, 'codex-loose-proj');
    expect(f.state).toBe('done');
    expect(f.tmux).toBeUndefined();
  });

  it('lands on the same record cx registered, and keeps its facts', async () => {
    const cwd = await projectDir('api');
    await runAdapter(['--register', '--name', 'api'], { home, cwd });
    const pathDir = await tmuxNameShim('api');
    await runAdapter([turnComplete()], { home, cwd, pathDir, tmux: FAKE_TMUX });

    expect(await listSessions()).toEqual(['codex-api.json']);
    expect(await readSession(home, 'codex-api')).toMatchObject({
      state: 'done',
      tmux: 'api',
      project: 'api',
      kind: 'codex',
    });
  });

  it('preserves the registered tmux name when tmux detection fails later', async () => {
    const cwd = await projectDir('api');
    await runAdapter(['--register', '--name', 'api'], { home, cwd });
    // Same identity (cwd basename === session name), but $TMUX is gone this time.
    await runAdapter([turnComplete()], { home, cwd });

    const f = await readSession(home, 'codex-api');
    expect(f.state).toBe('done');
    expect(f.tmux).toBe('api');
  });

  it('never revives an ended session, but --register does', async () => {
    const cwd = await projectDir('api');
    await runAdapter(['--register', '--name', 'api'], { home, cwd });
    const path = join(sessionsDirOf(home), 'codex-api.json');
    await writeFile(path, JSON.stringify({ ...(await readSession(home, 'codex-api')), state: 'ended' }));

    await runAdapter([turnComplete()], { home, cwd });
    expect((await readSession(home, 'codex-api')).state).toBe('ended');

    await runAdapter(['--register', '--name', 'api'], { home, cwd });
    expect((await readSession(home, 'codex-api')).state).toBe('idle');
  });

  it('exits 0, logs and writes nothing for an unknown event type', async () => {
    const cwd = await projectDir('myproj');
    const run = await runAdapter([JSON.stringify({ type: 'something-new' })], { home, cwd });

    expect(run.code).toBe(0);
    expect(await listSessions()).toEqual([]);
    expect(await readLog(home)).toMatch(/something-new/);
  });

  it('exits 0, logs and writes nothing for a garbage payload', async () => {
    const cwd = await projectDir('myproj');
    const run = await runAdapter(['not json at all {{{'], { home, cwd });

    expect(run.code).toBe(0);
    expect(await listSessions()).toEqual([]);
    expect(await readLog(home)).toMatch(/codex/);
  });

  it('exits 0 and writes nothing when invoked with no arguments at all', async () => {
    const cwd = await projectDir('myproj');
    const run = await runAdapter([], { home, cwd });

    expect(run.code).toBe(0);
    expect(await listSessions()).toEqual([]);
    expect(await readLog(home)).not.toBe('');
  });

  it('writes nothing to stdout and leaves no temp files behind', async () => {
    const cwd = await projectDir('myproj');
    const run = await runAdapter([turnComplete()], { home, cwd });

    expect(run.stdout).toBe('');
    expect(await listSessions()).toEqual(['codex-myproj.json']);
  });

  it('completes well inside the notify budget', async () => {
    const cwd = await projectDir('myproj');
    const run = await runAdapter([turnComplete()], { home, cwd });

    expect(run.code).toBe(0);
    // Generous bound: node process startup dominates the script itself.
    expect(run.ms).toBeLessThan(1500);
  });
});

describe('chain-forwarding (the existing notify program must keep working)', () => {
  it('invokes the forward program with its own args plus the codex payload', async () => {
    const cwd = await projectDir('myproj');
    const { program, capture } = await argvShim();
    const payload = turnComplete();
    const run = await runAdapter(['--forward', program, 'turn-ended', payload], { home, cwd });

    expect(run.code).toBe(0);
    const argv = (await waitForFile(capture)).split('\n').filter(Boolean);
    expect(argv).toEqual(['turn-ended', payload]);
    expect((await readSession(home, 'codex-myproj')).state).toBe('done');
  });

  it('does not wait for the forward program to finish', async () => {
    const cwd = await projectDir('myproj');
    const { program, capture } = await argvShim({ sleepSeconds: 2 });
    const run = await runAdapter(['--forward', program, 'turn-ended', turnComplete()], {
      home,
      cwd,
    });

    expect(run.code).toBe(0);
    expect(run.ms).toBeLessThan(1500);
    // The state file is already written while the forward target is still sleeping.
    expect((await readSession(home, 'codex-myproj')).state).toBe('done');
    // ...and the detached child survives our exit.
    expect(await waitForFile(capture, 8000)).toContain('turn-ended');
  });

  it('forwards a program path containing spaces without shell interpretation', async () => {
    const cwd = await projectDir('myproj');
    const { program, capture } = await argvShim({ fileName: 'Sky Computer Use Client' });
    const run = await runAdapter(['--forward', program, 'turn-ended', turnComplete()], {
      home,
      cwd,
    });

    expect(run.code).toBe(0);
    expect(await waitForFile(capture)).toContain('turn-ended');
  });

  it('still forwards when the payload is unusable, so the chain never breaks', async () => {
    const cwd = await projectDir('myproj');
    const { program, capture } = await argvShim();
    const run = await runAdapter(['--forward', program, 'turn-ended', 'garbage{{'], { home, cwd });

    expect(run.code).toBe(0);
    expect(await listSessions()).toEqual([]);
    const argv = (await waitForFile(capture)).split('\n').filter(Boolean);
    expect(argv).toEqual(['turn-ended', 'garbage{{']);
  });

  it('survives a forward program that does not exist', async () => {
    const cwd = await projectDir('myproj');
    const run = await runAdapter(
      ['--forward', '/nope/not/a/program', 'turn-ended', turnComplete()],
      { home, cwd },
    );

    expect(run.code).toBe(0);
    expect((await readSession(home, 'codex-myproj')).state).toBe('done');
  });

  it('exits 0 and logs when --forward names no program', async () => {
    const cwd = await projectDir('myproj');
    const run = await runAdapter(['--forward'], { home, cwd });

    expect(run.code).toBe(0);
    expect(await readLog(home)).toMatch(/forward/);
  });
});

describe('identity is filename-safe and stable across the register/notify split', () => {
  it('sanitizes a hostile session name instead of escaping the sessions dir', async () => {
    const cwd = await projectDir('myproj');
    const run = await runAdapter(['--register', '--name', '../../pwned'], { home, cwd });

    expect(run.code).toBe(0);
    const files = await listSessions();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^codex-[A-Za-z0-9._-]+\.json$/);
    await expect(stat(join(home, 'pwned.json'))).rejects.toThrow();
    await expect(stat(join(home, '.deck-neo/pwned.json'))).rejects.toThrow();
  });

  it('sanitizes a hostile tmux session name too', async () => {
    const cwd = await projectDir('myproj');
    const pathDir = await tmuxNameShim('../../evil');
    const run = await runAdapter([turnComplete()], { home, cwd, pathDir, tmux: FAKE_TMUX });

    expect(run.code).toBe(0);
    const files = await listSessions();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^codex-[A-Za-z0-9._-]+\.json$/);
  });

  it('register and notify agree on a name containing spaces', async () => {
    const cwd = await projectDir('myproj');
    await runAdapter(['--register', '--name', 'two words'], { home, cwd });
    const registered = await listSessions();
    expect(registered).toHaveLength(1);

    const pathDir = await tmuxNameShim('two words');
    await runAdapter([turnComplete()], { home, cwd, pathDir, tmux: FAKE_TMUX });

    expect(await listSessions()).toEqual(registered);
    const f = await readOnlySession();
    expect(f.state).toBe('done');
    // send-keys needs the name tmux actually uses, not the sanitized filename.
    expect(f.tmux).toBe('two words');
  });

  it('register and notify agree on the sanitized name cx creates', async () => {
    // tmux keeps '.'/':' verbatim but cannot target them, so bin/cx sanitizes the
    // name BEFORE creating the session and registering — both sides see deck_neo.
    const cwd = await projectDir('myproj');
    await runAdapter(['--register', '--name', 'deck_neo'], { home, cwd });
    const registered = await listSessions();
    expect(registered).toHaveLength(1);

    const pathDir = await tmuxNameShim('deck_neo');
    await runAdapter([turnComplete()], { home, cwd, pathDir, tmux: FAKE_TMUX });

    expect(await listSessions()).toEqual(registered);
    expect((await readSession(home, 'codex-deck_neo')).tmux).toBe('deck_neo');
  });

  it('keeps distinct non-Latin names in distinct files', async () => {
    const cwd = await projectDir('myproj');
    await runAdapter(['--register', '--name', '仕事'], { home, cwd });
    await runAdapter(['--register', '--name', '趣味'], { home, cwd });

    const files = await listSessions();
    expect(files).toHaveLength(2); // previously both collapsed to codex-__.json
  });

  it('register and notify derive the same hashed id for a non-Latin name', async () => {
    const cwd = await projectDir('myproj');
    await runAdapter(['--register', '--name', '仕事'], { home, cwd });
    const registered = await listSessions();
    expect(registered).toHaveLength(1);

    const pathDir = await tmuxNameShim('仕事');
    await runAdapter([turnComplete()], { home, cwd, pathDir, tmux: FAKE_TMUX });

    expect(await listSessions()).toEqual(registered); // same file, no split identity
    const f = JSON.parse(
      await readFile(join(sessionsDirOf(home), registered[0]!), 'utf8'),
    ) as { state: string; tmux: string };
    expect(f.state).toBe('done');
    expect(f.tmux).toBe('仕事');
  });

  it('keeps very long names inside filesystem limits', async () => {
    const cwd = await projectDir('myproj');
    const run = await runAdapter(['--register', '--name', 'x'.repeat(400)], { home, cwd });

    expect(run.code).toBe(0);
    const files = await listSessions();
    expect(files).toHaveLength(1);
    expect(files[0].length).toBeLessThanOrEqual(255);
  });
});
