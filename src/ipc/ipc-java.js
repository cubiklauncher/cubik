// 自动拆分自 main.js —— javaBlock
const { ipcMain, dialog, shell } = require('electron');

module.exports = function register(ctx) {
  const { loadConfig, path, fs, requiredJava } = ctx;
  const __win = () => ctx.getWin();

// ---------- 检测 Java ----------
// 优先：配置指定 -> JAVA_HOME -> .minecraft/runtime -> PATH 常见位置
ipcMain.handle('java:detect', () => {
  const cfg = loadConfig();
  const found = [];
  if (cfg.javaPath && fs.existsSync(cfg.javaPath)) found.push(cfg.javaPath);

  if (process.env.JAVA_HOME) {
    const p = path.join(process.env.JAVA_HOME, 'bin', 'java.exe');
    if (fs.existsSync(p)) found.push(p);
  }

  // .minecraft/runtime 下的 mojang java
  const rt = path.join(cfg.mcDir, 'runtime');
  if (fs.existsSync(rt)) {
    for (const d of fs.readdirSync(rt)) {
      const candidates = [
        path.join(rt, d, 'bin', 'java.exe'),
        path.join(rt, d, 'windows-x64', d, 'bin', 'java.exe')
      ];
      for (const c of candidates) if (fs.existsSync(c)) found.push(c);
    }
  }

  // 常见安装路径
  const common = [
    'C:\\Program Files\\Java',
    'C:\\Program Files (x86)\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft\\jdk'
  ];
  for (const base of common) {
    if (!fs.existsSync(base)) continue;
    for (const d of fs.readdirSync(base)) {
      const p = path.join(base, d, 'bin', 'java.exe');
      if (fs.existsSync(p)) found.push(p);
    }
  }
  return [...new Set(found)];
});


};
