import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyRefresh, CLAUDE_CODE_CLIENT_ID, needsRefresh, refreshRequestBody } from '@core/oauth';
import { lastRefreshProblem, refreshIfNeeded, resetRefreshBackoff } from '../../src/main/oauthRefresh';

const NOW = 1_800_000_000_000;

describe('oauth renewal (pure)', () => {
  it('renews only when a refresh token exists and the access token is near expiry', () => {
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3600_000 }, NOW)).toBe(false);
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 60_000 }, NOW)).toBe(true);
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW - 1 }, NOW)).toBe(true);
    expect(needsRefresh({ accessToken: 'a', expiresAt: NOW - 1 }, NOW)).toBe(false);
    expect(needsRefresh({ accessToken: 'a', refreshToken: 'r', expiresAt: NOW + 3600_000 }, NOW, true)).toBe(true);
  });

  it('builds the same request the CLI sends', () => {
    expect(refreshRequestBody({ refreshToken: 'r1', scopes: ['user:inference', 'user:profile'] })).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'r1',
      client_id: CLAUDE_CODE_CLIENT_ID,
      scope: 'user:inference user:profile',
    });
  });

  it('folds the response in and keeps everything else', () => {
    const creds = { other: 1, claudeAiOauth: { accessToken: 'old', refreshToken: 'r1', expiresAt: 1, scopes: ['a'], subscriptionType: 'max' } };
    const next = applyRefresh(creds, { access_token: 'new', refresh_token: 'r2', expires_in: 28800, scope: 'a b' }, NOW);
    expect(next).toEqual({
      other: 1,
      claudeAiOauth: { accessToken: 'new', refreshToken: 'r2', expiresAt: NOW + 28800_000, scopes: ['a', 'b'], subscriptionType: 'max' },
    });
    // no rotated refresh token in the response: keep the old one
    expect(applyRefresh(creds, { access_token: 'n2', expires_in: 10 }, NOW).claudeAiOauth.refreshToken).toBe('r1');
    expect(() => applyRefresh(creds, {}, NOW)).toThrow();
  });
});

describe('oauth renewal against a fake token server', () => {
  let home: string;
  let server: http.Server;
  let reply: { status: number; body: unknown };
  let seen: Record<string, unknown>[];

  beforeEach(async () => {
    resetRefreshBackoff();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-oauth-'));
    process.env.CLAUDE_VIS_HOME = home;
    seen = [];
    reply = { status: 200, body: { access_token: 'fresh-access', refresh_token: 'fresh-refresh', expires_in: 28800 } };
    server = http.createServer((req, res) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        seen.push(JSON.parse(b));
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    process.env.CLAUDE_VIS_OAUTH_TOKEN_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/oauth/token`;
  });
  afterEach(() => {
    server.close();
    delete process.env.CLAUDE_VIS_HOME;
    delete process.env.CLAUDE_VIS_OAUTH_TOKEN_URL;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const credFile = () => path.join(home, '.credentials.json');
  const write = (o: unknown) => fs.writeFileSync(credFile(), JSON.stringify(o));
  const read = () => JSON.parse(fs.readFileSync(credFile(), 'utf8'));

  it('renews an expired login and writes it back, keeping other fields', async () => {
    write({ keep: true, claudeAiOauth: { accessToken: 'stale', refreshToken: 'r1', expiresAt: Date.now() - 1000, scopes: ['user:inference'], subscriptionType: 'max' } });
    expect(await refreshIfNeeded()).toBe('refreshed');
    const c = read();
    expect(c.keep).toBe(true);
    expect(c.claudeAiOauth).toMatchObject({ accessToken: 'fresh-access', refreshToken: 'fresh-refresh', subscriptionType: 'max' });
    expect(c.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 7 * 3600_000);
    expect(seen[0]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1', client_id: CLAUDE_CODE_CLIENT_ID, scope: 'user:inference' });
    expect(fs.existsSync(`${credFile()}.claude-visualized.lock`)).toBe(false);
  });

  it('leaves a fresh login alone', async () => {
    write({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000 } });
    expect(await refreshIfNeeded()).toBe('fresh');
    expect(seen).toHaveLength(0);
  });

  it('reports a dead refresh token without touching the file', async () => {
    const before = { claudeAiOauth: { accessToken: 'a', refreshToken: 'dead', expiresAt: Date.now() - 1 } };
    write(before);
    reply = { status: 400, body: { error: 'invalid_grant' } };
    expect(await refreshIfNeeded()).toBe('dead');
    expect(read()).toEqual(before);
  });

  it('records why a renewal failed and backs off instead of retrying immediately', async () => {
    write({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - 1 } });
    reply = { status: 429, body: { error: { type: 'rate_limit_error' } } };
    expect(await refreshIfNeeded()).toBe('failed');
    expect(lastRefreshProblem).toBe('token server answered 429 (rate_limit_error)');
    reply = { status: 200, body: { access_token: 'x', expires_in: 100 } };
    expect(await refreshIfNeeded()).toBe('failed'); // still backing off
    expect(seen).toHaveLength(1);
  });

  it('backs off while another renewal holds the lock', async () => {
    write({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() - 1 } });
    fs.writeFileSync(`${credFile()}.claude-visualized.lock`, '');
    expect(await refreshIfNeeded()).toBe('busy');
    expect(seen).toHaveLength(0);
  });
});
