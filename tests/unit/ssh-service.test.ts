// The SSH remote end to end, with a local `sh` standing in for `ssh host sh`: the same script lists and reads a fixture
// "other computer" (a temp Claude home), the mirror copies it, and the service presents it like a paired computer.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isRemoteId } from '../../src/core/remote';
import type { SshHostConfig } from '../../src/core/sshRemote';
import { SshService, sshHostId } from '../../src/main/ssh/service';
import { loadBacklogInProcess } from '../../src/main/watcher';
import { SID, writeFixture } from '../fixtures/build';

const GIT_BIN = 'C:\\Program Files\\Git\\usr\\bin';
const sh = process.platform === 'win32' ? path.join(GIT_BIN, 'sh.exe') : 'sh';
const hasSh = process.platform === 'win32' ? fs.existsSync(sh) : spawnSync('sh', ['-c', 'true']).status === 0;

let remoteHome: string;
let root: string;
let svc: SshService | null = null;
let saved: SshHostConfig[] = [];

beforeEach(() => {
  remoteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-sshr-'));
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-sshm-'));
  saved = [];
});
afterEach(async () => {
  svc?.stop();
  svc = null;
  await new Promise((r) => setTimeout(r, 300));
  fs.rmSync(remoteHome, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

function service(hosts: SshHostConfig[] = []): SshService {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CONFIG_DIR: remoteHome.replace(/\\/g, '/') };
  if (process.platform === 'win32') {
    // Windows env names are case-insensitive: replace the one path variable rather than adding a second
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k];
    env.PATH = `${GIT_BIN};${process.env.PATH ?? ''}`;
  }
  svc = new SshService({
    root,
    hosts,
    save: (h) => (saved = h),
    spawn: () => ({ command: sh, args: [], env }),
    mirror: { quickMs: 100, fullMs: 400, chunk: 700, retryMs: 100 },
    tickMs: 50,
    backlogLoader: loadBacklogInProcess,
  });
  svc.start();
  return svc;
}

async function until<T>(fn: () => T | null | undefined | false, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe.skipIf(!hasSh)('ssh remote, end to end over a local shell', () => {
  it("lists the other computer's sessions, shows a selected one and follows new lines", async () => {
    const { mainFile } = writeFixture(remoteHome);
    const s = service();
    expect(s.add('me@my-mac', null, 'Mac')).toEqual({ ok: true });
    expect(s.add('me@my-mac').ok).toBe(false);
    const id = sshHostId('me@my-mac');
    expect(saved.map((h) => h.id)).toEqual([id]);

    const sum = await until(() => s.summaries().find((x) => x.id === `remote:${id}:${SID}`));
    expect(isRemoteId(sum.id)).toBe(true);
    expect(sum.machine).toBe('Mac');
    expect(sum.file).toBe('');
    expect(sum.offlineSince).toBeNull();
    expect(s.machineOf(sum.id)).toBe('Mac');
    // copied in several chunks, byte for byte
    const copy = path.join(root, id, 'projects', path.relative(path.join(remoteHome, 'projects'), mainFile));
    expect(fs.readFileSync(copy).equals(fs.readFileSync(mainFile))).toBe(true);
    expect(s.status()[0]).toMatchObject({ id, name: 'Mac', error: null });

    s.setSelected(sum.id);
    const view = await until(() => s.view(sum.id));
    expect(view.id).toBe(sum.id);
    expect(view.machine).toBe('Mac');
    const before = view.log.length;

    const line = {
      type: 'user',
      sessionId: SID,
      uuid: 'u-ssh-1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'hello from the other computer' },
    };
    fs.appendFileSync(mainFile, JSON.stringify(line) + '\n');
    await until(() => (s.view(sum.id)?.log.length ?? 0) > before);
    expect(JSON.stringify(s.view(sum.id)!.log)).toContain('hello from the other computer');

    s.setSelected(null);
    expect(s.view(sum.id)).toBeNull();
  }, 40_000);

  it('removing a remote drops its sessions and deletes the local copy', async () => {
    writeFixture(remoteHome);
    const s = service();
    s.add('me@my-mac');
    const id = sshHostId('me@my-mac');
    await until(() => s.summaries().length > 0);
    s.remove(id);
    expect(s.summaries()).toEqual([]);
    expect(saved).toEqual([]);
    await until(() => !fs.existsSync(path.join(root, id)));
  }, 40_000);
});

describe('ssh remote that cannot be reached', () => {
  it('reports why and keeps retrying, with nothing listed', async () => {
    svc = new SshService({
      root,
      hosts: [],
      save: () => {},
      spawn: () => ({ command: process.execPath, args: ['-e', "process.stderr.write('me@my-mac: Permission denied (publickey).\\n'); process.exit(255)"] }),
      mirror: { retryMs: 50 },
      tickMs: 50,
    });
    svc.start();
    svc.add('me@my-mac');
    const st = await until(() => svc!.status().find((h) => h.state === 'offline'));
    expect(st.error).toMatch(/SSH key/);
    expect(st.offlineSince).not.toBeNull();
    expect(svc.summaries()).toEqual([]);
  }, 20_000);
});
