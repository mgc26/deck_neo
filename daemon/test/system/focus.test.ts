import { describe, expect, it } from 'vitest';

import { focusAppWindow } from '../../src/system/focus.js';

// Headless-safe: every case targets an app name that cannot be running, so no real
// app is ever activated and no window is ever raised by the test suite.
const ABSENT_APP = 'DeckNeoNoSuchApp7f3a';

describe('focusAppWindow', () => {
  it('resolves false when the target app is not running', async () => {
    await expect(focusAppWindow('deck_neo', { appName: ABSENT_APP })).resolves.toBe(false);
  });

  it('never throws, even for a nonsense project name', async () => {
    await expect(
      focusAppWindow('"; do shell script "touch /tmp/deckneo-pwned', { appName: ABSENT_APP }),
    ).resolves.toBe(false);
  });

  it('defaults to a single-argument call signature', () => {
    expect(focusAppWindow.length).toBe(1);
  });
});
