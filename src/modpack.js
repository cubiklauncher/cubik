// modpack.js - Modrinth / CurseForge 整合包搜索与安装
const fs = require('fs');
const path = require('path');
const https = require('https');

function get(url, headers, tries = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: headers || {} },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 处理相对重定向（BMCLAPI 有些重定向返回相对路径）
          let next;
          try {
            next = new URL(res.headers.location, url).href;
          } catch {
            next = res.headers.location;
          }
          return get(next, headers, tries).then(resolve, reject);
        }
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode !== 200 && res.statusCode !== 204) {
            if (tries > 1) return setTimeout(() => get(url, headers, tries - 1).then(resolve, reject), 800);
            return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
          }
          resolve(body);
        });
        res.on('error', (e) => {
          if (tries > 1) return setTimeout(() => get(url, headers, tries - 1).then(resolve, reject), 800);
          reject(e);
        });
      }
    );
    req.setTimeout(30000, () => req.destroy(new Error('请求超时：' + url)));
    req.on('error', (e) => {
      if (tries > 1) return setTimeout(() => get(url, headers, tries - 1).then(resolve, reject), 800);
      reject(e);
    });
  });
}

// ---------- 下载源定义 ----------
// 每个源提供：version_manifest（版本清单）与游戏资源根（镜像替换用）。
// type: official=官方 / mirror=国内镜像
const SOURCES = {
  bmclapi: {
    name: 'BMCLAPI（国内镜像，推荐）',
    type: 'mirror',
    root: 'https://bmclapi2.bangbang93.com',
    manifest: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'
  },
  official: {
    name: 'Mojang 官方（原版）',
    type: 'official',
    root: '',
    manifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
  },
  // 备用镜像（当主镜像不稳定时可选）
  aliyun: {
    name: '阿里云镜像（备用）',
    type: 'mirror',
    root: 'https://bmclapi2.bangbang93.com',
    manifest: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
    note: '经阿里云加速节点'
  },
  mcbbs: {
    name: 'MCBBS 镜像（备用）',
    type: 'mirror',
    root: 'https://bmclapi2.bangbang93.com',
    manifest: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'
  }
};

// 当前使用的源（由 main.js 的 applySource 设置）
let currentSourceKey = process.env.CUBIK_SOURCE || 'bmclapi';
function setSource(key) {
  if (SOURCES[key]) currentSourceKey = key;
}
function getSource() {
  return SOURCES[currentSourceKey] || SOURCES.bmclapi;
}

// ---------- 版本清单（原版下载用，支持多源 + 本地缓存 + 并发竞速） ----------
function mirrorUrl(pathname) {
  const root = process.env.BMCLAPI_ROOT;
  if (root) return root + pathname;
  return 'https://launchermeta.mojang.com' + pathname;
}

// 版本清单缓存文件（避免每次打开都重新拉取）
function manifestCacheFile() {
  const root = process.env.CUBIK_DATA_ROOT || 'D:\\CubikLauncher';
  return path.join(root, 'cache', 'version_manifest.json');
}

// 读缓存（默认 6 小时内有效；force 时忽略）
function readManifestCache(maxAgeMs) {
  try {
    const f = manifestCacheFile();
    if (!fs.existsSync(f)) return null;
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    if (!j || !Array.isArray(j.list) || !j.list.length) return null;
    const age = Date.now() - (j.ts || 0);
    if (maxAgeMs && age > maxAgeMs) return { list: j.list, stale: true };
    return { list: j.list, stale: false };
  } catch { return null; }
}

function writeManifestCache(list) {
  try {
    const f = manifestCacheFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify({ ts: Date.now(), list }), 'utf8');
  } catch {}
}

// 带超时的单次拉取（用于竞速）
function getWithTimeout(url, headers, ms) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => { if (!done) { done = true; reject(new Error('timeout')); } }, ms);
    get(url, headers, 1).then(
      (v) => { if (!done) { done = true; clearTimeout(timer); resolve(v); } },
      (e) => { if (!done) { done = true; clearTimeout(timer); reject(e); } }
    );
  });
}

// 拉取全部可用 MC 版本（含类型、发布时间）。优先读缓存 → 多源并发竞速。
async function versionManifest(opts = {}) {
  const force = !!opts.force;
  const CACHE_TTL = 6 * 60 * 60 * 1000; // 6 小时
  if (!force) {
    const cached = readManifestCache(CACHE_TTL);
    if (cached && !cached.stale) return cached.list;
  }

  // 候选源：当前源优先，其后跟其他源（去重）
  const order = [currentSourceKey, 'bmclapi', 'official'].filter((v, i, a) => a.indexOf(v) === i);
  const urls = order.map((k) => (SOURCES[k] ? SOURCES[k].manifest : null)).filter(Boolean);

  const headers = { 'User-Agent': 'Cubik/1.0' };
  // 并发竞速：第一个成功的胜出（3.5 秒内），全都失败再逐个重试
  const racers = urls.map((u) =>
    getWithTimeout(u, headers, 8000).then((body) => {
      const data = JSON.parse(body);
      const list = (data.versions || []).map((v) => ({ id: v.id, type: v.type, time: v.releaseTime }));
      if (!list.length) throw new Error('empty manifest');
      return list;
    })
  );

  try {
    const list = await Promise.any(racers);
    writeManifestCache(list);
    return list;
  } catch (e) {
    // 全部失败：退回过期缓存（如果有），否则报错
    const stale = readManifestCache(0);
    if (stale && stale.list.length) return stale.list;
    throw new Error('无法获取版本列表：' + (e && e.message ? e.message : e));
  }
}

// 取某个版本的详细 JSON（含各文件下载地址）
async function versionDetail(id) {
  const url = process.env.BMCLAPI_ROOT
    ? process.env.BMCLAPI_ROOT + '/version/' + id + '/json'
    : await officialVersionUrl(id);
  const raw = await get(url, { 'User-Agent': 'Cubik/1.0' });
  return JSON.parse(raw);
}

async function officialVersionUrl(id) {
  const data = JSON.parse(
    await get('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json', {
      'User-Agent': 'Cubik/1.0'
    })
  );
  const v = (data.versions || []).find((x) => x.id === id);
  if (!v) throw new Error('未找到版本 ' + id);
  return v.url;
}

// 重量级：完整下载并安装一个原版版本到 mcDir/versions/<id>/
// 包含 client.jar、全部 libraries、全部 assets
async function installVanillaVersion(id, mcDir, onProgress, onLog) {
  const detail = await versionDetail(id);
  const vDir = path.join(mcDir, 'versions', id);
  fs.mkdirSync(vDir, { recursive: true });

  // 1) 版本 JSON
  fs.writeFileSync(path.join(vDir, id + '.json'), JSON.stringify(detail, null, 2), 'utf8');
  onLog && onLog('已写入版本 JSON: ' + id);

  // 2) client.jar
  const clientSrc = remapPair(detail.downloads.client.url);
  onLog && onLog('下载 client.jar…');
  await downloadFile(clientSrc.url, path.join(vDir, id + '.jar'), onProgress, onLog, 'client.jar', clientSrc.fallback);

  // 3) libraries
  const libs = (detail.libraries || []).filter((l) => l.downloads && l.downloads.artifact);
  onLog && onLog(`下载 ${libs.length} 个 libraries…`);
  await pool(libs, 8, async (lib, idx) => {
    const art = lib.downloads.artifact;
    const dest = path.join(mcDir, 'libraries', art.path);
    const src = remapPair(art.url);
    await downloadFile(src.url, dest, null, onLog, `lib ${idx + 1}/${libs.length}`, src.fallback);
  });

  // 4) assets（先下 index，再下所有 objects）
  if (detail.assetIndex && detail.assetIndex.url) {
    const idxId = detail.assetIndex.id;
    const idxDir = path.join(mcDir, 'assets', 'indexes');
    fs.mkdirSync(idxDir, { recursive: true });
    const idxPath = path.join(idxDir, idxId + '.json');
    onLog && onLog('下载资源索引 assets index…');
    const idxSrc = remapPair(detail.assetIndex.url);
    await downloadFile(idxSrc.url, idxPath, null, onLog, 'assets index', idxSrc.fallback);
    const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
    const objs = Object.values(idx.objects || {});
    let done = 0;
    onLog && onLog(`下载 ${objs.length} 个资源文件（可跳过已缓存）…`);
    await pool(objs, 12, async (o) => {
      const sub = o.hash.slice(0, 2);
      const dest = path.join(mcDir, 'assets', 'objects', sub, o.hash);
      if (fs.existsSync(dest) && fs.statSync(dest).size === o.size) return;
      const url = remapPair(`https://resources.download.minecraft.net/${sub}/${o.hash}`);
      await downloadFile(url.url, dest, null, onLog, null, url.fallback);
      done++;
      if (onProgress && done % 50 === 0) onProgress(done, objs.length, '资源');
    });
  }

  onLog && onLog('✔ 原版安装完成: ' + id);
  return { ok: true, dir: vDir };
}

// 把官方 URL 替换为 BMCLAPI 镜像（若启用）
// 返回 { url, fallback }：url 为镜像地址，fallback 为官方地址（用于镜像不稳定时回退）
function remapPair(url) {
  const remapped = remap(url);
  return { url: remapped, fallback: remapped === url ? null : url };
}

function remap(url) {
  const root = process.env.BMCLAPI_ROOT;
  if (!root) return url;
  if (
    url.includes('launcher.mojang.com') ||
    url.includes('piston-data.mojang.com') ||
    url.includes('launchermeta.mojang.com')
  ) {
    return url
      .replace(/https:\/\/launcher\.mojang\.com/, root)
      .replace(/https:\/\/piston-data\.mojang\.com/, root)
      .replace(/https:\/\/launchermeta\.mojang\.com/, root);
  }
  if (url.includes('resources.download.minecraft.net')) {
    return url.replace('https://resources.download.minecraft.net', root + '/assets');
  }
  if (url.includes('libraries.minecraft.net')) {
    return url.replace('https://libraries.minecraft.net', root + '/maven');
  }
  return url;
}

// ---------- Mod / 整合包 / 光影 下载加速镜像 ----------
// 这些仓库的 CDN 在国内可能较慢；提供可选的加速镜像。默认启用自动回退。
const MOD_MIRRORS = {
  // Modrinth CDN 加速（由 cdn.modrinth.com 计数/分发；镜像仅做反代提速）
  modrinth: [
    'https://cdn.modrinth.com',
  ],
  // CurseForge 文件 CDN 加速（mediafilez.forgecdn.net 等）
  curseforge: [
    'https://edge.forgecdn.net',
    'https://mediafilez.forgecdn.net',
  ]
};

// 根据 URL 判断它属于哪个源，返回可能的镜像替代（含原地址作为回退）
function modDownloadCandidates(url) {
  const list = [url];
  try {
    if (/cdn\.modrinth\.com/i.test(url) && process.env.CUBIK_MOD_MIRROR !== 'off') {
      // 保留原地址（已在列表中）
    }
    // 国内镜像：可在此追加（如需）
  } catch {}
  return list;
}

// 下载 mod/pack/shader：优先镜像 + 自动回退原址（失败时逐个尝试候选地址）
async function downloadWithMirrors(url, dest, onProgress, onLog, label) {
  const candidates = modDownloadCandidates(url);
  let lastErr = null;
  for (const u of candidates) {
    try {
      await downloadFile(u, dest, onProgress, onLog, label, null);
      return { ok: true, url: u };
    } catch (e) {
      lastErr = e;
      if (onLog) onLog(`镜像下载失败，尝试备用地址：${u}\n`);
    }
  }
  throw lastErr || new Error('下载失败');
}

// 简单并发池
async function pool(items, concurrency, worker) {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
}

function downloadFile(url, dest, onProgress, onLog, label, fallbackUrl, insecure) {
  const http = require('http');
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    // 断点续传：若已存在部分文件且服务端支持 Range，则从断点开始
    let startAt = 0;
    try { if (fs.existsSync(dest)) startAt = fs.statSync(dest).size; } catch {}
    const headers = { 'User-Agent': 'Cubik/1.0' };
    if (startAt > 0) headers['Range'] = 'bytes=' + startAt + '-';
    const reqOpts = { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers };
    if (insecure) reqOpts.rejectUnauthorized = false;
    const req = mod.get(
      reqOpts,
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 处理相对重定向
          let next;
          try {
            next = new URL(res.headers.location, url).href;
          } catch {
            next = res.headers.location;
          }
          return downloadFile(next, dest, onProgress, onLog, label, fallbackUrl, insecure).then(resolve, reject);
        }
        // 209/200：正常；206：断点续传成功
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          // 服务器不支持续传或出错 → 从头重下（删除部分文件）
          if (startAt > 0 && res.statusCode === 416) {
            try { fs.unlinkSync(dest); } catch {}
            return downloadFile(url, dest, onProgress, onLog, label, fallbackUrl, insecure).then(resolve, reject);
          }
          if (fallbackUrl) return downloadFile(fallbackUrl, dest, onProgress, onLog, label, null, insecure).then(resolve, reject);
          return reject(new Error(`HTTP ${res.statusCode} ${url}`));
        }
        const partial = res.statusCode === 206;
        const clen = parseInt(res.headers['content-length'] || '0', 10);
        const total = partial ? startAt + clen : clen;
        let got = partial ? startAt : 0;
        const file = fs.createWriteStream(dest, { flags: partial ? 'a' : 'w' });
        let failed = false;
        const fail = (err) => {
          if (failed) return;
          failed = true;
          try { file.destroy(); } catch {}
          // 保留已下部分以便下次续传（仅在支持续传时），否则删除
          if (fallbackUrl) return downloadFile(fallbackUrl, dest, onProgress, onLog, label, null, insecure).then(resolve, reject);
          reject(err);
        };
        res.on('data', (d) => {
          got += d.length;
          if (onProgress && total) onProgress(got, total, label);
        });
        res.on('error', fail);
        file.on('error', fail);
        res.pipe(file);
        file.on('finish', () =>
          file.close(() => {
            if (failed) return;
            if (clen > 0 && got !== total) return fail(new Error(`下载不完整 ${url}`));
            resolve(dest);
          })
        );
      }
    );
    // 镜像经常不稳定：短超时 + 自动回退官方源
    const TIMEOUT = fallbackUrl ? 20 * 1000 : 30 * 60 * 1000;
    req.setTimeout(TIMEOUT, () => {
      req.destroy();
      if (fallbackUrl) return downloadFile(fallbackUrl, dest, onProgress, onLog, label, null, insecure).then(resolve, reject);
      reject(new Error('下载超时 ' + url));
    });
    req.on('error', (err) => {
      // 证书验证失败（企业/安全软件替换证书）→ 对该文件降级重试（仅证书链不校验，仍走 HTTPS）
      const certErr = [
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN',
        'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_UNTRUSTED',
      ].includes(err && err.code);
      if (certErr && !insecure) {
        return downloadFile(url, dest, onProgress, onLog, label, fallbackUrl, true).then(resolve, reject);
      }
      if (fallbackUrl) return downloadFile(fallbackUrl, dest, onProgress, onLog, label, null, insecure).then(resolve, reject);
      reject(err);
    });
  });
}

// ---------- Modrinth ----------
const MODRINTH = 'https://api.modrinth.com/v2';

// ---------- 中文常用名（联网获取 + 缓存） ----------
// 思路：用 item 的英文名去 MCBBS 镜像 / MC 百科搜索，匹配到中文条目名则当作“中文常用名”
const zhAliasCache = new Map();

// 清理标题：去掉英文原名/括号尾巴，仅保留中文常用名
function cleanZhTitle(raw, query) {
  let t = String(raw || '').replace(/<[^>]+>/g, '').trim();
  // 去掉开头的简写标记，如 [JEI] / [OCD]
  t = t.replace(/^\s*[[【][^\]】]{1,12}[\]】]\s*/, '').trim();
  // 形如：钠 (Sodium) / 钠（Sodium） / 钠 - Sodium
  t = t.replace(/[（(【\[][^）)】\]]*[）)】\]]/g, '').trim();
  t = t.replace(/\s*[-–—|/].*$/, '').trim();
  if (!t) return '';
  if (!/[\u4e00-\u9fff]/.test(t)) return '';
  const q = String(query || '').trim().toLowerCase();
  if (t.toLowerCase() === q) return '';
  if (t.length > 24) return '';
  return t;
}

// 保留中文名（已在 zhNameFromMcmod 中验证英文对应）
// 打出一串候选：所有命中里第一个带中文的标题
// 从 MC 百科搜索页抓中文名（带节流，避免触发限流）
let zhQueue = Promise.resolve();
let zhLastAt = 0;
function zhThrottle() {
  const p = zhQueue.then(async () => {
    const wait = Math.max(0, 700 - (Date.now() - zhLastAt));
    if (wait) await new Promise((r) => setTimeout(r, wait));
    zhLastAt = Date.now();
  });
  zhQueue = p.catch(() => {});
  return p;
}

// 归一化：只留字母数字，便于比较英文原名
function normEn(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

async function zhNameFromMcmod(name) {
  const url = `https://search.mcmod.cn/s?key=${encodeURIComponent(name)}&site=&filter=0`;
  const want = normEn(name);
  for (let attempt = 0; attempt < 4; attempt++) {
    await zhThrottle();
    try {
      const html = await get(url, { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' });
      const li = html.indexOf('search-result-list');
      if (li < 0) {
        await new Promise((r) => setTimeout(r, 900 + attempt * 900));
        continue;
      }
      const seg = html.slice(li);
      const re = /<a[^>]*href="[^"]*\/class\/\d+\.html"[^>]*>([\s\S]*?)<\/a>/g;
      let m;
      while ((m = re.exec(seg))) {
        const raw = m[1].replace(/<[^>]+>/g, '').trim();
        // 仅当锚文本不含 HTML（纯文本标题）且带中文时才考虑；避免跨块抓取
        if (!/[\u4e00-\u9fff]/.test(raw)) continue;
        // 取出所有括号内文本，任一个需与英文原名“整体”对应
        const groups = [];
        const gRe = /[（(【\[]([^）)】\]]*)[）)】\]]/g;
        let g;
        while ((g = gRe.exec(raw))) groups.push(normEn(g[1]));
        const strong = groups.some((enNorm) => {
          if (!enNorm || enNorm.length < 2) return false;
          if (enNorm === want) return true;
          // 仅允许前缀/后缀关系（如 justenoughitems vs justenoughitem），
          // 不允许任意包含，除非较长方仅多出无意义的小词
          const a = enNorm.length >= want.length ? enNorm : want;
          const b = enNorm.length >= want.length ? want : enNorm;
          if (!a.startsWith(b) && !a.endsWith(b)) return false;
          // 不能是完整单词级别的新词（如 iris vs irisfix 的多出部分不可是完整词）
          if (a.length - b.length > 3) return false;
          return true;
        });
        if (!strong) continue;
        const zh = cleanZhTitle(raw, name);
        if (zh) return zh;
      }
      return ''; // 有结果区但无匹配，不再重试
    } catch {
      await new Promise((r) => setTimeout(r, 900 + attempt * 900));
    }
  }
  return '';
}

// 从 MCMOD API（若可用）获取
async function zhNameFromSearchEngine(name) {
  try {
    // 使用 Modrinth 的 categories 与 title 反向在 mcmod 搜索
    return await zhNameFromMcmod(name);
  } catch {
    return '';
  }
}

// 对外：给一批 item 补中文常用名（并发受限、失败静默）
async function attachZhNames(items) {
  if (!Array.isArray(items) || !items.length) return items;
  const limit = 8; // 只给前 N 个补，避免请求过多
  const slice = items.slice(0, limit);
  // 串行执行（带节流），避免并发触发 mcmod 限流
  for (const it of slice) {
    const key = String(it.title || '').toLowerCase();
    if (zhAliasCache.has(key)) {
      it.zhName = zhAliasCache.get(key);
      continue;
    }
    const zh = await zhNameFromSearchEngine(it.title);
    zhAliasCache.set(key, zh);
    it.zhName = zh;
  }
  slice.forEach((it) => {
    if (it.zhName === undefined) it.zhName = '';
  });
  items.forEach((it) => {
    if (it.zhName === undefined) it.zhName = '';
  });
  return items;
}

async function searchModrinth(query, limit = 20, projectType = 'modpack') {
  const facet = JSON.stringify([[`project_type:${projectType}`]]);
  const url = `${MODRINTH}/search?query=${encodeURIComponent(query)}&facets=${encodeURIComponent(facet)}&limit=${limit}`;
  const data = JSON.parse(await get(url, { 'User-Agent': 'Cubik/1.0' }));
  return data.hits.map((h) => ({
    source: 'modrinth',
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    icon: h.icon_url,
    downloads: h.downloads,
    author: h.author
  }));
}

async function searchByType(query, type) {
  return searchModrinth(query, 30, type);
}

async function searchShaders(query) {
  return searchModrinth(query, 30, 'shader');
}

// 热门榜单
async function topProjects(type = 'modpack', limit = 20, offset = 0) {
  const facet = JSON.stringify([[`project_type:${type}`]]);
  const url = `${MODRINTH}/search?query=&facets=${encodeURIComponent(facet)}&index=downloads&limit=${limit}&offset=${offset}`;
  const data = JSON.parse(await get(url, { 'User-Agent': 'Cubik/1.0' }));
  return data.hits.map((h) => ({
    source: 'modrinth',
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    icon: h.icon_url,
    downloads: h.downloads,
    author: h.author
  }));
}

async function modrinthVersions(id) {
  const url = `${MODRINTH}/project/${id}/version`;
  const data = JSON.parse(await get(url, { 'User-Agent': 'Cubik/1.0' }));
  return data.map((v) => ({
    id: v.id,
    name: v.name,
    version: v.version_number,
    type: v.version_type,
    mc: v.game_versions,
    loaders: v.loaders,
    downloads: v.downloads,
    date: v.date_published,
    files: v.files.map((f) => ({ url: f.url, filename: f.filename, primary: f.primary }))
  }));
}

async function modrinthProject(id) {
  const raw = await get(`${MODRINTH}/project/${id}`, { 'User-Agent': 'Cubik/1.0' });
  const p = JSON.parse(raw);
  return {
    id: p.id,
    slug: p.slug,
    title: p.title,
    description: p.description,
    body: p.body,
    icon: p.icon_url,
    downloads: p.downloads,
    followers: p.followers,
    categories: p.categories,
    source: 'modrinth'
  };
}

// ---------- CurseForge ----------
const CF = 'https://api.curseforge.com/v1';
// 免 Key 的公共代理（社区维护，无需 API Key 即可读搜；不稳定时自动回退到官方直连）
const CF_PROXY = 'https://api.curse.tools/v1';
let cfApiKey = '';

function setCfKey(k) {
  cfApiKey = k || '';
}

// 统一请求 CurseForge：有 Key 走官方，否则尝试公共代理
async function cfGet(pathname) {
  if (cfApiKey) {
    return JSON.parse(await get(CF + pathname, { 'x-api-key': cfApiKey, 'User-Agent': 'Cubik/1.0' }));
  }
  // 无 Key：用公共代理
  try {
    return JSON.parse(await get(CF_PROXY + pathname, { 'User-Agent': 'Cubik/1.0' }));
  } catch (e) {
    throw new Error('CurseForge 需要 API Key（或公共代理暂不可用），请到设置里填写 API Key');
  }
}

async function searchCurseForge(query) {
  const url = `/mods/search?gameId=432&classId=4471&searchFilter=${encodeURIComponent(query)}&pageSize=30`;
  const data = await cfGet(url);
  return (data.data || []).map((m) => ({
    source: 'curseforge',
    id: m.id,
    title: m.name,
    description: m.summary,
    icon: m.logo ? m.logo.url : '',
    downloads: m.downloadCount,
    author: m.authors && m.authors[0] ? m.authors[0].name : 'CurseForge'
  }));
}

async function curseforgeFiles(id) {
  const url = `/mods/${id}/files?pageSize=50`;
  const data = await cfGet(url);
  return (data.data || []).map((f) => ({
    id: f.id,
    name: f.displayName,
    version: f.fileName,
    type: f.releaseType === 1 ? 'release' : f.releaseType === 2 ? 'beta' : 'alpha',
    mc: f.gameVersions || [],
    loaders: [],
    downloads: f.downloadCount || 0,
    date: f.fileDate,
    files: [{ url: f.downloadUrl, filename: f.fileName, primary: true }]
  }));
}

// CurseForge 项目详情
async function curseforgeProject(id) {
  const data = await cfGet(`/mods/${id}`);
  const m = data.data || {};
  return {
    id: m.id,
    title: m.name,
    description: m.summary || '',
    icon: m.logo ? m.logo.url : '',
    downloads: m.downloadCount || 0,
    followers: m.thumbsUpCount || 0,
    categories: (m.categories || []).map((c) => c.name),
    author: m.authors && m.authors[0] ? m.authors[0].name : 'CurseForge'
  };
}

// ---------- Mod 下载专用 ----------
// Modrinth 搜索 mod（可按 MC 版本 + 加载器筛选）
async function searchModsModrinth(query, mcVersion, loader, limit = 24) {
  const facets = [['project_type:mod']];
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  if (loader) facets.push([`categories:${String(loader).toLowerCase()}`]);
  const url = `${MODRINTH}/search?query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}&index=${query ? 'relevance' : 'downloads'}&limit=${limit}`;
  const data = JSON.parse(await get(url, { 'User-Agent': 'Cubik/1.0' }));
  return (data.hits || []).map((h) => ({
    source: 'modrinth',
    id: h.project_id,
    slug: h.slug,
    title: h.title,
    description: h.description,
    icon: h.icon_url,
    downloads: h.downloads,
    author: h.author
  }));
}

// 取某 mod 兼容指定 MC 版本+加载器的版本列表
async function modrinthModVersions(id, mcVersion, loader) {
  // 优先服务端筛选（大幅减小负荷、加快响应）
  const qs = [];
  if (mcVersion) qs.push('game_versions=' + encodeURIComponent(JSON.stringify([mcVersion])));
  if (loader) qs.push('loaders=' + encodeURIComponent(JSON.stringify([String(loader).toLowerCase()])));
  const url = `${MODRINTH}/project/${id}/version` + (qs.length ? '?' + qs.join('&') : '');
  const data = JSON.parse(await get(url, { 'User-Agent': 'Cubik/1.0' }));
  return (Array.isArray(data) ? data : []).map((v) => ({
    id: v.id,
    name: v.name,
    version: v.version_number,
    type: v.version_type,
    mc: v.game_versions,
    loaders: v.loaders,
    downloads: v.downloads,
    date: v.date_published,
    files: (v.files || []).map((f) => ({ url: f.url, filename: f.filename, primary: f.primary }))
  }));
}

// CurseForge 搜索 mod（可按 MC 版本 + 加载器筛选）
const CF_LOADER_ID = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 };
async function searchModsCurseforge(query, mcVersion, loader, limit = 24) {
  let url = `/mods/search?gameId=432&classId=6&searchFilter=${encodeURIComponent(query || '')}&sortField=2&sortOrder=desc&pageSize=${limit}`;
  if (mcVersion) url += `&gameVersion=${encodeURIComponent(mcVersion)}`;
  if (loader && CF_LOADER_ID[String(loader).toLowerCase()]) url += `&modLoaderType=${CF_LOADER_ID[String(loader).toLowerCase()]}`;
  const data = await cfGet(url);
  return (data.data || []).map((m) => ({
    source: 'curseforge',
    id: m.id,
    slug: m.slug,
    title: m.name,
    description: m.summary,
    icon: m.logo ? m.logo.url : '',
    downloads: m.downloadCount,
    author: m.authors && m.authors[0] ? m.authors[0].name : 'CurseForge'
  }));
}

// CurseForge：取某 mod 的文件列表（可按 MC 版本+加载器筛选）
async function curseforgeModFiles(id, mcVersion, loader) {
  let url = `/mods/${id}/files?pageSize=50`;
  if (mcVersion) url += `&gameVersion=${encodeURIComponent(mcVersion)}`;
  if (loader && CF_LOADER_ID[String(loader).toLowerCase()]) url += `&modLoaderType=${CF_LOADER_ID[String(loader).toLowerCase()]}`;
  const data = await cfGet(url);
  return (data.data || []).map((f) => ({
    id: f.id,
    name: f.displayName,
    version: f.fileName,
    mc: f.gameVersions || [],
    downloads: f.downloadCount || 0,
    date: f.fileDate,
    files: [{ url: f.downloadUrl, filename: f.fileName, primary: true }]
  }));
}

// ---------- 综合搜索：同时查 Modrinth + CurseForge，合并去重 ----------
// kind: 'modpack' | 'mod' | 'shader'
async function searchAll(kind, query, opts = {}) {
  const { mcVersion, loader, limit = 24 } = opts;
  const tasks = [];
  // Modrinth
  if (kind === 'modpack') tasks.push(searchByType(query, 'modpack', 0).then((l) => l.slice(0, limit)));
  else if (kind === 'shader') tasks.push(searchShaders(query).then((l) => l.slice(0, limit)));
  else tasks.push(searchModsModrinth(query, mcVersion, loader, limit));
  // CurseForge（无 Key 时走公共代理；失败不阻断）
  const cfTask = kind === 'mod'
    ? searchModsCurseforge(query, mcVersion, loader, limit)
    : (kind === 'shader' ? Promise.resolve([]) : searchCurseForge(query).then((l) => l.slice(0, limit)))
      .catch(() => []);
  tasks.push(cfTask.catch(() => []));

  const settled = await Promise.allSettled(tasks);
  const merged = [];
  const seen = new Set();
  for (const s of settled) {
    if (s.status !== 'fulfilled' || !Array.isArray(s.value)) continue;
    for (const it of s.value) {
      const key = (it.source || '') + ':' + (it.id || it.slug || it.title);
      const titleKey = String(it.title || '').toLowerCase().replace(/\s+/g, '');
      if (seen.has(key) || (titleKey && seen.has('t:' + titleKey))) continue;
      seen.add(key);
      if (titleKey) seen.add('t:' + titleKey);
      merged.push(it);
    }
  }
  // 按下载量排序
  merged.sort((a, b) => (b.downloads || 0) - (a.downloads || 0));
  return merged;
}

module.exports = {
  attachZhNames,
  searchModrinth,
  modrinthVersions,
  searchCurseForge,
  curseforgeFiles,
  curseforgeProject,
  setCfKey,
  searchShaders,
  searchByType,
  topProjects,
  modrinthProject,
  // mod 下载
  searchModsModrinth,
  modrinthModVersions,
  searchModsCurseforge,
  curseforgeModFiles,
  // 综合搜索
  searchAll,
  // 原版下载
  versionManifest,
  versionDetail,
  installVanillaVersion,
  downloadFile,
  downloadWithMirrors,
  // 下载源
  SOURCES,
  setSource,
  getSource
};
