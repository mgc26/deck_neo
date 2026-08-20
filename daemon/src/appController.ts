// Wires core (state + reducer) to the device renderer and system executors.
// Owns transient UI concerns: current page, error flashes, infobar composition.

import { basename } from 'node:path';
import type {
  AgentKind,
  CockpitState,
  DeckConfig,
  Effect,
  RawInput,
  TmuxSession,
  UiModel,
  UiState,
} from './contracts.js';
import { reduceInput } from './core/app.js';

// The LCD strip fits a few dozen characters; the renderer clamps again, but a
// bounded model keeps huge Notification messages from ever leaving this layer.
const MAX_INFOBAR_CHARS = 160;

/** Cap on code points, not UTF-16 units — a raw slice can bisect an emoji. */
function capChars(text: string, max: number): string {
  const points = [...text];
  return points.length <= max ? text : points.slice(0, max).join('');
}

export interface SystemPorts {
  sendKeys(session: string, keys: string[]): Promise<void>;
  sendText(session: string, text: string): Promise<void>;
  listSessions(): Promise<TmuxSession[]>;
  newSession(name: string, cwd: string, command: string, args?: string[]): Promise<void>;
  focus(project: string, appName?: string, tmuxSession?: string): Promise<boolean>;
}

export interface DevicePort {
  render(model: UiModel): Promise<void>;
}

export interface StorePort {
  getState(): CockpitState;
  select(slot: number): void;
  setPage(page: number): void;
  gcAgainstTmux(liveSessions: TmuxSession[]): void;
  /** Optimistic in-memory override; the next file event overwrites it. */
  markWorking(sessionId: string): void;
}

export interface AppOptions {
  flashMs: number;
  launchCommand: string;
}

const DEFAULTS: AppOptions = { flashMs: 800, launchCommand: 'claude' };

export class AppController {
  private ui: UiState = { page: 'cockpit' };
  private flash?: { key: number };
  private flashMessage?: string;
  private flashTimer?: ReturnType<typeof setTimeout>;
  private readonly opts: AppOptions;

  constructor(
    private readonly store: StorePort,
    private readonly getConfig: () => DeckConfig,
    private readonly device: DevicePort,
    private readonly sys: SystemPorts,
    opts?: Partial<AppOptions>,
  ) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  buildModel(): UiModel {
    const cockpit = this.store.getState();
    return {
      ui: this.ui,
      cockpit,
      config: this.getConfig(),
      infobar: capChars(this.flashMessage ?? this.composeInfobar(cockpit), MAX_INFOBAR_CHARS),
      flash: this.flash,
    };
  }

  async refresh(): Promise<void> {
    await this.device.render(this.buildModel());
  }

  async handleInput(input: RawInput): Promise<void> {
    const pageBefore = this.ui.page;
    const { ui, effects } = reduceInput(this.ui, input, this.store.getState(), this.getConfig());
    this.ui = ui;
    for (const effect of effects) {
      try {
        await this.execute(effect);
      } catch (err) {
        // A runtime failure (dead tmux, launch collision) flashes the pressed key —
        // but only while the page it was pressed on is still showing; after a page
        // transition (picker -> cockpit) that index now belongs to a different key,
        // so the error goes to the infobar alone.
        const key = input.type === 'key' && this.ui.page === pageBefore ? input.index : -1;
        this.setFlash(key, err instanceof Error ? err.message : String(err));
      }
    }
    await this.refresh();
  }

  /** GC slots against live tmux sessions; callers run this on an interval. */
  async gcTick(): Promise<void> {
    this.store.gcAgainstTmux(await this.sys.listSessions());
  }

  stop(): void {
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = undefined;
    this.flash = undefined;
    this.flashMessage = undefined;
  }

  /** Per-kind key sequences: keys.codex overrides fall back to the top level. */
  private sequence(agent: AgentKind, action: 'approve' | 'reject'): string[] {
    const keys = this.getConfig().keys;
    const fallback = action === 'approve' ? ['Enter'] : ['Escape'];
    if (agent === 'codex') return keys?.codex?.[action] ?? keys?.[action] ?? fallback;
    return keys?.[action] ?? fallback;
  }

  /**
   * After the deck hands a session input, flip it blue immediately — no hook
   * fires on the ANSWER itself, so an approved session would otherwise sit
   * amber until its turn ends (codex: until its only, turn-end notify event).
   * The next real event always overwrites the guess.
   *
   * The slot is found by the tmux identity + kind the effect actually
   * ADDRESSED, never by re-reading selectedSlot: selection can change while
   * the send awaits, and a tmux session can host one agent per window whose
   * records share the session name (both QA findings).
   */
  private markSentWorking(sessionId: string): void {
    // By id (unique) so the exact session the press answered goes blue — never a
    // sibling sharing its tmux name, and independent of which page is showing.
    this.store.markWorking(sessionId);
  }

  private async execute(effect: Effect): Promise<void> {
    switch (effect.kind) {
      case 'select':
        this.store.select(effect.slot);
        break;
      case 'focus': {
        const appName = this.getConfig().focus?.appName ?? 'Cursor';
        const found = await this.sys.focus(effect.project, appName, effect.tmux);
        if (!found) this.setFlash(-1, `no ${appName} window for ${effect.project}`);
        break;
      }
      case 'approve':
        await this.sys.sendKeys(effect.tmux, this.sequence(effect.agent, 'approve'));
        this.markSentWorking(effect.sessionId);
        break;
      case 'reject':
        await this.sys.sendKeys(effect.tmux, this.sequence(effect.agent, 'reject'));
        break;
      case 'send-text':
        await this.sys.sendText(effect.tmux, effect.text);
        this.markSentWorking(effect.sessionId);
        break;
      case 'launch': {
        // Session name = basename(path), matching what `cc` uses and what the hook
        // reports as `project` — one name per project everywhere. Same sanitizing as
        // the wrappers: tmux cannot target names containing '.' or ':' with -t.
        const name = basename(effect.project.path).replace(/[.:]/g, '_') || 'session';
        // Pass launch args as a SEPARATE argv array, never string-joined — a
        // joined command string would be shell-interpreted by tmux, turning a
        // hostile config value into RCE. (SystemPorts.newSession keeps them split.)
        const args = this.getConfig().launch?.claudeArgs ?? [];
        await this.sys.newSession(name, effect.project.path, this.opts.launchCommand, args);
        break;
      }
      case 'set-session-page':
        this.store.setPage(effect.page);
        break;
      case 'flash-error':
        this.setFlash(effect.key, effect.message);
        break;
    }
  }

  /** key -1 = infobar message only, no key flash. */
  private setFlash(key: number, message: string): void {
    this.flash = key >= 0 ? { key } : undefined;
    this.flashMessage = message;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flash = undefined;
      this.flashMessage = undefined;
      void this.refresh();
    }, this.opts.flashMs);
  }

  private composeInfobar(cockpit: CockpitState): string {
    const selected =
      cockpit.selectedSlot !== null ? cockpit.sessions[cockpit.selectedSlot] : null;
    // Same identity rule as the key labels: the tmux name is the distinct
    // handle when present (several sessions can share one project). `||`, not
    // `??`: an empty-string tmux name means "absent" everywhere.
    const label = selected ? (selected.file.tmux || selected.file.project) : '';
    // Page indicator, only when there's more than one page to move between.
    const pager = cockpit.pageCount > 1 ? ` ◂ ${cockpit.page + 1}/${cockpit.pageCount} ▸` : '';
    switch (this.ui.page) {
      case 'picker':
        return 'pick a project';
      case 'commands':
        return `commands ▸ ${selected ? label : 'none'}`;
      case 'cockpit': {
        if (!selected) return `no session selected${pager}`;
        const tags: string[] = [];
        if ((selected.file.kind ?? 'claude') === 'codex') tags.push('codex');
        // The ○ on the key gets its explanation exactly when the user interacts.
        if (!selected.file.tmux) tags.push('watch-only');
        // Mutually exclusive with watch-only: detached implies a tmux backing.
        else if (selected.detached) tags.push('detached');
        const middle = tags.length > 0 ? `${tags.join(' ▸ ')} ▸ ` : '';
        return `${label} ▸ ${middle}${selected.file.message || selected.file.state}${pager}`;
      }
    }
  }
}
