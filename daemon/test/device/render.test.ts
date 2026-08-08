import { describe, it, expect } from 'vitest';
import { renderKeyImage, renderInfobarImage } from '../../src/device/render.js';
import { keySpecsFor } from '../../src/device/layout.js';
import type { CockpitState, DeckConfig, KeySpec, UiModel } from '../../src/contracts.js';

const KEY_PX = 96;
const LCD_W = 248;
const LCD_H = 58;

/** Private Use Area codepoint no font supplies — renders as the notdef box. */
const NOTDEF = '';

/** Fraction of pixels in a raw RGB buffer exactly matching the given colour. */
function fractionMatching(buf: Buffer, r: number, g: number, b: number): number {
  let hits = 0;
  for (let i = 0; i < buf.length; i += 3) {
    if (buf[i] === r && buf[i + 1] === g && buf[i + 2] === b) hits++;
  }
  return hits / (buf.length / 3);
}

describe('renderKeyImage', () => {
  it('returns a raw RGB buffer of sizePx * sizePx * 3 bytes', () => {
    const buf = renderKeyImage({ label: 'api', bg: '#1e6fd9', fg: '#ffffff' }, KEY_PX);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBe(KEY_PX * KEY_PX * 3);
  });

  it('honours other key sizes', () => {
    const buf = renderKeyImage({ label: 'x', bg: '#000000', fg: '#ffffff' }, 72);
    expect(buf.length).toBe(72 * 72 * 3);
  });

  it('keeps the tile dark with the accent present as a signal, not a fill', () => {
    // Annunciator look: near-black ground/tile dominates; the state hue appears
    // in the wash + glow bar but never floods the key.
    const buf = renderKeyImage({ label: 'api', sublabel: 'Working', bg: '#4d8dff', fg: '#f2f3f5' }, KEY_PX);
    let dark = 0;
    let accentish = 0;
    for (let i = 0; i < buf.length; i += 3) {
      const [r, g, b] = [buf[i]!, buf[i + 1]!, buf[i + 2]!];
      if (r < 0x40 && g < 0x40 && b < 0x50) dark++;
      if (b > 0x80 && b > r) accentish++;
    }
    const total = buf.length / 3;
    expect(dark / total).toBeGreaterThan(0.5);
    expect(accentish / total).toBeGreaterThan(0.02);
    expect(accentish / total).toBeLessThan(0.6);
  });

  it('renders a blank key as the solid ground colour', () => {
    const buf = renderKeyImage({ label: '', bg: '#060708', fg: '#ffffff' }, KEY_PX);
    expect(fractionMatching(buf, 0x06, 0x07, 0x08)).toBe(1);
  });

  it('draws a visible selection keyline when one is requested', () => {
    const plain = renderKeyImage({ label: 'api', sublabel: 'Done', bg: '#34c77b', fg: '#f2f3f5' }, KEY_PX);
    const bordered = renderKeyImage(
      { label: 'api', sublabel: 'Done', bg: '#34c77b', fg: '#f2f3f5', border: '#ffffff' },
      KEY_PX,
    );
    expect(bordered.length).toBe(plain.length);
    expect(bordered.equals(plain)).toBe(false);
    expect(fractionMatching(bordered, 0xff, 0xff, 0xff)).toBeGreaterThan(0);
  });

  it('produces different pixels for the two blink phases', () => {
    const amber = renderKeyImage({ label: 'web', sublabel: 'Needs you', bg: '#ffb021', fg: '#f2f3f5' }, KEY_PX);
    const dim = renderKeyImage({ label: 'web', sublabel: 'Needs you', bg: '#7a5510', fg: '#f2f3f5' }, KEY_PX);
    expect(amber.equals(dim)).toBe(false);
  });

  it('does not throw on very long labels', () => {
    const spec: KeySpec = {
      label: 'an-extremely-long-label-that-will-never-fit-on-a-96px-key',
      bg: '#202020',
      fg: '#ffffff',
    };
    expect(() => renderKeyImage(spec, KEY_PX)).not.toThrow();
    expect(renderKeyImage(spec, KEY_PX).length).toBe(KEY_PX * KEY_PX * 3);
  });

  it('does not throw on the specs the action keys actually render', () => {
    // Taken from the layout rather than retyped, so this can't drift from what
    // the deck draws. An earlier fixture passed '✗ REJECT' as a single label,
    // which is neither a glyph nor a label the code uses, and it missed the
    // glyph field entirely.
    const cockpit: CockpitState = {
      sessions: [null, null, null, null],
      selectedSlot: null,
      page: 0,
      pageCount: 1,
    };
    const config: DeckConfig = { projects: [], commands: [] };
    const base: UiModel = { ui: { page: 'cockpit' }, cockpit, config, infobar: '' };
    const actionKeys = [
      ...keySpecsFor(base).slice(4), // Approve / Stop / Continue / New
      ...keySpecsFor({ ...base, ui: { page: 'picker' } }).slice(-1), // Cancel
    ];

    expect(actionKeys).toHaveLength(5);
    for (const spec of actionKeys) {
      expect(spec.glyph, `action key "${spec.label}" carries no glyph`).toBeTruthy();
      expect(() => renderKeyImage(spec, KEY_PX)).not.toThrow();
      expect(renderKeyImage(spec, KEY_PX).length).toBe(KEY_PX * KEY_PX * 3);
    }
  });

  // A glyph the font stack lacks is drawn as a notdef box, identical for every
  // missing codepoint — so matching NOTDEF's pixels means the label is tofu.
  // These four are the symbols drawGlyph knows; any other one falls through to
  // the font, which is the path this guards.
  it('draws real glyphs, not notdef boxes, for the action-key symbols', () => {
    const key = (label: string) => renderKeyImage({ label, bg: '#202020', fg: '#ffffff' }, KEY_PX);
    const tofu = key(NOTDEF);
    for (const glyph of ['✓', '✕', '▸', '+']) {
      expect(key(glyph).equals(tofu), `${glyph} rendered as a notdef box`).toBe(false);
    }
  });
});

describe('renderInfobarImage', () => {
  it('returns a raw RGB buffer of w * h * 3 bytes', () => {
    const buf = renderInfobarImage('deck_neo ▸ working', LCD_W, LCD_H);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBe(LCD_W * LCD_H * 3);
  });

  it('renders empty text as a solid ground strip', () => {
    const buf = renderInfobarImage('', LCD_W, LCD_H);
    expect(fractionMatching(buf, 0x06, 0x07, 0x08)).toBe(1);
  });

  it('keeps the strip mostly dark so the text stays readable', () => {
    const buf = renderInfobarImage('deck_neo ▸ working', LCD_W, LCD_H);
    expect(fractionMatching(buf, 0x06, 0x07, 0x08)).toBeGreaterThanOrEqual(0.7);
  });

  it('does not throw on very long text', () => {
    const long = 'deck_neo ▸ permission: Bash(npm run test -- --reporter=verbose) '.repeat(6);
    expect(() => renderInfobarImage(long, LCD_W, LCD_H)).not.toThrow();
    expect(renderInfobarImage(long, LCD_W, LCD_H).length).toBe(LCD_W * LCD_H * 3);
  });

  it('produces different pixels for different text', () => {
    const a = renderInfobarImage('api ▸ working', LCD_W, LCD_H);
    const b = renderInfobarImage('web ▸ done', LCD_W, LCD_H);
    expect(a.equals(b)).toBe(false);
  });

  it('draws the ▸ separator as a real glyph, not a notdef box', () => {
    const separator = renderInfobarImage('▸', LCD_W, LCD_H);
    const tofu = renderInfobarImage(NOTDEF, LCD_W, LCD_H);
    expect(separator.equals(tofu)).toBe(false);
  });
});

describe('render time bounds (QA finding: unbounded text was O(n²) per frame)', () => {
  it('renders a 20,000-char infobar string well inside one blink interval', () => {
    const huge = 'permission: Bash(npm run something long) '.repeat(500);
    expect(huge.length).toBeGreaterThan(20000);
    const t0 = performance.now();
    const buf = renderInfobarImage(huge, LCD_W, LCD_H);
    const ms = performance.now() - t0;
    expect(buf.length).toBe(LCD_W * LCD_H * 3);
    expect(ms).toBeLessThan(250);
  });
});

describe('brand watermarks (render)', () => {
  it('draws distinct pixels for claude vs codex marks', () => {
    const base = { label: 'api', sublabel: 'Done', bg: '#34c77b', fg: '#f2f3f5' } as const;
    const claude = renderKeyImage({ ...base, brand: 'claude' }, KEY_PX);
    const codex = renderKeyImage({ ...base, brand: 'codex' }, KEY_PX);
    const none = renderKeyImage({ ...base }, KEY_PX);
    expect(claude.equals(codex)).toBe(false);
    expect(claude.equals(none)).toBe(false);
    expect(codex.equals(none)).toBe(false);
  });
});
