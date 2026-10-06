// sources.js - 统一下载源配置
// 把「游戏本体 / 资源 / Mod / 整合包 / Java / 服务端」的下载源集中在一处管理，
// 每类源定义一个"首选 + 回退链"，供各模块统一读取，避免散落各处。
//
// 配置入口：settings 里选一个「总源」（国内/官方），各分类按它挑首选，失败自动回退。

'use strict';

// ---------- 源类型 ----------
// domestic: 国内加速（默认，适合大陆网络）
// official: 官方源（适合海外 / 镜像挂了）
// auto: 自动（竞速/回退，谁快用谁）

// ---------- 各下载分类的候选源（按优先级排序） ----------
// 说明：fallback 链最后一个通常是官方源，保证可用性。
const SOURCE_MAP = {
  // 游戏本体版本清单 + 客户端 jar + libraries + assets
  game: {
    domestic: ['bmclapi', 'official'],
    official: ['official', 'bmclapi'],
    auto: ['bmclapi', 'official'],
  },
  // Mod / 整合包 / 光影 文件 CDN
  content: {
    domestic: ['modrinth', 'curseforge'],
    official: ['modrinth', 'curseforge'],
    auto: ['modrinth', 'curseforge'],
  },
  // Mod / 整合包 搜索 & 元数据 API
  api: {
    domestic: ['modrinth-api', 'curseforge-api'],
    official: ['modrinth-api', 'curseforge-api'],
    auto: ['modrinth-api', 'curseforge-api'],
  },
  // Java 运行时（Adoptium）
  java: {
    domestic: ['tuna-adoptium', 'adoptium'],
    official: ['adoptium', 'tuna-adoptium'],
    auto: ['tuna-adoptium', 'adoptium'],
  },
  // 服务端（原版/Paper/Fabric/Forge/NeoForge）
  server: {
    domestic: ['bmclapi', 'official', 'maven-forge', 'maven-neoforge'],
    official: ['official', 'bmclapi', 'maven-forge', 'maven-neoforge'],
    auto: ['bmclapi', 'official', 'maven-forge', 'maven-neoforge'],
  },
};

// ---------- 具体源地址 ----------
const SOURCES = {
  // —— 游戏本体 ——
  bmclapi: {
    name: 'BMCLAPI（国内镜像）', type: 'mirror', kind: 'game',
    root: 'https://bmclapi2.bangbang93.com',
    manifest: 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json',
  },
  official: {
    name: 'Mojang 官方', type: 'official', kind: 'game',
    root: '',
    manifest: 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json',
  },

  // —— 内容 CDN（Mod/整合包/光影）——
  modrinth: {
    name: 'Modrinth', type: 'cdn', kind: 'content',
    cdn: ['https://cdn.modrinth.com'],
    api: 'https://api.modrinth.com/v2',
  },
  curseforge: {
    name: 'CurseForge', type: 'cdn', kind: 'content',
    cdn: ['https://edge.forgecdn.net', 'https://mediafilez.forgecdn.net'],
    api: 'https://api.curseforge.com/v1',
  },

  // —— Java ——
  adoptium: {
    name: 'Adoptium 官方', type: 'official', kind: 'java',
    api: 'https://api.adoptium.net/v3/assets/latest',
    release: 'https://github.com/adoptium/temurin{ver}-binaries/releases/download',
  },
  'tuna-adoptium': {
    name: '清华 Adoptium 镜像', type: 'mirror', kind: 'java',
    mirrorRoot: 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium',
  },

  // —— 服务端 ——
  'maven-forge': {
    name: 'Forge Maven', type: 'official', kind: 'server',
    root: 'https://maven.minecraftforge.net',
  },
  'maven-neoforge': {
    name: 'NeoForge Maven', type: 'official', kind: 'server',
    root: 'https://maven.neoforged.net',
  },
};

// api 类源（modrinth-api / curseforge-api）在 SOURCES 里直接复用内容源
const API_ALIAS = { 'modrinth-api': 'modrinth', 'curseforge-api': 'curseforge' };

function resolveKey(key) {
  return API_ALIAS[key] || key;
}

// 当前总源模式（domestic/official/auto）
let currentMode = process.env.CUBIK_MODE || 'domestic';

function setMode(mode) {
  const m = String(mode || '').toLowerCase();
  if (['domestic', 'official', 'auto'].includes(m)) currentMode = m;
  else if (m === 'bmclapi' || m === 'mirror') currentMode = 'domestic';
  else if (m === 'mojang' || m === 'origin') currentMode = 'official';
  process.env.CUBIK_MODE = currentMode;
  return currentMode;
}
function getMode() { return currentMode; }

// 取某分类的候选源 key 列表（已按当前模式排序）
function candidateKeys(category) {
  const map = SOURCE_MAP[category];
  if (!map) return [];
  return (map[currentMode] || map.auto || []).slice();
}

// 取某分类的首选源对象
function preferred(category) {
  const keys = candidateKeys(category);
  return keys.length ? SOURCES[resolveKey(keys[0])] : null;
}

// 取某分类的首选源 key
function preferredKey(category) {
  const keys = candidateKeys(category);
  return keys.length ? resolveKey(keys[0]) : '';
}

// 取某分类候选源的完整对象列表（跳过解析不到的）
function candidates(category) {
  return candidateKeys(category).map((k) => SOURCES[resolveKey(k)]).filter(Boolean);
}

// 兼容：老的 BMCLAPI_ROOT 环境变量（modpack.js 的 remap 依赖它）
function applyEnv() {
  const gameKey = preferredKey('game');
  const S = SOURCES[gameKey];
  if (S && S.root) {
    process.env.BMCLAPI_ROOT = S.root;
    if (S.manifest) process.env.BMCLAPI_VERSION_MANIFEST = S.manifest;
  } else {
    delete process.env.BMCLAPI_ROOT;
    delete process.env.BMCLAPI_VERSION_MANIFEST;
  }
  process.env.CUBIK_SOURCE = gameKey;
}

// 给 UI 用：列出可切换的总源
function listModes() {
  return [
    { key: 'domestic', name: '国内加速（推荐）', desc: 'BMCLAPI 镜像 + 国内可达的 CDN，大陆网络最快' },
    { key: 'official', name: '官方源', desc: '全部走 Mojang/官方 CDN，适合海外或镜像不可用时' },
    { key: 'auto', name: '自动', desc: '同国内加速，但多源竞速/回退更积极' },
  ];
}

module.exports = {
  SOURCES, SOURCE_MAP, resolveKey, API_ALIAS,
  setMode, getMode, candidateKeys, preferred, preferredKey, candidates,
  applyEnv, listModes,
};
