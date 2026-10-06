// installer.js - 整合包一键安装（下载 -> 解压 -> 建实例 -> 装加载器）
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { execFileSync } = require('child_process');

const TMP_ROOT = 'D:\\CubikLauncher\\tmp';

function download(url, dest, onProgress, onLog) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const req = mod.get(
      { hostname: u.hostname, path: u.pathname + u.search, headers: { 'User-Agent': 'Cubik/1.0' } },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // 处理相对/绝对重定向
          const next = new URL(res.headers.location, url).href;
          return download(next, dest, onProgress, onLog).then(resolve, reject);
        }
        if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} (${url.slice(0, 80)})`));
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let got = 0;
        const file = fs.createWriteStream(dest);
        res.on('data', (d) => { got += d.length; onProgress && onProgress(got, total); });
        res.pipe(file);
        file.on('finish', () =>
          file.close(() => {
            if (total > 0 && got !== total) {
              try { fs.unlinkSync(dest); } catch {}
              return reject(new Error(`下载不完整 (${url.slice(0, 80)})`));
            }
            resolve(dest);
          })
        );
      }
    );
    req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error('下载超时')));
    req.on('error', reject);
  });
}

// 带重试的文本获取（应对网络抖动 ECONNRESET / 超时）
function getText(url, _tries = 3) {
  const tries = _tries == null ? 3 : _tries;
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Cubik/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next;
        try { next = new URL(res.headers.location, url).href; } catch { next = res.headers.location; }
        return getText(next, tries).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        if (tries > 1) return setTimeout(() => getText(url, tries - 1).then(resolve, reject), 800);
        return reject(new Error('HTTP ' + res.statusCode + ' ' + url));
      }
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve(b));
      res.on('error', (e) => {
        if (tries > 1) return setTimeout(() => getText(url, tries - 1).then(resolve, reject), 800);
        reject(e);
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('请求超时')));
    req.on('error', (e) => {
      if (tries > 1) return setTimeout(() => getText(url, tries - 1).then(resolve, reject), 800);
      reject(e);
    });
  });
}

// 取 JSON（带重试）
async function getJson(url) {
  const b = await getText(url);
  return JSON.parse(b);
}

// 解压 zip 到目录（用系统 tar）
function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('tar', ['-xf', zip, '-C', dest], { stdio: 'ignore' });
}

// 并行下载（限制并发）
async function downloadAll(tasks, concurrency, onOne, onLog) {
  let idx = 0;
  let done = 0;
  const total = tasks.length;
  async function worker() {
    while (idx < total) {
      const my = idx++;
      try {
        await tasks[my]();
      } catch (e) {
        onLog && onLog(`跳过失败文件: ${e.message}`);
      }
      done++;
      onOne && onOne(done, total);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(concurrency, total); i++) workers.push(worker());
  await Promise.all(workers);
}

// 安装 Fabric 加载器到实例目录（版本 JSON 以实例目录名命名）
async function installFabric(mcDir, instanceDir, mcVersion, loaderVersion, onLog, instanceName) {
  const installer = await getJson('https://meta.fabricmc.net/v2/versions/installer');
  const iv = installer[0].version;
  const lv =
    loaderVersion ||
    (await getJson('https://meta.fabricmc.net/v2/versions/loader')).find((l) => l.stable)?.version;

  onLog && onLog(`安装 Fabric ${lv} (MC ${mcVersion})…`);
  // 1) 先确保原版版本 JSON + jar 存在
  await ensureVanilla(mcDir, mcVersion, onLog);

  // 2) 取 Fabric profile json，并修正 id / inheritsFrom
  const profile = await getJson(
    `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${lv}/profile/json`
  );
  const finalId = instanceName || `${mcVersion}-fabric${lv}`;
  profile.id = finalId;
  profile.inheritsFrom = mcVersion;
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(path.join(instanceDir, finalId + '.json'), JSON.stringify(profile, null, 2), 'utf8');
  onLog && onLog(`已写入 Fabric 版本 JSON: ${finalId}.json (inheritsFrom ${mcVersion})`);
  return finalId;
}

// 确保原版版本完整存在（version json + client jar + 全部 libraries + assets）
async function ensureVanilla(mcDir, mcVersion, onLog) {
  const modpack = require('./modpack');
  const verDir = path.join(mcDir, 'versions', mcVersion);
  const verJsonPath = path.join(verDir, mcVersion + '.json');
  const jarPath = path.join(verDir, mcVersion + '.jar');

  // 已有完整文件则跳过（client.jar 需校验 ZIP 完整性，防止旧的损坏文件导致启动崩溃）
  if (fs.existsSync(verJsonPath) && fs.existsSync(jarPath) && modpack.isValidZip(jarPath)) {
    onLog && onLog(`原版 ${mcVersion} 已存在`);
    return verJsonPath;
  }
  if (fs.existsSync(jarPath) && !modpack.isValidZip(jarPath)) {
    onLog && onLog(`检测到损坏的 client.jar，将重新下载…`);
    try { fs.unlinkSync(jarPath); } catch {}
  }

  onLog && onLog(`准备原版 ${mcVersion}（版本 JSON + client.jar + 依赖库 + 资源）…`);
  await modpack.installVanillaVersion(mcVersion, mcDir, null, onLog);
  return verJsonPath;
}

// 主安装入口：安装 Modrinth .mrpack 整合包
async function installModpack(opts, progress, onLog) {
  const { mcDir, name, mrpackUrl, mrpackName, loaderHint, mcVersionHint } = opts;
  const instanceName = sanitize(name);
  const instanceDir = path.join(mcDir, 'versions', instanceName);
  const tmp = path.join(TMP_ROOT, 'instances');
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(instanceDir, { recursive: true });

  const steps = [];
  const step = (label) => { steps.push(label); onLog && onLog('▶ ' + label); };

  // 1) 下载 mrpack
  step('下载整合包文件');
  const mrpackPath = path.join(tmp, (mrpackName || instanceName) + '.mrpack');
  await download(mrpackUrl, mrpackPath, (g, t) => progress && progress(10, g, t, '下载整合包'), onLog);

  // 2) 解压
  step('解压整合包内容');
  const unpackDir = path.join(tmp, instanceName + '_unpack');
  fs.rmSync(unpackDir, { recursive: true, force: true });
  extractZip(mrpackPath, unpackDir);

  // 3) 读 index
  const indexPath = path.join(unpackDir, 'modrinth.index.json');
  if (!fs.existsSync(indexPath)) throw new Error('不是有效的 Modrinth 整合包（缺少 modrinth.index.json）');
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  const deps = index.dependencies || {};
  const mcVersion = deps.minecraft || mcVersionHint;
  const loader = deps['fabric-loader']
    ? 'fabric'
    : deps.forge
    ? 'forge'
    : deps.neoforge
    ? 'neoforge'
    : loaderHint || 'vanilla';
  onLog && onLog(`整合包信息: MC ${mcVersion}, 加载器 ${loader}`);

  // 4) 复制 overrides
  step('复制整合包自带文件（配置/资源）');
  const overridesDir = path.join(unpackDir, 'overrides');
  if (fs.existsSync(overridesDir)) copyRecursive(overridesDir, instanceDir);

  // 5) 下载 index 里列出的文件（mods 等）
  step(`下载模组文件（共 ${index.files.length} 个）`);
  const tasks = index.files.map((f) => () => {
    const target = path.join(instanceDir, f.path.replace(/\//g, path.sep));
    return download(f.downloads[0], target, null, null);
  });
  await downloadAll(
    tasks,
    6,
    (done, total) => progress && progress(20 + Math.round((done / total) * 60), done, total, '下载模组'),
    onLog
  );

  // 6) 安装加载器
  if (loader === 'fabric') {
    step('安装 Fabric 加载器');
    await installFabric(mcDir, instanceDir, mcVersion, deps['fabric-loader'], onLog, instanceName);
  } else if (loader === 'forge' || loader === 'neoforge') {
    step(`安装 ${loader} 加载器`);
    const { ensureJava } = require('./java');
    const javaPath = await ensureJava(mcVersion, mcDir, null, onLog);
    const lv = loader === 'forge' ? deps.forge : deps.neoforge;
    await installForgeLike(loader, mcDir, instanceDir, instanceName, mcVersion, lv, javaPath, onLog);
  } else {
    step('原版整合包，无需加载器');
    await ensureVanilla(mcDir, mcVersion, onLog);
    const src = path.join(mcDir, 'versions', mcVersion, mcVersion + '.json');
    if (fs.existsSync(src)) {
      fs.mkdirSync(instanceDir, { recursive: true });
      const prof = JSON.parse(fs.readFileSync(src, 'utf8'));
      prof.id = instanceName;
      prof.inheritsFrom = mcVersion;
      fs.writeFileSync(path.join(instanceDir, instanceName + '.json'), JSON.stringify(prof, null, 2), 'utf8');
    }
  }

  progress && progress(100, 1, 1, '完成');
  onLog && onLog(`✔ 整合包安装完成: ${instanceDir}`);
  return { ok: true, instanceDir, instanceName, mcVersion, loader, steps };
}

function sanitize(s) {
  return String(s).replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 60) || 'modpack';
}

function copyRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src)) {
    const s = path.join(src, e);
    const d = path.join(dest, e);
    if (fs.statSync(s).isDirectory()) copyRecursive(s, d);
    else fs.copyFileSync(s, d);
  }
}

// 光影包安装：下载 -> 放入 shaderpacks
async function installShader(opts, progress, onLog) {
  const { mcDir, name, url, filename } = opts;
  const destDir = path.join(mcDir, 'shaderpacks');
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, filename || name + '.zip');
  onLog && onLog(`下载光影包: ${filename || name}`);
  await download(url, dest, (g, t) => progress && progress(g, t, '下载光影包'), onLog);
  onLog && onLog(`✔ 光影包已安装到: ${dest}`);
  return { ok: true, file: dest };
}

// ---------- Forge / NeoForge 安装 ----------
// 取 Forge 推荐版本号（如 47.4.10 for 1.20.1）
async function forgeVersion(mcVersion, prefer) {
  const promo = await getJson('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
  const key = prefer === 'latest' ? `${mcVersion}-latest` : `${mcVersion}-recommended`;
  let v = promo.promos[key];
  if (!v) v = promo.promos[`${mcVersion}-latest`] || promo.promos[`${mcVersion}-recommended`];
  if (!v) throw new Error(`Forge 暂无 ${mcVersion} 版本`);
  return v;
}

// 取 NeoForge 最新稳定版本（按 MC 版本）
async function neoforgeVersion(mcVersion) {
  const prefix = mcVersion.replace(/^1\./, '') + '.';
  const xml = await new Promise((res, rej) => {
    const req = https.get(
      { hostname: 'maven.neoforged.net', path: '/releases/net/neoforged/neoforge/maven-metadata.xml', headers: { 'User-Agent': 'Cubik/1.0' } },
      (r) => { let b = ''; r.on('data', (d) => (b += d)); r.on('end', () => res(b)); }
    );
    req.setTimeout(60000, () => req.destroy(new Error('请求超时')));
    req.on('error', rej);
  });
  const vers = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((m) => m[1])
    .filter((v) => v.startsWith(prefix) && !/beta|alpha/.test(v));
  if (!vers.length) throw new Error(`NeoForge 暂无 ${mcVersion} 版本`);
  return vers[vers.length - 1];
}

// 用 Java 运行 installer jar 静默安装客户端
async function runInstaller(javaPath, jarPath, mcDir, onLog) {
  // Forge/NeoForge 安装器要求存在 launcher_profiles.json，否则报错
  const profiles = path.join(mcDir, 'launcher_profiles.json');
  if (!fs.existsSync(profiles)) {
    fs.writeFileSync(profiles, JSON.stringify({ profiles: {}, settings: {}, version: 3 }, null, 2), 'utf8');
    onLog && onLog('已创建 launcher_profiles.json（安装器需要）');
  }
  onLog && onLog('运行官方安装器（静默模式）…');
  await new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn(javaPath, ['-jar', jarPath, '--installClient', mcDir], {
      cwd: path.dirname(jarPath),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    proc.stdout.on('data', (d) => onLog && onLog(d.toString().trim()));
    proc.stderr.on('data', (d) => onLog && onLog(d.toString().trim()));
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error('安装器退出码 ' + code))));
    proc.on('error', reject);
  });
}

// 安装 Forge/NeoForge 到实例目录
async function installForgeLike(kind, mcDir, instanceDir, instanceName, mcVersion, loaderVersion, javaPath, onLog) {
  const tmp = path.join(TMP_ROOT, 'installers');
  fs.mkdirSync(tmp, { recursive: true });

  let url, jarName;
  if (kind === 'neoforge') {
    const v = loaderVersion || (await neoforgeVersion(mcVersion));
    jarName = `neoforge-${v}-installer.jar`;
    url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${v}/${jarName}`;
  } else {
    const v = loaderVersion || (await forgeVersion(mcVersion));
    jarName = `forge-${mcVersion}-${v}-installer.jar`;
    url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${v}/${jarName}`;
  }

  const jarPath = path.join(tmp, jarName);
  onLog && onLog(`下载 ${kind} 安装器: ${jarName}`);
  await download(url, jarPath, null, onLog);

  // 先确保原版版本存在（安装器需要原版 JSON）
  await ensureVanilla(mcDir, mcVersion, onLog);

  await runInstaller(javaPath, jarPath, mcDir, onLog);

  // 安装器会在 versions/ 下生成新版本目录，找出来迁到实例目录
  const vdir = path.join(mcDir, 'versions');
  let installed = null;
  if (fs.existsSync(vdir)) {
    const candidates = fs
      .readdirSync(vdir)
      .filter((d) => /forge/i.test(d) && fs.existsSync(path.join(vdir, d, d + '.json')));
    candidates.sort((a, b) => fs.statSync(path.join(vdir, b)).mtimeMs - fs.statSync(path.join(vdir, a)).mtimeMs);
    installed = candidates[0];
  }
  if (!installed) throw new Error(`${kind} 安装后未找到生成的版本目录`);

  // 把生成的版本 JSON 复制到实例目录并重命名为实例名
  const srcJson = path.join(vdir, installed, installed + '.json');
  const profile = JSON.parse(fs.readFileSync(srcJson, 'utf8'));
  profile.id = instanceName;
  fs.mkdirSync(instanceDir, { recursive: true });
  fs.writeFileSync(path.join(instanceDir, instanceName + '.json'), JSON.stringify(profile, null, 2), 'utf8');
  onLog && onLog(`已写入 ${kind} 版本 JSON: ${instanceName}.json (来自 ${installed})`);

  // 清理安装器生成的中间版本目录（避免版本列表出现重复项）
  try {
    const instDir = path.join(vdir, installed);
    if (instDir !== instanceDir && fs.existsSync(instDir)) {
      fs.rmSync(instDir, { recursive: true, force: true });
      onLog && onLog(`已清理中间版本目录: ${installed}`);
    }
  } catch {}

  return instanceName;
}

// 取 Fabric 加载器版本列表（针对某 MC 版本，稳定版优先）
async function fabricLoaderVersions(mcVersion) {
  const list = await getJson(`https://meta.fabricmc.net/v2/versions/loader/${mcVersion}`);
  return list.map((x) => ({ version: x.loader.version, stable: !!x.loader.stable }));
}

// 取 NeoForge 版本列表（按 MC 版本）
async function neoforgeVersions(mcVersion) {
  const prefix = mcVersion.replace(/^1\./, '') + '.';
  const xml = await getText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
  const vers = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((m) => m[1])
    .filter((v) => v.startsWith(prefix));
  // 稳定版（无 beta/alpha）排前面，整体倒序（新→旧）
  const stable = vers.filter((v) => !/beta|alpha/.test(v)).reverse();
  const beta = vers.filter((v) => /beta|alpha/.test(v)).reverse();
  return [...stable, ...beta].map((v) => ({ version: v, stable: !/beta|alpha/.test(v) }));
}

// 取 Forge 版本列表（按 MC 版本）
async function forgeVersions(mcVersion) {
  const xml = await getText('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
  const vers = [...xml.matchAll(/<version>([^<]+)<\/version>/g)]
    .map((m) => m[1])
    .filter((v) => v.startsWith(mcVersion + '-'))
    .map((v) => v.slice(mcVersion.length + 1))
    .reverse();
  return vers.map((v) => ({ version: v, stable: true }));
}

// 监听加载器版本列表（给界面下拉）
async function listLoaderVersions(kind, mcVersion) {
  if (kind === 'fabric') return await fabricLoaderVersions(mcVersion);
  if (kind === 'forge') return await forgeVersions(mcVersion);
  if (kind === 'neoforge') return await neoforgeVersions(mcVersion);
  return [];
}

// 安装一个带加载器的版本（先确保原版，再装加载器，生成组合版本）
// instanceName 必传：生成的版本目录/JSON 名
async function installLoaderVersion(kind, mcDir, instanceName, mcVersion, loaderVersion, onProgress, onLog) {
  const instanceDir = path.join(mcDir, 'versions', instanceName);
  fs.mkdirSync(instanceDir, { recursive: true });

  onLog && onLog(`准备安装 ${kind} ${loaderVersion || '推荐版'} (MC ${mcVersion})…`);

  if (kind === 'fabric') {
    await installFabric(mcDir, instanceDir, mcVersion, loaderVersion, onLog, instanceName);
  } else if (kind === 'forge' || kind === 'neoforge') {
    const { ensureJava } = require('./java');
    const javaPath = await ensureJava(mcVersion, mcDir, null, onLog);
    await installForgeLike(kind, mcDir, instanceDir, instanceName, mcVersion, loaderVersion, javaPath, onLog);
  } else {
    throw new Error('未知加载器: ' + kind);
  }

  onProgress && onProgress(100, 1, 1, '完成');
  onLog && onLog(`✔ ${kind} 安装完成: ${instanceName}`);
  return { ok: true, instanceDir, instanceName, mcVersion, loader: kind };
}

// ============================================================
// 组件叠加系统（在已有版本上追加 OptiFine 等）
// ============================================================

// 取 OptiFine 版本列表（BMCLAPI）
async function optifineVersions(mcVersion) {
  const list = await getJson(`https://bmclapi2.bangbang93.com/optifine/${mcVersion}`);
  if (!Array.isArray(list)) return [];
  // 新版本在前
  return list.reverse().map((x) => ({
    version: `${x.type}_${x.patch}`,
    type: x.type,
    patch: x.patch,
    filename: x.filename,
    label: `${x.type} ${x.patch}`,
    forge: x.forge && x.forge !== 'Forge N/A' ? x.forge : ''
  }));
}

// 取可叠加组件版本列表
async function listAddonVersions(kind, mcVersion) {
  if (kind === 'optifine') return await optifineVersions(mcVersion);
  return [];
}

// 取某个已安装版本的 inheritsFrom 链上的 MC 版本
function resolveBaseMcVersion(mcDir, versionId) {
  const vdir = path.join(mcDir, 'versions');
  let cur = versionId;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const json = path.join(vdir, cur, cur + '.json');
    if (!fs.existsSync(json)) return cur;
    try {
      const p = JSON.parse(fs.readFileSync(json, 'utf8'));
      if (p.inheritsFrom) cur = p.inheritsFrom;
      else return cur;
    } catch {
      return cur;
    }
  }
  return cur;
}

// 判断一个版本是否已经装了 OptiFine（查 mods 目录）
function hasOptiFine(mcDir, versionId) {
  const modsDir = path.join(mcDir, 'versions', versionId, 'mods');
  if (!fs.existsSync(modsDir)) return false;
  try {
    return fs.readdirSync(modsDir).some((f) => /^OptiFine/i.test(f) && f.endsWith('.jar'));
  } catch {
    return false;
  }
}

// 在已有版本（通常是 Forge/Fabric 实例）上叠加 OptiFine
// 现代 OptiFine（1.17+）本身就是 Forge mod，直接放进 mods/ 即可，无需跑 GUI 安装器
async function installAddon(kind, mcDir, baseVersionId, ofVer, onProgress, onLog) {
  if (kind !== 'optifine') throw new Error('暂只支持叠加 OptiFine');

  const mcVersion = resolveBaseMcVersion(mcDir, baseVersionId);
  const instanceDir = path.join(mcDir, 'versions', baseVersionId);
  if (!fs.existsSync(path.join(instanceDir, baseVersionId + '.json'))) {
    throw new Error('目标版本不存在: ' + baseVersionId);
  }

  onLog && onLog(`向 ${baseVersionId} 叠加 OptiFine ${ofVer.label || ofVer.version}（MC ${mcVersion}）`);

  // 下载 OptiFine
  const tmp = path.join(TMP_ROOT, 'optifine');
  fs.mkdirSync(tmp, { recursive: true });
  const jarName = ofVer.filename || `OptiFine_${mcVersion}_${ofVer.version}.jar`;
  const jarPath = path.join(tmp, jarName);
  const dlUrl = `https://bmclapi2.bangbang93.com/optifine/${mcVersion}/${ofVer.type || ofVer.version.split('_')[0]}/${ofVer.patch || ofVer.version.split('_')[1]}`;
  onLog && onLog(`下载 OptiFine: ${jarName}`);
  await download(dlUrl, jarPath, (g, t) => onProgress && onProgress(t ? Math.round((g / t) * 100) : 0, g, t, '下载 OptiFine'), onLog);

  // 放进 mods/ 目录
  const modsDir = path.join(instanceDir, 'mods');
  fs.mkdirSync(modsDir, { recursive: true });
  const destJar = path.join(modsDir, jarName);
  fs.copyFileSync(jarPath, destJar);
  onLog && onLog(`已放入 mods/ 目录: ${jarName}`);

  onProgress && onProgress(100, 1, 1, '完成');
  onLog && onLog(`✔ OptiFine 叠加完成，启动 ${baseVersionId} 时自动生效`);
  return { ok: true, instanceName: baseVersionId, file: destJar };
}

module.exports = { installModpack, installShader, download, extractZip, installForgeLike, forgeVersion, neoforgeVersion, listLoaderVersions, installLoaderVersion, fabricLoaderVersions, forgeVersions, neoforgeVersions, listAddonVersions, optifineVersions, resolveBaseMcVersion, hasOptiFine, installAddon };
