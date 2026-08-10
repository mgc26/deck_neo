#!/usr/bin/env node
// Codex CLI notify program -> Deck Neo state file.
//
//   node hooks/codex-notify.mjs [--forward <program> [args...]] '<json payload>'
//   node hooks/codex-notify.mjs --register [--name <tmux session name>]
//
// Codex passes its notification JSON as the FINAL argv argument (there is no stdin
// protocol) and its only event type is agent-turn-complete — there is nothing to map to
// 'working' or 'needs-input'. config.toml has a single `notify` slot, so this adapter
// chain-forwards: everything after `--forward <program>` is handed to that program
// unchanged, in a detached child that outlives us. `--register` is what `bin/cx` calls
// before it execs tmux, so the key lights up before codex has said anything.
//
// This runs on Codex's critical path: node builtins only, synchronous, ALWAYS exits 0 —
// a broken adapter must never break a turn or the user's existing notify program.
// Errors go to ~/.deck-neo/hook.log.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

// A loaded machine can starve the spawn for several seconds. A timed-out lookup
// is worse than a short delay here: it misfiles the event under its cwd-derived
// identity and leaves the real session tile stale.
const TMUX_TIMEOUT_MS = 5000;
// Long enough for any session name a human types, short enough that
// `codex-<name>.json` stays well inside the 255-byte filename limit.
const MAX_NAME_LEN = 96;
// A payload-derived label is a directory name, not a typed session name: cap it
// so the hash tag appended after it always survives the MAX_NAME_LEN cut.
const MAX_LABEL_LEN = 40;
// Where a turn-end lands when nothing — tmux, cwd, payload — can identify its
// session. One shared key, deterministic so repeated turns update it instead of
// minting a new one; watch-only, so the store ages it out when the turns stop.
const UNIDENTIFIED = { name: 'unidentified', project: 'codex' };

const home = process.env.HOME || homedir();
const baseDir = join(home, '.deck-neo');
const sessionsDir = join(baseDir, 'sessions');
const logPath = join(baseDir, 'hook.log');

function logError(tag, message) {
  try {
    mkdirSync(baseDir, { recursive: true });
    appendFileSync(logPath, `${new Date().toISOString()} [${tag}] ${message}\n`);
  } catch {
    // Logging is best-effort; never let it fail the adapter.
  }
}

/** Session name of the tmux session this codex process runs in, or undefined. */
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

// tmux keeps '.' and ':' in session names verbatim (it does NOT normalize them —
// verified against tmux 3.7b), so the raw `display-message -p '#S'` answer IS the
// identity. Never "correct" it: a rewritten name would split one session across two
// state files and aim the daemon's send-keys at a session that doesn't exist.
// (bin/cc and bin/cx sanitize '.'/':' out of the names they CREATE, because tmux
// cannot target such names with -t at all.)
const tmuxSessionName = (raw) => raw;

// The id becomes a filename. Keep it inside the character class report-state.mjs
// enforces for Claude session ids, and derive it identically in both modes so the
// --register record and the later notify records are the same file. When the safe
// substitution is lossy (non-Latin names: 仕事 and 趣味 would both become "__"), a
// short hash of the ORIGINAL name keeps distinct sessions in distinct files.
function sessionIdFor(name) {
  const trimmed = name.slice(0, MAX_NAME_LEN);
  const safe = trimmed.replace(/[^A-Za-z0-9_-]/g, '_');
  if (safe === trimmed) return `codex-${safe}`;
  const tag = createHash('sha256').update(name).digest('hex').slice(0, 8);
  return `codex-${safe}-${tag}`;
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

/**
 * Writes the session record. `name` identifies the session, `tmuxName` is the live tmux
 * session (undefined when we can't see one); `force` is registration, the only event
 * allowed to revive an ended session.
 */
function writeRecord({ tag, name, tmuxName, state, force = false, project }) {
  if (!name) {
    logError(tag, 'could not derive a session name from --name, tmux or cwd');
    return;
  }
  const sessionId = sessionIdFor(name);
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId) || sessionId.startsWith('.')) {
    logError(tag, `derived an unusable session id: ${JSON.stringify(sessionId)}`);
    return;
  }

  const path = join(sessionsDir, `${sessionId}.json`);
  const prev = readPrevious(path);
  // Once a session has reported ended, only a fresh registration may revive its file.
  if (prev.state === 'ended' && !force) return;

  let cwd = '';
  try {
    cwd = process.cwd();
  } catch {
    // cwd deleted underneath codex
  }
  if (!cwd && typeof prev.cwd === 'string') cwd = prev.cwd;

  const record = {
    session_id: sessionId,
    cwd,
    project: project || basename(cwd) || (typeof prev.project === 'string' ? prev.project : cwd),
    state,
    kind: 'codex',
    ts: Date.now(),
  };

  // The tmux field is a send-keys TARGET, so keep it consistent with the names
  // bin/cx creates (glob/target metacharacters stripped) and bounded — a direct
  // hostile `--register --name` must not store a 200-char or glob-bearing value.
  // Legit sessions are already sanitized at creation, so this is a no-op for them.
  const rawTmux = tmuxName ?? (typeof prev.tmux === 'string' ? prev.tmux : undefined);
  const tmux =
    typeof rawTmux === 'string' && rawTmux.length > 0
      ? rawTmux.replace(/[.:*?[\]=]/g, '_').slice(0, MAX_NAME_LEN)
      : undefined;
  if (tmux) record.tmux = tmux;

  mkdirSync(sessionsDir, { recursive: true });
  writeAtomic(path, JSON.stringify(record));
}

/** Hands the event to the notify program this adapter displaced. Never waits for it. */
function forwardDetached(tag, program, args) {
  try {
    const child = spawn(program, args, { detached: true, stdio: 'ignore' });
    child.on('error', (err) => {
      // Unreachable in practice — we exit first — but an unhandled 'error' would
      // otherwise crash the adapter before it exits 0.
      logError(tag, `forward to ${program} failed: ${err.message}`);
    });
    child.unref();
  } catch (err) {
    logError(tag, `forward to ${program} failed: ${err && err.message ? err.message : String(err)}`);
  }
}

const PATH_KEYS = ['cwd', 'workspace', 'workspace-root', 'working-directory', 'working_directory'];
// Thread/conversation ids are stable for the life of a session. turn-id is NOT
// in this list and must never be: it changes every turn, so it would burn one
// key per turn instead of updating one session.
const THREAD_KEYS = [
  'thread-id',
  'thread_id',
  'conversation-id',
  'conversation_id',
  'session-id',
  'session_id',
];

/** The first path-ish value that actually names something. */
function payloadPath(payload) {
  for (const key of PATH_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && basename(v)) return v;
  }
  return undefined;
}

/** The first stable id in the payload, if any. */
function payloadThread(payload) {
  for (const key of THREAD_KEYS) {
    const v = payload[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Identity for sessions with no tmux and no usable cwd — the ChatGPT desktop
 * app, whose codex engine is launched by LaunchServices and so runs from '/'.
 * The label comes from a workspace path (the tile then reads like a project);
 * the identity comes from the stable thread id, falling back to the path.
 *
 * The hash tag is not decoration. Without it an app thread resumed in ~/src/api
 * writes to `codex-api` — the file the tmux session `api` already owns — which
 * flips a live terminal session's key to done and lets the app thread inherit
 * its send-keys target. Tagging every payload-derived name keeps them in a
 * namespace tmux- and cwd-derived names can never reach, and keeps two threads
 * opened in one directory on two keys.
 */
function payloadIdentity(payload) {
  if (!payload) return undefined;
  const path = payloadPath(payload);
  // Bounded so the tag survives the MAX_NAME_LEN cut in sessionIdFor: two long
  // paths sharing a prefix must not truncate down onto the same id.
  const label = path ? basename(path).slice(0, MAX_LABEL_LEN) : '';
  const thread = payloadThread(payload);
  const anchor = thread ?? path;
  if (!anchor) return undefined;
  const tag = createHash('sha256').update(anchor).digest('hex').slice(0, 8);
  // The id follows the THREAD, not the label: the app asks which directory to
  // resume a thread in, so the same thread can report different paths on
  // different turns, and a label-keyed id would split it across two keys.
  // The label is display only (watch-only tiles are labelled by `project`).
  return { name: thread ? `app-${tag}` : `${label}-${tag}`, project: label || 'chatgpt' };
}

function parsePayload(arg) {
  if (typeof arg !== 'string' || arg.length === 0) return undefined;
  try {
    const parsed = JSON.parse(arg);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function register(argv) {
  const tag = 'codex-register';
  const nameIdx = argv.indexOf('--name');
  const explicit = nameIdx >= 0 && typeof argv[nameIdx + 1] === 'string' ? argv[nameIdx + 1] : '';
  // cx registers before it execs tmux, so there is no session to detect: the name it
  // passes is the one tmux is about to create.
  const tmuxName = explicit ? tmuxSessionName(explicit) : detectTmuxSession();
  writeRecord({
    tag,
    name: tmuxName ?? basename(safeCwd()),
    tmuxName,
    state: 'idle',
    force: true,
  });
}

function notify(argv) {
  const tag = 'codex-notify';
  const forwardIdx = argv.indexOf('--forward');
  let program;
  let forwardArgs = [];
  if (forwardIdx >= 0) {
    const candidate = argv[forwardIdx + 1];
    if (typeof candidate === 'string' && candidate.length > 0) {
      program = candidate;
      forwardArgs = argv.slice(forwardIdx + 2);
    } else {
      logError(tag, '--forward given without a program to forward to');
    }
  }

  // Codex appends the JSON as the last argument; anything else there is passed through
  // to the forward target untouched, so the chain sees exactly what codex sent.
  const trailing = program ? forwardArgs[forwardArgs.length - 1] : argv[argv.length - 1];
  const payload = parsePayload(trailing);
  const type = payload && typeof payload.type === 'string' ? payload.type : undefined;

  try {
    if (type === 'agent-turn-complete') {
      const tmuxName = detectTmuxSession();
      let name = tmuxName ?? basename(safeCwd());
      let project;
      if (!name) {
        // No tmux and no usable cwd: the ChatGPT desktop app's codex engine, or
        // anything else launched by launchd (cwd '/', no TMUX in its env). Fall
        // back to the identity the payload carries.
        const fromPayload = payloadIdentity(payload);
        if (fromPayload) {
          ({ name, project } = fromPayload);
        } else {
          // A turn genuinely ended, so the session exists; older codex builds
          // just send nothing that identifies it. File it under the shared key
          // rather than dropping the event — a session the deck never shows is
          // worse than one it shows coarsely.
          ({ name, project } = UNIDENTIFIED);
          const keys = payload ? Object.keys(payload).join(', ') : 'none';
          logError(tag, `no identity in payload (keys: ${keys}); filed as ${sessionIdFor(name)}`);
        }
      }
      writeRecord({ tag, name, tmuxName, state: 'done', project });
    } else if (type) {
      logError(tag, `ignoring unsupported notify type ${JSON.stringify(type)}`);
    } else {
      logError(tag, `no usable JSON payload in argv (last argument: ${JSON.stringify(trailing ?? null)})`);
    }
  } finally {
    // The user's own notify program must run whatever we made of the payload.
    if (program) forwardDetached(tag, program, forwardArgs);
  }
}

function safeCwd() {
  try {
    return process.cwd();
  } catch {
    return '';
  }
}

try {
  const argv = process.argv.slice(2);
  if (argv.includes('--register')) register(argv);
  else notify(argv);
} catch (err) {
  logError('codex-notify', err && err.stack ? err.stack : String(err));
}
process.exit(0);
