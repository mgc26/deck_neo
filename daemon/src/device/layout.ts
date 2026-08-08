// Pure cockpit layout: UiModel -> the 8 key specs and the infobar string.
// No canvas, no hardware — everything here is a plain function so it can be
// unit tested headless. Colours and labels are pinned by device/layout.test.ts.

import type {
  CockpitState,
  DeckConfig,
  KeySpec,
  SessionFile,
  SessionStateName,
  UiModel,
} from '../contracts.js';

// The whole light language, four rules:
//   1. Colour = meaning, one hue each: blue = busy, amber = needs you,
//      green = ready/yes, red = stop/can't. Gray = neutral chrome.
//   2. Blink = "needs you right now" — used by amber needs-input alone.
//   3. Bottom row: a key lights in its meaning colour exactly when pressing it
//      would do something; otherwise it sits dim. (Dim is a hint, not a lock —
//      an inert press still explains itself with a red flash + infobar text.)
//   4. Top row marks: white border = selected; ○ before the name = watch-only
//      (session not started via cc/tmux, so the action keys can't reach it);
//      ·2, ·3 after the name = this is the 2nd/3rd key showing that same name.
//   5. Flat (dim) tile = detached tmux session: alive and controllable, but no
//      window on screen. needs-input overrides it — amber always blinks lit.
// Annunciator palette: near-black machined tiles, state as a luminous signal.
// Hues are tuned to glow on the dark ground rather than fill the key.
export const COLORS = {
  working: '#4d8dff',
  needsInput: '#ffb021',
  done: '#34c77b',
  error: '#ff5d55',
  empty: '#060708',
  action: '#8a8f98', // neutral accent for always-available keys (+ New, picker)
  actionDim: '#14161a',
  fg: '#f2f3f5',
  fgDim: '#565b62',
  selectedBorder: '#f5f6f8',
  /** Amber at low luminance for the "off" half of the breathing pulse. */
  blinkOff: '#7a5510',
} as const;

/** Prefix marking a watch-only session (no tmux backing). */
export const WATCH_ONLY_MARK = '○ ';

/** Separator before the ordinal that tells two same-named sessions apart. */
export const DUPLICATE_MARK = '·';

export const KEY_COUNT = 8;
export const SESSION_KEYS = 4;

/** Longest label a 96px key can show at a readable size. */
const MAX_LABEL_CHARS = 10;

const BLANK: KeySpec = { label: '', bg: COLORS.empty, fg: COLORS.fg };

const ACTION_LABELS = {
  approve: 'Approve',
  // Escape's real job in a bypass-permissions workflow is interrupting a
  // running turn, so the key says what it does.
  reject: 'Stop',
  continueFallback: 'Continue',
  newSession: 'New',
  cancel: 'Cancel',
} as const;

const ACTION_GLYPHS = {
  approve: '✓',
  reject: '✕',
  continue: '▸',
  newSession: '+',
  cancel: '✕',
} as const;

/** Sentence-case state words drawn under the session name. */
function stateWord(state: SessionStateName): string {
  switch (state) {
    case 'working':
      return 'Working';
    case 'needs-input':
      return 'Needs you';
    case 'idle':
      return 'Ready';
    case 'done':
      return 'Done';
    case 'ended':
      return '';
  }
}

/** SHOUTING config labels read as legacy chrome; sentence-case them for display. */
export function displayCase(label: string): string {
  if (label.length > 1 && /^[A-Z0-9 .\-_/]+$/.test(label) && /[A-Z]/.test(label)) {
    return label.charAt(0) + label.slice(1).toLowerCase();
  }
  return label;
}

export function truncateLabel(label: string, max: number = MAX_LABEL_CHARS): string {
  if (label.length <= max) return label;
  // Cut on code points, not UTF-16 units — a .slice() through an emoji leaves a
  // lone surrogate the renderer draws as a notdef box.
  const points = [...label];
  if (points.length <= max) return label;
  return `${points.slice(0, max - 1).join('')}…`;
}

function stateColor(state: SessionStateName): string {
  switch (state) {
    case 'working':
      return COLORS.working;
    case 'needs-input':
      return COLORS.needsInput;
    case 'idle':
    case 'done':
      return COLORS.done;
    case 'ended':
      return COLORS.empty;
  }
}

function actionKey(label: string, glyph?: string): KeySpec {
  const spec: KeySpec = { label, bg: COLORS.action, fg: COLORS.fg };
  if (glyph) spec.glyph = glyph;
  return spec;
}

/** A bottom-row key whose press would currently do nothing. */
function dimKey(label: string, glyph?: string): KeySpec {
  const spec: KeySpec = { label, bg: COLORS.actionDim, fg: COLORS.fgDim, dim: true };
  if (glyph) spec.glyph = glyph;
  return spec;
}

/** A bottom-row key lit in its meaning colour because pressing it acts now. */
function litKey(label: string, bg: string, glyph?: string): KeySpec {
  const spec: KeySpec = { label, bg, fg: COLORS.fg };
  if (glyph) spec.glyph = glyph;
  return spec;
}

/**
 * What a session is called. Several sessions can run in one project, so the
 * tmux name — unique by construction — is the identity whenever there is one.
 */
export function baseLabel(file: SessionFile): string {
  // `||`, not `??`: an empty-string tmux name means "absent".
  return file.tmux || file.project;
}

function selectedSession(cockpit: CockpitState) {
  return cockpit.selectedSlot === null ? null : (cockpit.sessions[cockpit.selectedSlot] ?? null);
}

/** Action keys can only reach sessions with a tmux backing ('' counts as none). */
function controllable(session: { file: { tmux?: string } } | null): boolean {
  return session !== null && !!session.file.tmux;
}

function sessionKeys(cockpit: CockpitState): KeySpec[] {
  const keys: KeySpec[] = [];
  // Only keys actually on screen can be confused with each other, so the
  // ordinals count visible slots, in slot order.
  const seen = new Map<string, number>();
  for (let slot = 0; slot < SESSION_KEYS; slot++) {
    const session = cockpit.sessions[slot] ?? null;
    if (!session || session.file.state === 'ended') {
      keys.push({ ...BLANK });
      continue;
    }
    const base = baseLabel(session.file);
    const nth = (seen.get(base) ?? 0) + 1;
    seen.set(base, nth);
    const mark = session.file.tmux ? '' : WATCH_ONLY_MARK;
    const ordinal = nth > 1 ? `${DUPLICATE_MARK}${nth}` : '';
    // The mark and the ordinal are the whole point of the label; the name
    // gives up characters to them, never the other way round.
    const room = Math.max(1, MAX_LABEL_CHARS - mark.length - ordinal.length);
    const spec: KeySpec = {
      label: `${mark}${truncateLabel(base, room)}${ordinal}`,
      bg: stateColor(session.file.state),
      fg: COLORS.fg,
      sublabel: stateWord(session.file.state),
      brand: session.file.kind ?? 'claude',
    };
    if (cockpit.selectedSlot === slot) spec.border = COLORS.selectedBorder;
    if (session.file.state === 'needs-input') spec.blink = true;
    // Detached tmux (running headless, no window on screen): flatten the tile —
    // lit = in front of you, flat = in the background. The state word keeps its
    // hue, and needs-input wins outright: a pending prompt is still answerable
    // from the deck, so urgency is never muted because a window was closed.
    else if (session.detached) spec.dim = true;
    keys.push(spec);
  }
  return keys;
}

function cockpitKeys(cockpit: CockpitState, config: DeckConfig): KeySpec[] {
  const selected = selectedSession(cockpit);
  const canAct = controllable(selected);
  const awaiting = canAct && selected!.file.state === 'needs-input';
  const ready = canAct && (selected!.file.state === 'idle' || selected!.file.state === 'done');
  const continueLabel = truncateLabel(
    displayCase(config.commands[0]?.label ?? ACTION_LABELS.continueFallback),
  );

  return [
    ...sessionKeys(cockpit),
    awaiting
      ? litKey(ACTION_LABELS.approve, COLORS.done, ACTION_GLYPHS.approve)
      : dimKey(ACTION_LABELS.approve, ACTION_GLYPHS.approve),
    awaiting
      ? litKey(ACTION_LABELS.reject, COLORS.error, ACTION_GLYPHS.reject)
      : dimKey(ACTION_LABELS.reject, ACTION_GLYPHS.reject),
    ready && config.commands.length > 0
      ? litKey(continueLabel, COLORS.working, ACTION_GLYPHS.continue)
      : dimKey(continueLabel, ACTION_GLYPHS.continue),
    actionKey(ACTION_LABELS.newSession, ACTION_GLYPHS.newSession), // always acts
  ];
}

function commandKeys(config: DeckConfig, cockpit: CockpitState): KeySpec[] {
  const canAct = controllable(selectedSession(cockpit));
  return Array.from({ length: KEY_COUNT }, (_, i) => {
    const command = config.commands[i];
    if (!command) return { ...BLANK };
    const label = truncateLabel(displayCase(command.label));
    return canAct ? actionKey(label) : dimKey(label);
  });
}

function pickerKeys(config: DeckConfig): KeySpec[] {
  const keys = Array.from({ length: KEY_COUNT }, () => ({ ...BLANK }));
  for (let i = 0; i < SESSION_KEYS; i++) {
    const project = config.projects[i];
    if (project) keys[i] = actionKey(truncateLabel(project.name));
  }
  keys[KEY_COUNT - 1] = actionKey(ACTION_LABELS.cancel, ACTION_GLYPHS.cancel);
  return keys;
}

/** The 8 key specs for the current page. Always length 8. */
export function keySpecsFor(model: UiModel): KeySpec[] {
  let keys: KeySpec[];
  switch (model.ui.page) {
    case 'commands':
      keys = commandKeys(model.config, model.cockpit);
      break;
    case 'picker':
      keys = pickerKeys(model.config);
      break;
    default:
      keys = cockpitKeys(model.cockpit, model.config);
  }

  const flashed = model.flash?.key;
  if (flashed !== undefined && flashed >= 0 && flashed < keys.length) {
    const { blink: _blink, ...rest } = keys[flashed]!;
    keys[flashed] = { ...rest, bg: COLORS.error };
  }
  return keys;
}

/** The "off" half of an attention pulse; non-blinking specs pass through. */
export function blinkOffSpec(spec: KeySpec): KeySpec {
  if (!spec.blink) return spec;
  const { blink: _blink, ...rest } = spec;
  return { ...rest, bg: COLORS.blinkOff };
}

/**
 * The infobar string. A caller-supplied `model.infobar` always wins; this
 * derives the same text from the model when none was set.
 */
export function infobarTextFor(model: UiModel): string {
  if (model.infobar) return model.infobar;

  const selected =
    model.cockpit.selectedSlot === null ? null : (model.cockpit.sessions[model.cockpit.selectedSlot] ?? null);

  switch (model.ui.page) {
    case 'commands':
      return `commands ▸ ${selected ? baseLabel(selected.file) : 'none'}`;
    case 'picker':
      return 'pick a project';
    default: {
      if (!selected) return 'no session selected';
      // Codex sessions behave differently enough (no amber, no live working
      // state) that the bar says which agent you are looking at; and the ○ on
      // a key gets its explanation the moment the user selects it.
      const tags: string[] = [];
      if ((selected.file.kind ?? 'claude') === 'codex') tags.push('codex');
      if (!selected.file.tmux) tags.push('watch-only');
      // Mutually exclusive with watch-only: detached implies a tmux backing.
      else if (selected.detached) tags.push('detached');
      const middle = tags.length > 0 ? `${tags.join(' ▸ ')} ▸ ` : '';
      return `${baseLabel(selected.file)} ▸ ${middle}${selected.file.message || selected.file.state}`;
    }
  }
}
