// Typed surface the preload script exposes to the renderer as window.api.
import type { AgentEvent } from './events';
import type { HookInstallState, StatusLineState } from './hooksConfig';
import type { UsageView } from './usage';
import type { SessionSummary, SessionView } from './state';
import type { InboxSnapshot } from './inbox';
import type { UpdateView } from './updates';
import type { HistoryStatus, HistorySummary, SearchArgs, SearchResult, SummaryArgs } from './history';
import type { OverviewMsg, ViewMsg } from './sync';
import type { LocalModelsConfig, LocalModelsView } from './localModels';
import type { AccountView } from './setupWizard';
import type { SshAddResult, SshHostView } from './sshRemote';
import type { SyncChoice, SyncDetectView, SyncEnableResult, SyncStatusView } from './settingsSync';

export interface AppConfigView {
  port: number;
  followActive: boolean;
  notifyAttention: boolean;
  notifyAgentDone: boolean;
  closeToTray: boolean;
  miniAlwaysOnTop: boolean;
  launchAtLogin: boolean;
  autoDownloadUpdates: boolean;
  /** install a downloaded update by itself when the app is not in use (Settings > Updates) */
  autoInstallUpdates: boolean;
  /** pop up "Update available" in the window (Settings > Updates) */
  notifyUpdates: boolean;
  miniHotkey: string;
  onboardingDone?: boolean;
  onboardingVersion?: number;
  setupVersion?: number;
  setupStep?: number;
  localModels: LocalModelsConfig;
  usagePing: boolean;
  usagePingMinutes: number;
  opencodeEnabled: boolean;
  opencodeDir: string;
  kilnEnabled: boolean;
  kilnEventsFile: string;
}

/** Kiln as the Local models page shows it (src/main/kiln.ts). */
export interface KilnStatusView {
  enabled: boolean;
  file: string | null;
  /** the events file exists */
  found: boolean;
  /** Kiln's latest local_model_status check */
  check: { ts: number; profile: string; model: string; baseUrl: string; reachable: boolean; detail: string } | null;
  runs: number;
  running: number;
  /** the newest run, and the session that shows it (the Claude session that handed it off, or its own) */
  last: { title: string; at: number; ok: boolean | null; model: string; seconds: number; tokensPerSec: number; sessionId: string | null } | null;
}

/** What the setup wizard learns about Claude Code on this computer. Never contains a token. */
export interface SetupDetectView {
  platform: string;
  /** the Claude home: CLAUDE_CONFIG_DIR or ~/.claude */
  claudeHome: string;
  homeExists: boolean;
  projectsExists: boolean;
  sessionCount: number;
  /** the `claude` command on PATH (or where the installers put it) */
  cli: { found: boolean; path: string | null };
  /** best effort: the Claude desktop app */
  desktop: { found: boolean };
  account: AccountView;
}

export interface SystemInfoView {
  /** 'active': login item is really registered; 'dev': unpackaged build, config only; 'disabled': test runs */
  login: 'active' | 'dev' | 'disabled';
  /** whether the global hotkey is currently registered, and why not if it isn't */
  hotkey: { registered: boolean; error: string | null };
  platform: string;
}

export interface SetupStatusView {
  projectsDir: string;
  projectsDirExists: boolean;
  sessionCount: number;
  /** tests set CLAUDE_VIS_SKIP_ONBOARDING so the setup wizard doesn't cover the app */
  skipOnboarding: boolean;
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
  statusLine: StatusLineState;
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

/** A paired computer. role 'host': we watch it; role 'viewer': it may watch us. */
export interface PeerDeviceView {
  key: string;
  deviceId: string;
  name: string;
  role: 'host' | 'viewer';
  host?: string;
  port?: number;
  online: boolean;
  /** hosts: link state; viewers: 'online' or 'offline' */
  state: 'connecting' | 'online' | 'offline' | 'revoked' | 'error';
  error: string | null;
  /** when the link dropped (null while online or before the first attempt) */
  offlineSince: number | null;
  lastSeen: number | null;
  pairedAt: number;
}

export interface DiscoveredHostView {
  name: string;
  host: string;
  port: number;
  id: string;
  seenAt: number;
  /** already paired as a host */
  paired: boolean;
}

/** Peer link state (see docs/PEER-LINK.md), pushed on the 'peers' channel. */
export interface PeersView {
  self: { deviceId: string; name: string };
  sharing: boolean;
  listening: boolean;
  port: number;
  error: string | null;
  code: { code: string; expiresAt: number } | null;
  codeState: 'none' | 'active' | 'expired' | 'locked' | 'used';
  failuresLeft: number;
  /** the last pairing attempt that failed on this (sharing) side, for the UI */
  lastPairFailure: { reason: string; at: number } | null;
  discovering: boolean;
  discovered: DiscoveredHostView[];
  devices: PeerDeviceView[];
}

export interface PairResult {
  ok: boolean;
  error?: string;
  name?: string;
}

export interface OpenInClaudeResult {
  ok: boolean;
  url?: string;
  error?: string;
  /** the session runs on another computer: nothing was opened */
  machine?: string;
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
  /** pushes are incremental (see core/sync.ts): decode them with a ViewDecoder, and call getState() to resync */
  onState(cb: (m: ViewMsg) => void): () => void;
  onSelected(cb: (id: string | null) => void): () => void;
  replayEvents(id: string): Promise<AgentEvent[]>;
  getOverview(): Promise<SessionView[]>;
  /** start/stop receiving 'overview' pushes for this window */
  watchOverview(on: boolean): Promise<void>;
  onOverview(cb: (m: OverviewMsg) => void): () => void;
  getConfig(): Promise<AppConfigView>;
  setConfig(patch: Partial<AppConfigView>): Promise<AppConfigView>;
  onConfig(cb: (c: AppConfigView) => void): () => void;
  hookServerStatus(): Promise<HookServerStatusView>;
  onHookServerStatus(cb: (s: HookServerStatusView) => void): () => void;
  hookState(): Promise<HookStateView>;
  hookPreview(action: 'install' | 'uninstall'): Promise<HookPreviewView>;
  hookApply(action: 'install' | 'uninstall'): Promise<{ ok: boolean; backup?: string | null; error?: string }>;
  /** the user's Claude Code default model alias from settings.json (e.g. "opus[1m]") */
  claudeModelSetting(): Promise<string | null>;
  getUsage(): Promise<UsageView>;
  /** read the usage API now; `ran: false` when it is too soon or a Retry-After is pending (`nextAllowedAt`, epoch ms) */
  refreshUsage(): Promise<{ ran: boolean; nextAllowedAt: number | null }>;
  /** what the usage pings have cost so far (local only) and the reset for that counter */
  pingStats(): Promise<import('./pingStats').PingStatsSummary>;
  resetPingStats(): Promise<void>;
  onUsage(cb: (u: UsageView) => void): () => void;
  /** history index (local SQLite built from the transcripts) */
  historyStatus(): Promise<HistoryStatus>;
  historySummary(args: SummaryArgs): Promise<HistorySummary>;
  historySearch(args: SearchArgs): Promise<SearchResult>;
  historyRebuild(): Promise<void>;
  /** past agent runs and prompts the time estimates compare with (see eta.ts); empty when the index is unavailable */
  etaPriors(): Promise<import('./eta').EtaPriors>;
  /** past shell-command durations the running-command countdown compares with (see cmdEta.ts) */
  cmdPriors(): Promise<import('./cmdEta').CmdPriors>;
  onHistory(cb: (s: HistoryStatus) => void): () => void;
  /** open the session in the Claude desktop app (claude:// deep link) */
  openInClaude(id: string): Promise<OpenInClaudeResult>;
  getSystemInfo(): Promise<SystemInfoView>;
  /** validate + register a new global hotkey for the mini view; the old one stays if this fails */
  applyHotkey(accelerator: string): Promise<{ ok: boolean; error?: string; accelerator?: string }>;
  onSystemInfo(cb: (s: SystemInfoView) => void): () => void;
  /** the tray's "Open settings" was used before this window finished loading */
  takeOpenSettings(): Promise<boolean>;
  onOpenSettings(cb: () => void): () => void;
  toggleMini(): Promise<void>;
  showMain(): Promise<void>;
  openPath(p: string): Promise<void>;
  setupStatus(): Promise<SetupStatusView>;
  /** setup wizard: look at this computer's Claude Code install and login (read-only) */
  setupDetect(): Promise<SetupDetectView>;
  /** a free local port for the hook receiver (the configured one is taken) */
  setupFreePort(): Promise<number | null>;
  /** open a terminal in the home folder, for `claude /login` */
  setupOpenTerminal(): Promise<{ ok: boolean; error?: string }>;
  /** open the Claude Code download page in the browser */
  setupOpenDownload(): Promise<{ ok: boolean; url: string; error?: string }>;
  /** the tray menu asks the window to open the setup wizard */
  onShowOnboarding(cb: () => void): () => void;
  /** local model servers (Ollama, LM Studio, OpenAI-compatible), polled by the main process */
  getLocalModels(): Promise<LocalModelsView>;
  onLocalModels(cb: (v: LocalModelsView) => void): () => void;
  /** "check again": poll every enabled server now */
  refreshLocalModels(): Promise<void>;
  /** Kiln (local-model hand-offs): its events file, its last model check and its runs */
  getKilnStatus(): Promise<KilnStatusView>;
  /** attention inbox: everything across all sessions that needs the user */
  getInbox(): Promise<InboxSnapshot>;
  onInbox(cb: (s: InboxSnapshot) => void): () => void;
  dismissInbox(id: string): Promise<void>;
  /** dismiss every resolved item */
  clearInbox(): Promise<void>;
  /** bring the main window up on the inbox page */
  showInbox(): Promise<void>;
  /** the main process asks the window to show a page (tray menu, notification) */
  onNavigate(cb: (page: string) => void): () => void;
  /** the main window entered or left fullscreen (F11, Ctrl+Cmd+F); the renderer adds the `is-fullscreen` class to <html> */
  onFullscreen(cb: (on: boolean) => void): () => void;
  /** auto-update state (see core/updates.ts) */
  getUpdates(): Promise<UpdateView>;
  checkForUpdates(): Promise<UpdateView>;
  /** start the download when "Automatically download updates" is off */
  downloadUpdate(): Promise<UpdateView>;
  /** quit and install the downloaded update */
  installUpdate(): Promise<boolean>;
  /** one click: restart now if downloaded, else download and restart when done */
  updateNow(): Promise<UpdateView>;
  /** macOS copy run from the disk image or translocated: move it to /Applications and reopen it from there */
  moveToApplications(): Promise<{ ok: boolean; error?: string }>;
  onUpdates(cb: (u: UpdateView) => void): () => void;
  /** the main window was shown (start, or opened again from the tray): the update pop-up may come back */
  onWindowShown(cb: () => void): () => void;
  /** SSH remotes: computers watched without the app installed on them */
  getSshHosts(): Promise<SshHostView[]>;
  onSshHosts(cb: (hosts: SshHostView[]) => void): () => void;
  addSshHost(args: { target: string; port?: number | null; label?: string }): Promise<SshAddResult>;
  removeSshHost(id: string): Promise<SshHostView[]>;
  /** peer link: share with / watch other computers */
  getPeers(): Promise<PeersView>;
  onPeers(cb: (p: PeersView) => void): () => void;
  setSharing(on: boolean): Promise<PeersView>;
  newPairingCode(): Promise<PeersView>;
  /** listen for LAN beacons while the Devices page is open */
  setDiscovering(on: boolean): Promise<void>;
  pairWith(args: { host: string; port: number; code: string }): Promise<PairResult>;
  unpairDevice(key: string): Promise<PeersView>;
  setPeerPort(port: number): Promise<PeersView>;
  /** settings sync through a synced folder (Google Drive for desktop ...): see src/main/settingsSync.ts */
  syncStatus(): Promise<SyncStatusView>;
  onSyncStatus(cb: (s: SyncStatusView) => void): () => void;
  syncDetect(): Promise<SyncDetectView>;
  /** ask for a folder with the system dialog (null when cancelled) */
  syncPickFolder(): Promise<string | null>;
  syncEnable(root: string, choice?: SyncChoice): Promise<SyncEnableResult>;
  syncDisable(): Promise<void>;
  syncNow(): Promise<SyncStatusView>;
  syncOpenFolder(): Promise<void>;
  /** the renderer's synced localStorage values (`all`: first report after the window loaded) */
  syncReport(values: Record<string, string | null>, all?: boolean): Promise<void>;
  /** values that arrived from another computer, to be written to localStorage */
  onSyncApply(cb: (values: Record<string, string>) => void): () => void;
}
