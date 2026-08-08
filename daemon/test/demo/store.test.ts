import { describe, expect, it } from 'vitest';
import { DemoStore } from '../../src/demo/store.js';
import { sessionFile } from '../core/helpers.js';

function filled(store: DemoStore, ids: string[]): void {
  for (const id of ids) store.upsert(sessionFile({ session_id: id, tmux: id }));
}

describe('DemoStore', () => {
  it('maps sessions onto slots in arrival order', () => {
    const store = new DemoStore();
    filled(store, ['a', 'b']);
    const state = store.getState();
    expect(state.sessions.map((s) => s?.file.session_id)).toEqual(['a', 'b', undefined, undefined]);
    expect(state.page).toBe(0);
    expect(state.pageCount).toBe(1);
    expect(state.selectedSlot).toBeNull();
  });

  it('upsert with an existing id updates in place without reordering', () => {
    const store = new DemoStore();
    filled(store, ['a', 'b']);
    store.upsert(sessionFile({ session_id: 'a', tmux: 'a', state: 'done' }));
    const state = store.getState();
    expect(state.sessions[0]?.file.state).toBe('done');
    expect(state.sessions[1]?.file.session_id).toBe('b');
  });

  it('a fifth session opens a second page; setPage shows it at slot 0', () => {
    const store = new DemoStore();
    filled(store, ['a', 'b', 'c', 'd', 'e']);
    expect(store.getState().pageCount).toBe(2);
    store.setPage(1);
    const state = store.getState();
    expect(state.page).toBe(1);
    expect(state.sessions[0]?.file.session_id).toBe('e');
    expect(state.sessions[1]).toBeNull();
  });

  it('setPage clamps to the valid range', () => {
    const store = new DemoStore();
    filled(store, ['a']);
    store.setPage(5);
    expect(store.getState().page).toBe(0);
    store.setPage(-1);
    expect(store.getState().page).toBe(0);
  });

  it('selection is by id and survives page flips', () => {
    const store = new DemoStore();
    filled(store, ['a', 'b', 'c', 'd', 'e']);
    store.setPage(1);
    store.select(0); // selects 'e'
    expect(store.getState().selectedSlot).toBe(0);
    store.setPage(0);
    expect(store.getState().selectedSlot).toBeNull(); // 'e' not on this page
    store.setPage(1);
    expect(store.getState().selectedSlot).toBe(0);
  });

  it('select on an empty slot or out-of-range index is a no-op', () => {
    const store = new DemoStore();
    filled(store, ['a']);
    store.select(2);
    store.select(-1);
    store.select(4);
    expect(store.getState().selectedSlot).toBeNull();
  });

  it('end removes the session, shifts order, and clears its selection', () => {
    const store = new DemoStore();
    filled(store, ['a', 'b', 'c']);
    store.select(1); // 'b'
    store.end('b');
    const state = store.getState();
    expect(state.sessions.map((s) => s?.file.session_id)).toEqual(['a', 'c', undefined, undefined]);
    expect(state.selectedSlot).toBeNull();
  });

  it('page clamps when the last page empties', () => {
    const store = new DemoStore();
    filled(store, ['a', 'b', 'c', 'd', 'e']);
    store.setPage(1);
    store.end('e');
    const state = store.getState();
    expect(state.pageCount).toBe(1);
    expect(state.page).toBe(0);
    expect(state.sessions[0]?.file.session_id).toBe('a');
  });

  it('reset clears sessions, selection, and page', () => {
    const store = new DemoStore();
    filled(store, ['a', 'b', 'c', 'd', 'e']);
    store.setPage(1);
    store.select(0);
    store.reset();
    const state = store.getState();
    expect(state.sessions).toEqual([null, null, null, null]);
    expect(state.selectedSlot).toBeNull();
    expect(state.page).toBe(0);
    expect(state.pageCount).toBe(1);
  });

  it('gcAgainstTmux and markWorking are no-ops', () => {
    const store = new DemoStore();
    filled(store, ['a']);
    store.gcAgainstTmux([]); // real store would GC 'a' (its tmux is not live)
    store.markWorking('a');
    const state = store.getState();
    expect(state.sessions[0]?.file.session_id).toBe('a');
    expect(state.sessions[0]?.file.state).toBe('idle');
  });
});
