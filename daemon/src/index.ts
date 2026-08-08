// Deck Neo daemon entry point: wires the session store, config, Neo device,
// and system executors together. Run with `npm start`.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { AppController } from './appController.js';
import { ConfigWatcher } from './core/config.js';
import { SessionStore } from './core/store.js';
import { NeoDevice } from './device/neo.js';
import { focusCursorWindow } from './system/focus.js';
import {
  tmuxListSessions,
  tmuxNewSession,
  tmuxSendKeys,
  tmuxSendText,
} from './system/tmux.js';

const GC_INTERVAL_MS = 10_000;

// The daemon runs unsupervised; a bug in a render or watcher path must be
// loggable, never fatal. Deliberate trade-off: after an uncaught synchronous
// throw we keep running with whatever state we have — a dark or stale key beats
// silently dropping the USB claim (the Elgato app would grab the Neo and a
// restart would need the claim-order dance in INSTALL.md).
process.on('unhandledRejection', (err) => console.error('[deck-neo] unhandled rejection:', err));
process.on('uncaughtException', (err) => console.error('[deck-neo] uncaught exception:', err));

const baseDir = join(homedir(), '.deck-neo');
const sessionsDir = join(baseDir, 'sessions');
const configPath = join(baseDir, 'config.json');
mkdirSync(sessionsDir, { recursive: true });

const store = new SessionStore(sessionsDir);
const config = new ConfigWatcher(configPath);
const device = new NeoDevice();

const app = new AppController(store, () => config.getConfig(), device, {
  sendKeys: tmuxSendKeys,
  sendText: tmuxSendText,
  listSessions: tmuxListSessions,
  newSession: tmuxNewSession,
  focus: focusCursorWindow,
});

store.on('change', () => void app.refresh());
config.on('change', () => void app.refresh());
device.on('input', (raw) => {
  console.log(`[deck-neo] input ${JSON.stringify(raw)}`);
  void app.handleInput(raw);
});
device.on('status', (status) => {
  console.log(`[deck-neo] device ${status}`);
  if (status === 'connected') void app.refresh();
});

const gcTimer = setInterval(() => void app.gcTick().catch(() => undefined), GC_INTERVAL_MS);

async function shutdown(signal: string): Promise<void> {
  console.log(`[deck-neo] ${signal}, shutting down`);
  clearInterval(gcTimer);
  app.stop();
  await Promise.allSettled([device.stop(), store.stop(), config.stop()]);
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await config.start();
await store.start();
await device.start();
await app.refresh();
console.log(`[deck-neo] running — sessions: ${sessionsDir}, config: ${configPath}`);
