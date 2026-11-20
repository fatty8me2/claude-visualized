// scripts/install-mac.sh, run for real with sh against a local feed: real curl, openssl, sed and awk; the macOS-only tools
// (ditto, plutil, pgrep, osascript, xattr, open) are stubbed so it runs on any machine with a POSIX shell.
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SCRIPT = path.resolve(__dirname, '../../scripts/install-mac.sh');
const APP = 'Claude Visualized.app';
const ZIP = 'Claude-Visualized-9.9.9-mac-universal.zip';

const sh = (() => {
  for (const c of ['sh', 'C:\\Program Files\\Git\\usr\\bin\\sh.exe', 'C:\\Program Files\\Git\\bin\\sh.exe']) {
    if (spawnSync(c, ['-c', 'command -v curl && command -v openssl']).status === 0) return c;
  }
  return null;
})();

describe.skipIf(!sh)('install-mac.sh', async () => {
  const body = Buffer.from('pretend this is the universal zip '.repeat(500));
  const good = crypto.createHash('sha512').update(body).digest('base64');
  let sha = good;
  let zipRequests = 0;
  let server: http.Server;
  let feed = '';
  const dirs: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = (req.url ?? '').split('?')[0];
      if (u.endsWith('/latest-mac.yml')) {
        res
          .writeHead(200)
          .end(
            [
              'version: 9.9.9',
              'files:',
              `  - url: ${ZIP}`,
              `    sha512: ${sha}`,
              `    size: ${body.length}`,
              '  - url: Claude-Visualized-9.9.9-mac-universal.dmg',
              `    sha512: ${crypto.createHash('sha512').update('dmg').digest('base64')}`,
              `path: ${ZIP}`,
              `sha512: ${sha}`,
              "releaseDate: '2026-01-01T00:00:00.000Z'",
              '',
            ].join('\n'),
          );
      } else if (u.endsWith(`/${ZIP}`)) {
        zipRequests++;
        res.writeHead(200, { 'content-length': String(body.length) }).end(body);
      } else res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    feed = `http://127.0.0.1:${(server.address() as AddressInfo).port}/rel`;
  });
  afterAll(() => {
    server?.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  /** an Applications folder (optionally holding an installed version), stub tools, and a runner */
  function setup(installed?: string) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-instmac-'));
    dirs.push(root);
    const p = (...s: string[]) => path.join(root, ...s).replace(/\\/g, '/');
    fs.mkdirSync(p('Applications'));
    if (installed) {
      fs.mkdirSync(p('Applications', APP, 'Contents'), { recursive: true });
      fs.writeFileSync(p('Applications', APP, 'Contents', 'v'), installed);
      fs.writeFileSync(p('Applications', APP, 'Contents', 'Info.plist'), '<plist/>');
    }
    fs.mkdirSync(p('bin'));
    const stub = (name: string, text: string) => fs.writeFileSync(p('bin', name), `#!/bin/sh\n${text}\n`);
    // ditto -x -k <zip> <dest> unpacks: the "app" holds the zip's bytes; ditto <src> <dst> copies
    stub('ditto', `if [ "$1" = "-x" ]; then mkdir -p "$4/${APP}/Contents" && cp "$3" "$4/${APP}/Contents/payload"; else cp -R "$1" "$2"; fi`);
    stub('plutil', 'cat "$(dirname "$4")/v" 2>/dev/null');
    stub('pgrep', 'exit 1');
    stub('osascript', 'exit 0');
    stub('xattr', 'exit 0');
    stub('open', `echo "$1" >> "${p('opened')}"`);
    // async: the feed is served from this process, so a blocking spawn would hang curl
    const run = () =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const c = spawn(sh!, [
          '-c',
          `PATH="$(cd "${p('bin')}" && pwd):$PATH" CV_FEED="${feed}" CV_APP_DIR="${p('Applications')}" sh "${SCRIPT.replace(/\\/g, '/')}"`,
        ]);
        let stdout = '';
        let stderr = '';
        c.stdout.on('data', (d) => (stdout += d));
        c.stderr.on('data', (d) => (stderr += d));
        c.on('error', reject);
        c.on('close', (status) => resolve({ status, stdout, stderr }));
      });
    return { p, run };
  }

  it('installs into an empty Applications folder and opens the app', async () => {
    sha = good;
    const { p, run } = setup();
    const r = await run();
    expect(r.stderr).not.toMatch(/install:/); // only curl's progress bar
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/Claude Visualized 9\.9\.9 is installed/);
    expect(fs.readFileSync(p('Applications', APP, 'Contents', 'payload'))).toEqual(body);
    expect(fs.readFileSync(p('opened'), 'utf8').trim()).toBe(p('Applications', APP));
  });

  it('replaces an older version and leaves no leftovers', async () => {
    sha = good;
    const { p, run } = setup('0.12.1');
    const r = await run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/you have 0\.12\.1/);
    expect(fs.existsSync(p('Applications', APP, 'Contents', 'payload'))).toBe(true);
    expect(fs.existsSync(p('Applications', APP, 'Contents', 'v'))).toBe(false);
    expect(fs.readdirSync(p('Applications'))).toEqual([APP]);
  });

  it('a download that does not match its checksum changes nothing', async () => {
    sha = crypto.createHash('sha512').update('something else').digest('base64');
    const { p, run } = setup('0.12.1');
    const r = await run();
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/did not match its checksum/);
    expect(fs.readFileSync(p('Applications', APP, 'Contents', 'v'), 'utf8')).toBe('0.12.1');
    expect(fs.existsSync(p('opened'))).toBe(false);
  });

  it('does nothing when the latest version is already installed', async () => {
    sha = good;
    const before = zipRequests;
    const { p, run } = setup('9.9.9');
    const r = await run();
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/already installed/);
    expect(zipRequests).toBe(before);
    expect(fs.existsSync(p('opened'))).toBe(false);
  });
});
