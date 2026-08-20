// Reports exactly which of the seven Claude Code hooks (see docs/INSTALL.md step 1)
// are missing or stale in ~/.claude/settings.json, and prints only the JSON needed to
// fix it — never writes the file itself, since it's shared with other tooling and end
// users customize it (a naive merge could clobber unrelated hooks).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK_SCRIPT = join(REPO, 'hooks', 'report-state.mjs');

// Prefer whatever `node` resolves to on PATH (matches what a user following the docs
// would get from `which node`, including nvm/asdf shims and Homebrew symlinks) and
// only fall back to this process's own binary if PATH lookup fails.
function findNode(): string {
  try {
    return execFileSync('which', ['node'], { encoding: 'utf8' }).trim() || process.execPath;
  } catch {
    return process.execPath;
  }
}
const NODE = findNode();
const SETTINGS_PATH = join(homedir(), '.claude', 'settings.json');

const EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Notification',
  'Stop',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
];

function expectedCommand(event: string): string {
  return `${NODE} ${join(REPO, 'hooks', 'report-state.mjs')} ${event}`;
}

function hookEntry(event: string): unknown {
  return { hooks: [{ type: 'command', command: expectedCommand(event) }] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** True if any hook block under this event already runs report-state.mjs for it. */
function hasReportStateHook(settings: Record<string, unknown>, event: string): boolean {
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return false;
  const blocks = hooks[event];
  if (!Array.isArray(blocks)) return false;
  return blocks.some(
    (block) =>
      isRecord(block) &&
      Array.isArray(block.hooks) &&
      block.hooks.some(
        (h) => isRecord(h) && typeof h.command === 'string' && h.command.includes('report-state.mjs'),
      ),
  );
}

/**
 * True if a wired hook's report-state.mjs path doesn't match this repo's current
 * location (repo moved since the hook was wired). Deliberately ignores which `node`
 * precedes it — a homebrew symlink vs. its resolved Cellar path are equally valid and
 * shouldn't be flagged as stale.
 */
function isStale(settings: Record<string, unknown>, event: string): boolean {
  const hooks = settings.hooks;
  if (!isRecord(hooks)) return false;
  const blocks = hooks[event];
  if (!Array.isArray(blocks)) return false;
  return blocks.some(
    (block) =>
      isRecord(block) &&
      Array.isArray(block.hooks) &&
      block.hooks.some(
        (h) =>
          isRecord(h) &&
          typeof h.command === 'string' &&
          h.command.includes('report-state.mjs') &&
          !h.command.includes(HOOK_SCRIPT),
      ),
  );
}

function main(): void {
  let raw: string;
  try {
    raw = readFileSync(SETTINGS_PATH, 'utf8');
  } catch {
    console.log(`${SETTINGS_PATH} does not exist yet — add this "hooks" key to a new file there:\n`);
    console.log(JSON.stringify({ hooks: Object.fromEntries(EVENTS.map((e) => [e, [hookEntry(e)]])) }, null, 2));
    process.exitCode = 1;
    return;
  }

  let settings: unknown;
  try {
    settings = JSON.parse(raw);
  } catch (err) {
    console.error(`${SETTINGS_PATH} is not valid JSON: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  if (!isRecord(settings)) {
    console.error(`${SETTINGS_PATH}: top level must be an object`);
    process.exitCode = 1;
    return;
  }

  const missing = EVENTS.filter((e) => !hasReportStateHook(settings, e));
  const stale = EVENTS.filter((e) => !missing.includes(e) && isStale(settings, e));

  if (missing.length === 0 && stale.length === 0) {
    console.log(`hooks ✓ (7/7) wired in ${SETTINGS_PATH}`);
    return;
  }

  if (missing.length > 0) {
    console.log(
      `${missing.length}/7 hooks missing from ${SETTINGS_PATH}. Merge this into its "hooks" key ` +
        `(create the key if it isn't there yet — keep your other settings):\n`,
    );
    console.log(JSON.stringify(Object.fromEntries(missing.map((e) => [e, [hookEntry(e)]])), null, 2));
  }

  if (stale.length > 0) {
    if (missing.length > 0) console.log('');
    console.log(
      `${stale.length} hook(s) wired but pointing at a different path than this repo/node ` +
        `resolve to now — replace their "command" under these events:\n`,
    );
    console.log(JSON.stringify(Object.fromEntries(stale.map((e) => [e, [hookEntry(e)]])), null, 2));
  }

  process.exitCode = 1;
}

main();
