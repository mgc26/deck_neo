import { describe, it, expect, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { CockpitState, SessionFile } from '../../src/contracts.js';
import { SessionStore, parseSessionFile } from '../../src/core/store.js';
import { makeTmpDir, nextEvent, settle, waitSession, waitUntil, writeRaw, writeSession } from './helpers.js';

const HOUR = 60 * 60 * 1000;

describe('parseSessionFile', () => {
  const base = {
    session_id: 's1',
    cwd: '/tmp/api',
    project: 'api',
    state: 'idle',
    ts: Date.now(),
  };
  const parse = (extra: Record<string, unknown> = {}): SessionFile | null =>
    parseSessionFile(JSON.stringify({ ...base, ...extra }));

  it('parses a minimal record and leaves the optional phase-2 fields absent', () => {
    const file = parse();
    expect(file).not.toBeNull();
    expect(file?.kind).toBeUndefined();
    expect(file?.agents).toBeUndefined();
    expect(file?.main).toBeUndefined();
  });

  it('accepts and passes through both agent kinds', () => {
    expect(parse({ kind: 'claude' })?.kind).toBe('claude');
    expect(parse({ kind: 'codex' })?.kind).toBe('codex');
  });

  it('rejects an unknown or non-string kind', () => {
    for (const kind of ['gemini', '', 'Codex', 7, null, ['codex'], { k: 'codex' }]) {
      expect(parse({ kind })).toBeNull();
    }
  });

  it('accepts a finite agents count and passes it through', () => {
    expect(parse({ agents: 0 })?.agents).toBe(0);
    expect(parse({ agents: 3 })?.agents).toBe(3);
  });

  it('rejects a non-numeric agents count', () => {
    for (const agents of ['3', null, true, [], { n: 3 }]) {
      expect(parse({ agents })).toBeNull();
    }
  });

  // Non-finite numbers are unreachable through JSON (NaN/Infinity are not valid
  // JSON literals, so the parse fails first); the finiteness guard in the parser
  // mirrors the one on `ts` and is not separately testable from this entry point.

  it('accepts both main phases and passes them through', () => {
    expect(parse({ main: 'running' })?.main).toBe('running');
    expect(parse({ main: 'idle' })?.main).toBe('idle');
  });

  it('rejects an unknown or non-string main phase', () => {
    for (const main of ['working', '', 'Running', 1, null, ['idle']]) {
      expect(parse({ main })).toBeNull();
    }
  });

  it('carries the phase-2 fields alongside the phase-1 ones', () => {
    const file = parse({ kind: 'codex', tmux: 'api', message: 'hi', agents: 2, main: 'running' });
    expect(file).toEqual({
      session_id: 's1',
      cwd: '/tmp/api',
      project: 'api',
      state: 'idle',
      ts: base.ts,
      kind: 'codex',
      message: 'hi',
      tmux: 'api',
      agents: 2,
      main: 'running',
    });
  });
});

describe('SessionStore', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(opts?: {
    staleMs?: number;
    watchOnlyStaleMs?: number;
    reconcileMs?: number;
  }): Promise<{ dir: string; store: SessionStore }> {
    const dir = await makeTmpDir('deckneo-store-');
    const store = new SessionStore(dir, opts);
    cleanups.push(async () => {
      await store.stop();
      await rm(dir, { recursive: true, force: true });
    });
    return { dir, store };
  }

  const idsOf = (state: CockpitState): (string | null)[] =>
    state.sessions.map((s) => (s ? s.file.session_id : null));

  it('reads existing files before start() resolves', async () => {
    const { dir, store } = await setup();
    await writeSession(dir, { session_id: 's1' });
    await writeSession(dir, { session_id: 's2' });
    await store.start();

    const state = store.getState();
    expect(state.sessions).toHaveLength(4);
    expect(idsOf(state)).toEqual(['s1', 's2', null, null]);
    expect(state.selectedSlot).toBeNull();
  });

  it('assigns the lowest free slot in arrival order', async () => {
    const { dir, store } = await setup();
    await store.start();

    await writeSession(dir, { session_id: 's1', project: 'api' });
    await waitSession(store, 0, 's1');
    await writeSession(dir, { session_id: 's2', project: 'web' });
    await waitSession(store, 1, 's2');

    expect(idsOf(store.getState())).toEqual(['s1', 's2', null, null]);
    expect(store.getState().sessions[0]?.slot).toBe(0);
    expect(store.getState().sessions[1]?.file.project).toBe('web');
  });

  it('compacts arrival order when a session is released', async () => {
    const { dir, store } = await setup();
    await store.start();

    for (const id of ['s1', 's2', 's3']) {
      await writeSession(dir, { session_id: id });
      await waitUntil(
        () => store.getState().sessions.some((s) => s?.file.session_id === id),
        `${id} to be tracked`,
      );
    }
    await writeSession(dir, { session_id: 's2', state: 'ended' });
    await waitUntil(() => store.getState().sessions[1]?.file.session_id === 's3', 's3 to compact left');

    // s2 gone -> [s1, s3]; s4 appends at the end (arrival order, no slot reuse).
    await writeSession(dir, { session_id: 's4' });
    await waitSession(store, 2, 's4');
    expect(idsOf(store.getState())).toEqual(['s1', 's3', 's4', null]);
  });

  it('frees the slot on state "ended" and clears the selection', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 's1' });
    await waitSession(store, 0, 's1');

    store.select(0);
    expect(store.getState().selectedSlot).toBe(0);

    await writeSession(dir, { session_id: 's1', state: 'ended' });
    await waitUntil(() => store.getState().sessions[0] === null, 'ended session to free its slot');
    expect(store.getState().selectedSlot).toBeNull();
  });

  it('tracks a 5th+ session on the next page (unlimited, paged)', async () => {
    const { dir, store } = await setup();
    await store.start();

    // Wait for each session to be ingested before writing the next one so the
    // assertion tests store arrival order rather than watcher scheduling.
    for (const [slot, id] of ['s1', 's2', 's3', 's4'].entries()) {
      await writeSession(dir, { session_id: id });
      await waitSession(store, slot, id);
    }

    await writeSession(dir, { session_id: 's5' });
    await waitUntil(() => store.getState().pageCount === 2, 'a second page to appear');
    store.setPage(1);
    await waitSession(store, 0, 's5');

    await writeSession(dir, { session_id: 's6' });
    await waitSession(store, 1, 's6');

    store.setPage(0);
    expect(idsOf(store.getState())).toEqual(['s1', 's2', 's3', 's4']); // page 0
    store.setPage(1);
    expect(idsOf(store.getState())).toEqual(['s5', 's6', null, null]); // page 1
  });

  it('drops files older than the default stale window', async () => {
    const { dir, store } = await setup();
    await writeSession(dir, { session_id: 'old', ts: Date.now() - 25 * HOUR });
    await writeSession(dir, { session_id: 'fresh' });
    await store.start();

    expect(idsOf(store.getState())).toEqual(['fresh', null, null, null]);
  });

  it('honours a custom staleMs', async () => {
    const { dir, store } = await setup({ staleMs: 1000 });
    // tmux-backed so the controllable-session window (staleMs) applies, not the
    // shorter watch-only one.
    await writeSession(dir, { session_id: 'old', ts: Date.now() - 5000, tmux: 'old' });
    await store.start();

    expect(idsOf(store.getState())).toEqual([null, null, null, null]);
  });

  it('skips malformed json without crashing', async () => {
    const { dir, store } = await setup();
    await writeRaw(dir, 'bad.json', 'not json at all');
    await writeSession(dir, { session_id: 'good' });
    await store.start();

    expect(idsOf(store.getState())).toEqual(['good', null, null, null]);
  });

  it('frees the slot when a tracked file becomes malformed', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 's1' });
    await waitSession(store, 0, 's1');
    store.select(0);

    await writeRaw(dir, 's1.json', '{ truncated');
    await waitUntil(() => store.getState().sessions[0] === null, 'malformed file to free its slot');
    expect(store.getState().selectedSlot).toBeNull();
  });

  it('frees the slot when the file is deleted', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 's1' });
    await waitSession(store, 0, 's1');

    await unlink(join(dir, 's1.json'));
    await waitUntil(() => store.getState().sessions[0] === null, 'deleted file to free its slot');
  });

  it('gcAgainstTmux frees dead-tmux slots only', async () => {
    const { dir, store } = await setup();
    await writeSession(dir, { session_id: 's1', tmux: 'a' });
    await writeSession(dir, { session_id: 's2', tmux: 'b' });
    await writeSession(dir, { session_id: 's3' });
    await store.start();
    store.select(1);

    store.gcAgainstTmux([{ name: 'a', attached: true }]);

    // s2 (dead tmux 'b') released; arrival order compacts to [s1, s3].
    expect(idsOf(store.getState())).toEqual(['s1', 's3', null, null]);
    expect(store.getState().selectedSlot).toBeNull(); // the selected s2 is gone
  });

  it('select() is a no-op for an empty or out-of-range slot', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 's1' });
    await waitSession(store, 0, 's1');

    store.select(2);
    expect(store.getState().selectedSlot).toBeNull();
    store.select(9);
    expect(store.getState().selectedSlot).toBeNull();
    store.select(0);
    expect(store.getState().selectedSlot).toBe(0);
  });

  it('emits change with a length-4 sessions array', async () => {
    const { dir, store } = await setup();
    await store.start();
    const changed = nextEvent<CockpitState>(store, 'change');
    await writeSession(dir, { session_id: 's1', state: 'needs-input', message: 'approve?' });
    const state = await changed;

    expect(state.sessions).toHaveLength(4);
    expect(state.sessions[0]?.file.message).toBe('approve?');
    expect(state.sessions.slice(1)).toEqual([null, null, null]);
  });

  it('emits change when the selection changes', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 's1' });
    await waitSession(store, 0, 's1');

    const changed = nextEvent<CockpitState>(store, 'change');
    store.select(0);
    expect((await changed).selectedSlot).toBe(0);
  });

  // The reconcile sweep is the safety net for events fs.watch drops; each of
  // these three assertions is reachable only through the sweep, never through
  // an fs event, so they fail if the sweep stops running.
  it('reconcile adopts a session whose add event the watcher missed', async () => {
    const { dir, store } = await setup({ reconcileMs: 40 });
    await store.start();
    // Write the file directly and never emit through the watcher path — only the
    // periodic rescan can pick it up. (The 5th+ session is tracked, not dropped.)
    await writeSession(dir, { session_id: 's-missed' });
    await waitUntil(
      () => store.getState().sessions.some((s) => s?.file.session_id === 's-missed'),
      'the reconcile sweep to adopt the session',
    );
  });

  it('reconcile drops a session that goes stale while running', async () => {
    const { dir, store } = await setup({ staleMs: 300, watchOnlyStaleMs: 300, reconcileMs: 40 });
    await store.start();
    await writeSession(dir, { session_id: 's1' });
    await waitSession(store, 0, 's1');

    await waitUntil(
      () => store.getState().sessions[0] === null,
      'session to age out of the stale window',
      3000,
    );
  });

  it('reconcile does not emit change when nothing moved', async () => {
    const { dir, store } = await setup({ reconcileMs: 30 });
    await store.start();
    await writeSession(dir, { session_id: 's1' });
    await waitSession(store, 0, 's1');

    const seen: CockpitState[] = [];
    store.on('change', (s: CockpitState) => seen.push(s));
    await settle(300);
    expect(seen).toHaveLength(0);
  });

  it('stops watching after stop()', async () => {
    const { dir, store } = await setup();
    await store.start();
    const seen: CockpitState[] = [];
    store.on('change', (s: CockpitState) => seen.push(s));
    await store.stop();

    await writeSession(dir, { session_id: 's1' });
    await settle();
    expect(seen).toHaveLength(0);
  });

  it('carries kind/agents/main from the file into the cockpit state', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, {
      session_id: 'cx1',
      project: 'api',
      tmux: 'api',
      kind: 'codex',
      agents: 2,
      main: 'running',
    });
    await waitSession(store, 0, 'cx1');

    expect(store.getState().sessions[0]?.file).toMatchObject({
      kind: 'codex',
      agents: 2,
      main: 'running',
    });
  });

  it('leaves kind absent for a file that does not declare one', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 's1' });
    await waitSession(store, 0, 's1');

    expect(store.getState().sessions[0]?.file.kind).toBeUndefined();
  });
});

// markWorking exists because Codex's only notify event fires at turn END: without
// an optimistic override the key stays 'idle'-coloured for the whole turn.
describe('SessionStore.markWorking', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(opts?: { reconcileMs?: number }): Promise<{ dir: string; store: SessionStore }> {
    const dir = await makeTmpDir('deckneo-store-mw-');
    const store = new SessionStore(dir, opts);
    cleanups.push(async () => {
      await store.stop();
      await rm(dir, { recursive: true, force: true });
    });
    return { dir, store };
  }

  it('sets the slot to working and emits change', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 'cx1', kind: 'codex', tmux: 'api', state: 'done' });
    await waitSession(store, 0, 'cx1');

    const changed = nextEvent<CockpitState>(store, 'change');
    store.markWorking('cx1');
    expect((await changed).sessions[0]?.file.state).toBe('working');
    expect(store.getState().sessions[0]?.file.state).toBe('working');
  });

  it('keeps every other field of the session intact', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 'cx1', project: 'api', kind: 'codex', tmux: 'api' });
    await waitSession(store, 0, 'cx1');

    store.markWorking('cx1');
    expect(store.getState().sessions[0]?.file).toMatchObject({
      session_id: 'cx1',
      project: 'api',
      kind: 'codex',
      tmux: 'api',
    });
  });

  it('does not write anything to disk', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 'cx1', kind: 'codex', tmux: 'api' });
    await waitSession(store, 0, 'cx1');
    const before = await readFile(join(dir, 'cx1.json'), 'utf8');

    store.markWorking('cx1');
    await settle(150);

    expect(await readFile(join(dir, 'cx1.json'), 'utf8')).toBe(before);
    expect(store.getState().sessions[0]?.file.state).toBe('working');
  });

  it('is overwritten by the next file write', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 'cx1', kind: 'codex', tmux: 'api' });
    await waitSession(store, 0, 'cx1');

    store.markWorking('cx1');
    expect(store.getState().sessions[0]?.file.state).toBe('working');

    await writeSession(dir, { session_id: 'cx1', kind: 'codex', tmux: 'api', state: 'done' });
    await waitUntil(
      () => store.getState().sessions[0]?.file.state === 'done',
      'the file write to overwrite the optimistic state',
    );
  });

  // Pins a known limitation rather than a desired behaviour: the reconcile sweep
  // re-reads every file whether or not it changed, so the override dies within
  // reconcileMs (2s in production) even though codex writes nothing until its
  // turn ends. Change this test if the reconciliation contract changes.
  it('is reverted by the reconcile sweep even when no file was written', async () => {
    const { dir, store } = await setup({ reconcileMs: 40 });
    await store.start();
    await writeSession(dir, { session_id: 'cx1', kind: 'codex', tmux: 'api', state: 'done' });
    await waitSession(store, 0, 'cx1');

    store.markWorking('cx1');
    expect(store.getState().sessions[0]?.file.state).toBe('working');

    await waitUntil(
      () => store.getState().sessions[0]?.file.state === 'done',
      'the reconcile sweep to revert the optimistic state',
    );
  });

  it('is a no-op for an unknown session id', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 'cx1', kind: 'codex' });
    await waitSession(store, 0, 'cx1');

    const seen: CockpitState[] = [];
    store.on('change', (s: CockpitState) => seen.push(s));
    for (const id of ['nope', '', 'other-id']) store.markWorking(id);
    await settle();

    expect(seen).toHaveLength(0);
    expect(store.getState().sessions[0]?.file.state).toBe('idle');
  });

  it('does not re-emit when the session is already working', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 'cx1', kind: 'codex', state: 'working' });
    await waitSession(store, 0, 'cx1');

    const seen: CockpitState[] = [];
    store.on('change', (s: CockpitState) => seen.push(s));
    store.markWorking('cx1');
    await settle();

    expect(seen).toHaveLength(0);
  });
});

describe('SessionStore file retirement (QA finding: state files accumulated forever)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(opts?: { staleMs?: number; reconcileMs?: number; endedRetentionMs?: number }) {
    const dir = await makeTmpDir('deckneo-store-gc-');
    const store = new SessionStore(dir, opts);
    cleanups.push(async () => {
      await store.stop();
      await rm(dir, { recursive: true, force: true });
    });
    return { dir, store };
  }

  it('frees the slot but keeps a fresh ended file as a tombstone (hook guard reads it)', async () => {
    const { dir, store } = await setup();
    await store.start();
    await writeSession(dir, { session_id: 'gone' });
    await waitSession(store, 0, 'gone');

    await writeSession(dir, { session_id: 'gone', state: 'ended' });
    await waitUntil(() => store.getState().sessions[0] === null, 'slot to be freed');
    await settle(150);
    expect(existsSync(join(dir, 'gone.json'))).toBe(true);
  });

  it('deletes ended tombstones once the retention window passes', async () => {
    const { dir, store } = await setup({ endedRetentionMs: 0, reconcileMs: 50 });
    await store.start();
    await writeSession(dir, { session_id: 'gone' });
    await waitSession(store, 0, 'gone');

    await writeSession(dir, { session_id: 'gone', state: 'ended' });
    await waitUntil(() => store.getState().sessions[0] === null, 'slot to be freed');
    await waitUntil(() => !existsSync(join(dir, 'gone.json')), 'ended tombstone to be deleted');
  });

  it('deletes stale state files found at startup', async () => {
    const { dir, store } = await setup({ staleMs: HOUR });
    await writeSession(dir, { session_id: 'old', ts: Date.now() - 2 * HOUR });
    await store.start();

    expect(store.getState().sessions[0]).toBeNull();
    await waitUntil(() => !existsSync(join(dir, 'old.json')), 'stale state file to be deleted');
  });

  it('gcAgainstTmux retirement survives the reconcile scan', async () => {
    const { dir, store } = await setup({ reconcileMs: 50 });
    await store.start();
    await writeSession(dir, { session_id: 's1', tmux: 'dead' });
    await waitSession(store, 0, 's1');

    store.gcAgainstTmux([]);
    expect(store.getState().sessions[0]).toBeNull();

    // Several reconcile scans later the session must not have been re-adopted.
    await settle(250);
    expect(store.getState().sessions[0]).toBeNull();
    expect(existsSync(join(dir, 's1.json'))).toBe(false);
  });
});

describe('QA final round: gcAgainstTmux and empty tmux names', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('leaves a tmux:"" session alone — empty means watch-only, not dead', async () => {
    const dir = await makeTmpDir('deckneo-store-emptytmux-');
    const store = new SessionStore(dir);
    cleanups.push(async () => {
      await store.stop();
      await rm(dir, { recursive: true, force: true });
    });
    await store.start();
    await writeSession(dir, { session_id: 'e', tmux: '' });
    await waitSession(store, 0, 'e');

    store.gcAgainstTmux([]);
    expect(store.getState().sessions[0]?.file.session_id).toBe('e');
    await settle(100);
    expect(existsSync(join(dir, 'e.json'))).toBe(true);
  });
});

describe('detached tmux sessions', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setupDetached() {
    const dir = await makeTmpDir('deckneo-store-detached-');
    const store = new SessionStore(dir);
    cleanups.push(async () => {
      await store.stop();
      await rm(dir, { recursive: true, force: true });
    });
    return { dir, store };
  }

  it('marks a session detached when its tmux is alive but has no client', async () => {
    const { dir, store } = await setupDetached();
    await writeSession(dir, { session_id: 's1', tmux: 'a' });
    await store.start();

    store.gcAgainstTmux([{ name: 'a', attached: false }]);
    expect(store.getState().sessions[0]?.detached).toBe(true);
    // The session itself is untouched — detachment is not death.
    expect(store.getState().sessions[0]?.file.session_id).toBe('s1');
  });

  it('clears the flag when a client reattaches', async () => {
    const { dir, store } = await setupDetached();
    await writeSession(dir, { session_id: 's1', tmux: 'a' });
    await store.start();

    store.gcAgainstTmux([{ name: 'a', attached: false }]);
    expect(store.getState().sessions[0]?.detached).toBe(true);
    store.gcAgainstTmux([{ name: 'a', attached: true }]);
    expect(store.getState().sessions[0]?.detached).toBeUndefined();
  });

  it('never flags watch-only sessions, whatever the live list says', async () => {
    const { dir, store } = await setupDetached();
    await writeSession(dir, { session_id: 'w1' });
    await writeSession(dir, { session_id: 'e1', tmux: '' });
    await store.start();

    store.gcAgainstTmux([{ name: 'other', attached: false }]);
    expect(store.getState().sessions[0]?.detached).toBeUndefined();
    expect(store.getState().sessions[1]?.detached).toBeUndefined();
  });

  it('emits change when attachment flips, and not when it repeats', async () => {
    const { dir, store } = await setupDetached();
    await writeSession(dir, { session_id: 's1', tmux: 'a' });
    await store.start();

    const flipped = nextEvent<CockpitState>(store, 'change');
    store.gcAgainstTmux([{ name: 'a', attached: false }]);
    expect((await flipped).sessions[0]?.detached).toBe(true);

    let extra = 0;
    store.on('change', () => extra++);
    store.gcAgainstTmux([{ name: 'a', attached: false }]);
    expect(extra).toBe(0);
  });

  it('frees dead-tmux sessions while marking detached survivors, in one pass', async () => {
    const { dir, store } = await setupDetached();
    await writeSession(dir, { session_id: 's1', tmux: 'a' });
    await writeSession(dir, { session_id: 's2', tmux: 'b' });
    await store.start();

    store.gcAgainstTmux([{ name: 'a', attached: false }]);
    const state = store.getState();
    expect(state.sessions[0]?.file.session_id).toBe('s1');
    expect(state.sessions[0]?.detached).toBe(true);
    expect(state.sessions[1]).toBeNull(); // tmux 'b' gone -> freed
  });
});

describe('security: future-dated ts cannot pin a slot forever', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

  it('treats a far-future timestamp as stale-eligible, not eternally fresh', async () => {
    const dir = await makeTmpDir('deckneo-store-future-');
    const store = new SessionStore(dir, { staleMs: 50 });
    cleanups.push(async () => { await store.stop(); await rm(dir, { recursive: true, force: true }); });
    const tenYears = Date.now() + 10 * 365 * 24 * 60 * 60 * 1000;
    await writeSession(dir, { session_id: 'squatter', ts: tenYears });
    await store.start();
    // Clamped to now, so after staleMs it ages out instead of pinning the slot.
    expect(store.getState().sessions[0]).toBeNull();
  });
});

describe('watch-only sessions age out faster (stale ChatGPT-app / no-tmux keys)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

  async function setup(opts?: { staleMs?: number; watchOnlyStaleMs?: number }) {
    const dir = await makeTmpDir('deckneo-store-watch-');
    const store = new SessionStore(dir, opts);
    cleanups.push(async () => { await store.stop(); await rm(dir, { recursive: true, force: true }); });
    return { dir, store };
  }

  it('drops a quiet watch-only session past the short window, keeps a tmux one', async () => {
    const { dir, store } = await setup({ staleMs: HOUR, watchOnlyStaleMs: 1000 });
    const old = Date.now() - 5000;
    await writeSession(dir, { session_id: 'app', ts: old });                 // no tmux -> watch-only
    await writeSession(dir, { session_id: 'live', ts: old, tmux: 'live' });  // controllable
    await store.start();
    expect(store.getState().sessions.map((s) => s?.file.session_id ?? null)).toEqual(['live', null, null, null]);
  });

  it('keeps a fresh watch-only session', async () => {
    const { dir, store } = await setup({ watchOnlyStaleMs: 60_000 });
    await writeSession(dir, { session_id: 'app', ts: Date.now() });
    await store.start();
    expect(store.getState().sessions[0]?.file.session_id).toBe('app');
  });
});

describe('watch-only staleness only applies to terminal states', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

  it('keeps a WORKING watch-only session past the short window', async () => {
    const dir = await makeTmpDir('deckneo-store-terminal-');
    const store = new SessionStore(dir, { staleMs: HOUR, watchOnlyStaleMs: 1000 });
    cleanups.push(async () => { await store.stop(); await rm(dir, { recursive: true, force: true }); });
    const old = Date.now() - 5000;
    await writeSession(dir, { session_id: 'work', state: 'working', ts: old }); // watch-only, mid-turn
    await writeSession(dir, { session_id: 'done', state: 'done', ts: old });    // watch-only, terminal
    await store.start();
    const ids = store.getState().sessions.map((s) => s?.file.session_id ?? null);
    expect(ids).toContain('work'); // long autonomous run stays visible
    expect(ids).not.toContain('done'); // terminal one ages out
  });
});
