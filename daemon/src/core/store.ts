import { EventEmitter } from 'node:events';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type {
  AgentKind,
  CockpitState,
  Session,
  SessionFile,
  SessionStateName,
  TmuxSession,
} from '../contracts.js';

const SLOT_COUNT = 4;
const DEFAULT_STALE_MS = 24 * 60 * 60 * 1000;

// Watch-only sessions (no tmux — plain claude, or a ChatGPT-app thread) have no
// close signal: gcAgainstTmux can't see them and the app never says "thread
// closed", so they'd linger for the full 24h. They only ever get written on
// activity, so a quiet one is almost certainly gone — retire it far sooner.
const DEFAULT_WATCH_ONLY_STALE_MS = 30 * 60 * 1000;

// Ended files linger briefly as tombstones: the hook's "never revive an ended
// session" guard reads them, so a Stop hook racing SessionEnd must still find one.
const DEFAULT_ENDED_RETENTION_MS = 60 * 1000;

// fs.watch drops the occasional event on macOS (measured ~2% of adds), which
// would leave a session key dark until its next hook write. A cheap periodic
// rescan of the (tiny) sessions dir reconciles anything the events missed, and
// also re-applies the stale rule to sessions that age out while the daemon runs.
const DEFAULT_RECONCILE_MS = 2000;

// Small stability window for watcher events. Note the periodic reconcile scan
// reads files directly (no such window) — that path relies on the hook's atomic
// tmp+rename writes, which is also what makes the unlink-on-retire safe.
const AWAIT_WRITE_FINISH = { stabilityThreshold: 20, pollInterval: 10 };

const STATE_NAMES: readonly SessionStateName[] = ['idle', 'working', 'needs-input', 'done', 'ended'];
const AGENT_KINDS: readonly AgentKind[] = ['claude', 'codex'];

type MainPhase = NonNullable<SessionFile['main']>;
const MAIN_PHASES: readonly MainPhase[] = ['running', 'idle'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Returns null for anything that is not a well-formed SessionFile.
 *
 * The optional fields follow one rule: absent is always fine (files written by
 * an older hook simply lack them), but present-and-wrong rejects the whole file
 * rather than being silently dropped — a hook emitting garbage should darken the
 * key, not show a session in a state nobody can trust.
 */
export function parseSessionFile(json: string): SessionFile | null {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(root)) return null;

  const { session_id, cwd, project, state, kind, message, tmux, agents, main, ts } = root;
  if (typeof session_id !== 'string' || session_id === '') return null;
  if (typeof cwd !== 'string' || typeof project !== 'string') return null;
  if (typeof state !== 'string' || !STATE_NAMES.includes(state as SessionStateName)) return null;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  if (kind !== undefined && (typeof kind !== 'string' || !AGENT_KINDS.includes(kind as AgentKind))) {
    return null;
  }
  if (message !== undefined && typeof message !== 'string') return null;
  if (tmux !== undefined && typeof tmux !== 'string') return null;
  if (agents !== undefined && (typeof agents !== 'number' || !Number.isFinite(agents))) return null;
  if (main !== undefined && (typeof main !== 'string' || !MAIN_PHASES.includes(main as MainPhase))) {
    return null;
  }

  const file: SessionFile = { session_id, cwd, project, state: state as SessionStateName, ts };
  if (kind !== undefined) file.kind = kind as AgentKind;
  if (message !== undefined) file.message = message;
  if (tmux !== undefined) file.tmux = tmux;
  if (agents !== undefined) file.agents = agents;
  if (main !== undefined) file.main = main as MainPhase;
  return file;
}

/**
 * Watches ~/.deck-neo/sessions and maps live sessions onto the Neo's four
 * session slots. Slot identity is keyed off the file name (<session_id>.json)
 * so add/change/unlink events stay symmetric.
 */
export class SessionStore extends EventEmitter {
  private readonly dir: string;
  private readonly staleMs: number;
  private readonly watchOnlyStaleMs: number;
  private readonly reconcileMs: number;
  private readonly endedRetentionMs: number;
  private readonly sessions = new Map<string, SessionFile>();
  // Unbounded, arrival-ordered ids. The Neo shows SLOT_COUNT at a time (a page);
  // there is no limit on how many sessions are tracked.
  private readonly order: string[] = [];
  private selectedId: string | null = null;
  // tmux names alive with no attached client, per the last gcAgainstTmux pass.
  // Purely presentational: getState() stamps `detached` from it; nothing here
  // touches session lifetime.
  private detachedTmux = new Set<string>();
  private page = 0;
  private watcher: FSWatcher | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private live = false;
  private batching = false;
  private lastEmitted = '';
  /** Serializes file reads so two events cannot interleave slot assignment. */
  private queue: Promise<void> = Promise.resolve();

  constructor(
    sessionsDir: string,
    opts?: {
      staleMs?: number;
      watchOnlyStaleMs?: number;
      reconcileMs?: number;
      endedRetentionMs?: number;
    },
  ) {
    super();
    this.dir = sessionsDir;
    this.staleMs = opts?.staleMs ?? DEFAULT_STALE_MS;
    this.watchOnlyStaleMs = opts?.watchOnlyStaleMs ?? DEFAULT_WATCH_ONLY_STALE_MS;
    this.reconcileMs = opts?.reconcileMs ?? DEFAULT_RECONCILE_MS;
    this.endedRetentionMs = opts?.endedRetentionMs ?? DEFAULT_ENDED_RETENTION_MS;
  }

  async start(): Promise<void> {
    await mkdir(this.dir, { recursive: true }).catch(() => undefined);

    // Initial scan: state is complete before start() resolves.
    await this.scan();

    const watcher = watch(this.dir, {
      ignoreInitial: true,
      depth: 0,
      awaitWriteFinish: AWAIT_WRITE_FINISH,
    });
    this.watcher = watcher;

    await new Promise<void>((resolve) => {
      watcher.once('ready', () => resolve());
    });

    watcher.on('add', (p: string) => this.enqueue(() => this.ingest(p)));
    watcher.on('change', (p: string) => this.enqueue(() => this.ingest(p)));
    watcher.on('unlink', (p: string) =>
      this.enqueue(async () => {
        if (!p.endsWith('.json')) return;
        this.free(basename(p, '.json'));
      }),
    );
    watcher.on('error', (err: unknown) => {
      console.error(`[deck-neo] session watcher error: ${String(err)}`);
    });

    this.live = true;
    this.lastEmitted = JSON.stringify(this.getState());

    this.reconcileTimer = setInterval(() => this.enqueue(() => this.scan()), this.reconcileMs);
    this.reconcileTimer.unref();
  }

  async stop(): Promise<void> {
    const watcher = this.watcher;
    this.watcher = null;
    this.live = false;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.reconcileTimer = null;
    if (watcher) await watcher.close();
    await this.queue;
  }

  private pageCount(): number {
    return Math.max(1, Math.ceil(this.order.length / SLOT_COUNT));
  }

  /** The ids visible on the current page, padded to SLOT_COUNT with undefined. */
  private pageIds(): (string | undefined)[] {
    const start = this.page * SLOT_COUNT;
    return Array.from({ length: SLOT_COUNT }, (_, i) => this.order[start + i]);
  }

  getState(): CockpitState {
    const ids = this.pageIds();
    const sessions: (Session | null)[] = ids.map((id, slot) => {
      if (id === undefined) return null;
      const file = this.sessions.get(id);
      if (!file) return null;
      const session: Session = { file, slot };
      // `&&`, not `!== undefined`: an empty-string tmux means watch-only, which
      // has no attachment to speak of.
      if (file.tmux && this.detachedTmux.has(file.tmux)) session.detached = true;
      return session;
    });
    const selectedSlot = this.selectedId === null ? -1 : ids.indexOf(this.selectedId);
    return {
      sessions,
      selectedSlot: selectedSlot >= 0 ? selectedSlot : null,
      page: this.page,
      pageCount: this.pageCount(),
    };
  }

  select(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) return;
    const id = this.pageIds()[slot];
    if (id === undefined) return;
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.emitIfChanged();
  }

  /** Jump to a session page; clamped to the valid range. */
  setPage(page: number): void {
    const clamped = Math.max(0, Math.min(page, this.pageCount() - 1));
    if (clamped === this.page) return;
    this.page = clamped;
    this.emitIfChanged();
  }

  /**
   * Optimistically shows a slot as working. Purely in-memory: nothing is written
   * to disk, and the override is overwritten naturally, since ingest() replaces
   * the whole record with whatever the file says.
   *
   * Codex needs it because its only notify event fires when a turn ENDS — after
   * a deck-initiated send the key would otherwise keep showing the previous
   * state for the entire turn, which reads as "the press did nothing".
   *
   * Lifetime caveat: "overwritten naturally" includes the periodic reconcile
   * sweep, which re-reads every file whether or not it changed. So an override
   * survives at most `reconcileMs` (2s by default) unless the agent itself
   * writes a new state — which for codex it does not until the turn ends.
   */
  markWorking(sessionId: string): void {
    const file = this.sessions.get(sessionId);
    if (file === undefined || file.state === 'working') return;
    // Replace rather than mutate: getState() hands out these objects by
    // reference, so an in-place edit would rewrite snapshots already taken.
    this.sessions.set(sessionId, { ...file, state: 'working' });
    this.emitIfChanged();
  }

  gcAgainstTmux(liveSessions: TmuxSession[]): void {
    const live = new Set(liveSessions.map((s) => s.name));
    // Rebuilt whole each pass: a name absent from the live list must also leave
    // the detached set, or a recreated session would stay marked forever.
    this.detachedTmux = new Set(liveSessions.filter((s) => !s.attached).map((s) => s.name));
    for (const [id, file] of this.sessions) {
      // Truthy, not !== undefined: an empty-string tmux name means "absent"
      // (watch-only), and watch-only sessions are not this GC's business.
      if (file.tmux && !live.has(file.tmux)) {
        this.release(id);
        // Retire the file as well, or the next reconcile scan re-adopts the
        // dead session within 2s and the slot never actually frees.
        void unlink(join(this.dir, `${id}.json`)).catch(() => undefined);
      }
    }
    this.emitIfChanged();
  }

  private enqueue(task: () => Promise<void>): void {
    this.queue = this.queue
      .then(task)
      .catch((err: unknown) => console.error(`[deck-neo] session store: ${String(err)}`));
  }

  /**
   * Full reconciliation against the directory: adopts files the watcher missed,
   * re-applies the ended/stale/malformed rules, and drops sessions whose file
   * is gone. Emits at most one 'change' for the whole sweep.
   */
  private async scan(): Promise<void> {
    const entries = await readdir(this.dir).catch(() => [] as string[]);
    const present = entries.filter((n) => n.endsWith('.json')).sort();

    this.batching = true;
    try {
      const presentIds = new Set(present.map((n) => basename(n, '.json')));
      for (const id of [...this.sessions.keys()]) {
        if (!presentIds.has(id)) this.release(id);
      }
      for (const name of present) {
        await this.ingest(join(this.dir, name));
      }
    } finally {
      this.batching = false;
    }
    this.emitIfChanged();
  }

  private async ingest(filePath: string): Promise<void> {
    if (!filePath.endsWith('.json')) return;
    const id = basename(filePath, '.json');

    let file: SessionFile | null = null;
    try {
      file = parseSessionFile(await readFile(filePath, 'utf8'));
    } catch {
      // File vanished between the event and the read: treat as gone.
      file = null;
    }

    // A legitimate hook only ever writes Date.now(); a timestamp meaningfully in
    // the future is a malformed or squatter file trying to pin a slot forever
    // (future ts => negative elapsed => never stale). Treat it as stale so it
    // frees its slot instead of blinding the cockpit to real sessions. A small
    // skew tolerates honest clock differences.
    const now = Date.now();
    const CLOCK_SKEW_MS = 5 * 60 * 1000;
    // Watch-only sessions (no live tmux) age out fast — they have no close signal.
    // But ONLY when they're in a terminal state: a watch-only session that is
    // still 'working' or 'needs-input' writes nothing between turns, so the short
    // window would drop it mid-task (a long autonomous plain-`claude` run). Keep
    // those on the long window; controllable sessions always use the long one.
    const terminal = file != null && (file.state === 'done' || file.state === 'idle');
    const watchOnly = file != null && !file.tmux && terminal;
    const window = watchOnly ? this.watchOnlyStaleMs : this.staleMs;
    const stale =
      file !== null && (file.ts > now + CLOCK_SKEW_MS || now - file.ts >= window);
    if (file === null || file.state === 'ended' || stale) {
      this.free(id);
      // Retire the file too, or every 2s reconcile scan re-reads a graveyard that
      // grows with every Claude session ever run. Ended files get a grace window
      // first: the hook's "never revive an ended session" guard reads this file,
      // and a Stop hook racing SessionEnd would resurrect the session if the
      // tombstone vanished immediately.
      const endedInGrace =
        file !== null && file.state === 'ended' && !stale && Date.now() - file.ts < this.endedRetentionMs;
      if (!endedInGrace) await unlink(filePath).catch(() => undefined);
      return;
    }

    if (!this.order.includes(id)) this.order.push(id); // unbounded; shown a page at a time
    this.sessions.set(id, file);
    this.emitIfChanged();
  }

  /** Drops a session and emits; `release` does the same without emitting. */
  private free(id: string): void {
    if (this.release(id)) this.emitIfChanged();
  }

  private release(id: string): boolean {
    const pos = this.order.indexOf(id);
    const known = this.sessions.delete(id);
    if (pos === -1) return known;
    this.order.splice(pos, 1);
    if (this.selectedId === id) this.selectedId = null;
    // A removed session may have emptied the last page; keep the cursor valid.
    if (this.page > this.pageCount() - 1) this.page = this.pageCount() - 1;
    return true;
  }

  private emitIfChanged(): void {
    if (!this.live || this.batching) return;
    const state = this.getState();
    const serialized = JSON.stringify(state);
    if (serialized === this.lastEmitted) return;
    this.lastEmitted = serialized;
    this.emit('change', state);
  }
}
