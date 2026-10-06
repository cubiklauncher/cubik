// 自动拆分自 main.js —— searchBlock + mcmodBlock
const { ipcMain, dialog, shell } = require('electron');

module.exports = function register(ctx) {
  const { modpack, mcmod, backgroundEnrichZh, path, fs } = ctx;
  const __win = () => ctx.getWin();

// ---------- 综合搜索（Modrinth + CurseForge 合并） ----------
ipcMain.handle('search:all', async (_e, { kind, query, mcVersion, loader }) => {
  try {
    const list = await modpack.searchAll(kind || 'modpack', query, { mcVersion, loader });
    modpack.attachZhNames(list);
    backgroundEnrichZh(list);
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});


// ---------- MC 百科（mcmod.cn）中文搜索源 ----------
ipcMain.handle('mcmod:search', async (_e, { query, kind } = {}) => {
  try {
    const list = await mcmod.searchMcmod(query || '', kind || '');
    return { ok: true, list };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('mcmod:hot', async (_e, { kind, limit } = {}) => {
  try {
    const r = await mcmod.hotMods(limit || 30, kind === 'modpack' ? 'modpack' : 'mod');
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('mcmod:prereqs', async (_e, { id, kind } = {}) => {
  try {
    const r = await mcmod.fetchPrereqs(id, kind === 'modpack' ? 'modpack' : 'class');
    return r;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});


};
