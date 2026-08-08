import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeckConfig } from '../../src/contracts.js';
import { parseConfig, ConfigWatcher } from '../../src/core/config.js';
import { makeTmpDir, nextEvent, settle, waitUntil } from './helpers.js';

describe('parseConfig', () => {
  it('parses a valid config', () => {
    const cfg = parseConfig(
      JSON.stringify({
        projects: [{ name: 'deck_neo', path: '/tmp/deck_neo' }],
        commands: [{ label: 'CONT', text: 'continue' }],
      }),
    );
    expect(cfg.projects[0].name).toBe('deck_neo');
    expect(cfg.projects[0].path).toBe('/tmp/deck_neo');
    expect(cfg.commands[0]).toEqual({ label: 'CONT', text: 'continue' });
    expect(cfg.keys).toBeUndefined();
  });

  it('parses optional key overrides', () => {
    const cfg = parseConfig(
      JSON.stringify({
        projects: [],
        commands: [],
        keys: { approve: ['Enter'], reject: ['Escape'] },
      }),
    );
    expect(cfg.keys).toEqual({ approve: ['Enter'], reject: ['Escape'] });
  });

  it('throws on missing arrays', () => {
    expect(() => parseConfig('{}')).toThrow(/invalid config/);
  });

  it('throws on non-string command text', () => {
    expect(() =>
      parseConfig(JSON.stringify({ projects: [], commands: [{ label: 'x', text: 1 }] })),
    ).toThrow(/invalid config/);
  });

  it('throws on a malformed project entry', () => {
    expect(() =>
      parseConfig(JSON.stringify({ projects: [{ name: 'x' }], commands: [] })),
    ).toThrow(/invalid config/);
  });

  it('throws on unparseable JSON', () => {
    expect(() => parseConfig('{not json')).toThrow(/invalid config/);
  });

  it('throws on a non-object top level', () => {
    expect(() => parseConfig('[]')).toThrow(/invalid config/);
  });

  it('throws when keys.approve is not an array of strings', () => {
    expect(() =>
      parseConfig(JSON.stringify({ projects: [], commands: [], keys: { approve: 'Enter' } })),
    ).toThrow(/invalid config/);
  });

  it('parses per-kind codex key overrides alongside the top-level ones', () => {
    const cfg = parseConfig(
      JSON.stringify({
        projects: [],
        commands: [],
        keys: {
          approve: ['Enter'],
          reject: ['Escape'],
          codex: { approve: ['y', 'Enter'], reject: ['n', 'Enter'] },
        },
      }),
    );
    expect(cfg.keys).toEqual({
      approve: ['Enter'],
      reject: ['Escape'],
      codex: { approve: ['y', 'Enter'], reject: ['n', 'Enter'] },
    });
  });

  it('accepts a codex block that overrides only one sequence', () => {
    const cfg = parseConfig(
      JSON.stringify({ projects: [], commands: [], keys: { codex: { reject: ['Escape'] } } }),
    );
    expect(cfg.keys).toEqual({ codex: { reject: ['Escape'] } });
  });

  it('accepts an empty codex block', () => {
    const cfg = parseConfig(
      JSON.stringify({ projects: [], commands: [], keys: { codex: {} } }),
    );
    expect(cfg.keys).toEqual({ codex: {} });
  });

  it('throws when keys.codex is not an object', () => {
    for (const codex of ['Enter', 3, null, ['Enter']]) {
      expect(() =>
        parseConfig(JSON.stringify({ projects: [], commands: [], keys: { codex } })),
      ).toThrow(/invalid config/);
    }
  });

  it('throws when a codex sequence is not an array of strings', () => {
    for (const codex of [{ approve: 'Enter' }, { approve: [1] }, { reject: {} }, { reject: [null] }]) {
      expect(() =>
        parseConfig(JSON.stringify({ projects: [], commands: [], keys: { codex } })),
      ).toThrow(/invalid config/);
    }
  });

  it('names the offending codex field in the error message', () => {
    expect(() =>
      parseConfig(JSON.stringify({ projects: [], commands: [], keys: { codex: { approve: 'Enter' } } })),
    ).toThrow(/keys\.codex\.approve/);
  });
});

describe('ConfigWatcher', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  async function setup(
    initial?: unknown,
    opts?: { reconcileMs?: number },
  ): Promise<{ file: string; watcher: ConfigWatcher }> {
    const dir = await makeTmpDir();
    const file = join(dir, 'config.json');
    if (initial !== undefined) await writeFile(file, JSON.stringify(initial), 'utf8');
    const watcher = new ConfigWatcher(file, opts);
    cleanups.push(async () => {
      await watcher.stop();
      await rm(dir, { recursive: true, force: true });
    });
    return { file, watcher };
  }

  const cfgA = { projects: [{ name: 'a', path: '/tmp/a' }], commands: [{ label: 'A', text: 'a' }] };
  const cfgB = { projects: [{ name: 'b', path: '/tmp/b' }], commands: [{ label: 'B', text: 'b' }] };

  it('loads the config on start', async () => {
    const { watcher } = await setup(cfgA);
    await watcher.start();
    expect(watcher.getConfig().projects[0].name).toBe('a');
  });

  it('emits change and updates getConfig when the file is edited', async () => {
    const { file, watcher } = await setup(cfgA);
    await watcher.start();
    const changed = nextEvent<DeckConfig>(watcher, 'change');
    await writeFile(file, JSON.stringify(cfgB), 'utf8');
    const next = await changed;
    expect(next.projects[0].name).toBe('b');
    expect(watcher.getConfig().commands[0].text).toBe('b');
  });

  it('keeps the last good config when the file becomes invalid', async () => {
    const { file, watcher } = await setup(cfgA);
    await watcher.start();
    const seen: DeckConfig[] = [];
    watcher.on('change', (c: DeckConfig) => seen.push(c));

    await writeFile(file, '{ this is not json', 'utf8');
    await settle();

    expect(seen).toHaveLength(0);
    expect(watcher.getConfig().projects[0].name).toBe('a');

    // still watching after the error
    await writeFile(file, JSON.stringify(cfgB), 'utf8');
    await waitUntil(() => seen.length === 1, 'change event after recovery');
    expect(watcher.getConfig().projects[0].name).toBe('b');
  });

  it('falls back to an empty config when the file is missing, and picks it up when created', async () => {
    const { file, watcher } = await setup();
    await watcher.start();
    expect(watcher.getConfig()).toEqual({ projects: [], commands: [] });

    const changed = nextEvent<DeckConfig>(watcher, 'change');
    await writeFile(file, JSON.stringify(cfgA), 'utf8');
    await changed;
    expect(watcher.getConfig().projects[0].name).toBe('a');
  });

  // fs.watch cannot report a file under a directory that did not exist when
  // watching began, so this path is served only by the reconcile timer — the
  // daemon must not need a restart when ~/.deck-neo is created after it starts.
  it('picks up a config whose directory did not exist at start', async () => {
    const root = await makeTmpDir();
    const dir = join(root, '.deck-neo');
    const file = join(dir, 'config.json');
    const watcher = new ConfigWatcher(file, { reconcileMs: 40 });
    cleanups.push(async () => {
      await watcher.stop();
      await rm(root, { recursive: true, force: true });
    });

    await watcher.start();
    expect(watcher.getConfig()).toEqual({ projects: [], commands: [] });

    const changed = nextEvent<DeckConfig>(watcher, 'change');
    await mkdir(dir, { recursive: true });
    await writeFile(file, JSON.stringify(cfgA), 'utf8');

    await changed;
    expect(watcher.getConfig().projects[0].name).toBe('a');
  });

  it('reconcile does not re-emit an unchanged config', async () => {
    const { watcher } = await setup(cfgA, { reconcileMs: 30 });
    await watcher.start();
    const seen: DeckConfig[] = [];
    watcher.on('change', (c: DeckConfig) => seen.push(c));
    await settle(300);
    expect(seen).toHaveLength(0);
  });

  it('stops emitting after stop()', async () => {
    const { file, watcher } = await setup(cfgA);
    await watcher.start();
    const seen: DeckConfig[] = [];
    watcher.on('change', (c: DeckConfig) => seen.push(c));
    await watcher.stop();
    await writeFile(file, JSON.stringify(cfgB), 'utf8');
    await settle();
    expect(seen).toHaveLength(0);
  });
});

describe('launch config', () => {
  it('accepts launch.claudeArgs as a string array', () => {
    const cfg = parseConfig(JSON.stringify({
      projects: [], commands: [],
      launch: { claudeArgs: ['--dangerously-skip-permissions'] },
    }));
    expect(cfg.launch?.claudeArgs).toEqual(['--dangerously-skip-permissions']);
  });

  it('rejects non-string launch args', () => {
    expect(() => parseConfig(JSON.stringify({ projects: [], commands: [], launch: { claudeArgs: [1] } })))
      .toThrow(/invalid config/);
  });
});
