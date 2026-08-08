import type {
  AgentKind,
  CockpitState,
  DeckConfig,
  Effect,
  RawInput,
  Session,
  UiState,
} from '../contracts.js';

const KEY_COUNT = 8;
const SESSION_KEYS = 4;

export interface ReduceResult {
  ui: UiState;
  effects: Effect[];
}

const NO_SELECTION = 'no session selected';
const NO_TMUX = 'session has no tmux session';
const NO_COMMANDS = 'no commands configured';

function selectedSession(cockpit: CockpitState): Session | null {
  const slot = cockpit.selectedSlot;
  if (slot === null) return null;
  return cockpit.sessions[slot] ?? null;
}

function flash(key: number, message: string): Effect[] {
  return [{ kind: 'flash-error', key, message }];
}

/**
 * Resolves the tmux target of the current selection, or the reason there is none.
 * Callers turn the reason into a flash on their own key.
 *
 * `agent` rides along because the executor needs it — codex takes different
 * approve/reject key sequences — and the reducer is the only place that knows
 * which session the press applied to. A file without `kind` predates phase 2.
 */
function tmuxTarget(
  cockpit: CockpitState,
): { tmux: string; agent: AgentKind; sessionId: string } | { error: string } {
  const session = selectedSession(cockpit);
  if (session === null) return { error: NO_SELECTION };
  if (session.file.tmux === undefined || session.file.tmux === '') return { error: NO_TMUX };
  return {
    tmux: session.file.tmux,
    agent: session.file.kind ?? 'claude',
    sessionId: session.file.session_id,
  };
}

/**
 * The single source of truth for what a Neo press means. Pure: no IO, no
 * mutation of its arguments — the caller performs the returned effects.
 */
export function reduceInput(
  ui: UiState,
  input: RawInput,
  cockpit: CockpitState,
  config: DeckConfig,
): ReduceResult {
  const unchanged: ReduceResult = { ui, effects: [] };

  if (input.type === 'touch') {
    // The picker is a modal launch flow, not part of the touch carousel.
    if (ui.page === 'picker') return unchanged;
    return touchNav(ui, input.zone, cockpit);
  }

  const index = input.index;
  if (!Number.isInteger(index) || index < 0 || index >= KEY_COUNT) return unchanged;

  switch (ui.page) {
    case 'cockpit':
      return cockpitKey(ui, index, cockpit, config);
    case 'commands':
      return commandsKey(ui, index, cockpit, config);
    case 'picker':
      return pickerKey(ui, index, config);
  }
}

/**
 * Touch zones drive one carousel: [session page 0] … [session page N-1] [commands].
 * Right = next screen, left = previous, both wrap. With <= 4 sessions there is a
 * single session page, so this is the original "touch toggles commands" behavior.
 */
function touchNav(ui: UiState, zone: 'left' | 'right', cockpit: CockpitState): ReduceResult {
  const last = cockpit.pageCount; // carousel index of the commands screen
  // Current carousel position: a session page (0..pageCount-1) or commands (last).
  const pos = ui.page === 'commands' ? last : cockpit.page;
  const next = zone === 'right' ? (pos + 1) % (last + 1) : (pos - 1 + (last + 1)) % (last + 1);

  if (next === last) return { ui: { page: 'commands' }, effects: [] };
  return { ui: { page: 'cockpit' }, effects: [{ kind: 'set-session-page', page: next }] };
}

function cockpitKey(
  ui: UiState,
  index: number,
  cockpit: CockpitState,
  config: DeckConfig,
): ReduceResult {
  if (index < SESSION_KEYS) {
    const session = cockpit.sessions[index];
    if (!session) return { ui, effects: [] };
    return {
      ui,
      effects: [
        { kind: 'select', slot: index },
        { kind: 'focus', project: session.file.project },
      ],
    };
  }

  if (index === 7) return { ui: { page: 'picker' }, effects: [] };

  const target = tmuxTarget(cockpit);

  if (index === 4) {
    return 'tmux' in target
      ? { ui, effects: [{ kind: 'approve', tmux: target.tmux, agent: target.agent, sessionId: target.sessionId }] }
      : { ui, effects: flash(4, target.error) };
  }

  if (index === 5) {
    return 'tmux' in target
      ? { ui, effects: [{ kind: 'reject', tmux: target.tmux, agent: target.agent, sessionId: target.sessionId }] }
      : { ui, effects: flash(5, target.error) };
  }

  // index === 6: CONTINUE — commands[0] doubles as the cockpit continue key.
  const command = config.commands[0];
  if (command === undefined) return { ui, effects: flash(6, NO_COMMANDS) };
  return 'tmux' in target
    ? {
        ui,
        effects: [
          { kind: 'send-text', tmux: target.tmux, text: command.text, agent: target.agent, sessionId: target.sessionId },
        ],
      }
    : { ui, effects: flash(6, target.error) };
}

function commandsKey(
  ui: UiState,
  index: number,
  cockpit: CockpitState,
  config: DeckConfig,
): ReduceResult {
  const command = config.commands[index];
  if (command === undefined) return { ui, effects: [] };

  const target = tmuxTarget(cockpit);
  if (!('tmux' in target)) return { ui, effects: flash(index, target.error) };

  return {
    ui: { page: 'cockpit' },
    effects: [{ kind: 'send-text', tmux: target.tmux, text: command.text, agent: target.agent, sessionId: target.sessionId }],
  };
}

function pickerKey(ui: UiState, index: number, config: DeckConfig): ReduceResult {
  if (index === 7) return { ui: { page: 'cockpit' }, effects: [] };
  if (index >= SESSION_KEYS) return { ui, effects: [] };

  const project = config.projects[index];
  if (project === undefined) return { ui, effects: [] };
  return { ui: { page: 'cockpit' }, effects: [{ kind: 'launch', project }] };
}
