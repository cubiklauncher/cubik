// 自动拆分自 main.js —— versionBlock
const { ipcMain, dialog, shell } = require('electron');

module.exports = function register(ctx) {
  const { loadConfig, saveConfig, modpack, path, fs, readVersionMeta, mergeVersionJson, resolveBaseMcVersion, extractNatives, repairCorruptLibraries } = ctx;
  const __win = () => ctx.getWin();

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


};
