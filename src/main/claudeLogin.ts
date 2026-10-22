import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { claudeHome } from './paths';

/**
 * Where Claude Code keeps its OAuth login, per platform:
 *   Windows / Linux: <claude home>/.credentials.json (claude home honors CLAUDE_CONFIG_DIR)
 *   macOS:           the login keychain, generic password service "Claude Code-credentials"
 * Token values are only handed to callers inside this process (readCredentials); loginStatus() and
 * everything logged or shown in the UI carries no token material.
 */

export const KEYCHAIN_SERVICE = 'Claude Code-credentials';

export type CredentialSource = 'file' | 'keychain';

/** runs a binary without a shell; resolves stdout, or null on any failure (missing, locked, denied, timeout) */
export type ExecFn = (cmd: string, args: string[]) => Promise<string | null>;

export const defaultExec: ExecFn = (cmd, args) =>
  new Promise((resolve) => execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, out) => resolve(err ? null : String(out ?? ''))));

export interface LoginDeps {
  platform?: NodeJS.Platform;
  exec?: ExecFn;
  /** the credentials file path (default: <claude home>/.credentials.json) */
  file?: string;
}

export interface Credentials {
  raw: string;
  json: Record<string, any>;
  source: CredentialSource;
}

export function credentialsFile(): string {
  return path.join(claudeHome(), '.credentials.json');
}

function parse(raw: string | null): Record<string, any> | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw.trim());
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

const hasOauth = (j: Record<string, any> | null): j is Record<string, any> => !!j?.claudeAiOauth && typeof j.claudeAiOauth === 'object';

/** The saved login, file first, then (macOS) the keychain. Null when there is none or it cannot be read. */
export async function readCredentials(deps: LoginDeps = {}): Promise<Credentials | null> {
  const platform = deps.platform ?? process.platform;
  try {
    const raw = await fs.readFile(deps.file ?? credentialsFile(), 'utf8');
    const json = parse(raw);
    if (hasOauth(json)) return { raw, json, source: 'file' };
  } catch {
    /* no file */
  }
  if (platform === 'darwin') {
    const raw = await (deps.exec ?? defaultExec)('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
    const json = parse(raw);
    if (raw && hasOauth(json)) return { raw: raw.trim(), json, source: 'keychain' };
  }
  return null;
}

export interface LoginStatus {
  present: boolean;
  source: CredentialSource | null;
  expiresAt: number | null;
  subscriptionType: string | null;
  /** the saved login can read usage (has the user:profile scope, or an older login that lists none) */
  scopesOk: boolean;
}

/** Summary of the saved login for the setup wizard. Never contains token values. */
export async function loginStatus(deps: LoginDeps = {}): Promise<LoginStatus> {
  const c = await readCredentials(deps);
  const o = c?.json.claudeAiOauth;
  if (!c || typeof o?.accessToken !== 'string' || !o.accessToken) return { present: false, source: null, expiresAt: null, subscriptionType: null, scopesOk: false };
  const scopes: unknown = o.scopes;
  return {
    present: true,
    source: c.source,
    expiresAt: typeof o.expiresAt === 'number' ? o.expiresAt : null,
    subscriptionType: typeof o.subscriptionType === 'string' ? o.subscriptionType : null,
    scopesOk: Array.isArray(scopes) ? scopes.includes('user:profile') : true,
  };
}

/** True when the user authenticates with an API key (env var or apiKeyHelper) rather than a Claude login. */
export async function usesApiKey(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN) return true;
  try {
    const s = JSON.parse(await fs.readFile(path.join(claudeHome(), 'settings.json'), 'utf8'));
    return typeof s?.apiKeyHelper === 'string' && s.apiKeyHelper.length > 0;
  } catch {
    return false;
  }
}
