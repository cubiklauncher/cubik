// tunnel.js - 内网穿透辅助（基于开源 frp 客户端）
// 说明：真正的公网穿透需要一个服务端（自建或第三方）。本模块负责：
//   1) 下载 frp 客户端（开源，MIT）到本地
//   2) 用用户填写/预设的 frps 服务端地址生成 frpc 配置
//   3) 启动/停止隧道进程
// 不内置任何第三方账号，用户可自建 frps 或用免费公共 frp 服务。
const fs = require('fs');
const path = require('path');
const https = require('https');
const os = require('os');
const { spawn } = require('child_process');

let tunnelProc = null;

function get(url, dest) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : require('http');
    const req = mod.get({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: { 'User-Agent': 'Cubik/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next; try { next = new URL(res.headers.location, url).href; } catch { next = res.headers.location; }
        return get(next, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const file = fs.createWriteStream(dest);
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
      file.on('error', reject);
    });
    req.setTimeout(60000, () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

// 下载 frp 客户端 zip（Windows x64）
async function downloadFrp(dataDir, onLog) {
  const dir = path.join(dataDir, 'frp');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, 'frpc.exe');
  if (fs.existsSync(exe)) { onLog && onLog('frpc 已存在，跳过下载'); return exe; }

  // 从 GitHub releases 取最新版 frp（windows_amd64）
  onLog && onLog('获取 frp 最新版本…');
  const rel = JSON.parse(await httpGetText('https://api.github.com/repos/fatedier/frp/releases/latest'));
  const asset = (rel.assets || []).find((a) => /windows_amd64\.zip$/i.test(a.name));
  if (!asset) throw new Error('未找到 frp Windows 版下载地址');
  const zip = path.join(dir, asset.name);
  onLog && onLog('下载 frp 客户端：' + asset.name + '（' + (asset.size / 1048576).toFixed(1) + 'MB）');
  await get(asset.browser_download_url, zip);
  // 解压（用 PowerShell Expand-Archive，Windows 自带）
  onLog && onLog('解压 frp…');
  await unzip(zip, dir);
  // 找到 frpc.exe（在 frp_x.xx.x_windows_amd64/ 子目录）
  const found = findFile(dir, 'frpc.exe');
  if (!found) throw new Error('解压后未找到 frpc.exe');
  if (found !== exe) { try { fs.copyFileSync(found, exe); } catch {} }
  try { fs.unlinkSync(zip); } catch {}
  onLog && onLog('frp 客户端就绪');
  return fs.existsSync(exe) ? exe : found;
}

function findFile(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = findFile(p, name); if (r) return r; }
    else if (e.name === name) return p;
  }
  return null;
}

function unzip(zip, dir) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dir}' -Force`], (err) => {
      if (err) reject(new Error('解压失败：' + err.message));
      else resolve();
    });
  });
}

function httpGetText(url) {
  const mod = url.startsWith('https') ? https : require('http');
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    mod.get({ hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'Cubik/1.0', Accept: 'application/vnd.github+json' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next; try { next = new URL(res.headers.location, url).href; } catch { next = res.headers.location; }
        return httpGetText(next).then(resolve, reject);
      }
      let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b));
    }).on('error', reject);
  });
}

// 生成 frpc.toml（新版 frp 用 toml）
function writeConfig(dataDir, cfg) {
  const dir = path.join(dataDir, 'frp');
  fs.mkdirSync(dir, { recursive: true });
  const localPort = cfg.localPort || 25565;
  const remotePort = cfg.remotePort || localPort;
  const toml = [
    `serverAddr = "${cfg.serverAddr}"`,
    `serverPort = ${cfg.serverPort || 7000}`,
    cfg.token ? `auth.token = "${cfg.token}"` : '',
    '',
    '[[proxies]]',
    `name = "cubik-mc-${localPort}"`,
    'type = "tcp"',
    `localIP = "127.0.0.1"`,
    `localPort = ${localPort}`,
    `remotePort = ${remotePort}`
  ].filter(Boolean).join('\n');
  const p = path.join(dir, 'frpc.toml');
  fs.writeFileSync(p, toml, 'utf8');
  return p;
}

// 启动隧道
function startTunnel(dataDir, cfg, onLog, onData) {
  if (tunnelProc) return { ok: false, error: '隧道已在运行' };
  const exe = path.join(dataDir, 'frp', 'frpc.exe');
  if (!fs.existsSync(exe)) return { ok: false, error: '未找到 frpc.exe，请先下载' };
  const conf = writeConfig(dataDir, cfg);
  onLog && onLog(`启动隧道: ${exe} -c ${conf}`);
  try {
    tunnelProc = spawn(exe, ['-c', conf], { cwd: path.join(dataDir, 'frp') });
  } catch (e) {
    tunnelProc = null;
    return { ok: false, error: e.message };
  }
  tunnelProc.stdout.on('data', (d) => onData(d.toString()));
  tunnelProc.stderr.on('data', (d) => onData(d.toString()));
  tunnelProc.on('close', (code) => { onData(`\n[隧道已退出 ${code}]\n`); tunnelProc = null; });
  return { ok: true, remote: `${cfg.serverAddr}:${cfg.remotePort || cfg.localPort}` };
}

function stopTunnel() {
  if (!tunnelProc) return { ok: false, error: '没有运行中的隧道' };
  try { tunnelProc.kill(); } catch {}
  tunnelProc = null;
  return { ok: true };
}

function isRunning() { return !!tunnelProc; }

module.exports = { downloadFrp, writeConfig, startTunnel, stopTunnel, isRunning };
