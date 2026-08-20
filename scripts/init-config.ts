// Interactively builds ~/.deck-neo/config.json (see docs/INSTALL.md step 2). Safe to
// run again later: it's the only writer of this file (unlike ~/.claude/settings.json,
// which is shared and left to check-hooks.ts to merely inspect), so re-running just
// backs up whatever's there and starts fresh.
import { chmodSync, copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseConfig } from '../daemon/src/core/config.js';
import type { CommandRef, DeckConfig, ProjectRef } from '../daemon/src/contracts.js';

const CONFIG_DIR = join(homedir(), '.deck-neo');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const DEFAULT_COMMANDS: CommandRef[] = [
  { label: 'CONTINUE', text: 'continue' },
  { label: '/qa', text: '/qa' },
  { label: 'TESTS', text: 'run the tests' },
  { label: 'HANDOFF', text: '/handoff' },
];

const rl = createInterface({ input: process.stdin, output: process.stdout });
async function ask(prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
}

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

async function askProjects(): Promise<ProjectRef[]> {
  console.log('\nProjects — the launcher picker shows the first 4. Blank name to stop.');
  const projects: ProjectRef[] = [];
  for (;;) {
    const name = await ask(`  project ${projects.length + 1} name: `);
    if (!name) break;
    let path = '';
    while (!path) {
      const raw = await ask(`  project ${projects.length + 1} path: `);
      if (!raw) {
        console.log('  path is required.');
        continue;
      }
      path = resolve(expandHome(raw));
    }
    projects.push({ name, path });
  }
  return projects;
}

async function askCommands(): Promise<CommandRef[]> {
  console.log('\nCommands — commands[0] is also the cockpit CONTINUE key.');
  const useDefaults = await ask('  use the starter set (CONTINUE, /qa, TESTS, HANDOFF)? [Y/n]: ');
  const commands: CommandRef[] = useDefaults.toLowerCase() === 'n' ? [] : [...DEFAULT_COMMANDS];
  console.log('  add more commands, blank label to stop.');
  for (;;) {
    const label = await ask(`  command ${commands.length + 1} label: `);
    if (!label) break;
    const text = await ask(`  command ${commands.length + 1} text: `);
    if (!text) {
      console.log('  text is required, skipping.');
      continue;
    }
    commands.push({ label, text });
  }
  return commands;
}

async function askFocusAppName(): Promise<string | undefined> {
  const answer = await ask('\nApp to focus on session-key press [Cursor]: ');
  if (!answer || answer.toLowerCase() === 'cursor') return undefined;
  return answer;
}

async function askClaudeArgs(): Promise<string[] | undefined> {
  const answer = await ask('Standing Claude CLI args for +NEW launches, comma-separated (blank = none): ');
  if (!answer) return undefined;
  return answer.split(',').map((a) => a.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  if (existsSync(CONFIG_PATH)) {
    const overwrite = await ask(`${CONFIG_PATH} already exists. Back it up and start fresh? [y/N]: `);
    if (overwrite.toLowerCase() !== 'y') {
      console.log('Left the existing file untouched.');
      rl.close();
      return;
    }
    copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
    console.log(`Backed up to ${CONFIG_PATH}.bak`);
  }

  const projects = await askProjects();
  const commands = await askCommands();
  const appName = await askFocusAppName();
  const claudeArgs = await askClaudeArgs();
  rl.close();

  const config: DeckConfig = { projects, commands };
  if (appName) config.focus = { appName };
  if (claudeArgs) config.launch = { claudeArgs };

  try {
    parseConfig(JSON.stringify(config));
  } catch (err) {
    console.error(`\nNot writing anything — generated config failed validation: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  chmodSync(CONFIG_PATH, 0o600);

  console.log(`\nWrote ${CONFIG_PATH} (mode 600 — it's a control plane, see docs/INSTALL.md).`);
  console.log('The daemon reloads this file automatically when it changes.');
}

main();
