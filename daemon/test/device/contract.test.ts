import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  NeoDevice,
  type NeoFillOptions,
  type NeoStreamDeck,
  type StreamDeckApi,
  type StreamDeckControlDefinition,
  type StreamDeckDeviceEntry,
} from '../../src/device/neo.js';
import type { CockpitState, DeckConfig, Session, SessionFile, UiModel, UiPage } from '../../src/contracts.js';

const KEY_BYTES = 96 * 96 * 3;
const LCD_BYTES = 248 * 58 * 3;

/**
 * Mirrors the control table @elgato-stream-deck/core builds for the Neo:
 * a 4x2 grid of 96x96 lcd buttons (index 0-7), an rgb button at row 2 col 0
 * (index 8), the 248x58 lcd segment, and an rgb button at row 2 col 3 (index 9).
 */
function neoControls(): StreamDeckControlDefinition[] {
  const controls: StreamDeckControlDefinition[] = [];
  for (let row = 0; row < 2; row++) {
    for (let column = 0; column < 4; column++) {
      const index = row * 4 + column;
      controls.push({
        type: 'button',
        row,
        column,
        index,
        hidIndex: index,
        feedbackType: 'lcd',
        pixelSize: { width: 96, height: 96 },
      });
    }
  }
  controls.push({ type: 'button', row: 2, column: 0, index: 8, hidIndex: 8, feedbackType: 'rgb' });
  controls.push({
    type: 'lcd-segment',
    row: 2,
    column: 1,
    columnSpan: 2,
    rowSpan: 1,
    id: 0,
    pixelSize: { width: 248, height: 58 },
    drawRegions: false,
  });
  controls.push({ type: 'button', row: 2, column: 3, index: 9, hidIndex: 9, feedbackType: 'rgb' });
  return controls;
}

const CONTROLS = neoControls();
const controlAt = (index: number): StreamDeckControlDefinition => {
  const control = CONTROLS.find((c) => c.type === 'button' && c.index === index);
  if (!control) throw new Error(`no button control ${index}`);
  return control;
};

class FakeDeck extends EventEmitter implements NeoStreamDeck {
  readonly CONTROLS: readonly StreamDeckControlDefinition[] = CONTROLS;
  readonly MODEL = 'neo';
  fillKeyBuffer = vi.fn(async (_keyIndex: number, _buf: Uint8Array, _opts?: NeoFillOptions) => {});
  fillLcd = vi.fn(async (_lcdIndex: number, _buf: Uint8Array, _opts: NeoFillOptions) => {});
  clearPanel = vi.fn(async () => {});
  close = vi.fn(async () => {});
}

const DEVICES: StreamDeckDeviceEntry[] = [
  { model: 'xl', path: '/dev/xl' },
  { model: 'pedal', path: '/dev/pedal' },
  { model: 'neo', path: '/dev/neo', serialNumber: 'NEO123' },
];

function fakeApi(opts: { failures?: number; devices?: StreamDeckDeviceEntry[] } = {}) {
  let failuresLeft = opts.failures ?? 0;
  const deck = new FakeDeck();
  const listStreamDecks = vi.fn(async (): Promise<StreamDeckDeviceEntry[]> => {
    if (failuresLeft > 0) {
      failuresLeft--;
      throw new Error('hid busy — is the Elgato app running?');
    }
    return opts.devices ?? DEVICES;
  });
  const openStreamDeck = vi.fn(async (_path: string): Promise<NeoStreamDeck> => deck);
  const api: StreamDeckApi = { listStreamDecks, openStreamDeck };
  return { api, deck, listStreamDecks, openStreamDeck };
}

// ---- UiModel builders ----

function sess(project: string, state: SessionFile['state']): SessionFile {
  return { session_id: `id-${project}`, cwd: `/tmp/${project}`, project, state, ts: 1_700_000_000_000 };
}

function cockpitWith(files: (SessionFile | null)[]): CockpitState {
  const sessions: (Session | null)[] = [0, 1, 2, 3].map((slot) => {
    const file = files[slot] ?? null;
    return file ? { file, slot } : null;
  });
  return { sessions, selectedSlot: null, page: 0, pageCount: 1 };
}

const CFG: DeckConfig = {
  projects: [{ name: 'deck_neo', path: '/tmp/deck_neo' }],
  commands: [{ label: 'CONT', text: 'continue' }],
};

function model(cockpit: CockpitState = cockpitWith([]), page: UiPage = 'cockpit'): UiModel {
  return { ui: { page }, cockpit, config: CFG, infobar: '' };
}

const WORKING = model(cockpitWith([sess('api', 'working')]));
const BLINKING = model(cockpitWith([sess('api', 'needs-input')]));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('NeoDevice.start', () => {
  it('opens only the entry whose model is neo', async () => {
    const { api, openStreamDeck } = fakeApi();
    const dev = new NeoDevice({ api });
    const statuses: string[] = [];
    dev.on('status', (s: string) => statuses.push(s));

    await dev.start();

    expect(openStreamDeck).toHaveBeenCalledTimes(1);
    expect(openStreamDeck.mock.calls[0]?.[0]).toBe('/dev/neo');
    expect(statuses).toEqual(['connected']);
    await dev.stop();
  });

  it('retries every 3000ms after a failed open and emits disconnected then connected', async () => {
    const { api, openStreamDeck } = fakeApi({ failures: 1 });
    const dev = new NeoDevice({ api });
    const statuses: string[] = [];
    dev.on('status', (s: string) => statuses.push(s));

    await dev.start();
    expect(openStreamDeck).not.toHaveBeenCalled();
    expect(statuses).toEqual(['disconnected']);

    await vi.advanceTimersByTimeAsync(2999);
    expect(openStreamDeck).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(openStreamDeck).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['disconnected', 'connected']);
    await dev.stop();
  });

  it('keeps retrying while no Neo is attached', async () => {
    const { api, listStreamDecks, openStreamDeck } = fakeApi({ devices: [{ model: 'xl', path: '/dev/xl' }] });
    const dev = new NeoDevice({ api });

    await dev.start();
    expect(openStreamDeck).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(listStreamDecks).toHaveBeenCalledTimes(2);
    expect(openStreamDeck).not.toHaveBeenCalled();
    await dev.stop();
  });

  it('reopens after the device reports an error', async () => {
    const { api, deck, openStreamDeck } = fakeApi();
    const dev = new NeoDevice({ api });
    const statuses: string[] = [];
    dev.on('status', (s: string) => statuses.push(s));
    await dev.start();

    deck.emit('error', new Error('device unplugged'));
    await vi.advanceTimersByTimeAsync(0);
    expect(statuses).toEqual(['connected', 'disconnected']);

    await vi.advanceTimersByTimeAsync(3000);
    expect(openStreamDeck).toHaveBeenCalledTimes(2);
    await dev.stop();
  });
});

describe('NeoDevice.render', () => {
  it('draws 8 keys and the LCD strip using the sizes reported by the device', async () => {
    const { api, deck } = fakeApi();
    const dev = new NeoDevice({ api });
    await dev.start();
    deck.fillKeyBuffer.mockClear();

    await dev.render(WORKING);

    expect(deck.fillKeyBuffer).toHaveBeenCalledTimes(8);
    for (let i = 0; i < 8; i++) {
      const call = deck.fillKeyBuffer.mock.calls[i];
      expect(call?.[0]).toBe(i);
      expect(call?.[1].length).toBe(KEY_BYTES);
      expect(call?.[2]).toEqual({ format: 'rgb' });
    }

    expect(deck.fillLcd).toHaveBeenCalledTimes(1);
    const lcd = deck.fillLcd.mock.calls[0];
    expect(lcd?.[0]).toBe(0);
    expect(lcd?.[1].length).toBe(LCD_BYTES);
    expect(lcd?.[2]).toEqual({ format: 'rgb' });
    await dev.stop();
  });

  it('buffers a render issued before connection and draws it once connected', async () => {
    const { api, deck } = fakeApi({ failures: 1 });
    const dev = new NeoDevice({ api });
    await dev.start();

    await dev.render(WORKING);
    expect(deck.fillKeyBuffer).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(3000);
    expect(deck.fillKeyBuffer).toHaveBeenCalledTimes(8);
    expect(deck.fillLcd).toHaveBeenCalledTimes(1);
    await dev.stop();
  });

  it('re-renders blinking keys every 500ms, alternating the pixels', async () => {
    const { api, deck } = fakeApi();
    const dev = new NeoDevice({ api });
    await dev.start();
    await dev.render(BLINKING);
    const litBuffer = Buffer.from(deck.fillKeyBuffer.mock.calls.at(-8)?.[1] ?? []);
    deck.fillKeyBuffer.mockClear();

    await vi.advanceTimersByTimeAsync(500);
    expect(deck.fillKeyBuffer).toHaveBeenCalledTimes(8);
    const dimBuffer = Buffer.from(deck.fillKeyBuffer.mock.calls[0]?.[1] ?? []);
    expect(dimBuffer.equals(litBuffer)).toBe(false);

    deck.fillKeyBuffer.mockClear();
    await vi.advanceTimersByTimeAsync(500);
    const relitBuffer = Buffer.from(deck.fillKeyBuffer.mock.calls[0]?.[1] ?? []);
    expect(relitBuffer.equals(litBuffer)).toBe(true);
    await dev.stop();
  });

  it('reconnects instead of rejecting when a key write fails mid-frame', async () => {
    const { api, deck, openStreamDeck } = fakeApi();
    const dev = new NeoDevice({ api });
    const statuses: string[] = [];
    dev.on('status', (s: string) => statuses.push(s));
    await dev.start();

    deck.fillKeyBuffer.mockRejectedValueOnce(new Error('device went away'));
    await expect(dev.render(WORKING)).resolves.toBeUndefined();

    expect(statuses).toEqual(['connected', 'disconnected']);
    await vi.advanceTimersByTimeAsync(3000);
    expect(openStreamDeck).toHaveBeenCalledTimes(2);
    await dev.stop();
  });

  it('runs no blink timer when nothing blinks', async () => {
    const { api, deck } = fakeApi();
    const dev = new NeoDevice({ api });
    await dev.start();
    await dev.render(WORKING);
    deck.fillKeyBuffer.mockClear();

    await vi.advanceTimersByTimeAsync(5000);
    expect(deck.fillKeyBuffer).not.toHaveBeenCalled();
    await dev.stop();
  });
});

describe('NeoDevice input', () => {
  it('emits a key input on key-down and nothing on key-up', async () => {
    const { api, deck } = fakeApi();
    const dev = new NeoDevice({ api });
    const inputs: unknown[] = [];
    dev.on('input', (raw: unknown) => inputs.push(raw));
    await dev.start();

    deck.emit('down', controlAt(3));
    expect(inputs).toEqual([{ type: 'key', index: 3 }]);

    deck.emit('up', controlAt(3));
    expect(inputs).toHaveLength(1);
    await dev.stop();
  });

  it('maps the two extra Neo buttons to left and right touch zones', async () => {
    const { api, deck } = fakeApi();
    const dev = new NeoDevice({ api });
    const inputs: unknown[] = [];
    dev.on('input', (raw: unknown) => inputs.push(raw));
    await dev.start();

    deck.emit('down', controlAt(8));
    deck.emit('down', controlAt(9));

    expect(inputs).toEqual([
      { type: 'touch', zone: 'left' },
      { type: 'touch', zone: 'right' },
    ]);
    await dev.stop();
  });

  it('ignores controls that are not part of the cockpit', async () => {
    const { api, deck } = fakeApi();
    const dev = new NeoDevice({ api });
    const inputs: unknown[] = [];
    dev.on('input', (raw: unknown) => inputs.push(raw));
    await dev.start();

    deck.emit('down', {
      type: 'encoder',
      row: 0,
      column: 0,
      index: 0,
      hidIndex: 0,
      hasLed: true,
      ledRingSteps: 0,
    } satisfies StreamDeckControlDefinition);

    expect(inputs).toEqual([]);
    await dev.stop();
  });

  it('stops emitting input after stop()', async () => {
    const { api, deck } = fakeApi();
    const dev = new NeoDevice({ api });
    const inputs: unknown[] = [];
    dev.on('input', (raw: unknown) => inputs.push(raw));
    await dev.start();
    await dev.stop();

    deck.emit('down', controlAt(1));
    expect(inputs).toEqual([]);
  });
});

describe('NeoDevice.stop', () => {
  it('closes the device and clears the blink timer', async () => {
    const { api, deck } = fakeApi();
    const dev = new NeoDevice({ api });
    await dev.start();
    await dev.render(BLINKING);

    await dev.stop();
    expect(deck.close).toHaveBeenCalledTimes(1);

    deck.fillKeyBuffer.mockClear();
    await vi.advanceTimersByTimeAsync(5000);
    expect(deck.fillKeyBuffer).not.toHaveBeenCalled();
  });

  it('cancels a pending reconnect attempt', async () => {
    const { api, listStreamDecks } = fakeApi({ failures: 99 });
    const dev = new NeoDevice({ api });
    await dev.start();
    expect(listStreamDecks).toHaveBeenCalledTimes(1);

    await dev.stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(listStreamDecks).toHaveBeenCalledTimes(1);
  });
});

describe('device loss and render faults (QA round-3 coverage gap)', () => {
  it('clears the blink timer on device loss and reconnects in the bright phase', async () => {
    const { api, deck } = fakeApi();
    const dev = new NeoDevice({ api });
    await dev.start();
    await dev.render(BLINKING);
    const brightCall = deck.fillKeyBuffer.mock.calls.find((c) => c[0] === 0);
    const bright = Buffer.from(brightCall![1]);

    await vi.advanceTimersByTimeAsync(500); // park the blink on the dim phase
    expect(vi.getTimerCount()).toBe(1); // the blink interval
    deck.emit('error', new Error('gone'));
    expect(vi.getTimerCount()).toBe(1); // retry only — blink timer cleared, not leaked

    deck.fillKeyBuffer.mockClear();
    await vi.advanceTimersByTimeAsync(3000); // reconnect
    const key0 = deck.fillKeyBuffer.mock.calls.find((c) => c[0] === 0);
    expect(key0).toBeDefined();
    expect(Buffer.from(key0![1]).equals(bright)).toBe(true); // #blinkOn was reset
    await dev.stop();
  });

  it('a render fault logs and skips the frame without flapping the connection', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { api, deck } = fakeApi();
      const dev = new NeoDevice({ api });
      const statuses: string[] = [];
      dev.on('status', (s: string) => statuses.push(s));
      await dev.start();

      const hostile = {
        ...WORKING,
        get infobar(): string {
          throw new Error('layout bug');
        },
      } as UiModel;
      deck.fillKeyBuffer.mockClear();
      deck.fillLcd.mockClear();
      await expect(dev.render(hostile)).resolves.toBeUndefined();

      expect(statuses).toEqual(['connected']); // no disconnect/reconnect flap
      expect(deck.close).not.toHaveBeenCalled();
      expect(deck.fillKeyBuffer).not.toHaveBeenCalled(); // no partial frame reached the device
      expect(deck.fillLcd).not.toHaveBeenCalled();
      expect(errSpy).toHaveBeenCalled(); // the fault was reported, not swallowed
      await dev.stop();
    } finally {
      errSpy.mockRestore();
    }
  });
});
