import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loginStatus, readCredentials, usesApiKey, type ExecFn } from '../../src/main/claudeLogin';
import { refreshIfNeeded, resetRefreshBackoff } from '../../src/main/oauthRefresh';
import { claudeHome } from '../../src/main/paths';

const SECRET_A = 'fake-oat01-SECRET-ACCESS';
const SECRET_R = 'fake-ort01-SECRET-REFRESH';

const creds = (over: Record<string, unknown> = {}) =>
  JSON.stringify({ claudeAiOauth: { accessToken: SECRET_A, refreshToken: SECRET_R, expiresAt: Date.now() + 3600_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'max', ...over } });

describe('claudeHome precedence', () => {
  it('CLAUDE_VIS_HOME beats CLAUDE_CONFIG_DIR beats ~/.claude', () => {
    expect(claudeHome({ CLAUDE_VIS_HOME: '/vis', CLAUDE_CONFIG_DIR: '/cfg' }, '/h')).toBe('/vis');
    expect(claudeHome({ CLAUDE_CONFIG_DIR: '/cfg' }, '/h')).toBe('/cfg');
    expect(claudeHome({ CLAUDE_CONFIG_DIR: '  ' }, '/h')).toBe(path.join('/h', '.claude'));
    expect(claudeHome({}, '/h')).toBe(path.join('/h', '.claude'));
  });
});

describe('login reading', () => {
  let dir: string;
  let file: string;
  const calls: string[][] = [];
  const keychain =
    (out: string | null): ExecFn =>
    async (cmd, args) => {
      calls.push([cmd, ...args]);
      return out;
    };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-login-'));
    file = path.join(dir, '.credentials.json');
    calls.length = 0;
    process.env.CLAUDE_VIS_HOME = dir;
    resetRefreshBackoff();
  });
  afterEach(() => {
    delete process.env.CLAUDE_VIS_HOME;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reads the file on any platform and never asks the keychain when the file exists', async () => {
    fs.writeFileSync(file, creds());
    const c = await readCredentials({ platform: 'darwin', exec: keychain(null), file });
    expect(c?.source).toBe('file');
    expect(calls).toEqual([]);
  });

  it('macOS: parses the keychain item, with the right command and no shell', async () => {
    const c = await readCredentials({ platform: 'darwin', exec: keychain(creds() + '\n'), file });
    expect(c?.source).toBe('keychain');
    expect(calls).toEqual([['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w']]);
  });

  it('macOS: missing, locked or garbled keychain gives no login instead of throwing', async () => {
    expect(await readCredentials({ platform: 'darwin', exec: keychain(null), file })).toBeNull();
    expect(await readCredentials({ platform: 'darwin', exec: keychain('not json'), file })).toBeNull();
    expect(await readCredentials({ platform: 'darwin', exec: keychain('{"other":1}'), file })).toBeNull();
  });

  it('other platforms never touch the keychain', async () => {
    expect(await readCredentials({ platform: 'win32', exec: keychain(creds()), file })).toBeNull();
    expect(await readCredentials({ platform: 'linux', exec: keychain(creds()), file })).toBeNull();
    expect(calls).toEqual([]);
  });

  it('loginStatus summarizes and never contains token values', async () => {
    const exp = Date.now() + 1000;
    const st = await loginStatus({ platform: 'darwin', exec: keychain(creds({ expiresAt: exp })), file });
    expect(st).toEqual({ present: true, source: 'keychain', expiresAt: exp, subscriptionType: 'max', scopesOk: true });
    const dump = JSON.stringify(st);
    expect(dump).not.toContain(SECRET_A);
    expect(dump).not.toContain(SECRET_R);
    expect((await loginStatus({ platform: 'darwin', exec: keychain(creds({ scopes: ['user:inference'] })), file })).scopesOk).toBe(false);
    expect(await loginStatus({ platform: 'win32', file })).toEqual({ present: false, source: null, expiresAt: null, subscriptionType: null, scopesOk: false });
  });

  it('macOS expired login: refresh is read-only (no keychain write, no file written, no network)', async () => {
    const out = await refreshIfNeeded(false, { platform: 'darwin', exec: keychain(creds({ expiresAt: Date.now() - 1000 })), file });
    expect(out).toBe('readonly');
    expect(calls.every((c) => c.includes('find-generic-password'))).toBe(true);
    expect(calls.some((c) => c.includes('add-generic-password') || c.includes('-w') && c.length > 5)).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('macOS valid login is simply fresh', async () => {
    expect(await refreshIfNeeded(false, { platform: 'darwin', exec: keychain(creds()), file })).toBe('fresh');
  });

  it('API-key users are recognized by env or apiKeyHelper', async () => {
    expect(await usesApiKey({ ANTHROPIC_API_KEY: 'x' })).toBe(true);
    expect(await usesApiKey({})).toBe(false);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ apiKeyHelper: 'get-key.sh' }));
    expect(await usesApiKey({})).toBe(true);
  });
});
