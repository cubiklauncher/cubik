// 主进程共享上下文：集中管理状态、配置、路径、懒加载模块与跨域辅助函数。
// 各 src/ipc/* 模块通过 register(ctx) 拿到这里的一切，避免互相 import 造成循环依赖。
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { ensureJava, requiredJava } = require('../java');
const { APP_NAME, APP_VERSION, DATA_ROOT } = require('../constants');

// 供 modpack 等模块解析缓存路径
process.env.CUBIK_DATA_ROOT = DATA_ROOT;

// ---- 懒加载重依赖（首次访问才 require）----
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
const authMgr = lazyModule('../auth');
const modpack = lazyModule('../modpack');
const mcmod = lazyModule('../mcmod');
const serverMgr = lazyModule('../server');
const tunnelMgr = lazyModule('../tunnel');
const installer = lazyModule('../installer');
const backup = require('../backup');
const sources = require('../sources');
const telemetry = require('../telemetry');

// ---- 路径 ----
const DRIVE = 'D:\\';
const DEFAULT_MC_DIR = path.join(DRIVE, '.minecraft');
const LAUNCHER_DATA = DATA_ROOT;
const LEGACY_DATA = path.join(DRIVE, 'PCL-Like-Launcher');
const CONFIG_PATH = () => path.join(LAUNCHER_DATA, 'launcher-config.json');
const LEGACY_CONFIG = path.join(LEGACY_DATA, 'launcher-config.json');

function ensureDataDir() {
  try { fs.mkdirSync(LAUNCHER_DATA, { recursive: true }); } catch {}
}

// ---- 窗口引用（可变，用 getter/setter 暴露）----
let _win = null;
function getWin() { return _win; }
function setWin(w) { _win = w; }

// ---- 内存回收 ----
let _trimTimer = null;
function trimMemoryLater(delay = 15000) {
  if (_trimTimer) clearTimeout(_trimTimer);
  _trimTimer = setTimeout(() => {
    _trimTimer = null;
    try { if (_win && !_win.isDestroyed()) _win.webContents.send('mc:collect'); } catch {}
  }, delay);
}

// ---- 下载源 ----
function applySource(src) {
  let key = String(src || 'domestic').toLowerCase();
  if (['bmclapi', 'aliyun', 'mcbbs', 'mirror', 'cn'].includes(key)) key = 'domestic';
  else if (['mojang', 'official', 'origin'].includes(key)) key = 'official';
  else if (key === 'auto') key = 'auto';
  else key = 'domestic';
  sources.setMode(key);
  try { modpack.setSource(key); } catch {}
  try { sources.applyEnv(); } catch {}
  return key;
}

// ---- 配置 ----
function loadConfig() {
  ensureDataDir();
  try {
    if (!fs.existsSync(CONFIG_PATH()) && fs.existsSync(LEGACY_CONFIG)) {
      fs.copyFileSync(LEGACY_CONFIG, CONFIG_PATH());
    }
  } catch {}
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_PATH(), 'utf8'));
    if (!c.mcDir || /^C:/i.test(c.mcDir) || !c.mcDir.startsWith(DRIVE)) c.mcDir = DEFAULT_MC_DIR;
    if (!c.serverDir || /^C:/i.test(c.serverDir) || !c.serverDir.startsWith(DRIVE))
      c.serverDir = path.join(DEFAULT_MC_DIR, 'server');
    if (c.downloadSource) applySource(c.downloadSource);
    else applySource('domestic');
    if (c.cfApiKey) modpack.setCfKey(c.cfApiKey);
    if (!Array.isArray(c.servers)) c.servers = [];
    c.servers = c.servers.filter((s) => s && typeof s.dir === 'string' && s.dir);
    c.servers.forEach((s) => { if (!s.id) s.id = 'srv_' + Math.random().toString(36).slice(2, 9); if (!s.name) s.name = path.basename(s.dir) || 'Server'; });
    if (!c.servers.length && c.serverDir) {
      c.servers.push({ id: 'srv_default', name: path.basename(c.serverDir) || 'Server', dir: c.serverDir, type: '', mcVersion: '', memory: 2048 });
    }
    if (!c.activeServerId || !c.servers.some((s) => s.id === c.activeServerId)) {
      c.activeServerId = c.servers.length ? c.servers[0].id : '';
    }
    const act = c.servers.find((s) => s.id === c.activeServerId);
    if (act) c.serverDir = act.dir;
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
      serverDir: path.join(DEFAULT_MC_DIR, 'server'),
      servers: [{ id: 'srv_default', name: 'server', dir: path.join(DEFAULT_MC_DIR, 'server'), type: '', mcVersion: '', memory: 2048 }],
      activeServerId: 'srv_default'
    };
  }
}

function saveConfig(cfg) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_PATH(), JSON.stringify(cfg, null, 2), 'utf8');
}

// ---- 后台补全中文常用名 ----
let zhEnrichRunning = false;
function backgroundEnrichZh(list) {
  if (!Array.isArray(list) || !list.length) return;
  const run = async () => {
    if (zhEnrichRunning) return;
    zhEnrichRunning = true;
    try {
      const updates = await modpack.enrichZhNames(list, 8);
      if (updates && updates.length && _win && !_win.isDestroyed()) {
        try { _win.webContents.send('pack:zhname', updates); } catch {}
      }
    } catch {} finally {
      zhEnrichRunning = false;
    }
  };
  setTimeout(run, 400);
}

// ---- 共享辅助函数（从 main.js 提升，供各 ipc 域复用）----

// ---------- Mod 更新检查 ----------
function sha1File(p) {
  const crypto = require('crypto');
  const h = crypto.createHash('sha1');
  h.update(fs.readFileSync(p));
  return h.digest('hex');
}

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
  const mp = require('../modpack');
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

function autoBackupConfig() {
  const c = loadConfig();
  const ab = c.serverAutoBackup || {};
  return {
    enabled: ab.enabled !== false,
    intervalMin: Math.max(1, Math.min(1440, parseInt(ab.intervalMin, 10) || 30)),
    keep: Math.max(1, Math.min(100, parseInt(ab.keep, 10) || 10))
  };
}

async function runAutoBackup(reason) {
  const dir = srvDir();
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: '服务器目录不存在' };
  // 运行中的服务器先强制存盘，保证备份一致
  if (serverMgr.isRunning()) {
    try { serverMgr.sendCommand('save-all'); } catch {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  const cfgAB = autoBackupConfig();
  const note = reason || '自动存档';
  const r = backup.backupServerWorld(dir, note);
  pruneServerBackups(dir, cfgAB.keep);
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('server:autobackup', { ok: true, ...r, note, at: Date.now() }); } catch {}
  }
  return r;
}

function restartAutoBackupTimer() {
  if (autoBackupTimer) { clearInterval(autoBackupTimer); autoBackupTimer = null; }
  const ab = autoBackupConfig();
  if (!ab.enabled) return;
  const ms = ab.intervalMin * 60 * 1000;
  autoBackupTimer = setInterval(() => {
    // 仅在服务器运行中自动存档（避免空转）
    try {
      if (serverMgr.isRunning()) runAutoBackup('自动存档');
    } catch {}
  }, ms);
  // 不阻塞进程退出
  if (autoBackupTimer.unref) autoBackupTimer.unref();
}

// ---- srvDir ----
const srvDir = () => path.join(loadConfig().serverDir || path.join(loadConfig().mcDir, 'server'));

module.exports = {
  path, fs, app, APP_NAME, APP_VERSION, DATA_ROOT,
  ensureJava, requiredJava, getMLC,
  authMgr, modpack, mcmod, serverMgr, tunnelMgr, installer, backup, sources, telemetry,
  DRIVE, DEFAULT_MC_DIR, LAUNCHER_DATA, LEGACY_DATA, CONFIG_PATH, LEGACY_CONFIG,
  ensureDataDir, getWin, setWin, trimMemoryLater, applySource, loadConfig, saveConfig, backgroundEnrichZh, srvDir,
  sha1File, getAccounts, getActiveIndex, activeAccount, publicAccounts, publicAccount, fastLaunchMarkerPath, loadVerifiedSet, saveVerifiedSet, applyFastLaunch, readVersionMeta, mergeVersionJson, resolveBaseMcVersion, extractNatives, repairCorruptLibraries, autoBackupConfig, runAutoBackup, restartAutoBackupTimer
};
