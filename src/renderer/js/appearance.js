// 外观：自定义外观 / SKINS / ACCENTS / 性能模式
// ---------- 自定义外观（启动器皮肤） ----------
const SKINS = [
  { id: 'aurora', name: '极光', bg: 'linear-gradient(135deg,#eaf0ff,#f6ecff 45%,#e6fbf6)' },
  { id: 'ocean', name: '海洋', bg: 'linear-gradient(135deg,#dcefff,#cfe6ff)' },
  { id: 'sunset', name: '夕日', bg: 'linear-gradient(135deg,#fff0e8,#ffe0d6)' },
  { id: 'forest', name: '森林', bg: 'linear-gradient(135deg,#e8fff2,#d6f2ff)' },
  { id: 'grape', name: '葡萄', bg: 'linear-gradient(135deg,#f4ecff,#e6e0ff)' },
  { id: 'graphite', name: '石墨', bg: 'linear-gradient(135deg,#eceef3,#dfe3ec)' },
  { id: 'dark', name: '暗夜', bg: 'linear-gradient(135deg,#2a2f3a,#1d2230)' }
];
const ACCENTS = ['#2f6ae0', '#6a5cff', '#e0488a', '#2fae7a', '#e0803f', '#c0392b', '#3aa0c9', '#7a5cc0'];
let currentSkin = 'aurora';

function applyAppearance() {
  const accent = $('in-accent') ? $('in-accent').value : '#2f6ae0';
  document.documentElement.style.setProperty('--accent', accent);
  // 根据主色算一个浅一点的--accent-2
  document.documentElement.style.setProperty('--accent-2', lighten(accent, 0.28));
  const skin = currentSkin || 'aurora';
  document.body.dataset.skin = skin;
  // 暗夜主题：调文字色
  if (skin === 'dark') {
    document.body.style.setProperty('--text', '#e8ecf5');
    document.body.style.setProperty('--text-soft', '#b8c0d0');
    document.body.style.setProperty('--text-mute', '#8a93a5');
  } else {
    document.body.style.removeProperty('--text');
    document.body.style.removeProperty('--text-soft');
    document.body.style.removeProperty('--text-mute');
  }
  // 自定义背景图优先
  const bgImg = $('in-bg-image') ? $('in-bg-image').value.trim() : '';
  if (bgImg) {
    const url = 'file:///' + String(bgImg).replace(/\\/g, '/').replace(/^\/+/, '');
    document.body.style.backgroundImage = `url("${url}")`;
    document.body.setAttribute('data-bg-image', '1');
    document.body.style.backgroundSize = 'cover';
    document.body.style.backgroundPosition = 'center';
    document.body.style.backgroundRepeat = 'no-repeat';
  } else {
    document.body.removeAttribute('data-bg-image');
    document.body.style.backgroundImage = '';
  }
  // 更新选中态
  document.querySelectorAll('#skin-grid .skin-item').forEach((el) => el.classList.toggle('active', el.dataset.skin === skin && !bgImg));
  document.querySelectorAll('#accent-swatches .swatch').forEach((el) => el.classList.toggle('active', el.dataset.color.toLowerCase() === accent.toLowerCase()));
}

function lighten(hex, amt) {
  try {
    const c = hex.replace('#', '');
    let r = parseInt(c.substr(0, 2), 16), g = parseInt(c.substr(2, 2), 16), b = parseInt(c.substr(4, 2), 16);
    r = Math.round(r + (255 - r) * amt); g = Math.round(g + (255 - g) * amt); b = Math.round(b + (255 - b) * amt);
    return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  } catch { return hex; }
}

function buildAppearanceUI() {
  const grid = $('skin-grid');
  if (grid && !grid.dataset.built) {
    grid.dataset.built = '1';
    SKINS.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'skin-item';
      el.dataset.skin = s.id;
      el.style.background = s.bg;
      el.innerHTML = `<span>${s.name}</span>`;
      el.onclick = () => { currentSkin = s.id; if ($('in-bg-image')) $('in-bg-image').value = ''; applyAppearance(); };
      grid.appendChild(el);
    });
  }
  const sw = $('accent-swatches');
  if (sw && !sw.dataset.built) {
    sw.dataset.built = '1';
    ACCENTS.forEach((c) => {
      const el = document.createElement('div');
      el.className = 'swatch';
      el.dataset.color = c;
      el.style.background = c;
      el.onclick = () => { $('in-accent').value = c; applyAppearance(); };
      sw.appendChild(el);
    });
  }
}

function initAppearance(cfg) {
  buildAppearanceUI();
  currentSkin = cfg.skin || 'aurora';
  if ($('in-accent')) $('in-accent').value = cfg.accentColor || '#2f6ae0';
  if ($('in-bg-image')) $('in-bg-image').value = cfg.bgImage || '';
  if ($('in-perf-mode')) $('in-perf-mode').checked = !!cfg.perfMode;
  if ($('in-min-on-launch')) $('in-min-on-launch').checked = cfg.minimizeOnLaunch !== false;
  if ($('in-notify-done')) $('in-notify-done').checked = cfg.notifyOnDone !== false;
  if ($('in-telemetry')) $('in-telemetry').checked = cfg.telemetry !== false;
  applyAppearance();
}

// 性能模式：切换 body.perf-mode，关闭毛玻璃/动画等重特效
function applyPerfMode(on) {
  document.body.classList.toggle('perf-mode', !!on);
}

if ($('in-accent')) $('in-accent').oninput = applyAppearance;
if ($('in-perf-mode')) $('in-perf-mode').onchange = () => applyPerfMode($('in-perf-mode').checked);
if ($('btn-pick-bg')) $('btn-pick-bg').onclick = async () => {
  const p = await window.api.pickFile({ filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }] });
  if (p) { $('in-bg-image').value = p; applyAppearance(); }
};
if ($('btn-clear-bg')) $('btn-clear-bg').onclick = () => { $('in-bg-image').value = ''; applyAppearance(); };
if ($('btn-reset-skin')) $('btn-reset-skin').onclick = () => {
  currentSkin = 'aurora';
  if ($('in-accent')) $('in-accent').value = '#2f6ae0';
  if ($('in-bg-image')) $('in-bg-image').value = '';
  applyAppearance();
  alert('已恢复默认外观（记得点“保存设置”）');
};

// JVM 参数预设
if ($('in-jvmargs')) {
  document.querySelectorAll('.jvm-preset').forEach((b) => {
    b.onclick = () => {
      const cur = $('in-jvmargs').value.trim();
      $('in-jvmargs').value = cur ? cur + ' ' + b.dataset.jvm : b.dataset.jvm;
    };
  });
}
if ($('btn-clear-jvm')) $('btn-clear-jvm').onclick = () => { $('in-jvmargs').value = ''; };

$('btn-save').onclick = async () => {
  cfg.mcDir = $('in-mcdir').value.trim();
  cfg.javaPath = $('in-java').value.trim();
  cfg.maxMemory = $('in-mem').value.trim();
  cfg.username = $('in-username').value.trim() || 'Steve';
  cfg.downloadSource = $('sel-source').value;
  cfg.autoJava = $('in-autojava').checked;
  cfg.cfApiKey = $('in-cfkey').value.trim();
  cfg.serverDir = $('in-srv-dir').value.trim();
  if ($('in-jvmargs')) cfg.jvmArgs = $('in-jvmargs').value.trim();
  if ($('in-gameargs')) cfg.gameArgs = $('in-gameargs').value.trim();
  // 外观
  cfg.accentColor = $('in-accent').value;
  cfg.skin = currentSkin;
  cfg.bgImage = $('in-bg-image').value.trim();
  cfg.perfMode = $('in-perf-mode') ? $('in-perf-mode').checked : false;
  cfg.minimizeOnLaunch = $('in-min-on-launch') ? $('in-min-on-launch').checked : true;
  cfg.notifyOnDone = $('in-notify-done') ? $('in-notify-done').checked : true;
  cfg.telemetry = $('in-telemetry') ? $('in-telemetry').checked : true;
  applyPerfMode(cfg.perfMode);
  await window.api.setConfig(cfg);
  $('st-mcdir').textContent = cfg.mcDir;
  $('home-account').textContent = cfg.username;
  await refreshVersions();
  await detectJava();
  alert('设置已保存');
};

