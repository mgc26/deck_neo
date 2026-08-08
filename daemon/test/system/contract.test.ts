// Contract obligation for the system module: the documented surfaces exist, with
// the documented shapes, and the shipped scripts are runnable.

import { access, constants, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { focusCursorWindow } from '../../src/system/focus.js';
import * as tmux from '../../src/system/tmux.js';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

describe('system/tmux surface', () => {
  it('exports the four documented functions', () => {
    for (const name of [
      'tmuxSendKeys',
      'tmuxSendText',
      'tmuxListSessions',
      'tmuxNewSession',
    ] as const) {
      expect(typeof tmux[name]).toBe('function');
    }
  });

  it('declares the documented arities', () => {
    expect(tmux.tmuxSendKeys.length).toBe(2); // (session, keys)
    expect(tmux.tmuxSendText.length).toBe(2); // (session, text)
    expect(tmux.tmuxListSessions.length).toBe(0);
    expect(tmux.tmuxNewSession.length).toBe(3); // (name, cwd, command)
  });

  it('returns promises', async () => {
    const p = tmux.tmuxListSessions();
    expect(p).toBeInstanceOf(Promise);
    await p.catch(() => {});
  });
});

describe('system/focus surface', () => {
  it('exports focusCursorWindow(project) -> Promise<boolean>', async () => {
    expect(typeof focusCursorWindow).toBe('function');
    expect(focusCursorWindow.length).toBe(1);
    const result = await focusCursorWindow('deck_neo', { appName: 'DeckNeoNoSuchApp7f3a' });
    expect(typeof result).toBe('boolean');
  });
});

describe('shipped scripts', () => {
  it('hooks/report-state.mjs is an executable node ESM script using builtins only', async () => {
    const path = join(repoRoot, 'hooks/report-state.mjs');
    await access(path, constants.X_OK);
    const src = await readFile(path, 'utf8');
    const imports = [...src.matchAll(/^import\s+.*?from\s+'([^']+)';/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).toMatch(/^node:/);
  });

  it('bin/cc is executable', async () => {
    const s = await stat(join(repoRoot, 'bin/cc'));
    expect(s.mode & 0o111).toBeGreaterThan(0);
  });

  it('docs/INSTALL.md documents all five hook events and the config file', async () => {
    const doc = await readFile(join(repoRoot, 'docs/INSTALL.md'), 'utf8');
    for (const event of [
      'SessionStart',
      'UserPromptSubmit',
      'Notification',
      'Stop',
      'SessionEnd',
    ]) {
      expect(doc).toContain(event);
    }
    expect(doc).toContain('~/.deck-neo/config.json');
    expect(doc).toContain('hooks/report-state.mjs');
  });
});
