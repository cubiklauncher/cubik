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
const backup = require('./backup');
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
    if (process.env.CUBIK_SELFTEST === 'launchcheck') {
      try {
        await new Promise((r) => setTimeout(r, 2500));
        const out = await win.webContents.executeJavaScript(`(async () => {
          const list = await window.api.listVersions();
          const results = [];
          for (const v of list) {
            const r = { version: v };
            try {
              const info = await window.api.versionInfo({ name: v });
              r.info = info.ok ? { loader: info.info.loader, mc: info.info.mcVersion, mods: info.info.mods, libs: info.info.libraries, hasJar: info.info.hasJar } : { err: info.error };
              const libs = await window.api.libraries({ name: v });
              if (libs.ok) {
                const missing = libs.list.filter(x => !x.present);
                r.libsTotal = libs.list.length;
                r.libsMissing = missing.length;
              }
            } catch (e) { r.err = e.message; }
            results.push(r);
          }
          return JSON.stringify(results);
        })()`);
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), out);
      } catch (e) { try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'ERR ' + e.message); } catch {} }
      setTimeout(() => app.quit(), 300);
      return;
    }
    if (process.env.CUBIK_SELFTEST === 'trash') {
      try {
        await new Promise((r) => setTimeout(r, 2500));
        const out = await win.webContents.executeJavaScript(`(async () => {
          const res = {};
          const t = await window.api.trashList();
          res.trash = { ok: t.ok, count: t.list ? t.list.length : 0, sample: t.list && t.list[0] ? t.list[0].origName : null };
          document.querySelector('.nav-item[data-page="versions"]').click();
          await new Promise(r => setTimeout(r, 1500));
          const btn = document.getElementById('btn-trash-open');
          res.trashBtnExists = !!btn;
          if (btn) { btn.click(); await new Promise(r => setTimeout(r, 1500)); }
          const panel = document.getElementById('trash-panel');
          res.panelShown = panel ? panel.style.display !== 'none' : false;
          res.trashItems = document.querySelectorAll('#trash-list li:not(.empty)').length;
          res.verItems = document.querySelectorAll('#version-list li:not(.empty)').length;
          return JSON.stringify(res);
        })()`);
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), out);
      } catch (e) { try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'ERR ' + e.message); } catch {} }
      setTimeout(() => app.quit(), 300);
      return;
    }
    if (process.env.CUBIK_SELFTEST === 'homever') {
      try {
        await new Promise((r) => setTimeout(r, 2500));
        const out = await win.webContents.executeJavaScript(`(async () => {
          const res = {};
          document.querySelector('.nav-item[data-page="home"]').click();
          await new Promise(r => setTimeout(r, 1200));
          const lv = document.getElementById('home-version');
          const lb = document.getElementById('btn-launch');
          res.home = {
            active: document.getElementById('page-home').classList.contains('active'),
            versionText: lv ? lv.textContent : null,
            launchBtn: lb ? lb.textContent.trim() : null,
            launchDisabled: lb ? lb.disabled : null,
            username: document.getElementById('in-username') ? document.getElementById('in-username').value : null,
            memVal: document.getElementById('in-mem') ? document.getElementById('in-mem').value : null
          };
          res.navOrder = [...document.querySelectorAll('.nav-item')].map(b => b.dataset.page);
          document.querySelector('.nav-item[data-page="versions"]').click();
          await new Promise(r => setTimeout(r, 2500));
          const vlist = document.getElementById('version-list');
          res.versions = {
            active: document.getElementById('page-versions').classList.contains('active'),
            itemCount: vlist ? vlist.querySelectorAll('li:not(.empty)').length : 0,
            firstText: vlist && vlist.querySelector('li') ? vlist.querySelector('li').textContent.trim().slice(0,100) : null,
            empty: vlist ? !!vlist.querySelector('.empty') : null
          };
          document.querySelector('.nav-item[data-page="vanilla"]').click();
          await new Promise(r => setTimeout(r, 3000));
          const vcards = document.querySelectorAll('#van-card-list .ver-card');
          res.vanilla = {
            active: document.getElementById('page-vanilla').classList.contains('active'),
            cardCount: vcards.length,
            firstCard: vcards[0] ? vcards[0].textContent.trim().slice(0,60) : null,
            cacheHint: document.getElementById('van-cache-hint') ? document.getElementById('van-cache-hint').textContent : null
          };
          return JSON.stringify(res);
        })()`);
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), out);
        // 截图版本管理页
        await win.webContents.executeJavaScript(`document.querySelector('.nav-item[data-page="versions"]').click()`);
        await new Promise((r) => setTimeout(r, 1500));
        const png = await win.webContents.capturePage();
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-ver-shot.png'), png.toPNG());
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
        // 新增：存档与备份页 / 资源包 / 实例设置
        srv.dataNav = !!document.querySelector('.nav-item[data-page="data"]');
        document.querySelector('.nav-item[data-page="data"]').click();
        await new Promise(r => setTimeout(r, 1500));
        srv.dataPageActive = document.getElementById('page-data').classList.contains('active');
        srv.dataTabs = document.querySelectorAll('.data-tab').length;
        srv.worldItems = document.querySelectorAll('#world-list .data-item').length;
        // 切到实例备份 tab
        const instTab = document.querySelector('[data-dtab="instances"]');
        if (instTab) { instTab.click(); await new Promise(r => setTimeout(r, 1200)); }
        srv.instItems = document.querySelectorAll('#inst-list .data-item').length;
        // 资源包 tab
        srv.rpackNav = !!document.querySelector('.nav-item[data-page="shader"]');
        document.querySelector('.nav-item[data-page="shader"]').click();
        await new Promise(r => setTimeout(r, 300));
        const rpTab = document.querySelector('[data-stab="rpack"]');
        if (rpTab) { rpTab.click(); await new Promise(r => setTimeout(r, 3000)); }
        srv.rpackCards = document.querySelectorAll('#rpack-list .pack-card').length;
        // 新增：全局下载进度条
        srv.gpExists = !!document.getElementById('global-progress');
        document.querySelector('.nav-item[data-page="home"]').click();
        updateGlobalProgress({ pct: 42, done: 420, total: 1000, label: '测试下载' });
        await new Promise(r => setTimeout(r, 150));
        const gpEl = document.getElementById('global-progress');
        srv.gpVisible = gpEl.style.display !== 'none';
        srv.gpLabel = document.getElementById('gp-label').textContent;
        srv.gpPct = document.getElementById('gp-pct').textContent;
        srv.gpWidth = document.getElementById('gp-inner').style.width;
        finishGlobalProgress({ label: '测试下载', ok: true });
        await new Promise(r => setTimeout(r, 150));
        srv.gpDone = gpEl.classList.contains('gp-ok');
        // 服务器页新增元素
        srv.srvStatusBar = !!document.getElementById('srv-status-text');
        srv.srvChatLog = !!document.getElementById('chat-log');
        srv.srvStatusChip = !!document.getElementById('srv-status-online');
        // 服务器控制：玩家管理 + 常用指令
        srv.srvPlayerInput = !!document.getElementById('in-srv-player');
        srv.srvOpBtn = !!document.getElementById('btn-srv-op');
        srv.srvDeopBtn = !!document.getElementById('btn-srv-deop');
        srv.srvKickBtn = !!document.getElementById('btn-srv-kick');
        srv.srvBanBtn = !!document.getElementById('btn-srv-ban');
        srv.quickCmdCount = document.querySelectorAll('#quick-cmds .qcmd').length;
        srv.quickCmdFirst = (document.querySelector('#quick-cmds .qcmd') || {}).getAttribute ? document.querySelector('#quick-cmds .qcmd').getAttribute('data-cmd') : '';
        // 新增：主页版本切换器 / 使用习惯设置 / 最近排序
        srv.homeVerSwitch = !!document.getElementById('home-ver-pop');
        srv.minOnLaunch = !!document.getElementById('in-min-on-launch');
        srv.notifyDone = !!document.getElementById('in-notify-done');
        // 更新进度弹窗
        srv.updModal = !!document.getElementById('upd-modal');
        srv.updModalProg = !!document.getElementById('upd-modal-prog');
        srv.updModalText = !!document.getElementById('upd-modal-text');
        // 模拟打开弹窗并驱动进度
        const um = document.getElementById('upd-modal');
        if (um) {
          um.style.display = 'flex';
          const mp = document.getElementById('upd-modal-prog');
          const mt = document.getElementById('upd-modal-text');
          if (mp) mp.style.width = '55%';
          if (mt) mt.textContent = '下载中 55% (42.0/76.0 MB)';
          srv.updModalVisible = um.style.display !== 'none';
          srv.updModalWidth = mp ? mp.style.width : '';
          um.style.display = 'none';
        }
        window.api.listVersions().then(list => { srv.localVers = list.length; });
        // 模拟最近使用排序
        if (!window.__cfg) window.__cfg = {};
        return JSON.stringify(srv);
      })()`);
      console.log('SELFTEST_STATE ' + state);
      try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'SELFTEST_STATE ' + state); } catch {}
      // 截图（用于人工核对渲染）—— 切到服务器页
      try {
        await win.webContents.executeJavaScript("document.querySelector('.nav-item[data-page=\"server\"]').click()");
        await new Promise((r) => setTimeout(r, 1000));
        // 滚到“控制”卡片（玩家管理 + 常用指令）
        await win.webContents.executeJavaScript(`
          (function(){
            var cards = document.querySelectorAll('#page-server .card');
            for (var i=0;i<cards.length;i++){
              var h = cards[i].querySelector('h2');
              if (h && /控制/.test(h.textContent)) { cards[i].scrollIntoView({block:'start'}); return true; }
            }
            return false;
          })()
        `);
        await new Promise((r) => setTimeout(r, 800));
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

    const mode = detectInstallMode();

    if (mode === 'dev') {
      // 开发模式：跑的是源码目录，更新靠 git 拉取而非替换 exe，无需下载安装包。
      // 直接重启：重新拉起 electron 加载当前源码目录。
      const electronBin = process.execPath;
      const appDir = path.resolve(__dirname, '..');
      try {
        const child = spawn(electronBin, [appDir], { detached: true, stdio: 'ignore', cwd: appDir });
        child.unref();
      } catch (e) {
        return { ok: false, mode, error: '重启失败：' + e.message };
      }
      setTimeout(() => { try { app.exit(0); } catch { app.quit(); } }, 1000);
      return { ok: true, mode, file: '', relaunched: true };
    }

    if (!(fs.existsSync(dest) && fs.statSync(dest).size > 1024)) {
      await modpack.downloadFile(url, dest, send, null, name || 'update');
    }

    if (mode === 'portable') {
      // 免安装版：无法覆盖正在运行的自身。改为启动新下载的便携包（它自解压后即为新版），
      // 再退出当前进程 —— 对新版而言就是一次干净的重启。
      // 注意：便携包不能从与自身相同的路径直接运行，先复制到一个独立临时文件再启动。
      const launchTmp = path.join(dir, 'Cubik-relaunch-' + Date.now() + '.exe');
      try { fs.copyFileSync(dest, launchTmp); } catch { /* 复制失败则退回原文件 */ }
      const launchPath = fs.existsSync(launchTmp) ? launchTmp : dest;
      const child = spawn(launchPath, [], { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => { try { app.exit(0); } catch { app.quit(); } }, 1200);
      return { ok: true, mode, file: dest, relaunched: true };
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
// 启动前提取 LWJGL 等原生库（.dll）到游戏目录。
// 原因：MCLC 对 MC ≥1.19 不再自己提取 natives（它假设 dll 已在游戏目录），
// 若从未解压 natives jar，游戏会报 "Failed to locate library: lwjgl_opengl.dll" 并自动退出。
async function extractNatives(mcDir, version, cwd, send) {
  const merged = (() => { try { return mergeVersionJson(mcDir, version); } catch { return null; } })();
  if (!merged) return;
  const libs = (merged.libraries || []).filter((l) => l.downloads);
  // 收集该平台（windows-x64）需要解压的 natives jar
  const targets = [];
  for (const lib of libs) {
    // 1) 新版格式：libraries[].downloads.classifiers['natives-windows']
    if (lib.downloads.classifiers) {
      const c = lib.downloads.classifiers['natives-windows'] || lib.downloads.classifiers['natives-windows-64'] || lib.downloads.classifiers['natives-windows-amd64'];
      if (c && c.path) targets.push({ path: c.path });
    }
    // 2) 新版：libraries[].downloads.artifact + natives-windows classifier 命名约定
    // 3) 现代格式：natives 通过 name 中的 classifiers（如 :natives-windows）声明
    const nm = lib.name || '';
    const m = nm.match(/natives-windows(?:-64|-amd64)?$/);
    if (m && lib.downloads.artifact && lib.downloads.artifact.path) {
      targets.push({ path: lib.downloads.artifact.path });
    }
  }
  // 去重
  const seen = new Set();
  const list = targets.filter((t) => t.path && !seen.has(t.path) && seen.add(t.path));
  if (!list.length) return;

  const nativesDir = path.join(cwd, 'natives');
  fs.mkdirSync(nativesDir, { recursive: true });

  let extracted = 0;
  const AdmZip = (() => { try { return require('adm-zip'); } catch { return null; } })();
  for (const t of list) {
    const jarPath = path.join(mcDir, 'libraries', t.path);
    if (!fs.existsSync(jarPath)) continue;
    // 检查是否已解压过（用 jar 名做标记）
    const marker = path.join(nativesDir, '.' + path.basename(t.path) + '.done');
    let needExtract = true;
    try { if (fs.existsSync(marker) && fs.statSync(marker).mtimeMs >= fs.statSync(jarPath).mtimeMs) needExtract = false; } catch {}
    if (!needExtract) continue;
    try {
      if (AdmZip) {
        const zip = new AdmZip(jarPath);
        zip.getEntries().forEach((e) => {
          if (e.isDirectory) return;
          const base = path.basename(e.entryName);
          if (!/\.(dll|so|dylib)$/i.test(base)) return;
          fs.writeFileSync(path.join(nativesDir, base), e.getData());
        });
      } else {
        // 降级：用 PowerShell Expand-Archive
        const { execFileSync } = require('child_process');
        const tmp = path.join(nativesDir, '_tmp_' + Date.now());
        fs.mkdirSync(tmp, { recursive: true });
        execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${jarPath}' -DestinationPath '${tmp}' -Force`], { stdio: 'ignore' });
        for (const f of fs.readdirSync(tmp)) {
          if (/\.(dll|so|dylib)$/i.test(f)) fs.copyFileSync(path.join(tmp, f), path.join(nativesDir, f));
        }
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      fs.writeFileSync(marker, String(Date.now()));
      extracted++;
    } catch (e) {
      send && send('debug', '提取原生库失败 ' + path.basename(t.path) + '：' + (e && e.message ? e.message : e));
    }
  }
  if (extracted > 0) send && send('data', `已就绪 ${extracted} 个原生库（natives/.dll）`);
  return nativesDir;
}

// 启动前自检：合并版本 JSON，检查每个 library 的 jar 是否为完整 zip。
// 下载中断/镜像异常会导致 zip 损坏（zip END header not found），游戏启动即崩溃。
// 发现损坏的则删掉并重新下载（用合并后的版本 JSON 里的 downloads.artifact.url）。
async function repairCorruptLibraries(mcDir, version, send) {
  const mp = require('./modpack');
  if (!mp.isValidZip || !mp.downloadFile) return;
  let merged;
  try { merged = mergeVersionJson(mcDir, version); } catch { merged = null; }
  if (!merged) return;
  const libs = (merged.libraries || []).filter((l) => l.downloads && l.downloads.artifact);
  const bad = [];
  for (const lib of libs) {
    const art = lib.downloads.artifact;
    if (!art.path || !/\.jar$/i.test(art.path)) continue;
    const dest = path.join(mcDir, 'libraries', art.path);
    if (fs.existsSync(dest) && !mp.isValidZip(dest)) bad.push({ art, dest });
  }
  if (!bad.length) return;
  send('data', `检测到 ${bad.length} 个损坏的依赖库，正在自动修复…`);
  for (const b of bad) {
    try { fs.unlinkSync(b.dest); } catch {}
    const name = b.art.path.split('/').slice(-1)[0];
    try {
      await mp.downloadFile(b.art.url, b.dest, null, (m) => send('debug', m), '修复 ' + name, null);
      send('data', `✔ 已修复 ${name}`);
    } catch (e) {
      send('data', `✖ 修复 ${name} 失败：${e && e.message ? e.message : e}`);
    }
  }
}

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
  if (m) return m[0];
  // 形如 '1.20.1-forge-47.4.26' 或纯版本名：先从 libraries 里找 minecraft 依赖
  try {
    const cj = path.join(mcDir, 'versions', name, name + '.json');
    if (fs.existsSync(cj)) {
      const p = JSON.parse(fs.readFileSync(cj, 'utf8'));
      // Forge/NeoForge 整合包：从库声明中提取 MC 版本
      // 常见形式：net.minecraftforge:fmlloader:1.20.1-47.4.10 / net.neoforged:neoforge:20.4.237
      // 以及最新优先：先试 --fml.mcVersion 参数，再试库名
      const argStr = JSON.stringify(p.arguments || '');
      const am = argStr.match(/--fml\.mcVersion[",\s]+([0-9]+\.[0-9]+(?:\.[0-9]+)?)/);
      if (am) return am[1];
      for (const lib of (p.libraries || [])) {
        const nm = lib.name || '';
        // 版本号部分（如 1.20.1-47.4.10）开头就是 MC 版本
        const mm = nm.match(/:(\d+\.\d+(?:\.\d+)?)-\d/);
        if (mm && /forge/i.test(nm)) return mm[1];
        const mm2 = nm.match(/:([0-9]+\.[0-9]+(?:\.[0-9]+)?)$/);
        if (mm2 && /neoforge/i.test(nm)) return mm2[1];
      }
    }
  } catch {}
  return last;
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
  // 沿 inheritsFrom 链找基础 MC 版本（Forge/NeoForge 整合包无 inheritsFrom，从库/参数提取）
  const base = resolveBaseMcVersion(mcDir, name) || name;
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

// 实例独立启动设置（内存/Java/参数），未设置则为空
ipcMain.handle('instance:settings-get', (_e, { name }) => {
  try {
    const cfg = loadConfig();
    const ov = (cfg.instanceOverrides && cfg.instanceOverrides[name]) || {};
    return { ok: true, settings: ov };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('instance:settings-set', (_e, { name, settings }) => {
  try {
    const cfg = loadConfig();
    cfg.instanceOverrides = cfg.instanceOverrides || {};
    if (settings && Object.keys(settings).length) cfg.instanceOverrides[name] = settings;
    else delete cfg.instanceOverrides[name];
    saveConfig(cfg);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 列出回收站中已删除的版本
ipcMain.handle('mc:trash-list', () => {
  try {
    const cfg = loadConfig();
    const trash = path.join(cfg.mcDir, '.trash', 'versions');
    if (!fs.existsSync(trash)) return { ok: true, list: [] };
    const list = fs.readdirSync(trash, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => {
        // 目录名格式：<原名>_<时间戳>
        const m = d.name.match(/^(.*)_(\d{13})$/);
        const origName = m ? m[1] : d.name;
        const ts = m ? parseInt(m[2], 10) : 0;
        const full = path.join(trash, d.name);
        let sizeMB = 0;
        try {
          const walk = (p) => { for (const e of fs.readdirSync(p, { withFileTypes: true })) { const fp = path.join(p, e.name); if (e.isDirectory()) walk(fp); else { try { sizeMB += fs.statSync(fp).size; } catch {} } } };
          walk(full);
        } catch {}
        return { dir: d.name, origName, deletedAt: ts, sizeMB: Math.round(sizeMB / 1048576 * 10) / 10 };
      })
      .sort((a, b) => b.deletedAt - a.deletedAt);
    return { ok: true, list };
  } catch (e) { return { ok: false, error: e.message } };
});

// 从回收站恢复一个版本
ipcMain.handle('mc:trash-restore', (_e, { dir }) => {
  try {
    const cfg = loadConfig();
    const trash = path.join(cfg.mcDir, '.trash', 'versions');
    const src = path.join(trash, dir);
    if (!fs.existsSync(src)) return { ok: false, error: '回收站中未找到该项' };
    const m = dir.match(/^(.*)_(\d{13})$/);
    let origName = m ? m[1] : dir;
    const dst = path.join(cfg.mcDir, 'versions', origName);
    // 若同名已存在，自动加后缀避免覆盖
    let finalDst = dst;
    if (fs.existsSync(dst)) {
      const stamp = Date.now();
      finalDst = path.join(cfg.mcDir, 'versions', origName + '_restored_' + stamp);
    }
    try { fs.renameSync(src, finalDst); }
    catch { fs.cpSync(src, finalDst, { recursive: true }); fs.rmSync(src, { recursive: true, force: true }); }
    return { ok: true, restored: path.basename(finalDst) };
  } catch (e) { return { ok: false, error: e.message } };
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

// ---------- 存档 / 实例备份 / 截图 / 导入（backup.js） ----------
ipcMain.handle('world:list', () => {
  try { return { ok: true, list: backup.listWorlds(loadConfig().mcDir) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('world:backup', (_e, { name, note }) => {
  try { const r = backup.backupWorld(loadConfig().mcDir, name, note); return { ...r, sizeText: backup.fmtSize(r.size) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('world:backups', (_e, { name }) => {
  try { return { ok: true, list: backup.listWorldBackups(loadConfig().mcDir, name || '') }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('world:restore', (_e, { file }) => {
  try { return backup.restoreWorld(loadConfig().mcDir, file); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('world:delete', (_e, { name }) => {
  try { return backup.deleteWorld(loadConfig().mcDir, name); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('world:backup-delete', (_e, { file }) => {
  try { return backup.deleteWorldBackup(loadConfig().mcDir, file); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('world:open', () => {
  const dir = path.join(loadConfig().mcDir, 'saves');
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

ipcMain.handle('instance:backup', (_e, { name }) => {
  try { return backup.backupInstance(loadConfig().mcDir, name); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('instance:backups', (_e, { name }) => {
  try { return { ok: true, list: backup.listInstanceBackups(loadConfig().mcDir, name || '') }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('instance:restore', (_e, { file }) => {
  try { return backup.restoreInstance(loadConfig().mcDir, file); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('instance:backup-delete', (_e, { file }) => {
  try { return backup.deleteInstanceBackup(loadConfig().mcDir, file); }
  catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('shot:list', () => {
  try { return { ok: true, list: backup.listScreenshots(loadConfig().mcDir) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('shot:open', () => {
  const dir = path.join(loadConfig().mcDir, 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});
ipcMain.handle('shot:show', (_e, { file }) => {
  try {
    const full = path.join(loadConfig().mcDir, 'screenshots', file);
    if (!fs.existsSync(full)) return { ok: false, error: '截图不存在' };
    shell.showItemInFolder(full);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('import:list', () => {
  try { return { ok: true, ...backup.listImportableVersions(loadConfig().mcDir) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('import:version', (_e, { name }) => {
  try { return backup.importVersion(loadConfig().mcDir, name); }
  catch (e) { return { ok: false, error: e.message }; }
});

// ---------- 资源包 ----------
ipcMain.handle('rpack:search', async (_e, { query }) => {
  try {
    const list = await modpack.searchResourcepacks(query || '');
    await modpack.attachZhNames(list);
    return { ok: true, list };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('rpack:versions', async (_e, { id, mc }) => {
  try { return { ok: true, list: await modpack.modrinthResourcepackVersions(id, mc || '') }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('rpack:install', async (_e, { url, filename }) => {
  try {
    const cfg = loadConfig();
    const dir = path.join(cfg.mcDir, 'resourcepacks');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, filename);
    const send = (m) => win.webContents.send('install:log', m + '\n');
    await modpack.downloadFile(url, dest, null, send, filename);
    return { ok: true, file: dest };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('rpack:list', () => {
  try {
    const dir = path.join(loadConfig().mcDir, 'resourcepacks');
    if (!fs.existsSync(dir)) return { ok: true, list: [] };
    const list = fs.readdirSync(dir).filter((f) => /\.zip$/i.test(f)).map((f) => {
      let size = 0; try { size = fs.statSync(path.join(dir, f)).size; } catch {}
      return { file: f, size, sizeText: backup.fmtSize(size) };
    });
    return { ok: true, list };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('rpack:open', () => {
  const dir = path.join(loadConfig().mcDir, 'resourcepacks');
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});

// ---------- Mod 更新检查 ----------
function sha1File(p) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}
ipcMain.handle('mod:check-updates', async (_e, { version }) => {
  try {
    const cfg = loadConfig();
    const dir = path.join(cfg.mcDir, 'versions', version, 'mods');
    if (!fs.existsSync(dir)) return { ok: true, list: [] };
    const files = fs.readdirSync(dir).filter((f) => /\.jar$/i.test(f));
    const hashes = {};
    for (const f of files) { try { hashes[f] = sha1File(path.join(dir, f)); } catch {} }
    if (!Object.keys(hashes).length) return { ok: true, list: [] };
    const info = readVersionMeta(cfg.mcDir, version);
    const updates = await modpack.checkModUpdates(hashes, info.mcVersion, '');
    return { ok: true, list: updates, total: files.length };
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

// ---------- 皮肤 / 披风（正版账号） ----------
// 确保当前账号 accessToken 有效（过期/即将过期则自动静默续期）
async function ensureFreshToken(cfg, index) {
  const accs = getAccounts(cfg);
  const idx = typeof index === 'number' ? index : getActiveIndex(cfg);
  const acc = accs[idx];
  if (!acc || acc.offline) throw new Error('请先登录微软正版账号');
  // 令牌 24h 过期，剩余不足 1h 时续期
  const age = Date.now() - (acc.obtainedAt || 0);
  if (!acc.accessToken || age > 23 * 3600 * 1000) {
    if (!acc.refreshToken) throw new Error('登录已失效，请重新登录');
    const info = await authMgr.refreshFlow(acc.refreshToken);
    accs[idx] = Object.assign({}, acc, {
      accessToken: info.accessToken,
      refreshToken: info.refreshToken,
      uuid: info.uuid,
      name: info.name,
      owns: info.owns,
      obtainedAt: info.obtainedAt,
      offline: false
    });
    saveConfig(cfg);
  }
  return { token: accs[idx].accessToken, idx, uuid: accs[idx].uuid, name: accs[idx].name };
}

// 当前账号的皮肤/披风信息
ipcMain.handle('skin:info', async (_e, opts) => {
  try {
    const cfg = loadConfig();
    const acc = activeAccount(cfg);
    if (!acc || acc.offline || !acc.uuid) return { ok: false, error: '请先登录微软正版账号' };
    const { token } = await ensureFreshToken(cfg, typeof (opts && opts.index) === 'number' ? opts.index : undefined);
    const p = await authMgr.refreshProfile(token);
    return {
      ok: true,
      name: p.name,
      uuid: p.id,
      skins: (p.skins || []).map((s) => ({ id: s.id, state: s.state, url: s.url, variant: s.variant })),
      capes: (p.capes || []).map((c) => ({ id: c.id, state: c.state, url: c.url, alias: c.alias }))
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 上传皮肤（本地 png）+ 可选 variant（classic/slim）
ipcMain.handle('skin:upload', async (_e, opts) => {
  try {
    const cfg = loadConfig();
    const { token } = await ensureFreshToken(cfg, typeof (opts && opts.index) === 'number' ? opts.index : undefined);
    let file = opts && opts.file;
    if (!file) {
      const r = await dialog.showOpenDialog(win, {
        title: '选择皮肤文件（PNG，64x64 或 64x32）',
        properties: ['openFile'],
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      file = r.filePaths[0];
    }
    if (!fs.existsSync(file)) return { ok: false, error: '文件不存在' };
    await authMgr.uploadSkin(token, file, opts && opts.variant === 'slim' ? 'slim' : 'classic');
    const p = await authMgr.refreshProfile(token);
    return { ok: true, name: p.name, uuid: p.id, skins: p.skins || [], capes: p.capes || [] };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 设置/取消活动披风（capeId 为空则隐藏）
ipcMain.handle('skin:set-cape', async (_e, opts) => {
  try {
    const cfg = loadConfig();
    const { token } = await ensureFreshToken(cfg, typeof (opts && opts.index) === 'number' ? opts.index : undefined);
    await authMgr.setActiveCape(token, (opts && opts.capeId) || '');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
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

// ---------- 启动提速：跳过不必要的 SHA1 全量校验 ----------
// MCLC 的 handler.getAssets() 对资产索引里的**每个文件**都跑 checkSum（SHA1），
// 14000+ 个文件即使全部命中也要 25~50 秒；libraries 同理。这些文件下载后几乎不会变。
// 做法：用 markers 文件记录“已校验通过”的路径集合，且其 mtime 早于 marker 时间就跳过哈希。
// 若文件被改动（mtime 变新）或首次启动，则照常哈希，不会漏掉真正损坏的文件。
function fastLaunchMarkerPath(mcDir) {
  return path.join(LAUNCHER_DATA, 'cache', 'verified-' + require('crypto').createHash('md5').update(String(mcDir)).digest('hex') + '.json');
}
function loadVerifiedSet(mcDir) {
  try {
    const j = JSON.parse(fs.readFileSync(fastLaunchMarkerPath(mcDir), 'utf8'));
    if (j && j.files && typeof j.files === 'object') return j;
  } catch {}
  return { ts: 0, files: {} };
}
function saveVerifiedSet(mcDir, data) {
  try {
    const p = fastLaunchMarkerPath(mcDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(data));
  } catch {}
}

// 给 launcher 实例打补丁：拦下 handler.checkSum，对已验证且未变更的文件直接返回 true。
// 注意：MCLC 的 handler 是在 launch() 内部才创建的（不在 constructor 里），
// 所以这里改为直接打 Handler 类的原型，不依赖实例创建时机。
function applyFastLaunch(client, mcDir, send) {
  try {
    const Handler = require('minecraft-launcher-core/components/handler');
    if (!Handler || !Handler.prototype || typeof Handler.prototype.checkSum !== 'function') return;
    if (Handler.prototype.__fastPatched) {
      // 已打过补丁：只刷新当前 mcDir 的验证集合
      Handler.prototype.__fastSet(mcDir, send);
      return;
    }
    const orig = Handler.prototype.checkSum;
    const state = { store: null, verified: null, now: Date.now(), skipped: 0, hashed: 0, mcDir };
    Handler.prototype.__fastSet = (dir, snd) => {
      state.mcDir = dir;
      state.store = loadVerifiedSet(dir);
      state.verified = state.store.files || {};
      state.now = Date.now();
      state.skipped = 0;
      state.hashed = 0;
      state.send = snd;
    };
    Handler.prototype.checkSum = async function (hash, file) {
      if (!state.verified) return await orig.call(this, hash, file);
      try {
        const st = fs.statSync(file);
        const rec = state.verified[file];
        if (rec && rec.h === hash && st.mtimeMs <= rec.t) { state.skipped++; return true; }
        state.hashed++;
        const ok = await orig.call(this, hash, file);
        if (ok) state.verified[file] = { h: hash, t: state.now };
        else delete state.verified[file];
        return ok;
      } catch {
        return await orig.call(this, hash, file);
      }
    };
    Handler.prototype.__fastSave = () => {
      if (!state.mcDir) return;
      saveVerifiedSet(state.mcDir, { ts: state.now, files: state.verified || {} });
      if (state.skipped > 0 && state.send) state.send('debug', `快速启动：跳过 ${state.skipped} 个文件的重复校验（新校验 ${state.hashed} 个）`);
    };
    Handler.prototype.__fastPatched = true;
    Handler.prototype.__fastSet(mcDir, send);
  } catch (e) {
    send && send('debug', '启用快速启动失败（不影响启动）：' + (e && e.message ? e.message : e));
  }
}

// ---------- 启动游戏 ----------
ipcMain.handle('mc:launch', async (_e, opts) => {
  const cfg = loadConfig();
  const version = opts.version || cfg.version;
  const send = (level, msg) => win.webContents.send('mc:log', { level, msg: String(msg) });

  // 实例独立启动设置：覆盖全局（仅对独立实例生效）
  const ov = (cfg.instanceOverrides && version && cfg.instanceOverrides[version]) || {};
  if (ov.maxMemory) cfg.maxMemory = ov.maxMemory;
  if (ov.autoJava !== undefined) cfg.autoJava = ov.autoJava;
  if (ov.jvmArgs !== undefined && opts.jvmArgs === undefined) opts = Object.assign({}, opts, { jvmArgs: ov.jvmArgs });
  if (ov.gameArgs !== undefined) cfg.gameArgs = ov.gameArgs;

  // 自动准备 Java
  let javaPath = opts.javaPath || ov.javaPath || cfg.javaPath;
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
  // 启动提速：MCLC 每次启动都会对全部 assets（1.4 万+ 文件）逐个计算 SHA1 校验，
  // 未变时纯属浪费（实测 25~50 秒）。这里把 checkSum 打补丁：对已校验过且自上次
  // 校验后未被修改的 assets / libraries，直接返回 true，跳过重复哈希。
  applyFastLaunch(launcher, cfg.mcDir, send);
  launcher.on('debug', (m) => send('debug', m));
  launcher.on('data', (m) => send('data', m));
  launcher.on('progress', (p) => win.webContents.send('mc:progress', p));
  launcher.on('close', (code) => {
    win.webContents.send('mc:close', code);
    // 游戏已关闭：清理启动器闲置内存（回收 V8/GC 后的工作集），降低后台占用
    trimMemoryLater();
  });

  // 启动前自检：扫描该版本依赖的 libraries，修复损坏的 jar（下载中断会导致 zip 损坏，游戏直接崩溃）
  if (version) {
    try {
      await repairCorruptLibraries(cfg.mcDir, version, send);
    } catch (e) {
      send('debug', '库完整性自检失败（已跳过）：' + (e && e.message ? e.message : e));
    }
  }

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

  // 提取原生库（.dll）到游戏目录（MCLC 对 MC ≥1.19 不再自己提取，否则会因缺少
  // lwjgl_opengl.dll 等直接崩溃退出）
  try {
    const cwdNatives = isInstance ? instDir : cfg.mcDir;
    const nativesDir = await extractNatives(cfg.mcDir, version, cwdNatives, send);
    if (nativesDir) {
      launchOpts.overrides = launchOpts.overrides || {};
      launchOpts.overrides.natives = nativesDir;
    }
  } catch (e) {
    send('debug', '原生库提取失败（已跳过）：' + (e && e.message ? e.message : e));
  }

  try {
    await launcher.launch(launchOpts);
    // 启动成功：持久化本次已验证的文件集合，下次启动直接跳过这些校验
    try { require('minecraft-launcher-core/components/handler').prototype.__fastSave && require('minecraft-launcher-core/components/handler').prototype.__fastSave(); } catch {}
    return { ok: true };
  } catch (err) {
    // 即使启动失败也保存已校验结果（下次仍可复用未变文件的校验）
    try { require('minecraft-launcher-core/components/handler').prototype.__fastSave && require('minecraft-launcher-core/components/handler').prototype.__fastSave(); } catch {}
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
    try { win.webContents.send('install:done', { label: name || '整合包', ok: !!(result && result.ok !== false), result }); } catch {}
    return result;
  } catch (e) {
    try { win.webContents.send('install:done', { label: name || '整合包', ok: false, error: e.message }); } catch {}
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
    try { win.webContents.send('install:done', { label: (ver && ver.name) || '光影包', ok: !!(result && result.ok !== false), result }); } catch {}
    return result;
  } catch (e) {
    try { win.webContents.send('install:done', { label: '光影包', ok: false, error: e.message }); } catch {}
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
    try { win.webContents.send('install:done', { label: '原版 ' + version, ok: !!(result && result.ok !== false), result }); } catch {}
    return result;
  } catch (e) {
    try { win.webContents.send('install:done', { label: '原版 ' + version, ok: false, error: e.message }); } catch {}
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
    try { win.webContents.send('install:done', { label: instanceName || kind, ok: !!(result && result.ok !== false), result }); } catch {}
    return result;
  } catch (e) {
    try { win.webContents.send('install:done', { label: instanceName || kind, ok: false, error: e.message }); } catch {}
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
  return serverMgr.startServer(dir, jp, memory, type, (m) => win.webContents.send('server:log', m + '\n'), (d) => {
    win.webContents.send('server:log', d);
    // 逐行解析：提取聊天/进退/在线人数事件，推送给渲染层
    try {
      for (const rawLine of String(d).split(/\r?\n/)) {
        if (!rawLine.trim()) continue;
        if (serverMgr.setOnlineFromListLine(rawLine)) {
          win.webContents.send('server:online', serverMgr.getOnlinePlayers());
          continue;
        }
        const ev = serverMgr.parseServerLine(rawLine);
        if (ev) {
          win.webContents.send('server:chat', ev);
          if (ev.type === 'join' || ev.type === 'leave') {
            win.webContents.send('server:online', serverMgr.getOnlinePlayers());
          }
        }
        // 状态机：检测 "Done (...)!" → 标记已就绪
        if (/Done \(/.test(rawLine) || /For help, type/.test(rawLine)) {
          win.webContents.send('server:ready');
        }
      }
    } catch {}
  });
});

ipcMain.handle('server:status', () => ({ ok: true, running: serverMgr.isRunning(), ...serverMgr.getState() }));
ipcMain.handle('server:quick-defaults', () => ({ ok: true, ...serverMgr.quickServerDefaults() }));

ipcMain.handle('server:info', async (_e, { dir }) => serverMgr.serverInfo(dir || (cfg && cfg.serverDir) || ''));

ipcMain.handle('server:stop', () => serverMgr.stopServer());
ipcMain.handle('server:cmd', (_e, cmd) => serverMgr.sendCommand(cmd));
// 发送聊天消息到服务器（主机在聊天栏发消息 → 以主机身份广播到游戏内）
ipcMain.handle('server:say', (_e, { text, name }) => {
  if (!serverMgr.isRunning()) return { ok: false, error: '服务器未运行' };
  const msg = String(text || '').trim().slice(0, 240);
  if (!msg) return { ok: false, error: '消息为空' };
  const who = String(name || 'Host').replace(/[\x00-\x1f]/g, '').slice(0, 16) || 'Host';
  // 用 tellraw 广播消息；JSON 组件必须作为行内 JSON 传递（Minecraft 要求合法 JSON）
  // 注意：sendCommand 会直接写入 stdin，命令本身不能带换行（已过滤）
  const component = JSON.stringify([
    { text: '[' + who + '] ', color: 'gold' },
    { text: msg, color: 'white' }
  ]);
  const r = serverMgr.sendCommand('tellraw @a ' + component);
  return r.ok ? { ok: true } : { ok: false, error: r.error || '发送失败' };
});
ipcMain.handle('server:online', () => ({ ok: true, online: serverMgr.getOnlinePlayers(), running: serverMgr.isRunning() }));
ipcMain.handle('server:refresh-online', () => ({ ok: serverMgr.requestOnlineList() }));
ipcMain.handle('server:reset-online', () => { serverMgr.resetOnline(); return { ok: true }; });
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

// 窗口控制：最小化/显示（启动游戏后自动最小化等）
ipcMain.handle('win:minimize', () => {
  try { if (win && !win.isDestroyed()) win.minimize(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('win:show', () => {
  try {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 系统通知（下载/安装完成、游戏退出等）
ipcMain.handle('notify', (_e, opts) => {
  try {
    const { Notification } = require('electron');
    if (!Notification.isSupported()) return { ok: false, error: 'unsupported' };
    const n = new Notification({
      title: (opts && opts.title) || APP_NAME,
      body: (opts && opts.body) || '',
      silent: !!(opts && opts.silent)
    });
    n.on('click', () => {
      try {
        if (win && !win.isDestroyed()) {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      } catch {}
    });
    n.show();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('java:required', (_e, v) => requiredJava(v));

