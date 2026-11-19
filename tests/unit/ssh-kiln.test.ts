// Kiln over SSH: the other computer's Kiln events file is copied with its transcripts (by the same read-only script, through a
// local `sh` or PowerShell standing in for ssh), so a remote session shows the runs it handed to Kiln, runs nobody claims get
// a session of their own, and a rotation of the events file (events.jsonl -> .1) loses nothing.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RemoteShell } from '../../src/core/sshRemote';
import type { SpawnSpec } from '../../src/main/ssh/conn';
import { SshService, sshHostId } from '../../src/main/ssh/service';
import { loadBacklogInProcess } from '../../src/main/watcher';
import { kilnRunLines } from '../fixtures/kiln';

const GIT_BIN = 'C:\\Program Files\\Git\\usr\\bin';
const sh = process.platform === 'win32' ? path.join(GIT_BIN, 'sh.exe') : 'sh';
const hasSh = process.platform === 'win32' ? fs.existsSync(sh) : spawnSync('sh', ['-c', 'true']).status === 0;

const SID = '77777777-7777-4777-8777-777777777777';
const CWD = '/Users/me/app';
const BRIEF = 'Write tests for the retry helper in src/retry.ts.\nVerify with npm test -- retry.';

let remoteHome: string;
let root: string;
let svc: SshService | null = null;

beforeEach(() => {
  remoteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-sshk-r-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-sshk-m-'));
});
afterEach(async () => {
  svc?.stop();
  svc = null;
  await new Promise((r) => setTimeout(r, 400));
  fs.rmSync(remoteHome, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

async function until<T>(fn: () => T | null | undefined | false, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

/** A Claude session on the other computer that handed one task to Kiln a minute ago. */
function writeSession(now: number) {
  const at = (sAgo: number) => new Date(now - sAgo * 1000).toISOString();
  const base = (sAgo: number) => ({ sessionId: SID, cwd: CWD, version: '2.1.300', gitBranch: 'main', timestamp: at(sAgo) });
  const lines = [
    { type: 'user', isSidechain: false, message: { role: 'user', content: 'Hand the tests to the local model.' }, ...base(90) },
    {
      type: 'assistant',
      isSidechain: false,
      message: {
        id: 'm_1',
        model: 'claude-opus-5-5',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_K0', name: 'mcp__kiln__delegate_task', input: { task: BRIEF, cwd: CWD, effort: 'medium' } }],
        stop_reason: null,
        usage: { input_tokens: 3000, output_tokens: 120 },
      },
      ...base(80),
    },
  ];
  const dir = path.join(remoteHome, '.claude', 'projects', '-Users-me-app');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SID}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

function service(spawn: (shell: RemoteShell) => SpawnSpec) {
  svc = new SshService({
    root,
    hosts: [],
    save: () => {},
    spawn: (_h, shell) => spawn(shell),
    mirror: { quickMs: 150, fullMs: 1000, chunk: 900, retryMs: 100 },
    tickMs: 50,
    backlogLoader: loadBacklogInProcess,
  });
  svc.start();
  return svc;
}

function remoteEnv(kilnFile: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: path.join(remoteHome, '.claude'), KILN_EVENTS_PATH: kilnFile };
  delete env.XDG_CONFIG_HOME;
  return env;
}

async function scenario(spawn: (shell: RemoteShell, env: NodeJS.ProcessEnv) => SpawnSpec, slash: (p: string) => string) {
  const now = Date.now();
  const sec = (sAgo: number) => (now - sAgo * 1000) / 1000;
  writeSession(now);
  const kdir = path.join(remoteHome, 'kiln-data');
  fs.mkdirSync(kdir);
  const events = path.join(kdir, 'events.jsonl');
  const run = kilnRunLines({
    id: 'run1',
    task: BRIEF,
    cwd: CWD,
    start: sec(79),
    steps: [
      ['read_file', 'src/retry.ts', true],
      ['write_file', 'tests/retry.test.ts', true],
      ['bash', 'npm test -- retry', true],
    ],
    finish: { ok: true, answer: 'Added five tests; they pass.', files: ['tests/retry.test.ts'], seconds: 40 },
  });
  const orphan = kilnRunLines({
    id: 'orphan1',
    task: 'Summarize what scripts/deploy.sh does.',
    cwd: '/srv/other',
    start: sec(600),
    readonly: true,
    steps: [['read_file', 'scripts/deploy.sh', true]],
    finish: { ok: true, answer: 'It builds and rsyncs dist/.', seconds: 20 },
  });
  // the claimed run's finish is held back and written just before Kiln rotates the file
  const finish = run.pop()!;
  fs.writeFileSync(events, [...orphan, ...run].join('\n') + '\n');

  const env = remoteEnv(slash(events));
  const s = service((shell) => spawn(shell, env));
  s.add('me@my-mac', null, 'Mac');
  const id = sshHostId('me@my-mac');
  const nsId = `remote:${id}:${SID}`;

  // a run no session on the Mac claims: a Kiln session of its own, from that computer
  const orphanRow = await until(() => s.summaries().find((x) => x.id === `remote:${id}:kiln-orphan1`));
  expect(orphanRow).toMatchObject({ source: 'kiln', machine: 'Mac' });

  // the hand-off shows under the agent that made it, still working
  await until(() => s.summaries().find((x) => x.id === nsId));
  s.setSelected(nsId);
  const kiln = await until(() => s.view(nsId)?.agents['kiln-run1']);
  expect(kiln.kiln).toMatchObject({ finished: false, model: 'qwen3:30b' });
  expect(s.summaries().some((x) => x.id === `remote:${id}:kiln-run1`)).toBe(false);

  // Kiln writes the finish, then rotates: the finish is only in events.jsonl.1 on the other side
  fs.appendFileSync(events, finish + '\n');
  fs.renameSync(events, events + '.1');
  const later = kilnRunLines({ id: 'orphan2', task: 'List the TODOs in /srv/other.', cwd: '/srv/other', start: sec(1), readonly: true });
  fs.writeFileSync(events, later.join('\n') + '\n');

  const done = await until(() => s.view(nsId)?.agents['kiln-run1']?.kiln?.finished && s.view(nsId)!.agents['kiln-run1']);
  expect(done.kiln).toMatchObject({ ok: true, answer: 'Added five tests; they pass.', filesChanged: ['tests/retry.test.ts'] });
  await until(() => s.summaries().find((x) => x.id === `remote:${id}:kiln-orphan2`));
  // the local copy mirrors both files byte for byte
  const copy = path.join(root, id, 'kiln', 'events.jsonl');
  await until(() => fs.existsSync(copy) && fs.readFileSync(copy).equals(fs.readFileSync(events)));
  expect(fs.readFileSync(copy + '.1').equals(fs.readFileSync(events + '.1'))).toBe(true);

  // "Show Kiln runs" off: SSH remotes stop showing them too
  s.setKiln(false);
  await until(() => !s.summaries().some((x) => x.id.includes(':kiln-')));
  expect(s.summaries().some((x) => x.id === nsId)).toBe(true);
}

describe.skipIf(!hasSh)('Kiln over SSH (sh)', () => {
  it("copies the Mac's Kiln events with its transcripts, through a rotation", async () => {
    await scenario(
      (_shell, env) => {
        if (process.platform === 'win32') {
          for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
          env.PATH = `${GIT_BIN};${process.env.PATH ?? ''}`;
        }
        return { command: sh, args: [], env };
      },
      (p) => p.replace(/\\/g, '/'),
    );
  }, 60_000);
});

describe.skipIf(process.platform !== 'win32')('Kiln over SSH (PowerShell)', () => {
  it("copies a Windows computer's Kiln events with its transcripts, through a rotation", async () => {
    await scenario(
      (_shell, env) => ({
        command: 'powershell.exe',
        args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
        env,
        shell: 'powershell',
      }),
      (p) => p,
    );
  }, 90_000);
});
