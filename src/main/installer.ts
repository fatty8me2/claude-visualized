import fs from 'node:fs/promises';
import path from 'node:path';
import { hookStatus, installHooks, uninstallHooks, type HookInstallState } from '@core/hooksConfig';
import { settingsPath } from './paths';

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

const hooksSection = (j: Record<string, unknown>) => JSON.stringify(j.hooks ?? {}, null, 2);

export async function getHookState(port: number): Promise<{ state: HookInstallState | 'error'; error?: string; settingsFile: string }> {
  try {
    const { json } = await readSettings();
    return { state: hookStatus(json, port), settingsFile: settingsPath() };
  } catch (e) {
    return { state: 'error', error: `settings.json is not valid JSON: ${(e as Error).message}`, settingsFile: settingsPath() };
  }
}

export async function previewHooks(action: 'install' | 'uninstall', port: number): Promise<HookPreview> {
  const { json } = await readSettings();
  const next = action === 'install' ? installHooks(json, port) : uninstallHooks(json);
  const before = hooksSection(json);
  const after = hooksSection(next);
  return { action, settingsFile: settingsPath(), before, after, changed: before !== after };
}

/** Backs up settings.json, writes atomically, then re-reads to verify. Returns the backup path. */
export async function applyHooks(action: 'install' | 'uninstall', port: number, backupDir: string): Promise<{ backup: string | null }> {
  const { raw, json } = await readSettings();
  const next = action === 'install' ? installHooks(json, port) : uninstallHooks(json);
  const file = settingsPath();
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
  if (hookStatus(verify, port) !== expected && !(action === 'uninstall' && hookStatus(verify, port) === 'none')) {
    throw new Error('verification failed after writing settings.json');
  }
  return { backup };
}
