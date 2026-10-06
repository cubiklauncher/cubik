// 自动拆分自 main.js —— worldBlock + rpackBlock
const { ipcMain, dialog, shell } = require('electron');

module.exports = function register(ctx) {
  const { loadConfig, backup, modpack, backgroundEnrichZh, path, fs } = ctx;
  const __win = () => ctx.getWin();

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

// 服务器存档备份（serverDir 下的世界）
ipcMain.handle('server-world:info', () => {
  try { return { ok: true, info: backup.serverWorldInfo(srvDir()) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-world:backup', (_e, { note } = {}) => {
  try { return backup.backupServerWorld(srvDir(), note); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-world:backups', () => {
  try { return { ok: true, list: backup.listServerBackups(srvDir()) }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-world:restore', (_e, { file }) => {
  try { return backup.restoreServerWorld(srvDir(), file); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-world:backup-delete', (_e, { file }) => {
  try { return backup.deleteServerBackup(srvDir(), file); }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('server-world:open', () => {
  const dir = srvDir();
  fs.mkdirSync(dir, { recursive: true });
  return shell.openPath(dir);
});


// ---------- 资源包 ----------
ipcMain.handle('rpack:search', async (_e, { query }) => {
  try {
    const list = await modpack.searchResourcepacks(query || '');
    modpack.attachZhNames(list);
    backgroundEnrichZh(list);
    return { ok: true, list };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('rpack:versions', async (_e, { id, mc }) => {
  try { return { ok: true, list: await modpack.modrinthResourcepackVersions(id, mc || '') }; }
  catch (e) { return { ok: false, error: e.message }; }
});
// 资源包目录：指定版本时用「版本目录/resourcepacks」，否则用全局 .minecraft/resourcepacks
function rpackDir(version) {
  const cfg = loadConfig();
  if (version) {
    const dir = path.join(cfg.mcDir, 'versions', version, 'resourcepacks');
    return dir;
  }
  return path.join(cfg.mcDir, 'resourcepacks');
}

ipcMain.handle('rpack:install', async (_e, { url, filename, version }) => {
  try {
    const dir = rpackDir(version || '');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, filename);
    const msg = (m) => { try { __win().webContents.send('install:log', m + '\n'); } catch {} };
    await modpack.downloadFile(url, dest, null, msg, filename);
    return { ok: true, file: dest };
  } catch (e) { return { ok: false, error: e.message }; }
});
// 资源包全量安装：把版本的所有文件（含前置）按序下载到目标版本目录
ipcMain.handle('rpack:install-full', async (_e, { id, versionId, version, name, source }) => {
  try {
    const dir = rpackDir(version || '');
    fs.mkdirSync(dir, { recursive: true });
    const label = name || id;
    const send = (payload) => { try { __win().webContents.send('install:progress', payload); } catch {} };
    const files = await modpack.collectInstallFiles({ source, id, versionId });
    if (!files || !files.length) return { ok: false, error: '该版本没有可下载文件' };
    const total = files.length;
    const done = [];
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      send({ pct: Math.round((i / total) * 100), done: i, total, label: `下载 ${label}（${i + 1}/${total}）` });
      const dest = path.join(dir, f.filename);
      await modpack.downloadFile(f.url, dest, null, (m) => { try { __win().webContents.send('install:log', m + '\n'); } catch {} }, f.filename);
      done.push(f.filename);
    }
    send({ pct: 100, done: total, total, label: '完成' });
    return { ok: true, dir, count: total, files: done };
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


};
