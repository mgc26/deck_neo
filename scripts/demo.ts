// Demo mode: cycles synthetic sessions on the physical Neo for promo footage.
// The launchd daemon holds the USB claim (KeepAlive), so this boots it out and
// restores it on exit.
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { AppController } from '../daemon/src/appController.js';
import { NeoDevice } from '../daemon/src/device/neo.js';
import { DemoStore } from '../daemon/src/demo/store.js';
import { DEMO_CONFIG, DEMO_SYS, makeDemoContext, playOnce } from '../daemon/src/demo/timeline.js';

const run = promisify(execFile);

const uid = process.getuid?.();
if (uid === undefined) {
  console.error('[demo] needs a macOS user session (no uid)');
  process.exit(1);
}

const LABEL = 'com.deckneo.daemon';
const DOMAIN = `gui/${uid}`;
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLIST = join(ROOT, 'launchd', `${LABEL}.plist`);
const USB_SETTLE_MS = 1500;
const CONNECT_TIMEOUT_MS = 10_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function daemonLoaded(): Promise<boolean> {
  try {
    await run('launchctl', ['print', `${DOMAIN}/${LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

const device = new NeoDevice();
let restoreDaemon = false;
let cleanedUp = false;

async function cleanup(): Promise<void> {
  if (cleanedUp) return;
  cleanedUp = true;
  await device.stop().catch(() => undefined);
  if (restoreDaemon) {
    console.log('[demo] restoring deck-neo daemon');
    await run('launchctl', ['bootstrap', DOMAIN, PLIST]).catch((err) => {
      console.error(`[demo] restore failed — run: launchctl bootstrap ${DOMAIN} ${PLIST}`);
      console.error(err);
    });
  }
}

async function shutdown(code: number): Promise<void> {
  await cleanup();
  process.exit(code);
}

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
// Mid-loop errors log and keep cycling (a stale frame beats a dead demo);
// only a synchronous throw tears down, and it still restores the daemon.
process.on('unhandledRejection', (err) => console.error('[demo] unhandled rejection:', err));
process.on('uncaughtException', (err) => {
  console.error('[demo] uncaught exception:', err);
  void shutdown(1);
});

if (await daemonLoaded()) {
  console.log('[demo] stopping deck-neo daemon (restored on exit)');
  await run('launchctl', ['bootout', `${DOMAIN}/${LABEL}`]).catch(() => undefined);
  restoreDaemon = true;
  await sleep(USB_SETTLE_MS);
}

const store = new DemoStore();
const app = new AppController(store, () => DEMO_CONFIG, device, DEMO_SYS);
const ctx = makeDemoContext(store, app);

const connected = new Promise<void>((resolve) => {
  device.on('status', (status) => {
    console.log(`[demo] device ${status}`);
    if (status === 'connected') resolve();
  });
});
// Physical presses stay live: select/paging act for real, action keys hit the
// no-op system ports — nothing errors, nothing reaches a real tmux.
device.on('input', (raw) => void app.handleInput(raw));

await device.start();
const timedOut = await Promise.race([
  connected.then(() => false),
  sleep(CONNECT_TIMEOUT_MS).then(() => true),
]);
if (timedOut) {
  console.error('[demo] could not claim the Neo — is the Elgato app holding it? See docs/INSTALL.md step 4.');
  await shutdown(1);
}

console.log('[demo] cycling — Ctrl-C to stop and restore the daemon');
for (;;) {
  await playOnce(ctx, sleep);
}
