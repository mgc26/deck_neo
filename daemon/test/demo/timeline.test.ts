import { describe, expect, it } from 'vitest';
import { AppController } from '../../src/appController.js';
import type { UiModel } from '../../src/contracts.js';
import { keySpecsFor } from '../../src/device/layout.js';
import { DemoStore } from '../../src/demo/store.js';
import { DEMO_CONFIG, DEMO_SYS, makeDemoContext, playOnce } from '../../src/demo/timeline.js';

async function record(): Promise<UiModel[]> {
  const models: UiModel[] = [];
  const device = { render: async (m: UiModel) => void models.push(structuredClone(m)) };
  const store = new DemoStore();
  const app = new AppController(store, () => DEMO_CONFIG, device, DEMO_SYS);
  await playOnce(makeDemoContext(store, app), async () => {});
  return models;
}

describe('demo timeline', () => {
  it('hits every promo beat in one loop', async () => {
    const models = await record();

    // Needs-you beat: an amber-blinking session key is rendered.
    expect(models.some((m) => keySpecsFor(m).slice(0, 4).some((s) => s.blink))).toBe(true);

    // While a needs-input session is selected, APPROVE (key 4) is lit, not dim.
    const armed = models.find((m) => {
      const slot = m.cockpit.selectedSlot;
      return slot !== null && m.cockpit.sessions[slot]?.file.state === 'needs-input';
    });
    expect(armed).toBeDefined();
    expect(keySpecsFor(armed!)[4]!.dim).toBeFalsy();

    // The permission message reaches the infobar.
    expect(models.some((m) => m.infobar.includes('Permission: Bash(npm test)'))).toBe(true);

    // Commands page beat.
    expect(models.some((m) => m.ui.page === 'commands')).toBe(true);

    // Paging beat: a fifth session opens page 2 and the script visits it.
    expect(models.some((m) => m.cockpit.pageCount === 2 && m.cockpit.page === 1)).toBe(true);
  });

  it('never renders an error flash (all stubs succeed, focus finds a window)', async () => {
    const models = await record();
    expect(models.every((m) => m.flash === undefined)).toBe(true);
    expect(models.some((m) => m.infobar.startsWith('no Cursor window'))).toBe(false);
  });

  it('loops cleanly: a second run starts from an empty cockpit', async () => {
    const models: UiModel[] = [];
    const device = { render: async (m: UiModel) => void models.push(structuredClone(m)) };
    const store = new DemoStore();
    const app = new AppController(store, () => DEMO_CONFIG, device, DEMO_SYS);
    const ctx = makeDemoContext(store, app);
    const sleep = async (): Promise<void> => {};
    await playOnce(ctx, sleep);
    const secondRunStart = models.length;
    await playOnce(ctx, sleep);
    const first = models[secondRunStart]!;
    expect(first.cockpit.sessions).toEqual([null, null, null, null]);
    expect(first.cockpit.page).toBe(0);
    expect(first.ui.page).toBe('cockpit');
  });
});
