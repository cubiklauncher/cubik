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

// ---------- 整合包创作 / 导出（本地实例 → 可分享 .mrpack） ----------
// 导出为 Modrinth 兼容格式（modrinth.index.json + overrides/），可被本启动器直接再导入。
// 导出内容：manifest（MC 版本、加载器、模组清单）+ mods 文件夹 + 实例配置（config/options 等），
// 不打包游戏本体 / 大型缓存（saves、logs、crash-reports、libraries 等）。

// 从版本 JSON 推断加载器与加载器版本号
function _detectLoaderVersion(json) {
  const mainClass = String(json.mainClass || '').toLowerCase();
  const libs = (json.libraries || []).map((l) => (l.name || '').toLowerCase()).join(' ');
  let kind = 'vanilla';
  let version = '';
  if (mainClass.includes('fabricmc') || libs.includes('net.fabricmc:')) kind = 'fabric';
  else if (mainClass.includes('neoforge') || libs.includes('neoforged:')) kind = 'neoforge';
  else if (mainClass.includes('forge') || libs.includes('net.minecraftforge:')) kind = 'forge';
  // 从库名提取加载器版本：net.fabricmc:fabric-loader:0.15.11 / net.minecraftforge:forge:1.20.1-47.4.10 / net.neoforged:neoforge:20.4.237
  const m = String(json.libraries || []).match(/(?:fabric-loader|forge|neoforge):([0-9][^"',\s]*?)["',]/i);
  if (m) version = m[1].replace(/[^0-9.\-]/g, '');
  // fabric 常见形式 net.fabricmc:fabric-loader:0.15.11（无前缀）
  if (!version && kind === 'fabric') {
    const fm = String(json.libraries || []).match(/fabric-loader:([0-9.]+)/i);
    if (fm) version = fm[1];
  }
  return { kind, version };
}

ipcMain.handle('pack:export', async (_e, { instanceName, packName, packVersion, author, description, outDir } = {}) => {
  try {
    if (!instanceName) return { ok: false, error: '请先选择要导出的实例' };
    const cfg = loadConfig();
    const instanceDir = path.join(cfg.mcDir, 'versions', String(instanceName));
    if (!fs.existsSync(instanceDir)) return { ok: false, error: '实例目录不存在：' + instanceName };
    const jsonPath = path.join(instanceDir, String(instanceName) + '.json');
    if (!fs.existsSync(jsonPath)) return { ok: false, error: '该实例缺少版本 JSON，无法导出' };

    const send = (m) => __win().webContents.send('install:log', m + '\n');
    const prog = (pct, done, total, label) => __win().webContents.send('install:progress', { pct, done, total, label });

    send('开始导出整合包：' + instanceName);
    const vjson = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const mcVersion = resolveBaseMcVersion(cfg.mcDir, String(instanceName)) || '';
    const { kind: loader, version: loaderVersion } = _detectLoaderVersion(vjson);

    // 目标文件名（非法字符已清洗）
    const safeName = String(packName || instanceName).replace(/[<>:"/\\|?*\s]+/g, '_').slice(0, 60) || 'modpack';
    const finalOutDir = outDir || path.join(cfg.mcDir, 'exports');
    fs.mkdirSync(finalOutDir, { recursive: true });
    const outFile = path.join(finalOutDir, safeName + '.mrpack');

    // 收集 mods 清单（instanceDir/mods 下的 .jar）
    prog(5, 0, 1, '收集模组清单');
    const modsDir = path.join(instanceDir, 'mods');
    const mods = [];
    if (fs.existsSync(modsDir)) {
      for (const f of fs.readdirSync(modsDir)) {
        if (!/\.jar$/i.test(f)) continue;
        const fp = path.join(modsDir, f);
        let size = 0; try { size = fs.statSync(fp).size; } catch {}
        mods.push({ filename: f, sizeBytes: size });
      }
    }

    // 构建 Modrinth 兼容 manifest
    const deps = { minecraft: mcVersion || '1.20.1' };
    if (loader === 'fabric') deps['fabric-loader'] = loaderVersion || '0.15.11';
    else if (loader === 'forge') deps['forge'] = loaderVersion || '';
    else if (loader === 'neoforge') deps['neoforge'] = loaderVersion || '';
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: mcVersion || '1.20.1',
      name: packName || String(instanceName),
      summary: description || '',
      author: author || '',
      dependencies: deps,
      files: [],
      mods
    };

    // 用 adm-zip 打包（跨平台，无需外部 tar）
    const AdmZip = (() => { try { return require('adm-zip'); } catch { return null; } })();
    if (!AdmZip) return { ok: false, error: '缺少 adm-zip 依赖，无法打包' };
    const zip = new AdmZip();

    prog(25, 0, 1, '写入整合包清单');
    zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, null, 2), 'utf8'));

    // 复制 mods 到 overrides/mods（保证 round-trip：导入时会原样拷贝回实例）
    if (mods.length) {
      send(`打包 ${mods.length} 个模组`);
      mods.forEach((m, i) => {
        zip.addLocalFile(path.join(modsDir, m.filename), 'overrides/mods');
        prog(30 + Math.round((i / mods.length) * 40), i, mods.length, '打包模组');
      });
    }

    // 复制实例配置（config / options.txt 等），排除大型缓存与游戏本体
    prog(72, 0, 1, '复制实例配置');
    const SKIP = new Set(['mods', 'saves', 'logs', 'crash-reports', 'libraries', 'versions', 'natives', 'shaderpacks', 'resourcepacks', 'screenshots', 'texturepacks']);
    const walk = (dir, rel) => {
      let count = 0;
      if (!fs.existsSync(dir)) return count;
      for (const e of fs.readdirSync(dir)) {
        const abs = path.join(dir, e);
        const r = rel ? rel + '/' + e : e;
        let st; try { st = fs.statSync(abs); } catch { continue; }
        if (st.isDirectory()) {
          if (SKIP.has(e)) continue;
          count += walk(abs, r);
        } else {
          // 跳过版本 json / jar（游戏本体，由 manifest + 加载器安装负责）
          if (e === String(instanceName) + '.json' || e === String(instanceName) + '.jar') continue;
          zip.addLocalFile(abs, 'overrides' + (rel ? '/' + rel : ''));
          count++;
        }
      }
      return count;
    };
    const cfgCount = walk(instanceDir, '');
    if (cfgCount) send(`打包 ${cfgCount} 个实例配置文件`);

    prog(88, 0, 1, '压缩打包');
    await new Promise((res, rej) => { try { zip.writeZip(outFile); res(); } catch (err) { rej(err); } });
    prog(100, 1, 1, '完成');
    send('✔ 整合包导出完成: ' + outFile);
    return { ok: true, file: outFile, dir: finalOutDir, name: safeName, mcVersion, loader, modsCount: mods.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});


};
