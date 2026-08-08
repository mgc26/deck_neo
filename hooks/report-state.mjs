#!/usr/bin/env node
// Claude Code hook -> Deck Neo state file.
//
//   node hooks/report-state.mjs <SessionStart|UserPromptSubmit|Notification|Stop|SessionEnd>
//
// Hook JSON arrives on stdin; the session's current state is written to
// ~/.deck-neo/sessions/<session_id>.json. This runs on Claude's critical path, so it
// uses node builtins only, does its work synchronously, and ALWAYS exits 0 — a broken
// hook must never block or fail a Claude turn. Errors go to ~/.deck-neo/hook.log.

import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

const EVENT_STATES = {
  SessionStart: 'idle',
  UserPromptSubmit: 'working',
  Notification: 'needs-input',
  Stop: 'done',
  SessionEnd: 'ended',
};

// Subagent events don't map straight to a state: they adjust the live-agent
// counter, and the state is derived from counter + main-loop phase below.
const SUBAGENT_EVENTS = new Set(['SubagentStart', 'SubagentStop']);

// Generous ceilings: on an idle machine these paths take single-digit ms, but a
// loaded one (parallel builds, test suites) can starve a child spawn past 500ms —
// and a timed-out tmux lookup would silently drop the session's control channel.
const STDIN_TIMEOUT_MS = 1000;
const TMUX_TIMEOUT_MS = 2000;

const home = process.env.HOME || homedir();
const baseDir = join(home, '.deck-neo');
const sessionsDir = join(baseDir, 'sessions');
const logPath = join(baseDir, 'hook.log');

function logError(event, message) {
  try {
    mkdirSync(baseDir, { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} [${event}] ${message}\n`);
  } catch {
    // Logging is best-effort; never let it fail the hook.
  }
}

function readStdin() {
  if (process.stdin.isTTY) return Promise.resolve('');
  return new Promise((resolve) => {
    const chunks = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    const timer = setTimeout(finish, STDIN_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

/** Session name of the tmux session this Claude process runs in, or undefined. */
function detectTmuxSession() {
  if (!process.env.TMUX) return undefined;
  try {
    const out = execFileSync('tmux', ['display-message', '-p', '#S'], {
      encoding: 'utf8',
      timeout: TMUX_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const name = out.trim();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

function readPrevious(path) {
  try {
    if (!existsSync(path)) return {};
    const prev = JSON.parse(readFileSync(path, 'utf8'));
    return prev && typeof prev === 'object' ? prev : {};
  } catch {
    return {}; // a corrupt previous file is simply replaced
  }
}

function writeAtomic(path, contents) {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, contents, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
}

async function main() {
  const event = process.argv[2];
  if (!EVENT_STATES[event] && !SUBAGENT_EVENTS.has(event)) {
    logError(
      event ?? '(none)',
      'unknown hook event; expected one of ' +
        [...Object.keys(EVENT_STATES), ...SUBAGENT_EVENTS].join(', '),
    );
    return;
  }

  const raw = await readStdin();
  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    logError(event, `stdin was not valid JSON (${raw.length} bytes)`);
    return;
  }
  if (!payload || typeof payload !== 'object') {
    logError(event, 'stdin JSON was not an object');
    return;
  }

  const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
  // The id becomes a filename; anything path-ish would let a hook payload write outside
  // the sessions dir.
  // 'codex-' is the Codex adapter's id namespace; a Claude payload carrying such an
  // id (malformed or hostile) would overwrite a Codex record and flip its `kind`,
  // silently switching which approve/reject key sequences the deck sends.
  if (
    !sessionId ||
    !/^[A-Za-z0-9._-]+$/.test(sessionId) ||
    sessionId.startsWith('.') ||
    sessionId.startsWith('codex-')
  ) {
    logError(event, `missing or unusable session_id: ${JSON.stringify(payload.session_id ?? null)}`);
    return;
  }

  const path = join(sessionsDir, `${sessionId}.json`);
  const prev = readPrevious(path);

  // Hooks for one session can race (Stop vs SessionEnd): once a session has
  // reported ended, only a fresh SessionStart may revive its file.
  if (prev.state === 'ended' && event !== 'SessionStart') return;

  const cwd =
    typeof payload.cwd === 'string' && payload.cwd.length > 0
      ? payload.cwd
      : typeof prev.cwd === 'string'
        ? prev.cwd
        : process.cwd();

  // Derive the state from: this event, the main-loop phase, and how many
  // subagents are still out. A session with background agents running is
  // "working" even after its main turn stopped — the green light must mean
  // "everything is finished".
  const prevAgents = typeof prev.agents === 'number' && prev.agents > 0 ? Math.floor(prev.agents) : 0;
  const prevMain = prev.main === 'running' ? 'running' : 'idle';
  const prevState = typeof prev.state === 'string' ? prev.state : 'idle';

  let agents = prevAgents;
  let mainPhase = prevMain;
  let state;
  // When true, keep the prior message instead of adopting this payload's text —
  // the idle nag must not overwrite the real pending-prompt explanation.
  let keepPrevMessage = false;

  switch (event) {
    case 'SessionStart':
      agents = 0; // a fresh session can't have leaked agents
      mainPhase = 'idle';
      state = 'idle';
      break;
    case 'UserPromptSubmit':
      mainPhase = 'running';
      state = 'working';
      break;
    case 'Notification': {
      // Not every notification is an alert. "Claude is waiting for your input"
      // is the idle nag ~60s after a turn ends — that session is READY, and
      // blinking amber for it would cry wolf. Amber is reserved for genuine
      // mid-task attention: permissions, questions, plan approvals.
      const text = typeof payload.message === 'string' ? payload.message : '';
      const isIdleNag = /^claude is waiting for( your)? input\.?$/i.test(text.trim());
      if (isIdleNag && prevState !== 'needs-input') {
        // Demote to ready — but never clear a still-pending permission/question
        // prompt (prevState needs-input) to green; that would hide a real block.
        mainPhase = 'idle';
        state = agents > 0 ? 'working' : 'done';
      } else if (isIdleNag) {
        state = 'needs-input'; // keep the pending prompt visible, drop the nag text
        keepPrevMessage = true; // don't let the nag replace the real prompt message
      } else {
        state = 'needs-input'; // attention beats everything while it lasts
      }
      break;
    }
    case 'Stop':
      mainPhase = 'idle';
      state = agents > 0 ? 'working' : 'done';
      break;
    case 'SubagentStart':
      agents = Math.min(agents + 1, 99);
      state = prevState === 'needs-input' ? 'needs-input' : 'working';
      break;
    case 'SubagentStop':
      agents = Math.max(agents - 1, 0);
      state =
        prevState === 'needs-input'
          ? 'needs-input'
          : agents > 0 || mainPhase === 'running'
            ? 'working'
            : 'done';
      break;
    default: // SessionEnd
      state = 'ended';
  }

  const record = {
    session_id: sessionId,
    cwd,
    project: basename(cwd) || (typeof prev.project === 'string' ? prev.project : cwd),
    state,
    kind: 'claude',
    agents,
    main: mainPhase,
    ts: Date.now(),
  };

  if (state === 'needs-input') {
    // The LCD strip shows a few dozen characters; an unbounded message is pure
    // rendering cost downstream. Subagent events must not drop an active message.
    if (!keepPrevMessage && typeof payload.message === 'string' && payload.message.length > 0) {
      record.message = payload.message.slice(0, 500);
    } else if (typeof prev.message === 'string') {
      record.message = prev.message;
    }
  }

  const tmuxName = detectTmuxSession() ?? (typeof prev.tmux === 'string' ? prev.tmux : undefined);
  if (tmuxName) record.tmux = tmuxName;

  mkdirSync(sessionsDir, { recursive: true });
  writeAtomic(path, JSON.stringify(record));
}

try {
  await main();
} catch (err) {
  logError(process.argv[2] ?? '(none)', err && err.stack ? err.stack : String(err));
}
process.exit(0);
