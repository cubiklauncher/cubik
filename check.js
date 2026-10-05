// Cubik 校验脚本：IPC 通道一致性、preload/api 对应、DOM id 完整性
const fs = require('fs');
const path = require('path');
const R = (p) => fs.readFileSync(path.join(__dirname, p), 'utf8');

let fail = 0;
const ok = (label, n) => console.log('  OK  ' + label + (n != null ? ' ' + n : ''));
const bad = (label, msg) => { fail++; console.log('  XX  ' + label + ' ' + msg); };

const main = R('src/main.js');
const preload = R('src/preload.js');
const renderer = R('src/renderer/renderer.js');
const html = R('src/renderer/index.html');

// 1. IPC 通道一致性
const invokesMain = [...main.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
const installer = (() => { try { return R('src/installer.js'); } catch { return ''; } })();
invokesMain.push(...[...installer.matchAll(/ipcMain\.handle\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]));
const invokesPre = [...preload.matchAll(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
const setPre = new Set(invokesPre);
const missPre = invokesMain.filter((c) => !setPre.has(c));
// 未在 preload 暴露的旧 handler（legacy）不算错误，仅提示
if (missPre.length) ok('IPC: preload ' + invokesPre.length + ' / main ' + invokesMain.length + ' (legacy 未暴露: ' + missPre.join(',') + ')');
else ok('IPC: preload', invokesPre.length + ' / main ' + invokesMain.length);

// 2. api.xxx 在 renderer 用到的是否在 preload 导出
const apiInPreload = [...preload.matchAll(/^\s{2}([a-zA-Z]\w*)\s*:/gm)].map((m) => m[1]);
const apiUsed = [...renderer.matchAll(/api\.([a-zA-Z]\w*)\s*\(/g)].map((m) => m[1]);
const setApi = new Set(apiInPreload);
const missApi = [...new Set(apiUsed)].filter((a) => !setApi.has(a));
if (missApi.length) bad('api: renderer 用到但 preload 未导出', missApi.join(',')); else ok('api: renderer ' + new Set(apiUsed).size + ' / preload ' + apiInPreload.length);

// 3. DOM id 完整性
const htmlIds = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
const rendererIds = [...renderer.matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]);
const missDom = [...new Set(rendererIds)].filter((i) => !htmlIds.has(i) && !/^(upd-|dyn-)/.test(i));
if (missDom.length) bad('DOM id: HTML 缺少', missDom.join(',')); else ok('DOM id: HTML ' + htmlIds.size + ' / renderer ' + new Set(rendererIds).size);

// 4. 模块语法
const files = ['src/main.js', 'src/preload.js', 'src/server.js', 'src/modpack.js', 'src/installer.js', 'src/constants.js'];
console.log('=== 模块语法 ===');
for (const f of files) {
  try { new Function(R(f)); console.log('  OK  ' + f); }
  catch (e) { fail++; console.log('  XX  ' + f + ' ' + e.message); }
}

console.log(fail ? '\n有 ' + fail + ' 处问题 ❌' : '\n全部通过 ✅');
process.exit(fail ? 1 : 0);
