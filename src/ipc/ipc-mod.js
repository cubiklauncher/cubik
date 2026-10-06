// 自动拆分自 main.js —— modBlock + modUpdBlock
const { ipcMain, dialog, shell } = require('electron');

module.exports = function register(ctx) {
  const { loadConfig, modpack, backgroundEnrichZh, path, fs, readVersionMeta, sha1File } = ctx;
  const __win = () => ctx.getWin();

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
    const r = await dialog.showOpenDialog(__win(), {
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
    modpack.attachZhNames(list);
    backgroundEnrichZh(list);
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
    const send = (m) => __win().webContents.send('install:log', m + '\n');
    await modpack.downloadFile(url, dest, null, send, filename);
    send(`✔ 已下载 Mod: ${filename}`);
    return { ok: true, file: dest };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 查询某个 mod 版本的「前置 Mod」（依赖）
ipcMain.handle('mod:deps', async (_e, { source, id, fileId, versionId, mcVersion, loader }) => {
  try {
    return await modpack.modDependencies({ source, id, fileId, versionId, mcVersion, loader });
  } catch (e) { return { ok: false, error: e.message, dependencies: [] }; }
});

// 下载一个前置 Mod 到实例的 mods 文件夹（成功后返回文件名，交给前端标记已装）
ipcMain.handle('mod:install-dep', async (_e, { version, url, filename }) => {
  try {
    const cfg = loadConfig();
    const dir = path.join(cfg.mcDir, 'versions', version, 'mods');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, filename);
    const send = (m) => __win().webContents.send('install:log', m + '\n');
    await modpack.downloadFile(url, dest, null, send, filename);
    send(`✔ 已下载前置 Mod: ${filename}`);
    return { ok: true, file: dest };
  } catch (e) { return { ok: false, error: e.message }; }
});



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


};
