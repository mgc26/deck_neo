import { describe, expect, it } from 'vitest';

import { focusCursorWindow } from '../../src/system/focus.js';

// Headless-safe: every case targets an app name that cannot be running, so the real
// Cursor is never activated and no window is ever raised by the test suite.
const ABSENT_APP = 'DeckNeoNoSuchApp7f3a';

describe('focusCursorWindow', () => {
  it('resolves false when the target app is not running', async () => {
    await expect(focusCursorWindow('deck_neo', { appName: ABSENT_APP })).resolves.toBe(false);
  });

  it('never throws, even for a nonsense project name', async () => {
    await expect(
      focusCursorWindow('"; do shell script "touch /tmp/deckneo-pwned', { appName: ABSENT_APP }),
    ).resolves.toBe(false);
  });

  it('defaults to a single-argument call signature', () => {
    expect(focusCursorWindow.length).toBe(1);
  });
});
