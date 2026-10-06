// java.js - Java 运行时自动下载（Adoptium Temurin）
const fs = require('fs');
const path = require('path');
const https = require('https');

// 临时目录默认也放 D 盘，避免占 C 盘
const TMP_DIR = 'D:\\CubikLauncher\\tmp';

// 从任意字符串（版本号或实例名，如 "Fabulously Optimized 1.20.1"）中提取 MC 版本号
function extractMcVersion(s) {
  if (!s) return '';
  const str = String(s);
  // 优先匹配完整的 1.x[.y] 形态（避免只拿到结尾的 "1"）
  let m = str.match(/1\.(\d{1,2})(?:\.(\d{1,2}))?/);
  if (m) return m[2] ? `1.${m[1]}.${m[2]}` : `1.${m[1]}`;
  // 新命名（如 25w14a / 26.3）
  m = str.match(/(\d{2})\.(\d{1,2})/);
  if (m) return `${m[1]}.${m[2]}`;
  return str;
}

// MC 版本 -> 需要的 Java 大版本
function requiredJava(mcVersion) {
  if (!mcVersion) return 21;
  const s = extractMcVersion(mcVersion);
  let major, minor;
  if (/^1\./.test(s)) {
    [, major, minor] = s.split('.').map((n) => parseInt(n, 10));
  } else {
    // 新版本命名（25w14a -> 25.x，26.3 -> 26.x）
    const mm = s.match(/^(\d{2})(?:\.(\d{1,2}))?/);
    if (mm) { major = parseInt(mm[1], 10); minor = parseInt(mm[2] || '0', 10); }
    else major = NaN;
  }
  if (major === 0 || isNaN(major)) return 17; // 无法识别时给个安全值
  if (major >= 100) major = major % 100; // 例如 120 -> 20
  // 1.0 ~ 1.16.x -> 8
  if (major <= 16) return 8;
  if (major === 17) return 16;
  if (major === 18 || major === 19) return 17;
  if (major === 20) {
    // 1.20.5+ -> 21
    return minor >= 5 ? 21 : 17;
  }
  return 21; // 1.21+ 及更新版本
}

// 从 Adoptium API 取下载链接（含文件名）
function adoptiumUrl(javaVer, onLog) {
  return new Promise((resolve, reject) => {
    const api = `https://api.adoptium.net/v3/assets/latest/${javaVer}/hotspot?architecture=x64&image_type=jre&os=windows`;    onLog && onLog(`查询 Java ${javaVer} 下载地址…`);
    const req = https.get(api, { headers: { 'User-Agent': 'Cubik/1.0' } }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Adoptium API 返回 ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          const arr = JSON.parse(body);
          if (!arr.length) return reject(new Error('未找到可用 Java 包'));
          const bin = arr[0].binary;
          resolve({ url: bin.package.link, name: bin.package.name });
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(60000, () => req.destroy(new Error('查询 Java 下载地址超时')));
    req.on('error', reject);
  });
}

// 国内镜像：清华 Adoptium（避免 GitHub 被墙）
// 目录结构：https://mirrors.tuna.tsinghua.edu.cn/Adoptium/<大版本>/jre/x64/windows/<文件名>
function mirrorJavaUrl(javaVer, filename) {
  return `https://mirrors.tuna.tsinghua.edu.cn/Adoptium/${javaVer}/jre/x64/windows/${filename}`;
}

function headOk(url) {
  return new Promise((resolve) => {
    const req = https.request(url, { method: 'HEAD', headers: { 'User-Agent': 'Cubik/1.0' } }, (res) => {
      resolve(res.statusCode >= 200 && res.statusCode < 400);
      res.destroy();
    });
    req.setTimeout(20000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// 通用下载（带进度 + 超时 + 失败清理 + 完整性校验）
function download(url, dest, onProgress, onLog) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const req = https.get(url, { headers: { 'User-Agent': 'Cubik/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return download(res.headers.location, dest, onProgress, onLog).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error(`下载失败 HTTP ${res.statusCode}`));
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let got = 0;
      res.on('data', (d) => {
        got += d.length;
        onProgress && onProgress(got, total);
      });
      res.pipe(file);
      file.on('finish', () =>
        file.close(() => {
          // 校验：有 content-length 时检查大小是否完整
          if (total > 0 && got !== total) {
            try { fs.unlinkSync(dest); } catch {}
            return reject(new Error(`下载不完整（${got}/${total} 字节）`));
          }
          resolve(dest);
        })
      );
    });
    // 30 分钟无响应则中断（大文件需留足时间）
    req.setTimeout(30 * 60 * 1000, () => req.destroy(new Error('下载超时')));
    req.on('error', (e) => {
      try { fs.unlinkSync(dest); } catch {}
      reject(e);
    });
  });
}

// 确保 java 可用：返回 java.exe 路径
async function ensureJava(mcVersion, mcDir, onProgress, onLog) {
  const need = requiredJava(mcVersion);
  const runtimeDir = path.join(mcDir, 'runtime', `java-${need}`);
  const javaExe = path.join(runtimeDir, 'bin', 'java.exe');
  if (fs.existsSync(javaExe) && javaMajorVersion(javaExe) === need) {
    onLog && onLog(`已存在 Java ${need}: ${javaExe}`);
    return javaExe;
  }
  if (fs.existsSync(javaExe)) {
    onLog && onLog(`缓存目录 java-${need} 里的 Java 实际版本不符，重新下载…`);
    try { fs.rmSync(runtimeDir, { recursive: true, force: true }); } catch {}
  }

  onLog && onLog(`MC ${mcVersion} 需要 Java ${need}，开始自动下载…`);
  const { url, name } = await adoptiumUrl(need, onLog);
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const tmpZip = path.join(TMP_DIR, `temurin-jre-${need}.zip`);

  // 按统一下载源配置决定首选：国内加速时优先清华镜像，失败回退官方；官方模式反之
  let srcMod = null;
  try { srcMod = require('./sources'); } catch {}
  const javaKeys = srcMod ? srcMod.candidateKeys('java') : ['tuna-adoptium', 'adoptium'];
  const mirror = name ? mirrorJavaUrl(need, name) : null;
  const preferMirror = javaKeys[0] === 'tuna-adoptium';
  const attempts = [];
  if (preferMirror && mirror) attempts.push({ label: '清华 Adoptium 镜像', url: mirror });
  if (url) attempts.push({ label: 'Adoptium 官方', url });
  if (!preferMirror && mirror) attempts.push({ label: '清华 Adoptium 镜像', url: mirror });

  let lastErr = null;
  for (const a of attempts) {
    try {
      onLog && onLog(`使用 ${a.label} 下载 Java…`);
      await download(a.url, tmpZip, onProgress, onLog);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      onLog && onLog(`${a.label} 下载失败（${e.message}），尝试下一个源…`);
    }
  }
  if (lastErr) throw lastErr;

  onLog && onLog('解压 Java 运行时…');
  fs.mkdirSync(runtimeDir, { recursive: true });
  // 用系统 tar 解压（Windows10+ 自带 tar 支持 zip）
  const { execFileSync } = require('child_process');
  execFileSync('tar', ['-xf', tmpZip, '-C', runtimeDir], { stdio: 'ignore' });

  // Adoptium zip 解压后有一层目录 jdk-xx-jre，需要把它内容提上来
  const entries = fs.readdirSync(runtimeDir);
  const inner = entries.find((e) => fs.statSync(path.join(runtimeDir, e)).isDirectory());
  if (inner && !fs.existsSync(path.join(runtimeDir, 'bin'))) {
    const innerPath = path.join(runtimeDir, inner);
    for (const f of fs.readdirSync(innerPath)) {
      fs.renameSync(path.join(innerPath, f), path.join(runtimeDir, f));
    }
    fs.rmdirSync(innerPath);
  }
  try { fs.unlinkSync(tmpZip); } catch {}

  if (!fs.existsSync(javaExe)) {
    // 兼容目录名不完全匹配的情况
    const found = findJavaExe(runtimeDir);
    if (found) return found;
    throw new Error('Java 解压后未找到 java.exe');
  }
  onLog && onLog(`Java ${need} 安装完成`);
  return javaExe;
}

// 读取 java.exe 的大版本号（执行 java -version；注意 JDK 把版本写到 stderr），失败返回 0
function javaMajorVersion(javaExe) {
  try {
    const { spawnSync } = require('child_process');
    const r = spawnSync(javaExe, ['-version'], { encoding: 'utf8' });
    const text = (r.stdout || '') + (r.stderr || '');
    return parseJavaVersion(text);
  } catch {
    return 0;
  }
}

function parseJavaVersion(text) {
  const m = String(text).match(/version\s+"?(\d+)(?:\.(\d+))?/);
  if (!m) return 0;
  const first = parseInt(m[1], 10);
  if (first === 1) return parseInt(m[2] || '0', 10); // 1.8 -> 8
  return first; // 17 / 21
}

function findJavaExe(dir) {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const e of fs.readdirSync(cur)) {
      const p = path.join(cur, e);
      const st = fs.statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (e === 'java.exe') return p;
    }
  }
  return null;
}

module.exports = { ensureJava, requiredJava, download, javaMajorVersion };
