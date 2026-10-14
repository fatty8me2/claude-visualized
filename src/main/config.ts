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
  /** clicking a session also opens it in the Claude desktop app */
  openInClaudeOnClick: boolean;
}

export const DEFAULT_CONFIG: AppConfig = {
  port: 47821,
  followActive: true,
  notifyAttention: true,
  notifyAgentDone: false,
  closeToTray: true,
  miniAlwaysOnTop: true,
  openInClaudeOnClick: true,
};

function file() {
  return path.join(app.getPath('userData'), 'config.json');
}

export function loadConfig(): AppConfig {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
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
