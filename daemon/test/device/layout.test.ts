import { describe, it, expect } from 'vitest';
import { keySpecsFor, infobarTextFor, blinkOffSpec, COLORS, WATCH_ONLY_MARK } from '../../src/device/layout.js';
import type {
  CockpitState,
  DeckConfig,
  Session,
  SessionFile,
  SessionStateName,
  UiModel,
  UiPage,
} from '../../src/contracts.js';

function sess(project: string, state: SessionStateName, extra: Partial<SessionFile> = {}): SessionFile {
  return {
    session_id: `id-${project}`,
    cwd: `/tmp/${project}`,
    project,
    state,
    ts: 1_700_000_000_000,
    ...extra,
  };
}

function cockpitWith(files: (SessionFile | null)[], selectedSlot: number | null = null): CockpitState {
  const sessions: (Session | null)[] = [0, 1, 2, 3].map((slot) => {
    const file = files[slot] ?? null;
    return file ? { file, slot } : null;
  });
  return { sessions, selectedSlot, page: 0, pageCount: 1 };
}

const CFG: DeckConfig = {
  projects: [
    { name: 'deck_neo', path: '/tmp/deck_neo' },
    { name: 'api', path: '/tmp/api' },
    { name: 'web', path: '/tmp/web' },
    { name: 'infra', path: '/tmp/infra' },
    { name: 'extra', path: '/tmp/extra' },
  ],
  commands: [
    { label: 'CONT', text: 'continue' },
    { label: '/qa', text: '/qa' },
    { label: 'TESTS', text: 'run the tests' },
  ],
};

function model(over: Partial<UiModel> & { page?: UiPage } = {}): UiModel {
  const { page, ...rest } = over;
  return {
    ui: { page: page ?? 'cockpit' },
    cockpit: cockpitWith([]),
    config: CFG,
    infobar: '',
    ...rest,
  };
}

describe('keySpecsFor — cockpit page', () => {
  it('always returns exactly 8 key specs', () => {
    expect(keySpecsFor(model())).toHaveLength(8);
    expect(keySpecsFor(model({ page: 'commands' }))).toHaveLength(8);
    expect(keySpecsFor(model({ page: 'picker' }))).toHaveLength(8);
  });

  it('working session key is blue with the project label and no blink', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([sess('api', 'working', { tmux: 'api' })]) }),
    );
    expect(specs[0]).toMatchObject({ label: 'api', bg: COLORS.working, fg: COLORS.fg });
    expect(specs[0].blink).toBeUndefined();
    expect(specs[0].border).toBeUndefined();
  });

  it('needs-input blinks amber; selected adds a white border', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([null, sess('web', 'needs-input', { tmux: 'web' })], 1) }),
    );
    expect(specs[1]).toMatchObject({
      label: 'web',
      bg: COLORS.needsInput,
      blink: true,
      border: COLORS.selectedBorder,
    });
  });

  it('marks watch-only (tmux-less) sessions with ○, controllable ones without', () => {
    const specs = keySpecsFor(
      model({
        cockpit: cockpitWith([sess('api', 'working'), sess('web', 'done', { tmux: 'web' })]),
      }),
    );
    expect(specs[0].label).toBe(`${WATCH_ONLY_MARK}api`);
    expect(specs[1].label).toBe('web');
  });

  it('done and idle sessions are green', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([sess('a', 'done'), sess('b', 'idle')]) }),
    );
    expect(specs[0].bg).toBe(COLORS.done);
    expect(specs[1].bg).toBe(COLORS.done);
  });

  it('empty slots and ended sessions render as blank dark keys', () => {
    const specs = keySpecsFor(model({ cockpit: cockpitWith([null, sess('gone', 'ended')]) }));
    expect(specs[0]).toMatchObject({ label: '', bg: COLORS.empty });
    expect(specs[1]).toMatchObject({ label: '', bg: COLORS.empty });
  });

  it('draws the four action keys with the contract labels; only + NEW is lit with no selection', () => {
    const specs = keySpecsFor(model());
    expect(specs.slice(4).map((s) => s.label)).toEqual(['Approve', 'Stop', 'Cont', 'New']);
    for (const spec of specs.slice(4, 7)) {
      expect(spec.bg).toBe(COLORS.actionDim); // nothing selected: pressing does nothing
      expect(spec.fg).toBe(COLORS.fgDim);
    }
    expect(specs[7]).toMatchObject({ bg: COLORS.action, fg: COLORS.fg }); // + NEW always acts
  });

  it('lights APPROVE green and REJECT red when the selected controllable session awaits input', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([sess('api', 'needs-input', { tmux: 'api' })], 0) }),
    );
    expect(specs[4]).toMatchObject({ bg: COLORS.done, fg: COLORS.fg });
    expect(specs[5]).toMatchObject({ bg: COLORS.error, fg: COLORS.fg });
  });

  it('keeps APPROVE/REJECT dim when the awaiting session is watch-only', () => {
    const specs = keySpecsFor(model({ cockpit: cockpitWith([sess('api', 'needs-input')], 0) }));
    expect(specs[4].bg).toBe(COLORS.actionDim);
    expect(specs[5].bg).toBe(COLORS.actionDim);
  });

  it('lights CONTINUE blue only when the selected controllable session is ready', () => {
    const ready = keySpecsFor(
      model({ cockpit: cockpitWith([sess('api', 'done', { tmux: 'api' })], 0) }),
    );
    expect(ready[6]).toMatchObject({ bg: COLORS.working, fg: COLORS.fg });

    const busy = keySpecsFor(
      model({ cockpit: cockpitWith([sess('api', 'working', { tmux: 'api' })], 0) }),
    );
    expect(busy[6].bg).toBe(COLORS.actionDim);
  });

  it('falls back to CONTINUE when no commands are configured', () => {
    const specs = keySpecsFor(model({ config: { projects: [], commands: [] } }));
    expect(specs[6].label).toBe('Continue');
  });

  it('truncates a long base label to fit the key', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([sess('proj', 'working', { tmux: 'a-very-long-session-name' })]) }),
    );
    expect(specs[0].label.length).toBeLessThanOrEqual(10);
    expect(specs[0].label.endsWith('…')).toBe(true);
    expect(specs[0].label.startsWith('a-very-l')).toBe(true);
  });
});

describe('keySpecsFor — session key identity', () => {
  it('names a session by its tmux session, not its project, when it has one', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([sess('api', 'working', { tmux: 'api-2' })]) }),
    );
    expect(specs[0].label).toBe('api-2');
  });

  it('suffixes later slots sharing a base label and leaves the first bare', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([sess('api', 'working'), sess('api', 'done')]) }),
    );
    expect(specs[0].label).toBe(`${WATCH_ONLY_MARK}api`);
    expect(specs[1].label).toBe(`${WATCH_ONLY_MARK}api·2`);
  });

  it('numbers a third duplicate ·3, in slot order', () => {
    const specs = keySpecsFor(
      model({
        cockpit: cockpitWith([sess('api', 'working'), sess('api', 'done'), sess('api', 'idle')]),
      }),
    );
    expect(specs.slice(0, 3).map((s) => s.label)).toEqual([
      `${WATCH_ONLY_MARK}api`,
      `${WATCH_ONLY_MARK}api·2`,
      `${WATCH_ONLY_MARK}api·3`,
    ]);
  });

  it('leaves distinct tmux names unsuffixed even when they share a project', () => {
    const specs = keySpecsFor(
      model({
        cockpit: cockpitWith([
          sess('api', 'working', { tmux: 'api' }),
          sess('api', 'done', { tmux: 'api-2' }),
        ]),
      }),
    );
    expect(specs.slice(0, 2).map((s) => s.label)).toEqual(['api', 'api-2']);
  });

  it('suffixes across the tmux/watch-only mix, counting in slot order', () => {
    const tmuxFirst = keySpecsFor(
      model({
        cockpit: cockpitWith([sess('api', 'working', { tmux: 'api' }), sess('api', 'needs-input')]),
      }),
    );
    expect(tmuxFirst.slice(0, 2).map((s) => s.label)).toEqual(['api', `${WATCH_ONLY_MARK}api·2`]);

    const watchFirst = keySpecsFor(
      model({
        cockpit: cockpitWith([sess('api', 'needs-input'), sess('api', 'working', { tmux: 'api' })]),
      }),
    );
    expect(watchFirst.slice(0, 2).map((s) => s.label)).toEqual([`${WATCH_ONLY_MARK}api`, 'api·2']);
  });

  it('does not count blank or ended slots toward the numbering', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([sess('api', 'ended'), null, sess('api', 'working')]) }),
    );
    expect(specs[0].label).toBe('');
    expect(specs[2].label).toBe(`${WATCH_ONLY_MARK}api`);
  });

  it('shortens the base but keeps the ○ mark and the ·2 suffix intact', () => {
    const long = 'infrastructure-pipeline';
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([sess(long, 'working'), sess(long, 'done')]) }),
    );
    for (const spec of specs.slice(0, 2)) expect(spec.label.length).toBeLessThanOrEqual(10);
    expect(specs[0].label).toBe(`${WATCH_ONLY_MARK}infrast…`);
    expect(specs[1].label).toBe(`${WATCH_ONLY_MARK}infra…·2`);
    expect(specs[1].label.endsWith('·2')).toBe(true);
  });

  it('keeps the suffix on a truncated tmux-backed name', () => {
    const specs = keySpecsFor(
      model({
        cockpit: cockpitWith([
          sess('a', 'working', { tmux: 'deck-neo-daemon' }),
          sess('b', 'done', { tmux: 'deck-neo-daemon' }),
        ]),
      }),
    );
    expect(specs[1].label.length).toBeLessThanOrEqual(10);
    expect(specs[1].label.endsWith('·2')).toBe(true);
    expect(specs[1].label).toBe('deck-ne…·2');
  });
});

describe('keySpecsFor — commands page', () => {
  it('maps commands to keys and blanks the keys beyond the list', () => {
    const specs = keySpecsFor(model({ page: 'commands' }));
    expect(specs.slice(0, 3).map((s) => s.label)).toEqual(['Cont', '/qa', 'Tests']);
    // No controllable session selected: command keys are dim (still labelled).
    for (const spec of specs.slice(0, 3)) expect(spec.bg).toBe(COLORS.actionDim);
    for (const spec of specs.slice(3)) expect(spec).toMatchObject({ label: '', bg: COLORS.empty });
  });

  it('lights command keys when a controllable session is selected', () => {
    const specs = keySpecsFor(
      model({ page: 'commands', cockpit: cockpitWith([sess('api', 'done', { tmux: 'api' })], 0) }),
    );
    for (const spec of specs.slice(0, 3)) expect(spec).toMatchObject({ bg: COLORS.action, fg: COLORS.fg });
  });

  it('shows at most 8 commands', () => {
    const commands = Array.from({ length: 12 }, (_, i) => ({ label: `c${i}`, text: `t${i}` }));
    const specs = keySpecsFor(model({ page: 'commands', config: { projects: [], commands } }));
    expect(specs.map((s) => s.label)).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
  });
});

describe('keySpecsFor — picker page', () => {
  it('shows the first 4 projects on the top row and a cancel key on key 7', () => {
    const specs = keySpecsFor(model({ page: 'picker' }));
    expect(specs.slice(0, 4).map((s) => s.label)).toEqual(['deck_neo', 'api', 'web', 'infra']);
    for (const spec of specs.slice(4, 7)) expect(spec).toMatchObject({ label: '', bg: COLORS.empty });
    expect(specs[7]).toMatchObject({ label: 'Cancel', bg: COLORS.action });
  });

  it('blanks picker slots with no configured project', () => {
    const specs = keySpecsFor(
      model({ page: 'picker', config: { projects: [{ name: 'solo', path: '/tmp/solo' }], commands: [] } }),
    );
    expect(specs[0].label).toBe('solo');
    for (const spec of specs.slice(1, 4)) expect(spec).toMatchObject({ label: '', bg: COLORS.empty });
  });
});

describe('keySpecsFor — flash override', () => {
  it('overrides the background to red on the flashed key only', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([sess('api', 'working')]), flash: { key: 4 } }),
    );
    expect(specs[4].bg).toBe(COLORS.error);
    expect(specs[0].bg).toBe(COLORS.working);
  });

  it('stops a blink while the key is flashing but keeps the selected border', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([sess('web', 'needs-input')], 0), flash: { key: 0 } }),
    );
    expect(specs[0]).toMatchObject({ bg: COLORS.error, border: COLORS.selectedBorder });
    expect(specs[0].blink).toBeUndefined();
  });

  it('ignores an out-of-range flash key', () => {
    const specs = keySpecsFor(model({ flash: { key: 99 } }));
    expect(specs.every((s) => s.bg !== COLORS.error)).toBe(true);
  });
});

describe('blinkOffSpec', () => {
  it('dims the background of a blinking key and clears the blink flag', () => {
    const off = blinkOffSpec({ label: 'web', bg: COLORS.needsInput, fg: COLORS.fg, blink: true });
    expect(off.bg).toBe(COLORS.blinkOff);
    expect(off.blink).toBeUndefined();
    expect(off.label).toBe('web');
  });

  it('leaves a non-blinking key untouched', () => {
    const spec = { label: 'api', bg: COLORS.working, fg: COLORS.fg };
    expect(blinkOffSpec(spec)).toEqual(spec);
  });
});

describe('infobarTextFor', () => {
  it('passes through a caller-supplied infobar string', () => {
    expect(infobarTextFor(model({ infobar: 'deck_neo ▸ permission: Bash' }))).toBe(
      'deck_neo ▸ permission: Bash',
    );
  });

  it('cockpit: shows the selected project and its notification message', () => {
    const files = [sess('api', 'needs-input', { tmux: 'api', message: 'permission: Bash(npm test)' })];
    expect(infobarTextFor(model({ cockpit: cockpitWith(files, 0) }))).toBe(
      'api ▸ permission: Bash(npm test)',
    );
  });

  it('cockpit: falls back to the state name when there is no message', () => {
    expect(
      infobarTextFor(model({ cockpit: cockpitWith([sess('api', 'working', { tmux: 'api' })], 0) })),
    ).toBe('api ▸ working');
  });

  it('cockpit: explains the ○ mark — watch-only tag for tmux-less sessions', () => {
    expect(infobarTextFor(model({ cockpit: cockpitWith([sess('api', 'working')], 0) }))).toBe(
      'api ▸ watch-only ▸ working',
    );
  });

  it('cockpit: reports when nothing is selected', () => {
    expect(infobarTextFor(model({ cockpit: cockpitWith([sess('api', 'working')]) }))).toBe(
      'no session selected',
    );
  });

  it('commands: names the target project, or none', () => {
    expect(
      infobarTextFor(model({ page: 'commands', cockpit: cockpitWith([sess('api', 'done')], 0) })),
    ).toBe('commands ▸ api');
    expect(infobarTextFor(model({ page: 'commands' }))).toBe('commands ▸ none');
  });

  it('picker: prompts for a project', () => {
    expect(infobarTextFor(model({ page: 'picker' }))).toBe('pick a project');
  });
});

describe('infobarTextFor — agent kind', () => {
  it('cockpit: tags a codex session between its name and the detail', () => {
    const files = [sess('api', 'needs-input', { kind: 'codex', tmux: 'cx1', message: 'approve? y/n' })];
    expect(infobarTextFor(model({ cockpit: cockpitWith(files, 0) }))).toBe(
      'cx1 ▸ codex ▸ approve? y/n',
    );
  });

  it('cockpit: a codex session with no message still falls back to the state', () => {
    expect(
      infobarTextFor(model({ cockpit: cockpitWith([sess('api', 'done', { kind: 'codex', tmux: 'api' })], 0) })),
    ).toBe('api ▸ codex ▸ done');
  });

  it('cockpit: claude sessions stay untagged, explicit kind or not', () => {
    expect(
      infobarTextFor(model({ cockpit: cockpitWith([sess('api', 'working', { kind: 'claude', tmux: 'api' })], 0) })),
    ).toBe('api ▸ working');
    expect(
      infobarTextFor(model({ cockpit: cockpitWith([sess('api', 'working', { tmux: 'api' })], 0) })),
    ).toBe('api ▸ working');
  });

  it('cockpit: names the session by its tmux identity, as the key does', () => {
    expect(
      infobarTextFor(model({ cockpit: cockpitWith([sess('api', 'working', { tmux: 'api-2' })], 0) })),
    ).toBe('api-2 ▸ working');
  });

  it('commands: names a codex target by its tmux identity, with no kind tag', () => {
    expect(
      infobarTextFor(
        model({
          page: 'commands',
          cockpit: cockpitWith([sess('api', 'done', { kind: 'codex', tmux: 'cx1' })], 0),
        }),
      ),
    ).toBe('commands ▸ cx1');
  });
});

describe('QA round: empty tmux and astral labels', () => {
  it('treats an empty-string tmux as absent: project label, ○ mark, dim APPROVE', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([sess('api', 'needs-input', { tmux: '' })], 0) }),
    );
    expect(specs[0].label).toBe(`${WATCH_ONLY_MARK}api`);
    expect(specs[4].bg).toBe(COLORS.actionDim); // not controllable -> APPROVE stays dim
  });

  it('never splits a surrogate pair when truncating emoji labels', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitWith([sess('p', 'working', { tmux: '💀💀💀💀💀💀💀💀💀💀💀💀' })]) }),
    );
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(specs[0].label)).toBe(false);
    expect(specs[0].label.endsWith('…')).toBe(true);
  });
});

/** cockpitWith, plus a detached flag on the given slots. */
function cockpitDetached(
  files: (SessionFile | null)[],
  detachedSlots: number[],
  selectedSlot: number | null = null,
): CockpitState {
  const base = cockpitWith(files, selectedSlot);
  return {
    ...base,
    sessions: base.sessions.map((s) =>
      s && detachedSlots.includes(s.slot) ? { ...s, detached: true } : s,
    ),
  };
}

describe('keySpecsFor — detached sessions', () => {
  it('flattens a detached working session to a dim tile, keeping name, hue and brand', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitDetached([sess('api', 'working', { tmux: 'api' })], [0]) }),
    );
    expect(specs[0]).toMatchObject({
      label: 'api',
      bg: COLORS.working,
      fg: COLORS.fg,
      dim: true,
      sublabel: 'Working',
      brand: 'claude',
    });
    expect(specs[0].blink).toBeUndefined();
  });

  it('keeps the amber blink on a detached needs-input session — urgency wins', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitDetached([sess('api', 'needs-input', { tmux: 'api' })], [0]) }),
    );
    expect(specs[0]).toMatchObject({ bg: COLORS.needsInput, blink: true });
    expect(specs[0].dim).toBeUndefined();
  });

  it('keeps the selection border on a dim detached key', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitDetached([sess('api', 'done', { tmux: 'api' })], [0], 0) }),
    );
    expect(specs[0]).toMatchObject({ dim: true, border: COLORS.selectedBorder });
  });

  it('leaves attached and watch-only sessions lit', () => {
    const specs = keySpecsFor(
      model({
        cockpit: cockpitDetached(
          [sess('api', 'working', { tmux: 'api' }), sess('web', 'working')],
          [],
        ),
      }),
    );
    expect(specs[0].dim).toBeUndefined();
    expect(specs[1].dim).toBeUndefined();
  });

  it('still lights CONTINUE for a selected detached ready session — detached stays controllable', () => {
    const specs = keySpecsFor(
      model({ cockpit: cockpitDetached([sess('api', 'done', { tmux: 'api' })], [0], 0) }),
    );
    expect(specs[6]).toMatchObject({ bg: COLORS.working, fg: COLORS.fg });
  });
});

describe('infobarTextFor — detached', () => {
  it('cockpit: explains the flat tile — detached tag between name and detail', () => {
    expect(
      infobarTextFor(
        model({ cockpit: cockpitDetached([sess('api', 'working', { tmux: 'api' })], [0], 0) }),
      ),
    ).toBe('api ▸ detached ▸ working');
  });

  it('cockpit: attached sessions stay untagged', () => {
    expect(
      infobarTextFor(
        model({ cockpit: cockpitDetached([sess('api', 'working', { tmux: 'api' })], [], 0) }),
      ),
    ).toBe('api ▸ working');
  });
});

describe('brand watermarks', () => {
  it('stamps session keys with their agent kind, defaulting to claude', () => {
    const specs = keySpecsFor(
      model({
        cockpit: cockpitWith([
          sess('api', 'working', { tmux: 'api' }),
          sess('cx', 'done', { tmux: 'cx', kind: 'codex' }),
        ]),
      }),
    );
    expect(specs[0].brand).toBe('claude');
    expect(specs[1].brand).toBe('codex');
    expect(specs[4].brand).toBeUndefined(); // action keys carry no watermark
  });
});
