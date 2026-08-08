// Contact sheet: representative key faces + infobar, PNG for visual review.
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { keySpecsFor, blinkOffSpec, COLORS } from '../daemon/src/device/layout.js';
import { renderKeyImage, renderInfobarImage } from '../daemon/src/device/render.js';
import type { CockpitState, DeckConfig, KeySpec, SessionFile, UiModel } from '../daemon/src/contracts.js';

const KEY = 96;
const SCALE = 2;

const cfg: DeckConfig = {
  projects: [
    { name: 'deck_neo', path: '/tmp/deck_neo' },
    { name: 'chart_review', path: '/tmp/chart_review' },
    { name: 'flights', path: '/tmp/flights' },
  ],
  commands: [
    { label: 'CONTINUE', text: 'c' },
    { label: '/qa', text: 'q' },
    { label: 'TESTS', text: 't' },
    { label: 'HANDOFF', text: 'h' },
  ],
};

function sess(project: string, state: SessionFile['state'], extra: Partial<SessionFile> = {}): SessionFile {
  return { session_id: `id-${project}`, cwd: `/t/${project}`, project, state, ts: 1, ...extra };
}
function cockpit(files: (SessionFile | null)[], selectedSlot: number | null = null): CockpitState {
  return {
    sessions: [0, 1, 2, 3].map((slot) => (files[slot] ? { file: files[slot]!, slot } : null)),
    selectedSlot,
    page: 0,
    pageCount: 1,
  };
}
function model(c: CockpitState, page: UiModel['ui']['page'] = 'cockpit'): UiModel {
  return { ui: { page }, cockpit: c, config: cfg, infobar: '' };
}

// Row 1: cockpit — watch-only working, selected amber, codex done, idle + action row follows in row order
const row1 = keySpecsFor(
  model(
    cockpit(
      [
        sess('deck_neo', 'working'), // watch-only working
        sess('chart_review', 'needs-input', { tmux: 'chart_review' }),
        sess('api-2', 'done', { tmux: 'api-2', kind: 'codex' }),
        sess('flights', 'idle', { tmux: 'flights' }),
      ],
      1,
    ),
  ),
);
// Row 2: amber breathing dim phase, lit Continue, dim Approve, blank, first 4 command tiles
const readyRow = keySpecsFor(model(cockpit([sess('api-2', 'done', { tmux: 'api-2' })], 0)));
const commandsRow = keySpecsFor(model(cockpit([sess('api-2', 'done', { tmux: 'api-2' })], 0), 'commands'));
const row2: KeySpec[] = [
  blinkOffSpec(row1[1]!),
  readyRow[6]!,
  readyRow[4]!,
  { label: '', bg: COLORS.empty, fg: COLORS.fg },
  commandsRow[0]!,
  commandsRow[1]!,
  commandsRow[2]!,
  commandsRow[3]!,
];

const rows = [row1, row2];
const infobars = [
  'chart_review ▸ Permission: Bash(npm test)',
  'api-2 ▸ codex ▸ done',
  'no session selected',
];

const GAP = 10;
const sheetW = (KEY * SCALE + GAP) * 8 + GAP;
const infoH = 58 * SCALE;
const sheetH = (KEY * SCALE + GAP) * rows.length + (infoH + GAP) * infobars.length + GAP;
const sheet = createCanvas(sheetW, sheetH);
const sctx = sheet.getContext('2d');
sctx.fillStyle = '#2a2d33';
sctx.fillRect(0, 0, sheetW, sheetH);

function blit(rgb: Buffer, w: number, h: number, dx: number, dy: number): void {
  const tile = createCanvas(w, h);
  const tctx = tile.getContext('2d');
  const img = tctx.createImageData(w, h);
  for (let px = 0, s = 0, d = 0; px < w * h; px++, s += 3, d += 4) {
    img.data[d] = rgb[s]!; img.data[d + 1] = rgb[s + 1]!; img.data[d + 2] = rgb[s + 2]!; img.data[d + 3] = 255;
  }
  tctx.putImageData(img, 0, 0);
  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(tile, dx, dy, w * SCALE, h * SCALE);
}

rows.forEach((row, r) => {
  row.forEach((spec, i) => {
    blit(renderKeyImage(spec, KEY), KEY, KEY, GAP + i * (KEY * SCALE + GAP), GAP + r * (KEY * SCALE + GAP));
  });
});
infobars.forEach((text, i) => {
  const y = GAP + rows.length * (KEY * SCALE + GAP) + i * (infoH + GAP);
  blit(renderInfobarImage(text, 248, 58), 248, 58, GAP, y);
});

writeFileSync('contact-sheet.png', sheet.toBuffer('image/png'));
console.log('wrote contact-sheet.png');
