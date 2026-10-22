// Pure logic for the first-run setup wizard: when it shows, the steps, and how the saved Claude Code login and account file turn into what
// the wizard displays. Nothing here ever holds a token: parseCredentials reads the login JSON and keeps only presence, expiry and plan.

type Json = Record<string, any>;

/** Bump when the wizard changes enough that people who finished an older one should see it again. */
export const SETUP_VERSION = 1;

export const SETUP_STEPS = ['welcome', 'detect', 'account', 'live', 'done'] as const;
export type SetupStepId = (typeof SETUP_STEPS)[number];

export const CLAUDE_CODE_URL = 'https://claude.com/claude-code';

export interface SetupConfig {
  setupVersion?: number;
  onboardingDone?: boolean;
}

/**
 * Show the wizard when this version has not been completed (or skipped). Someone who finished the older welcome screen before the wizard existed
 * is treated as set up: they already have a working install and should not be interrupted by an update.
 */
export function shouldShowSetup(cfg: SetupConfig, current = SETUP_VERSION, skip = false): boolean {
  if (skip) return false;
  if (cfg.setupVersion === undefined) return !cfg.onboardingDone;
  return cfg.setupVersion < current;
}

/** A saved step index made safe: an integer inside the steps, and never the last one (finishing is not resumable). */
export function resumeStep(saved: unknown): number {
  const n = typeof saved === 'number' && Number.isFinite(saved) ? Math.trunc(saved) : 0;
  return Math.max(0, Math.min(SETUP_STEPS.length - 2, n));
}

/** What we keep of Claude Code's saved login. No token fields, by construction. */
export interface CredentialsInfo {
  /** an access or refresh token is stored (we never say which, nor its value) */
  present: boolean;
  hasRefresh: boolean;
  expiresAt: number | null;
  subscriptionType: string | null;
  rateLimitTier: string | null;
}

export function parseCredentials(raw: string | null | undefined): CredentialsInfo | null {
  if (!raw) return null;
  let j: Json;
  try {
    j = JSON.parse(raw);
  } catch {
    return null;
  }
  const o = j?.claudeAiOauth;
  if (!o || typeof o !== 'object') return null;
  const hasAccess = typeof o.accessToken === 'string' && o.accessToken.length > 0;
  const hasRefresh = typeof o.refreshToken === 'string' && o.refreshToken.length > 0;
  if (!hasAccess && !hasRefresh) return null;
  return {
    present: true,
    hasRefresh,
    expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null,
    subscriptionType: typeof o.subscriptionType === 'string' && o.subscriptionType ? o.subscriptionType : null,
    rateLimitTier: typeof o.rateLimitTier === 'string' && o.rateLimitTier ? o.rateLimitTier : null,
  };
}

/** The display fields of ~/.claude.json's oauthAccount: nothing else from that file is read. */
export interface AccountInfo {
  email: string | null;
  name: string | null;
  org: string | null;
}

export function parseOauthAccount(raw: string | null | undefined): AccountInfo | null {
  if (!raw) return null;
  let a: Json | undefined;
  try {
    a = JSON.parse(raw)?.oauthAccount;
  } catch {
    return null;
  }
  if (!a || typeof a !== 'object') return null;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 120) : null);
  const info = { email: s(a.emailAddress), name: s(a.displayName), org: s(a.organizationName) };
  return info.email || info.name || info.org ? info : null;
}

/** "Claude Max 5x", "Claude Pro", "Claude Team" ... from the stored plan fields; null when unknown. */
export function planLabel(subscriptionType: string | null | undefined, rateLimitTier?: string | null): string | null {
  const t = (subscriptionType ?? '').toLowerCase();
  if (!t) return null;
  const names: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  const base = names[t] ?? t.charAt(0).toUpperCase() + t.slice(1);
  const mult = t === 'max' ? /(\d+)x/i.exec(rateLimitTier ?? '')?.[1] : null;
  return `Claude ${base}${mult ? ` ${mult}x` : ''}`;
}

/**
 * ok: a login that works now. renewable: the pass ran out but there is a refresh token, which the app uses by itself.
 * expired: the login is dead; `claude /login` needed. api-key: no subscription login but an API key (no usage meters). none: nothing.
 */
export type LoginState = 'ok' | 'renewable' | 'expired' | 'api-key' | 'none';

export interface AccountView {
  login: LoginState;
  expiresAt: number | null;
  plan: string | null;
  email: string | null;
  name: string | null;
  org: string | null;
}

export function buildAccount(creds: CredentialsInfo | null, acct: AccountInfo | null, hasApiKey: boolean, now: number): AccountView {
  let login: LoginState = 'none';
  if (creds) {
    const expired = creds.expiresAt !== null && creds.expiresAt < now;
    login = !expired ? 'ok' : creds.hasRefresh ? 'renewable' : 'expired';
  } else if (hasApiKey) login = 'api-key';
  const signedIn = login === 'ok' || login === 'renewable' || login === 'expired';
  return {
    login,
    expiresAt: creds?.expiresAt ?? null,
    plan: creds ? planLabel(creds.subscriptionType, creds.rateLimitTier) : null,
    // the account file can linger after signing out: only show who it is while a login is stored
    email: signedIn ? (acct?.email ?? null) : null,
    name: signedIn ? (acct?.name ?? null) : null,
    org: signedIn ? (acct?.org ?? null) : null,
  };
}

/** "you@example.com (Acme Inc)", the name, or null when nothing is known. */
export function whoLabel(a: Pick<AccountView, 'email' | 'name' | 'org'>): string | null {
  const who = a.email ?? a.name;
  if (!who) return a.org;
  return a.org && a.org !== who ? `${who} (${a.org})` : who;
}

/** True when the folder Claude Code writes to, or its command, is there: the wizard stops showing install instructions. */
export function claudeCodePresent(d: { homeExists: boolean; cliFound: boolean }): boolean {
  return d.homeExists || d.cliFound;
}
