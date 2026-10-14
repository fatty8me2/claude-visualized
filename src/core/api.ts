// Typed surface the preload script exposes to the renderer as window.api.
import type { AgentEvent } from './events';
import type { HookInstallState } from './hooksConfig';
import type { SessionSummary, SessionView } from './state';

export interface AppConfigView {
  port: number;
  followActive: boolean;
  notifyAttention: boolean;
  notifyAgentDone: boolean;
  closeToTray: boolean;
  miniAlwaysOnTop: boolean;
}

export interface HookServerStatusView {
  listening: boolean;
  port: number;
  error: string | null;
  received: number;
  lastAt: number | null;
}

export interface HookStateView {
  state: HookInstallState | 'error';
  error?: string;
  settingsFile: string;
}

export interface HookPreviewView {
  action: 'install' | 'uninstall';
  settingsFile: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface VisApi {
  platform: string;
  isMini: boolean;
  getSessions(): Promise<SessionSummary[]>;
  getState(): Promise<SessionView | null>;
  getSelected(): Promise<string | null>;
  select(id: string | null): Promise<void>;
  setFollow(on: boolean): Promise<void>;
  onSessions(cb: (s: SessionSummary[]) => void): () => void;
  onState(cb: (s: SessionView | null) => void): () => void;
  onSelected(cb: (id: string | null) => void): () => void;
  replayEvents(id: string): Promise<AgentEvent[]>;
  getConfig(): Promise<AppConfigView>;
  setConfig(patch: Partial<AppConfigView>): Promise<AppConfigView>;
  onConfig(cb: (c: AppConfigView) => void): () => void;
  hookServerStatus(): Promise<HookServerStatusView>;
  onHookServerStatus(cb: (s: HookServerStatusView) => void): () => void;
  hookState(): Promise<HookStateView>;
  hookPreview(action: 'install' | 'uninstall'): Promise<HookPreviewView>;
  hookApply(action: 'install' | 'uninstall'): Promise<{ ok: boolean; backup?: string | null; error?: string }>;
  toggleMini(): Promise<void>;
  showMain(): Promise<void>;
  openPath(p: string): Promise<void>;
}
