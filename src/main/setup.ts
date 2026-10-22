import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { SetupDetectView } from '@core/api';
import { buildAccount, parseCredentials, parseOauthAccount, type CredentialsInfo } from '@core/setupWizard';
import { readCredentials, usesApiKey } from './claudeLogin';
import { claudeHome } from './paths';

/**
 * First-run setup detection. Reads Claude Code's footprint on this computer and reports what exists. Hard rules:
 *  - the login file / keychain item is parsed in this process and only presence, expiry and plan type leave it (never a token field);
 *  - ~/.claude.json is read for the oauthAccount display fields only;
 *  - nothing here writes to Claude's folders.
 */

const exists = (p: string) =>
  fs.stat(p).then(
    () => true,
    () => false,
  );

async function readText(p: string, max = 32 * 1024 * 1024): Promise<string | null> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile() || st.size > max) return null;
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

/** Claude Code's saved login (file, or the macOS keychain), via claudeLogin.ts; reduced at once to presence / expiry / plan. */
async function readCredentialsInfo(): Promise<CredentialsInfo | null> {
  const c = await readCredentials();
  return c ? parseCredentials(c.raw) : null;
}

/** where Claude Code keeps its account file: next to the config dir when one is set, else ~/.claude.json */
function accountFile(): string {
  if (process.env.CLAUDE_VIS_HOME) return path.join(process.env.CLAUDE_VIS_HOME, '.claude.json');
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json');
  return path.join(os.homedir(), '.claude.json');
}

async function findClaudeCli(): Promise<{ found: boolean; path: string | null }> {
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude.bat', 'claude.ps1'] : ['claude'];
  const override = process.env.CLAUDE_VIS_SETUP_PATH;
  const dirs = (override ?? process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  if (override === undefined) {
    // an app started from the Start menu / Dock can have a short PATH: also look where the installers put the command
    const home = os.homedir();
    dirs.push(path.join(home, '.local', 'bin'), path.join(home, '.claude', 'local'), path.join(home, '.npm-global', 'bin'));
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/usr/local/bin');
  }
  for (const d of dirs)
    for (const n of names) {
      const p = path.join(d, n);
      if (await exists(p)) return { found: true, path: p };
    }
  return { found: false, path: null };
}

/** Best effort: where the Claude desktop app normally lives. A miss just means "not detected". */
async function findClaudeDesktop(): Promise<boolean> {
  if (process.env.CLAUDE_VIS_SETUP_PATH !== undefined) return false;
  const home = os.homedir();
  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
    candidates.push(path.join(local, 'AnthropicClaude'), path.join(local, 'Programs', 'Claude'), path.join(process.env.APPDATA ?? '', 'Claude'));
    try {
      const pk = await fs.readdir(path.join(local, 'Packages'));
      if (pk.some((n) => /^(Claude_|AnthropicPBC\.Claude)/i.test(n))) return true;
    } catch {
      /* no packages dir */
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Claude.app', path.join(home, 'Applications', 'Claude.app'));
  }
  for (const c of candidates) if (c && (await exists(c))) return true;
  return false;
}

export async function detectSetup(sessionCount: number): Promise<SetupDetectView> {
  const home = claudeHome();
  const [homeExists, cli, desktop, creds, acctRaw] = await Promise.all([
    exists(home),
    findClaudeCli(),
    findClaudeDesktop(),
    readCredentialsInfo(),
    readText(accountFile()),
  ]);
  const hasApiKey = await usesApiKey();
  return {
    platform: process.platform,
    claudeHome: home,
    homeExists,
    projectsExists: await exists(path.join(home, 'projects')),
    sessionCount,
    cli,
    desktop: { found: desktop },
    account: buildAccount(creds, parseOauthAccount(acctRaw), hasApiKey, Date.now()),
  };
}

/** Open a terminal window in the user's home folder (they then type `claude`). Nothing is typed for them. */
export async function openTerminalInHome(): Promise<{ ok: boolean; error?: string }> {
  if (process.env.CLAUDE_VIS_NO_EXTERNAL) return { ok: true };
  const home = os.homedir();
  const run = (cmd: string, args: string[]) => {
    const child = spawn(cmd, args, { cwd: home, detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  };
  try {
    if (process.platform === 'win32') {
      // Windows Terminal when installed, else a plain command prompt window
      const wt = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', 'wt.exe');
      if (process.env.LOCALAPPDATA && (await exists(wt))) run(wt, ['-d', home]);
      else run('cmd.exe', ['/c', 'start', 'cmd.exe']);
    } else if (process.platform === 'darwin') {
      run('open', ['-a', 'Terminal', home]);
    } else {
      run('sh', ['-c', 'x-terminal-emulator || gnome-terminal || konsole || xterm']);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** A free local port for the hook receiver, searching upward from `from` (127.0.0.1 only, as the receiver itself is). */
export async function findFreePort(from: number): Promise<number | null> {
  const { createServer } = await import('node:net');
  for (let port = from + 1; port < from + 60 && port < 65535; port++) {
    const ok = await new Promise<boolean>((resolve) => {
      const srv = createServer();
      srv.once('error', () => resolve(false));
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
    });
    if (ok) return port;
  }
  return null;
}
