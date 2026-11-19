import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { DEFAULT_MINI_HOTKEY } from '@core/system';
import type { SshHostConfig } from '@core/sshRemote';
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
  /** pop up "Update available" in the window when an update is found (Settings > Updates) */
  notifyUpdates: boolean;
  miniHotkey: string;
  onboardingDone?: boolean;
  onboardingVersion?: number;
  /** the setup wizard version that was completed or skipped (see core/setupWizard.ts) */
  setupVersion?: number;
  /** step the wizard was left on, so it resumes there */
  setupStep?: number;
  localModels: LocalModelsConfig;
  /** peer link: "Share with my other computers" (off by default) and its TCP port */
  shareEnabled: boolean;
  peerPort: number;
  /** read the 5-hour / weekly limits from a tiny Messages API request about once a minute (privacy: docs/PRIVACY.md) */
  usagePing: boolean;
  /** minutes between pings while a session is active (min 5) */
  usagePingMinutes: number;
  /** follow OpenCode sessions (read-only) and where its data lives; empty = auto-detect */
  opencodeEnabled: boolean;
  opencodeDir: string;
  /** show Kiln runs (tasks Claude hands to the local model, read-only) and where Kiln's events file is; empty = Kiln's default */
  kilnEnabled: boolean;
  kilnEventsFile: string;
  /** computers watched over SSH, without the app installed on them (docs/SSH-REMOTES.md); never synced between machines */
  sshHosts: SshHostConfig[];
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
  notifyUpdates: true,
  miniHotkey: DEFAULT_MINI_HOTKEY,
  localModels: DEFAULT_LOCAL_CONFIG,
  shareEnabled: false,
  peerPort: 47830,
  usagePing: true,
  usagePingMinutes: 10,
  opencodeEnabled: true,
  opencodeDir: '',
  kilnEnabled: true,
  kilnEventsFile: '',
  sshHosts: [],
};

function file() {
  return path.join(app.getPath('userData'), 'config.json');
}

export function loadConfig(): AppConfig {
  try {
    const saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
    delete saved.openInClaudeOnClick; // removed option: sessions only open in Claude via the button
    return { ...DEFAULT_CONFIG, ...saved, localModels: normalizeLocalConfig(saved.localModels), sshHosts: Array.isArray(saved.sshHosts) ? saved.sshHosts : [] };
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
