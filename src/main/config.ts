import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { DEFAULT_MINI_HOTKEY } from '@core/system';
import { DEFAULT_LOCAL_CONFIG, normalizeLocalConfig, type LocalModelsConfig } from '@core/localModels';

export interface AppConfig {
  port: number;
  followActive: boolean;
  notifyAttention: boolean;
  notifyAgentDone: boolean;
  closeToTray: boolean;
  miniAlwaysOnTop: boolean;
  launchAtLogin: boolean;
  autoDownloadUpdates: boolean;
  miniHotkey: string;
  onboardingDone?: boolean;
  onboardingVersion?: number;
  localModels: LocalModelsConfig;
  /** peer link: "Share with my other computers" (off by default) and its TCP port */
  shareEnabled: boolean;
  peerPort: number;
}

export const DEFAULT_CONFIG: AppConfig = {
  port: 47821,
  followActive: true,
  notifyAttention: true,
  notifyAgentDone: false,
  closeToTray: true,
  miniAlwaysOnTop: true,
  launchAtLogin: false,
  autoDownloadUpdates: true,
  miniHotkey: DEFAULT_MINI_HOTKEY,
  localModels: DEFAULT_LOCAL_CONFIG,
  shareEnabled: false,
  peerPort: 47830,
};

function file() {
  return path.join(app.getPath('userData'), 'config.json');
}

export function loadConfig(): AppConfig {
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    delete saved.openInClaudeOnClick; // removed option: sessions only open in Claude via the button
    return { ...DEFAULT_CONFIG, ...saved, localModels: normalizeLocalConfig(saved.localModels) };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(c: AppConfig) {
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(c, null, 2));
  } catch (e) {
    console.error('config save failed', e);
  }
}
