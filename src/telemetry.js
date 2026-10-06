// telemetry.js —— 匿名使用统计（隐私友好）
//
// 设计原则：
//  1. 只上报**匿名**信息：应用版本、平台、是否首次启动、匿名设备 ID；
//     **不采集**用户名、微软账号、IP 不落库（仅按国家/地区粗粒度聚合，可选）、不装设备指纹。
//  2. 匿名设备 ID = 随机 UUID，存本地配置文件，用户可随时删除；
//     卸载/删除配置即彻底断开，无法反推个人身份。
//  3. 全程静默、失败不影响启动（超时/断网/证书错误一律吞掉）。
//  4. 提供开关：设置里可关闭统计（PRIVACY.md 说明）。
//
// 后端：Cloudflare Worker（见 server-telemetry/worker.js），
//      接口 POST /report（上报）、GET /stats（公开统计）、GET /admin（需 Token）。

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 统计后端地址（部署 Worker 后填入，留空则完全关闭统计）
const TELEMETRY_ENDPOINT = 'https://cubik-telemetry.example.workers.dev';

// 上报超时（毫秒）——弱网也不拖慢启动
const REPORT_TIMEOUT = 4000;

let _inited = false;

function getDeviceFile(dataRoot) {
  return path.join(dataRoot, 'device.json');
}

// 读取（或首次生成）匿名设备 ID
function getDeviceId(dataRoot) {
  const file = getDeviceFile(dataRoot);
  try {
    if (fs.existsSync(file)) {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (j && typeof j.id === 'string' && j.id.length >= 16) return j.id;
    }
  } catch {}
  const id = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ id, created: new Date().toISOString() }, null, 2), 'utf8');
  } catch {}
  return id;
}

// 读取本机配置里的统计开关（默认开启）
function statsEnabled(dataRoot) {
  try {
    const cfg = path.join(dataRoot, 'launcher-config.json');
    if (fs.existsSync(cfg)) {
      const j = JSON.parse(fs.readFileSync(cfg, 'utf8'));
      if (j && j.telemetry === false) return false;
    }
  } catch {}
  return true;
}

function post(url, payload, timeout = REPORT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(e); }
    const mod = u.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = mod.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'User-Agent': 'Cubik/' + require('./constants').APP_VERSION
        },
        timeout
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      }
    );
    req.on('timeout', () => { try { req.destroy(); } catch {} reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 上报一次启动事件（匿名）。
 * @param {object} opts { dataRoot, version, firstRun }
 */
async function report(opts) {
  const { dataRoot, version, firstRun } = opts || {};
  if (!TELEMETRY_ENDPOINT || TELEMETRY_ENDPOINT.includes('example.com')) return { skipped: true };
  if (!dataRoot || !statsEnabled(dataRoot)) return { skipped: true };

  const payload = {
    v: version || '0.0.0',          // 应用版本
    p: process.platform,             // win32 / darwin / linux
    a: process.arch,                 // x64 / arm64
    f: firstRun ? 1 : 0,             // 是否首次启动
    d: getDeviceId(dataRoot)         // 匿名设备 ID（随机 UUID）
  };

  try {
    const r = await post(TELEMETRY_ENDPOINT.replace(/\/$/, '') + '/report', payload);
    return { ok: r.status >= 200 && r.status < 300, status: r.status };
  } catch (e) {
    // 静默失败：统计绝不影响启动
    return { ok: false, error: String(e && e.message || e) };
  }
}

/**
 * 在 app ready 后调用一次：延迟上报 + 只发首次启动标记。
 * @param {object} opts { dataRoot, version }
 */
function init(opts) {
  if (_inited) return;
  _inited = true;
  const { dataRoot, version } = opts || {};
  if (!TELEMETRY_ENDPOINT || TELEMETRY_ENDPOINT.includes('example.com')) return;

  // 是否首次启动：device.json 之前不存在
  let firstRun = true;
  try { firstRun = !fs.existsSync(getDeviceFile(dataRoot)); } catch {}

  // 延迟 3 秒，避开启动高峰，不影响用户感知
  setTimeout(() => {
    report({ dataRoot, version, firstRun }).catch(() => {});
  }, 3000);
}

module.exports = { init, report, getDeviceId, TELEMETRY_ENDPOINT };
