import path from 'node:path';
import { app, BrowserWindow, globalShortcut, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { loadConfig, saveConfig, type AppConfig } from './config';
import type { SystemInfoView } from '@core/api';
import { loginSupport, shouldShowOnSecondInstance, shouldStartHidden, validateHotkey } from '@core/system';
import { HookServer } from './hookServer';
import fs from 'node:fs';
import { applyQuota, applyStatusline, applyUsageApi, emptyUsage, settleUsage, type UsageView } from '@core/usage';
import { fetchUsage } from './usageApi';
import { registerAllIpc } from './ipc/registry';
import { getHookState } from './installer';
import { writeStatusLineScript } from './statusline';
import { SessionManager, type NotifyRequest } from './manager';
import { LocalMonitor } from './localMonitor';
import { InboxService } from './inbox';
import { overlayIcon, withDot } from './trayBadge';
import { applyUrlOverrides, normalizeLocalConfig } from '@core/localModels';
import { Updater } from './updater';
import { RELEASES_URL } from '@core/updates';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

// test hooks: isolated profile dir and receiver port
if (process.env.CLAUDE_VIS_USER_DATA) app.setPath('userData', process.env.CLAUDE_VIS_USER_DATA);

let mainWin: BrowserWindow | null = null;
let miniWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let config: AppConfig;
/** launched by the login item: keep the main window hidden until the user asks for it */
let startHidden = false;
/** tray "Open settings" used while the main window was still loading */
let pendingOpenSettings = false;

// ---- OS integration: launch at login + global hotkey (never touched in tests) ----
const LOGIN_ARGS = ['--hidden'];
const noIntegration = !!process.env.CLAUDE_VIS_NO_SYSTEM_INTEGRATION;
const loginMode = () => loginSupport(app.isPackaged, noIntegration);
let registeredHotkey: string | null = null;
let hotkeyError: string | null = null;

function systemInfo(): SystemInfoView {
  return { login: loginMode(), hotkey: { registered: registeredHotkey !== null, error: hotkeyError }, platform: process.platform };
}

function broadcastSystem() {
  broadcast('systeminfo', systemInfo());
  rebuildTrayMenu();
}

/** The OS is the source of truth for the login item (the user can switch it off in Task Manager / Settings). */
function readLoginItem(): boolean {
  return app.getLoginItemSettings({ args: LOGIN_ARGS }).openAtLogin;
}

function applyLoginItem(on: boolean) {
  if (loginMode() !== 'active') return; // dev would register electron.exe; tests must not touch the machine
  try {
    app.setLoginItemSettings({ openAtLogin: on, args: LOGIN_ARGS });
    config.launchAtLogin = readLoginItem();
  } catch (e) {
    console.error('login item failed', e);
  }
}

function tryRegisterHotkey(acc: string): string | null {
  try {
    return globalShortcut.register(acc, toggleMini) ? null : `${acc} is already in use by another app, or the system doesn't allow it.`;
  } catch (e) {
    return `Invalid shortcut: ${(e as Error).message}`;
  }
}

/** Register the configured hotkey at startup. */
function registerStartupHotkey() {
  if (noIntegration) return;
  const v = validateHotkey(config.miniHotkey);
  const err = v.ok ? tryRegisterHotkey(v.accelerator) : v.error;
  if (!err && v.ok) registeredHotkey = v.accelerator;
  hotkeyError = err;
}

/** Validate and switch to a new hotkey; the previous one stays active if the new one can't be registered. */
function applyHotkey(raw: string): { ok: boolean; error?: string; accelerator?: string } {
  const v = validateHotkey(raw);
  if (!v.ok) return { ok: false, error: v.error };
  if (noIntegration) {
    updateConfig({ miniHotkey: v.accelerator });
    return { ok: true, accelerator: v.accelerator };
  }
  if (v.accelerator !== registeredHotkey) {
    const err = tryRegisterHotkey(v.accelerator);
    if (err) return { ok: false, error: err };
    if (registeredHotkey) globalShortcut.unregister(registeredHotkey);
    registeredHotkey = v.accelerator;
  }
  hotkeyError = null;
  updateConfig({ miniHotkey: v.accelerator });
  broadcastSystem();
  return { ok: true, accelerator: v.accelerator };
}

const manager = new SessionManager();
let localMonitor: LocalMonitor;
let inbox: InboxService;
let updater: Updater;
// ---- 5-hour / weekly usage limits, persisted so they show right after a restart ----
const usageFile = () => path.join(app.getPath('userData'), 'usage.json');
let usage: UsageView = emptyUsage();

function loadUsage() {
  try {
    usage = { ...emptyUsage(), ...JSON.parse(fs.readFileSync(usageFile(), 'utf8')) };
  } catch {
    usage = emptyUsage();
  }
}

const USAGE_POLL_MS = 3 * 60_000;
let usageTimer: NodeJS.Timeout | null = null;

/** Poll the plan usage API; on failure keep the last numbers but say why they may be stale. */
async function pollUsageApi() {
  if (usageTimer) clearTimeout(usageTimer);
  const r = await fetchUsage();
  let delay = USAGE_POLL_MS;
  if (r.ok) setUsage(applyUsageApi(usage, r.body, Date.now()));
  else {
    setUsage({ ...usage, api: { state: r.state, message: r.message, at: Date.now() } });
    if (r.retryAfterMs) delay = Math.max(delay, r.retryAfterMs);
    else if (r.state !== 'error') delay = 60_000; // pick up a fresh `claude /login` quickly
  }
  usageTimer = setTimeout(() => void pollUsageApi(), delay);
}

function setUsage(next: UsageView) {
  const settled = settleUsage(next, Date.now());
  if (JSON.stringify(settled) === JSON.stringify(usage)) return;
  usage = settled;
  try {
    fs.writeFileSync(usageFile(), JSON.stringify(usage));
  } catch {
    /* non-fatal */
  }
  broadcast('usage', usage);
  updateTrayTooltip();
  inbox?.schedule();
}

const hookServer = new HookServer(
  (payload) => manager.ingestHook(payload),
  (payload) => setUsage(applyStatusline(usage, payload, Date.now())),
  (status) => broadcast('hookserver', status),
);

function broadcast(channel: string, payload: unknown) {
  for (const w of [mainWin, miniWin]) if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
}

function assetPath(...p: string[]) {
  return app.isPackaged ? path.join(process.resourcesPath, ...p) : path.join(__dirname, '../../build', ...p);
}

function loadRenderer(win: BrowserWindow) {
  if (isDev) void win.loadURL(process.env.ELECTRON_RENDERER_URL!);
  else void win.loadFile(path.join(__dirname, '../renderer/index.html'));
}

function webPrefs(mini: boolean): Electron.WebPreferences {
  return {
    preload: path.join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: false,
    additionalArguments: mini ? ['--vis-mini'] : [],
  };
}

function createMain() {
  mainWin = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0e0c14',
    title: 'Claude Visualized',
    // packaged builds carry the icon in the executable / app bundle
    icon: app.isPackaged ? undefined : path.join(__dirname, '../../build/icon.png'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: webPrefs(false),
  });
  mainWin.once('ready-to-show', () => {
    if (!startHidden) mainWin?.show();
    badgeShown = -1;
    applyInboxBadge();
  });
  mainWin.on('close', (e) => {
    if (!quitting && config.closeToTray && tray) {
      e.preventDefault();
      mainWin?.hide();
    }
  });
  mainWin.on('closed', () => (mainWin = null));
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  loadRenderer(mainWin);
}

function showMain() {
  startHidden = false;
  if (!mainWin) createMain();
  else {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }
}

function openSettings() {
  const fresh = !mainWin;
  showMain();
  const wc = mainWin?.webContents;
  if (!wc) return;
  if (fresh || wc.isLoading())
    pendingOpenSettings = true; // the renderer asks for it once mounted
  else wc.send('ui:openSettings');
}

/** Show the main window on a page (the renderer listens for 'ui:navigate'). */
function navigate(page: string) {
  showMain();
  const send = () => mainWin?.webContents.send('ui:navigate', page);
  if (mainWin?.webContents.isLoading()) mainWin.webContents.once('did-finish-load', () => setTimeout(send, 300));
  else send();
}

const showInbox = () => navigate('inbox');

let baseTrayImage: Electron.NativeImage | null = null;
let dotTrayImage: Electron.NativeImage | null = null;
let badgeShown = -1;

/** Taskbar overlay + tray dot (Windows/Linux) or tray title (macOS) while something needs the user. */
function applyInboxBadge() {
  const n = inbox?.count ?? 0;
  if (n === badgeShown) return;
  badgeShown = n;
  try {
    if (process.platform !== 'darwin') mainWin?.setOverlayIcon(n > 0 ? overlayIcon() : null, n > 0 ? `${n} need you` : '');
    if (tray && baseTrayImage) {
      if (process.platform === 'darwin') tray.setTitle(n > 0 ? String(n) : '');
      else tray.setImage(n > 0 ? (dotTrayImage ??= withDot(baseTrayImage)) : baseTrayImage);
    }
  } catch (e) {
    console.error('badge failed', e);
  }
}

function showWelcome() {
  showMain();
  // a freshly created window needs a moment to load before it can listen
  const send = () => mainWin?.webContents.send('onboarding:show');
  if (mainWin?.webContents.isLoading()) mainWin.webContents.once('did-finish-load', () => setTimeout(send, 300));
  else send();
}

function toggleMini() {
  if (miniWin) {
    miniWin.close();
    return;
  }
  miniWin = new BrowserWindow({
    width: 400,
    height: 260,
    minWidth: 300,
    minHeight: 160,
    frame: false,
    resizable: true,
    alwaysOnTop: config.miniAlwaysOnTop,
    skipTaskbar: true,
    backgroundColor: '#0e0c14',
    title: 'Claude Visualized (mini)',
    webPreferences: webPrefs(true),
  });
  miniWin.setAlwaysOnTop(config.miniAlwaysOnTop, 'floating');
  miniWin.on('closed', () => {
    miniWin = null;
    rebuildTrayMenu();
  });
  loadRenderer(miniWin);
  rebuildTrayMenu();
}

let traySignature = '';

function usageText(): string {
  const p = (w: UsageView['fiveHour']) => (w ? `${Math.round(w.pct)}%` : '—');
  return usage.fiveHour || usage.sevenDay ? `5-hour ${p(usage.fiveHour)} · weekly ${p(usage.sevenDay)}` : '';
}

function updateTrayTooltip() {
  if (!tray) return;
  const sessions = manager.getSummaries().filter((s) => s.live);
  const running = sessions.reduce((n, s) => n + (s.running ?? 0), 0);
  const u = usageText();
  const need = inbox?.count ?? 0;
  tray.setToolTip(
    `Claude Visualized — ${sessions.length} live session${sessions.length === 1 ? '' : 's'}${running ? `, ${running} subagents running` : ''}${need ? `, ${need} need you` : ''}${
      u
        ? `
${u}`
        : ''
    }`,
  );
}

/** Tray entry for updates: restart when ready, the release page on unsigned macOS, otherwise a manual check. Nothing when disabled. */
function updateTrayItems(): Electron.MenuItemConstructorOptions[] {
  const u = updater?.state;
  if (!u || u.status === 'disabled') return [];
  if (u.status === 'downloaded') return [{ type: 'separator' }, { label: `Restart to update to v${u.version}`, click: () => updater.install() }];
  if (u.status === 'available' && u.mode === 'manual')
    return [{ type: 'separator' }, { label: `Download v${u.version}…`, click: () => void shell.openExternal(u.releaseUrl ?? RELEASES_URL) }];
  if (u.status === 'downloading') return [{ type: 'separator' }, { label: `Downloading update… ${u.percent ?? 0}%`, enabled: false }];
  return [{ type: 'separator' }, { label: 'Check for updates', enabled: u.status !== 'checking', click: () => void updater.check() }];
}

function rebuildTrayMenu() {
  if (!tray) return;
  updateTrayTooltip();
  const sessions = manager
    .getSummaries()
    .filter((s) => s.live)
    .slice(0, 8);
  // rebuilding an open native menu makes it flicker; only rebuild when something visible changed
  const sig = JSON.stringify([
    sessions.map((s) => [s.id, s.title, s.running, s.waiting]),
    !!miniWin,
    manager.followActive,
    config.launchAtLogin,
    config.miniHotkey,
    registeredHotkey,
    inbox?.count ?? 0,
    updater?.state.status,
    updater?.state.version,
    updater?.state.mode,
  ]);
  if (sig === traySignature) return;
  traySignature = sig;
  const need = inbox?.count ?? 0;
  const items: Electron.MenuItemConstructorOptions[] = [
    ...(need > 0 ? [{ label: `⚠ ${need} need you`, click: showInbox }, { type: 'separator' as const }] : []),
    { label: `${sessions.length} live session${sessions.length === 1 ? '' : 's'}`, enabled: false },
    ...sessions.map((s) => ({
      label: `${s.waiting ? '⚠ ' : s.running ? '● ' : '○ '}${(s.title ?? s.project).slice(0, 48)}${s.running ? `  (${s.running} running)` : ''}`,
      click: () => {
        manager.select(s.id);
        showMain();
      },
    })),
    { type: 'separator' },
    { label: 'Show window', click: showMain },
    { label: 'Show welcome & tour', click: showWelcome },
    { label: `${miniWin ? 'Close mini view' : 'Mini view'}${registeredHotkey ? ` (${registeredHotkey})` : ''}`, click: toggleMini },
    { label: 'Open settings', click: openSettings },
    {
      label: 'Follow active session',
      type: 'checkbox',
      checked: manager.followActive,
      click: (mi) => {
        manager.setFollow(mi.checked);
        updateConfig({ followActive: mi.checked });
      },
    },
    {
      label: process.platform === 'darwin' ? 'Start at login' : 'Start with Windows',
      type: 'checkbox',
      checked: config.launchAtLogin,
      click: (mi) => updateConfig({ launchAtLogin: mi.checked }),
    },
    ...updateTrayItems(),
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

function createTray() {
  const img = nativeImage.createFromPath(assetPath('tray', process.platform === 'darwin' ? 'tray.png' : 'tray@2x.png'));
  baseTrayImage = img.isEmpty() ? nativeImage.createEmpty() : img;
  tray = new Tray(baseTrayImage);
  tray.on('click', showMain);
  rebuildTrayMenu();
  badgeShown = -1;
  applyInboxBadge();
}

function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const prevPort = config.port;
  config = { ...config, ...patch };
  saveConfig(config);
  manager.notifyAttention = config.notifyAttention;
  manager.notifyAgentDone = config.notifyAgentDone;
  if (patch.followActive !== undefined) manager.setFollow(config.followActive);
  if (patch.launchAtLogin !== undefined) {
    applyLoginItem(config.launchAtLogin);
    saveConfig(config); // may differ from the request if the OS refused
  }
  if (patch.localModels !== undefined) {
    config.localModels = normalizeLocalConfig(patch.localModels);
    saveConfig(config);
    localMonitor.setConfig(config.localModels);
  }
  if (config.port !== prevPort) hookServer.start(config.port);
  if (miniWin && patch.miniAlwaysOnTop !== undefined) miniWin.setAlwaysOnTop(config.miniAlwaysOnTop, 'floating');
  broadcast('config', config);
  rebuildTrayMenu();
  return config;
}

function notify(n: NotifyRequest) {
  inbox.onNotify(n);
  if (!Notification.isSupported()) return;
  if (mainWin?.isFocused() && manager.selected === n.sessionId) return;
  const note = new Notification({ title: n.title, body: n.body.slice(0, 200), silent: false });
  note.on('click', () => {
    manager.select(n.sessionId);
    navigate('session');
  });
  note.show();
}

/** Handlers live in src/main/ipc/*.ts (one module per area, listed in ipc/registry.ts); this hands them the app state they need. */
function registerIpc() {
  registerAllIpc({
    manager,
    hookServer,
    inbox,
    getLocalMonitor: () => localMonitor,
    getConfig: () => config,
    updateConfig,
    getUsage: () => usage,
    pollUsageApi,
    systemInfo,
    applyHotkey,
    toggleMini,
    showMain,
    showInbox,
    updater,
    takePendingOpenSettings: () => {
      const p = pendingOpenSettings;
      pendingOpenSettings = false;
      return p;
    },
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => {
    // a hidden (login) launch must not pop the window; a normal launch brings it up
    if (shouldShowOnSecondInstance(argv)) showMain();
  });
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.fatty8me2.claudevisualized');
    config = loadConfig();
    if (process.env.CLAUDE_VIS_PORT) config.port = Number(process.env.CLAUDE_VIS_PORT);
    // test hooks: CLAUDE_VIS_OLLAMA_URL / CLAUDE_VIS_LMSTUDIO_URL ("off" disables that server)
    config.localModels = applyUrlOverrides(config.localModels, process.env);
    localMonitor = new LocalMonitor(config.localModels);
    localMonitor.on('view', (v) => broadcast('local', v));
    updater = new Updater({
      autoDownload: () => config.autoDownloadUpdates,
      onChange: (v) => {
        broadcast('updates', v);
        rebuildTrayMenu();
      },
      beforeInstall: () => {
        quitting = true;
      },
    });
    manager.followActive = config.followActive;
    manager.notifyAttention = config.notifyAttention;
    manager.notifyAgentDone = config.notifyAgentDone;
    inbox = new InboxService(manager, () => usage, path.join(app.getPath('userData'), 'inbox-dismissed.json'));
    inbox.on('inbox', (snap) => {
      broadcast('inbox', snap);
      applyInboxBadge();
      rebuildTrayMenu();
    });
    registerIpc();
    manager.on('sessions', (s) => {
      broadcast('sessions', s);
      rebuildTrayMenu();
    });
    manager.on('state', (v) => broadcast('state', v));
    manager.on('overview', (v) => broadcast('overview', v));
    manager.on('selected', (id) => broadcast('selected', id));
    manager.on('notify', notify);
    manager.on('quota', (q) => setUsage(applyQuota(usage, q, Date.now())));
    loadUsage();
    // windows that reset while the app was closed, and countdowns crossing a reset
    setInterval(() => setUsage(usage), 30_000);
    if (!process.env.CLAUDE_VIS_NO_USAGE_API) void pollUsageApi();
    // keep the status-line forwarder in sync with the configured port
    void getHookState(config.port).then((h) => {
      if (h.statusLine === 'ours') void writeStatusLineScript(config.port);
    });
    // reflect the real OS login-item state (the user may have switched it off outside the app)
    if (loginMode() === 'active') {
      try {
        config.launchAtLogin = readLoginItem();
        saveConfig(config);
      } catch (e) {
        console.error('login item read failed', e);
      }
    }
    registerStartupHotkey();
    manager.start();
    inbox.start();
    localMonitor.start();
    updater.start();
    if (!process.env.CLAUDE_VIS_NO_HOOK_SERVER) hookServer.start(config.port);
    if (!process.env.CLAUDE_VIS_NO_TRAY) createTray();
    const openedAtLogin = process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAtLogin;
    startHidden = shouldStartHidden(process.argv, openedAtLogin, !!tray);
    createMain();
    app.on('activate', showMain);
  });
  app.on('before-quit', () => {
    quitting = true;
    globalShortcut.unregisterAll();
    manager.stop();
    inbox?.stop();
    localMonitor?.stop();
    updater?.stop();
    hookServer.stop();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && (!tray || quitting)) app.quit();
  });
}
