// 自动拆分自 main.js —— authBlock + skinBlock
const { ipcMain, dialog, shell } = require('electron');

module.exports = function register(ctx) {
  const { loadConfig, saveConfig, authMgr, path, fs, getAccounts, getActiveIndex, activeAccount, publicAccounts, publicAccount } = ctx;
  const __win = () => ctx.getWin();

// ---------- 微软正版登录（支持多账号） ----------
let pendingLogin = null; // { deviceCode, interval, expiresIn }

ipcMain.handle('auth:ms-start', async () => {
  try {
    const dc = await authMgr.startDeviceCode();
    pendingLogin = { deviceCode: dc.deviceCode, interval: dc.interval, expiresIn: dc.expiresIn };
    try { shell.openExternal(dc.verificationUri); } catch {}
    return { ok: true, userCode: dc.userCode, verificationUri: dc.verificationUri, expiresIn: dc.expiresIn };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('auth:ms-poll', async () => {
  if (!pendingLogin) return { ok: false, error: '请先点击“微软登录”' };
  try {
    const onStatus = (m) => { try { __win().webContents.send('auth:status', m); } catch {} };
    const info = await authMgr.loginFlow(pendingLogin.deviceCode, pendingLogin.interval, pendingLogin.expiresIn, onStatus);
    pendingLogin = null;
    const cfg = loadConfig();
    const accs = getAccounts(cfg);
    const newAcc = {
      name: info.name,
      uuid: info.uuid,
      accessToken: info.accessToken,
      refreshToken: info.refreshToken,
      owns: info.owns,
      obtainedAt: info.obtainedAt,
      offline: false
    };
    // 同 UUID 已存在则更新，否则追加
    const dup = accs.findIndex((a) => a.uuid && a.uuid === info.uuid);
    if (dup >= 0) { accs[dup] = newAcc; cfg.activeAccount = dup; }
    else { accs.push(newAcc); cfg.activeAccount = accs.length - 1; }
    cfg.username = info.name;
    saveConfig(cfg);
    return { ok: true, account: publicAccount(newAcc), accounts: publicAccounts(cfg) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 静默续期（针对当前激活账号）
ipcMain.handle('auth:ms-refresh', async (_e, opts) => {
  const cfg = loadConfig();
  const idx = (opts && typeof opts.index === 'number') ? opts.index : getActiveIndex(cfg);
  const accs = getAccounts(cfg);
  const acc = accs[idx];
  if (!acc || !acc.refreshToken) return { ok: false, error: '未登录' };
  try {
    const info = await authMgr.refreshFlow(acc.refreshToken);
    accs[idx] = {
      name: info.name,
      uuid: info.uuid,
      accessToken: info.accessToken,
      refreshToken: info.refreshToken,
      owns: info.owns,
      obtainedAt: info.obtainedAt,
      offline: false
    };
    cfg.username = info.name;
    saveConfig(cfg);
    return { ok: true, account: publicAccount(accs[idx]), accounts: publicAccounts(cfg) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 删除账号（by index）
ipcMain.handle('auth:remove', (_e, opts) => {
  const cfg = loadConfig();
  const accs = getAccounts(cfg);
  const idx = (opts && typeof opts.index === 'number') ? opts.index : -1;
  if (idx < 0 || idx >= accs.length) return { ok: false, error: '无效账号' };
  accs.splice(idx, 1);
  let active = cfg.activeAccount || 0;
  if (active >= accs.length) active = Math.max(0, accs.length - 1);
  cfg.activeAccount = active;
  const cur = accs[active];
  if (cur) cfg.username = cur.name;
  saveConfig(cfg);
  return { ok: true, accounts: publicAccounts(cfg), active: active };
});

// 切换激活账号
ipcMain.handle('auth:switch', (_e, opts) => {
  const cfg = loadConfig();
  const accs = getAccounts(cfg);
  const idx = opts && typeof opts.index === 'number' ? opts.index : -1;
  if (idx < 0 || idx >= accs.length) return { ok: false, error: '无效账号' };
  cfg.activeAccount = idx;
  cfg.username = accs[idx].name;
  saveConfig(cfg);
  return { ok: true, account: publicAccount(accs[idx]), active: idx };
});

// 兼容旧接口：退出登录（删除全部或当前）
ipcMain.handle('auth:ms-logout', (_e, opts) => {
  const cfg = loadConfig();
  if (opts && opts.all) {
    cfg.accounts = [];
    cfg.activeAccount = 0;
  } else {
    const accs = getAccounts(cfg);
    const idx = getActiveIndex(cfg);
    accs.splice(idx, 1);
    cfg.activeAccount = Math.max(0, Math.min(idx, accs.length - 1));
  }
  delete cfg.msAccount;
  saveConfig(cfg);
  return { ok: true, accounts: publicAccounts(cfg) };
});

ipcMain.handle('auth:account', () => {
  const cfg = loadConfig();
  const acc = activeAccount(cfg);
  return acc ? publicAccount(acc) : null;
});

// 返回全部账号（脱敏）
ipcMain.handle('auth:accounts', () => {
  const cfg = loadConfig();
  return { ok: true, accounts: publicAccounts(cfg), active: getActiveIndex(cfg) };
});


// ---------- 皮肤 / 披风（正版账号） ----------
// 确保当前账号 accessToken 有效（过期/即将过期则自动静默续期）
async function ensureFreshToken(cfg, index) {
  const accs = getAccounts(cfg);
  const idx = typeof index === 'number' ? index : getActiveIndex(cfg);
  const acc = accs[idx];
  if (!acc || acc.offline) throw new Error('请先登录微软正版账号');
  // 令牌 24h 过期，剩余不足 1h 时续期
  const age = Date.now() - (acc.obtainedAt || 0);
  if (!acc.accessToken || age > 23 * 3600 * 1000) {
    if (!acc.refreshToken) throw new Error('登录已失效，请重新登录');
    const info = await authMgr.refreshFlow(acc.refreshToken);
    accs[idx] = Object.assign({}, acc, {
      accessToken: info.accessToken,
      refreshToken: info.refreshToken,
      uuid: info.uuid,
      name: info.name,
      owns: info.owns,
      obtainedAt: info.obtainedAt,
      offline: false
    });
    saveConfig(cfg);
  }
  return { token: accs[idx].accessToken, idx, uuid: accs[idx].uuid, name: accs[idx].name };
}

// 当前账号的皮肤/披风信息
ipcMain.handle('skin:info', async (_e, opts) => {
  try {
    const cfg = loadConfig();
    const acc = activeAccount(cfg);
    if (!acc || acc.offline || !acc.uuid) return { ok: false, error: '请先登录微软正版账号' };
    const { token } = await ensureFreshToken(cfg, typeof (opts && opts.index) === 'number' ? opts.index : undefined);
    const p = await authMgr.refreshProfile(token);
    return {
      ok: true,
      name: p.name,
      uuid: p.id,
      skins: (p.skins || []).map((s) => ({ id: s.id, state: s.state, url: s.url, variant: s.variant })),
      capes: (p.capes || []).map((c) => ({ id: c.id, state: c.state, url: c.url, alias: c.alias }))
    };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 上传皮肤（本地 png）+ 可选 variant（classic/slim）
ipcMain.handle('skin:upload', async (_e, opts) => {
  try {
    const cfg = loadConfig();
    const { token } = await ensureFreshToken(cfg, typeof (opts && opts.index) === 'number' ? opts.index : undefined);
    let file = opts && opts.file;
    if (!file) {
      const r = await dialog.showOpenDialog(__win(), {
        title: '选择皮肤文件（PNG，64x64 或 64x32）',
        properties: ['openFile'],
        filters: [{ name: 'PNG 图片', extensions: ['png'] }]
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      file = r.filePaths[0];
    }
    if (!fs.existsSync(file)) return { ok: false, error: '文件不存在' };
    await authMgr.uploadSkin(token, file, opts && opts.variant === 'slim' ? 'slim' : 'classic');
    const p = await authMgr.refreshProfile(token);
    return { ok: true, name: p.name, uuid: p.id, skins: p.skins || [], capes: p.capes || [] };
  } catch (e) { return { ok: false, error: e.message }; }
});

// 设置/取消活动披风（capeId 为空则隐藏）
ipcMain.handle('skin:set-cape', async (_e, opts) => {
  try {
    const cfg = loadConfig();
    const { token } = await ensureFreshToken(cfg, typeof (opts && opts.index) === 'number' ? opts.index : undefined);
    await authMgr.setActiveCape(token, (opts && opts.capeId) || '');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});


};
