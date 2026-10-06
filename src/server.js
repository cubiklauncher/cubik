// server.js - 在启动器内创建/管理 Minecraft 服务器
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');

let serverProc = null;
const UA = { 'User-Agent': 'Cubik/1.0' };

// ---------- 在线玩家 / 聊天追踪 ----------
// 从服务端 stdout 行中解析玩家进/出/聊天/死亡等事件。
// 兼容 Vanilla / Paper / Forge / Fabric 常见输出格式。
const onlinePlayers = new Set();
let _pendingKick = null;

// 去掉 ANSI 颜色码
function stripAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, '');
}

// 解析一行服务端输出，返回结构化事件或 null
function parseServerLine(raw) {
  const line = stripAnsi(raw).replace(/\r$/, '');
  if (!line.trim()) return null;
  const ts = Date.now();

  // 玩家加入："<name> joined the game" / "<name> joined the game (" / "<name>[/ip:端口] logged in with entity id ..."
  let m =
    line.match(/\]:\s*([A-Za-z0-9_]{1,16})\s+joined the game/) ||
    line.match(/\]:\s*([A-Za-z0-9_]{1,16})\[[^\]]*\]\s+logged in with entity id/);
  if (m) {
    const name = m[1];
    onlinePlayers.add(name);
    return { type: 'join', name, online: onlinePlayers.size };
  }

  // 玩家离开："<name> left the game" / "<name> lost connection: ..."
  m =
    line.match(/\]:\s*([A-Za-z0-9_]{1,16})\s+left the game/) ||
    line.match(/\]:\s*([A-Za-z0-9_]{1,16})\s+lost connection:/);
  if (m) {
    const name = m[1];
    onlinePlayers.delete(name);
    return { type: 'leave', name, online: onlinePlayers.size };
  }

  // 聊天消息："[Not Secure] <name> 内容" 或 "<name> 内容"（Paper/Vanilla 常见）
  m = line.match(/\]:\s*(?:\[[^\]]*\]\s*)?<([A-Za-z0-9_]{1,16})>\s?(.*)$/);
  if (m) {
    return { type: 'chat', name: m[1], text: m[2], online: onlinePlayers.size };
  }

  // 系统提示（含加入/离开的彩色提示），如 "[CHAT] xxx"、"* xxx joined"
  if (/\]:\s*\*?\s*[A-Za-z0-9_]{1,16}\s+(joined|left)\b/.test(line)) {
    return { type: 'system', text: line.replace(/^.*\]:\s*/, '') };
  }

  // 死亡/成就等广播（可选）
  m = line.match(/\]:\s*([A-Za-z0-9_]{1,16})\s+(was slain|was killed|drowned|blew up|fell|burned|starved|died|hit the ground|withered away|was shot)/);
  if (m) return { type: 'death', name: m[1], text: line.replace(/^.*\]:\s*/, '') };

  return null;
}

// 主动同步在线名单（从日志中的 } 行或 list 命令输出解析）
function setOnlineFromListLine(line) {
  // 形如: "There are 2 of a max of 20 players online: Alex, Steve"
  const m = stripAnsi(line).match(/There are (\d+) of a max of \d+ players online:?\s*(.*)$/);
  if (!m) return false;
  const names = (m[2] || '').split(',').map((s) => s.trim()).filter(Boolean);
  onlinePlayers.clear();
  names.forEach((n) => onlinePlayers.add(n));
  return true;
}

function getOnlinePlayers() {
  return { count: onlinePlayers.size, players: [...onlinePlayers] };
}
function resetOnline() { onlinePlayers.clear(); }

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

async function vanillaManifest() {
  if (manifestCache) return manifestCache;
  manifestCache = await getJSON('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  return manifestCache;
}

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
function writeForgeStartScripts(dir, type, memory, onLog) {
  const files = fs.readdirSync(dir);
  const hasRunBat = files.includes('run.bat');
  const argsFile = files.find((f) => /^win_args\.txt$|^args\.txt$|^user_jvm_args\.txt$/.test(f));
  const jarCandidates = files.filter((f) => /forge.*\.jar$|server\.jar$/i.test(f) && !/installer/.test(f));
  let scriptBat, scriptSh;
  if (hasRunBat) {
    scriptBat = '@echo off\r\nrun.bat\r\npause\r\n';
    scriptSh = '#!/bin/sh\nexec ./run.sh\n';
  } else {
    // 找启动 jar（常为 forge-xxx-server.jar 或 libraries 下）
    const jar = jarCandidates.find((f) => /server\.jar$/i.test(f)) || jarCandidates[0] || 'server.jar';
    const args = serverJvmArgs('paper', memory).join(' ');
    scriptBat = `@echo off\r\njava ${args} -jar ${jar} nogui\r\npause\r\n`;
    scriptSh = `#!/bin/sh\nexec java ${args} -jar ${jar} nogui\n`;
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

  // Forge / NeoForge 需要下载安装器并执行 --installServer（多一步）
  if (type === 'forge' || type === 'neoforge') {
    const info = type === 'forge'
      ? await forgeInstallerUrl(mcVersion)
      : await neoforgeInstallerUrl(mcVersion);
    onLog && onLog(`使用 ${type} ${info.forgeVersion}（会自动下载依赖，首次较慢）`);
    const instPath = path.join(dir, `${type}-installer.jar`);
    onLog && onLog('下载安装器…');
    await get(info.url, instPath, onProgress);
    // 执行安装（需要 java）
    const javaExe = opts.javaPath || 'java';
    await runForgeInstaller(javaExe, instPath, dir, onLog);
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n', 'utf8');
    const props = path.join(dir, 'server.properties');
    if (!fs.existsSync(props)) fs.writeFileSync(props, defaultProperties(memory, opts), 'utf8');
    // 生成启动脚本（forge 的启动命令在生成的文件里，通常为 run.bat/run.sh 或 libraries 组合）
    writeForgeStartScripts(dir, type, memory, onLog);
    onLog && onLog('服务器创建完成，可点击「启动服务器」');
    return { ok: true, dir, args: serverJvmArgs('paper', memory) };
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

  // 启动脚本（bat + sh），含调优参数
  const args = serverJvmArgs(type, memory).join(' ');
  fs.writeFileSync(
    path.join(dir, 'start.bat'),
    `@echo off\r\njava ${args} -jar server.jar nogui\r\npause\r\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'start.sh'),
    `#!/bin/sh\nexec java ${args} -jar server.jar nogui\n`,
    'utf8'
  );
  onLog && onLog('服务器创建完成，可点击「启动服务器」');

  return { ok: true, dir, args: serverJvmArgs(type, memory) };
}

function startServer(dir, javaPath, memory, type, onLog, onData) {
  if (serverProc) return { ok: false, error: '服务器已在运行' };

  // 探测服务端类型与启动 jar
  let srvType = type;
  const files = fs.readdirSync(dir);
  // Forge/NeoForge：有 run.bat 或 libraries 目录 + forge jar
  const isForgeLike = files.includes('run.bat') || files.includes('run.sh') ||
    files.some((f) => /^forge-.*\.jar$/i.test(f)) || files.some((f) => /^neoforge-.*\.jar$/i.test(f)) ||
    fs.existsSync(path.join(dir, 'libraries', 'net', 'minecraftforge')) || fs.existsSync(path.join(dir, 'libraries', 'net', 'neoforged'));
  if (!srvType) {
    if (isForgeLike) srvType = 'forge';
    else if (fs.existsSync(path.join(dir, 'config')) || fs.existsSync(path.join(dir, 'paper-global.yml'))) srvType = 'paper';
    else srvType = 'vanilla';
  }

  const java = javaPath || 'java';

  // Forge/NeoForge 优先用生成器提供的 run.bat / @argfile
  if (isForgeLike) {
    if (files.includes('run.bat')) {
      onLog && onLog('使用 Forge 生成的 run.bat 启动…');
      try {
        serverProc = spawn('cmd.exe', ['/c', 'run.bat', 'nogui'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) { serverProc = null; return { ok: false, error: '启动失败：' + e.message }; }
      hookProc(onData);
      return { ok: true, args: ['run.bat'] };
    }
  }

  const jar = path.join(dir, 'server.jar');
  if (!fs.existsSync(jar)) {
    // forge jar 名可能不同
    const fj = files.find((f) => /^forge-.*-server\.jar$/i.test(f)) || files.find((f) => /^forge-.*\.jar$/i.test(f) && !/installer/.test(f)) || files.find((f) => /^neoforge-.*\.jar$/i.test(f) && !/installer/.test(f));
    if (!fj) return { ok: false, error: '未找到服务端 jar，请先创建服务器' };
    const args = serverJvmArgs('paper', memory).concat(['-jar', fj, 'nogui']);
    onLog && onLog(`启动命令: ${java} ${args.join(' ')}`);
    try { serverProc = spawn(java, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch (e) { serverProc = null; return { ok: false, error: '启动失败：' + e.message }; }
    hookProc(onData);
    return { ok: true, args };
  }

  const args = serverJvmArgs(srvType, memory).concat(['-jar', 'server.jar', 'nogui']);
  onLog && onLog(`启动命令: ${java} ${args.join(' ')}`);

  try {
    serverProc = spawn(java, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (e) {
    serverProc = null;
    return { ok: false, error: '启动失败：' + e.message };
  }
  hookProc(onData);
  return { ok: true, args };
}

function hookProc(onData) {
  if (!serverProc) return;
  serverProc.stdout.on('data', (d) => onData(d.toString()));
  serverProc.stderr.on('data', (d) => onData(d.toString()));
  serverProc.on('error', (err) => {
    onData(`\n[启动失败] ${err.message}（请检查 Java 路径是否正确）\n`);
    serverProc = null;
  });
  serverProc.on('close', (code) => {
    onData(`\n[服务器已退出，退出码 ${code}]\n`);
    serverProc = null;
  });
}

function stopServer() {
  if (!serverProc) return { ok: false, error: '没有运行中的服务器' };
  try {
    serverProc.stdin.write('stop\n');
  } catch {
    serverProc.kill();
  }
  return { ok: true };
}

function sendCommand(cmd) {
  if (!serverProc) return { ok: false };
  try { serverProc.stdin.write(cmd + '\n'); return { ok: true }; } catch { return { ok: false }; }
}

function isRunning() {
  return !!serverProc;
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

module.exports = { createServer, startServer, stopServer, sendCommand, listServerVersions, isRunning, serverJvmArgs, serverInfo, getLanIP, getPublicIP, readServerPort, updateServerProperties, parseServerLine, setOnlineFromListLine, getOnlinePlayers, resetOnline, quickServerDefaults };
