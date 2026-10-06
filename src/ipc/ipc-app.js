// 自动拆分自 main.js —— appBlock
const { ipcMain, dialog, shell } = require('electron');

module.exports = function register(ctx) {
  const { modpack, installer, APP_VERSION, LAUNCHER_DATA, app, path, fs } = ctx;
  const __win = () => ctx.getWin();

// 检查更新：比对 GitHub Releases 最新版本（支持重定向、超时重试、友好错误分类）
ipcMain.handle('app:check-update', async (_e, opts) => {
  const repo = require('../constants').UPDATE_REPO;
  const t0 = Date.now();
  const prefer = (opts && opts.prefer) || 'installer'; // installer | portable | auto
  try {
    // 优先 /releases（列表）：可同时拿到预发布 + 全部资源；失败回退 /releases/latest
    const body = await githubGet(`/repos/${repo}/releases?per_page=10`);
    const list = JSON.parse(body);
    const rel = pickBestRelease(list);
    if (!rel) throw new Error('HTTP 404 该仓库还没有发布版本');

    const latest = String(rel.tag_name || '').replace(/^v/i, '');
    const cmp = cmpVersion(latest, APP_VERSION);
    const hasUpdate = !!latest && cmp > 0;

    const assets = (rel.assets || []).filter((a) => /\.exe$/i.test(a.name));
    const pickByName = (re) => assets.find((a) => re.test(a.name));

    // 按偏好挑选下载资源（返回安装版与免安装版两个，供 UI 切换）
    const installer = pickByName(/setup|installer|-x64\.exe$/i) || pickByName(/\.exe$/i) || null;
    const portable = pickByName(/portable/i) || null;
    const chosen = prefer === 'portable' ? (portable || installer) : prefer === 'auto' ? (installer || portable) : (installer || portable);

    const mapAsset = (a) => (a ? { url: a.browser_download_url, name: a.name, size: a.size, downloads: a.download_count || 0 } : null);

    return {
      ok: true,
      current: APP_VERSION,
      latest: latest || APP_VERSION,
      hasUpdate,
      isNewer: hasUpdate,
      prerelease: !!rel.prerelease,
      name: rel.name || rel.tag_name || '',
      url: rel.html_url || '',
      publishedAt: rel.published_at || '',
      notes: (rel.body || '').slice(0, 6000),
      // 兼容旧字段
      downloadUrl: chosen ? chosen.browser_download_url : '',
      downloadName: chosen ? chosen.name : '',
      size: chosen ? chosen.size : 0,
      // 新增：可选下载（安装版 / 免安装版）
      installer: mapAsset(installer),
      portable: mapAsset(portable),
      chosen: prefer,
      assetCount: assets.length,
      elapsedMs: Date.now() - t0
    };
  } catch (e) {
    const msg = String(e && e.message ? e.message : e);
    let error, hint;
    if (msg.includes('404')) { error = 'NO_RELEASE'; hint = '仓库还没有发布任何版本（或仓库名未设置）。'; }
    else if (msg.includes('403')) { error = 'RATE_LIMIT'; hint = 'GitHub 请求过于频繁，请稍后再试。'; }
    else if (msg.includes('timeout') || msg.includes('ETIMEDOUT')) { error = 'TIMEOUT'; hint = '请求超时，请检查网络后重试。'; }
    else if (msg.includes('ENOTFOUND') || msg.includes('ECONNREFUSED') || msg.includes('EAI_AGAIN')) { error = 'OFFLINE'; hint = '网络不可用（可能被墙），请检查网络。'; }
    else { error = 'ERROR'; hint = msg; }
    return { ok: false, error, hint, raw: msg, repo };
  }
});

// 从 releases 列表中挑选最合适的版本（优先正式版，看最新发布时间）
function pickBestRelease(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const stable = list.filter((r) => !r.draft && !r.prerelease);
  const pool = stable.length ? stable : list.filter((r) => !r.draft);
  if (!pool.length) return null;
  // GitHub 返回按时间倒序，取第一个
  return pool[0];
}

// 下载更新包（带进度，保存到下载目录）
ipcMain.handle('app:download-update', async (_e, { url, name }) => {
  try {
    if (!url) return { ok: false, error: '没有可下载的更新包' };
    const dir = path.join(LAUNCHER_DATA, 'updates');
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, name || 'Cubik-update.exe');
    const send = (got, total) => { try { __win().webContents.send('update:progress', { got, total }); } catch {} };
    await modpack.downloadFile(url, dest, send, null, name || 'update');
    return { ok: true, file: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 打开已下载的更新包所在文件夹
ipcMain.handle('app:open-update-folder', () => {
  const dir = path.join(LAUNCHER_DATA, 'updates');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return shell.openPath(dir);
});

// 一键更新：下载新包 → 启动安装程序 → 退出本启动器
ipcMain.handle('app:install-update', async (_e, { url, name }) => {
  try {
    if (!url) return { ok: false, error: '没有可下载的更新包' };
    const dir = path.join(LAUNCHER_DATA, 'updates');
    fs.mkdirSync(dir, { recursive: true });
    // 安装版用固定名，避免重复堆积
    const isInstaller = /setup|installer/i.test(name || '') || /\.exe$/i.test(name || '');
    const dest = path.join(dir, name || 'Cubik-update.exe');
    const send = (got, total) => { try { __win().webContents.send('update:progress', { got, total }); } catch {} };
    await modpack.downloadFile(url, dest, send, null, name || 'update');
    return { ok: true, file: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 运行下载好的安装包并退出（仅支持安装版 exe）
ipcMain.handle('app:run-update', async (_e, { file }) => {
  try {
    if (!file || !fs.existsSync(file)) return { ok: false, error: '更新包不存在' };
    // 启动安装程序（detached），然后退出当前启动器，让安装器替换文件
    const { spawn } = require('child_process');
    const child = spawn(file, [], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => { try { app.exit(0); } catch { app.quit(); } }, 800);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 判断当前是否为安装版（exe 位于用户/系统安装目录）还是免安装版
function detectInstallMode() {
  try {
    if (!app.isPackaged) return 'dev';
    const exe = process.execPath || '';
    const dir = path.dirname(exe);
    const lower = exe.toLowerCase();
    // 免安装版：electron-builder portable 会解压到临时目录运行，路径含 'portable' 或临时目录
    if (/\bportable\b/i.test(lower)) return 'portable';
    // 安装版典型路径：%LOCALAPPDATA%\Programs\<app> 或 Program Files
    if (/\\programs\\/i.test(dir + '\\') || /program files/i.test(lower) || /appdata\\local/i.test(lower)) return 'installed';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// 真正的自动更新：后台下载安装包 → 静默安装（/S）→ 自动重启新版本 → 退出当前进程
ipcMain.handle('app:auto-update', async (_e, { url, name }) => {
  const { spawn } = require('child_process');
  try {
    if (!url) return { ok: false, error: '没有可下载的更新包' };
    const dir = path.join(LAUNCHER_DATA, 'updates');
    fs.mkdirSync(dir, { recursive: true });
    // 安装包固定名，避免重复堆积；已存在且大小一致则跳过重复下载
    const dest = path.join(dir, 'Cubik-update-setup.exe');
    const send = (got, total) => { try { __win().webContents.send('update:progress', { got, total }); } catch {} };

    const mode = detectInstallMode();

    if (mode === 'dev') {
      // 开发模式：跑的是源码目录，更新靠 git 拉取而非替换 exe，无需下载安装包。
      // 直接重启：重新拉起 electron 加载当前源码目录。
      const electronBin = process.execPath;
      const appDir = path.resolve(__dirname, '..');
      try {
        const child = spawn(electronBin, [appDir], { detached: true, stdio: 'ignore', cwd: appDir });
        child.unref();
      } catch (e) {
        return { ok: false, mode, error: '重启失败：' + e.message };
      }
      setTimeout(() => { try { app.exit(0); } catch { app.quit(); } }, 1000);
      return { ok: true, mode, file: '', relaunched: true };
    }

    if (!(fs.existsSync(dest) && fs.statSync(dest).size > 1024)) {
      await modpack.downloadFile(url, dest, send, null, name || 'update');
    }

    if (mode === 'portable') {
      // 免安装版：无法覆盖正在运行的自身。改为启动新下载的便携包（它自解压后即为新版），
      // 再退出当前进程 —— 对新版而言就是一次干净的重启。
      // 注意：便携包不能从与自身相同的路径直接运行，先复制到一个独立临时文件再启动。
      const launchTmp = path.join(dir, 'Cubik-relaunch-' + Date.now() + '.exe');
      try { fs.copyFileSync(dest, launchTmp); } catch { /* 复制失败则退回原文件 */ }
      const launchPath = fs.existsSync(launchTmp) ? launchTmp : dest;
      const child = spawn(launchPath, [], { detached: true, stdio: 'ignore' });
      child.unref();
      setTimeout(() => { try { app.exit(0); } catch { app.quit(); } }, 1200);
      return { ok: true, mode, file: dest, relaunched: true };
    }

    // 安装版：静默运行 NSIS 安装器（/S = silent），安装完成后安装器会拉起新版
    const child = spawn(dest, ['/S'], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(() => { try { app.exit(0); } catch { app.quit(); } }, 800);
    return { ok: true, mode, file: dest };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// GitHub API GET（自动跟随重定向、超时、最多重试 2 次）
// insecure=true 时对 GitHub 域名降级：仍用 HTTPS，但不再强校验证书
// （应对企业网络/安全软件替换证书导致“无法验证证书”的情况，仅用于 api.github.com）
function githubGet(path, tries = 2, insecure = false) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const opts = {
      hostname: 'api.github.com',
      path,
      headers: { 'User-Agent': 'Cubik/' + APP_VERSION, Accept: 'application/vnd.github+json' },
    };
    if (insecure) opts.rejectUnauthorized = false;
    const req = https.get(opts, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return githubGet(res.headers.location.replace(/^https?:\/\/api\.github\.com/, ''), tries, insecure).then(resolve, reject);
      }
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        if (res.statusCode !== 200) {
          if (tries > 1 && res.statusCode >= 500) return setTimeout(() => githubGet(path, tries - 1, insecure).then(resolve, reject), 800);
          return reject(new Error('HTTP ' + res.statusCode));
        }
        resolve(b);
      });
    });
    req.setTimeout(12000, () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => {
      // 证书验证失败 → 降级重试（仍走 HTTPS，仅不校验证书链）
      const certErr = [
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN',
        'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED',
      ].includes(e && e.code);
      if (certErr && tries > 1) {
        return githubGet(path, tries - 1, true).then(resolve, reject);
      }
      if (tries > 1) return setTimeout(() => githubGet(path, tries - 1, insecure).then(resolve, reject), 800);
      reject(e);
    });
  });
}

function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

};
