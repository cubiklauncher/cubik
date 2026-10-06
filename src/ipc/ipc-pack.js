// 自动拆分自 main.js —— packBlock
const { ipcMain, dialog, shell } = require('electron');

module.exports = function register(ctx) {
  const { loadConfig, modpack, installer, backgroundEnrichZh, path, fs, readVersionMeta, resolveBaseMcVersion } = ctx;
  const __win = () => ctx.getWin();

// ---------- 整合包搜索/安装 ----------
ipcMain.handle('pack:search', async (_e, { source, query, type }) => {
  try {
    const list =
      source === 'curseforge'
        ? await modpack.searchCurseForge(query)
        : await modpack.searchByType(query, type || 'modpack');
    modpack.attachZhNames(list);
    backgroundEnrichZh(list);
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
    const send = (m) => __win().webContents.send('install:log', m + '\n');
    const result = await installer.installModpack(
      {
        mcDir: cfg.mcDir,
        name: name || id,
        mrpackUrl: f.url,
        mrpackName: f.filename,
        mcVersionHint: (ver.mc || [])[0]
      },
      (pct, done, total, label) => __win().webContents.send('install:progress', { pct, done, total, label }),
      send
    );
    try { __win().webContents.send('install:done', { label: name || '整合包', ok: !!(result && result.ok !== false), result }); } catch {}
    return result;
  } catch (e) {
    try { __win().webContents.send('install:done', { label: name || '整合包', ok: false, error: e.message }); } catch {}
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
    const send = (m) => __win().webContents.send('install:log', m + '\n');
    const result = await installer.installShader(
      { mcDir: cfg.mcDir, name: id, url: f.url, filename: f.filename },
      (got, total, label) => __win().webContents.send('install:progress', { pct: total ? Math.round((got / total) * 100) : 0, done: got, total, label }),
      send
    );
    try { __win().webContents.send('install:done', { label: (ver && ver.name) || '光影包', ok: !!(result && result.ok !== false), result }); } catch {}
    return result;
  } catch (e) {
    try { __win().webContents.send('install:done', { label: '光影包', ok: false, error: e.message }); } catch {}
    return { ok: false, error: e.message };
  }
});

// 热门榜单（整合包 / 光影包）
ipcMain.handle('pack:top', async (_e, { type, offset }) => {
  try {
    const list = await modpack.topProjects(type || 'modpack', 20, offset || 0);
    modpack.attachZhNames(list);
    backgroundEnrichZh(list);
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 光影包搜索
ipcMain.handle('shader:search', async (_e, { query }) => {
  try {
    const list = await modpack.searchShaders(query);
    modpack.attachZhNames(list);
    backgroundEnrichZh(list);
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
    const { download } = require('../java');
    await download(
      f.url,
      dest,
      (got, total) => __win().webContents.send('mc:progress', { type: '光影包', task: got, total }),
      (m) => __win().webContents.send('mc:log', { level: 'debug', msg: m })
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
    const { download } = require('../java');
    await download(f.url, dest, (got, total) => __win().webContents.send('mc:progress', { type: '整合包', task: got, total }), (m) => __win().webContents.send('mc:log', { level: 'debug', msg: m }));
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
    const send = (m) => __win().webContents.send('install:log', m + '\n');
    const result = await modpack.installVanillaVersion(
      version,
      cfg.mcDir,
      (done, total, label) => __win().webContents.send('install:progress', { pct: total ? Math.round((done / total) * 100) : 0, done, total, label: label || '下载中' }),
      send
    );
    try { __win().webContents.send('install:done', { label: '原版 ' + version, ok: !!(result && result.ok !== false), result }); } catch {}
    return result;
  } catch (e) {
    try { __win().webContents.send('install:done', { label: '原版 ' + version, ok: false, error: e.message }); } catch {}
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
    const send = (m) => __win().webContents.send('install:log', m + '\n');
    const result = await installer.installLoaderVersion(
      kind,
      cfg.mcDir,
      instanceName,
      mcVersion,
      loaderVersion,
      (done, total, label) => __win().webContents.send('install:progress', { pct: total ? Math.round((done / total) * 100) : 0, done, total, label: label || '安装中' }),
      send
    );
    try { __win().webContents.send('install:done', { label: instanceName || kind, ok: !!(result && result.ok !== false), result }); } catch {}
    return result;
  } catch (e) {
    try { __win().webContents.send('install:done', { label: instanceName || kind, ok: false, error: e.message }); } catch {}
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
    const send = (m) => __win().webContents.send('install:log', m + '\n');
    const result = await installer.installAddon(
      kind,
      cfg.mcDir,
      baseVersion,
      addonVersion,
      (done, total, label) => __win().webContents.send('install:progress', { pct: total ? Math.round((done / total) * 100) : 0, done, total, label: label || '安装中' }),
      send
    );
    return result;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});


};
