// 自动拆分自 main.js —— srvBackupBlock + serverBlock
const { ipcMain, dialog, shell } = require('electron');

module.exports = function register(ctx) {
  const { loadConfig, saveConfig, serverMgr, tunnelMgr, backup, APP_NAME, LAUNCHER_DATA, DEFAULT_MC_DIR, ensureJava, requiredJava, path, fs, autoBackupConfig, runAutoBackup, restartAutoBackupTimer, srvDir } = ctx;
  const __win = () => ctx.getWin();

// ---------- 服务器自动存档（定时自动备份 + 保留最近 N 份）----------
let autoBackupTimer = null;

// 清理旧备份，仅保留最近 keep 份
function pruneServerBackups(dir, keep) {
  try {
    const list = backup.listServerBackups(dir); // 已按时间倒序
    for (let i = keep; i < list.length; i++) {
      try { backup.deleteServerBackup(dir, list[i].file); } catch {}
    }
  } catch {}
}

ipcMain.handle('server-auto-backup:get', () => ({ ok: true, ...autoBackupConfig() }));
ipcMain.handle('server-auto-backup:set', (_e, opts = {}) => {
  try {
    const c = loadConfig();
    c.serverAutoBackup = {
      enabled: opts.enabled !== false,
      intervalMin: Math.max(1, Math.min(1440, parseInt(opts.intervalMin, 10) || 30)),
      keep: Math.max(1, Math.min(100, parseInt(opts.keep, 10) || 10))
    };
    saveConfig(c);
    restartAutoBackupTimer();
    return { ok: true, ...autoBackupConfig() };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-auto-backup:run-now', async () => {
  try { return { ok: true, ...(await runAutoBackup('手动自动存档')) }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ---------- 服务器自动更新 ----------
ipcMain.handle('server-update:check', async () => {
  try { return { ok: true, ...(await serverMgr.checkServerUpdate(srvDir())) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-update:apply', async () => {
  try {
    if (serverMgr.isRunning()) return { ok: false, error: '请先停止服务器再更新' };
    const r = await serverMgr.updateServerJar(
      srvDir(),
      (m) => { try { __win().webContents.send('server:log', m + '\n'); } catch {} },
      (got, total) => { try { __win().webContents.send('server:progress', { task: got, total }); } catch {} }
    );
    if (r && r.ok) restartAutoBackupTimer();
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
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


// ---------- 服务器管理 ----------
ipcMain.handle('server:create', async (_e, opts) => {
  try {
    const cfg = loadConfig();
    const r = await serverMgr.createServer(
      { ...opts, mcDir: opts.mcDir || cfg.mcDir || 'D:\\CubikLauncher' },
      (got, total) => __win().webContents.send('server:progress', { task: got, total }),
      (m) => __win().webContents.send('server:log', m + '\n')
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
        __win().webContents.send('server:log', m + '\n')
      );
    } catch (e) {
      __win().webContents.send('server:log', '未找到 Java，将尝试系统 java：' + e.message + '\n');
    }
  }
  return serverMgr.startServer(dir, jp, memory, type, (m) => __win().webContents.send('server:log', m + '\n'), (d) => {
    __win().webContents.send('server:log', d);
    // 逐行解析：提取聊天/进退/在线人数事件，推送给渲染层
    try {
      for (const rawLine of String(d).split(/\r?\n/)) {
        if (!rawLine.trim()) continue;
        if (serverMgr.setOnlineFromListLine(rawLine)) {
          __win().webContents.send('server:online', serverMgr.getOnlinePlayers());
          continue;
        }
        const ev = serverMgr.parseServerLine(rawLine);
        if (ev) {
          __win().webContents.send('server:chat', ev);
          if (ev.type === 'join' || ev.type === 'leave') {
            __win().webContents.send('server:online', serverMgr.getOnlinePlayers());
          }
        }
        // 状态机：检测 "Done (...)!" → 标记已就绪
        if (/Done \(/.test(rawLine) || /For help, type/.test(rawLine)) {
          __win().webContents.send('server:ready');
        }
      }
    } catch {}
  });
});

ipcMain.handle('server:status', () => ({ ok: true, running: serverMgr.isRunning(), ...serverMgr.getState() }));
ipcMain.handle('server:quick-defaults', () => ({ ok: true, ...serverMgr.quickServerDefaults() }));

// ---------- 多服务器管理 ----------
ipcMain.handle('server:list', async () => {
  try {
    const c = loadConfig();
    const list = await Promise.all((c.servers || []).map(async (s) => {
      let info = {};
      try { info = serverMgr.detectServer(s.dir) || {}; } catch {}
      const exists = !!(s.dir && fs.existsSync(s.dir));
      const running = serverMgr.isRunning() && serverMgr.getState().dir === s.dir;
      return {
        ...s,
        exists,
        running,
        detectedType: info.type || '',
        detectedType2: info.current || '',
        detectedMc: info.mcVersion || '',
        isActive: s.id === c.activeServerId,
      };
    }));
    return { ok: true, list, activeServerId: c.activeServerId || '' };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('server:add', async (_e, opts = {}) => {
  try {
    const c = loadConfig();
    if (!Array.isArray(c.servers)) c.servers = [];
    const dir = String(opts.dir || '').trim();
    if (!dir) throw new Error('请指定服务器目录');
    if (c.servers.some((s) => path.resolve(s.dir) === path.resolve(dir))) throw new Error('该目录已在列表中');
    let info = {};
    try { info = serverMgr.detectServer(dir) || {}; } catch {}
    const srv = {
      id: 'srv_' + Math.random().toString(36).slice(2, 9),
      name: String(opts.name || path.basename(dir) || 'Server').slice(0, 40),
      dir,
      type: opts.type || info.type || '',
      mcVersion: opts.mcVersion || info.mcVersion || '',
      memory: parseInt(opts.memory, 10) || 2048,
    };
    c.servers.push(srv);
    c.activeServerId = srv.id;
    c.serverDir = srv.dir;
    saveConfig(c);
    return { ok: true, server: srv, activeServerId: srv.id };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('server:remove', async (_e, { id }) => {
  try {
    const c = loadConfig();
    if (!Array.isArray(c.servers)) c.servers = [];
    const srv = c.servers.find((s) => s.id === id);
    if (!srv) throw new Error('未找到该服务器');
    if (serverMgr.isRunning() && serverMgr.getState().dir === srv.dir) throw new Error('该服务器正在运行，请先停止再移除');
    c.servers = c.servers.filter((s) => s.id !== id);
    if (c.activeServerId === id) {
      c.activeServerId = c.servers.length ? c.servers[0].id : '';
      c.serverDir = c.servers.length ? c.servers[0].dir : path.join(DEFAULT_MC_DIR, 'server');
    }
    saveConfig(c);
    return { ok: true, activeServerId: c.activeServerId };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('server:switch', async (_e, { id }) => {
  try {
    const c = loadConfig();
    const srv = (c.servers || []).find((s) => s.id === id);
    if (!srv) throw new Error('未找到该服务器');
    if (serverMgr.isRunning()) {
      const st = serverMgr.getState();
      if (st.dir && st.dir !== srv.dir) throw new Error('当前服务器正在运行，请先停止再切换');
    }
    c.activeServerId = srv.id;
    c.serverDir = srv.dir;
    saveConfig(c);
    return { ok: true, server: srv, activeServerId: srv.id };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('server:rename', async (_e, { id, name }) => {
  try {
    const c = loadConfig();
    const srv = (c.servers || []).find((s) => s.id === id);
    if (!srv) throw new Error('未找到该服务器');
    srv.name = String(name || '').trim().slice(0, 40) || srv.name;
    saveConfig(c);
    return { ok: true, server: srv };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('server:info', async (_e, { dir }) => serverMgr.serverInfo(dir || (cfg && cfg.serverDir) || ''));

// ---------- 服务端 Mod 管理 ----------
const srvModDir = (d) => d || loadConfig().serverDir || path.join(loadConfig().mcDir, 'server');
ipcMain.handle('srvmod:list', (_e, { dir }) => {
  try { return serverMgr.listServerMods(srvModDir(dir)); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('srvmod:install', async (_e, { dir, url, filename }) => {
  try {
    const r = await serverMgr.installServerMod(
      srvModDir(dir), { url, filename },
      (got, total) => { if (__win() && !__win().isDestroyed()) __win().webContents.send('srvmod:progress', { got, total }); },
      (m) => { if (__win() && !__win().isDestroyed()) __win().webContents.send('server:log', m + '\n'); }
    );
    return r;
  } catch (e) { return { ok: false, error: e.message }; }
});
// 批量安装：建服时一次装多个 Mod（含前置）到新服务器
ipcMain.handle('srvmod:install-many', async (_e, { dir, files }) => {
  try {
    const d = srvModDir(dir);
    const list = Array.isArray(files) ? files : [];
    const done = []; const failed = [];
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      try {
        if (__win() && !__win().isDestroyed()) __win().webContents.send('srvmod:progress', { got: i, total: list.length, label: `安装 Mod ${i + 1}/${list.length}：${f.filename}` });
        await serverMgr.installServerMod(d, { url: f.url, filename: f.filename }, null,
          (m) => { if (__win() && !__win().isDestroyed()) __win().webContents.send('server:log', m + '\n'); });
        done.push(f.filename);
      } catch (e) { failed.push({ filename: f.filename, error: e.message }); }
    }
    if (__win() && !__win().isDestroyed()) __win().webContents.send('srvmod:progress', { got: list.length, total: list.length, label: '完成' });
    return { ok: true, installed: done.length, failed };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('srvmod:toggle', (_e, { dir, file, disabled }) => {
  try { return serverMgr.toggleServerMod(srvModDir(dir), file, disabled); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('srvmod:delete', (_e, { dir, file }) => {
  try { return serverMgr.deleteServerMod(srvModDir(dir), file); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('srvmod:open', (_e, { dir }) => {
  const md = serverMgr.serverModsDir(srvModDir(dir));
  try { fs.mkdirSync(md, { recursive: true }); } catch {}
  shell.openPath(md);
  return { ok: true, dir: md };
});

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
    const exe = await tunnelMgr.downloadFrp(LAUNCHER_DATA, (m) => { try { __win().webContents.send('tunnel:log', m + '\n'); } catch {} });
    return { ok: true, exe };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('tunnel:start', (_e, cfg) => {
  try {
    const r = tunnelMgr.startTunnel(LAUNCHER_DATA, cfg,
      (m) => { try { __win().webContents.send('tunnel:log', m + '\n'); } catch {} },
      (d) => { try { __win().webContents.send('tunnel:log', d); } catch {} });
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
  try { if (__win() && !__win().isDestroyed()) __win().minimize(); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('win:show', () => {
  try {
    if (__win() && !__win().isDestroyed()) {
      if (__win().isMinimized()) __win().restore();
      __win().show();
      __win().focus();
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
        if (__win() && !__win().isDestroyed()) {
          if (__win().isMinimized()) __win().restore();
          __win().show();
          __win().focus();
        }
      } catch {}
    });
    n.show();
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('java:required', (_e, v) => requiredJava(v));


};
