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
ipcMain.handle('rpack:install', async (_e, { url, filename }) => {
  try {
    const cfg = loadConfig();
    const dir = path.join(cfg.mcDir, 'resourcepacks');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, filename);
    const send = (m) => __win().webContents.send('install:log', m + '\n');
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


};
