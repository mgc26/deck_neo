// Shared types for the Deck Neo cockpit, and the authoritative source for them.
// Every module imports from here; nobody redeclares these shapes.

// ---- Session state file: ~/.deck-neo/sessions/<session_id>.json ----
export type SessionStateName =
  | 'idle'        // SessionStart
  | 'working'     // UserPromptSubmit
  | 'needs-input' // Notification (message carries detail)
  | 'done'        // Stop
  | 'ended';      // SessionEnd -> slot is freed

/** Which agent CLI a session belongs to. Absent in older files = 'claude'. */
export type AgentKind = 'claude' | 'codex';

export interface SessionFile {
  session_id: string;
  cwd: string;
  project: string;      // basename(cwd)
  state: SessionStateName;
  kind?: AgentKind;     // absent = 'claude'
  message?: string;     // Notification text, when state === 'needs-input'
  tmux?: string;        // tmux session name; absent if not started inside tmux
  agents?: number;      // live subagents (SubagentStart/Stop hooks); informational —
                        // the hook already folds this into `state`
  main?: 'running' | 'idle'; // main-loop phase; informational, same reason
  ts: number;           // epoch millis written by the hook
}

// ---- Config file: ~/.deck-neo/config.json ----
export interface ProjectRef { name: string; path: string }
export interface CommandRef { label: string; text: string }
export interface KeySequences {
  approve?: string[];       // tmux send-keys args, default ['Enter']
  reject?: string[];        // default ['Escape']
}
export interface DeckConfig {
  projects: ProjectRef[];   // launcher picker shows the first 4
  commands: CommandRef[];   // commands[0] is also the cockpit CONTINUE key; page 2 shows up to 8
  keys?: KeySequences & {
    codex?: KeySequences;   // per-kind overrides; fall back to the top-level values
  };
  launch?: {
    claudeArgs?: string[];  // standing flags for + NEW launches (the daemon runs
                            // under launchd and never sees shell-alias env vars)
  };
}

// ---- System model (tmux -> core) ----
/** One live tmux session as reported by `tmux list-sessions`. */
export interface TmuxSession {
  name: string;
  attached: boolean;        // any client attached; false = running headless
}

// ---- Cockpit model (core -> device) ----
export interface Session {
  file: SessionFile;
  slot: number;             // 0..3
  detached?: boolean;       // tmux alive but no client — never written to session files
}
export interface CockpitState {
  sessions: (Session | null)[]; // the current PAGE of session keys, ALWAYS length 4
  selectedSlot: number | null;  // selected session's slot on the current page, or null
  page: number;                 // 0-based session-page index
  pageCount: number;            // number of session pages (>= 1); sessions are unlimited
}

// ---- UI model & reducer ----
export type UiPage = 'cockpit' | 'commands' | 'picker';
export interface UiState { page: UiPage }

export type RawInput =
  | { type: 'key'; index: number }            // 0..7, top row 0-3, bottom 4-7
  | { type: 'touch'; zone: 'left' | 'right' };

export type Effect =
  | { kind: 'select'; slot: number }
  | { kind: 'focus'; project: string }
  | { kind: 'approve'; tmux: string; agent: AgentKind; sessionId: string }
  | { kind: 'reject'; tmux: string; agent: AgentKind; sessionId: string }
  | { kind: 'send-text'; tmux: string; text: string; agent: AgentKind; sessionId: string }
  | { kind: 'launch'; project: ProjectRef }
  | { kind: 'set-session-page'; page: number }
  | { kind: 'flash-error'; key: number; message: string };

// ---- Render model (index.ts builds it; device consumes it) ----
export interface UiModel {
  ui: UiState;
  cockpit: CockpitState;
  config: DeckConfig;
  infobar: string;
  flash?: { key: number };  // brief red flash on this key
}

export interface KeySpec {
  label: string;      // short text drawn on the key ('' = blank)
  bg: string;         // accent hue for the tile wash/state bar (css color)
  fg: string;         // css color
  border?: string;    // css color, selected-session highlight keyline
  blink?: boolean;    // amber attention pulse (renderer breathes the wash)
  sublabel?: string;  // small state word under the name ("Working", "Needs you")
  glyph?: string;     // large action glyph drawn above the label ("✓", "✕", "+")
  dim?: boolean;      // inert action key: flat tile, muted text, no glow
  brand?: AgentKind;  // small corner watermark: which agent runs this session
}
