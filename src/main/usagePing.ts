import { PING_MODELS, pingBody, unifiedHeaders } from '@core/usagePing';
import { parsePingUsage, type PingUsage } from '@core/pingStats';
import { AUTH_DEAD_MESSAGE, loginForRequest, retryAfterMs } from './usageApi';
import { testOverride } from './paths';

/**
 * The usage ping: POST a one-token request to Anthropic's Messages API with the user's own Claude Code login and read the unified
 * rate-limit headers off the reply (core/usagePing.ts has the request and the parsing). The token goes only to api.anthropic.com and is
 * never logged; every error here carries a status or a fixed sentence, never a header, body or token.
 */
const PING_URL = 'https://api.anthropic.com/v1/messages';
/** test hook: a fake server (ignored in an installed build, see paths.ts) */
const pingUrl = () => testOverride('CLAUDE_VIS_PING_URL') ?? PING_URL;

export type PingResult =
  | { ok: true; headers: Record<string, string>; usage: PingUsage | null; model: string }
  | {
      ok: false;
      state: 'no-login' | 'expired' | 'error';
      message: string;
      rateLimited?: boolean;
      retryAfterMs?: number;
      /** unified headers that came with a 429 (a limit really hit) */
      headers?: Record<string, string>;
      /** no Haiku model id was accepted: the ping cannot work, fall back to the usage API */
      unavailable?: boolean;
    };

/** token counts from the reply body (numbers only; nothing else of the body is kept) */
async function readUsage(res: Response): Promise<PingUsage | null> {
  try {
    return parsePingUsage(((await res.json()) as { usage?: unknown })?.usage);
  } catch {
    return null;
  }
}

/** index of the Haiku id that worked last (or the first to try) */
let modelIdx = 0;

export async function fetchPing(retried = false): Promise<PingResult> {
  const lg = await loginForRequest(retried);
  if (!lg.ok) return lg;
  try {
    for (; modelIdx < PING_MODELS.length; modelIdx++) {
      const res = await fetch(pingUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${lg.token}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
          'content-type': 'application/json',
        },
        body: pingBody(PING_MODELS[modelIdx]),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 404) continue; // this Haiku id does not exist: try the next Haiku id
      const headers = unifiedHeaders((n) => res.headers.get(n));
      if (res.status === 401 || res.status === 403) {
        if (!retried) return fetchPing(true);
        return { ok: false, state: 'expired', message: AUTH_DEAD_MESSAGE(lg.renewal) };
      }
      if (res.status === 429) {
        return { ok: false, state: 'error', rateLimited: true, message: 'Claude is rate limiting; will retry.', retryAfterMs: retryAfterMs(res.headers.get('retry-after')), headers };
      }
      if (!res.ok) return { ok: false, state: 'error', message: `Usage ping answered ${res.status}.` };
      return { ok: true, headers, usage: await readUsage(res), model: PING_MODELS[modelIdx] };
    }
    modelIdx = 0;
    return { ok: false, state: 'error', unavailable: true, message: 'No Haiku model was accepted for the usage ping.' };
  } catch (e) {
    return { ok: false, state: 'error', message: `Usage ping unreachable: ${(e as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}` };
  }
}
