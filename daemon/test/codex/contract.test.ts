import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import type { AgentKind, SessionFile, SessionStateName } from '../../src/contracts.js';
import {
  adapterScript,
  argvShim,
  cleanScratch,
  cxScript,
  projectDir,
  readSession,
  repoRoot,
  runAdapter,
  sessionsDirOf,
  tmpDir,
  turnComplete,
  waitForFile,
} from './helpers.js';

const STATES: SessionStateName[] = ['idle', 'working', 'needs-input', 'done', 'ended'];
const KINDS: AgentKind[] = ['claude', 'codex'];
const SESSION_FILE_KEYS = new Set([
  'session_id',
  'cwd',
  'project',
  'state',
  'kind',
  'message',
  'tmux',
  'agents',
  'main',
  'ts',
]);

let home: string;

beforeEach(async () => {
  home = await tmpDir('deckneo-cxhome-');
});

afterAll(cleanScratch);

describe('records honour the SessionFile contract', () => {
  it('carries every required field, kind codex, and nothing unknown', async () => {
    const cwd = await projectDir('myproj');
    await runAdapter(['--register', '--name', 'api'], { home, cwd });
    await runAdapter([turnComplete()], { home, cwd: await projectDir('other') });

    for (const file of await readdir(sessionsDirOf(home))) {
      const f = JSON.parse(
        await readFile(join(sessionsDirOf(home), file), 'utf8'),
      ) as SessionFile & Record<string, unknown>;

      expect(typeof f.session_id).toBe('string');
      expect(typeof f.cwd).toBe('string');
      expect(typeof f.project).toBe('string');
      expect(typeof f.ts).toBe('number');
      expect(STATES).toContain(f.state);
      expect(KINDS).toContain(f.kind);
      expect(f.kind).toBe('codex');
      expect(Object.keys(f).filter((k) => !SESSION_FILE_KEYS.has(k))).toEqual([]);
      expect(file).toBe(`${f.session_id}.json`);
    }
  });

  it('names every record with the codex- prefix so kinds never collide', async () => {
    const cwd = await projectDir('myproj');
    await runAdapter(['--register'], { home, cwd });

    for (const file of await readdir(sessionsDirOf(home))) expect(file).toMatch(/^codex-/);
  });
});

describe('the adapter can never break a codex turn', () => {
  const hostile: Array<[string, string[]]> = [
    ['no arguments', []],
    ['empty payload', ['']],
    ['array payload', ['[1,2,3]']],
    ['null payload', ['null']],
    ['string payload', ['"hello"']],
    ['payload with a non-string type', [JSON.stringify({ type: 42 })]],
    ['payload without a type', [JSON.stringify({ 'turn-id': 'x' })]],
    ['huge payload', [JSON.stringify({ type: 'agent-turn-complete', big: 'x'.repeat(200_000) })]],
    ['unknown flag', ['--wat', turnComplete()]],
    ['register with an empty name', ['--register', '--name', '']],
    ['register with a missing name value', ['--register', '--name']],
    ['forward with no program', ['--forward']],
    ['forward to a directory', ['--forward', '/tmp', turnComplete()]],
  ];

  for (const [label, args] of hostile) {
    it(`exits 0 on ${label}`, async () => {
      const cwd = await projectDir('myproj');
      const run = await runAdapter(args, { home, cwd });
      expect(run.code).toBe(0);
      expect(run.stdout).toBe('');
    });
  }

  it('forwards the trailing argument verbatim even for payloads it ignores', async () => {
    const cwd = await projectDir('myproj');
    const { program, capture } = await argvShim();
    const payload = JSON.stringify({ type: 'some-future-event', detail: 'x' });
    await runAdapter(['--forward', program, 'turn-ended', payload], { home, cwd });

    expect((await waitForFile(capture)).split('\n').filter(Boolean)).toEqual([
      'turn-ended',
      payload,
    ]);
    expect(await readdir(sessionsDirOf(home)).catch(() => [])).toEqual([]);
  });

  it('keeps working across repeated turns in one session', async () => {
    const cwd = await projectDir('myproj');
    for (let i = 0; i < 3; i++) {
      const run = await runAdapter([turnComplete(`turn ${i}`)], { home, cwd });
      expect(run.code).toBe(0);
    }
    expect(await readdir(sessionsDirOf(home))).toEqual(['codex-myproj.json']);
    expect((await readSession(home, 'codex-myproj')).state).toBe('done');
  });
});

describe('source-level constraints', () => {
  it('the adapter uses node builtins only', async () => {
    const src = await readFile(adapterScript, 'utf8');
    expect(src).toMatch(/^#!\/usr\/bin\/env node/);
    const specifiers = [...src.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    for (const s of specifiers) expect(s).toMatch(/^node:/);
    expect(src).not.toMatch(/require\(/);
  });

  it('the adapter never spawns through a shell', async () => {
    const src = await readFile(adapterScript, 'utf8');
    expect(src).not.toMatch(/shell\s*:\s*true/);
    expect(src).not.toMatch(/\bexec(Sync)?\s*\(/);
  });

  it('cx derives the repo path from its own location', async () => {
    const src = await readFile(cxScript, 'utf8');
    expect(src).toContain('${0:A:h:h}');
    expect(src).not.toMatch(/\/Users\//);
  });
});

describe('docs/CODEX.md', () => {
  let doc: string;

  beforeEach(async () => {
    doc = await readFile(join(repoRoot, 'docs/CODEX.md'), 'utf8');
  });

  it('documents the notify wiring including the chain-forward', () => {
    expect(doc).toMatch(/notify\s*=\s*\[/);
    expect(doc).toContain('codex-notify.mjs');
    expect(doc).toContain('--forward');
    expect(doc).toContain('SkyComputerUseClient');
    expect(doc).toContain('turn-ended');
  });

  it('installs cx as an alias rather than on PATH', () => {
    expect(doc).toMatch(/alias cx=/);
  });

  it('states the v1 limits honestly', () => {
    expect(doc).toContain('agent-turn-complete');
    expect(doc).toMatch(/amber/i);
    expect(doc).toMatch(/cx <name>|cx api-2|cx `?<name>`?/);
  });
});
