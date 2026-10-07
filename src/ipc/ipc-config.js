// 自动拆分自 main.js —— configBlock + appInfoBlock
const { ipcMain, dialog, shell } = require('electron');

module.exports = function register(ctx) {
  const { loadConfig, saveConfig, applySource, modpack, sources, DEFAULT_MC_DIR, APP_NAME, APP_VERSION, app, path, fs } = ctx;
  const __win = () => ctx.getWin();

ipcMain.handle('sys:ram', () => ({ total: require('os').totalmem() }));
ipcMain.handle('sources:info', () => {
  try {
    const cats = ['game', 'content', 'api', 'java', 'server'];
    const detail = {};
    for (const c of cats) {
      detail[c] = sources.candidates(c).map((s) => s.name);
    }
    return { ok: true, mode: sources.getMode(), modes: sources.listModes(), detail };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('cfg:set', (_e, cfg) => {
  saveConfig(cfg);
  if (cfg.downloadSource) applySource(cfg.downloadSource);
  if (cfg.cfApiKey) modpack.setCfKey(cfg.cfApiKey);
  return true;
});

// ---------- IPC：选择目录 ----------
ipcMain.handle('pick:dir', async () => {
  const r = await dialog.showOpenDialog(__win(), { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

// 选择（或新建）一个文件夹作为服务器目录：默认定位到 .minecraft 同级，方便用户直接“新建文件夹”
ipcMain.handle('pick:newDir', async (_e, { defaultPath } = {}) => {
  const c = loadConfig();
  const base = defaultPath || path.dirname(c.serverDir || path.join(DEFAULT_MC_DIR, 'server'));
  const r = await dialog.showOpenDialog(__win(), {
    title: '选择或新建一个文件夹作为服务器目录',
    defaultPath: base,
    buttonLabel: '用这个文件夹',
    properties: ['openDirectory', 'createDirectory', 'promptToCreate'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

// ---------- IPC：选择 Java ----------
ipcMain.handle('pick:java', async () => {
  const r = await dialog.showOpenDialog(__win(), {
    properties: ['openFile'],
    filters: [{ name: 'Java', extensions: ['exe'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- IPC：选择文件（通用，用于自定义背景图） ----------
ipcMain.handle('pick:file', async (_e, { filters } = {}) => {
  const r = await dialog.showOpenDialog(__win(), {
    properties: ['openFile'],
    filters: filters && filters.length ? filters : undefined
  });
  return r.canceled ? null : r.filePaths[0];
});


// ---------- IPC：配置 ----------
ipcMain.handle('cfg:get', () => loadConfig());
ipcMain.handle('app:info', () => {
  const C = require('../constants');
  return { name: APP_NAME, version: APP_VERSION, electron: process.versions.electron, node: process.versions.node, author: C.LEGAL_AUTHOR || '', email: C.LEGAL_EMAIL || '', repo: C.REPO_URL || '' };
});

// 支持作者信息（赞赏收款码 / 反馈链接），随版本常量暴露
ipcMain.handle('app:support', () => {
  const C = require('../constants');
  return {
    wechat: C.SUPPORT_QR_WECHAT || '',
    alipay: C.SUPPORT_QR_ALIPAY || '',
    repo: C.REPO_URL || '',
    issues: C.SUPPORT_ISSUES_URL || ''
  };
});

// 读取法律文档（从随附的 .md 文件）
ipcMain.handle('app:legal', (_e, doc) => {
  const allow = ['LICENSE', 'PRIVACY', 'TERMS', 'DISCLAIMER', 'THIRD-PARTY-NOTICES'];
  if (!allow.includes(doc)) return { ok: false, error: '未知文档' };
  const candidates = [
    path.join(app.getAppPath(), doc + (doc === 'LICENSE' ? '' : '.md')),
    path.join(__dirname, '..', doc + (doc === 'LICENSE' ? '' : '.md')),
    path.join(process.resourcesPath || '', doc + (doc === 'LICENSE' ? '' : '.md'))
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        let content = fs.readFileSync(p, 'utf8');
        // 用 constants 中的主体信息替换占位符（方便一处修改）
        const C = require('../constants');
        content = content.replace(/\[作者名\]/g, C.LEGAL_AUTHOR || '[作者名]')
                         .replace(/\[contact@example\.com\]/g, C.LEGAL_EMAIL || '[contact@example.com]');
        return { ok: true, content };
      }
    } catch {}
  }
  return { ok: false, error: '未找到文档文件' };
});


};
