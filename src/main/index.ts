import path from 'node:path';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, shell, Tray } from 'electron';
import { loadConfig, saveConfig, type AppConfig } from './config';
import { HookServer } from './hookServer';
import { applyHooks, getHookState, previewHooks } from './installer';
import { SessionManager, type NotifyRequest } from './manager';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

// test hooks: isolated profile dir and receiver port
if (process.env.CLAUDE_VIS_USER_DATA) app.setPath('userData', process.env.CLAUDE_VIS_USER_DATA);

let mainWin: BrowserWindow | null = null;
let miniWin: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let config: AppConfig;

const manager = new SessionManager();
const hookServer = new HookServer(
  (payload) => manager.ingestHook(payload),
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
  mainWin.once('ready-to-show', () => mainWin?.show());
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
  if (!mainWin) createMain();
  else {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.show();
    mainWin.focus();
  }
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

function rebuildTrayMenu() {
  if (!tray) return;
  const sessions = manager.getSummaries().filter((s) => s.live).slice(0, 8);
  const running = sessions.reduce((n, s) => n + (s.running ?? 0), 0);
  // rebuilding an open native menu makes it flicker; only rebuild when something visible changed
  const sig = JSON.stringify([sessions.map((s) => [s.id, s.title, s.running, s.waiting]), !!miniWin, manager.followActive]);
  if (sig === traySignature) return;
  traySignature = sig;
  tray.setToolTip(`Claude Visualized — ${sessions.length} live session${sessions.length === 1 ? '' : 's'}${running ? `, ${running} subagents running` : ''}`);
  const items: Electron.MenuItemConstructorOptions[] = [
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
    { label: miniWin ? 'Close mini view' : 'Mini view (always on top)', click: toggleMini },
    {
      label: 'Follow active session',
      type: 'checkbox',
      checked: manager.followActive,
      click: (mi) => {
        manager.setFollow(mi.checked);
        updateConfig({ followActive: mi.checked });
      },
    },
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
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.on('click', showMain);
  rebuildTrayMenu();
}

function updateConfig(patch: Partial<AppConfig>): AppConfig {
  const prevPort = config.port;
  config = { ...config, ...patch };
  saveConfig(config);
  manager.notifyAttention = config.notifyAttention;
  manager.notifyAgentDone = config.notifyAgentDone;
  if (patch.followActive !== undefined) manager.setFollow(config.followActive);
  if (config.port !== prevPort) hookServer.start(config.port);
  if (miniWin && patch.miniAlwaysOnTop !== undefined) miniWin.setAlwaysOnTop(config.miniAlwaysOnTop, 'floating');
  broadcast('config', config);
  rebuildTrayMenu();
  return config;
}

function notify(n: NotifyRequest) {
  if (!Notification.isSupported()) return;
  if (mainWin?.isFocused() && manager.selected === n.sessionId) return;
  const note = new Notification({ title: n.title, body: n.body.slice(0, 200), silent: false });
  note.on('click', () => {
    manager.select(n.sessionId);
    showMain();
  });
  note.show();
}

function registerIpc() {
  ipcMain.handle('sessions:get', () => manager.getSummaries());
  ipcMain.handle('state:get', () => manager.currentView());
  ipcMain.handle('selected:get', () => manager.selected);
  ipcMain.handle('session:select', (_e, id: string | null) => {
    manager.select(id);
    updateConfig({ followActive: false });
  });
  ipcMain.handle('follow:set', (_e, on: boolean) => {
    updateConfig({ followActive: on });
  });
  ipcMain.handle('replay:events', (_e, id: string) => manager.replayEvents(id));
  ipcMain.handle('config:get', () => config);
  ipcMain.handle('config:set', (_e, patch: Partial<AppConfig>) => updateConfig(patch));
  ipcMain.handle('hookserver:status', () => hookServer.status);
  ipcMain.handle('hooks:state', () => getHookState(config.port));
  ipcMain.handle('hooks:preview', (_e, action: 'install' | 'uninstall') => previewHooks(action, config.port));
  ipcMain.handle('hooks:apply', async (_e, action: 'install' | 'uninstall') => {
    try {
      const r = await applyHooks(action, config.port, path.join(app.getPath('userData'), 'backups'));
      return { ok: true, backup: r.backup };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });
  ipcMain.handle('mini:toggle', () => toggleMini());
  ipcMain.handle('main:show', () => showMain());
  ipcMain.handle('path:open', (_e, p: string) => {
    shell.showItemInFolder(p);
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);
  app.whenReady().then(() => {
    if (process.platform === 'win32') app.setAppUserModelId('com.fatty8me2.claudevisualized');
    config = loadConfig();
    if (process.env.CLAUDE_VIS_PORT) config.port = Number(process.env.CLAUDE_VIS_PORT);
    manager.followActive = config.followActive;
    manager.notifyAttention = config.notifyAttention;
    manager.notifyAgentDone = config.notifyAgentDone;
    registerIpc();
    manager.on('sessions', (s) => {
      broadcast('sessions', s);
      rebuildTrayMenu();
    });
    manager.on('state', (v) => broadcast('state', v));
    manager.on('selected', (id) => broadcast('selected', id));
    manager.on('notify', notify);
    manager.start();
    if (!process.env.CLAUDE_VIS_NO_HOOK_SERVER) hookServer.start(config.port);
    if (!process.env.CLAUDE_VIS_NO_TRAY) createTray();
    createMain();
    app.on('activate', showMain);
  });
  app.on('before-quit', () => {
    quitting = true;
    manager.stop();
    hookServer.stop();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin' && (!tray || quitting)) app.quit();
  });
}
