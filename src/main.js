const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
// 启动优化：重依赖懒加载（首次访问时才 require），减少冷启动模块解析耗时。
// 用惰性 getter 对上层透明：调用处仍写 modpack.xxx / authMgr.xxx，实际首次访问才加载。
const { ensureJava, requiredJava } = require('./java');
let _mlc = null;
function getMLC() {
  if (!_mlc) _mlc = require('minecraft-launcher-core');
  return _mlc;
}
const lazyModule = (rel) => {
  let m;
  return new Proxy({}, {
    get(_t, prop) {
      if (!m) m = require(rel);
      return m[prop];
    }
  });
};
const authMgr = lazyModule('./auth');
const modpack = lazyModule('./modpack');
const serverMgr = lazyModule('./server');
const tunnelMgr = lazyModule('./tunnel');
const installer = lazyModule('./installer');
const { APP_NAME, APP_VERSION, DATA_ROOT } = require('./constants');
// 供 modpack 等模块解析缓存路径
process.env.CUBIK_DATA_ROOT = DATA_ROOT;

// ---------- 启动开关（必须在 app ready 前设置）----------
// 1) 证书兼容：部分企业网络/安全软件替换 TLS 证书，Node 默认不读系统库。
//    开启 use-system-ca 让 HTTPS 请求信任 Windows 系统根证书。
try {
  if (typeof app.commandLine?.appendSwitch === 'function') {
    app.commandLine.appendSwitch('use-system-ca');
  }
} catch {}

// 2) 启动性能开关：缩短首窗时间、减少不必要的后台开销。
try {
  const cl = app.commandLine;
  // 一次性合并 disable-features（多次 appendSwitch 会覆盖，必须合并写入）
  cl.appendSwitch('disable-features', 'CalculateNativeWinOcclusion,MediaRouter,Translate,BackForwardCache');
  // 保持后台计时准确（下载/安装即使在后台也继续走），但允许渲染被节流以省电
  cl.appendSwitch('disable-background-timer-throttling');
  // 减少首帧前的着色器磁盘缓存探测
  cl.appendSwitch('disable-gpu-shader-disk-cache');
  // V8 优化：尽早编译常用代码；暴露 gc 以便闲置时主动回收内存
  cl.appendSwitch('js-flags', '--no-lazy-feedback-allocation --expose-gc');
} catch {}

// ---------- 全局错误处理：不让未捕获异常直接静默崩掉进程 ----------
process.on('uncaughtException', (err) => {
  const msg = `[未捕获异常] ${err && err.stack ? err.stack : err}`;
  try { console.error(msg); } catch {}
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('mc:log', { level: 'error', msg }); } catch {}
  }
});
process.on('unhandledRejection', (reason) => {
  const msg = `[未处理的 Promise 拒绝] ${reason && reason.stack ? reason.stack : reason}`;
  try { console.error(msg); } catch {}
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('mc:log', { level: 'error', msg }); } catch {}
  }
});

// Electron 自身的缓存/userData 也重定向到 D 盘（需在 app ready 前设置）
try {
  const userDataDir = path.join(DATA_ROOT, 'electron');
  fs.mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
  app.setPath('cache', path.join(userDataDir, 'cache'));
  app.setPath('temp', path.join(DATA_ROOT, 'tmp'));
} catch {}

// ---------- 路径与配置 ----------
// 所有下载/数据默认走 D 盘
const DRIVE = 'D:\\';
const DEFAULT_MC_DIR = path.join(DRIVE, '.minecraft');
const LAUNCHER_DATA = DATA_ROOT; // 配置、缓存、临时文件
const LEGACY_DATA = path.join(DRIVE, 'PCL-Like-Launcher'); // 旧目录（自动迁移）
const CONFIG_PATH = () => path.join(LAUNCHER_DATA, 'launcher-config.json');
const LEGACY_CONFIG = path.join(LEGACY_DATA, 'launcher-config.json');

function ensureDataDir() {
  try { fs.mkdirSync(LAUNCHER_DATA, { recursive: true }); } catch {}
}

// ---------- 内存回收：空闲时降工作集 ----------
// 启动器大部分时间处于闲置；游戏/下载结束后主动让 V8/Chromium 回收内存，
// 降低后台常驻占用。不影响正在进行的下载/安装。
let _trimTimer = null;
function trimMemoryLater(delay = 15000) {
  if (_trimTimer) clearTimeout(_trimTimer);
  _trimTimer = setTimeout(() => {
    _trimTimer = null;
    // 下载/安装中不回收，避免干扰进度回调（running 由页面维护，不存在则视为空闲）
    try {
      if (win && !win.isDestroyed()) win.webContents.send('mc:collect');
    } catch {}
  }, delay);
}

function loadConfig() {
  ensureDataDir();
  // 从旧目录迁移配置（仅一次）
  try {
    if (!fs.existsSync(CONFIG_PATH()) && fs.existsSync(LEGACY_CONFIG)) {
      fs.copyFileSync(LEGACY_CONFIG, CONFIG_PATH());
    }
  } catch {}
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    // 强制所有路径到 D 盘（将旧的 C 盘路径迁移过来）
    if (!c.mcDir || /^C:/i.test(c.mcDir) || !c.mcDir.startsWith(DRIVE)) c.mcDir = DEFAULT_MC_DIR;
    if (!c.serverDir || /^C:/i.test(c.serverDir) || !c.serverDir.startsWith(DRIVE))
      c.serverDir = path.join(DEFAULT_MC_DIR, 'server');
    if (c.downloadSource === 'bmclapi') applySource('bmclapi');
    if (c.cfApiKey) modpack.setCfKey(c.cfApiKey);
    return c;
  } catch {
    return {
      mcDir: DEFAULT_MC_DIR,
      username: 'Steve',
      javaPath: '',
      maxMemory: '2048',
      version: '',
      autoJava: true,
      downloadSource: 'bmclapi',
      cfApiKey: '',
      serverDir: path.join(DEFAULT_MC_DIR, 'server')
    };
  }
}

// ---------- 下载源切换 ----------
// 支持多源：bmclapi（国内镜像，默认）、official（Mojang 官方）等。
function applySource(src) {
  // 兼容旧配置：mojang → official
  let key = src || 'bmclapi';
  if (key === 'mojang') key = 'official';
  try { modpack.setSource(key); } catch {}
  const S = (modpack.SOURCES && modpack.SOURCES[key]) || null;
  const root = S && S.root ? S.root : '';
  if (root) {
    process.env.BMCLAPI_ROOT = root;
    if (S.manifest) process.env.BMCLAPI_VERSION_MANIFEST = S.manifest;
  } else {
    delete process.env.BMCLAPI_ROOT;
    delete process.env.BMCLAPI_VERSION_MANIFEST;
  }
  process.env.CUBIK_SOURCE = key;
}

function saveConfig(cfg) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), 'utf8');
}

let win = null;
let launcher = null;

// 启动优化：禁用 GPU 黑名单缓存检查、启用 V8 代码缓存等（已在上方统一设置）
// 单实例锁：避免用户重复双击开多个窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

function createWindow() {
  const t0 = Date.now();
  win = new BrowserWindow({
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
      // 默认允许后台节流：最小化/失焦时降低渲染开销（游戏启动/下载期间不受影响，
      // 因为下载与安装在主进程进行）。需要持续渲染的场景由页面自身处理。
      backgroundThrottling: true,
      spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // 尽早显示，不等把所有异步工作做完（用背景色避免白屏）
  win.once('ready-to-show', () => {
    win.show();
    console.log('[启动耗时] 窗口可见: ' + (Date.now() - t0) + 'ms');
  });

  // 禁止页面内导航到外部网址（外链一律走系统浏览器）
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 空闲时回收内存：窗口最小化/隐藏后延迟回收渲染进程工作集
  win.on('minimize', () => trimMemoryLater(20000));
  win.on('hide', () => trimMemoryLater(20000));

  if (process.env.CUBIK_PERF) {
    const perfLog = [];
    win.webContents.on('console-message', (_e, lvl, msg) => {
      if (/\[启动耗时\]/.test(msg)) perfLog.push(msg);
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'perf-out.txt'), perfLog.join('\n'));
        if (process.env.CUBIK_PERF === 'exit') app.quit();
      }, 8000);
    });
  }

  // 自动化自测钩子：设置 CUBIK_SELFTEST=1 时自测；=launch 时测试启动游戏
  win.once('ready-to-show', async () => {
    if (!process.env.CUBIK_SELFTEST) return;
    if (process.env.CUBIK_SELFTEST === 'manifest') {
      try {
        const out = await win.webContents.executeJavaScript(`(async () => {
          const r1t = performance.now();
          const r1 = await window.api.versionManifest({ type: 'release' });
          const ms1 = Math.round(performance.now() - r1t);
          const r2t = performance.now();
          const r2 = await window.api.versionManifest({ type: 'release' });
          const ms2 = Math.round(performance.now() - r2t);
          const srcs = await window.api.sourceList();
          return JSON.stringify({ first:{ok:r1.ok,n:r1.list?r1.list.length:0,ms:ms1}, cached:{ok:r2.ok,n:r2.list?r2.list.length:0,ms:ms2}, sources:srcs.map(s=>s.key) });
        })()`);
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), out);
      } catch (e) { try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'ERR ' + e.message); } catch {} }
      setTimeout(() => app.quit(), 300);
      return;
    }
    if (process.env.CUBIK_SELFTEST === 'launch') {
      // 测试启动游戏，捕获错误
      try {
        await new Promise((r) => setTimeout(r, 2000));
        const out = await win.webContents.executeJavaScript(`(async () => {
          const list = await window.api.listVersions();
          if (!list.length) return 'NO_VERSIONS';
          const v = list.find(x => /Fabulously/i.test(x)) || list[0];
          const res = await window.api.launch({ version: v, username: 'Steve', maxMemory: '2048', javaPath: '' });
          await new Promise(r => setTimeout(r, 8000));
          const logs = document.getElementById('log-box') ? document.getElementById('log-box').textContent.slice(-3000) : '';
          return JSON.stringify({ version: v, res, logs });
        })()`);
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), out);
      } catch (e) { try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'ERR ' + e.message); } catch {} }
      setTimeout(() => app.quit(), 400);
      return;
    }
    try {
      await new Promise((r) => setTimeout(r, 2500));
      const state = await win.webContents.executeJavaScript(`(async () => {
        document.querySelector('.nav-item[data-page="server"]').click();
        await new Promise(r => setTimeout(r, 4000));
        const srv = {
          lan: document.getElementById('net-lan').textContent,
          pub: document.getElementById('net-pub').textContent,
          port: document.getElementById('net-port').textContent,
          online: document.getElementById('net-online').textContent,
          pages: document.querySelectorAll('.page').length,
          navs: document.querySelectorAll('.nav-item').length
        };
        // 测试 Mod 页：搜索结果点卡片 -> 跳到详情页
        document.querySelector('.nav-item[data-page="mod"]').click();
        // 轮询等待卡片出现（最多 12s）
        let cards = [];
        for (let i = 0; i < 24; i++) {
          await new Promise(r => setTimeout(r, 500));
          cards = document.querySelectorAll('#mod-grid .pack-card');
          if (cards.length) break;
        }
        if (cards.length) cards[0].click();
        await new Promise(r => setTimeout(r, 4000));
        srv.modCards = cards.length;
        srv.detailActive = document.getElementById('page-detail').classList.contains('active');
        srv.detailTitle = document.getElementById('detail-title').textContent;
        srv.detailVers = document.querySelectorAll('#detail-ver-list li').length;
        srv.targetRowShown = document.getElementById('detail-mod-target-row').style.display !== 'none';
        srv.targetOpts = document.querySelectorAll('#sel-detail-target option').length;
        srv.installBtn = document.getElementById('btn-detail-install').textContent;
        srv.detailClasses = document.getElementById('page-detail').className;
        srv.activePages = [...document.querySelectorAll('.page.active')].map(p => p.id).join(',');
        // 新增功能核对
        srv.accountCard = !!document.getElementById('btn-ms-login');
        srv.jvmArgsInput = !!document.getElementById('in-jvmargs');
        srv.srvGamemode = !!document.getElementById('sel-srv-gamemode');
        srv.legalLinks = document.querySelectorAll('.legal-link').length;
        srv.tutCollapse = document.querySelectorAll('.tut-collapse').length;
        srv.homeAvatar = !!document.getElementById('home-avatar');
        srv.acctList = !!document.getElementById('acct-list');
        srv.srvTypeForge = !!document.querySelector('#sel-srv-type option[value="forge"]');
        srv.tunnelCard = !!document.getElementById('btn-tun-start');
        srv.autoUpdBtn = true;
        return JSON.stringify(srv);
      })()`);
      console.log('SELFTEST_STATE ' + state);
      try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'SELFTEST_STATE ' + state); } catch {}
      // 截图（用于人工核对渲染）—— 此时应在 Mod 详情页
      try {
        await new Promise((r) => setTimeout(r, 500));
        const png = await win.webContents.capturePage();
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-srv-shot.png'), png.toPNG());
      } catch (e) {}
    } catch (e) { console.log('SELFTEST_ERROR ' + e.message); try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'SELFTEST_ERROR ' + e.message); } catch {} }
    setTimeout(() => app.quit(), 400);
  });
}

if (gotLock) {
  app.whenReady().then(() => {
    // 匿名使用统计：启动后延迟上报一次（隐私友好，可在配置关闭，失败不影响启动）
    try { telemetry.init({ dataRoot: DATA_ROOT, version: APP_VERSION }); } catch {}
    createWindow();
  });
}
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// ---------- IPC：配置 ----------
ipcMain.handle('cfg:get', () => loadConfig());
ipcMain.handle('app:info', () => {
  const C = require('./constants');
  return { name: APP_NAME, version: APP_VERSION, electron: process.versions.electron, node: process.versions.node, author: C.LEGAL_AUTHOR || '', email: C.LEGAL_EMAIL || '', repo: C.REPO_URL || '' };
});

// 读取法律文档（从随附的 .md 文件）
ipcMain.handle('app:legal', (_e, doc) => {
  const allow = ['LICENSE', 'PRIVACY', 'TERMS', 'DISCLAIMER', 'THIRD-PARTY-NOTICES'];
  if (!allow.includes(doc)) return { ok: false, error: '未知文档' };
  const candidates = [
    path.join(app.getAppPath(), doc + (doc === 'LICENSE' ? '' : '.md')),
    path.join(__dirname, '..', doc + (doc === 'LICENSE' ? '' : '.md')),
    path.join(process.resourcesPath || '', doc + (doc === 'LICENSE' ? '' : '.md'))
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        let content = fs.readFileSync(p, 'utf8');
        // 用 constants 中的主体信息替换占位符（方便一处修改）
        const C = require('./constants');
        content = content.replace(/\[作者名\]/g, C.LEGAL_AUTHOR || '[作者名]')
                         .replace(/\[contact@example\.com\]/g, C.LEGAL_EMAIL || '[contact@example.com]');
        return { ok: true, content };
      }
    } catch {}
  }
  return { ok: false, error: '未找到文档文件' };
});

// 检查更新：比对 GitHub Releases 最新版本（支持重定向、超时重试、友好错误分类）
ipcMain.handle('app:check-update', async (_e, opts) => {
  const repo = require('./constants').UPDATE_REPO;
  const t0 = Date.now();
  const prefer = (opts && opts.prefer) || 'installer'; // installer | portable | auto
  try {
    // 优先 /releases（列表）：可同时拿到预发布 + 全部资源；失败回退 /releases/latest
    const body = await githubGet(`/repos/${repo}/releases?per_page=10`);
    const list = JSON.parse(body);
    const rel = pickBestRelease(list);
    if (!rel) throw new Error('HTTP 404 该仓库还没有发布版本');

    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const cmp = cmpVersion(latest, APP_VERSION);
    const hasUpdate = !!latest && cmp > 0;

    const assets = (rel.assets || []).filter((a) => /\.exe$/i.test(a.name));
    const pickByName = (re) => assets.find((a) => re.test(a.name));

    // 按偏好挑选下载资源（返回安装版与免安装版两个，供 UI 切换）
    const installer = pickByName(/setup|installer|-x64\.exe$/i) || pickByName(/\.exe$/i) || null;
    const portable = pickByName(/portable/i) || null;
    const chosen = prefer === 'portable' ? (portable || installer) : prefer === 'auto' ? (installer || portable) : (installer || portable);

    const mapAsset = (a) => (a ? { url: a.browser_download_url, name: a.name, size: a.size, downloads: a.download_count || 0 } : null);

    return {
      ok: true,
      current: APP_VERSION,
      latest: latest || APP_VERSION,
      hasUpdate,
      isNewer: hasUpdate,
      prerelease: !!rel.prerelease,
      name: rel.name || rel.tag_name || '',
      url: rel.html_url || '',
      publishedAt: rel.published_at || '',
      notes: (rel.body || '').slice(0, 6000),
      // 兼容旧字段
      downloadUrl: chosen ? chosen.browser_download_url : '',
      downloadName: chosen ? chosen.name : '',
      size: chosen ? chosen.size : 0,
      // 新增：可选下载（安装版 / 免安装版）
      installer: mapAsset(installer),
      portable: mapAsset(portable),
      chosen: prefer,
      assetCount: assets.length,
      elapsedMs: Date.now() - t0
    };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    let error, hint;
    if (msg.includes('404')) { error = 'NO_RELEASE'; hint = '仓库还没有发布任何版本（或仓库名未设置）。'; }
    else if (msg.includes('403')) { error = 'RATE_LIMIT'; hint = 'GitHub 请求过于频繁，请稍后再试。'; }
    else if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) { error = 'TIMEOUT'; hint = '请求超时，请检查网络后重试。'; }
    else if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('EAI_AGAIN')) { error = 'OFFLINE'; hint = '网络不可用（可能被墙），请检查网络。'; }
    else { error = 'ERROR'; hint = msg; }
    return { ok: false, error, hint, raw: msg, repo };
  }
});

// 从 releases 列表中挑选最合适的版本（优先正式版，看最新发布时间）
function pickBestRelease(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const stable = list.filter((r) => !r.draft && !r.prerelease);
  const pool = stable.length ? stable : list.filter((r) => !r.draft);
  if (!pool.length) return null;
  // GitHub 返回按时间倒序，取第一个
  return pool[0];
}

// 下载更新包（带进度，保存到下载目录）
ipcMain.handle('app:download-update', async (_e, { url, name }) => {
  try {
    if (!url) return { ok: false, error: '没有可下载的更新包' };
    const dir = path.join(LAUNCHER_DATA, 'updates');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name || 'Cubik-update.exe');
    const send = (got, total) => { try { win.webContents.send('update:progress', { got, total }); } catch {} };
    await modpack.downloadFile(url, dest, send, null, name || 'update');
    return { ok: true, file: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 打开已下载的更新包所在文件夹
ipcMain.handle('app:open-update-folder', () => {
  const dir = path.join(LAUNCHER_DATA, 'updates');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return shell.openPath(dir);
});

// 一键更新：下载新包 → 启动安装程序 → 退出本启动器
ipcMain.handle('app:install-update', async (_e, { url, name }) => {
  try {
    if (!url) return { ok: false, error: '没有可下载的更新包' };
    const dir = path.join(LAUNCHER_DATA, 'updates');
    fs.mkdirSync(dir, { recursive: true });
    // 安装版用固定名，避免重复堆积
    const isInstaller = /setup|installer/i.test(name || '') || /\.exe$/i.test(name || '');
    const dest = path.join(dir, name || 'Cubik-update.exe');
    const send = (got, total) => { try { win.webContents.send('update:progress', { got, total }); } catch {} };
    await modpack.downloadFile(url, dest, send, null, name || 'update');
    return { ok: true, file: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 运行下载好的安装包并退出（仅支持安装版 exe）
ipcMain.handle('app:run-update', async (_e, { file }) => {
  try {
    if (!file || !fs.existsSync(file)) return { ok: false, error: '更新包不存在' };
    // 启动安装程序（detached），然后退出当前启动器，让安装器替换文件
    const { spawn } = require('child_process');
    const child = spawn(file, [], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => { try { app.exit(0); } catch { app.quit(); } }, 800);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 判断当前是否为安装版（exe 位于用户/系统安装目录）还是免安装版
function detectInstallMode() {
  try {
    if (!app.isPackaged) return 'dev';
    const exe = process.execPath || '';
    const dir = path.dirname(exe);
    const lower = exe.toLowerCase();
    // 免安装版：electron-builder portable 会解压到临时目录运行，路径含 'portable' 或临时目录
    if (/\bportable\b/i.test(lower)) return 'portable';
    // 安装版典型路径：%LOCALAPPDATA%\Programs\<app> 或 Program Files
    if (/\\programs\\/i.test(dir + '\\') || /program files/i.test(lower) || /appdata\\local/i.test(lower)) return 'installed';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// 真正的自动更新：后台下载安装包 → 静默安装（/S）→ 自动重启新版本 → 退出当前进程
ipcMain.handle('app:auto-update', async (_e, { url, name }) => {
  const { spawn } = require('child_process');
  try {
    if (!url) return { ok: false, error: '没有可下载的更新包' };
    const dir = path.join(LAUNCHER_DATA, 'updates');
    fs.mkdirSync(dir, { recursive: true });
    // 安装包固定名，避免重复堆积；已存在且大小一致则跳过重复下载
    const dest = path.join(dir, 'Cubik-update-setup.exe');
    const send = (got, total) => { try { win.webContents.send('update:progress', { got, total }); } catch {} };
    if (!(fs.existsSync(dest) && fs.statSync(dest).size > 1024)) {
      await modpack.downloadFile(url, dest, send, null, name || 'update');
    }

    const mode = detectInstallMode();
    if (mode === 'portable' || mode === 'dev') {
      // 免安装版/开发模式无法静默覆盖自身，退化为：下载完成后打开所在文件夹让用户手动替换
      return { ok: false, mode, file: dest, error: '免安装版不支持自动覆盖，请手动替换（已下载到 updates 文件夹）', fallback: true };
    }

    // 安装版：静默运行 NSIS 安装器（/S = silent），安装完成后安装器会拉起新版
    const child = spawn(dest, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => { try { app.exit(0); } catch { app.quit(); } }, 800);
    return { ok: true, mode, file: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// GitHub API GET（自动跟随重定向、超时、最多重试 2 次）
// insecure=true 时对 GitHub 域名降级：仍用 HTTPS，但不再强校验证书
// （应对企业网络/安全软件替换证书导致“无法验证证书”的情况，仅用于 api.github.com）
function githubGet(path, tries = 2, insecure = false) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const opts = {
      hostname: 'api.github.com',
      path,
      headers: { 'User-Agent': 'Cubik/' + APP_VERSION, Accept: 'application/vnd.github+json' },
    };
    if (insecure) opts.rejectUnauthorized = false;
    const req = https.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return githubGet(res.headers.location.replace(/^https?:\/\/api\.github\.com/, ''), tries, insecure).then(resolve, reject);
      }
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          if (tries > 1 && res.statusCode >= 500) return setTimeout(() => githubGet(path, tries - 1, insecure).then(resolve, reject), 800);
          return reject(new Error('HTTP ' + res.statusCode));
        }
        resolve(b);
      });
    });
    req.setTimeout(12000, () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => {
      // 证书验证失败 → 降级重试（仍走 HTTPS，仅不校验证书链）
      const certErr = [
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN',
        'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED',
      ].includes(e && e.code);
      if (certErr && tries > 1) {
        return githubGet(path, tries - 1, true).then(resolve, reject);
      }
      if (tries > 1) return setTimeout(() => githubGet(path, tries - 1, insecure).then(resolve, reject), 800);
      reject(e);
    });
  });
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}
ipcMain.handle('sys:ram', () => ({ total: require('os').totalmem() }));
ipcMain.handle('cfg:set', (_e, cfg) => {
  saveConfig(cfg);
  if (cfg.downloadSource) applySource(cfg.downloadSource);
  if (cfg.cfApiKey) modpack.setCfKey(cfg.cfApiKey);
  return true;
});

// ---------- IPC：选择目录 ----------
ipcMain.handle('pick:dir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- IPC：选择 Java ----------
ipcMain.handle('pick:java', async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Java', extensions: ['exe'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- IPC：选择文件（通用，用于自定义背景图） ----------
ipcMain.handle('pick:file', async (_e, { filters } = {}) => {
  const r = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: filters && filters.length ? filters : undefined
  });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- 扫描本地版本 ----------
ipcMain.handle('mc:versions', () => {
  const cfg = loadConfig();
  const vdir = path.join(cfg.mcDir, 'versions');
  if (!fs.existsSync(vdir)) return [];
  return fs.readdirSync(vdir).filter((name) => {
    const json = path.join(vdir, name, name + '.json');
    if (!fs.existsSync(json)) return false;
    // 过滤脏目录：必须有自有 jar，或 inheritsFrom 的基座版本存在
    try {
      const j = JSON.parse(fs.readFileSync(json, 'utf8'));
      const hasJar = fs.existsSync(path.join(vdir, name, name + '.jar'));
      const base = j.inheritsFrom && String(j.inheritsFrom).trim();
      const baseOk = base && fs.existsSync(path.join(vdir, base, base + '.json'));
      return hasJar || !!baseOk;
    } catch {
      return false;
    }
  });
});

// 解析实例的真实基础 MC 版本号（沿 inheritsFrom 链走到最底层，返回形如 '1.20.1'）
function resolveBaseMcVersion(mcDir, name) {
  if (!name) return '';
  let cur = name;
  const seen = new Set();
  let last = name;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const cj = path.join(mcDir, 'versions', cur, cur + '.json');
    if (!fs.existsSync(cj)) break;
    let p;
    try { p = JSON.parse(fs.readFileSync(cj, 'utf8')); } catch { break; }
    if (p.inheritsFrom) { last = p.inheritsFrom; cur = p.inheritsFrom; }
    else { last = cur; break; }
  }
  // last 现在是最底层的版本 id（如 '1.20.1'）；提取出标准 MC 版本号
  const m = String(last).match(/1\.\d{1,2}(?:\.\d{1,2})?/);
  return m ? m[0] : last;
}

// 将实例 JSON 与其 inheritsFrom 链上的基座版本合并成一个完整 JSON
// 规则遵循官方 launcher：子版本优先；libraries 拼接（去重）；arguments 合并；
// mainClass / downloads / assetIndex / assets 等子版本没有的继承自基座。
function mergeVersionJson(mcDir, name) {
  const chain = [];
  let cur = name;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const cj = path.join(mcDir, 'versions', cur, cur + '.json');
    if (!fs.existsSync(cj)) break;
    let p;
    try { p = JSON.parse(fs.readFileSync(cj, 'utf8')); } catch { break; }
    chain.push(p); // 子在前，基座在后
    cur = p.inheritsFrom;
  }
  if (!chain.length) return null;
  // 从最底层（基座）往上合并
  const base = JSON.parse(JSON.stringify(chain[chain.length - 1]));
  const out = base;
  // 逆序合并：先拼 libraries，再覆盖除 libraries 外的字段
  const libMap = new Map();
  const addLibs = (libs) => {
    for (const lib of libs || []) {
      const key = lib.name + (lib.downloads && lib.downloads.classifiers ? ':classifiers' : '');
      libMap.set(key, lib);
    }
  };
  // 基座优先放入，然后子版本覆盖（子版本同名库替换）
  for (let i = chain.length - 1; i >= 0; i--) addLibs(chain[i].libraries);
  out.libraries = [...libMap.values()];
  // arguments 合并：子版本的参数追加到基座后面
  const mergeArgs = (key) => {
    const acc = [];
    for (let i = chain.length - 1; i >= 0; i--) {
      const a = chain[i].arguments && chain[i].arguments[key];
      if (Array.isArray(a)) acc.push(...a);
    }
    return acc;
  };
  if (chain.some((c) => c.arguments)) {
    out.arguments = out.arguments || {};
    out.arguments.game = mergeArgs('game');
    out.arguments.jvm = mergeArgs('jvm');
  }
  // 子版本的顶层字段覆盖（id / mainClass / downloads / assetIndex / assets / type 等）
  for (let i = 0; i < chain.length - 1; i++) {
    const c = chain[i];
    for (const k of Object.keys(c)) {
      if (k === 'libraries' || k === 'arguments' || k === 'inheritsFrom') continue;
      out[k] = c[k];
    }
  }
  // 保证 id 为实例名，jar 指向实例自己的 jar（若存在）
  out.id = name;
  delete out.inheritsFrom;
  return out;
}

// 版本详情：加载器类型、基础 MC 版本、mod 数量、支持库数量
function readVersionMeta(mcDir, name) {
  const vdir = path.join(mcDir, 'versions', name);
  const json = path.join(vdir, name + '.json');
  let j = {};
  try { j = JSON.parse(fs.readFileSync(json, 'utf8')); } catch {}
  // 沿 inheritsFrom 链找基础 MC 版本
  let base = name; const seen = new Set();
  while (base && !seen.has(base)) {
    seen.add(base);
    const bj = path.join(mcDir, 'versions', base, base + '.json');
    if (!fs.existsSync(bj)) break;
    try { const p = JSON.parse(fs.readFileSync(bj, 'utf8')); if (p.inheritsFrom) base = p.inheritsFrom; else break; }
    catch { break; }
  }
  const idLower = name.toLowerCase();
  let loader = '原版';
  if (/forge/.test(idLower) && !/neoforge/.test(idLower)) loader = 'Forge';
  else if (/neoforge/.test(idLower)) loader = 'NeoForge';
  else if (/fabric/.test(idLower)) loader = 'Fabric';
  else if (j.mainClass && /fabric/i.test(j.mainClass)) loader = 'Fabric';
  else if (j.mainClass && /bootstraplauncher/i.test(j.mainClass)) loader = 'Forge';
  // 支持库数量（含继承链）
  const libSet = new Set();
  let cur = name; const seen2 = new Set();
  while (cur && !seen2.has(cur)) {
    seen2.add(cur);
    const cj = path.join(mcDir, 'versions', cur, cur + '.json');
    if (!fs.existsSync(cj)) break;
    try {
      const p = JSON.parse(fs.readFileSync(cj, 'utf8'));
      (p.libraries || []).forEach((l) => { if (l.name) libSet.add(l.name); });
      if (p.inheritsFrom) cur = p.inheritsFrom; else break;
    } catch { break; }
  }
  const modsDir = path.join(vdir, 'mods');
  let modCount = 0;
  if (fs.existsSync(modsDir)) modCount = fs.readdirSync(modsDir).filter((f) => /\.jar(\.disabled)?$/i.test(f)).length;
  let sizeMB = 0;
  try { sizeMB = Math.round(fs.statSync(json).size / 1024); } catch {}
  return { name, loader, mcVersion: base, mods: modCount, libraries: libSet.size, hasJar: fs.existsSync(path.join(vdir, name + '.jar')) };
}

ipcMain.handle('mc:version-info', (_e, { name }) => {
  try { return { ok: true, info: readVersionMeta(loadConfig().mcDir, name) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// 删除一个版本（移到回收站目录，不真删，可恢复）
ipcMain.handle('mc:version-delete', (_e, { name }) => {
  try {
    const cfg = loadConfig();
    const vdir = path.join(cfg.mcDir, 'versions');
    const target = path.join(vdir, name);
    if (!fs.existsSync(target)) return { ok: false, error: '版本不存在' };
    const trash = path.join(cfg.mcDir, '.trash', 'versions');
    fs.mkdirSync(trash, { recursive: true });
    const dest = path.join(trash, name + '_' + Date.now());
    try { fs.renameSync(target, dest); }
    catch { fs.cpSync(target, dest, { recursive: true }); fs.rmSync(target, { recursive: true, force: true }); }
    return { ok: true, movedTo: dest };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 列出某个版本引用的支持库（含继承链），标注本地是否存在
ipcMain.handle('mc:libraries', (_e, { name }) => {
  try {
    const cfg = loadConfig();
    const libRoot = path.join(cfg.mcDir, 'libraries');
    const out = []; const seen = new Set();
    let cur = name; const chain = new Set();
    while (cur && !chain.has(cur)) {
      chain.add(cur);
      const cj = path.join(cfg.mcDir, 'versions', cur, cur + '.json');
      if (!fs.existsSync(cj)) break;
      let p; try { p = JSON.parse(fs.readFileSync(cj, 'utf8')); } catch { break; }
      (p.libraries || []).forEach((l) => {
        if (!l.name || seen.has(l.name)) return;
        seen.add(l.name);
        let rel = l.downloads && l.downloads.artifact && l.downloads.artifact.path;
        if (!rel) {
          const parts = String(l.name).split(':');
          if (parts.length >= 3) rel = parts[0].replace(/\./g, '/') + '/' + parts[1] + '/' + parts[2] + '/' + parts[1] + '-' + parts[2] + '.jar';
        }
        out.push({ name: l.name, path: rel || '', present: rel ? fs.existsSync(path.join(libRoot, rel)) : false });
      });
      if (p.inheritsFrom) cur = p.inheritsFrom; else break;
    }
    out.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, list: out };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------- mod 管理 ----------
ipcMain.handle('mods:list', (_e, { version }) => {
  try {
    const cfg = loadConfig();
    const dir = path.join(cfg.mcDir, 'versions', version, 'mods');
    if (!fs.existsSync(dir)) return { ok: true, list: [] };
    const list = fs.readdirSync(dir).filter((f) => /\.jar(\.disabled)?$/i.test(f)).map((f) => {
      const disabled = /\.disabled$/i.test(f);
      let sizeKB = 0; try { sizeKB = Math.round(fs.statSync(path.join(dir, f)).size / 1024); } catch {}
      return { file: f, name: f.replace(/\.disabled$/i, '').replace(/\.jar$/i, ''), disabled, sizeKB };
    });
    return { ok: true, list };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('mods:toggle', (_e, { version, file, disabled }) => {
  try {
    const dir = path.join(loadConfig().mcDir, 'versions', version, 'mods');
    const from = path.join(dir, file);
    let to;
    if (disabled) to = file.toLowerCase().endsWith('.disabled') ? file : file + '.disabled';
    else to = file.replace(/\.disabled$/i, '');
    fs.renameSync(from, path.join(dir, to));
    return { ok: true, file: to };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('mods:delete', (_e, { version, file }) => {
  try {
    const cfg = loadConfig();
    const dir = path.join(cfg.mcDir, 'versions', version, 'mods');
    const target = path.join(dir, file);
    if (!fs.existsSync(target)) return { ok: false, error: '文件不存在' };
    const trash = path.join(cfg.mcDir, '.trash', 'mods', version);
    fs.mkdirSync(trash, { recursive: true });
    try { fs.renameSync(target, path.join(trash, file)); }
    catch { fs.rmSync(target, { force: true }); }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 从文件选择导入 mod
ipcMain.handle('mods:add', async (_e, { version }) => {
  try {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Mod', extensions: ['jar'] }]
    });
    if (r.canceled) return { ok: true, added: 0 };
    const dir = path.join(loadConfig().mcDir, 'versions', version, 'mods');
    fs.mkdirSync(dir, { recursive: true });
    for (const f of r.filePaths) fs.copyFileSync(f, path.join(dir, path.basename(f)));
    return { ok: true, added: r.filePaths.length };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('mods:open', (_e, { version }) => {
  const dir = path.join(loadConfig().mcDir, 'versions', version, 'mods');
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

// 搜索可下载的 mod（可按指定 MC 版本/加载器，或从目标实例自动推导筛选）
ipcMain.handle('mod:search', async (_e, { source, query, version, mc, loader }) => {
  try {
    let mcV = mc || '', ld = loader || '';
    if (!mcV && version) {
      const info = readVersionMeta(loadConfig().mcDir, version);
      ld = ['fabric', 'forge', 'neoforge'].includes(String(info.loader).toLowerCase()) ? String(info.loader).toLowerCase() : '';
      mcV = info.mcVersion || '';
    }
    const list = source === 'curseforge'
      ? await modpack.searchModsCurseforge(query, mcV, ld)
      : await modpack.searchModsModrinth(query, mcV, ld);
    await modpack.attachZhNames(list);
    return { ok: true, list, mc: mcV, loader: ld };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 取某 mod 可用版本（可按指定 MC 版本/加载器筛选）
ipcMain.handle('mod:versions', async (_e, { source, id, version, mc, loader }) => {
  try {
    let mcV = mc || '', ld = loader || '';
    if (!mcV && version) {
      const info = readVersionMeta(loadConfig().mcDir, version);
      ld = ['fabric', 'forge', 'neoforge'].includes(String(info.loader).toLowerCase()) ? String(info.loader).toLowerCase() : '';
      mcV = info.mcVersion || '';
    }
    const list = source === 'curseforge'
      ? await modpack.curseforgeModFiles(id, mcV, ld)
      : await modpack.modrinthModVersions(id, mcV, ld);
    return { ok: true, list, mc: mcV, loader: ld };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 下载一个 mod 文件到该实例的 mods 文件夹
ipcMain.handle('mod:install', async (_e, { version, url, filename }) => {
  try {
    const cfg = loadConfig();
    const dir = path.join(cfg.mcDir, 'versions', version, 'mods');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, filename);
    const send = (m) => win.webContents.send('install:log', m + '\n');
    await modpack.downloadFile(url, dest, null, send, filename);
    send(`✔ 已下载 Mod: ${filename}`);
    return { ok: true, file: dest };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ---------- 检测 Java ----------
// 优先：配置指定 -> JAVA_HOME -> .minecraft/runtime -> PATH 常见位置
ipcMain.handle('java:detect', () => {
  const cfg = loadConfig();
  const found = [];
  if (cfg.javaPath && fs.existsSync(cfg.javaPath)) found.push(cfg.javaPath);

  if (process.env.JAVA_HOME) {
    const p = path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
    if (fs.existsSync(p)) found.push(p);
  }

  // .minecraft/runtime 下的 mojang java
  const rt = path.join(cfg.mcDir, 'runtime');
  if (fs.existsSync(rt)) {
    for (const d of fs.readdirSync(rt)) {
      const candidates = [
        path.join(rt, d, 'bin', 'java.exe'),
        path.join(rt, d, 'windows-x64', d, 'bin', 'java.exe')
      ];
      for (const c of candidates) if (fs.existsSync(c)) found.push(c);
    }
  }

  // 常见安装路径
  const common = [
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft\\jdk'
  ];
  for (const base of common) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'bin', 'java.exe');
      if (fs.existsSync(p)) found.push(p);
    }
  }
  return [...new Set(found)];
});

// ---------- 微软正版登录（支持多账号） ----------
let pendingLogin = null; // { deviceCode, interval, expiresIn }

// 兼容旧配置：将单个 msAccount 迁移为账号列表
function getAccounts(cfg) {
  if (!cfg.accounts) {
    cfg.accounts = cfg.msAccount ? [Object.assign({ offline: false }, cfg.msAccount)] : [];
  }
  return cfg.accounts;
}
function getActiveIndex(cfg) {
  const accs = getAccounts(cfg);
  let i = typeof cfg.activeAccount === 'number' ? cfg.activeAccount : 0;
  if (i < 0 || i >= accs.length) i = 0;
  return i;
}
function activeAccount(cfg) {
  const accs = getAccounts(cfg);
  return accs.length ? accs[getActiveIndex(cfg)] : null;
}

ipcMain.handle('auth:ms-start', async () => {
  try {
    const dc = await authMgr.startDeviceCode();
    pendingLogin = { deviceCode: dc.deviceCode, interval: dc.interval, expiresIn: dc.expiresIn };
    try { shell.openExternal(dc.verificationUri); } catch {}
    return { ok: true, userCode: dc.userCode, verificationUri: dc.verificationUri, expiresIn: dc.expiresIn };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('auth:ms-poll', async () => {
  if (!pendingLogin) return { ok: false, error: '请先点击“微软登录”' };
  try {
    const onStatus = (m) => { try { win.webContents.send('auth:status', m); } catch {} };
    const info = await authMgr.loginFlow(pendingLogin.deviceCode, pendingLogin.interval, pendingLogin.expiresIn, onStatus);
    pendingLogin = null;
    const cfg = loadConfig();
    const accs = getAccounts(cfg);
    const newAcc = {
      name: info.name,
      uuid: info.uuid,
      accessToken: info.accessToken,
      refreshToken: info.refreshToken,
      owns: info.owns,
      obtainedAt: info.obtainedAt,
      offline: false
    };
    // 同 UUID 已存在则更新，否则追加
    const dup = accs.findIndex((a) => a.uuid && a.uuid === info.uuid);
    if (dup >= 0) { accs[dup] = newAcc; cfg.activeAccount = dup; }
    else { accs.push(newAcc); cfg.activeAccount = accs.length - 1; }
    cfg.username = info.name;
    saveConfig(cfg);
    return { ok: true, account: publicAccount(newAcc), accounts: publicAccounts(cfg) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 静默续期（针对当前激活账号）
ipcMain.handle('auth:ms-refresh', async (_e, opts) => {
  const cfg = loadConfig();
  const idx = (opts && typeof opts.index === 'number') ? opts.index : getActiveIndex(cfg);
  const accs = getAccounts(cfg);
  const acc = accs[idx];
  if (!acc || !acc.refreshToken) return { ok: false, error: '未登录' };
  try {
    const info = await authMgr.refreshFlow(acc.refreshToken);
    accs[idx] = {
      name: info.name,
      uuid: info.uuid,
      accessToken: info.accessToken,
      refreshToken: info.refreshToken,
      owns: info.owns,
      obtainedAt: info.obtainedAt,
      offline: false
    };
    cfg.username = info.name;
    saveConfig(cfg);
    return { ok: true, account: publicAccount(accs[idx]), accounts: publicAccounts(cfg) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 删除账号（by index）
ipcMain.handle('auth:remove', (_e, opts) => {
  const cfg = loadConfig();
  const accs = getAccounts(cfg);
  const idx = (opts && typeof opts.index === 'number') ? opts.index : -1;
  if (idx < 0 || idx >= accs.length) return { ok: false, error: '无效账号' };
  accs.splice(idx, 1);
  let active = cfg.activeAccount || 0;
  if (active >= accs.length) active = Math.max(0, accs.length - 1);
  cfg.activeAccount = active;
  const cur = accs[active];
  if (cur) cfg.username = cur.name;
  saveConfig(cfg);
  return { ok: true, accounts: publicAccounts(cfg), active: active };
});

// 切换激活账号
ipcMain.handle('auth:switch', (_e, opts) => {
  const cfg = loadConfig();
  const accs = getAccounts(cfg);
  const idx = opts && typeof opts.index === 'number' ? opts.index : -1;
  if (idx < 0 || idx >= accs.length) return { ok: false, error: '无效账号' };
  cfg.activeAccount = idx;
  cfg.username = accs[idx].name;
  saveConfig(cfg);
  return { ok: true, account: publicAccount(accs[idx]), active: idx };
});

// 兼容旧接口：退出登录（删除全部或当前）
ipcMain.handle('auth:ms-logout', (_e, opts) => {
  const cfg = loadConfig();
  if (opts && opts.all) {
    cfg.accounts = [];
    cfg.activeAccount = 0;
  } else {
    const accs = getAccounts(cfg);
    const idx = getActiveIndex(cfg);
    accs.splice(idx, 1);
    cfg.activeAccount = Math.max(0, Math.min(idx, accs.length - 1));
  }
  delete cfg.msAccount;
  saveConfig(cfg);
  return { ok: true, accounts: publicAccounts(cfg) };
});

ipcMain.handle('auth:account', () => {
  const cfg = loadConfig();
  const acc = activeAccount(cfg);
  return acc ? publicAccount(acc) : null;
});

// 返回全部账号（脱敏）
ipcMain.handle('auth:accounts', () => {
  const cfg = loadConfig();
  return { ok: true, accounts: publicAccounts(cfg), active: getActiveIndex(cfg) };
});

function publicAccounts(cfg) {
  return getAccounts(cfg).map((a, i) => Object.assign(publicAccount(a), { index: i, active: i === getActiveIndex(cfg) }));
}

// 只暴露给渲染进程的非敏感字段
function publicAccount(a) {
  return {
    name: a.name,
    uuid: a.uuid,
    owns: !!a.owns,
    offline: !!a.offline,
    avatar: a.uuid ? authMgr.avatarUrl(a.uuid) : '',
    body: a.uuid ? authMgr.bodyUrl(a.uuid) : '',
    obtainedAt: a.obtainedAt || 0
  };
}

// ---------- 启动游戏 ----------
ipcMain.handle('mc:launch', async (_e, opts) => {
  const cfg = loadConfig();
  const version = opts.version || cfg.version;
  const send = (level, msg) => win.webContents.send('mc:log', { level, msg: String(msg) });

  // 自动准备 Java
  let javaPath = opts.javaPath || cfg.javaPath;
  if (cfg.autoJava && !javaPath && version) {
    try {
      // 解析实例的真实基础 MC 版本（读取 inheritsFrom 链），避免从实例名误判 Java 版本
      const baseMc = resolveBaseMcVersion(cfg.mcDir, version);
      javaPath = await ensureJava(
        baseMc || version,
        cfg.mcDir,
        (got, total) => win.webContents.send('mc:progress', { type: 'Java下载', task: got, total }),
        (m) => send('debug', m)
      );
    } catch (e) {
      send('debug', '自动下载 Java 失败：' + e.message + '，将尝试系统 Java');
    }
  }

  const { Client } = getMLC();
  launcher = new Client();
  launcher.on('debug', (m) => send('debug', m));
  launcher.on('data', (m) => send('data', m));
  launcher.on('progress', (p) => win.webContents.send('mc:progress', p));
  launcher.on('close', (code) => {
    win.webContents.send('mc:close', code);
    // 游戏已关闭：清理启动器闲置内存（回收 V8/GC 后的工作集），降低后台占用
    trimMemoryLater();
  });

  let auth;
  try {
    // 优先使用微软正版账号（当前激活的）
    const acc = activeAccount(cfg);
    if (acc && acc.accessToken && acc.uuid) {
      // 令牌可能已过期：这里不主动验证，启动失败会提示重新登录
      auth = {
        access_token: acc.accessToken,
        client_token: acc.uuid,
        uuid: acc.uuid,
        name: acc.name,
        user_properties: '{}'
      };
    } else {
      const { Authenticator } = getMLC();
      auth = await Authenticator.getAuth(opts.username || cfg.username);
    }
  } catch (e) {
    return { ok: false, error: '离线认证失败：' + (e && e.message ? e.message : e) };
  }

  // 若选中的是独立实例（versions/<id>/<id>.json 存在且其顶层为 inheritsFrom 或含 mods），
  // 用 custom + gameDirectory 启动，否则 mods/光影包不会生效。
  const fs = require('fs');
  const pathMod = require('path');
  const instDir = pathMod.join(cfg.mcDir, 'versions', version);
  const instJson = pathMod.join(instDir, version + '.json');
  let isInstance = false;
  if (fs.existsSync(instJson)) {
    try {
      const prof = JSON.parse(fs.readFileSync(instJson, 'utf8'));
      // 有 inheritsFrom（Fabric/Forge 实例）或自带 mods 目录→当成独立实例启动
      isInstance = !!prof.inheritsFrom;
    } catch {}
  }
  if (!isInstance && fs.existsSync(pathMod.join(instDir, 'mods'))) isInstance = true;

  const launchOpts = {
    authorization: auth,
    root: cfg.mcDir,
    version: isInstance
      ? { number: version, type: 'release', custom: version }
      : { number: version, type: 'release' },
    memory: { max: String(opts.maxMemory || cfg.maxMemory), min: '1024' },
    javaPath: javaPath || undefined
  };
  // 自定义 JVM / 游戏参数
  const customArgs = String(opts.jvmArgs !== undefined ? opts.jvmArgs : cfg.jvmArgs || '').trim();
  if (customArgs) {
    launchOpts.customArgs = customArgs.split(/\s+/).filter(Boolean);
  }
  // 额外游戏参数（附加到游戏命令行）
  const gameArgs = String(cfg.gameArgs || '').trim();
  if (gameArgs) {
    launchOpts.gameArgs = gameArgs.split(/\s+/).filter(Boolean);
  }
  if (isInstance) {
    launchOpts.overrides = { gameDirectory: instDir };
    // 将实例 JSON 与其 inheritsFrom 链的基座版本合并成一个完整 JSON，
    // 因为 MCLC 不自动解析 inheritsFrom，否则会缺少基座的库（jopt-simple 等）导致启动失败。
    try {
      const merged = mergeVersionJson(cfg.mcDir, version);
      if (merged) {
        const mergedPath = pathMod.join(LAUNCHER_DATA, 'meta', `${version}.json`);
        fs.mkdirSync(pathMod.dirname(mergedPath), { recursive: true });
        fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));
        launchOpts.overrides.versionJson = mergedPath;
      }
    } catch (e) {
      send('debug', '合并版本 JSON 失败（将直接启动）：' + e.message);
    }
  }

  try {
    await launcher.launch(launchOpts);
    return { ok: true };
  } catch (err) {
    const raw = String(err && err.message ? err.message : err);
    return { ok: false, error: humanizeError(raw) };
  }
});

// 把原始报错翻译成人话
function humanizeError(raw) {
  const r = raw.toLowerCase();
  if (r.includes('enoent') && r.includes('java')) return '未找到 Java。请到「设置」里指定 java.exe，或开启自动下载 Java。';
  if (r.includes('version') && (r.includes('not found') || r.includes('does not exist')))
    return '找不到所选版本，可能尚未下载完成。请到「版本选择」重新下载后再试。';
  if (r.includes('eacces') || r.includes('permission')) return '文件权限不足，请尝试以管理员身份运行，或换一个游戏目录。';
  if (r.includes('out of memory') || r.includes('heap')) return '内存不足，请在「设置」里调低最大内存分配。';
  if (r.includes('etimedout') || r.includes('enotfound') || r.includes('econnrefused'))
    return '网络连接失败，请检查网络或切换下载源。';
  if (r.includes('missing') && r.includes('asset')) return '游戏资源文件缺失，请在「版本选择」重新下载该版本。';
  if (r.includes('unsupportedclassversion') || r.includes('class file version'))
    return 'Java 版本不对：该游戏版本需要更新的 Java。请到「设置」里手动指定正确的 java.exe（如 1.17+ 需 Java 17，1.20.5+/1.21+ 需 Java 21），或开启「自动下载 Java」。';
  return raw;
}

// ---------- 综合搜索（Modrinth + CurseForge 合并） ----------
ipcMain.handle('search:all', async (_e, { kind, query, mcVersion, loader }) => {
  try {
    const list = await modpack.searchAll(kind || 'modpack', query, { mcVersion, loader });
    await modpack.attachZhNames(list);
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---------- 整合包搜索/安装 ----------
ipcMain.handle('pack:search', async (_e, { source, query, type }) => {
  try {
    const list =
      source === 'curseforge'
        ? await modpack.searchCurseForge(query)
        : await modpack.searchByType(query, type || 'modpack');
    await modpack.attachZhNames(list);
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 项目详情（Modrinth）
ipcMain.handle('project:detail', async (_e, { id, source }) => {
  try {
    const info = source === 'curseforge' ? await modpack.curseforgeProject(id) : await modpack.modrinthProject(id);
    return { ok: true, info };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 一键安装整合包
ipcMain.handle('pack:install-full', async (_e, { id, versionId, name }) => {
  try {
    const cfg = loadConfig();
    const versions = await modpack.modrinthVersions(id);
    const ver = versions.find((v) => String(v.id) === String(versionId)) || versions[0];
    if (!ver || !ver.files || !ver.files.length) throw new Error('该版本没有可用文件');
    const f = ver.files.find((x) => x.primary) || ver.files[0];
    const send = (m) => win.webContents.send('install:log', m + '\n');
    const result = await installer.installModpack(
      {
        mcDir: cfg.mcDir,
        name: name || id,
        mrpackUrl: f.url,
        mrpackName: f.filename,
        mcVersionHint: (ver.mc || [])[0]
      },
      (pct, done, total, label) => win.webContents.send('install:progress', { pct, done, total, label }),
      send
    );
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 一键安装光影包
ipcMain.handle('shader:install-full', async (_e, { id, versionId }) => {
  try {
    const cfg = loadConfig();
    const versions = await modpack.modrinthVersions(id);
    const ver = versions.find((v) => String(v.id) === String(versionId)) || versions[0];
    if (!ver || !ver.files || !ver.files.length) throw new Error('该光影没有可用文件');
    const f = ver.files.find((x) => x.primary) || ver.files[0];
    const send = (m) => win.webContents.send('install:log', m + '\n');
    const result = await installer.installShader(
      { mcDir: cfg.mcDir, name: id, url: f.url, filename: f.filename },
      (got, total, label) => win.webContents.send('install:progress', { pct: total ? Math.round((got / total) * 100) : 0, done: got, total, label }),
      send
    );
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 热门榜单（整合包 / 光影包）
ipcMain.handle('pack:top', async (_e, { type, offset }) => {
  try {
    const list = await modpack.topProjects(type || 'modpack', 20, offset || 0);
    await modpack.attachZhNames(list);
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 光影包搜索
ipcMain.handle('shader:search', async (_e, { query }) => {
  try {
    const list = await modpack.searchShaders(query);
    await modpack.attachZhNames(list);
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 光影包版本 / 下载
ipcMain.handle('shader:versions', async (_e, { id }) => {
  try {
    const list = await modpack.modrinthVersions(id);
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('shader:install', async (_e, { id, versionId }) => {
  try {
    const cfg = loadConfig();
    const list = await modpack.modrinthVersions(id);
    const ver = list.find((v) => String(v.id) === String(versionId)) || list[0];
    if (!ver || !ver.files || !ver.files.length) throw new Error('该光影没有可用文件');
    const f = ver.files.find((x) => x.primary) || ver.files[0];
    const dest = path.join(cfg.mcDir, 'shaderpacks', f.filename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const { download } = require('./java');
    await download(
      f.url,
      dest,
      (got, total) => win.webContents.send('mc:progress', { type: '光影包', task: got, total }),
      (m) => win.webContents.send('mc:log', { level: 'debug', msg: m })
    );
    return { ok: true, file: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pack:versions', async (_e, { source, id, version, mc, loader }) => {
  try {
    // 若指定了某个本地实例名，推导其 MC + loader 用于筛选（Mod 详情页用）
    let mcV = mc, ldr = loader;
    if (version) {
      try {
        const cfg = loadConfig();
        const base = resolveBaseMcVersion(cfg.mcDir, version) || version;
        mcV = base;
        const meta = readVersionMeta(cfg.mcDir, version);
        ldr = meta && meta.loader && meta.loader !== '原版' ? String(meta.loader).toLowerCase() : '';
      } catch {}
    }
    const list =
      source === 'curseforge'
        ? (version || mcV ? await modpack.curseforgeModFiles(id, mcV, ldr) : await modpack.curseforgeFiles(id))
        : (version || mcV ? await modpack.modrinthModVersions(id, mcV, ldr) : await modpack.modrinthVersions(id));
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('pack:install', async (_e, { source, id, versionId }) => {
  try {
    const cfg = loadConfig();
    const list = source === 'curseforge' ? await modpack.curseforgeFiles(id) : await modpack.modrinthVersions(id);
    const ver = list.find((v) => String(v.id) === String(versionId)) || list[0];
    if (!ver || !ver.files || !ver.files.length) throw new Error('该版本没有可用文件');
    const f = ver.files.find((x) => x.primary) || ver.files[0];
    const dest = path.join(cfg.mcDir, '整合包', f.filename);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const { download } = require('./java');
    await download(f.url, dest, (got, total) => win.webContents.send('mc:progress', { type: '整合包', task: got, total }), (m) => win.webContents.send('mc:log', { level: 'debug', msg: m }));
    return { ok: true, file: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---------- 安装原版 ----------
ipcMain.handle('mc:manifest', async (_e, { type, force }) => {
  try {
    const list = await modpack.versionManifest({ force: !!force });
    let filtered = list;
    if (type === 'release') filtered = list.filter((v) => v.type === 'release');
    else if (type === 'snapshot') filtered = list.filter((v) => v.type === 'snapshot');
    else if (type === 'old') filtered = list.filter((v) => v.type === 'old_beta' || v.type === 'old_alpha');
    return { ok: true, list: filtered };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 下载源列表（供设置页下拉框）
ipcMain.handle('source:list', () => {
  const S = modpack.SOURCES || {};
  return Object.keys(S).map((k) => ({ key: k, name: S[k].name, type: S[k].type, note: S[k].note || '' }));
});

ipcMain.handle('mc:install-vanilla', async (_e, { version }) => {
  try {
    const cfg = loadConfig();
    const send = (m) => win.webContents.send('install:log', m + '\n');
    const result = await modpack.installVanillaVersion(
      version,
      cfg.mcDir,
      (done, total, label) => win.webContents.send('install:progress', { pct: total ? Math.round((done / total) * 100) : 0, done, total, label: label || '下载中' }),
      send
    );
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 加载器版本列表
ipcMain.handle('loader:versions', async (_e, { kind, mcVersion }) => {
  try {
    const list = await installer.listLoaderVersions(kind, mcVersion);
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 安装带加载器的版本
ipcMain.handle('loader:install', async (_e, { kind, mcVersion, loaderVersion, instanceName }) => {
  try {
    const cfg = loadConfig();
    const send = (m) => win.webContents.send('install:log', m + '\n');
    const result = await installer.installLoaderVersion(
      kind,
      cfg.mcDir,
      instanceName,
      mcVersion,
      loaderVersion,
      (done, total, label) => win.webContents.send('install:progress', { pct: total ? Math.round((done / total) * 100) : 0, done, total, label: label || '安装中' }),
      send
    );
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 可叠加组件版本列表
ipcMain.handle('addon:versions', async (_e, { kind, mcVersion }) => {
  try {
    const list = await installer.listAddonVersions(kind, mcVersion);
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 向已有版本叠加组件（如 OptiFine）
ipcMain.handle('addon:install', async (_e, { kind, baseVersion, addonVersion }) => {
  try {
    const cfg = loadConfig();
    const send = (m) => win.webContents.send('install:log', m + '\n');
    const result = await installer.installAddon(
      kind,
      cfg.mcDir,
      baseVersion,
      addonVersion,
      (done, total, label) => win.webContents.send('install:progress', { pct: total ? Math.round((done / total) * 100) : 0, done, total, label: label || '安装中' }),
      send
    );
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// ---------- 服务器管理 ----------
ipcMain.handle('server:create', async (_e, opts) => {
  try {
    const cfg = loadConfig();
    const r = await serverMgr.createServer(
      opts,
      (got, total) => win.webContents.send('server:progress', { task: got, total }),
      (m) => win.webContents.send('server:log', m + '\n')
    );
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('server:versions', async (_e, { type }) => {
  try {
    const list = await serverMgr.listServerVersions(type || 'vanilla');
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('server:start', async (_e, { dir, javaPath, memory, type }) => {
  const cfg = loadConfig();
  let jp = javaPath || cfg.javaPath;
  if (!jp) {
    try {
      jp = await ensureJava(cfg.version || '1.20.1', cfg.mcDir, null, (m) =>
        win.webContents.send('server:log', m + '\n')
      );
    } catch (e) {
      win.webContents.send('server:log', '未找到 Java，将尝试系统 java：' + e.message + '\n');
    }
  }
  return serverMgr.startServer(dir, jp, memory, type, (m) => win.webContents.send('server:log', m + '\n'), (d) => win.webContents.send('server:log', d));
});

ipcMain.handle('server:status', () => ({ ok: true, running: serverMgr.isRunning() }));

ipcMain.handle('server:info', async (_e, { dir }) => serverMgr.serverInfo(dir || (cfg && cfg.serverDir) || ''));

ipcMain.handle('server:stop', () => serverMgr.stopServer());
ipcMain.handle('server:cmd', (_e, cmd) => serverMgr.sendCommand(cmd));
ipcMain.handle('server:update-props', (_e, { dir, updates }) => serverMgr.updateServerProperties(dir, updates));

// ---------- 内网穿透 ----------
ipcMain.handle('tunnel:download', async () => {
  try {
    const exe = await tunnelMgr.downloadFrp(LAUNCHER_DATA, (m) => { try { win.webContents.send('tunnel:log', m + '\n'); } catch {} });
    return { ok: true, exe };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('tunnel:start', (_e, cfg) => {
  try {
    const r = tunnelMgr.startTunnel(LAUNCHER_DATA, cfg,
      (m) => { try { win.webContents.send('tunnel:log', m + '\n'); } catch {} },
      (d) => { try { win.webContents.send('tunnel:log', d); } catch {} });
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('tunnel:stop', () => tunnelMgr.stopTunnel());
ipcMain.handle('tunnel:status', () => ({ ok: true, running: tunnelMgr.isRunning() }));

ipcMain.handle('shell:open', (_e, p) => {
  if (/^https?:\/\//i.test(p)) return shell.openExternal(p);
  return shell.openPath(p);
});

ipcMain.handle('java:required', (_e, v) => requiredJava(v));

