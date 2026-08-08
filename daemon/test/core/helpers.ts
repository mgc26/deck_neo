// Shared helpers for core tests. Not a *.test.ts file, so vitest does not collect it.
import { EventEmitter } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentKind, CockpitState, SessionFile, SessionStateName } from '../../src/contracts.js';

export async function makeTmpDir(prefix = 'deckneo-core-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

/** Polls `predicate` until it returns true, or fails the test after `timeoutMs`. */
export async function waitUntil(
  predicate: () => boolean,
  what: string,
  timeoutMs = 5000,
  stepMs = 10,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** Resolves with the first payload of `event`, or rejects on timeout. */
export function nextEvent<T>(emitter: EventEmitter, event: string, timeoutMs = 5000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      emitter.off(event, onEvent);
      reject(new Error(`timed out after ${timeoutMs}ms waiting for '${event}'`));
    }, timeoutMs);
    const onEvent = (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    };
    emitter.once(event, onEvent);
  });
}

/** Waits until `slot` holds the session with `id`. */
export function waitSession(
  store: { getState(): CockpitState },
  slot: number,
  id: string,
  timeoutMs = 5000,
): Promise<void> {
  return waitUntil(
    () => store.getState().sessions[slot]?.file.session_id === id,
    `session ${id} in slot ${slot}`,
    timeoutMs,
  );
}

/** Bounded wait used only for negative assertions ("no event should arrive"). */
export function settle(ms = 250): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface SessionOverrides {
  session_id: string;
  project?: string;
  cwd?: string;
  state?: SessionStateName;
  kind?: AgentKind;
  message?: string;
  tmux?: string;
  agents?: number;
  main?: 'running' | 'idle';
  ts?: number;
}

export function sessionFile(o: SessionOverrides): SessionFile {
  const project = o.project ?? o.session_id;
  const file: SessionFile = {
    session_id: o.session_id,
    cwd: o.cwd ?? `/tmp/${project}`,
    project,
    state: o.state ?? 'idle',
    ts: o.ts ?? Date.now(),
  };
  if (o.kind !== undefined) file.kind = o.kind;
  if (o.message !== undefined) file.message = o.message;
  if (o.tmux !== undefined) file.tmux = o.tmux;
  if (o.agents !== undefined) file.agents = o.agents;
  if (o.main !== undefined) file.main = o.main;
  return file;
}

export async function writeSession(dir: string, o: SessionOverrides): Promise<SessionFile> {
  const file = sessionFile(o);
  await writeFile(join(dir, `${o.session_id}.json`), JSON.stringify(file), 'utf8');
  return file;
}

export async function writeRaw(dir: string, name: string, contents: string): Promise<void> {
  await writeFile(join(dir, name), contents, 'utf8');
}
