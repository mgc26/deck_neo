import { execFile } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { cleanScratch, cxScript, projectDir, readSession, sessionsDirOf, tmpDir } from './helpers.js';

const execFileP = promisify(execFile);
const cxaScript = join(dirname(cxScript), 'cxa');

let home: string;

beforeEach(async () => {
  home = await tmpDir('deckneo-cxahome-');
});

afterAll(cleanScratch);

async function tmuxShim(): Promise<{ dir: string; capture: string }> {
  const dir = await tmpDir('deckneo-cxashim-');
  const capture = join(dir, 'argv.txt');
  await writeFile(
    join(dir, 'tmux'),
    `#!/bin/sh\nprintf '%s\\n' "$@" >> "${capture}"\nif [ "$1" = "has-session" ]; then exit 1; fi\n`,
  );
  await chmod(join(dir, 'tmux'), 0o755);
  return { dir, capture };
}

async function writeIndex(lines: object[]): Promise<void> {
  await mkdir(join(home, '.codex'), { recursive: true });
  await writeFile(
    join(home, '.codex/session_index.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

async function runCxa(args: string[], shimDir: string): Promise<void> {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
  delete env.TMUX;
  env.PATH = `${shimDir}:${dirname(process.execPath)}:${process.env.PATH}`;
  await execFileP('zsh', [cxaScript, ...args], { cwd: await projectDir('anywhere'), env });
}

const argvOf = async (capture: string): Promise<string[]> =>
  (await readFile(capture, 'utf8')).trim().split('\n');

describe('bin/cxa', () => {
  it('passes a zsh syntax check', async () => {
    await expect(execFileP('zsh', ['-n', cxaScript])).resolves.toBeTruthy();
  });

  it('resumes the most recent indexed thread, title + id-hash, resume -- id, exact target', async () => {
    await writeIndex([
      { id: 'old-id', thread_name: 'Old thread', updated_at: '2030-01-01T00:00:00Z' },
      { id: '019f-abc', thread_name: 'Review the draft plan', updated_at: '2030-01-02T00:00:00Z' },
    ]);
    const { dir, capture } = await tmuxShim();
    await runCxa([], dir);

    const name = 'Review-the-draft-pla-019fab'; // title[1,20] + '-' + hex(id)[1,6]
    expect(await argvOf(capture)).toEqual([
      'has-session', '-t', `=${name}`,
      'new-session', '-d', '-s', name, 'codex', 'resume', '--', '019f-abc',
      'attach-session', '-t', `=${name}`,
    ]);
    const f = await readSession(home, `codex-${name}`);
    expect(f).toMatchObject({ kind: 'codex', state: 'idle', tmux: name });
  });

  it('accepts an explicit session id and names the session after it', async () => {
    const { dir, capture } = await tmuxShim();
    await runCxa(['0199-feed-beef'], dir);
    const name = 'gpt-0199-fee-0199fe';
    expect(await argvOf(capture)).toEqual([
      'has-session', '-t', `=${name}`,
      'new-session', '-d', '-s', name, 'codex', 'resume', '--', '0199-feed-beef',
      'attach-session', '-t', `=${name}`,
    ]);
  });

  it('keeps two threads with the same title-prefix on distinct keys (id-hash)', async () => {
    const { dir: d1 } = await tmuxShim();
    await runCxa(['aaaaaaaa-1111-2222-3333-444444444444'], d1);
    const { dir: d2 } = await tmuxShim();
    await runCxa(['bbbbbbbb-1111-2222-3333-444444444444'], d2);
    const files = (await readdir(sessionsDirOf(home))).sort();
    expect(files).toHaveLength(2); // distinct id-hash suffixes, not one merged key
  });

  it('refuses a hostile session id that codex would parse as a flag', async () => {
    const { dir } = await tmuxShim();
    await expect(runCxa(['--config=sandbox_mode="danger-full-access"'], dir)).rejects.toThrow();
    await expect(runCxa(['--last'], dir)).rejects.toThrow();
  });

  it('fails cleanly when there is no index', async () => {
    const { dir } = await tmuxShim();
    await expect(runCxa([], dir)).rejects.toThrow();
  });

  it('ignores a trailing blank line in the index', async () => {
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(
      join(home, '.codex/session_index.jsonl'),
      JSON.stringify({ id: '019f-abc', thread_name: 'Real thread' }) + '\n\n',
    );
    const { dir, capture } = await tmuxShim();
    await runCxa([], dir);
    expect((await argvOf(capture)).join(' ')).toContain('resume -- 019f-abc');
  });
});

describe('bin/cxa nested-tmux guard', () => {
  it('does not create a session when already inside tmux', async () => {
    const { dir, capture } = await tmuxShim();
    // A fake codex on PATH so the exec target exists.
    await writeFile(join(dir, 'codex'), '#!/bin/sh\nprintf codex-resume-in-place\n');
    await chmod(join(dir, 'codex'), 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMUX: '/tmp/t,1,0' };
    env.PATH = `${dir}:${dirname(process.execPath)}:${process.env.PATH}`;
    await execFileP('zsh', [cxaScript, '019f-abcdef'], { cwd: await projectDir('x'), env });
    // No tmux session was created.
    await expect(readFile(capture, 'utf8')).rejects.toThrow();
  });
});

describe('bin/cxa nested-tmux resume args', () => {
  it('resumes with -- and the id as SEPARATE args, not one glued word', async () => {
    const dir = await tmpDir('deckneo-cxaresume-');
    const capture = join(dir, 'codex.argv');
    await writeFile(join(dir, 'codex'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${capture}"\n`);
    await chmod(join(dir, 'codex'), 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, TMUX: '/tmp/t,1,0' };
    env.PATH = `${dir}:${dirname(process.execPath)}:${process.env.PATH}`;
    await execFileP('zsh', [cxaScript, '3f2504e0-4f89-11d3-9a0c-0305e82c3301'], {
      cwd: await projectDir('x'),
      env,
    });
    expect((await readFile(capture, 'utf8')).trim().split('\n')).toEqual([
      'resume', '--', '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    ]);
  });
});
