// The demo-mode script: synthetic projects cycling through realistic states
// for promo footage. Everything on-camera — names, messages, hold times — is
// a constant here; tweak and re-run `npm run demo`. One loop ≈ 50s.
import type { DeckConfig, RawInput, SessionFile } from '../contracts.js';
import type { AppController, SystemPorts } from '../appController.js';
import type { DemoStore } from './store.js';

export interface DemoContext {
  upsert(file: SessionFile): void;
  end(sessionId: string): void;
  reset(): void;
  input(raw: RawInput): Promise<void>;
  refresh(): Promise<void>;
}

export interface Step {
  /** ms to hold the frame after applying this step. */
  wait: number;
  act(ctx: DemoContext): void | Promise<void>;
}

export const DEMO_CONFIG: DeckConfig = {
  projects: [
    { name: 'api-server', path: '/demo/api-server' },
    { name: 'webapp', path: '/demo/webapp' },
    { name: 'etl-pipeline', path: '/demo/etl-pipeline' },
    { name: 'docs-site', path: '/demo/docs-site' },
  ],
  commands: [
    { label: 'CONTINUE', text: 'continue' },
    { label: '/qa', text: '/qa' },
    { label: 'TESTS', text: 'npm test' },
    { label: 'HANDOFF', text: '/handoff' },
    { label: 'BUILD', text: 'npm run build' },
    { label: 'LINT', text: 'npm run lint' },
    { label: 'REVIEW', text: '/review' },
    { label: 'DEPLOY', text: '/deploy' },
  ],
};

/** Every port resolves successfully; `focus` must return true or the
 *  controller flashes "no Cursor window for X" onto the infobar. */
export const DEMO_SYS: SystemPorts = {
  sendKeys: async () => undefined,
  sendText: async () => undefined,
  listSessions: async () => [],
  newSession: async () => undefined,
  focus: async () => true,
};

/** tmux = project so tiles render fully controllable (no watch-only ○). */
function sess(project: string, state: SessionFile['state'], extra: Partial<SessionFile> = {}): SessionFile {
  return {
    session_id: `demo-${project}`,
    cwd: `/demo/${project}`,
    project,
    state,
    tmux: project,
    ts: Date.now(),
    ...extra,
  };
}

const key = (index: number): RawInput => ({ type: 'key', index });
const touch = (zone: 'left' | 'right'): RawInput => ({ type: 'touch', zone });

export const SCRIPT: Step[] = [
  // Fill: sessions arrive one by one.
  { wait: 1500, act: () => undefined }, // empty cockpit establishes the frame
  { wait: 1800, act: (c) => c.upsert(sess('api-server', 'working')) },
  { wait: 1800, act: (c) => c.upsert(sess('webapp', 'working')) },
  { wait: 1800, act: (c) => c.upsert(sess('etl-pipeline', 'working', { kind: 'codex' })) },
  { wait: 3000, act: (c) => c.upsert(sess('docs-site', 'idle')) },
  // Needs-you beat: amber blink, select it, action row arms, then "approved".
  { wait: 2500, act: (c) => c.upsert(sess('webapp', 'needs-input', { message: 'Permission: Bash(npm test)' })) },
  { wait: 4000, act: (c) => c.input(key(1)) }, // hold: room to film a physical APPROVE press
  { wait: 3000, act: (c) => c.upsert(sess('webapp', 'working')) },
  // Ready beat: done goes green, CONTINUE lights, commands page flips by.
  { wait: 2000, act: (c) => c.upsert(sess('api-server', 'done')) },
  { wait: 3000, act: (c) => c.input(key(0)) },
  { wait: 3500, act: (c) => c.input(touch('right')) }, // one session page -> commands
  { wait: 2000, act: (c) => c.input(touch('left')) },
  { wait: 2500, act: (c) => c.upsert(sess('api-server', 'working')) },
  // Paging beat: a fifth session opens page 2; visit it and come back.
  { wait: 2000, act: (c) => c.upsert(sess('etl-pipeline', 'done', { kind: 'codex' })) },
  { wait: 3000, act: (c) => c.upsert(sess('ml-training', 'working')) },
  { wait: 3000, act: (c) => c.input(touch('right')) }, // -> session page 2
  { wait: 2500, act: (c) => c.input(touch('left')) },
  // Turnover: a session finishes and leaves; the next slides onto page 1.
  { wait: 2000, act: (c) => c.upsert(sess('docs-site', 'done')) },
  { wait: 3000, act: (c) => c.end('demo-docs-site') },
  { wait: 2500, act: (c) => c.upsert(sess('webapp', 'done')) },
];

export function makeDemoContext(
  store: DemoStore,
  app: Pick<AppController, 'handleInput' | 'refresh'>,
): DemoContext {
  return {
    upsert: (file) => store.upsert(file),
    end: (id) => store.end(id),
    reset: () => store.reset(),
    input: (raw) => app.handleInput(raw),
    refresh: () => app.refresh(),
  };
}

/** One full loop: reset, then act -> refresh -> hold, per step. The caller
 *  loops this forever; tests pass a no-op sleep to run it instantly. */
export async function playOnce(ctx: DemoContext, sleep: (ms: number) => Promise<void>): Promise<void> {
  ctx.reset();
  await ctx.refresh();
  for (const step of SCRIPT) {
    await step.act(ctx);
    await ctx.refresh();
    await sleep(step.wait);
  }
}
