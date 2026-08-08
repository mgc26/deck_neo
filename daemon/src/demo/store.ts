// Scripted StorePort for demo mode (`npm run demo`): in-memory synthetic
// sessions with SessionStore's paging/selection semantics but none of its
// lifecycle rules — no files, no watchers, no staleness, no tmux GC. The
// timeline mutates it via upsert/end/reset; nothing in the daemon imports it.
import type { CockpitState, Session, SessionFile, TmuxSession } from '../contracts.js';
import type { StorePort } from '../appController.js';

const SLOT_COUNT = 4;

export class DemoStore implements StorePort {
  private readonly sessions = new Map<string, SessionFile>();
  private readonly order: string[] = [];
  private selectedId: string | null = null;
  private page = 0;

  private pageCount(): number {
    return Math.max(1, Math.ceil(this.order.length / SLOT_COUNT));
  }

  private pageIds(): (string | undefined)[] {
    const start = this.page * SLOT_COUNT;
    return Array.from({ length: SLOT_COUNT }, (_, i) => this.order[start + i]);
  }

  getState(): CockpitState {
    // Clamp here rather than in end(): any shrink path then heals the page.
    this.page = Math.min(this.page, this.pageCount() - 1);
    const ids = this.pageIds();
    const sessions: (Session | null)[] = ids.map((id, slot) => {
      if (id === undefined) return null;
      const file = this.sessions.get(id);
      return file ? { file, slot } : null;
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
    if (id !== undefined) this.selectedId = id;
  }

  setPage(page: number): void {
    this.page = Math.max(0, Math.min(page, this.pageCount() - 1));
  }

  /** Demo sessions have no live tmux behind them; never GC. */
  gcAgainstTmux(_live: TmuxSession[]): void {}

  /** States are timeline-scripted; the optimistic flip stays off. */
  markWorking(_sessionId: string): void {}

  upsert(file: SessionFile): void {
    if (!this.sessions.has(file.session_id)) this.order.push(file.session_id);
    this.sessions.set(file.session_id, file);
  }

  end(sessionId: string): void {
    this.sessions.delete(sessionId);
    const i = this.order.indexOf(sessionId);
    if (i >= 0) this.order.splice(i, 1);
    if (this.selectedId === sessionId) this.selectedId = null;
  }

  reset(): void {
    this.sessions.clear();
    this.order.length = 0;
    this.selectedId = null;
    this.page = 0;
  }
}
