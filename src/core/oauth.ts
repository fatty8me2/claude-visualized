// Renewing Claude Code's saved OAuth login, the same way the `claude` CLI does
// (read from its own refresh routine: JSON POST to the token URL with grant_type=refresh_token,
// its public client id and the saved scopes). Pure helpers; the file/keychain I/O is in main/oauthRefresh.ts.

type Json = Record<string, any>;

export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
/** renew a little before expiry so a reading never fails on a just-expired token */
export const REFRESH_MARGIN_MS = 5 * 60_000;

export interface SavedOauth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  [k: string]: unknown;
}

export function oauthOf(creds: Json | null | undefined): SavedOauth | null {
  const o = creds?.claudeAiOauth;
  return o && typeof o === 'object' ? (o as SavedOauth) : null;
}

/** Due for renewal: we hold a refresh token and the access token is missing, expired or about to be. */
export function needsRefresh(o: SavedOauth | null, now: number, force = false): boolean {
  if (!o || typeof o.refreshToken !== 'string' || !o.refreshToken) return false;
  if (force || !o.accessToken) return true;
  return typeof o.expiresAt === 'number' && o.expiresAt - now < REFRESH_MARGIN_MS;
}

export function refreshRequestBody(o: SavedOauth): Json {
  const body: Json = { grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: CLAUDE_CODE_CLIENT_ID };
  if (Array.isArray(o.scopes) && o.scopes.length) body.scope = o.scopes.join(' ');
  return body;
}

/**
 * The saved credentials with a token response folded in. Everything else in the file (other keys,
 * subscription info) is kept; a response without a new refresh token keeps the old one, as the CLI does.
 */
export function applyRefresh(creds: Json, resp: Json, now: number): Json {
  const old = oauthOf(creds) ?? {};
  if (typeof resp?.access_token !== 'string' || !resp.access_token) throw new Error('token response has no access_token');
  const next: SavedOauth = { ...old, accessToken: resp.access_token };
  if (typeof resp.refresh_token === 'string' && resp.refresh_token) next.refreshToken = resp.refresh_token;
  if (typeof resp.expires_in === 'number') next.expiresAt = now + resp.expires_in * 1000;
  if (typeof resp.refresh_token_expires_in === 'number') next.refreshTokenExpiresAt = now + resp.refresh_token_expires_in * 1000;
  if (typeof resp.scope === 'string' && resp.scope.trim()) next.scopes = resp.scope.trim().split(/\s+/);
  return { ...creds, claudeAiOauth: next };
}

/** invalid_grant / 400-401: the refresh token itself is dead; only a new `claude /login` helps. */
export function isDeadRefresh(status: number, body: Json | null): boolean {
  if (status === 400 || status === 401) return !body || body.error === 'invalid_grant' || body.error === 'invalid_request' || status === 401;
  return false;
}
