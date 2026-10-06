// server.js - 在启动器内创建/管理 Minecraft 服务器
// 重写版（v1.0.23）：稳健解析、可靠进程管理、清晰状态机。
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');
const { ensureJava, requiredJava } = require('./java');

let serverProc = null;
let serverState = 'stopped'; // stopped | starting | running | stopping
let serverStartedAt = 0;
let serverDir = '';
let onDataSink = null;
const UA = { 'User-Agent': 'Cubik/1.0' };

// ---------- 在线玩家 / 聊天追踪 ----------
// 从服务端 stdout 行中解析玩家进/出/聊天/死亡等事件。
// 兼容 Vanilla / Paper / Forge / Fabric / 中文语言包常见输出格式。
const onlinePlayers = new Set();

// 去掉 ANSI 颜色码。
// 注意：服务端被重定向到管道时，颜色码可能是真正的 ESC 字节(\x1b)，
// 也可能因平台/编码变成字面量形式的 "[91m"、"[0m"、"§a" 等，逐一清除。
function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;]*m/g, '')      // 真 ESC 序列
    .replace(/\[[0-9;]{1,4}m/g, '')       // 字面量 [91m / [0m / [1;32m
    .replace(/§./g, '')                   // Minecraft § 颜色码
    .replace(/\r$/, '');
}

// 取 "[12:34:56 INFO]: " 或 "[12:34:56] [Server thread/INFO]: " 之后的正文
function bodyOf(line) {
  // 常见服务端日志前缀： [时间 级别]:  /  [时间] [线程/级别]: 
  let m = line.match(/\]\s*(?:\[[^\]]*\]\s*)?:\s*(.*)$/);
  if (m) return m[1];
  m = line.match(/^\[[^\]]*\]\s*(.*)$/);
  return m ? m[1] : line;
}

// 解析一行服务端输出，返回结构化事件或 null
function parseServerLine(raw) {
  const line = stripAnsi(raw);
  if (!line.trim()) return null;
  const body = bodyOf(line).trim();
  if (!body) return null;

  // 玩家加入
  let m =
    body.match(/^([A-Za-z0-9_]{1,16})(?:\[[^\]]*\])?\s+joined the game/) ||
    body.match(/^([A-Za-z0-9_]{1,16})(?:\[[^\]]*\])?\s+logged in with entity id/) ||
    body.match(/^([A-Za-z0-9_]{1,16})\s+\u52a0\u5165\u4e86\u6e38\u620f/);
  if (m) {
    const name = m[1];
    if (!/^(?:Server|Player|Async|Thread|Netty|Chunk|Main)$/.test(name)) {
      onlinePlayers.add(name);
      return { type: 'join', name, online: onlinePlayers.size };
    }
  }

  // 玩家离开
  m =
    body.match(/^([A-Za-z0-9_]{1,16})\s+left the game/) ||
    body.match(/^([A-Za-z0-9_]{1,16})\s+lost connection:/) ||
    body.match(/^([A-Za-z0-9_]{1,16})\s+\u79bb\u5f00\u4e86\u6e38\u620f/);
  if (m) {
    const name = m[1];
    onlinePlayers.delete(name);
    return { type: 'leave', name, online: onlinePlayers.size };
  }

  // 聊天消息："[Not Secure] <name> 内容" 或 "<name> 内容"
  m = body.match(/^(?:\[[^\]]*\]\s*)?<([A-Za-z0-9_]{1,16})>\s?(.*)$/);
  if (m) {
    return { type: 'chat', name: m[1], text: m[2], online: onlinePlayers.size };
  }

  // 系统提示（含加入/离开的彩色提示）
  if (/^\*?\s*[A-Za-z0-9_]{1,16}\s+(joined|left)\b/.test(body)) {
    return { type: 'system', text: body };
  }

  // 死亡/成就等广播
  m = body.match(/^([A-Za-z0-9_]{1,16})\s+(was slain|was killed|drowned|blew up|fell|burned|starved|died|hit the ground|withered away|was shot|went up in flames|walked into)/);
  if (m) return { type: 'death', name: m[1], text: body };

  return null;
}

// 主动同步在线名单（从 list 命令输出解析，支持中英文）
function setOnlineFromListLine(line) {
  const s = stripAnsi(line);
  // "There are 2 of a max of 20 players online: Alex, Steve"
  let m = s.match(/There are (\d+) of a max of \d+ players online:?\s*(.*)$/);
  // 中文："当前有 2 名玩家在线：Alex, Steve" / "有 2 个玩家在线"
  if (!m) m = s.match(/\u5f53\u524d\u6709\s*(\d+)\s*\u540d\u73a9\u5bb6\u5728\u7ebf[:\uff1a]?\s*(.*)$/);
  if (!m) m = s.match(/\u6709\s*(\d+)\s*\u4e2a?\u73a9\u5bb6\u5728\u7ebf[:\uff1a]?\s*(.*)$/);
  if (!m) return false;
  const names = (m[2] || '')
    .split(/[,\uff0c]/)
    .map((x) => x.trim())
    .filter((x) => x && !/^(?:and|\u548c)$/i.test(x));
  onlinePlayers.clear();
  names.forEach((n) => onlinePlayers.add(n));
  return true;
}

function getOnlinePlayers() {
  return { count: onlinePlayers.size, players: [...onlinePlayers] };
}
function resetOnline() { onlinePlayers.clear(); }

// 通过控制台指令让服务端回吐在线名单（list），随后由 setOnlineFromListLine 解析
function requestOnlineList() {
  if (!serverProc) return false;
  try { serverProc.stdin.write('list\n'); return true; } catch { return false; }
}

function getJSON(url, tries = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: UA }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next;
        try { next = new URL(res.headers.location, url).href; } catch { next = res.headers.location; }
        return getJSON(next, tries).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        if (tries > 1) return setTimeout(() => getJSON(url, tries - 1).then(resolve, reject), 800);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        try { resolve(JSON.parse(b)); } catch (e) { reject(e); }
      });
      res.on('error', (e) => {
        if (tries > 1) return setTimeout(() => getJSON(url, tries - 1).then(resolve, reject), 800);
        reject(e);
      });
    });
    req.setTimeout(30000, () => req.destroy(new Error('请求超时：' + url)));
    req.on('error', (e) => {
      if (tries > 1) return setTimeout(() => getJSON(url, tries - 1).then(resolve, reject), 800);
      reject(e);
    });
  });
}

function get(url, dest, onProgress, tries = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const retry = (err) => {
      if (tries > 1) return setTimeout(() => get(url, dest, onProgress, tries - 1).then(resolve, reject), 800);
      reject(err);
    };
    const req = mod.get({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: UA }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next;
        try { next = new URL(res.headers.location, url).href; } catch { next = res.headers.location; }
        return get(next, dest, onProgress, tries).then(resolve, reject);
      }
      if (res.statusCode !== 200) return retry(new Error(`HTTP ${res.statusCode}`));
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const file = fs.createWriteStream(dest);
      let failed = false;
      const fail = (err) => {
        if (failed) return;
        failed = true;
        try { file.destroy(); } catch {}
        try { fs.unlinkSync(dest); } catch {}
        retry(err);
      };
      res.on('data', (d) => { got += d.length; onProgress && onProgress(got, total); });
      res.on('error', fail);
      file.on('error', fail);
      res.pipe(file);
      file.on('finish', () =>
        file.close(() => {
          if (failed) return;
          if (total > 0 && got !== total) return fail(new Error(`服务端下载不完整（${got}/${total}）`));
          resolve(dest);
        })
      );
    });
    req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error('下载超时')));
    req.on('error', (e) => retry(e));
  });
}

// ---------- 版本清单 ----------
let manifestCache = null;
function getText(url, tries = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.get({ hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: UA }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let next;
        try { next = new URL(res.headers.location, url).href; } catch { next = res.headers.location; }
        return getText(next, tries).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        if (tries > 1) return setTimeout(() => getText(url, tries - 1).then(resolve, reject), 800);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve(b.trim()));
      res.on('error', (e) => {
        if (tries > 1) return setTimeout(() => getText(url, tries - 1).then(resolve, reject), 800);
        reject(e);
      });
    });
    req.setTimeout(15000, () => req.destroy(new Error('请求超时：' + url)));
    req.on('error', (e) => {
      if (tries > 1) return setTimeout(() => getText(url, tries - 1).then(resolve, reject), 800);
      reject(e);
    });
  });
}

// 竞速拉取多个 URL，谁先返回有效结果用谁（用于镜像回退：bmclapi 在国内明显更快）
function getJSONRace(urls, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let pending = urls.length;
    const errs = [];
    urls.forEach((u) => {
      getJSON(u, 1).then(resolve, (e) => {
        errs.push(e);
        if (--pending === 0) reject(errs[0] || new Error('全部源失败'));
      });
    });
  });
}

async function vanillaManifest() {
  if (manifestCache) return manifestCache;
  // 优先 bmclapi（国内快），同时请求官方源，谁先回来用谁；失败自动回退
  const urls = [
    'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
    'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
  ];
  manifestCache = await getJSONRace(urls);
  return manifestCache;
}

// 服务端版本列表缓存（按类型，15 分钟内有效，避免频繁切类型时重复拉取）
const serverVerCache = {};

async function vanillaServerUrl(mcVersion) {
  const manifest = await vanillaManifest();
  const v = manifest.versions.find((x) => x.id === mcVersion);
  if (!v) throw new Error('未找到版本 ' + mcVersion);
  const detail = await getJSON(v.url);
  if (!detail.downloads || !detail.downloads.server) {
    throw new Error(`原版 ${mcVersion} 没有服务端 jar（可能是快照或极老版本）`);
  }
  return detail.downloads.server.url;
}

// Paper 可用版本列表（v3 API：按大版本分组）
async function paperVersions() {
  const data = await getJSON('https://fill.papermc.io/v3/projects/paper');
  const vers = data.versions || {};
  const all = [];
  for (const key of Object.keys(vers)) {
    if (Array.isArray(vers[key])) all.push(...vers[key]);
  }
  // 只保留正式版（去掉 rc/pre 后缀）
  return all.filter((v) => !/-(rc|pre)/i.test(v));
}

async function paperUrl(mcVersion) {
  const builds = await getJSON(`https://fill.papermc.io/v3/projects/paper/versions/${mcVersion}/builds`);
  if (!Array.isArray(builds) || !builds.length) throw new Error(`Paper 暂无 ${mcVersion} 构建`);
  const stable = builds.filter((b) => b.channel === 'STABLE');
  const list = stable.length ? stable : builds;
  const last = list[list.length - 1];
  const dl = last.downloads['server:default'] || last.downloads['server:mojang'];
  if (!dl) throw new Error('Paper 下载信息缺失');
  return dl.url;
}

// Paper 最新构建信息（含 build 号与下载地址），用于自动更新
async function paperLatestBuild(mcVersion) {
  const builds = await getJSON(`https://fill.papermc.io/v3/projects/paper/versions/${mcVersion}/builds`);
  if (!Array.isArray(builds) || !builds.length) throw new Error(`Paper 暂无 ${mcVersion} 构建`);
  const stable = builds.filter((b) => b.channel === 'STABLE');
  const list = stable.length ? stable : builds;
  const last = list[list.length - 1];
  const dl = last.downloads['server:default'] || last.downloads['server:mojang'];
  if (!dl) throw new Error('Paper 下载信息缺失');
  return { build: last.id, channel: last.channel, url: dl.url, mcVersion };
}

// Fabric 服务端
async function fabricUrl(mcVersion) {
  const installer = await getJSON('https://meta.fabricmc.net/v2/versions/installer');
  const loader = await getJSON('https://meta.fabricmc.net/v2/versions/loader');
  const iv = installer[0].version;
  const lv = loader[0].version;
  return `https://meta.fabricmc.net/v2/versions/loader/${mcVersion}/${lv}/${iv}/server/jar`;
}

// Forge 服务端安装器 URL（走 maven，自动选最新可用版本）
async function forgeInstallerUrl(mcVersion) {
  const meta = await getJSON('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
  const promos = meta.promos || {};
  // 优先 recommended，其次 latest
  let fv = promos[mcVersion + '-recommended'] || promos[mcVersion + '-latest'];
  if (!fv) throw new Error(`Forge 暂无 ${mcVersion} 的版本（请换版本或换服务端类型）`);
  // 带版本号 maven 路径，classifier 为 installer
  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${mcVersion}-${fv}/forge-${mcVersion}-${fv}-installer.jar`;
  return { url, forgeVersion: fv };
}

// NeoForge 服务端安装器 URL
async function neoforgeInstallerUrl(mcVersion) {
  const list = await getJSON('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge');
  const versions = (list.versions || []).filter((v) => v.startsWith(mcVersion.replace(/^1\./, '')));
  // mcVersion 1.21.1 -> neoforge 21.1.x
  const norm = mcVersion.replace(/^1\./, '');
  const cand = (list.versions || []).filter((v) => v.startsWith(norm + '.') || v === norm);
  const pick = cand.length ? cand[cand.length - 1] : null;
  if (!pick) throw new Error(`NeoForge 暂无 ${mcVersion} 的版本`);
  const url = `https://maven.neoforged.net/releases/net/neoforged/neoforge/${pick}/neoforge-${pick}-installer.jar`;
  return { url, forgeVersion: pick };
}

// 按类型返回可用版本列表
async function listServerVersions(type) {
  const key = type || 'vanilla';
  const c = serverVerCache[key];
  if (c && Date.now() - c.t < 15 * 60 * 1000 && c.list.length) return c.list;
  const list = await _listServerVersionsRaw(key);
  if (list && list.length) serverVerCache[key] = { t: Date.now(), list };
  return list;
}

async function _listServerVersionsRaw(type) {
  if (type === 'paper') {
    return await paperVersions();
  }
  const m = await vanillaManifest();
  if (type === 'snapshot') {
    return m.versions.filter((v) => v.type === 'snapshot').map((v) => v.id).slice(0, 100);
  }
  if (type === 'forge') {
    // 只列出 Forge 有推荐的版本
    try {
      const meta = await getJSON('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
      const promos = meta.promos || {};
      const vers = new Set();
      for (const k of Object.keys(promos)) {
        const mm = k.match(/^(.+)-(recommended|latest)$/);
        if (mm) vers.add(mm[1]);
      }
      const releases = m.versions.filter((v) => v.type === 'release' && vers.has(v.id)).map((v) => v.id);
      if (releases.length) return releases;
    } catch {}
    return m.versions.filter((v) => v.type === 'release').map((v) => v.id);
  }
  if (type === 'neoforge') {
    // NeoForge 版本号形如 21.1.256，对应 MC 版本按官方“版本映射”规则推算（21.1→1.21.1）
    try {
      const xml = await getText('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
      const vers = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((x) => x[1]);
      const mcSet = new Set();
      for (const v of vers) {
        // 形如 20.4.x → 1.20.4，21.1.x → 1.21.1，21.0.x → 1.21
        const mm = v.match(/^(\d+)\.(\d+)\.\d+/);
        if (!mm) continue;
        const a = mm[1], b = mm[2];
        const mc = b === '0' ? `1.${a}` : `1.${a}.${b}`;
        mcSet.add(mc);
      }
      const releases = m.versions.filter((v) => v.type === 'release' && mcSet.has(v.id)).map((v) => v.id);
      if (releases.length) return releases;
    } catch {}
    return m.versions.filter((v) => v.type === 'release').map((v) => v.id);
  }
  // vanilla / fabric 都基于正式版
  return m.versions.filter((v) => v.type === 'release').map((v) => v.id);
}

// ---------- 智能建服默认值：按内存/CPU 推荐类型与内存分配 ----------
function quickServerDefaults() {
  const totalGB = os.totalmem() / 1024 / 1024 / 1024;
  const cpus = os.cpus().length;
  // 服务器内存：总内存的 50%，夹在 1.5G~8G 之间，取 512 整数倍
  let mem = Math.round(Math.min(8192, Math.max(1536, totalGB * 1024 * 0.5)) / 512) * 512;
  // 类型：默认 Paper（性能好、兼容插件、启动快）；低配建议 Paper 而非 Forge
  const type = 'paper';
  return { type, memory: String(mem), totalGB: Math.round(totalGB), cpus };
}

// ---------- server.properties 优化 ----------
function defaultProperties(mem, opts = {}) {
  const o = opts || {};
  const lines = [
    '#Minecraft server properties (由 Cubik 启动器生成)',
    'server-port=' + (o.port || 25565),
    'gamemode=' + (o.gamemode || 'survival'),
    'difficulty=' + (o.difficulty || 'easy'),
    'max-players=' + (o.maxPlayers || 20),
    'online-mode=' + (o.onlineMode ? 'true' : 'false'),
    'motd=' + (o.motd || 'A Minecraft Server'),
    'level-name=world',
    'pvp=' + (o.pvp === false ? 'false' : 'true'),
    'enable-command-block=' + (o.commandBlock ? 'true' : 'false'),
    'white-list=' + (o.whitelist ? 'true' : 'false'),
    'enforce-whitelist=' + (o.whitelist ? 'true' : 'false'),
    'spawn-protection=16',
    'view-distance=10',
    'simulation-distance=8',
    'entity-broadcast-range-percentage=100',
    'sync-chunk-writes=false'
  ];
  return lines.join('\n') + '\n';
}

// ---------- 启动参数（按服务端类型区分 Aikar / 调优参数） ----------
function serverJvmArgs(type, memory) {
  const mem = parseInt(memory || 2048, 10);
  const xms = Math.max(512, Math.floor(mem / 2));
  const args = [`-Xms${xms}M`, `-Xmx${mem}M`];

  if (type === 'paper') {
    // Aikar 推荐参数（Paper 专用）
    args.push(
      '-XX:+UseG1GC',
      '-XX:+ParallelRefProcEnabled',
      '-XX:MaxGCPauseMillis=200',
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+DisableExplicitGC',
      '-XX:+AlwaysPreTouch',
      '-XX:G1NewSizePercent=30',
      '-XX:G1MaxNewSizePercent=40',
      '-XX:G1HeapRegionSize=8M',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapWastePercent=5',
      '-XX:G1MixedGCCountTarget=4',
      '-XX:InitiatingHeapOccupancyPercent=15',
      '-XX:G1MixedGCLiveThresholdPercent=90',
      '-XX:G1RSetUpdatingPauseTimePercent=5',
      '-XX:SurvivorRatio=32',
      '-XX:+PerfDisableSharedMem',
      '-XX:MaxTenuringThreshold=1',
      '-Dusing.aikars.flags=https://mcflags.emc.gs',
      '-Daikars.new.flags=true'
    );
  } else {
    // 原版 / Fabric：G1 + 基础调优
    args.push('-XX:+UseG1GC', '-XX:+UnlockExperimentalVMOptions', '-XX:MaxGCPauseMillis=200', '-XX:+DisableExplicitGC');
  }
  return args;
}

// 运行 Forge/NeoForge 安装器（java -jar installer --installServer）
function runForgeInstaller(javaExe, installerPath, dir, onLog) {
  return new Promise((resolve, reject) => {
    onLog && onLog('执行 Forge 安装器（首次可能下载大量依赖，请耐心等待）…');
    const proc = spawn(javaExe, ['-jar', installerPath, '--installServer'], { cwd: dir });
    let out = '';
    proc.stdout.on('data', (d) => { out += d.toString(); onLog && onLog(d.toString().trimEnd()); });
    proc.stderr.on('data', (d) => { out += d.toString(); onLog && onLog(d.toString().trimEnd()); });
    proc.on('error', (e) => reject(new Error('启动安装器失败（可能未安装 Java）：' + e.message)));
    proc.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`Forge 安装器退出码 ${code}，请查看日志`));
    });
  });
}

// 写 Forge 启动脚本（兼容新版 run.bat 与旧版 @argfile）
function writeForgeStartScripts(dir, type, memory, onLog, javaExe) {
  const files = fs.readdirSync(dir);
  const hasRunBat = files.includes('run.bat');
  const argsFile = files.find((f) => /^win_args\.txt$|^args\.txt$|^user_jvm_args\.txt$/.test(f));
  const jarCandidates = files.filter((f) => /forge.*\.jar$|server\.jar$/i.test(f) && !/installer/.test(f));
  const javaCmd = javaExe && path.isAbsolute(javaExe) ? '"' + javaExe.replace(/\\/g, '\\\\') + '"' : 'java';
  let scriptBat, scriptSh;
  if (hasRunBat) {
    scriptBat = '@echo off\r\nrun.bat\r\npause\r\n';
    scriptSh = '#!/bin/sh\nexec ./run.sh\n';
  } else {
    // 找启动 jar（常为 forge-xxx-server.jar 或 libraries 下）
    const jar = jarCandidates.find((f) => /server\.jar$/i.test(f)) || jarCandidates[0] || 'server.jar';
    const args = serverJvmArgs('paper', memory).join(' ');
    scriptBat = `@echo off\r\n${javaCmd} ${args} -jar ${jar} nogui\r\npause\r\n`;
    scriptSh = `#!/bin/sh\nexec ${javaExe || 'java'} ${args} -jar ${jar} nogui\n`;
  }
  fs.writeFileSync(path.join(dir, 'start.bat'), scriptBat, 'utf8');
  fs.writeFileSync(path.join(dir, 'start.sh'), scriptSh, 'utf8');
  onLog && onLog(argsFile ? `检测到 ${argsFile}，启动参数以安装器生成文件为准` : '已生成启动脚本');
}

// 创建服务器
async function createServer(opts, onProgress, onLog) {
  const { dir, type, mcVersion, memory } = opts;

  // —— 预检：参数校验，避免下游报晦涩错误 ——
  if (!dir) throw new Error('未指定服务器目录');
  if (!mcVersion) throw new Error('未选择 Minecraft 版本');
  if (!type) throw new Error('未选择服务端类型');
  if (fs.existsSync(dir)) {
    // 目录里已有服务器？询问是否覆盖（这里仅提示，不阻断）
    const hasServer = fs.existsSync(path.join(dir, 'server.jar')) ||
      fs.existsSync(path.join(dir, 'run.bat')) ||
      fs.existsSync(path.join(dir, 'server.properties'));
    if (hasServer) onLog && onLog('⚠ 该目录已存在服务器文件，将保留配置、仅补充缺失部分');
  }
  fs.mkdirSync(dir, { recursive: true });
  onLog && onLog(`创建服务器目录: ${dir}`);

  // —— 自动下载该 MC 版本所需的 Java 运行时（Adoptium，国内镜像优先）——
  const mcDir = opts.mcDir || 'D:\\CubikLauncher';
  let javaExe = opts.javaPath && opts.javaPath.trim() ? opts.javaPath.trim() : null;
  if (!javaExe || !/^java(\.exe)?$/i.test(path.basename(javaExe))) {
    // 未指定有效 java，或指定的是系统 java：自动确保正确版本
  }
  if (!javaExe) {
    onLog && onLog(`检查 Java 运行时（MC ${mcVersion} 需要 Java ${requiredJava(mcVersion)}）…`);
    try {
      javaExe = await ensureJava(mcVersion, mcDir, onProgress, onLog);
    } catch (e) {
      onLog && onLog('⚠ 自动下载 Java 失败：' + (e && e.message) + '（将回退到系统 java）');
      javaExe = 'java';
    }
  }
  onLog && onLog('服务器将使用 Java: ' + javaExe);

  // Forge / NeoForge 需要下载安装器并执行 --installServer（多一步）
  if (type === 'forge' || type === 'neoforge') {
    const info = type === 'forge'
      ? await forgeInstallerUrl(mcVersion)
      : await neoforgeInstallerUrl(mcVersion);
    onLog && onLog(`使用 ${type} ${info.forgeVersion}（会自动下载依赖，首次较慢）`);
    const instPath = path.join(dir, `${type}-installer.jar`);
    onLog && onLog('下载安装器…');
    await get(info.url, instPath, onProgress);
    // 执行安装（使用刚确保的 java）
    await runForgeInstaller(javaExe, instPath, dir, onLog);
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n', 'utf8');
    const props = path.join(dir, 'server.properties');
    if (!fs.existsSync(props)) fs.writeFileSync(props, defaultProperties(memory, opts), 'utf8');
    // 生成启动脚本（forge 的启动命令在生成的文件里，通常为 run.bat/run.sh 或 libraries 组合）
    writeForgeStartScripts(dir, type, memory, onLog, javaExe);
    // 带上已下载的本地模组
    if (Array.isArray(opts.localMods) && opts.localMods.length) {
      onLog && onLog('导入已下载的本地 Mod…');
      installLocalMods(dir, opts.localMods, onLog);
    }
    onLog && onLog('服务器创建完成，可点击「启动服务器」');
    return { ok: true, dir, javaPath: javaExe, args: serverJvmArgs('paper', memory) };
  }

  let url;
  const jarName = 'server.jar';
  if (type === 'paper') {
    onLog && onLog('获取 Paper 下载地址…');
    url = await paperUrl(mcVersion);
    onLog && onLog('使用 Paper 服务端（性能优化）');
  } else if (type === 'fabric') {
    onLog && onLog('获取 Fabric 服务端…');
    url = await fabricUrl(mcVersion);
    onLog && onLog('使用 Fabric 服务端');
  } else {
    url = await vanillaServerUrl(mcVersion);
    onLog && onLog('使用原版服务端');
  }

  onLog && onLog('下载服务端 jar…');
  await get(url, path.join(dir, jarName), onProgress);
  onLog && onLog('服务端 jar 下载完成');

  // eula
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n', 'utf8');
  onLog && onLog('已自动同意 EULA (eula.txt)');

  // server.properties（不存在才写）
  const props = path.join(dir, 'server.properties');
  if (!fs.existsSync(props)) {
    fs.writeFileSync(props, defaultProperties(memory, opts), 'utf8');
    onLog && onLog('已生成 server.properties');
  }

  // 启动脚本（bat + sh），含调优参数，并用刚下载的 java 绝对路径（避免依赖系统 java）
  const args = serverJvmArgs(type, memory).join(' ');
  // 若 javaExe 是具体路径（自动下载的），写绝对路径；若是系统 "java" 则写 java
  const javaCmd = path.isAbsolute(javaExe) ? '"' + javaExe.replace(/\\/g, '\\\\') + '"' : 'java';
  fs.writeFileSync(
    path.join(dir, 'start.bat'),
    `@echo off\r\n${javaCmd} ${args} -jar server.jar nogui\r\npause\r\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'start.sh'),
    `#!/bin/sh\nexec ${javaExe} ${args} -jar server.jar nogui\n`,
    'utf8'
  );
  onLog && onLog('服务器创建完成，可点击「启动服务器」');
  // 带上已下载的本地模组（仅 Fabric/Forge/NeoForge 生效，其它类型也照常放入 mods 目录）
  if (Array.isArray(opts.localMods) && opts.localMods.length) {
    onLog && onLog('导入已下载的本地 Mod…');
    installLocalMods(dir, opts.localMods, onLog);
  }

  return { ok: true, dir, javaPath: javaExe, args: serverJvmArgs(type, memory) };
}

function startServer(dir, javaPath, memory, type, onLog, onData) {
  if (serverProc) return { ok: false, error: '\u670d\u52a1\u5668\u5df2\u5728\u8fd0\u884c' };
  if (!dir || !fs.existsSync(dir)) return { ok: false, error: '\u670d\u52a1\u5668\u76ee\u5f55\u4e0d\u5b58\u5728\uff0c\u8bf7\u5148\u521b\u5efa\u670d\u52a1\u5668' };

  const LOG = onLog || (() => {});
  const DATA = onData || (() => {});
  const java = javaPath || 'java';

  // 预检 Java 可执行文件
  if (!/^java(\.exe)?$/i.test(path.basename(java)) && !fs.existsSync(java)) {
    return { ok: false, error: '\u672a\u627e\u5230 Java\uff1a' + java + '\uff08\u8bf7\u5148\u5b89\u88c5 Java \u6216\u5728\u8bbe\u7f6e\u91cc\u6307\u5b9a\uff09' };
  }

  // 探测服务端类型与启动 jar
  let srvType = type;
  let files = [];
  try { files = fs.readdirSync(dir); } catch (e) { return { ok: false, error: '\u65e0\u6cd5\u8bfb\u53d6\u76ee\u5f55\uff1a' + e.message }; }

  const isForgeLike = files.includes('run.bat') || files.includes('run.sh') ||
    files.some((f) => /^forge-.*\.jar$/i.test(f)) || files.some((f) => /^neoforge-.*\.jar$/i.test(f)) ||
    fs.existsSync(path.join(dir, 'libraries', 'net', 'minecraftforge')) || fs.existsSync(path.join(dir, 'libraries', 'net', 'neoforged'));
  if (!srvType) {
    if (isForgeLike) srvType = 'forge';
    else if (fs.existsSync(path.join(dir, 'config')) || fs.existsSync(path.join(dir, 'paper-global.yml'))) srvType = 'paper';
    else srvType = 'vanilla';
  }

  const spawnOpts = { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true };
  let cmd, args, label;

  // Forge/NeoForge 优先用生成器提供的 run.bat / @argfile
  if (isForgeLike && files.includes('run.bat')) {
    label = 'Forge run.bat';
    cmd = 'cmd.exe';
    args = ['/c', 'run.bat', 'nogui'];
  } else {
    // 找启动 jar：优先 server.jar，其次 forge/neoforge/fabric/paper jar
    let jar = null;
    if (files.includes('server.jar')) jar = 'server.jar';
    else {
      jar = files.find((f) => /^forge-.*-server\.jar$/i.test(f)) ||
            files.find((f) => /^(?:forge|neoforge|fabric|paper|purpur|spigot|craftbukkit)-.*\.jar$/i.test(f) && !/installer/i.test(f)) ||
            files.find((f) => /\.jar$/i.test(f) && !/installer/i.test(f));
    }
    if (!jar) return { ok: false, error: '\u672a\u627e\u5230\u670d\u52a1\u7aef jar\uff0c\u8bf7\u5148\u521b\u5efa\u670d\u52a1\u5668' };
    cmd = java;
    args = serverJvmArgs(srvType, memory).concat(['-jar', jar, 'nogui']);
    label = jar;
  }

  // 启动前自动纠正：离线玩家进不来最常见的坑是 online-mode=true。
  // 若服务器已生成 server.properties 且为 true，但启动器当前没有激活的正版账号，
  // 自动改为 false，避免“无效会话/Invalid session”导致离线账号无法进入。
  try {
    const propsPath = path.join(dir, 'server.properties');
    if (fs.existsSync(propsPath)) {
      const raw = fs.readFileSync(propsPath, 'utf8');
      if (/^\s*online-mode\s*=\s*true\s*$/im.test(raw)) {
        const fixed = raw.replace(/^\s*online-mode\s*=\s*true\s*$/im, 'online-mode=false');
        fs.writeFileSync(propsPath, fixed, 'utf8');
        LOG('[\u63d0\u793a] \u68c0\u6d4b\u5230 online-mode=true\uff0c\u5df2\u81ea\u52a8\u6539\u4e3a false\uff08\u5426\u5219\u79bb\u7ebf\u8d26\u53f7\u4f1a\u62a5\u201c\u65e0\u6548\u4f1a\u8bdd\u201d\uff09\u3002\u5982\u9700\u4ec5\u6b63\u7248\u53ef\u8fdb\uff0c\u8bf7\u5728\u8bbe\u7f6e\u91cc\u6253\u5f00\u201c\u6b63\u7248\u9a8c\u8bc1\u201d\u3002');
      }
    }
  } catch (e) {
    LOG('[\u63d0\u793a] \u81ea\u52a8\u6821\u6b63 online-mode \u5931\u8d25\uff08\u5df2\u8df3\u8fc7\uff09\uff1a' + (e && e.message ? e.message : e));
  }

  LOG('\u542f\u52a8\u547d\u4ee4: ' + cmd + ' ' + args.join(' '));

  try {
    serverProc = spawn(cmd, args, spawnOpts);
  } catch (e) {
    serverProc = null;
    return { ok: false, error: '\u542f\u52a8\u5931\u8d25\uff1a' + e.message };
  }

  serverState = 'starting';
  serverStartedAt = Date.now();
  serverDir = dir;
  resetOnline();
  hookProc(DATA);

  // 启动超时监控：90s 内未出现 "Done" 也未退出则提示
  const startGuard = setTimeout(() => {
    if (serverState === 'starting') {
      DATA('\n[\u63d0\u793a] \u670d\u52a1\u5668\u542f\u52a8\u8f83\u6162\uff08\u9996\u6b21\u751f\u6210\u4e16\u754c\u53ef\u80fd\u9700\u8981 1-2 \u5206\u949f\uff09\u3002\u82e5\u957f\u65f6\u95f4\u65e0\u54cd\u5e94\uff0c\u8bf7\u68c0\u67e5\u5185\u5b58\u662f\u5426\u8db3\u591f\u3002\n');
    }
  }, 90000);
  serverProc._startGuard = startGuard;

  return { ok: true, args, label };
}

function hookProc(onData) {
  if (!serverProc) return;
  const push = (d) => { try { onData(String(d)); } catch {} };

  serverProc.stdout.on('data', push);
  serverProc.stderr.on('data', push);

  serverProc.on('error', (err) => {
    push(`\n[\u542f\u52a8\u5931\u8d25] ${err.message}${/ENOENT/.test(err.message) ? '\uff08\u627e\u4e0d\u5230 Java\uff0c\u8bf7\u68c0\u67e5 Java \u8def\u5f84\uff09' : ''}\n`);
    finishProc(-1);
  });

  serverProc.on('close', (code) => finishProc(code));
}

function finishProc(code) {
  if (serverProc && serverProc._startGuard) clearTimeout(serverProc._startGuard);
  const wasRunning = serverState !== 'stopped';
  if (serverProc && onDataSink && wasRunning) {
    const seconds = serverStartedAt ? Math.round((Date.now() - serverStartedAt) / 1000) : 0;
    onDataSink(`\n[\u670d\u52a1\u5668\u5df2\u9000\u51fa\uff0c\u9000\u51fa\u7801 ${code}${seconds ? '\uff08\u8fd0\u884c ' + seconds + 's\uff09' : ''}]\n`);
  }
  serverProc = null;
  serverState = 'stopped';
  serverStartedAt = 0;
  onDataSink = null;
  resetOnline();
}

function stopServer() {
  if (!serverProc) return { ok: false, error: '\u6ca1\u6709\u8fd0\u884c\u4e2d\u7684\u670d\u52a1\u5668' };
  serverState = 'stopping';
  try {
    serverProc.stdin.write('stop\n');
  } catch {
    try { serverProc.kill(); } catch {}
    return { ok: true, forced: true };
  }
  // 10s 内未退出则强制结束
  const p = serverProc;
  setTimeout(() => {
    if (serverProc === p) { try { serverProc.kill(); } catch {} }
  }, 10000);
  return { ok: true };
}

function sendCommand(cmd) {
  if (!serverProc) return { ok: false, error: '\u670d\u52a1\u5668\u672a\u8fd0\u884c' };
  try { serverProc.stdin.write(cmd + '\n'); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }
}

function isRunning() {
  return !!serverProc;
}

function getState() {
  return {
    state: serverState,
    running: !!serverProc,
    startedAt: serverStartedAt,
    dir: serverDir,
    uptime: serverStartedAt ? Math.round((Date.now() - serverStartedAt) / 1000) : 0
  };
}

// 解析 server.properties 里的端口（读 servers 目录下的 server.properties）
function readServerPort(dir) {
  try {
    const p = path.join(dir, 'server.properties');
    if (!fs.existsSync(p)) return 25565;
    const txt = fs.readFileSync(p, 'utf8');
    const m = txt.match(/^server-port\s*=\s*(\d+)/m);
    if (m) return parseInt(m[1], 10);
  } catch {}
  return 25565;
}

// 局域网 IP（取第一个非回环 IPv4）
function getLanIP() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push({ name, address: ni.address });
    }
  }
  // 优先 192.168 / 10. / 172.16-31
  const priv = out.find((x) => /^192\.168\./.test(x.address)) ||
               out.find((x) => /^10\./.test(x.address)) ||
               out.find((x) => /^172\.(1[6-9]|2\d|3[01])\./.test(x.address)) ||
               out[0];
  return priv || null;
}

// 公网 IP（多个服务，逐一尝试；优先 IPv4）
function getPublicIP() {
  return new Promise((resolve) => {
    let done = false;
    let firstV6 = '';
    const isV6 = (ip) => ip && ip.includes(':');
    const finish = (ip, isp) => {
      if (done || !ip) return;
      if (isV6(ip)) { if (!firstV6) firstV6 = ip; return; } // 先留着 IPv6，等 IPv4
      done = true;
      resolve({ ok: true, ip, isp: isp || '' });
    };
    // 优先只拿 IPv4 的接口
    getJSON('https://api.ipify.org?format=json', 2).then((d) => finish(d.ip, '')).catch(() => {});
    getText('https://api.ipify.org', 2).then((t) => finish(t, '')).catch(() => {});
    getJSON('https://ipv4.icanhazip.com', 2).catch(() => {});
    getText('https://ipv4.icanhazip.com', 2).then((t) => finish(t, '')).catch(() => {});
    getJSON('https://ipapi.co/json/', 2)
      .then((d) => finish(d.ip, `${d.org || d.isp || ''} ${d.country_name || d.country || ''}`.trim()))
      .catch(() => {});
    getText('https://ifconfig.me/ip', 2).then((t) => finish(t, '')).catch(() => {});
    // 总超时兜底：若只有 IPv6 也先用着
    setTimeout(() => { if (!done) { done = true; resolve(firstV6 ? { ok: true, ip: firstV6, isp: '', v6: true } : { ok: false }); } }, 8000);
  });
}

// 服务器网络信息汇总
async function serverInfo(dir) {
  const lan = getLanIP();
  const port = readServerPort(dir);
  const pub = await getPublicIP();
  let props = {};
  try {
    const p = path.join(dir, 'server.properties');
    if (fs.existsSync(p)) {
      fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach((line) => {
        const m = line.match(/^([\w.-]+)\s*=\s*(.*)$/);
        if (m) props[m[1]] = m[2];
      });
    }
  } catch {}
  return {
    ok: true,
    running: !!serverProc,
    lan,
    public: pub,
    port,
    onlineMode: props['online-mode'] !== 'false',
    motd: props['motd'] || 'A Minecraft Server',
    maxPlayers: props['max-players'] || '20',
    viewDistance: props['view-distance'] || '10',
    lanAddr: lan ? `${lan.address}:${port}` : '',
    publicAddr: pub && pub.ok ? `${pub.ip}:${port}` : ''
  };
}

// 更新 server.properties 中的若干键（保留其他内容与注释）
function updateServerProperties(dir, updates = {}) {
  const props = path.join(dir, 'server.properties');
  if (!fs.existsSync(props)) return { ok: false, error: '未找到 server.properties，请先创建服务器' };
  const raw = fs.readFileSync(props, 'utf8');
  const lines = raw.split(/\r?\n/);
  const keys = Object.keys(updates);
  const seen = {};
  const out = lines.map((line) => {
    const m = /^([^#=]+)=(.*)$/.exec(line);
    if (!m) return line;
    const k = m[1].trim();
    if (keys.includes(k)) { seen[k] = true; return k + '=' + updates[k]; }
    return line;
  });
  // 追加不存在的键
  for (const k of keys) {
    if (!seen[k]) out.push(k + '=' + updates[k]);
  }
  fs.writeFileSync(props, out.join('\n'), 'utf8');
  return { ok: true };
}

// ---------- 服务端类型/版本检测 + 自动更新 ----------
// 从服务器目录推断当前服务端类型与版本。
function detectServer(dir) {
  const res = { type: 'unknown', mcVersion: '', build: '', current: '', raw: '' };
  if (!dir || !fs.existsSync(dir)) return res;

  // 1) version_history.json（Paper/Spigot/Bukkit 会写）：{"currentVersion":"git-Paper-18 (MC: 1.20.1)"}
  try {
    const vh = path.join(dir, 'version_history.json');
    if (fs.existsSync(vh)) {
      const j = JSON.parse(fs.readFileSync(vh, 'utf8'));
      const cur = j.currentVersion || '';
      res.raw = cur;
      const m = cur.match(/git-(\w+)-(\d+)\s*\(MC:\s*([^)]+)\)/i);
      if (m) {
        const name = m[1].toLowerCase();
        res.type = name === 'paper' ? 'paper' : name === 'spigot' ? 'spigot' : name;
        res.build = m[2];
        res.mcVersion = m[3].trim();
        res.current = cur;
        return res;
      }
    }
  } catch {}

  // 2) Fabric：fabric-server-launch.properties 或 .fabric 目录 + launch jar
  try {
    const hasFabric = fs.existsSync(path.join(dir, '.fabric')) ||
      fs.existsSync(path.join(dir, 'fabric-server-launch.jar')) ||
      fs.existsSync(path.join(dir, 'fabric-server-launcher.properties'));
    if (hasFabric) {
      res.type = 'fabric';
      // 尝试从 .fabric/remappedJars 或 log 取 mc 版本
      const lf = path.join(dir, 'logs', 'latest.log');
      if (fs.existsSync(lf)) {
        const txt = fs.readFileSync(lf, 'utf8').slice(-20000);
        const mm = txt.match(/Loading Minecraft ([\d.]+)/i) || txt.match(/minecraft server version ([\d.]+)/i);
        if (mm) res.mcVersion = mm[1];
      }
      res.current = 'Fabric';
      return res;
    }
  } catch {}

  // 3) Forge/NeoForge：libraries 下 net/minecraftforge 或 neoforged
  try {
    const libs = path.join(dir, 'libraries');
    if (fs.existsSync(path.join(libs, 'net', 'neoforged'))) {
      res.type = 'neoforge'; res.current = 'NeoForge'; return res;
    }
    if (fs.existsSync(path.join(libs, 'net', 'minecraftforge'))) {
      res.type = 'forge'; res.current = 'Forge'; return res;
    }
  } catch {}

  // 4) 兜底：有 server.jar 且无特征 → 视为原版；尝试从 start.bat 里解析 mc 版本（不可得则空）
  if (fs.existsSync(path.join(dir, 'server.jar'))) {
    res.type = 'vanilla';
    res.current = '原版/未知';
  }
  return res;
}

// 检查服务端是否有可用更新（不需要运行中）
async function checkServerUpdate(dir) {
  const det = detectServer(dir);
  const info = { ...det, latest: '', latestBuild: '', hasUpdate: false, note: '', canUpdate: false };
  try {
    if (det.type === 'paper' && det.mcVersion) {
      const lb = await paperLatestBuild(det.mcVersion);
      info.latestBuild = String(lb.build);
      info.latest = `Paper #${lb.build} (MC: ${det.mcVersion})`;
      info.hasUpdate = String(lb.build) !== String(det.build);
      info.canUpdate = true;
      info.downloadUrl = lb.url;
      if (!info.hasUpdate) info.note = '已是最新版';
      else info.note = `有新版：#${lb.build}（当前 #${det.build}）`;
    } else if (det.type === 'vanilla' && det.mcVersion) {
      info.note = '原版服务端需按 MC 版本下载，请到「建服」重装对应版本';
    } else {
      info.note = det.type === 'unknown' ? '未能识别服务端类型，无法自动更新' : `${det.type} 暂不支持自动更新`;
    }
  } catch (e) {
    info.note = '检查更新失败：' + e.message;
  }
  return info;
}

// 执行更新（仅支持 Paper）：先备份旧 jar，再下载新 jar 覆盖
async function updateServerJar(dir, onLog, onProgress) {
  const det = detectServer(dir);
  if (det.type !== 'paper' || !det.mcVersion) {
    return { ok: false, error: '暂仅支持 Paper 服务端自动更新（当前识别为：' + det.type + '）' };
  }
  if (serverProc) return { ok: false, error: '请先停止服务器再更新' };
  const lb = await paperLatestBuild(det.mcVersion);
  const jar = path.join(dir, 'server.jar');
  // 备份旧 jar
  if (fs.existsSync(jar)) {
    const bakDir = path.join(dir, '.backups', 'server-jar');
    fs.mkdirSync(bakDir, { recursive: true });
    const bak = path.join(bakDir, `server__${det.build || 'old'}__${Date.now()}.jar`);
    try { fs.copyFileSync(jar, bak); onLog && onLog('已备份旧服务端：' + path.basename(bak)); } catch {}
  }
  onLog && onLog(`下载 Paper #${lb.build} …`);
  const tmp = jar + '.download';
  await get(lb.url, tmp, onProgress);
  fs.renameSync(tmp, jar);
  onLog && onLog(`已更新到 Paper #${lb.build}`);
  return { ok: true, build: lb.build, mcVersion: det.mcVersion };
}

// ---------- 服务端 Mod 管理 ----------
// 只在 Fabric / Forge / NeoForge 服务端里放 mod；Paper/Vanilla 用插件而不是 mod。
function serverModsDir(dir) {
  return path.join(dir, 'mods');
}

// 判断该服务端类型是否支持 Mod
function serverSupportsMods(type) {
  return type === 'fabric' || type === 'forge' || type === 'neoforge';
}

// 列出服务端 mods 目录下的模组（.jar / .jar.disabled）
function listServerMods(dir) {
  const md = serverModsDir(dir);
  if (!dir || !fs.existsSync(md)) return { ok: true, dir: md, list: [], supports: null };
  const det = detectServer(dir);
  let names = [];
  try { names = fs.readdirSync(md); } catch (e) { return { ok: false, error: e.message }; }
  const list = names
    .filter((n) => /\.jar(\.disabled)?$/i.test(n))
    .map((n) => {
      const full = path.join(md, n);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch {}
      return {
        file: n,
        size,
        mtime,
        disabled: /\.disabled$/i.test(n),
      };
    })
    .sort((a, b) => (a.disabled - b.disabled) || a.file.localeCompare(b.file));
  return { ok: true, dir: md, list, supports: serverSupportsMods(det.type), type: det.type, mcVersion: det.mcVersion };
}

// 从任意 URL 安装一个 mod 到服务端 mods 目录（支持进度回调）
async function installServerMod(dir, opts = {}, onProgress, onLog) {
  const { url, filename } = opts;
  if (!dir || !fs.existsSync(dir)) throw new Error('服务器目录不存在，请先创建/选择服务器');
  if (!url) throw new Error('缺少下载地址');
  const det = detectServer(dir);
  if (det.type === 'paper' || det.type === 'spigot' || det.type === 'vanilla') {
    onLog && onLog(`⚠ 当前服务端是 ${det.current || det.type}，通常用「插件」而不是 Mod。已照常放入 mods 目录，但可能不会生效。`);
  }
  const md = serverModsDir(dir);
  fs.mkdirSync(md, { recursive: true });
  let name = filename || decodeURIComponent(url.split('/').pop().split('?')[0]) || 'mod.jar';
  name = name.replace(/[\\/:*?"<>|]/g, '_');
  if (!/\.jar$/i.test(name)) name += '.jar';
  const dest = path.join(md, name);
  onLog && onLog(`下载 Mod：${name}`);
  const tmp = dest + '.download';
  await get(url, tmp, onProgress);
  if (fs.existsSync(dest)) { try { fs.unlinkSync(dest); } catch {} }
  fs.renameSync(tmp, dest);
  onLog && onLog(`已安装到 ${path.join('mods', name)}`);
  return { ok: true, file: name, dir: md };
}

// 把本地已有的 jar 文件复制到服务端 mods 目录（建服时可"带上已下载的模组"）
// files: [{ path, name? }]；返回 { ok, added:[], skipped:[], errors:[] }
function installLocalMods(dir, files, onLog) {
  const out = { ok: true, added: [], skipped: [], errors: [] };
  if (!dir) { out.ok = false; out.error = '未指定服务器目录'; return out; }
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  if (!list.length) return out;
  const md = serverModsDir(dir);
  fs.mkdirSync(md, { recursive: true });
  for (const item of list) {
    const src = typeof item === 'string' ? item : item.path;
    if (!src) continue;
    try {
      if (!fs.existsSync(src)) { out.errors.push({ file: src, error: '文件不存在' }); continue; }
      let name = (typeof item === 'object' && item.name) ? item.name : path.basename(src);
      name = String(name).replace(/[\\/:*?"<>|]/g, '_');
      if (!/\.jar$/i.test(name)) name += '.jar';
      const dest = path.join(md, name);
      // 目标已存在同名：跳过（避免重复/覆盖）
      if (fs.existsSync(dest) && path.resolve(dest) !== path.resolve(src)) {
        out.skipped.push(name);
        onLog && onLog(`⏭ 已存在同名 Mod，跳过：${name}`);
        continue;
      }
      if (path.resolve(dest) === path.resolve(src)) { out.skipped.push(name); continue; }
      fs.copyFileSync(src, dest);
      out.added.push(name);
      onLog && onLog(`复制 Mod 到 mods：${name}`);
    } catch (e) {
      out.errors.push({ file: src, error: e.message });
      onLog && onLog(`⚠ 复制 Mod 失败：${path.basename(src)} — ${e.message}`);
    }
  }
  onLog && onLog(`本地 Mod 导入完成：成功 ${out.added.length} 个` + (out.skipped.length ? `，跳过 ${out.skipped.length} 个` : '') + (out.errors.length ? `，失败 ${out.errors.length} 个` : ''));
  return out;
}

// 启用/停用一个 mod（改名 .disabled）
function toggleServerMod(dir, file, disabled) {
  const md = serverModsDir(dir);
  const clean = path.basename(file);
  const isDis = /\.disabled$/i.test(clean);
  const base = isDis ? clean.replace(/\.disabled$/i, '') : clean;
  const from = path.join(md, isDis ? base + '.disabled' : base);
  const to = path.join(md, disabled ? base + '.disabled' : base);
  if (!fs.existsSync(from)) return { ok: false, error: '文件不存在：' + clean };
  fs.renameSync(from, to);
  return { ok: true, file: path.basename(to) };
}

// 删除一个 mod
function deleteServerMod(dir, file) {
  const md = serverModsDir(dir);
  const target = path.join(md, path.basename(file));
  if (!fs.existsSync(target)) return { ok: false, error: '文件不存在' };
  fs.unlinkSync(target);
  return { ok: true };
}

module.exports = { createServer, startServer, stopServer, sendCommand, listServerVersions, isRunning, getState, requestOnlineList, serverJvmArgs, serverInfo, getLanIP, getPublicIP, readServerPort, updateServerProperties, parseServerLine, setOnlineFromListLine, getOnlinePlayers, resetOnline, quickServerDefaults, detectServer, checkServerUpdate, updateServerJar, paperLatestBuild, serverModsDir, serverSupportsMods, listServerMods, installServerMod, installLocalMods, toggleServerMod, deleteServerMod };
