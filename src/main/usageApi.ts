import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { lastRefreshProblem, refreshIfNeeded } from './oauthRefresh';
import { claudeHome } from './paths';

/**
 * Reads 5-hour / weekly plan usage the same way Claude Code's /usage does: with the OAuth login
 * Claude Code saved locally, against Anthropic's usage endpoint. The token is only ever sent to
 * api.anthropic.com and is never logged. When it is (nearly) expired the app renews it the way the
 * CLI does (oauthRefresh.ts, owner decision); only a dead refresh token needs `claude /login`.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export type UsageApiResult =
  { ok: true; body: Record<string, unknown> } | { ok: false; state: 'no-login' | 'expired' | 'error'; message: string; retryAfterMs?: number };

interface Login {
  token: string;
  expiresAt: number | null;
}

function fromJson(raw: string): Login | null {
  try {
    const j = JSON.parse(raw);
    const o = j?.claudeAiOauth;
    if (o && typeof o.accessToken === 'string' && o.accessToken)
      return { token: o.accessToken, expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null };
  } catch {
    /* not JSON */
  }
  return null;
}

async function readLogin(): Promise<Login | null> {
  try {
    const l = fromJson(await fs.readFile(path.join(claudeHome(), '.credentials.json'), 'utf8'));
    if (l) return l;
  } catch {
    /* no file */
  }
  // macOS keeps Claude Code's login in the login keychain
  if (process.platform === 'darwin') {
    const raw = await new Promise<string | null>((resolve) =>
      execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (err, out) => resolve(err ? null : out.trim())),
    );
    if (raw) return fromJson(raw);
  }
  return null;
}

const DEAD_LOGIN = 'Claude Code is signed out on this computer. Run `claude /login` in a terminal once; after that the app keeps the login fresh by itself.';

export async function fetchUsage(retried = false): Promise<UsageApiResult> {
  const renewal = await refreshIfNeeded(retried);
  if (renewal === 'dead') return { ok: false, state: 'expired', message: DEAD_LOGIN };
  const login = await readLogin();
  if (!login) return { ok: false, state: 'no-login', message: 'No Claude Code login found. Run `claude` once and sign in (claude /login).' };
  if (login.expiresAt && login.expiresAt < Date.now()) {
    const transient = renewal === 'failed' || renewal === 'busy';
    return {
      ok: false,
      state: transient ? 'error' : 'expired',
      message: transient ? `Could not renew the Claude Code login just now${lastRefreshProblem ? ` (${lastRefreshProblem})` : ''}; will retry.` : DEAD_LOGIN,
    };
  }
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${login.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      // the pass may have been revoked early: renew once and try again
      if (!retried) return fetchUsage(true);
      return { ok: false, state: 'expired', message: DEAD_LOGIN };
    }
    if (res.status === 429) {
      const ra = Number(res.headers.get('retry-after'));
      return {
        ok: false,
        state: 'error',
        message: 'Usage API is rate limiting; will retry.',
        retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : 10 * 60_000,
      };
    }
    if (!res.ok) return { ok: false, state: 'error', message: `Usage API answered ${res.status}.` };
    const body = (await res.json()) as Record<string, unknown>;
    return { ok: true, body };
  } catch (e) {
    return { ok: false, state: 'error', message: `Usage API unreachable: ${(e as Error).message}` };
  }
}
