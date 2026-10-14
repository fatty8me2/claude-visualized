import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

export interface AppConfig {
  port: number;
  followActive: boolean;
  notifyAttention: boolean;
  notifyAgentDone: boolean;
  closeToTray: boolean;
  miniAlwaysOnTop: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  port: 47821,
  followActive: true,
  notifyAttention: true,
  notifyAgentDone: false,
  closeToTray: true,
  miniAlwaysOnTop: true,
};

function file() {
  return path.join(app.getPath('userData'), 'config.json');
}

export function loadConfig(): AppConfig {
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    delete saved.openInClaudeOnClick; // removed option: sessions only open in Claude via the button
    return { ...DEFAULT_CONFIG, ...saved };
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
