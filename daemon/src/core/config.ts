import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { watch, type FSWatcher } from 'chokidar';
import type { CommandRef, DeckConfig, KeySequences, ProjectRef } from '../contracts.js';

const EMPTY_CONFIG: DeckConfig = { projects: [], commands: [] };

// Small stability window so a half-written file is never parsed.
const AWAIT_WRITE_FINISH = { stabilityThreshold: 20, pollInterval: 10 };

// fs.watch misses events: it drops a small fraction of writes on macOS, and it
// never reports a file whose parent directory did not exist when watching began
// (the daemon started before ~/.deck-neo did). Re-reading the file on a slow
// timer covers both; load() only emits when the parsed config actually changed.
const DEFAULT_RECONCILE_MS = 2000;

function fail(why: string): never {
  throw new Error(`invalid config: ${why}`);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function stringField(source: Record<string, unknown>, key: string, where: string): string {
  const value = source[key];
  if (typeof value !== 'string') fail(`${where}.${key} must be a string`);
  return value;
}

function stringArray(value: unknown, where: string): string[] {
  if (!Array.isArray(value)) fail(`${where} must be an array of strings`);
  return value.map((entry, i) => {
    if (typeof entry !== 'string') fail(`${where}[${i}] must be a string`);
    return entry;
  });
}

/** Shared by the top-level `keys` block and each per-kind override under it. */
function keySequences(value: Record<string, unknown>, where: string): KeySequences {
  const seq: KeySequences = {};
  if (value.approve !== undefined) seq.approve = stringArray(value.approve, `${where}.approve`);
  if (value.reject !== undefined) seq.reject = stringArray(value.reject, `${where}.reject`);
  return seq;
}

export function parseConfig(json: string): DeckConfig {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch (err) {
    fail(`not valid JSON (${(err as Error).message})`);
  }
  if (!isRecord(root)) fail('top level must be an object');

  if (!Array.isArray(root.projects)) fail('projects must be an array');
  if (!Array.isArray(root.commands)) fail('commands must be an array');

  const projects: ProjectRef[] = root.projects.map((entry, i) => {
    if (!isRecord(entry)) fail(`projects[${i}] must be an object`);
    return {
      name: stringField(entry, 'name', `projects[${i}]`),
      path: stringField(entry, 'path', `projects[${i}]`),
    };
  });

  const commands: CommandRef[] = root.commands.map((entry, i) => {
    if (!isRecord(entry)) fail(`commands[${i}] must be an object`);
    return {
      label: stringField(entry, 'label', `commands[${i}]`),
      text: stringField(entry, 'text', `commands[${i}]`),
    };
  });

  const config: DeckConfig = { projects, commands };

  if (root.keys !== undefined) {
    if (!isRecord(root.keys)) fail('keys must be an object');
    const keys: NonNullable<DeckConfig['keys']> = keySequences(root.keys, 'keys');
    if (root.keys.codex !== undefined) {
      if (!isRecord(root.keys.codex)) fail('keys.codex must be an object');
      keys.codex = keySequences(root.keys.codex, 'keys.codex');
    }
    config.keys = keys;
  }

  if (root.launch !== undefined) {
    if (!isRecord(root.launch)) fail('launch must be an object');
    const launch: DeckConfig['launch'] = {};
    if (root.launch.claudeArgs !== undefined) {
      if (
        !Array.isArray(root.launch.claudeArgs) ||
        !root.launch.claudeArgs.every((a) => typeof a === 'string')
      ) {
        fail('launch.claudeArgs must be an array of strings');
      }
      launch.claudeArgs = root.launch.claudeArgs as string[];
    }
    config.launch = launch;
  }

  return config;
}

/**
 * Watches config.json and keeps the last successfully parsed config available.
 * A missing or invalid file never throws out of start(): the daemon must keep
 * running with whatever config it last had (an empty one at worst).
 */
export class ConfigWatcher extends EventEmitter {
  private readonly filePath: string;
  private readonly reconcileMs: number;
  private config: DeckConfig = EMPTY_CONFIG;
  private serialized = '';
  private watcher: FSWatcher | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private lastProblem: string | null = null;

  constructor(filePath: string, opts?: { reconcileMs?: number }) {
    super();
    this.filePath = filePath;
    this.reconcileMs = opts?.reconcileMs ?? DEFAULT_RECONCILE_MS;
  }

  async start(): Promise<void> {
    await this.load(false);

    const watcher = watch(this.filePath, {
      ignoreInitial: true,
      awaitWriteFinish: AWAIT_WRITE_FINISH,
    });
    this.watcher = watcher;

    await new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
    });

    const reload = (): void => {
      void this.load(true);
    };
    watcher.on('add', reload);
    watcher.on('change', reload);
    watcher.on('error', (err: unknown) => {
      console.error(`[deck-neo] config watcher error: ${String(err)}`);
    });

    this.reconcileTimer = setInterval(reload, this.reconcileMs);
    this.reconcileTimer.unref();
  }

  async stop(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    if (watcher) await watcher.close();
  }

  getConfig(): DeckConfig {
    return this.config;
  }

  /** Logs a problem once; the reconcile timer would otherwise repeat it forever. */
  private report(problem: string): void {
    if (problem === this.lastProblem) return;
    this.lastProblem = problem;
    console.error(`[deck-neo] ${problem}`);
  }

  private async load(emitChange: boolean): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (err) {
      this.report(`cannot read ${this.filePath}: ${(err as Error).message}`);
      return;
    }

    let next: DeckConfig;
    try {
      next = parseConfig(text);
    } catch (err) {
      this.report(`${(err as Error).message} — keeping last good config`);
      return;
    }
    this.lastProblem = null;

    const serialized = JSON.stringify(next);
    if (serialized === this.serialized) return;
    this.serialized = serialized;
    this.config = next;
    if (emitChange) this.emit('change', next);
  }
}
