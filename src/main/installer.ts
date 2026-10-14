import fs from 'node:fs/promises';
import path from 'node:path';
import { hookStatus, installHooks, statusLineState, uninstallHooks, type HookInstallState, type StatusLineState } from '@core/hooksConfig';
import { settingsPath } from './paths';
import { removeStatusLineScript, statusLineCommand, writeStatusLineScript } from './statusline';

export interface HookPreview {
  action: 'install' | 'uninstall';
  settingsFile: string;
  before: string;
  after: string;
  changed: boolean;
}

async function readSettings(): Promise<{ raw: string | null; json: Record<string, unknown> }> {
  let raw: string | null = null;
  try {
    raw = await fs.readFile(settingsPath(), 'utf8');
  } catch {
    return { raw: null, json: {} };
  }
  // throws on invalid JSON on purpose: never rewrite a file we can't parse
  return { raw, json: raw.trim() ? JSON.parse(raw) : {} };
}

/** the part of settings.json we touch, for the preview */
const hooksSection = (j: Record<string, unknown>) => JSON.stringify(j.statusLine ? { statusLine: j.statusLine, hooks: j.hooks ?? {} } : { hooks: j.hooks ?? {} }, null, 2);

export async function getHookState(port: number): Promise<{ state: HookInstallState | 'error'; statusLine: StatusLineState; error?: string; settingsFile: string }> {
  try {
    const { json } = await readSettings();
    return { state: hookStatus(json, port), statusLine: statusLineState(json), settingsFile: settingsPath() };
  } catch (e) {
    return { state: 'error', statusLine: 'none', error: `settings.json is not valid JSON: ${(e as Error).message}`, settingsFile: settingsPath() };
  }
}

export async function previewHooks(action: 'install' | 'uninstall', port: number): Promise<HookPreview> {
  const { json } = await readSettings();
  const next = action === 'install' ? installHooks(json, port, statusLineCommand()) : uninstallHooks(json);
  const before = hooksSection(json);
  const after = hooksSection(next);
  return { action, settingsFile: settingsPath(), before, after, changed: before !== after };
}

/** Backs up settings.json, writes atomically, then re-reads to verify. Returns the backup path. */
export async function applyHooks(action: 'install' | 'uninstall', port: number, backupDir: string): Promise<{ backup: string | null }> {
  const { raw, json } = await readSettings();
  const next = action === 'install' ? installHooks(json, port, statusLineCommand()) : uninstallHooks(json);
  const file = settingsPath();
  if (action === 'install') await writeStatusLineScript(port);
  let backup: string | null = null;
  if (raw !== null) {
    await fs.mkdir(backupDir, { recursive: true });
    backup = path.join(backupDir, `settings-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    await fs.writeFile(backup, raw, 'utf8');
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.claude-visualized.tmp`;
  await fs.writeFile(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  await fs.rename(tmp, file);
  const verify = JSON.parse(await fs.readFile(file, 'utf8'));
  const expected = action === 'install' ? 'installed' : 'none';
  if (action === 'uninstall') await removeStatusLineScript();
  if (hookStatus(verify, port) !== expected && !(action === 'uninstall' && hookStatus(verify, port) === 'none')) {
    throw new Error('verification failed after writing settings.json');
  }
  return { backup };
}
