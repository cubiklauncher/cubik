// 自动拆分自 main.js —— localpackBlock
const { ipcMain, dialog, shell } = require('electron');

module.exports = function register(ctx) {
  const { loadConfig, serverMgr, path, fs, resolveBaseMcVersion, readVersionMeta } = ctx;
  const __win = () => ctx.getWin();

// ---------- 本机已下载的整合包（供建服时直接选包建服） ----------
// 读 versions 下每个实例：从 json 推断 MC 版本 + 加载器，并统计 mods/jar 数量
function _detectPackFromJson(mcDir, name) {
  const jp = path.join(mcDir, 'versions', name, name + '.json');
  let mc = '', loader = '';
  try {
    const j = JSON.parse(fs.readFileSync(jp, 'utf8'));
    const src = j.inheritsFrom || j.id || '';
    const m = String(src).match(/1\.\d+(?:\.\d+)?/);
    if (m) mc = m[0];
    const libs = (j.libraries || []).map((l) => (l.name || '').toLowerCase()).join(' ');
    const mc2 = (j.mainClass || '').toLowerCase();
    if (mc2.includes('fabricmc') || libs.includes('net.fabricmc:')) loader = 'fabric';
    else if (mc2.includes('neoforge') || libs.includes('neoforged:')) loader = 'neoforge';
    else if (mc2.includes('forge') || libs.includes('net.minecraftforge:')) loader = 'forge';
    else if (mc2.includes('minecraft.client.main')) loader = ''; // 纯原版
    else if (j.inheritsFrom) loader = 'fabric';
    // 包名/ id 里没有 MC 版本时，从类库名推断（如 net.minecraftforge:fmlloader:1.20.1-47.4.10）
    if (!mc) {
      for (const l of (j.libraries || [])) {
        const nm = String(l.name || '');
        if (!/minecraftforge|neoforged|fabricmc|^net\.minecraft:/i.test(nm)) continue;
        const mm = nm.match(/:(\d+\.\d+(?:\.\d+)?)(?:[-+]|$)/);
        if (mm && /^1\.\d/.test(mm[1])) { mc = mm[1]; break; }
      }
    }
  } catch {}
  // 兜底：从目录名推断 MC 版本（如 1.20.1）
  if (!mc) { const m = name.match(/(1\.\d+(?:\.\d+)?)/); if (m) mc = m[1]; }
  const md = path.join(mcDir, 'versions', name, 'mods');
  let mods = 0;
  try { if (fs.existsSync(md)) mods = fs.readdirSync(md).filter((f) => /\.jar$/i.test(f)).length; } catch {}
  return { name, mcVersion: mc, loader, modsCount: mods, modsDir: fs.existsSync(md) ? md : '', hasMods: mods > 0 };
}

ipcMain.handle('localpacks:list', async () => {
  try {
    const cfg = loadConfig();
    const vdir = path.join(cfg.mcDir, 'versions');
    const out = [];
    if (fs.existsSync(vdir)) {
      for (const name of fs.readdirSync(vdir)) {
        const full = path.join(vdir, name);
        try { if (!fs.statSync(full).isDirectory()) continue; } catch { continue; }
        const jp = path.join(full, name + '.json');
        if (!fs.existsSync(jp)) continue; // 只有带 json 的才是可识别的实例/整合包
        const info = _detectPackFromJson(cfg.mcDir, name);
        if (!info.mcVersion) continue;      // 推断不出 MC 版本的跳过
        // 只列出"整合包"：有 mods 模组的，或加载器为 fabric/forge/neoforge 的非原版实例
        const isPack = info.modsCount > 0 || info.loader === 'fabric' || info.loader === 'forge' || info.loader === 'neoforge';
        if (!isPack) continue;
        let mtime = 0; try { mtime = fs.statSync(jp).mtimeMs; } catch {}
        out.push({ ...info, mtime });
      }
    }
    out.sort((a, b) => (b.hasMods - a.hasMods) || (b.mtime || 0) - (a.mtime || 0));
    return { ok: true, list: out, mcDir: cfg.mcDir };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 列出某个整合包 mods 目录下的 jar（供建服时预览/勾选）
ipcMain.handle('localpacks:mods', async (_e, { name } = {}) => {
  try {
    const cfg = loadConfig();
    const md = path.join(cfg.mcDir, 'versions', String(name || ''), 'mods');
    if (!name || !fs.existsSync(md)) return { ok: true, list: [], dir: md };
    const list = fs.readdirSync(md).filter((f) => /\.jar$/i.test(f)).map((f) => {
      let sizeKB = 0; try { sizeKB = Math.round(fs.statSync(path.join(md, f)).size / 1024); } catch {}
      return { file: f, sizeKB, path: path.join(md, f) };
    }).sort((a, b) => a.file.localeCompare(b.file));
    return { ok: true, list, dir: md };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 把某个整合包 mods 目录下的所有 jar 复制到目标服务器 mods 目录
ipcMain.handle('localpacks:carry', async (_e, { packName, dir } = {}) => {
  try {
    const cfg = loadConfig();
    const srcMd = path.join(cfg.mcDir, 'versions', String(packName || ''), 'mods');
    if (!packName || !fs.existsSync(srcMd)) return { ok: false, error: '整合包 mods 目录不存在' };
    const files = fs.readdirSync(srcMd).filter((f) => /\.jar$/i.test(f)).map((f) => ({ path: path.join(srcMd, f), name: f }));
    if (!files.length) return { ok: true, carried: 0 };
    const r = serverMgr.installLocalMods(dir, files, (m) => __win().webContents.send('server:log', m + '\n'));
    return { ok: true, carried: (r.added || []).length, skipped: r.skipped || [], errors: r.errors || [] };
  } catch (e) { return { ok: false, error: e.message }; }
});


};
