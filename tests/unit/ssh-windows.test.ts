// A Windows remote: its login shell does not know `sh`, so the mirror switches to PowerShell and remembers it.
// The end-to-end part runs the real PowerShell script against a fixture Claude home, on Windows only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listCommand, noPosixShell, REMOTE_SCRIPT_PS, sshArgs, type RemoteShell, type SshHostConfig } from '../../src/core/sshRemote';
import { SshService, sshHostId } from '../../src/main/ssh/service';
import { loadBacklogInProcess } from '../../src/main/watcher';
import { SID, writeFixture } from '../fixtures/build';

describe('windows remote: commands', () => {
  it('asks ssh for powershell reading from stdin', () => {
    const a = sshArgs({ target: 'me@my-pc' }, 'powershell');
    expect(a).toContain('BatchMode=yes');
    expect(a.slice(a.indexOf('me@my-pc') + 1)).toEqual([
      'powershell',
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      '-',
    ]);
  });
  it('recognizes a login shell without sh', () => {
    expect(noPosixShell("'sh' is not recognized as an internal or external command,\r\noperable program or batch file.")).toBe(true);
    expect(noPosixShell("sh : The term 'sh' is not recognized as the name of a cmdlet, function, script file, or operable program.")).toBe(true);
    expect(noPosixShell('me@my-pc: Permission denied (publickey).')).toBe(false);
  });
  it('lists by minutes, and the script is one statement per line and only reads', () => {
    expect(listCommand('powershell', 'full')).toBe('cv_list 20160');
    expect(listCommand('powershell', 'quick')).toBe('cv_list 3');
    expect(listCommand('sh', 'quick')).toBe('cv_list -mmin -3');
    expect(REMOTE_SCRIPT_PS).not.toMatch(/\r/);
    expect(REMOTE_SCRIPT_PS).not.toMatch(
      /Remove-Item|Set-Content|Out-File|Invoke-Expression|Invoke-WebRequest|\biex\b|WriteAll|FileAccess\]::(Write|ReadWrite)/i,
    );
    for (const line of REMOTE_SCRIPT_PS.trim().split('\n')) {
      const open = (line.match(/\{/g) ?? []).length;
      expect(open, line.slice(0, 40)).toBe((line.match(/\}/g) ?? []).length);
    }
  });
});

describe.skipIf(process.platform !== 'win32')('windows remote, end to end over a local PowerShell', () => {
  let remoteHome: string;
  let root: string;
  let svc: SshService | null = null;
  let saved: SshHostConfig[] = [];
  const shells: RemoteShell[] = [];

  beforeEach(() => {
    remoteHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-winr-'));
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-winm-'));
    saved = [];
    shells.length = 0;
  });
  afterEach(async () => {
    svc?.stop();
    svc = null;
    await new Promise((r) => setTimeout(r, 500));
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

  it('falls back from sh to PowerShell, remembers it, and follows the session', async () => {
    const { mainFile } = writeFixture(remoteHome);
    svc = new SshService({
      root,
      hosts: [],
      save: (h) => (saved = h),
      spawn: (_h, shell) => {
        shells.push(shell);
        // what cmd.exe on the other side answers to `ssh host sh`
        if (shell === 'sh')
          return {
            command: process.execPath,
            args: ['-e', `process.stderr.write("'sh' is not recognized as an internal or external command,\\r\\n"); process.exit(1)`],
            shell,
          };
        return {
          command: 'powershell.exe',
          args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', '-'],
          env: { ...process.env, CLAUDE_CONFIG_DIR: remoteHome },
          shell,
        };
      },
      mirror: { quickMs: 200, fullMs: 2000, chunk: 700, retryMs: 100 },
      tickMs: 50,
      backlogLoader: loadBacklogInProcess,
    });
    svc.start();
    const s = svc;
    expect(s.add('me@my-pc', null, 'Other PC')).toEqual({ ok: true });
    const id = sshHostId('me@my-pc');

    const sum = await until(() => s.summaries().find((x) => x.id === `remote:${id}:${SID}`));
    expect(shells.slice(0, 2)).toEqual(['sh', 'powershell']);
    expect(sum.machine).toBe('Other PC');
    expect(saved[0]).toMatchObject({ id, shell: 'powershell' });
    // copied in several chunks through PowerShell's raw stdout, byte for byte
    const copy = path.join(root, id, 'projects', path.relative(path.join(remoteHome, 'projects'), mainFile));
    expect(fs.readFileSync(copy).equals(fs.readFileSync(mainFile))).toBe(true);
    expect(s.status()[0]).toMatchObject({ error: null });

    s.setSelected(sum.id);
    const view = await until(() => s.view(sum.id));
    const before = view.log.length;
    // appended while the reader may have the file open: sharing must allow it
    const line = {
      type: 'user',
      sessionId: SID,
      uuid: 'u-win-1',
      timestamp: new Date().toISOString(),
      message: { role: 'user', content: 'héllo from the other PC ✓' },
    };
    fs.appendFileSync(mainFile, JSON.stringify(line) + '\n');
    await until(() => (s.view(sum.id)?.log.length ?? 0) > before);
    expect(JSON.stringify(s.view(sum.id)!.log)).toContain('héllo from the other PC ✓');
  }, 60_000);
});
