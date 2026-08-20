import { describe, it, expect } from 'vitest';
import type { AgentKind, CockpitState, DeckConfig, Session, UiState } from '../../src/contracts.js';
import { reduceInput } from '../../src/core/app.js';
import { sessionFile } from './helpers.js';

const cfg: DeckConfig = {
  projects: [
    { name: 'api', path: '/tmp/api' },
    { name: 'web', path: '/tmp/web' },
  ],
  commands: [
    { label: 'CONT', text: 'continue' },
    { label: 'TESTS', text: 'run the tests' },
  ],
};

const noCommands: DeckConfig = { projects: [], commands: [] };

function sess(project: string, slot: number, tmux?: string, kind?: AgentKind): Session {
  return { file: sessionFile({ session_id: project, project, tmux, kind }), slot };
}

/** CockpitState with the given sessions placed at their own slot index. */
function cockpitWith(sessions: Session[], selectedSlot: number | null = null): CockpitState {
  const arr: (Session | null)[] = [null, null, null, null];
  for (const s of sessions) arr[s.slot] = s;
  return { sessions: arr, selectedSlot, page: 0, pageCount: 1 };
}

const COCKPIT: UiState = { page: 'cockpit' };
const COMMANDS: UiState = { page: 'commands' };
const PICKER: UiState = { page: 'picker' };

const key = (index: number) => ({ type: 'key', index }) as const;
const touch = (zone: 'left' | 'right') => ({ type: 'touch', zone }) as const;

describe('reduceInput — cockpit page', () => {
  it('row 1: key 0-3 on an occupied slot selects and focuses', () => {
    const cockpit = cockpitWith([sess('api', 0, 'api-tmux'), sess('web', 1)]);
    const { ui, effects } = reduceInput(COCKPIT, key(1), cockpit, cfg);
    expect(ui.page).toBe('cockpit');
    expect(effects).toEqual([
      { kind: 'select', slot: 1 },
      { kind: 'focus', project: 'web' },
    ]);
  });

  it('row 2: key 0-3 on an empty slot does nothing', () => {
    const { ui, effects } = reduceInput(COCKPIT, key(2), cockpitWith([sess('api', 0)]), cfg);
    expect(ui.page).toBe('cockpit');
    expect(effects).toEqual([]);
  });

  it('row 3: APPROVE sends approve for a selected session with tmux', () => {
    const cockpit = cockpitWith([sess('api', 0, 'api-tmux')], 0);
    const { effects } = reduceInput(COCKPIT, key(4), cockpit, cfg);
    expect(effects).toEqual([{ kind: 'approve', tmux: 'api-tmux', agent: 'claude', sessionId: 'api' }]);
  });

  it('row 3: APPROVE with a tmux-less selected session flashes key 4', () => {
    const cockpit = cockpitWith([sess('api', 0)], 0);
    const { effects } = reduceInput(COCKPIT, key(4), cockpit, cfg);
    expect(effects).toEqual([
      { kind: 'flash-error', key: 4, message: expect.stringContaining('tmux') },
    ]);
  });

  it('row 3: APPROVE with nothing selected flashes key 4', () => {
    const cockpit = cockpitWith([sess('api', 0, 'api-tmux')], null);
    const { effects } = reduceInput(COCKPIT, key(4), cockpit, cfg);
    expect(effects).toEqual([
      { kind: 'flash-error', key: 4, message: expect.any(String) },
    ]);
  });

  it('row 4: REJECT mirrors APPROVE on key 5', () => {
    const withTmux = cockpitWith([sess('api', 0, 'api-tmux')], 0);
    expect(reduceInput(COCKPIT, key(5), withTmux, cfg).effects).toEqual([
      { kind: 'reject', tmux: 'api-tmux', agent: 'claude', sessionId: 'api' },
    ]);

    const withoutTmux = cockpitWith([sess('api', 0)], 0);
    expect(reduceInput(COCKPIT, key(5), withoutTmux, cfg).effects).toEqual([
      { kind: 'flash-error', key: 5, message: expect.stringContaining('tmux') },
    ]);
  });

  it('row 5: CONTINUE sends commands[0].text to the selected session', () => {
    const cockpit = cockpitWith([sess('api', 0, 'api-tmux')], 0);
    const { ui, effects } = reduceInput(COCKPIT, key(6), cockpit, cfg);
    expect(effects).toEqual([
      { kind: 'send-text', tmux: 'api-tmux', text: 'continue', agent: 'claude', sessionId: 'api' },
    ]);
    expect(ui.page).toBe('cockpit');
  });

  it('row 5: CONTINUE flashes key 6 with no selection', () => {
    const { effects } = reduceInput(COCKPIT, key(6), cockpitWith([sess('api', 0, 't')]), cfg);
    expect(effects).toEqual([{ kind: 'flash-error', key: 6, message: expect.any(String) }]);
  });

  it('row 5: CONTINUE flashes key 6 when no commands are configured', () => {
    const cockpit = cockpitWith([sess('api', 0, 'api-tmux')], 0);
    const { effects } = reduceInput(COCKPIT, key(6), cockpit, noCommands);
    expect(effects).toEqual([
      { kind: 'flash-error', key: 6, message: expect.stringContaining('command') },
    ]);
  });

  it('row 6: key 7 opens the picker', () => {
    const { ui, effects } = reduceInput(COCKPIT, key(7), cockpitWith([]), cfg);
    expect(ui.page).toBe('picker');
    expect(effects).toEqual([]);
  });

  it('row 7: either touch zone opens the commands page', () => {
    expect(reduceInput(COCKPIT, touch('left'), cockpitWith([]), cfg).ui.page).toBe('commands');
    expect(reduceInput(COCKPIT, touch('right'), cockpitWith([]), cfg).ui.page).toBe('commands');
  });
});

describe('reduceInput — commands page', () => {
  it('row 8: an existing command sends its text and returns to the cockpit', () => {
    const cockpit = cockpitWith([sess('api', 0, 'api-tmux')], 0);
    const { ui, effects } = reduceInput(COMMANDS, key(1), cockpit, cfg);
    expect(effects).toEqual([
      { kind: 'send-text', tmux: 'api-tmux', text: 'run the tests', agent: 'claude', sessionId: 'api' },
    ]);
    expect(ui.page).toBe('cockpit');
  });

  it('row 8: an existing command with no usable session flashes and stays on the page', () => {
    const cockpit = cockpitWith([sess('api', 0)], 0);
    const { ui, effects } = reduceInput(COMMANDS, key(1), cockpit, cfg);
    expect(effects).toEqual([
      { kind: 'flash-error', key: 1, message: expect.stringContaining('tmux') },
    ]);
    expect(ui.page).toBe('commands');
  });

  it('row 9: a key beyond the command list does nothing', () => {
    const cockpit = cockpitWith([sess('api', 0, 'api-tmux')], 0);
    const { ui, effects } = reduceInput(COMMANDS, key(5), cockpit, cfg);
    expect(effects).toEqual([]);
    expect(ui.page).toBe('commands');
  });

  it('row 10: either touch zone returns to the cockpit', () => {
    expect(reduceInput(COMMANDS, touch('left'), cockpitWith([]), cfg).ui.page).toBe('cockpit');
    expect(reduceInput(COMMANDS, touch('right'), cockpitWith([]), cfg).ui.page).toBe('cockpit');
  });
});

describe('reduceInput — picker page', () => {
  it('row 11: keys 0-3 launch the matching project and return to the cockpit', () => {
    const { ui, effects } = reduceInput(PICKER, key(1), cockpitWith([]), cfg);
    expect(effects).toEqual([{ kind: 'launch', project: { name: 'web', path: '/tmp/web' } }]);
    expect(ui.page).toBe('cockpit');
  });

  it('row 12: keys 0-3 with no configured project do nothing', () => {
    const { ui, effects } = reduceInput(PICKER, key(3), cockpitWith([]), cfg);
    expect(effects).toEqual([]);
    expect(ui.page).toBe('picker');
  });

  it('row 13: key 7 cancels back to the cockpit', () => {
    const { ui, effects } = reduceInput(PICKER, key(7), cockpitWith([]), cfg);
    expect(ui.page).toBe('cockpit');
    expect(effects).toEqual([]);
  });

  it('row 14: other keys and touch zones do nothing', () => {
    for (const index of [4, 5, 6]) {
      const { ui, effects } = reduceInput(PICKER, key(index), cockpitWith([]), cfg);
      expect(effects).toEqual([]);
      expect(ui.page).toBe('picker');
    }
    const { ui, effects } = reduceInput(PICKER, touch('left'), cockpitWith([]), cfg);
    expect(effects).toEqual([]);
    expect(ui.page).toBe('picker');
  });
});

// The executor needs to know which CLI it is talking to: codex takes different
// approve/reject key sequences, and a send to codex also needs an optimistic
// 'working' override. The reducer is the only place that knows the selection.
describe('reduceInput — agent tagging', () => {
  const claude = cockpitWith([sess('api', 0, 'api-tmux')], 0);
  const codex = cockpitWith([sess('api', 0, 'api-tmux', 'codex')], 0);
  const explicitClaude = cockpitWith([sess('api', 0, 'api-tmux', 'claude')], 0);

  it('tags APPROVE with the selected session kind', () => {
    expect(reduceInput(COCKPIT, key(4), codex, cfg).effects).toEqual([
      { kind: 'approve', tmux: 'api-tmux', agent: 'codex', sessionId: 'api' },
    ]);
    expect(reduceInput(COCKPIT, key(4), explicitClaude, cfg).effects).toEqual([
      { kind: 'approve', tmux: 'api-tmux', agent: 'claude', sessionId: 'api' },
    ]);
  });

  it('tags REJECT with the selected session kind', () => {
    expect(reduceInput(COCKPIT, key(5), codex, cfg).effects).toEqual([
      { kind: 'reject', tmux: 'api-tmux', agent: 'codex', sessionId: 'api' },
    ]);
    expect(reduceInput(COCKPIT, key(5), explicitClaude, cfg).effects).toEqual([
      { kind: 'reject', tmux: 'api-tmux', agent: 'claude', sessionId: 'api' },
    ]);
  });

  it('tags the cockpit CONTINUE send with the selected session kind', () => {
    expect(reduceInput(COCKPIT, key(6), codex, cfg).effects).toEqual([
      { kind: 'send-text', tmux: 'api-tmux', text: 'continue', agent: 'codex', sessionId: 'api' },
    ]);
  });

  it('tags a commands-page send with the selected session kind', () => {
    expect(reduceInput(COMMANDS, key(1), codex, cfg).effects).toEqual([
      { kind: 'send-text', tmux: 'api-tmux', text: 'run the tests', agent: 'codex', sessionId: 'api' },
    ]);
    expect(reduceInput(COMMANDS, key(1), explicitClaude, cfg).effects).toEqual([
      { kind: 'send-text', tmux: 'api-tmux', text: 'run the tests', agent: 'claude', sessionId: 'api' },
    ]);
  });

  it("defaults to 'claude' when the session file predates the kind field", () => {
    expect(reduceInput(COCKPIT, key(4), claude, cfg).effects).toEqual([
      { kind: 'approve', tmux: 'api-tmux', agent: 'claude', sessionId: 'api' },
    ]);
    expect(reduceInput(COCKPIT, key(5), claude, cfg).effects).toEqual([
      { kind: 'reject', tmux: 'api-tmux', agent: 'claude', sessionId: 'api' },
    ]);
    expect(reduceInput(COCKPIT, key(6), claude, cfg).effects).toEqual([
      { kind: 'send-text', tmux: 'api-tmux', text: 'continue', agent: 'claude', sessionId: 'api' },
    ]);
    expect(reduceInput(COMMANDS, key(1), claude, cfg).effects).toEqual([
      { kind: 'send-text', tmux: 'api-tmux', text: 'run the tests', agent: 'claude', sessionId: 'api' },
    ]);
  });

  it('tags the kind of the selected session, not of slot 0', () => {
    const mixed = cockpitWith(
      [sess('api', 0, 'api-tmux', 'claude'), sess('web', 1, 'web-tmux', 'codex')],
      1,
    );
    expect(reduceInput(COCKPIT, key(4), mixed, cfg).effects).toEqual([
      { kind: 'approve', tmux: 'web-tmux', agent: 'codex', sessionId: 'web' },
    ]);
  });

  it('leaves select/focus/launch untagged — they are kind-agnostic', () => {
    expect(reduceInput(COCKPIT, key(0), codex, cfg).effects).toEqual([
      { kind: 'select', slot: 0 },
      { kind: 'focus', project: 'api', tmux: 'api-tmux' },
    ]);
    expect(reduceInput(PICKER, key(0), codex, cfg).effects).toEqual([
      { kind: 'launch', project: { name: 'api', path: '/tmp/api' } },
    ]);
  });
});

describe('reduceInput — purity and edge cases', () => {
  it('does not mutate its inputs', () => {
    const ui: UiState = { page: 'cockpit' };
    const cockpit = cockpitWith([sess('api', 0, 'api-tmux')], 0);
    const snapshot = JSON.stringify({ ui, cockpit, cfg });
    reduceInput(ui, key(7), cockpit, cfg);
    reduceInput(ui, key(4), cockpit, cfg);
    expect(JSON.stringify({ ui, cockpit, cfg })).toBe(snapshot);
  });

  it('ignores out-of-range key indices', () => {
    const cockpit = cockpitWith([sess('api', 0, 'api-tmux')], 0);
    for (const index of [-1, 8, 42]) {
      expect(reduceInput(COCKPIT, key(index), cockpit, cfg).effects).toEqual([]);
    }
  });

  it('ignores a selection pointing at an empty slot', () => {
    const cockpit: CockpitState = { sessions: [null, null, null, null], selectedSlot: 0, page: 0, pageCount: 1 };
    expect(reduceInput(COCKPIT, key(4), cockpit, cfg).effects).toEqual([
      { kind: 'flash-error', key: 4, message: expect.any(String) },
    ]);
  });
});

describe('reduceInput — paging carousel', () => {
  const paged = (page: number, pageCount: number): CockpitState => ({
    sessions: [null, null, null, null],
    selectedSlot: null,
    page,
    pageCount,
  });

  it('with one page, touch toggles cockpit <-> commands (original behavior)', () => {
    const r1 = reduceInput(COCKPIT, touch('right'), paged(0, 1), cfg);
    expect(r1.ui.page).toBe('commands');
    expect(r1.effects).toEqual([]);
    const r2 = reduceInput(COMMANDS, touch('right'), paged(0, 1), cfg);
    expect(r2.ui.page).toBe('cockpit');
    expect(r2.effects).toEqual([{ kind: 'set-session-page', page: 0 }]);
  });

  it('right advances session pages, then reaches commands, then wraps to page 0', () => {
    // 3 session pages: carousel = [0,1,2,commands].
    const s = (p: number) => reduceInput(COCKPIT, touch('right'), paged(p, 3), cfg);
    expect(s(0).effects).toEqual([{ kind: 'set-session-page', page: 1 }]);
    expect(s(0).ui.page).toBe('cockpit');
    expect(s(2).ui.page).toBe('commands'); // last session page -> commands
    // from commands, right wraps to page 0
    const back = reduceInput(COMMANDS, touch('right'), paged(2, 3), cfg);
    expect(back.ui.page).toBe('cockpit');
    expect(back.effects).toEqual([{ kind: 'set-session-page', page: 0 }]);
  });

  it('left moves backward and wraps to commands from page 0', () => {
    const l = reduceInput(COCKPIT, touch('left'), paged(0, 2), cfg);
    expect(l.ui.page).toBe('commands'); // page 0 <- wraps to commands
    const l2 = reduceInput(COCKPIT, touch('left'), paged(1, 2), cfg);
    expect(l2.effects).toEqual([{ kind: 'set-session-page', page: 0 }]);
  });

  it('touch does nothing on the picker page', () => {
    const r = reduceInput(PICKER, touch('right'), paged(0, 2), cfg);
    expect(r.ui.page).toBe('picker');
    expect(r.effects).toEqual([]);
  });
});
