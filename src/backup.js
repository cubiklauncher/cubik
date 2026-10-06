// backup.js - 存档（世界）管理、实例级备份/还原、截图管理
// 压缩统一走系统 tar（bsdtar 支持 .zip，通过 -a 按扩展名自动识别格式）。
// 国内 Windows 10+ 自带 tar，项目里 java.js 也在用它。
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function ensureDir(p) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }

function dirSize(p) {
  let total = 0;
  try {
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) walk(fp);
        else { try { total += fs.statSync(fp).size; } catch {} }
      }
    };
    walk(p);
  } catch {}
  return total;
}

function fmtSize(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + ' KB';
  return bytes + ' B';
}

// 用系统 tar 打包目录为 zip：tar -a -c -f out.zip -C <parent> <basename>
function zipDir(srcDir, outZip) {
  ensureDir(path.dirname(outZip));
  const parent = path.dirname(srcDir);
  const base = path.basename(srcDir);
  const r = spawnSync('tar', ['-a', '-c', '-f', outZip, '-C', parent, base], { windowsHide: true, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('压缩失败：' + (r.stderr || r.stdout || ('exit ' + r.status)).trim());
  if (!fs.existsSync(outZip)) throw new Error('压缩产物未生成');
  return outZip;
}

// 把多个目录打进同一个 zip（各自保留自身目录名）
// entries: [{ src, name }]；name 为 zip 内的目录名
function zipDirMulti(entries, outZip) {
  ensureDir(path.dirname(outZip));
  const args = ['-a', '-c', '-f', outZip];
  const seenDirs = new Set();
  for (const e of entries) {
    const parent = path.dirname(e.src);
    if (!seenDirs.has(parent)) { args.push('-C', parent); seenDirs.add(parent); }
    args.push(e.name);
  }
  const r = spawnSync('tar', args, { windowsHide: true, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('压缩失败：' + (r.stderr || r.stdout || ('exit ' + r.status)).trim());
  if (!fs.existsSync(outZip)) throw new Error('压缩产物未生成');
  return outZip;
}

// 解压 zip 到目标目录：tar -x -f x.zip -C dest
function unzipTo(zipFile, destDir) {
  ensureDir(destDir);
  const r = spawnSync('tar', ['-x', '-f', zipFile, '-C', destDir], { windowsHide: true, encoding: 'utf8' });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('解压失败：' + (r.stderr || r.stdout || ('exit ' + r.status)).trim());
  return destDir;
}

// ---------- 存档（世界）管理 ----------
function savesDir(mcDir) { return path.join(mcDir, 'saves'); }

function listWorlds(mcDir) {
  const dir = savesDir(mcDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const full = path.join(dir, d.name);
      let lastPlayed = 0, version = '', size = 0;
      try { lastPlayed = fs.statSync(full).mtimeMs; } catch {}
      const lvl = path.join(full, 'level.dat');
      const icon = path.join(full, 'icon.png');
      // 从 level.dat 读不出（NBT），改从可用信息推断；至少给出 mtime 与 icon 是否存在
      size = dirSize(full);
      return {
        name: d.name,
        lastPlayed,
        size,
        sizeText: fmtSize(size),
        hasIcon: fs.existsSync(icon),
        iconPath: fs.existsSync(icon) ? icon : '',
        // 备份数量（该世界有多少个备份）
        backups: countWorldBackups(mcDir, d.name)
      };
    })
    .sort((a, b) => b.lastPlayed - a.lastPlayed);
}

function backupsRoot(mcDir) { return path.join(mcDir, '.backups', 'worlds'); }

function countWorldBackups(mcDir, worldName) {
  const dir = backupsRoot(mcDir);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => f.startsWith(worldName + '__') && /\.zip$/i.test(f)).length;
}

function listWorldBackups(mcDir, worldName) {
  const dir = backupsRoot(mcDir);
  if (!fs.existsSync(dir)) return [];
  const prefix = worldName ? worldName + '__' : '';
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.zip') && f.startsWith(prefix))
    .map((f) => {
      const full = path.join(dir, f);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch {}
      const m = f.match(/^(.*)__(\d{13})\.zip$/);
      return { file: f, world: m ? m[1] : '', ts: m ? parseInt(m[2], 10) : 0, size, sizeText: fmtSize(size), mtime };
    })
    .sort((a, b) => b.ts - a.ts);
}

// 备份一个世界到 .backups/worlds/<name>__<ts>.zip
function backupWorld(mcDir, worldName, note) {
  const src = path.join(savesDir(mcDir), worldName);
  if (!fs.existsSync(src)) throw new Error('世界不存在：' + worldName);
  const ts = Date.now();
  const out = path.join(backupsRoot(mcDir), worldName + '__' + ts + '.zip');
  zipDir(src, out);
  if (note) { try { fs.writeFileSync(out + '.note.txt', note, 'utf8'); } catch {} }
  return { ok: true, file: out, size: fs.statSync(out).size };
}

// 从一个备份恢复世界（先把现有世界自动备份一份，再覆盖）
function restoreWorld(mcDir, backupFile) {
  const dir = backupsRoot(mcDir);
  const zip = path.join(dir, backupFile);
  if (!fs.existsSync(zip)) throw new Error('备份文件不存在');
  const m = backupFile.match(/^(.*)__(\d{13})\.zip$/);
  const worldName = m ? m[1] : backupFile.replace(/\.zip$/i, '');
  const target = path.join(savesDir(mcDir), worldName);
  // 现有世界先另存一份
  if (fs.existsSync(target)) {
    try { backupWorld(mcDir, worldName, '恢复前自动备份'); } catch {}
    fs.rmSync(target, { recursive: true, force: true });
  }
  // 解压到 saves/，zip 内顶层目录就是世界名
  unzipTo(zip, savesDir(mcDir));
  if (!fs.existsSync(target)) throw new Error('恢复后未找到世界目录，备份结构可能异常');
  return { ok: true, world: worldName };
}

function deleteWorld(mcDir, worldName) {
  const target = path.join(savesDir(mcDir), worldName);
  if (!fs.existsSync(target)) throw new Error('世界不存在');
  const trash = path.join(mcDir, '.trash', 'saves');
  ensureDir(trash);
  const dest = path.join(trash, worldName + '_' + Date.now());
  try { fs.renameSync(target, dest); }
  catch { fs.cpSync(target, dest, { recursive: true }); fs.rmSync(target, { recursive: true, force: true }); }
  return { ok: true, movedTo: dest };
}

function deleteWorldBackup(mcDir, backupFile) {
  const zip = path.join(backupsRoot(mcDir), backupFile);
  if (!fs.existsSync(zip)) throw new Error('备份不存在');
  fs.rmSync(zip, { force: true });
  try { fs.rmSync(zip + '.note.txt', { force: true }); } catch {}
  return { ok: true };
}

// ---------- 实例级备份/还原 ----------
function instancesRoot(mcDir) { return path.join(mcDir, '.backups', 'instances'); }

function listInstanceBackups(mcDir, instanceName) {
  const dir = instancesRoot(mcDir);
  if (!fs.existsSync(dir)) return [];
  const prefix = instanceName ? instanceName + '__' : '';
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.zip') && f.startsWith(prefix))
    .map((f) => {
      const full = path.join(dir, f);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch {}
      const m = f.match(/^(.*)__(\d{13})\.zip$/);
      return { file: f, instance: m ? m[1] : '', ts: m ? parseInt(m[2], 10) : 0, size, sizeText: fmtSize(size), mtime };
    })
    .sort((a, b) => b.ts - a.ts);
}

// 备份整个实例（versions/<name>）
function backupInstance(mcDir, instanceName) {
  const src = path.join(mcDir, 'versions', instanceName);
  if (!fs.existsSync(src)) throw new Error('实例不存在：' + instanceName);
  const ts = Date.now();
  const safe = instanceName.replace(/[\\/:*?"<>|]/g, '_');
  const out = path.join(instancesRoot(mcDir), safe + '__' + ts + '.zip');
  zipDir(src, out);
  return { ok: true, file: out, size: fs.statSync(out).size, sizeText: fmtSize(fs.statSync(out).size) };
}

function restoreInstance(mcDir, backupFile) {
  const zip = path.join(instancesRoot(mcDir), backupFile);
  if (!fs.existsSync(zip)) throw new Error('备份文件不存在');
  const m = backupFile.match(/^(.*)__(\d{13})\.zip$/);
  const instanceName = m ? m[1] : backupFile.replace(/\.zip$/i, '');
  const target = path.join(mcDir, 'versions', instanceName);
  if (fs.existsSync(target)) { try { backupInstance(mcDir, instanceName); } catch {} fs.rmSync(target, { recursive: true, force: true }); }
  unzipTo(zip, path.join(mcDir, 'versions'));
  if (!fs.existsSync(target)) throw new Error('恢复后未找到实例目录');
  return { ok: true, instance: instanceName };
}

function deleteInstanceBackup(mcDir, backupFile) {
  const zip = path.join(instancesRoot(mcDir), backupFile);
  if (!fs.existsSync(zip)) throw new Error('备份不存在');
  fs.rmSync(zip, { force: true });
  return { ok: true };
}

// ---------- 截图管理 ----------
function screenshotsDir(mcDir) { return path.join(mcDir, 'screenshots'); }

function listScreenshots(mcDir) {
  const dir = screenshotsDir(mcDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(png|jpe?g)$/i.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch {}
      return { file: f, path: full, size, sizeText: fmtSize(size), mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

// ---------- 官方启动器版本导入 ----------
// 从 %APPDATA%\.minecraft\versions 发现可导入的版本（排除已存在的）
function officialMcDir() {
  const appdata = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(appdata, '.minecraft');
}

function listImportableVersions(mcDir) {
  const src = path.join(officialMcDir(), 'versions');
  if (!fs.existsSync(src)) return { dir: officialMcDir(), list: [] };
  const existing = new Set();
  const dst = path.join(mcDir, 'versions');
  if (fs.existsSync(dst)) fs.readdirSync(dst).forEach((n) => existing.add(n));
  const list = fs.readdirSync(src, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(src, d.name, d.name + '.json')))
    .map((d) => {
      const full = path.join(src, d.name);
      let hasJar = fs.existsSync(path.join(full, d.name + '.jar'));
      // 支持资源库 + mods
      const sub = fs.readdirSync(full, { withFileTypes: true });
      return {
        name: d.name,
        hasJar,
        already: existing.has(d.name),
        size: dirSize(full),
        sizeText: fmtSize(dirSize(full)),
        extras: sub.filter((e) => e.isDirectory()).map((e) => e.name)
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { dir: officialMcDir(), list };
}

// 导入一个官方版本（复制版本目录 + 缺失的 libraries/assets 由启动时按需补齐）
function importVersion(mcDir, versionName, opts) {
  const src = path.join(officialMcDir(), 'versions', versionName);
  if (!fs.existsSync(src)) throw new Error('官方版本不存在：' + versionName);
  const dst = path.join(mcDir, 'versions', versionName);
  if (fs.existsSync(dst)) throw new Error('本地已存在同名版本：' + versionName);
  ensureDir(path.dirname(dst));
  fs.cpSync(src, dst, { recursive: true });
  return { ok: true, version: versionName };
}

// ---------- 服务器存档备份/还原 ----------
// 服务器存档位于 <serverDir>/world（由 server.properties 的 level-name 决定，默认 world）
function serverWorldName(serverDir) {
  try {
    const p = path.join(serverDir, 'server.properties');
    if (fs.existsSync(p)) {
      const txt = fs.readFileSync(p, 'utf8');
      const m = txt.match(/^level-name\s*=\s*(.+)$/m);
      if (m && m[1].trim()) return m[1].trim();
    }
  } catch {}
  return 'world';
}

function serverWorldDir(serverDir) {
  return path.join(serverDir, serverWorldName(serverDir));
}

// 服务器世界相关目录：主世界 world + 下界 world_nether + 末地 world_the_end
// （备份必须三者一起，否则恢复后维度不对应）
function serverWorldParts(serverDir) {
  const base = serverWorldName(serverDir);
  const names = [base, base + '_nether', base + '_the_end'];
  return names.filter((n) => fs.existsSync(path.join(serverDir, n)));
}

function serverBackupsRoot(serverDir) {
  return path.join(serverDir, '.backups', 'worlds');
}

// 服务器存档基本信息（大小、最后修改、备份数量）
function serverWorldInfo(serverDir) {
  const worldName = serverWorldName(serverDir);
  const parts = serverWorldParts(serverDir);
  const dir = path.join(serverDir, worldName);
  const exists = fs.existsSync(dir);
  let size = 0, mtime = 0;
  for (const n of (parts.length ? parts : [worldName])) {
    const p = path.join(serverDir, n);
    if (!fs.existsSync(p)) continue;
    size += dirSize(p);
    try { const m = fs.statSync(p).mtimeMs; if (m > mtime) mtime = m; } catch {}
  }
  return {
    worldName,
    parts,
    exists,
    size,
    sizeText: fmtSize(size),
    mtime,
    backups: countServerBackups(serverDir)
  };
}

function countServerBackups(serverDir) {
  const dir = serverBackupsRoot(serverDir);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => /__\d{13}\.zip$/i.test(f)).length;
}

function listServerBackups(serverDir) {
  const dir = serverBackupsRoot(serverDir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.zip'))
    .map((f) => {
      const full = path.join(dir, f);
      let size = 0, mtime = 0;
      try { const st = fs.statSync(full); size = st.size; mtime = st.mtimeMs; } catch {}
      const m = f.match(/^(.*)__(\d{13})\.zip$/);
      let note = '';
      try { note = fs.readFileSync(full + '.note.txt', 'utf8'); } catch {}
      return { file: f, world: m ? m[1] : '', ts: m ? parseInt(m[2], 10) : 0, size, sizeText: fmtSize(size), mtime, note };
    })
    .sort((a, b) => b.ts - a.ts);
}

// 备份服务器存档（主世界+下界+末地）到 <serverDir>/.backups/worlds/<world>__<ts>.zip
function backupServerWorld(serverDir, note) {
  const worldName = serverWorldName(serverDir);
  const parts = serverWorldParts(serverDir);
  if (!parts.length) throw new Error('服务器存档不存在：' + worldName);
  const ts = Date.now();
  const out = path.join(serverBackupsRoot(serverDir), worldName + '__' + ts + '.zip');
  zipDirMulti(parts.map((n) => ({ src: path.join(serverDir, n), name: n })), out);
  if (note) { try { fs.writeFileSync(out + '.note.txt', note, 'utf8'); } catch {} }
  const size = fs.statSync(out).size;
  return { ok: true, file: out, name: path.basename(out), size, sizeText: fmtSize(size), parts };
}

// 从备份恢复服务器存档（先自动备份当前存档，再覆盖；包含三个维度）
function restoreServerWorld(serverDir, backupFile) {
  const zip = path.join(serverBackupsRoot(serverDir), backupFile);
  if (!fs.existsSync(zip)) throw new Error('备份文件不存在');
  const m = backupFile.match(/^(.*)__(\d{13})\.zip$/);
  const worldName = m ? m[1] : serverWorldName(serverDir);
  const parts = [worldName, worldName + '_nether', worldName + '_the_end'];
  // 当前存档先自动备份
  try { backupServerWorld(serverDir, '恢复前自动备份'); } catch {}
  // 删掉当前三个维度目录
  for (const n of parts) {
    const p = path.join(serverDir, n);
    if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  unzipTo(zip, serverDir);
  if (!fs.existsSync(path.join(serverDir, worldName))) throw new Error('恢复后未找到存档目录');
  return { ok: true, worldName };
}

function deleteServerBackup(serverDir, backupFile) {
  const zip = path.join(serverBackupsRoot(serverDir), backupFile);
  if (!fs.existsSync(zip)) throw new Error('备份不存在');
  fs.rmSync(zip, { force: true });
  try { fs.rmSync(zip + '.note.txt', { force: true }); } catch {}
  return { ok: true };
}

module.exports = {
  fmtSize,
  dirSize,
  zipDir,
  zipDirMulti,
  unzipTo,
  serverWorldInfo,
  listServerBackups,
  backupServerWorld,
  restoreServerWorld,
  deleteServerBackup,
  serverWorldName,
  listWorlds,
  listWorldBackups,
  backupWorld,
  restoreWorld,
  deleteWorld,
  deleteWorldBackup,
  listInstanceBackups,
  backupInstance,
  restoreInstance,
  deleteInstanceBackup,
  listScreenshots,
  screenshotsDir,
  listImportableVersions,
  importVersion
};
