import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildAccount,
  claudeCodePresent,
  parseCredentials,
  parseOauthAccount,
  planLabel,
  resumeStep,
  SETUP_STEPS,
  shouldShowSetup,
  whoLabel,
} from '@core/setupWizard';
import { detectSetup } from '../../src/main/setup';

const NOW = 1_800_000_000_000;
const creds = (o: Record<string, unknown>) => JSON.stringify({ claudeAiOauth: o });

describe('shouldShowSetup', () => {
  it('shows on a fresh config', () => expect(shouldShowSetup({})).toBe(true));
  it('hides once this version was completed or skipped', () => expect(shouldShowSetup({ setupVersion: 1 }, 1)).toBe(false));
  it('shows again for a newer wizard version', () => expect(shouldShowSetup({ setupVersion: 1 }, 2)).toBe(true));
  it('leaves people who finished the old welcome screen alone', () => expect(shouldShowSetup({ onboardingDone: true })).toBe(false));
  it('CLAUDE_VIS_SKIP_ONBOARDING skips it', () => expect(shouldShowSetup({}, 1, true)).toBe(false));
});

describe('resumeStep', () => {
  it('clamps to a real step and never resumes on the last one', () => {
    expect(resumeStep(undefined)).toBe(0);
    expect(resumeStep(2)).toBe(2);
    expect(resumeStep(99)).toBe(SETUP_STEPS.length - 2);
    expect(resumeStep(-3)).toBe(0);
    expect(resumeStep(1.7)).toBe(1);
    expect(resumeStep('x')).toBe(0);
  });
});

describe('parseCredentials', () => {
  it('keeps presence, expiry and plan, and nothing else', () => {
    const c = parseCredentials(
      creds({
        accessToken: 'SECRET-A',
        refreshToken: 'SECRET-R',
        expiresAt: NOW + 1000,
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
        scopes: ['x'],
      }),
    );
    expect(c).toEqual({ present: true, hasRefresh: true, expiresAt: NOW + 1000, subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' });
    expect(JSON.stringify(c)).not.toContain('SECRET');
  });
  it('is null for empty, malformed or token-less files', () => {
    expect(parseCredentials(null)).toBeNull();
    expect(parseCredentials('not json')).toBeNull();
    expect(parseCredentials('{}')).toBeNull();
    expect(parseCredentials(creds({ accessToken: '', refreshToken: '' }))).toBeNull();
  });
});

describe('parseOauthAccount', () => {
  it('reads only the display fields', () => {
    const a = parseOauthAccount(
      JSON.stringify({
        oauthAccount: { emailAddress: 'ann@example.test', displayName: 'Ann', organizationName: 'Acme', accountUuid: 'u-1', billingType: 'x' },
        other: 1,
      }),
    );
    expect(a).toEqual({ email: 'ann@example.test', name: 'Ann', org: 'Acme' });
  });
  it('is null when there is no account', () => {
    expect(parseOauthAccount('{}')).toBeNull();
    expect(parseOauthAccount('oops')).toBeNull();
  });
});

describe('planLabel', () => {
  it('names the plans', () => {
    expect(planLabel('max', 'default_claude_max_5x')).toBe('Claude Max 5x');
    expect(planLabel('max', 'default_claude_max_20x')).toBe('Claude Max 20x');
    expect(planLabel('pro')).toBe('Claude Pro');
    expect(planLabel('team')).toBe('Claude Team');
    expect(planLabel('weird')).toBe('Claude Weird');
    expect(planLabel(null)).toBeNull();
  });
});

describe('buildAccount', () => {
  const acct = { email: 'ann@example.test', name: null, org: 'Acme' };
  it('a valid login is ok and shows who it is', () => {
    const a = buildAccount({ present: true, hasRefresh: true, expiresAt: NOW + 5000, subscriptionType: 'pro', rateLimitTier: null }, acct, false, NOW);
    expect(a).toMatchObject({ login: 'ok', plan: 'Claude Pro', email: 'ann@example.test', org: 'Acme' });
  });
  it('an expired pass with a refresh token is renewable', () => {
    expect(buildAccount({ present: true, hasRefresh: true, expiresAt: NOW - 1, subscriptionType: null, rateLimitTier: null }, null, false, NOW).login).toBe(
      'renewable',
    );
  });
  it('an expired pass without one is expired', () => {
    expect(buildAccount({ present: true, hasRefresh: false, expiresAt: NOW - 1, subscriptionType: null, rateLimitTier: null }, null, false, NOW).login).toBe(
      'expired',
    );
  });
  it('no login: api key, or none, and a leftover account file is not shown', () => {
    expect(buildAccount(null, acct, true, NOW)).toMatchObject({ login: 'api-key', email: null });
    expect(buildAccount(null, acct, false, NOW)).toMatchObject({ login: 'none', email: null, org: null });
  });
  it('whoLabel', () => {
    expect(whoLabel({ email: 'ann@example.test', name: null, org: 'Acme' })).toBe('ann@example.test (Acme)');
    expect(whoLabel({ email: null, name: 'Ann', org: null })).toBe('Ann');
    expect(whoLabel({ email: null, name: null, org: 'Acme' })).toBe('Acme');
    expect(whoLabel({ email: null, name: null, org: null })).toBeNull();
  });
});

describe('claudeCodePresent', () => {
  it('needs the folder or the command', () => {
    expect(claudeCodePresent({ homeExists: false, cliFound: false })).toBe(false);
    expect(claudeCodePresent({ homeExists: true, cliFound: false })).toBe(true);
    expect(claudeCodePresent({ homeExists: false, cliFound: true })).toBe(true);
  });
});

describe('detectSetup (temp Claude home)', () => {
  const saved = { ...process.env };
  const dirs: string[] = [];
  afterEach(() => {
    process.env = { ...saved };
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });
  const tmp = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cvis-setup-unit-'));
    dirs.push(d);
    return d;
  };

  it('a missing home and no command: nothing found, nobody signed in', async () => {
    const empty = tmp();
    process.env.CLAUDE_VIS_HOME = path.join(empty, 'nope');
    process.env.CLAUDE_VIS_SETUP_PATH = empty;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    const d = await detectSetup(0);
    expect(d.homeExists).toBe(false);
    expect(d.cli.found).toBe(false);
    expect(d.account.login).toBe('none');
  });

  it('a signed-in home: plan and account shown, no token anywhere in the result', async () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, 'projects'));
    fs.writeFileSync(
      path.join(home, '.credentials.json'),
      creds({
        accessToken: 'TOKEN-ACCESS-123',
        refreshToken: 'TOKEN-REFRESH-456',
        expiresAt: Date.now() + 3600_000,
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_5x',
      }),
    );
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'who@example.com', organizationName: 'Org' } }));
    const bin = tmp();
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? 'claude.cmd' : 'claude'), '');
    process.env.CLAUDE_VIS_HOME = home;
    process.env.CLAUDE_VIS_SETUP_PATH = bin;
    const d = await detectSetup(4);
    expect(d).toMatchObject({ homeExists: true, projectsExists: true, sessionCount: 4 });
    expect(d.cli.found).toBe(true);
    expect(d.account).toMatchObject({ login: 'ok', plan: 'Claude Max 5x', email: 'who@example.com', org: 'Org' });
    expect(JSON.stringify(d)).not.toMatch(/TOKEN-/);
  });

  it('an API key alone is reported as api-key', async () => {
    process.env.CLAUDE_VIS_HOME = path.join(tmp(), 'nope');
    process.env.CLAUDE_VIS_SETUP_PATH = tmp();
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    expect((await detectSetup(0)).account.login).toBe('api-key');
  });
});
