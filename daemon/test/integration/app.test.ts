// Integration: real SessionStore + real reducer through AppController,
// with a fake device and fake system ports. No hardware, no tmux server.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppController, type SystemPorts } from '../../src/appController.js';
import type { DeckConfig, SessionFile, TmuxSession, UiModel } from '../../src/contracts.js';
import { SessionStore } from '../../src/core/store.js';

const config: DeckConfig = {
  projects: [{ name: 'demo', path: '/tmp/demo' }],
  commands: [{ label: 'CONT', text: 'continue' }],
};

function sessionFile(over: Partial<SessionFile>): SessionFile {
  return {
    session_id: 'sess-1',
    cwd: '/tmp/api',
    project: 'api',
    state: 'working',
    ts: Date.now(),
    ...over,
  };
}

class FakeDevice {
  models: UiModel[] = [];
  async render(model: UiModel): Promise<void> {
    this.models.push(structuredClone(model));
  }
  get last(): UiModel {
    if (this.models.length === 0) throw new Error('nothing rendered');
    return this.models[this.models.length - 1];
  }
}

function fakeSys(): SystemPorts & { calls: Array<Array<string | string[]>>; tmuxLive: TmuxSession[] } {
  const calls: Array<Array<string | string[]>> = [];
  const sys = {
    calls,
    tmuxLive: [] as TmuxSession[],
    async sendKeys(session: string, keys: string[]) { calls.push(['sendKeys', session, ...keys]); },
    async sendText(session: string, text: string) { calls.push(['sendText', session, text]); },
    async listSessions() { calls.push(['listSessions']); return sys.tmuxLive; },
    async newSession(name: string, cwd: string, command: string, args?: string[]) {
      calls.push(args && args.length ? ['newSession', name, cwd, command, args] : ['newSession', name, cwd, command]);
    },
    async focus(project: string) { calls.push(['focus', project]); return true; },
  };
  return sys;
}

describe('AppController integration', () => {
  let dir: string;
  let store: SessionStore;
  let device: FakeDevice;
  let sys: ReturnType<typeof fakeSys>;
  let app: AppController;

  async function write(file: SessionFile): Promise<void> {
    await writeFile(join(dir, `${file.session_id}.json`), JSON.stringify(file));
  }

  async function until(pred: () => boolean, ms = 3000): Promise<void> {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > ms) throw new Error('condition never became true');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'deckneo-int-'));
    store = new SessionStore(dir);
    device = new FakeDevice();
    sys = fakeSys();
    app = new AppController(store, () => config, device, sys, { flashMs: 50 });
    store.on('change', () => void app.refresh());
    await store.start();
  });

  afterEach(async () => {
    app.stop();
    await store.stop();
    await rm(dir, { recursive: true, force: true });
  });

  it('renders a working session, then amber needs-input on Notification', async () => {
    await write(sessionFile({ tmux: 'api' }));
    await until(() => device.models.some((m) => m.cockpit.sessions[0]?.file.state === 'working'));

    await write(sessionFile({ tmux: 'api', state: 'needs-input', message: 'permission: Bash(npm test)' }));
    await until(() => device.last.cockpit.sessions[0]?.file.state === 'needs-input');
    expect(device.last.cockpit.sessions[0]?.file.message).toBe('permission: Bash(npm test)');
  });

  it('select then approve sends the default approve keys to that tmux session', async () => {
    await write(sessionFile({ tmux: 'api', state: 'needs-input' }));
    await until(() => store.getState().sessions[0] !== null);

    await app.handleInput({ type: 'key', index: 0 });          // select + focus
    expect(sys.calls).toContainEqual(['focus', 'api']);
    expect(device.last.infobar).toContain('api');

    await app.handleInput({ type: 'key', index: 4 });          // approve
    expect(sys.calls).toContainEqual(['sendKeys', 'api', 'Enter']);
  });

  it('approve with nothing selected flashes key 4 and recovers', async () => {
    await app.handleInput({ type: 'key', index: 4 });
    expect(device.last.flash).toEqual({ key: 4 });
    await until(() => device.last.flash === undefined);
    expect(device.last.infobar).toBe('no session selected');
  });

  it('commands page sends command text and returns to cockpit', async () => {
    await write(sessionFile({ tmux: 'api', state: 'done' }));
    await until(() => store.getState().sessions[0] !== null);
    await app.handleInput({ type: 'key', index: 0 });

    await app.handleInput({ type: 'touch', zone: 'right' });   // commands page
    expect(device.last.ui.page).toBe('commands');
    await app.handleInput({ type: 'key', index: 0 });          // commands[0]
    expect(sys.calls).toContainEqual(['sendText', 'api', 'continue']);
    expect(device.last.ui.page).toBe('cockpit');
  });

  it('picker launches a configured project detached', async () => {
    await app.handleInput({ type: 'key', index: 7 });          // open picker
    expect(device.last.ui.page).toBe('picker');
    await app.handleInput({ type: 'key', index: 0 });          // pick projects[0]
    expect(sys.calls).toContainEqual(['newSession', 'demo', '/tmp/demo', 'claude']);
    expect(device.last.ui.page).toBe('cockpit');
  });

  it('launch names the tmux session after the path basename, not the config label', async () => {
    const labeled: DeckConfig = {
      ...config,
      projects: [{ name: 'My API', path: '/tmp/backend-api' }],
    };
    const app2 = new AppController(store, () => labeled, device, sys, { flashMs: 50 });
    await app2.handleInput({ type: 'key', index: 7 });
    await app2.handleInput({ type: 'key', index: 0 });
    expect(sys.calls).toContainEqual(['newSession', 'backend-api', '/tmp/backend-api', 'claude']);
    app2.stop();
  });

  it('a failing launch reports on the infobar without flashing a cockpit key', async () => {
    sys.newSession = async () => { throw new Error('duplicate session: demo'); };
    await app.handleInput({ type: 'key', index: 7 });          // picker
    await app.handleInput({ type: 'key', index: 0 });          // pick -> page flips to cockpit
    expect(device.last.ui.page).toBe('cockpit');
    expect(device.last.flash).toBeUndefined();                 // key 0 is a session key now
    expect(device.last.infobar).toContain('duplicate session');
  });

  it('a failing tmux call flashes the pressed key', async () => {
    await write(sessionFile({ tmux: 'gone', state: 'needs-input' }));
    await until(() => store.getState().sessions[0] !== null);
    await app.handleInput({ type: 'key', index: 0 });
    sys.sendKeys = async () => { throw new Error("can't find session: gone"); };
    await app.handleInput({ type: 'key', index: 4 });
    expect(device.last.flash).toEqual({ key: 4 });
    expect(device.last.infobar).toContain('gone');
  });

  it('codex approve uses keys.codex and optimistically marks the session working', async () => {
    const codexConfig: DeckConfig = {
      ...config,
      keys: { approve: ['Enter'], codex: { approve: ['y', 'Enter'] } },
    };
    const app2 = new AppController(store, () => codexConfig, device, sys, { flashMs: 50 });
    store.on('change', () => void app2.refresh());
    await write(sessionFile({ tmux: 'cx1', state: 'done', kind: 'codex' }));
    await until(() => store.getState().sessions[0] !== null);

    await app2.handleInput({ type: 'key', index: 0 });          // select
    await app2.handleInput({ type: 'key', index: 4 });          // approve
    expect(sys.calls).toContainEqual(['sendKeys', 'cx1', 'y', 'Enter']);
    expect(store.getState().sessions[0]?.file.state).toBe('working'); // optimistic
    app2.stop();
  });

  it('selected codex session is tagged on the infobar with its tmux identity', async () => {
    await write(sessionFile({ tmux: 'cx1', state: 'done', kind: 'codex' }));
    await until(() => store.getState().sessions[0] !== null);
    await app.handleInput({ type: 'key', index: 0 });
    expect(device.last.infobar).toBe('cx1 ▸ codex ▸ done');
  });

  it('gcTick frees slots whose tmux died', async () => {
    await write(sessionFile({ tmux: 'api' }));
    await until(() => store.getState().sessions[0] !== null);
    await app.gcTick();                                        // listSessions -> []
    expect(store.getState().sessions[0]).toBeNull();
  });

  it('gcTick marks a live-but-unattached tmux session detached; the infobar explains it', async () => {
    await write(sessionFile({ tmux: 'api', state: 'done' }));
    await until(() => store.getState().sessions[0] !== null);

    sys.tmuxLive = [{ name: 'api', attached: false }];
    await app.gcTick();
    expect(store.getState().sessions[0]?.detached).toBe(true);

    await app.handleInput({ type: 'key', index: 0 });          // select
    expect(device.last.infobar).toBe('api ▸ detached ▸ done');

    sys.tmuxLive = [{ name: 'api', attached: true }];          // reattached
    await app.gcTick();
    expect(store.getState().sessions[0]?.detached).toBeUndefined();
  });
});

async function waitSlot(store: SessionStore, slot: number, id: string): Promise<void> {
  const t0 = Date.now();
  while (store.getState().sessions[slot]?.file.session_id !== id) {
    if (Date.now() - t0 > 3000) throw new Error(`slot ${slot} never became ${id}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('QA round: optimistic working targets the addressed session', () => {
  it('marks the codex session the send addressed, not whatever is selected afterwards', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deckneo-int-race-'));
    const store = new SessionStore(dir);
    const device = new FakeDevice();
    const calls: string[][] = [];
    const sys: SystemPorts = {
      async sendKeys(session, keys) {
        calls.push(['sendKeys', session, ...keys]);
        store.select(1); // selection changes while the send is in flight
      },
      async sendText() {},
      async listSessions() { return []; },
      async newSession() {},
      async focus() { return true; },
    };
    const app = new AppController(store, () => config, device, sys, { flashMs: 50 });
    await store.start();
    // Sequential writes: slot order follows event arrival, so make it deterministic.
    await writeFile(join(dir, 'cx.json'), JSON.stringify(sessionFile({ session_id: 'cx', tmux: 'cx1', state: 'needs-input', kind: 'codex' })));
    await waitSlot(store, 0, 'cx');
    await writeFile(join(dir, 'other.json'), JSON.stringify(sessionFile({ session_id: 'other', cwd: '/tmp/o', project: 'o', tmux: 'o1', state: 'done', kind: 'codex' })));
    await waitSlot(store, 1, 'other');

    await app.handleInput({ type: 'key', index: 0 });   // select cx (slot 0)
    await app.handleInput({ type: 'key', index: 4 });   // approve -> sys flips selection mid-send

    expect(calls).toContainEqual(['sendKeys', 'cx1', 'Enter']);
    expect(store.getState().sessions[0]?.file.state).toBe('working'); // the addressed one
    expect(store.getState().sessions[1]?.file.state).toBe('done');    // untouched
    app.stop();
    await store.stop();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('QA final round: shared tmux session across agent kinds', () => {
  it('marks the codex record, not the claude one sharing the same tmux name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deckneo-int-shared-'));
    const store = new SessionStore(dir);
    const device = new FakeDevice();
    const sys = {
      async sendKeys() {},
      async sendText() {},
      async listSessions() { return []; },
      async newSession() {},
      async focus() { return true; },
    } satisfies SystemPorts;
    const app = new AppController(store, () => config, device, sys, { flashMs: 50 });
    await store.start();
    // One tmux session 'work', two windows: claude in slot 0, codex in slot 1.
    // Sequential writes: slot order follows event arrival, so make it deterministic.
    await writeFile(join(dir, 'cl.json'), JSON.stringify(sessionFile({ session_id: 'cl', tmux: 'work', state: 'done', kind: 'claude' })));
    await waitSlot(store, 0, 'cl');
    await writeFile(join(dir, 'cx.json'), JSON.stringify(sessionFile({ session_id: 'cx', cwd: '/tmp/o', project: 'o', tmux: 'work', state: 'needs-input', kind: 'codex' })));
    await waitSlot(store, 1, 'cx');

    await app.handleInput({ type: 'key', index: 1 });   // select the codex one
    await app.handleInput({ type: 'key', index: 4 });   // approve

    expect(store.getState().sessions[1]?.file.state).toBe('working'); // codex marked
    expect(store.getState().sessions[0]?.file.state).toBe('done');    // claude untouched
    app.stop();
    await store.stop();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('launch standing args', () => {
  it('appends config launch.claudeArgs to the + NEW command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deckneo-int-launch-'));
    const store = new SessionStore(dir);
    const device = new FakeDevice();
    const sys = fakeSys();
    const cfg: DeckConfig = {
      ...config,
      launch: { claudeArgs: ['--dangerously-skip-permissions'] },
    };
    const app = new AppController(store, () => cfg, device, sys, { flashMs: 50 });
    await store.start();
    await app.handleInput({ type: 'key', index: 7 });
    await app.handleInput({ type: 'key', index: 0 });
    expect(sys.calls).toContainEqual([
      'newSession', 'demo', '/tmp/demo', 'claude', ['--dangerously-skip-permissions'],
    ]);
    app.stop();
    await store.stop();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('deck-answered prompts flip blue immediately (all kinds)', () => {
  it('claude approve marks the addressed session working until hooks correct it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deckneo-int-clapprove-'));
    const store = new SessionStore(dir);
    const device = new FakeDevice();
    const sys = fakeSys();
    const app = new AppController(store, () => config, device, sys, { flashMs: 50 });
    await store.start();
    await writeFile(join(dir, 'cl.json'), JSON.stringify(sessionFile({ session_id: 'cl', tmux: 'api', state: 'needs-input', kind: 'claude' })));
    await waitSlot(store, 0, 'cl');

    await app.handleInput({ type: 'key', index: 0 });
    await app.handleInput({ type: 'key', index: 4 }); // approve
    expect(sys.calls).toContainEqual(['sendKeys', 'api', 'Enter']);
    expect(store.getState().sessions[0]?.file.state).toBe('working'); // no longer amber

    app.stop();
    await store.stop();
    await rm(dir, { recursive: true, force: true });
  });
});

describe('security: launch args cannot reach a shell (F2)', () => {
  it('passes launch.claudeArgs as a separate argv array, never joined', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deckneo-int-f2-'));
    const store = new SessionStore(dir);
    const device = new FakeDevice();
    const calls: unknown[][] = [];
    const sys: SystemPorts = {
      async sendKeys() {}, async sendText() {}, async listSessions() { return []; },
      async newSession(...a) { calls.push(a); },
      async focus() { return true; },
    };
    const hostile = '--dangerously-skip-permissions; touch /tmp/PWNED';
    const cfg: DeckConfig = { ...config, launch: { claudeArgs: [hostile] } };
    const app = new AppController(store, () => cfg, device, sys, { flashMs: 50 });
    await store.start();
    await app.handleInput({ type: 'key', index: 7 });
    await app.handleInput({ type: 'key', index: 0 });
    // 4th arg is the args ARRAY containing the hostile string as one element —
    // not concatenated into the command string (3rd arg).
    expect(calls[0]).toEqual(['demo', '/tmp/demo', 'claude', [hostile]]);
    app.stop(); await store.stop(); await rm(dir, { recursive: true, force: true });
  });
});

describe('paging: select and act on a session on page 2', () => {
  it('pages to a session, selects and approves it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'deckneo-int-page-'));
    const store = new SessionStore(dir);
    const device = new FakeDevice();
    const sys = fakeSys();
    const app = new AppController(store, () => config, device, sys, { flashMs: 50 });
    store.on('change', () => void app.refresh());
    await store.start();
    for (let i = 1; i <= 6; i++) {
      await writeFile(join(dir, `s${i}.json`), JSON.stringify(sessionFile({ session_id: `s${i}`, project: `p${i}`, tmux: `t${i}`, state: 'needs-input' })));
      await new Promise((r) => setTimeout(r, 40));
    }
    const t0 = Date.now();
    while (store.getState().pageCount < 2) {
      if (Date.now() - t0 > 3000) throw new Error('second page never appeared');
      await new Promise((r) => setTimeout(r, 20));
    }

    await app.handleInput({ type: 'touch', zone: 'right' }); // -> session page 1
    expect(device.last.cockpit.page).toBe(1);
    await app.handleInput({ type: 'key', index: 0 });   // select s5 (page 1, slot 0)
    await app.handleInput({ type: 'key', index: 4 });   // approve
    expect(sys.calls).toContainEqual(['sendKeys', 't5', 'Enter']);

    app.stop();
    await store.stop();
    await rm(dir, { recursive: true, force: true });
  });
});
