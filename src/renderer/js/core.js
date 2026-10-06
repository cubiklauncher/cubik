// 核心：全局状态 / 工具函数 / 页面切换 / 日志 / 全局进度 / init
let cfg = {};
let selectedVersion = '';
let localVersions = [];
let appInfo = {};

const $ = (id) => document.getElementById(id);

// ---------- 渲染层全局错误：写入日志而不要默默消失 ----------
window.onerror = (_m, _s, _l, _c, err) => {
  try { log('error', '界面错误：' + (err && err.stack ? err.stack : _m)); } catch {}
};
window.addEventListener('unhandledrejection', (e) => {
  try { log('error', '未处理错误：' + (e.reason && e.reason.message ? e.reason.message : e.reason)); } catch {}
});

// ---------- 内存滑块 ----------
function bindMemSlider(rangeId, hiddenId, labelId, hintId) {
  const range = $(rangeId);
  const hidden = $(hiddenId);
  const label = $(labelId);
  const sync = () => {
    const mb = parseInt(range.value, 10);
    hidden.value = String(mb);
    label.textContent = mb + ' MB';
    if (hintId) updateMemHint(mb);
  };
  range.oninput = sync;
  document.querySelectorAll('[data-mem]').forEach((b) => {
    if (b.dataset.boundFor === rangeId) return;
    b.dataset.boundFor = rangeId;
    b.onclick = () => { range.value = b.dataset.mem; sync(); };
  });
  sync();
  return { range, hidden, sync, set(v) { range.value = v; sync(); } };
}

function totalRamGB() {
  // 浏览器端无法直接拿内存，从 API 侧注入过则用，否则给个常见默认
  return window.__totalRamGB || 16;
}

function updateMemHint(current) {
  const hint = $('mem-hint');
  if (!hint) return;
  const total = totalRamGB();
  const recMB = howMuchMem(total);
  const recGB = (recMB / 1024).toFixed(1);
  const os = Math.max(0, total - recMB / 1024).toFixed(1);
  hint.textContent = `物理内存 ${total} GB，建议分配 ${recMB} MB（约 ${recGB} GB，给系统留 ~${os} GB）。当前 ${current} MB`;
}

// 按物理内存给出建议分配（给系统保留 3~4GB，不超过 12GB）
function howMuchMem(totalGB) {
  let rec;
  if (totalGB <= 4) rec = 2048;
  else if (totalGB <= 8) rec = 4096;
  else if (totalGB <= 16) rec = 8192;
  else rec = 12288;
  return Math.min(rec, Math.round(totalGB * 0.6 * 1024 / 512) * 512);
}

// ---------- 主页快捷操作 ----------
document.querySelectorAll('.qa-card').forEach((btn) => {
  btn.onclick = () => { const p = btn.dataset.go; if (p) goPage(p); };
});

// ---------- 页面切换 ----------
function navToPage(page) {
  const btn = document.querySelector('.nav-item[data-page="' + page + '"]');
  if (!btn) return;
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  const pageEl = $('page-' + page);
  if (pageEl) pageEl.classList.add('active');
  if (page === 'modpack' && !packLoaded) loadPackTop();
  if (page === 'shader' && !shaderLoaded) loadShaderTop();
  if (page === 'data') loadDataPage();
  if (page === 'mod' && !modPageLoaded) loadModPage();
  if (page === 'downloads' && typeof dlRender === 'function') dlRender();
  if (page === 'server') { refreshNetInfo(); try { loadServerVersions(); } catch {} try { renderServerOverview(); } catch {} try { refreshCreateDirDefault(); } catch {} try { loadSrvPackOptions(); } catch {} }
  if (page === 'srvmanage') { try { loadServerListIntoManage(); } catch {}
    refreshServerBackup(); loadAutoBackup(); checkServerUpdateUI(true); refreshNetInfo(); try { loadServerMods(); } catch {} try { refreshServerStatus(); } catch {} }
  if (page === 'vanilla' && !window.__vanLoaded) { window.__vanLoaded = true; loadVanillaVersions(); }
  if (page === 'versions') refreshVersions();
}

// 事件委托：支持动态新增的导航项（如「下载中心」）
document.addEventListener('click', (e) => {
  const item = e.target.closest && e.target.closest('.nav-item');
  if (item && item.dataset.page) navToPage(item.dataset.page);
});

// ---------- 日志 ----------
let logLines = 0;
function log(level, msg) {
  const box = $('log-box');
  if (!box) return;
  const line = `[${new Date().toLocaleTimeString()}] ${msg}\n`;
  box.textContent += line;
  box.scrollTop = box.scrollHeight;
  logLines++;
  const c = $('log-count');
  if (c) c.textContent = logLines + ' 条';
}

// ---------- 全局下载/安装进度（切页也能看到）----------
let gpState = { active: false, label: '', pct: 0, startedAt: 0, lastUpdate: 0, timer: null };
function showGlobalProgress() {
  const el = $('global-progress');
  if (el) el.style.display = '';
}
function updateGlobalProgress(p) {
  if (!p) return;
  const el = $('global-progress');
  if (!el) return;
  if (!gpState.active) { gpState.active = true; gpState.startedAt = Date.now(); }
  gpState.lastUpdate = Date.now();
  const label = p.label || '下载中';
  gpState.label = label;
  const done = p.done || 0, total = p.total || 0;
  const pct = p.pct != null ? p.pct : total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  gpState.pct = pct;
  el.style.display = '';
  el.classList.remove('gp-done');
  $('gp-label').textContent = label;
  $('gp-pct').textContent = total ? `${pct}%  (${done}/${total})` : pct + '%';
  $('gp-inner').style.width = pct + '%';
  // 看门狗：若 25s 无新进度，视为结束
  if (gpState.timer) clearTimeout(gpState.timer);
  gpState.timer = setTimeout(() => { if (Date.now() - gpState.lastUpdate > 24000) finishGlobalProgress({ label: gpState.label, ok: true }); }, 26000);
}
function finishGlobalProgress(d) {
  const el = $('global-progress');
  if (!el || !gpState.active) return;
  gpState.active = false;
  if (gpState.timer) { clearTimeout(gpState.timer); gpState.timer = null; }
  const ok = !d || d.ok !== false;
  $('gp-inner').style.width = '100%';
  el.classList.add('gp-done', ok ? 'gp-ok' : 'gp-err');
  $('gp-label').textContent = ok ? '✔ 完成：' + (d && d.label ? d.label : gpState.label) : '✖ 失败：' + (d && d.label ? d.label : gpState.label);
  $('gp-pct').textContent = ok ? '' : (d && d.error ? d.error : '出错');
  setTimeout(() => {
    el.style.display = 'none';
    el.classList.remove('gp-done', 'gp-ok', 'gp-err');
    $('gp-inner').style.width = '0%';
  }, ok ? 3500 : 8000);
  // 系统通知（应用在后台时也能看到；可在设置里关闭）
  if (!cfg || cfg.notifyOnDone !== false) {
    try {
      window.api.notify({
        title: ok ? '✔ Cubik 完成' : '✖ Cubik 任务失败',
        body: ok ? ((d && d.label ? d.label : gpState.label) + ' 已完成') : ((d && d.label ? d.label : gpState.label) + '：' + ((d && d.error) || '出错'))
      });
    } catch {}
  }
}
if ($('gp-close')) $('gp-close').onclick = () => {
  gpState.active = false;
  if (gpState.timer) { clearTimeout(gpState.timer); gpState.timer = null; }
  $('global-progress').style.display = 'none';
};
if ($('gp-jump')) $('gp-jump').onclick = () => {
  if (detailCtx) {
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    $('page-detail').classList.add('active');
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
  }
};

async function init() {
  const t0 = performance.now();
  // 下载中心：把入口注入侧边栏（DOM 就绪即可，不依赖 IPC）
  try { buildDownloadCenterUI(); } catch {}
  // 并行拉取配置和 app 信息（两块 IPC 不互相依赖）
  const [config, info, ram] = await Promise.all([
    window.api.getConfig().catch(() => ({})),
    window.api.appInfo().catch(() => ({})),
    window.api.getRam().catch(() => ({ total: 16 * 1024 * 1024 * 1024 }))
  ]);
  cfg = config || {};
  appInfo = info || {};
  // 性能模式：尽早应用，避免带着毛玻璃跑首屏（initAppearance 会再同步一次）
  if (cfg.perfMode) document.body.classList.add('perf-mode');
  if (appInfo.version) {
    $('about-ver').textContent = appInfo.version;
    $('home-app-ver').textContent = `${appInfo.name || 'Cubik'} v${appInfo.version}`;
  }
  if (appInfo.electron) $('about-electron').textContent = appInfo.electron;
  if (appInfo.node) $('about-node').textContent = appInfo.node;
  if (appInfo.email && $('about-email')) $('about-email').textContent = appInfo.email;
  $('in-mcdir').value = cfg.mcDir || '';
  $('in-java').value = cfg.javaPath || '';
  $('in-username').value = cfg.username || 'Steve';
  $('sel-source').value = normalizeSourceVal(cfg.downloadSource);
  try { refreshSourceDetail(); } catch {}
  $('in-autojava').checked = cfg.autoJava !== false;
  $('in-cfkey').value = cfg.cfApiKey || '';
  // 建服目录：给一个全新的建议目录（D:\mc-server、D:\mc-server2…避开已有服务器）
  // 不要默认成现有服务器的目录，否则容易误覆盖/建到同一处
  $('in-srv-dir').value = suggestNewServerDir(cfg);
  // 高级启动参数
  if ($('in-jvmargs')) $('in-jvmargs').value = cfg.jvmArgs || '';
  if ($('in-gameargs')) $('in-gameargs').value = cfg.gameArgs || '';
  // 外观（启动器皮肤）
  initAppearance(cfg);
  $('home-account').textContent = cfg.username || 'Steve';
  $('st-mcdir').textContent = cfg.mcDir;
  // 账号状态（微软正版）
  refreshAccountUI();

  // 内存滑块
  try {
    window.__totalRamGB = Math.round((ram.total / 1024 / 1024 / 1024) * 10) / 10;
  } catch { window.__totalRamGB = 16; }
  window.memSlider = bindMemSlider('in-mem-range', 'in-mem', 'mem-label', 'mem-hint');
  window.memSlider.range.max = Math.max(16384, Math.round(totalRamGB() * 1024 / 512) * 512);
  window.memSlider.set(Math.min(parseInt(cfg.maxMemory || 4096, 10), window.memSlider.range.max));
  window.srvMemSlider = bindMemSlider('in-srv-mem-range', 'in-srv-mem', 'srv-mem-label', null);
  window.srvMemSlider.range.max = Math.max(16384, Math.round(totalRamGB() * 1024 / 512) * 512);
  window.srvMemSlider.set(2048);

  selectedVersion = cfg.version || '';
  updateHomeVersion();
  console.log('[启动耗时] 基础初始化: ' + Math.round(performance.now() - t0) + 'ms');

  // 先渲染版本列表（首屏最关键），Java 检测并行跑
  await Promise.all([refreshVersions(), detectJava()]).catch(() => {});
  console.log('[启动耗时] 首屏完成: ' + Math.round(performance.now() - t0) + 'ms');
  // 拉取可用版本列表这类非关键网请求放到空闲时执行，不阻塞首屏
  const defer = (fn) => (window.requestIdleCallback ? window.requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 400));
  defer(() => { window.__vanLoaded = true; loadVanillaVersions(); });
  defer(() => loadServerVersions());

  window.api.onLog((d) => log(d.level, d.msg));
// 后台补全的中文常用名到达时，局部更新已渲染的卡片（按标题匹配）
if (window.api.onPackZhName) {
  window.api.onPackZhName((updates) => {
    if (!Array.isArray(updates) || !updates.length) return;
    const map = new Map(updates.map((u) => [String(u.title || '').trim(), u.zhName]));
    document.querySelectorAll('.pack-card').forEach((card) => {
      const titleEl = card.querySelector('.pk-title');
      if (!titleEl) return;
      if (titleEl.querySelector('.pk-zh')) return;
      // 只取标题的纯文本（不含后续可能追加的标签）
      const raw = (titleEl.firstChild && titleEl.firstChild.nodeType === 3
        ? titleEl.firstChild.textContent : titleEl.textContent) || '';
      const zh = map.get(raw.trim());
      if (zh) titleEl.insertAdjacentHTML('beforeend', `<span class="pk-zh">${esc(zh)}</span>`);
    });
  });
}
  // 全局绑定服务器聊天监听（不依赖是否切到服务器页，避免错过早期日志）
  try { ensureChatGlobals(); } catch {}
  window.api.onProgress((p) => {
    const wrap = $('progress-wrap');
    wrap.classList.add('show');
    if (p && typeof p === 'object') {
      const total = p.total || 0;
      const task = p.task || 0;
      const pct = total > 0 ? Math.min(100, Math.round((task / total) * 100)) : 0;
      $('progress-inner').style.width = pct + '%';
      // 速度 / 剩余时间估算（基于相邻两次进度）
      const now = Date.now();
      if (!window.__dlPrev || window.__dlPrev.total !== total) {
        window.__dlPrev = { t: now, task, total };
      } else {
        const dt = (now - window.__dlPrev.t) / 1000;
        const db = task - window.__dlPrev.task;
        if (dt > 0.5 && db >= 0) {
          const speed = db / dt; // bytes/s
          window.__dlSpeed = speed;
          window.__dlPrev = { t: now, task, total };
        }
      }
      const speedTxt = window.__dlSpeed ? ' · ' + fmtBytes(window.__dlSpeed) + '/s' : '';
      let etaTxt = '';
      if (window.__dlSpeed && total > task) {
        const eta = (total - task) / window.__dlSpeed;
        etaTxt = ' · 剩余 ' + fmtEta(eta);
      }
      const sizeTxt = total > 0 ? ` (${fmtBytes(task)}/${fmtBytes(total)})` : '';
      $('progress-text').textContent = `${p.type || '下载中'} ${pct}%${sizeTxt}${speedTxt}${etaTxt}`;
    }
  });
  window.api.onServerLog((d) => {
    const box = $('srv-log');
    if (box) { box.textContent += d; box.scrollTop = box.scrollHeight; }
    // 同时写入「创建日志」（服务器页），方便建服时也能看到下载/写入详情
    const cbox = $('srv-create-log');
    if (cbox) { cbox.textContent += d; cbox.scrollTop = cbox.scrollHeight; }
  });
  window.api.onInstallLog((d) => {
    log('data', d.trim());
    const m = d.trim();
    if (m.startsWith('▶')) addStep(m.slice(1).trim(), 'run');
  });
  window.api.onInstallProgress((p) => {
    if (p.pct != null) $('detail-progress').style.width = p.pct + '%';
    if (p.label) $('detail-progress-text').textContent = `${p.label} ${p.done ? '(' + p.done + '/' + p.total + ')' : ''}`;
    updateGlobalProgress(p);
    try { dlHookInstallProgress(p); } catch {}
  });
  // 安装/下载完成 → 顶部进度条闪一下“完成”后自动隐藏
  window.api.onInstallDone((d) => { finishGlobalProgress(d); try { dlHookInstallDone(d); } catch {} });window.api.onServerProgress((p) => {
    const pct = p.total > 0 ? Math.min(100, Math.round((p.task / p.total) * 100)) : 0;
    $('srv-progress').style.width = pct + '%';
  });
  window.api.onTunnelLog((d) => {
    const box = $('tun-log');
    if (!box) return;
    box.textContent += d;
    box.scrollTop = box.scrollHeight;
  });
  window.api.onUpdateProgress((p) => {
    const pct = p.total > 0 ? Math.min(100, Math.round((p.got / p.total) * 100)) : 0;
    const mb = (p.got / 1048576).toFixed(1), tot = (p.total / 1048576).toFixed(1);
    const line = `下载中 ${pct}%  (${mb}/${tot} MB)`;
    // 更新进度弹窗
    if ($('upd-modal') && $('upd-modal').style.display !== 'none') {
      if ($('upd-modal-prog')) $('upd-modal-prog').style.width = pct + '%';
      if ($('upd-modal-text')) $('upd-modal-text').textContent = line;
    }
    // 设置页内嵌进度条
    const wp = $('upd-prog-wrap');
    if (!wp || wp.style.display === 'none') return;
    if ($('upd-prog')) $('upd-prog').style.width = pct + '%';
    if ($('upd-prog-text')) $('upd-prog-text').textContent = line;
  });
  window.api.onAuthStatus((m) => { const s = $('ms-status'); if (s) s.textContent = m; });
  window.api.onClose((code) => {
    log('data', `游戏进程已退出，退出码 ${code}`);
    $('btn-launch').disabled = false;
    $('btn-launch').innerHTML = icon('play') + ' 启动游戏';
    $('progress-text').textContent = '游戏已退出';
    if (!cfg || cfg.notifyOnDone !== false) {
      try { window.api.notify({ title: 'Cubik', body: '游戏已退出' }); } catch {}
    }
  });

  // 主进程请求回收内存（游戏退出/闲置时）：清掉大对象引用并触发 GC，
  // 配合后台节流降低启动器常驻内存。
  if (window.api.onCollectGarbage) {
    window.api.onCollectGarbage(() => {
      try {
        window.__dlPrev = null;
        window.__dlSpeed = 0;
        if (typeof window.gc === 'function') window.gc();
      } catch {}
    });
  }
}

// ---------- 下载源（统一）----------
// 旧值（bmclapi/aliyun/mcbbs/mojang）归一为新模式
function normalizeSourceVal(v) {
  const k = String(v || 'domestic').toLowerCase();
  if (['bmclapi', 'aliyun', 'mcbbs', 'mirror', 'cn', 'domestic'].includes(k)) return 'domestic';
  if (['mojang', 'official', 'origin'].includes(k)) return 'official';
  if (k === 'auto') return 'auto';
  return 'domestic';
}
async function refreshSourceDetail() {
  const el = $('source-detail');
  if (!el) return;
  try {
    const r = await window.api.sourcesInfo({});
    if (!r || !r.ok) { el.textContent = ''; return; }
    const label = { game: icon('game') + ' 游戏本体', content: icon('puzzle') + ' Mod/整合包/光影', api: icon('search') + ' 搜索 API', java: icon('cup') + ' Java 运行时', server: icon('server') + ' 服务端' };
    el.innerHTML = Object.keys(label).map((c) => {
      const names = (r.detail[c] || []).join(' → ') || '—';
      return `<div>${label[c]}：${esc(names)}</div>`;
    }).join('');
  } catch { el.textContent = ''; }
}
if ($('sel-source')) {
  $('sel-source').onchange = () => {
    if (cfg) cfg.downloadSource = $('sel-source').value;
    try { window.api.setConfig(Object.assign({}, cfg, { downloadSource: $('sel-source').value })); } catch {}
    refreshSourceDetail();
    log('data', '下载源已切换为：' + $('sel-source').selectedOptions[0].textContent);
  };
}

function updateHomeVersion() {
  $('home-version').textContent = selectedVersion || '未选择';
}

// 记录版本最近使用时间（用于列表排序）
function markVersionUsed(name) {
  if (!name) return;
  if (!cfg) cfg = {};
  cfg.recentVersions = cfg.recentVersions || {};
  cfg.recentVersions[name] = Date.now();
  try { window.api.setConfig(cfg); } catch {}
}

// ---------- 主页版本快速切换 ----------
let homePickerOpen = false;
async function toggleHomePicker() {
  const pop = $('home-ver-pop');
  if (!pop) return;
  if (homePickerOpen) { pop.style.display = 'none'; homePickerOpen = false; return; }
  homePickerOpen = true;
  pop.style.display = 'block';
  pop.innerHTML = '<div class="hvp-empty">加载中…</div>';
  const list = await window.api.listVersions();
  if (!list.length) { pop.innerHTML = '<div class="hvp-empty">还没有本地版本，请先到「原版下载」安装一个。</div>'; return; }
  const recent = (cfg && cfg.recentVersions) || {};
  const sorted = [...list].sort((a, b) => (recent[b] || 0) - (recent[a] || 0));
  pop.innerHTML = '';
  sorted.forEach((v) => {
    const item = document.createElement('div');
    item.className = 'hvp-item' + (v === selectedVersion ? ' active' : '');
    item.innerHTML = `<span class="hvp-name">${esc(v)}</span>${recent[v] ? '<span class="hvp-recent">最近</span>' : ''}${v === selectedVersion ? '<span class="hvp-cur">✓</span>' : ''}`;
    item.onclick = async () => {
      selectedVersion = v;
      cfg.version = v;
      markVersionUsed(v);
      updateHomeVersion();
      homePickerOpen = false;
      pop.style.display = 'none';
      await window.api.setConfig(cfg);
    };
    pop.appendChild(item);
  });
  const more = document.createElement('div');
  more.className = 'hvp-more';
  more.innerHTML = icon('settings') + ' 管理全部版本…';
  more.onclick = () => { homePickerOpen = false; pop.style.display = 'none'; goPage('versions'); };
  pop.appendChild(more);
}
// 点击其他地方关闭主页选择器
document.addEventListener('click', (e) => {
  const pop = $('home-ver-pop');
  const trig = $('home-version');
  if (homePickerOpen && pop && !pop.contains(e.target) && e.target !== trig && !(trig && trig.contains(e.target))) {
    pop.style.display = 'none';
    homePickerOpen = false;
  }
});

// 统一页面跳转（供主页选择器等调用）
function goPage(page) {
  const nav = document.querySelector('.nav-item[data-page="' + page + '"]');
  if (nav) nav.click();
}

