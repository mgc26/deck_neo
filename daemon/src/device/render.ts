// Pure pixel rendering for the Neo: KeySpec -> raw RGB buffer.
// Dimensions are always parameters so tests never need the hardware.
//
// Visual system ("annunciator panel"): every key is a near-black machined tile;
// state arrives as a luminous signal — a tinted wash rising from a bright state
// bar at the tile's base — never as a full-bleed colour fill. Typography is
// SF Pro (the platform face) in sentence case: name in semibold, state word
// small in the state hue, action keys a large glyph over a quiet caption.

import { createCanvas, GlobalFonts, type SKRSContext2D } from '@napi-rs/canvas';
import type { KeySpec } from '../contracts.js';

// SF Pro carries the premium look; Helvetica covers a machine without it, and
// Menlo trails as the symbol fallback for ✓ ✕ ▸ (skia resolves per glyph).
let uiFamily = 'Helvetica';
try {
  GlobalFonts.registerFromPath('/System/Library/Fonts/SFNS.ttf', 'SF Pro');
  uiFamily = 'SF Pro';
} catch {
  // Helvetica fallback is fine — layout metrics are close enough.
}
const FONT_STACK = `"${uiFamily}", Helvetica, Arial, Menlo, "Arial Unicode MS", sans-serif`;

// Tile geometry (ratios of key size).
const TILE_INSET = 3; // black bezel margin blends the tile into the hardware
const TILE_RADIUS_RATIO = 0.12;
const BAR_HEIGHT_RATIO = 0.055;
const BAR_INSET_RATIO = 0.13;

// Surfaces.
const GROUND = '#060708';
const TILE_TOP = '#171a1f';
const TILE_BOTTOM = '#0e1013';
const TILE_DIM = '#101216';
const CAPTION_FG = '#c8ccd2';
const INFOBAR_DIM = '#9aa0a7';
const INFOBAR_SEP = '#565b62';

const MIN_FONT_PX = 8;

// More characters than any key or the LCD strip can physically show; bounding here
// keeps the measureText loops O(1) even if a huge string slips into the model
// (a 20k-char Notification message once cost 28s/frame unbounded).
const MAX_TEXT_CHARS = 120;

/** Strip the alpha channel; the Stream Deck wants tightly packed RGB. */
function toRgbBuffer(ctx: SKRSContext2D, w: number, h: number): Buffer {
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const rgb = Buffer.allocUnsafe(w * h * 3);
  for (let px = 0, src = 0, dst = 0; px < w * h; px++, src += 4, dst += 3) {
    rgb[dst] = rgba[src]!;
    rgb[dst + 1] = rgba[src + 1]!;
    rgb[dst + 2] = rgba[src + 2]!;
  }
  return rgb;
}

function setFont(ctx: SKRSContext2D, px: number, weight: 'normal' | 'bold' | number = 'normal'): void {
  ctx.font = `${weight} ${Math.max(1, Math.round(px))}px ${FONT_STACK}`;
}

/** Cut on code points — slicing through an emoji leaves a lone surrogate. */
function clampChars(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : `${points.slice(0, max - 1).join('')}…`;
}

/**
 * Single-line fit: shrink the font from `startPx` until the text fits, then
 * ellipsize (code-point safe) at the floor size. Font is left set on `ctx`.
 */
function fitLine(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number,
  startPx: number,
  weight: 'normal' | 'bold' | number = 'normal',
): string {
  let line = clampChars(text, MAX_TEXT_CHARS);
  for (let px = startPx; px >= MIN_FONT_PX; px--) {
    setFont(ctx, px, weight);
    if (ctx.measureText(line).width <= maxWidth) return line;
  }
  setFont(ctx, MIN_FONT_PX, weight);
  const points = [...line];
  while (points.length > 1 && ctx.measureText(`${points.join('')}…`).width > maxWidth) {
    points.pop();
  }
  return `${points.join('')}…`;
}

// Brand watermarks: which agent runs this session, at a glance.
const BRAND_CLAUDE = '#d97757'; // Anthropic terracotta
const BRAND_OPENAI = '#dfe3e8';

/**
 * Small corner mark: Anthropic's radial spark for Claude, a hex ring for
 * OpenAI/Codex. Drawn as strokes at ~55% alpha — a watermark, not a badge.
 */
function drawBrandMark(ctx: SKRSContext2D, brand: 'claude' | 'codex', cx: number, cy: number, size: number): void {
  const r = size / 2;
  ctx.save();
  ctx.globalAlpha = 0.62;
  ctx.lineCap = 'round';
  if (brand === 'claude') {
    // The spark: eight radial rays, alternating lengths.
    ctx.strokeStyle = BRAND_CLAUDE;
    ctx.lineWidth = Math.max(1.6, size * 0.14);
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI / 4) * i;
      const len = i % 2 === 0 ? r : r * 0.68;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * len * 0.3, cy + Math.sin(a) * len * 0.3);
      ctx.lineTo(cx + Math.cos(a) * len, cy + Math.sin(a) * len);
      ctx.stroke();
    }
  } else {
    // Hex ring for the OpenAI knot.
    ctx.strokeStyle = BRAND_OPENAI;
    ctx.lineWidth = Math.max(1.6, size * 0.16);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i - Math.PI / 6;
      const x = cx + Math.cos(a) * r * 0.85;
      const y = cy + Math.sin(a) * r * 0.85;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Stroke-drawn action glyphs, centred on (cx, cy) inside a box of `size`.
 * Round caps, uniform weight — matched to SF Pro's optical stroke.
 */
function drawGlyph(ctx: SKRSContext2D, glyph: string, cx: number, cy: number, size: number, color: string): void {
  const s = size / 2;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(2.5, size * 0.2);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (glyph) {
    case '✓':
      ctx.moveTo(cx - s * 0.9, cy + s * 0.05);
      ctx.lineTo(cx - s * 0.25, cy + s * 0.7);
      ctx.lineTo(cx + s * 0.95, cy - s * 0.6);
      ctx.stroke();
      break;
    case '✕':
      ctx.moveTo(cx - s * 0.7, cy - s * 0.7);
      ctx.lineTo(cx + s * 0.7, cy + s * 0.7);
      ctx.moveTo(cx + s * 0.7, cy - s * 0.7);
      ctx.lineTo(cx - s * 0.7, cy + s * 0.7);
      ctx.stroke();
      break;
    case '▸':
      ctx.moveTo(cx - s * 0.45, cy - s * 0.75);
      ctx.lineTo(cx + s * 0.65, cy);
      ctx.lineTo(cx - s * 0.45, cy + s * 0.75);
      ctx.closePath();
      ctx.fill();
      break;
    case '+':
      ctx.moveTo(cx, cy - s * 0.8);
      ctx.lineTo(cx, cy + s * 0.8);
      ctx.moveTo(cx - s * 0.8, cy);
      ctx.lineTo(cx + s * 0.8, cy);
      ctx.stroke();
      break;
    default: {
      // Unknown glyph: fall back to the font.
      setFont(ctx, size, 'bold');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(glyph, cx, cy);
    }
  }
}

interface TileOptions {
  accent?: string; // state hue: tinted wash + glow bar
  dim?: boolean; // inert: flatter surface, no wash
  border?: string; // selection keyline
}

/** The machined tile every key face sits on. */
function drawTile(ctx: SKRSContext2D, size: number, opts: TileOptions): void {
  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, size, size);

  const r = Math.round(size * TILE_RADIUS_RATIO);
  const x = TILE_INSET;
  const w = size - TILE_INSET * 2;

  ctx.beginPath();
  ctx.roundRect(x, x, w, w, r);
  if (opts.dim) {
    ctx.fillStyle = TILE_DIM;
  } else {
    const sheen = ctx.createLinearGradient(0, x, 0, x + w);
    sheen.addColorStop(0, TILE_TOP);
    sheen.addColorStop(1, TILE_BOTTOM);
    ctx.fillStyle = sheen;
  }
  ctx.fill();

  if (opts.accent && !opts.dim) {
    // Wash: the hue rising from the base — reads at arm's length without
    // turning the key into a paint chip.
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, x, w, w, r);
    ctx.clip();
    const wash = ctx.createLinearGradient(0, size, 0, size * 0.22);
    wash.addColorStop(0, `${opts.accent}59`); // ~35% alpha
    wash.addColorStop(1, `${opts.accent}00`);
    ctx.fillStyle = wash;
    ctx.fillRect(x, x, w, w);

    // State bar with a soft bloom.
    const barH = Math.max(3, Math.round(size * BAR_HEIGHT_RATIO));
    const barInset = Math.round(size * BAR_INSET_RATIO);
    const barY = size - TILE_INSET - barH - Math.round(size * 0.07);
    ctx.shadowColor = opts.accent;
    ctx.shadowBlur = Math.round(size * 0.12);
    ctx.fillStyle = opts.accent;
    ctx.beginPath();
    ctx.roundRect(barInset, barY, size - barInset * 2, barH, barH / 2);
    ctx.fill();
    ctx.restore();
  }

  if (opts.border) {
    ctx.strokeStyle = opts.border;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(x + 1, x + 1, w - 2, w - 2, Math.max(2, r - 1));
    ctx.stroke();
  }
}

/** One key image as a raw RGB buffer of `sizePx * sizePx * 3` bytes. */
export function renderKeyImage(spec: KeySpec, sizePx: number): Buffer {
  const canvas = createCanvas(sizePx, sizePx);
  const ctx = canvas.getContext('2d');

  const blank = !spec.label && !spec.glyph && !spec.sublabel;
  if (blank) {
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, sizePx, sizePx);
    return toRgbBuffer(ctx, sizePx, sizePx);
  }

  const isSession = spec.sublabel !== undefined;
  const accent = spec.dim ? undefined : spec.bg;
  drawTile(ctx, sizePx, {
    accent: isSession ? accent : undefined, // action keys signal via glyph, not bar
    dim: spec.dim,
    border: spec.border,
  });

  const maxWidth = sizePx - Math.round(sizePx * 0.16);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (spec.glyph) {
    // Action key: crisp vector glyph, quiet sentence-case caption. (Font
    // glyphs for ✓/✕ resolve to heavy emoji-style marks — drawn strokes keep
    // the machined look.)
    const glyphColor = spec.dim ? spec.fg : spec.bg;
    ctx.save();
    if (!spec.dim) {
      ctx.shadowColor = glyphColor;
      ctx.shadowBlur = Math.round(sizePx * 0.1);
    }
    drawGlyph(ctx, spec.glyph, sizePx / 2, sizePx * 0.4, sizePx * 0.26, glyphColor);
    ctx.restore();
    const caption = fitLine(ctx, spec.label, maxWidth, sizePx * 0.14, 500);
    ctx.fillStyle = spec.dim ? spec.fg : CAPTION_FG;
    ctx.fillText(caption, sizePx / 2, sizePx * 0.75);
  } else if (isSession) {
    // Session key: name over a small state word in the hue.
    const name = fitLine(ctx, spec.label, maxWidth, sizePx * 0.17, 600);
    ctx.fillStyle = spec.fg;
    ctx.fillText(name, sizePx / 2, sizePx * 0.38);
    if (spec.sublabel) {
      const word = fitLine(ctx, spec.sublabel, maxWidth, sizePx * 0.115, 500);
      ctx.fillStyle = spec.bg;
      ctx.fillText(word, sizePx / 2, sizePx * 0.62);
    }
    if (spec.brand) {
      const mark = sizePx * 0.13;
      drawBrandMark(ctx, spec.brand, sizePx - TILE_INSET - mark * 0.85 - 4, TILE_INSET + mark * 0.85 + 4, mark);
    }
  } else {
    // Text-only tile (commands page): one centred label.
    const label = fitLine(ctx, spec.label, maxWidth, sizePx * 0.15, 500);
    ctx.fillStyle = spec.dim ? spec.fg : CAPTION_FG;
    ctx.fillText(label, sizePx / 2, sizePx * 0.5);
  }

  return toRgbBuffer(ctx, sizePx, sizePx);
}

/** The LCD strip image as a raw RGB buffer of `w * h * 3` bytes. */
export function renderInfobarImage(text: string, w: number, h: number): Buffer {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = GROUND;
  ctx.fillRect(0, 0, w, h);

  if (text) {
    const pad = Math.round(h * 0.2);
    const maxWidth = w - pad * 2;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';

    // The controller composes "name ▸ state" (optionally more segments);
    // typeset the name in semibold white and the rest quiet, joined by dots.
    const segments = clampChars(text, MAX_TEXT_CHARS)
      .split(' ▸ ')
      .filter((s) => s.length > 0);
    const fontPx = Math.max(MIN_FONT_PX, Math.round(h * 0.4));
    const sep = '  ·  ';

    // Shrink-to-fit over the whole line, then draw segment by segment.
    let px = fontPx;
    const lineWidth = (size: number): number => {
      let total = 0;
      segments.forEach((seg, i) => {
        setFont(ctx, size, i === 0 ? 600 : 'normal');
        total += ctx.measureText(seg).width;
        if (i < segments.length - 1) total += ctx.measureText(sep).width;
      });
      return total;
    };
    while (px > MIN_FONT_PX && lineWidth(px) > maxWidth) px--;

    // A lone segment is a status phrase ("no session selected"), not an
    // identity — it recedes instead of shouting in headline semibold.
    const lone = segments.length === 1;
    let x = pad;
    const y = h / 2;
    segments.forEach((seg, i) => {
      setFont(ctx, lone ? Math.round(px * 0.85) : px, i === 0 && !lone ? 600 : 'normal');
      ctx.fillStyle = lone ? INFOBAR_DIM : i === 0 ? '#f2f3f5' : INFOBAR_DIM;
      const drawn = i === segments.length - 1 ? fitLine(ctx, seg, Math.max(10, w - pad - x), px, i === 0 ? 600 : 'normal') : seg;
      ctx.fillText(drawn, x, y);
      x += ctx.measureText(drawn).width;
      if (i < segments.length - 1) {
        setFont(ctx, px, 'normal');
        ctx.fillStyle = INFOBAR_SEP;
        ctx.fillText(sep, x, y);
        x += ctx.measureText(sep).width;
      }
    });
  }

  return toRgbBuffer(ctx, w, h);
}
