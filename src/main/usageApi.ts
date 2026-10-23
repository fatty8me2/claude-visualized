import { readCredentials, usesApiKey } from './claudeLogin';
import { lastRefreshProblem, refreshIfNeeded } from './oauthRefresh';
import { testOverride } from './paths';

/**
 * Reads 5-hour / weekly plan usage the same way Claude Code's /usage does: with the OAuth login
 * Claude Code saved locally, against Anthropic's usage endpoint. The token is only ever sent to
 * api.anthropic.com and is never logged. When it is (nearly) expired the app renews it the way the
 * CLI does (oauthRefresh.ts, owner decision); only a dead refresh token needs `claude /login`.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
/** test hook: a fake usage server (the access token is still only ever sent to the URL configured here) */
const usageUrl = () => testOverride('CLAUDE_VIS_USAGE_URL') ?? USAGE_URL;

export type UsageApiResult =
  { ok: true; body: Record<string, unknown> } | { ok: false; state: 'no-login' | 'expired' | 'error'; message: string; rateLimited?: boolean; retryAfterMs?: number };

interface Login {
  token: string;
  expiresAt: number | null;
}

async function readLogin(): Promise<Login | null> {
  const c = await readCredentials();
  const o = c?.json.claudeAiOauth;
  if (o && typeof o.accessToken === 'string' && o.accessToken) return { token: o.accessToken, expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null };
  return null;
}

const MAC_EXPIRED = 'The Claude Code login has expired. Open Claude Code (run `claude`) once; it renews the login and this app picks it up on the next check.';
const API_KEY_ONLY =
  'Claude Code is using an API key here, not a Claude subscription login, so there are no plan usage meters. Run `claude /login` to sign in with a subscription if you have one.';

const DEAD_LOGIN = 'Claude Code is signed out on this computer. Run `claude /login` in a terminal once; after that the app keeps the login fresh by itself.';

export type LoginResult = { ok: true; token: string; renewal: Awaited<ReturnType<typeof refreshIfNeeded>> } | { ok: false; state: 'no-login' | 'expired' | 'error'; message: string };

/** A usable access token (renewed first when it is about to expire), or why there is none. Shared by the usage read and the ping. */
export async function loginForRequest(retried = false): Promise<LoginResult> {
  const renewal = await refreshIfNeeded(retried);
  if (renewal === 'dead') return { ok: false, state: 'expired', message: DEAD_LOGIN };
  const login = await readLogin();
  if (!login) {
    if (await usesApiKey()) return { ok: false, state: 'no-login', message: API_KEY_ONLY };
    return { ok: false, state: 'no-login', message: 'No Claude Code login found. Run `claude` once and sign in (claude /login).' };
  }
  if (login.expiresAt && login.expiresAt < Date.now()) {
    if (renewal === 'readonly') return { ok: false, state: 'expired', message: MAC_EXPIRED };
    const transient = renewal === 'failed' || renewal === 'busy';
    return {
      ok: false,
      state: transient ? 'error' : 'expired',
      message: transient ? `Could not renew the Claude Code login just now${lastRefreshProblem ? ` (${lastRefreshProblem})` : ''}; will retry.` : DEAD_LOGIN,
    };
  }
  return { ok: true, token: login.token, renewal };
}

/** Retry-After (seconds or an HTTP date) in ms, or undefined when absent or zero (the real endpoints often answer `0`, which says nothing). */
export function retryAfterMs(h: string | null): number | undefined {
  const secs = h === null ? NaN : /^\d+(\.\d+)?$/.test(h.trim()) ? Number(h) : (Date.parse(h) - Date.now()) / 1000;
  return Number.isFinite(secs) && secs > 0 ? Math.min(secs, 3600) * 1000 : undefined;
}

export const AUTH_DEAD_MESSAGE = (renewal: string) => (renewal === 'readonly' ? MAC_EXPIRED : DEAD_LOGIN);

export async function fetchUsage(retried = false): Promise<UsageApiResult> {
  const lg = await loginForRequest(retried);
  if (!lg.ok) return lg;
  const login = { token: lg.token };
  const renewal = lg.renewal;
  try {
    const res = await fetch(usageUrl(), {
      headers: { Authorization: `Bearer ${login.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) {
      // the pass may have been revoked early: renew once and try again
      if (!retried) return fetchUsage(true);
      return { ok: false, state: 'expired', message: renewal === 'readonly' ? MAC_EXPIRED : DEAD_LOGIN };
    }
    if (res.status === 429) {
      // Retry-After is seconds (or an HTTP date). The real endpoint often answers `0`, which says nothing; the scheduler then backs off by itself.
      return {
        ok: false,
        state: 'error',
        rateLimited: true,
        message: 'Usage API is rate limiting; will retry.',
        retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
      };
    }
    if (!res.ok) return { ok: false, state: 'error', message: `Usage API answered ${res.status}.` };
    const body = (await res.json()) as Record<string, unknown>;
    return { ok: true, body };
  } catch (e) {
    return { ok: false, state: 'error', message: `Usage API unreachable: ${(e as Error).message}` };
  }
}
