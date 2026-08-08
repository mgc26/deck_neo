// Thin hardware wrapper around the Stream Deck Neo. No cockpit logic lives
// here: it turns a UiModel into fillKeyBuffer/fillLcd calls via layout.ts +
// render.ts, and turns the device's button events into RawInput.

import { EventEmitter } from 'node:events';
import type { StreamDeckControlDefinition } from '@elgato-stream-deck/node';
import type { KeySpec, RawInput, UiModel } from '../contracts.js';
import { COLORS, blinkOffSpec, infobarTextFor, keySpecsFor } from './layout.js';
import { renderInfobarImage, renderKeyImage } from './render.js';

export type { StreamDeckControlDefinition };

export type NeoStatus = 'connected' | 'disconnected';

export interface NeoFillOptions {
  format: 'rgb' | 'rgba' | 'bgr' | 'bgra';
}

/** An entry from `listStreamDecks()`. */
export interface StreamDeckDeviceEntry {
  model: string;
  path: string;
  serialNumber?: string;
}

type DeckControlListener = (control: StreamDeckControlDefinition) => void;
type DeckErrorListener = (err: unknown) => void;

/** The slice of `@elgato-stream-deck/node`'s StreamDeck this daemon touches. */
export interface NeoStreamDeck {
  readonly CONTROLS: readonly StreamDeckControlDefinition[];
  readonly MODEL: string;
  fillKeyBuffer(keyIndex: number, imageBuffer: Uint8Array, options?: NeoFillOptions): Promise<void>;
  fillLcd(lcdIndex: number, imageBuffer: Uint8Array, options: NeoFillOptions): Promise<void>;
  clearPanel(): Promise<void>;
  close(): Promise<void>;
  on(event: 'down' | 'up', listener: DeckControlListener): unknown;
  on(event: 'error', listener: DeckErrorListener): unknown;
  off(event: 'down' | 'up', listener: DeckControlListener): unknown;
  off(event: 'error', listener: DeckErrorListener): unknown;
}

export interface StreamDeckApi {
  listStreamDecks(): Promise<StreamDeckDeviceEntry[]>;
  openStreamDeck(path: string, options?: { resetToLogoOnClose?: boolean }): Promise<NeoStreamDeck>;
}

export interface NeoDeviceOptions {
  /** Injected for tests; defaults to the real @elgato-stream-deck/node. */
  api?: StreamDeckApi;
  retryMs?: number;
  blinkMs?: number;
}

export interface NeoDeviceEvents {
  input: [raw: RawInput];
  status: [status: NeoStatus];
}

type ButtonControl = Extract<StreamDeckControlDefinition, { type: 'button' }>;
type LcdButtonControl = Extract<ButtonControl, { feedbackType: 'lcd' }>;
type LcdSegmentControl = Extract<StreamDeckControlDefinition, { type: 'lcd-segment' }>;

const NEO_MODEL = 'neo';
const DEFAULT_RETRY_MS = 3000;
const DEFAULT_BLINK_MS = 500;
const RGB: NeoFillOptions = { format: 'rgb' };
const BLANK_KEY: KeySpec = { label: '', bg: COLORS.empty, fg: COLORS.fg };

const isLcdButton = (c: StreamDeckControlDefinition): c is LcdButtonControl =>
  c.type === 'button' && c.feedbackType === 'lcd';
const isRgbButton = (c: StreamDeckControlDefinition): c is ButtonControl =>
  c.type === 'button' && c.feedbackType === 'rgb';
const isLcdSegment = (c: StreamDeckControlDefinition): c is LcdSegmentControl => c.type === 'lcd-segment';

async function loadRealApi(): Promise<StreamDeckApi> {
  // Imported lazily so tests (and any machine without the USB stack) never
  // pull in node-hid just by importing this module.
  const mod = await import('@elgato-stream-deck/node');
  const lib = (mod as { default?: unknown }).default ?? mod;
  return lib as unknown as StreamDeckApi;
}

export class NeoDevice extends EventEmitter<NeoDeviceEvents> {
  readonly #retryMs: number;
  readonly #blinkMs: number;
  #api: StreamDeckApi | null;

  #deck: NeoStreamDeck | null = null;
  #keyControls: LcdButtonControl[] = [];
  #touchControls: ButtonControl[] = [];
  #lcdControl: LcdSegmentControl | null = null;

  #retryTimer: NodeJS.Timeout | null = null;
  #blinkTimer: NodeJS.Timeout | null = null;
  #blinkOn = true;

  #model: UiModel | null = null;
  #running = false;
  #status: NeoStatus | null = null;
  #lastFailure: string | null = null;

  constructor(options: NeoDeviceOptions = {}) {
    super();
    this.#api = options.api ?? null;
    this.#retryMs = options.retryMs ?? DEFAULT_RETRY_MS;
    this.#blinkMs = options.blinkMs ?? DEFAULT_BLINK_MS;
  }

  /** Open the Neo, retrying every `retryMs` until it succeeds or stop() wins. */
  async start(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    await this.#openOnce();
  }

  /** Draw the model: 8 keys plus the LCD strip. A no-op while disconnected. */
  async render(model: UiModel): Promise<void> {
    this.#model = model;
    await this.#draw();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#clearRetryTimer();
    this.#clearBlinkTimer();
    this.#status = null;
    this.#lastFailure = null;
    const deck = this.#detach();
    if (deck) await deck.close().catch(() => undefined);
  }

  // ---- connection ----

  async #openOnce(): Promise<void> {
    if (!this.#running) return;
    try {
      const api = await this.#resolveApi();
      const devices = await api.listStreamDecks();
      const neo = devices.find((device) => device.model === NEO_MODEL);
      if (!neo) {
        const seen = devices.map((d) => d.model).join(', ') || 'none';
        throw new Error(`no Stream Deck Neo attached (found: ${seen})`);
      }
      const deck = await api.openStreamDeck(neo.path, { resetToLogoOnClose: true });
      if (!this.#running) {
        await deck.close().catch(() => undefined);
        return;
      }
      this.#attach(deck);
      this.#lastFailure = null;
      this.#setStatus('connected');
      await deck.clearPanel().catch(() => undefined);
      await this.#draw();
    } catch (err) {
      this.#reportFailure(err);
      this.#handleLoss();
    }
  }

  async #resolveApi(): Promise<StreamDeckApi> {
    if (!this.#api) this.#api = await loadRealApi();
    return this.#api;
  }

  #attach(deck: NeoStreamDeck): void {
    this.#deck = deck;
    this.#keyControls = deck.CONTROLS.filter(isLcdButton).sort((a, b) => a.index - b.index);
    // The Neo's two extra buttons flank the LCD strip; the device reports them
    // at column 0 and column 3, so column order is left-to-right.
    this.#touchControls = deck.CONTROLS.filter(isRgbButton).sort((a, b) => a.column - b.column);
    this.#lcdControl = deck.CONTROLS.find(isLcdSegment) ?? null;
    deck.on('down', this.#onDown);
    deck.on('error', this.#onDeviceError);
  }

  #detach(): NeoStreamDeck | null {
    const deck = this.#deck;
    if (deck) {
      deck.off('down', this.#onDown);
      deck.off('error', this.#onDeviceError);
    }
    this.#deck = null;
    this.#keyControls = [];
    this.#touchControls = [];
    this.#lcdControl = null;
    return deck;
  }

  #onDeviceError = (): void => {
    this.#handleLoss();
  };

  /** Drop the current handle and fall back into the retry loop. */
  #handleLoss(): void {
    const deck = this.#detach();
    if (deck) void deck.close().catch(() => undefined);
    // No deck, no blinking — otherwise the interval ticks for as long as the
    // Neo stays unplugged (and leaves #blinkOn on the dim phase for reconnect).
    this.#clearBlinkTimer();
    this.#setStatus('disconnected');
    this.#scheduleRetry();
  }

  #scheduleRetry(): void {
    if (!this.#running || this.#retryTimer) return;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      void this.#openOnce();
    }, this.#retryMs);
  }

  #clearRetryTimer(): void {
    if (!this.#retryTimer) return;
    clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #setStatus(status: NeoStatus): void {
    if (this.#status === status) return;
    this.#status = status;
    this.emit('status', status);
  }

  #reportFailure(err: unknown): void {
    const reason = err instanceof Error ? err.message : String(err);
    // The retry loop runs forever; only log when the reason actually changes.
    if (reason === this.#lastFailure) return;
    this.#lastFailure = reason;
    console.error(`[neo] Stream Deck Neo unavailable: ${reason}`);
  }

  // ---- input ----

  #onDown = (control: StreamDeckControlDefinition): void => {
    const raw = this.#toRawInput(control);
    if (raw) this.emit('input', raw);
  };

  #toRawInput(control: StreamDeckControlDefinition): RawInput | null {
    if (control.type !== 'button') return null;

    const keyIndex = this.#keyControls.findIndex((c) => c.index === control.index);
    if (keyIndex >= 0) return { type: 'key', index: keyIndex };

    const touchIndex = this.#touchControls.findIndex((c) => c.index === control.index);
    if (touchIndex < 0) return null;
    return { type: 'touch', zone: touchIndex === 0 ? 'left' : 'right' };
  }

  // ---- drawing ----

  async #draw(): Promise<void> {
    const model = this.#model;
    if (!model) return;

    let specs: KeySpec[];
    try {
      specs = keySpecsFor(model);
    } catch (err) {
      // A layout bug must not look like a device loss (which would trigger the
      // reconnect loop) nor escape as an unhandled rejection.
      this.#reportFailure(err);
      return;
    }

    const deck = this.#deck;
    if (!deck) return;
    // After the deck check: no point blinking while disconnected.
    this.#syncBlinkTimer(specs);

    // All pure rendering happens before any device write, under the same rule as
    // keySpecsFor above: a rendering bug logs and skips the frame — it must never
    // reach the catch below, whose #handleLoss would flap the reconnect loop.
    let keyImages: { index: number; image: Buffer }[];
    let lcdImage: { id: number; image: Buffer } | null = null;
    try {
      keyImages = this.#keyControls.map((control, i) => {
        const spec = specs[i] ?? BLANK_KEY;
        const shown = this.#blinkOn ? spec : blinkOffSpec(spec);
        return { index: control.index, image: renderKeyImage(shown, control.pixelSize.width) };
      });
      const lcd = this.#lcdControl;
      if (lcd) {
        lcdImage = {
          id: lcd.id,
          image: renderInfobarImage(infobarTextFor(model), lcd.pixelSize.width, lcd.pixelSize.height),
        };
      }
    } catch (err) {
      this.#reportFailure(err);
      return;
    }

    try {
      for (const { index, image } of keyImages) {
        await deck.fillKeyBuffer(index, image, RGB);
      }
      if (lcdImage) await deck.fillLcd(lcdImage.id, lcdImage.image, RGB);
    } catch (err) {
      // A rejected write means the Neo went away mid-frame; reconnect rather
      // than rejecting into the caller's render loop.
      this.#reportFailure(err);
      this.#handleLoss();
    }
  }

  #syncBlinkTimer(specs: KeySpec[]): void {
    const wanted = specs.some((spec) => spec.blink);
    if (wanted === Boolean(this.#blinkTimer)) return;

    if (wanted) {
      this.#blinkTimer = setInterval(() => {
        this.#blinkOn = !this.#blinkOn;
        void this.#draw().catch(() => undefined);
      }, this.#blinkMs);
    } else {
      this.#clearBlinkTimer();
    }
  }

  #clearBlinkTimer(): void {
    if (this.#blinkTimer) {
      clearInterval(this.#blinkTimer);
      this.#blinkTimer = null;
    }
    this.#blinkOn = true;
  }
}
