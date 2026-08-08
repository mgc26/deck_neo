/**
 * Contract test: proves daemon/src/core exposes exactly the surfaces other
 * modules are allowed to depend on, with the right
 * shapes and arity. Behaviour lives in config/store/app.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CockpitState, DeckConfig, UiState } from '../../src/contracts.js';
import { parseConfig, ConfigWatcher } from '../../src/core/config.js';
import { SessionStore } from '../../src/core/store.js';
import { reduceInput } from '../../src/core/app.js';
import { makeTmpDir, waitSession, writeSession } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe('core/config surface', () => {
  it('exports parseConfig(json) => DeckConfig', () => {
    expect(typeof parseConfig).toBe('function');
    expect(parseConfig.length).toBe(1);
    const cfg: DeckConfig = parseConfig('{"projects":[],"commands":[]}');
    expect(cfg).toEqual({ projects: [], commands: [] });
  });

  it('exports ConfigWatcher as an EventEmitter with start/stop/getConfig', async () => {
    const dir = await makeTmpDir('deckneo-contract-');
    const file = join(dir, 'config.json');
    await writeFile(file, JSON.stringify({ projects: [], commands: [] }), 'utf8');

    const watcher = new ConfigWatcher(file);
    cleanups.push(async () => {
      await watcher.stop();
      await rm(dir, { recursive: true, force: true });
    });

    expect(watcher).toBeInstanceOf(EventEmitter);
    expect(typeof watcher.start).toBe('function');
    expect(typeof watcher.stop).toBe('function');
    expect(typeof watcher.getConfig).toBe('function');

    await expect(watcher.start()).resolves.toBeUndefined();
    const cfg = watcher.getConfig();
    expect(Array.isArray(cfg.projects)).toBe(true);
    expect(Array.isArray(cfg.commands)).toBe(true);
    await expect(watcher.stop()).resolves.toBeUndefined();
  });
});

describe('core/store surface', () => {
  it('exports SessionStore as an EventEmitter with the documented methods', async () => {
    const dir = await makeTmpDir('deckneo-contract-');
    const store = new SessionStore(dir, { staleMs: 60_000 });
    cleanups.push(async () => {
      await store.stop();
      await rm(dir, { recursive: true, force: true });
    });

    expect(store).toBeInstanceOf(EventEmitter);
    for (const method of [
      'start',
      'stop',
      'getState',
      'select',
      'gcAgainstTmux',
      'markWorking',
    ] as const) {
      expect(typeof store[method]).toBe('function');
    }

    await expect(store.start()).resolves.toBeUndefined();

    const empty: CockpitState = store.getState();
    expect(empty.sessions).toHaveLength(4);
    expect(empty.sessions.every((s) => s === null)).toBe(true);
    expect(empty.selectedSlot).toBeNull();

    await writeSession(dir, { session_id: 'c1', project: 'proj', tmux: 'proj' });
    await waitSession(store, 0, 'c1');

    const state = store.getState();
    expect(state.sessions[0]).toMatchObject({ slot: 0, file: { project: 'proj' } });

    store.select(0);
    expect(store.getState().selectedSlot).toBe(0);
    expect(store.gcAgainstTmux([{ name: 'proj', attached: true }])).toBeUndefined();
    expect(store.getState().sessions[0]).not.toBeNull();
    expect(store.markWorking('c1')).toBeUndefined();
    expect(store.getState().sessions[0]?.file.state).toBe('working');

    await expect(store.stop()).resolves.toBeUndefined();
  });
});

describe('core/app surface', () => {
  it('exports reduceInput(ui, input, cockpit, config) => { ui, effects }', () => {
    expect(typeof reduceInput).toBe('function');
    expect(reduceInput.length).toBe(4);

    const ui: UiState = { page: 'cockpit' };
    const cockpit: CockpitState = { sessions: [null, null, null, null], selectedSlot: null, page: 0, pageCount: 1 };
    const config: DeckConfig = { projects: [], commands: [] };

    const result = reduceInput(ui, { type: 'key', index: 7 }, cockpit, config);
    expect(result.ui.page).toBe('picker');
    expect(Array.isArray(result.effects)).toBe(true);

    const touched = reduceInput(ui, { type: 'touch', zone: 'right' }, cockpit, config);
    expect(touched.ui.page).toBe('commands');
    expect(touched.effects).toEqual([]);
  });
});
