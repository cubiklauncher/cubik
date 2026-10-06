const { app, BrowserWindow, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// 主进程入口：只负责启动开关、窗口创建、生命周期，以及装配各 IPC 域模块（src/ipc/*）。
const ctx = require('./ipc/context');
const { APP_NAME, DATA_ROOT } = ctx;

// ---------- 启动开关（必须在 app ready 前设置）----------
try {
  if (typeof app.commandLine?.appendSwitch === 'function') {
    app.commandLine.appendSwitch('use-system-ca');
  }
} catch {}

try {
  const cl = app.commandLine;
  cl.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,MediaRouter,Translate,BackForwardCache');
  cl.appendSwitch('disable-background-timer-throttling');
  cl.appendSwitch('disable-gpu-shader-disk-cache');
  cl.appendSwitch('js-flags', '--no-lazy-feedback-allocation --expose-gc');
} catch {}

// ---------- 全局错误处理 ----------
process.on('uncaughtException', (err) => {
  const msg = `[未捕获异常] ${err && err.stack ? err.stack : err}`;
  try { console.error(msg); } catch {}
  const w = ctx.getWin();
  if (w && !w.isDestroyed()) { try { w.webContents.send('mc:log', { level: 'error', msg }); } catch {} }
});
process.on('unhandledRejection', (reason) => {
  const msg = `[未处理的 Promise 拒绝] ${reason && reason.stack ? reason.stack : reason}`;
  try { console.error(msg); } catch {}
  const w = ctx.getWin();
  if (w && !w.isDestroyed()) { try { w.webContents.send('mc:log', { level: 'error', msg }); } catch {} }
});

// Electron 缓存/userData 重定向到 D 盘（需在 app ready 前设置）
try {
  const userDataDir = path.join(DATA_ROOT, 'electron');
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
  app.setPath('cache', path.join(userDataDir, 'cache'));
  app.setPath('temp', path.join(DATA_ROOT, 'tmp'));
} catch {}

// ---------- 单实例锁 ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = ctx.getWin();
    if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
  });
}

// ---------- 创建窗口 ----------
function createWindow() {
  const t0 = Date.now();
  const win = new BrowserWindow({
    width: 1060,
    height: 700,
    minWidth: 880,
    minHeight: 580,
    backgroundColor: '#eaf0ff',
    transparent: false,
    show: false,
    autoHideMenuBar: true,
    title: APP_NAME + ' — Minecraft 启动器',
    icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true,
      spellcheck: false
    }
  });
  ctx.setWin(win);
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.once('ready-to-show', () => {
    win.show();
    console.log('[启动耗时] 窗口可见: ' + (Date.now() - t0) + 'ms');
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.on('minimize', () => ctx.trimMemoryLater(20000));
  win.on('hide', () => ctx.trimMemoryLater(20000));

  if (process.env.CUBIK_PERF) {
    const perfLog = [];
    win.webContents.on('console-message', (_e, lvl, msg) => {
      if (/\[启动耗时\]/.test(msg)) perfLog.push(msg);
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        fs.writeFileSync(path.join(__dirname, '..', 'perf-out.txt'), perfLog.join('\n'));
        if (process.env.CUBIK_PERF === 'exit') app.quit();
      }, 8000);
    });
  }

  // 自动化自测钩子（逻辑在 src/selftest.js）
  try { require('./selftest').attachSelfTest(win, app); } catch (e) { console.error('selftest attach 失败', e); }
}

// ---------- 装配 IPC 域模块 ----------
function registerIpc() {
  const modules = [
    './ipc/ipc-config',
    './ipc/ipc-app',
    './ipc/ipc-version',
    './ipc/ipc-launch',
    './ipc/ipc-localpack',
    './ipc/ipc-mod',
    './ipc/ipc-world',
    './ipc/ipc-server',
    './ipc/ipc-java',
    './ipc/ipc-account',
    './ipc/ipc-search',
    './ipc/ipc-pack'
  ];
  for (const m of modules) {
    try { require(m)(ctx); } catch (e) { console.error('IPC 模块注册失败 ' + m + ': ' + (e && e.stack || e)); }
  }
}

if (gotLock) {
  app.whenReady().then(() => {
    try { ctx.telemetry.init({ dataRoot: DATA_ROOT, version: ctx.APP_VERSION }); } catch {}
    registerIpc();
    createWindow();
    try { ctx.restartAutoBackupTimer(); } catch {}
    setTimeout(() => { try { ctx.serverMgr.listServerVersions('vanilla').catch(() => {}); } catch {} }, 1500);
  });
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
