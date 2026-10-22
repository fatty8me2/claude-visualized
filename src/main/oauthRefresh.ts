import fs from 'node:fs/promises';
import path from 'node:path';
import { applyRefresh, isDeadRefresh, needsRefresh, oauthOf, refreshRequestBody, TOKEN_URL } from '@core/oauth';
import { readCredentials, type LoginDeps } from './claudeLogin';
import { claudeHome } from './paths';

/**
 * Keeps Claude Code's saved login fresh so the usage meters keep working when only the desktop app
 * is in use (its separate login never renews the CLI's). Owner decision: the app may renew it.
 *
 * Safety: tokens are never logged; the file is re-read under a lock right before writing, and if
 * the CLI renewed it meanwhile its copy wins; writes are atomic (temp file + rename) and keep every
 * other field. A dead refresh token is reported, never "fixed" by clearing anything.
 */

/** why the last renewal failed (status / error code only, never token material), for the UI and diagnosis */
export let lastRefreshProblem: string | null = null;

export type RefreshOutcome = 'fresh' | 'refreshed' | 'dead' | 'failed' | 'no-login' | 'busy' | 'readonly';
// 'readonly': the login lives in the macOS keychain; writing it back would put the secret in argv, so only Claude Code renews it

interface Store {
  read(): Promise<string | null>;
  write(raw: string): Promise<void>;
  lockPath: string;
}

function fileStore(): Store {
  const file = path.join(claudeHome(), '.credentials.json');
  return {
    lockPath: `${file}.claude-visualized.lock`,
    async read() {
      try {
        return await fs.readFile(file, 'utf8');
      } catch {
        return null;
      }
    },
    async write(raw) {
      const tmp = `${file}.claude-visualized.tmp`;
      await fs.writeFile(tmp, raw, { encoding: 'utf8', mode: 0o600 });
      await fs.rename(tmp, file);
    },
  };
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T | 'busy'> {
  let fh: fs.FileHandle | null = null;
  try {
    fh = await fs.open(lockPath, 'wx');
  } catch {
    // a lock older than a minute is from a crashed run
    try {
      const st = await fs.stat(lockPath);
      if (Date.now() - st.mtimeMs < 60_000) return 'busy';
      await fs.rm(lockPath, { force: true });
      fh = await fs.open(lockPath, 'wx');
    } catch {
      return 'busy';
    }
  }
  try {
    return await fn();
  } finally {
    await fh.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

function tokenUrl(): string {
  return process.env.CLAUDE_VIS_OAUTH_TOKEN_URL || TOKEN_URL;
}

/** Renew the saved login if it is (nearly) expired, or always when `force` (the usage API rejected it). */
/** after a failed renewal, wait before hammering the token server again: 2, 4, 8 … up to 30 minutes */
let failures = 0;
let retryAfter = 0;

export async function refreshIfNeeded(force = false, deps: LoginDeps = {}): Promise<RefreshOutcome> {
  if (Date.now() < retryAfter) return 'failed';
  const out = await refreshOnce(force, deps);
  if (out === 'failed') {
    failures++;
    retryAfter = Date.now() + Math.min(30, 2 ** failures) * 60_000;
  } else if (out !== 'busy') {
    failures = 0;
    retryAfter = 0;
  }
  return out;
}

/** test helper: forget the backoff */
export function resetRefreshBackoff() {
  failures = 0;
  retryAfter = 0;
}

async function refreshOnce(force: boolean, deps: LoginDeps): Promise<RefreshOutcome> {
  const store = fileStore();
  const found = await readCredentials(deps);
  if (!found) return 'no-login';
  const first = found.raw;
  let creds: Record<string, any>;
  try {
    creds = JSON.parse(first);
  } catch {
    return 'failed';
  }
  if (!needsRefresh(oauthOf(creds), Date.now(), force)) return oauthOf(creds)?.refreshToken ? 'fresh' : oauthOf(creds) ? 'dead' : 'no-login';
  if (found.source === 'keychain') return 'readonly';

  const result = await withLock(store.lockPath, async (): Promise<RefreshOutcome> => {
    // the CLI may have renewed while we waited
    const before = await store.read();
    if (before === null) return 'no-login';
    const cur = JSON.parse(before);
    if (!needsRefresh(oauthOf(cur), Date.now(), force && before === first)) return 'fresh';

    let res: Response;
    try {
      res = await fetch(tokenUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(refreshRequestBody(oauthOf(cur)!)),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      lastRefreshProblem = `token server unreachable: ${(e as Error).message}`;
      return 'failed';
    }
    let body: Record<string, any> | null = null;
    try {
      body = (await res.json()) as Record<string, any>;
    } catch {
      body = null;
    }
    if (!res.ok) {
      lastRefreshProblem = `token server answered ${res.status}${body?.error ? ` (${typeof body.error === 'string' ? body.error : (body.error.type ?? 'error')})` : ''}`;
      return isDeadRefresh(res.status, body) ? 'dead' : 'failed';
    }
    lastRefreshProblem = null;

    const next = applyRefresh(cur, body ?? {}, Date.now());
    // last check: if the CLI wrote in the meantime, keep its copy
    const latest = await store.read();
    if (latest !== before) return 'fresh';
    await store.write(JSON.stringify(next));
    return 'refreshed';
  });
  return result;
}
