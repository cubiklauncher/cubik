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

// ---------- 页面切换 ----------
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
    $('page-' + btn.dataset.page).classList.add('active');
    if (btn.dataset.page === 'modpack' && !packLoaded) loadPackTop();
    if (btn.dataset.page === 'shader' && !shaderLoaded) loadShaderTop();
    if (btn.dataset.page === 'data') loadDataPage();
    if (btn.dataset.page === 'mod' && !modPageLoaded) loadModPage();
    if (btn.dataset.page === 'server') { refreshNetInfo(); refreshServerBackup(); loadAutoBackup(); checkServerUpdateUI(true); }
    if (btn.dataset.page === 'vanilla' && !window.__vanLoaded) { window.__vanLoaded = true; loadVanillaVersions(); }
    if (btn.dataset.page === 'versions') refreshVersions();
  };
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
  $('sel-source').value = cfg.downloadSource || 'bmclapi';
  $('in-autojava').checked = cfg.autoJava !== false;
  $('in-cfkey').value = cfg.cfApiKey || '';
  $('in-srv-dir').value = cfg.serverDir || (cfg.mcDir + '\\server');
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
    box.textContent += d;
    box.scrollTop = box.scrollHeight;
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
  });
  // 安装/下载完成 → 顶部进度条闪一下“完成”后自动隐藏
  window.api.onInstallDone((d) => finishGlobalProgress(d));window.api.onServerProgress((p) => {
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
    $('btn-launch').textContent = '▶ 启动游戏';
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
  more.textContent = '⚙ 管理全部版本…';
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

// ---------- 账号（微软正版多账号 + 离线）----------
let msLoggedIn = false;

async function refreshAccountUI() {
  let data = { accounts: [], active: 0 };
  try { data = await window.api.accounts(); } catch {}
  const accounts = (data && data.accounts) || [];
  const active = (data && data.active) || 0;
  const activeAcc = accounts[active] || null;
  msLoggedIn = !!activeAcc;
  const list = $('acct-list');
  const homeAvatar = $('home-avatar');
  const homeBadge = $('home-acct-badge');

  if (list) {
    list.innerHTML = '';
    if (!accounts.length) {
      list.innerHTML = '<div class="empty" style="padding:10px 0">还没有账号。你可以添加微软正版账号（可进所有正版服务器），或直接在下方用离线用户名。 </div>';
    } else {
      accounts.forEach((a) => {
        const item = document.createElement('div');
        item.className = 'acct-item' + (a.active ? ' active' : '');
        const av = a.avatar ? `<img src="${a.avatar}" onerror="this.style.display='none';this.parentNode.innerHTML='<span class=acct-avatar-fallback>'+(a.name[0]||'?').toUpperCase()+'</span>'">` : `<span class="acct-avatar-fallback">${esc((a.name[0] || '?').toUpperCase())}</span>`;
        const badge = a.owns ? '<span class="acct-badge ok">✔ 正版</span>' : '<span class="acct-badge warn">⚠ 无游戏</span>';
        item.innerHTML =
          `<div class="acct-avatar">${av}</div>` +
          `<div class="acct-info"><div class="acct-name">${esc(a.name)}${a.active ? ' <span class="acct-cur">当前</span>' : ''}</div>` +
          `<div class="acct-type">${a.uuid ? '微软账号' : '离线'}</div></div>` + badge +
          `<div class="acct-item-actions">` +
          (a.active ? '' : `<button class="btn mini acct-switch" data-idx="${a.index}">切换</button>`) +
          `<button class="btn mini ghost acct-del" data-idx="${a.index}">✕</button>` +
          `</div>`;
        list.appendChild(item);
      });
      list.querySelectorAll('.acct-switch').forEach((b) => {
        b.onclick = async () => {
          const r = await window.api.switchAccount({ index: Number(b.dataset.idx) });
          if (r.ok) { cfg.username = r.account.name; await refreshAccountUI(); }
        };
      });
      list.querySelectorAll('.acct-del').forEach((b) => {
        b.onclick = async () => {
          if (!confirm('确定删除该账号？')) return;
          await window.api.removeAccount({ index: Number(b.dataset.idx) });
          await refreshAccountUI();
        };
      });
    }
  }

  const logoutAll = $('btn-ms-logout-all');
  if (logoutAll) logoutAll.style.display = accounts.length > 1 ? '' : 'none';

  if (activeAcc) {
    if ($('home-account')) $('home-account').textContent = activeAcc.name;
    if ($('in-username')) $('in-username').value = activeAcc.name;
    if (homeAvatar && activeAcc.avatar) { homeAvatar.src = activeAcc.avatar; homeAvatar.style.display = ''; }
    if (homeBadge) { homeBadge.textContent = activeAcc.owns ? '✔' : '⚠'; homeBadge.className = 'home-acct-badge ' + (activeAcc.owns ? 'ok' : 'warn'); }
    if ($('offline-card')) $('offline-card').style.opacity = '.55';
  } else {
    const uname = (cfg && cfg.username) || 'Steve';
    if ($('home-account')) $('home-account').textContent = uname;
    if (homeAvatar) { homeAvatar.style.display = 'none'; }
    if (homeBadge) { homeBadge.textContent = ''; homeBadge.className = 'home-acct-badge'; }
    if ($('offline-card')) $('offline-card').style.opacity = '';
  }
  refreshSkinUI();
}

// ---------- 皮肤 / 披风管理 ----------
async function refreshSkinUI() {
  const body = $('skin-body');
  const hint = $('skin-hint');
  if (!body || !hint) return;
  const acc = $('acct-list') ? true : false;
  const r = await window.api.skinInfo({}).catch(() => ({ ok: false }));
  if (!r || !r.ok) {
    body.style.display = 'none';
    hint.style.display = '';
    hint.textContent = '登录微软正版账号后可在此更换皮肤/披风。' + (r && r.error ? '（' + r.error + '）' : '');
    return;
  }
  body.style.display = '';
  hint.style.display = 'none';
  $('skin-name-acc').textContent = r.name + '（' + String(r.uuid || '').slice(0, 8) + '…）';
  // 预览：用 crafatar 的 body 渲染（带皮肤）
  const prev = $('skin-preview');
  if (prev) { prev.src = `https://crafatar.com/renders/body/${String(r.uuid || '').replace(/-/g, '')}?size=192&overlay`; prev.onerror = () => { prev.style.opacity = '.25'; }; prev.style.opacity = ''; }
  // 披风列表
  const capes = $('skin-capes');
  capes.innerHTML = '';
  const activeCape = (r.capes || []).find((c) => c.state === 'ACTIVE');
  const mkBtn = (label, capeId, active) => {
    const b = document.createElement('button');
    b.className = 'cape-btn' + (active ? ' active' : '');
    b.textContent = label;
    b.onclick = async () => {
      const rr = await window.api.skinSetCape({ capeId });
      if (rr.ok) refreshSkinUI(); else alert('设置失败：' + rr.error);
    };
    return b;
  };
  capes.appendChild(mkBtn('无披风', '', !activeCape));
  (r.capes || []).forEach((c) => capes.appendChild(mkBtn(c.alias || '披风', c.id, c.state === 'ACTIVE')));
  if (!(r.capes || []).length) {
    const p = document.createElement('span');
    p.className = 'hint'; p.style.margin = '0';
    p.textContent = '该账号没有可用披风（需在官网活动获得）。';
    capes.appendChild(p);
  }
}

if ($('btn-skin-refresh')) $('btn-skin-refresh').onclick = () => refreshSkinUI();
if ($('btn-skin-upload')) $('btn-skin-upload').onclick = async () => {
  const btn = $('btn-skin-upload');
  btn.disabled = true; btn.textContent = '上传中…';
  const r = await window.api.skinUpload({ variant: ($('sel-skin-variant') || {}).value || 'classic' });
  btn.disabled = false; btn.textContent = '⬆ 上传新皮肤';
  if (r.ok) { log('data', '皮肤已更新'); refreshSkinUI(); }
  else if (!r.canceled) alert('上传失败：' + (r.error || '未知错误'));
};

let msPolling = false;
if ($('btn-ms-login')) $('btn-ms-login').onclick = async () => {
  const flow = $('ms-login-flow');
  const status = $('ms-status');
  if (flow) flow.style.display = 'block';
  if (status) status.textContent = '正在连接微软…';
  $('btn-ms-login').disabled = true;
  const r = await window.api.msStart();
  if (!r.ok) {
    if (status) status.textContent = '启动登录失败：' + r.error;
    $('btn-ms-login').disabled = false;
    return;
  }
  $('ms-user-code').textContent = r.userCode;
  $('ms-verify-url').textContent = r.verificationUri;
  const link = $('ms-verify-link');
  if (link) link.onclick = (e) => { e.preventDefault(); window.api.openPath(r.verificationUri); };
  status.textContent = '请在弹出的网页输入上面的设备码（已自动复制）…';
  try { await navigator.clipboard.writeText(r.userCode); } catch {}

  msPolling = true;
  const t0 = Date.now();
  while (msPolling && Date.now() - t0 < (r.expiresIn || 900) * 1000) {
    const pr = await window.api.msPoll();
    if (pr.ok) {
      msPolling = false;
      flow.style.display = 'none';
      $('btn-ms-login').disabled = false;
      await refreshAccountUI();
      alert('✔ 登录成功：' + pr.account.name);
      return;
    }
    if (pr.error && /过期|拒绝|启动/.test(pr.error)) {
      status.textContent = '登录失败：' + pr.error;
      $('btn-ms-login').disabled = false;
      msPolling = false;
      return;
    }
    await new Promise((res) => setTimeout(res, 2500));
  }
  if (msPolling) { status.textContent = '登录超时，请重试'; $('btn-ms-login').disabled = false; msPolling = false; }
};
if ($('btn-ms-cancel')) $('btn-ms-cancel').onclick = () => { msPolling = false; $('ms-login-flow').style.display = 'none'; $('btn-ms-login').disabled = false; };
if ($('btn-ms-logout-all')) $('btn-ms-logout-all').onclick = async () => {
  if (!confirm('确定退出全部账号？')) return;
  await window.api.msLogout({ all: true });
  await refreshAccountUI();
};

// ---------- 版本列表 ----------
// 版本图标（内联 SVG，按类型/加载器区分，无需下载）
function verIcon(name, type) {
  const n = String(name || '').toLowerCase();
  let inner, cls;
  if (/forge/.test(n) && !/neoforge/.test(n)) { cls = 'ico-forge'; inner = '<path d="M12 2l7 4v8l-7 4-7-4V6z" fill="#fff"/><path d="M12 5l4 2.3v4.6L12 14l-4-2.1V7.3z" fill="#c9a227"/>'; }
  else if (/neoforge/.test(n)) { cls = 'ico-neo'; inner = '<path d="M12 2l7 4v8l-7 4-7-4V6z" fill="#fff"/><path d="M12 5l4 2.3v4.6L12 14l-4-2.1V7.3z" fill="#e07b39"/>'; }
  else if (/fabric/.test(n)) { cls = 'ico-fabric'; inner = '<path d="M12 2l7 4v8l-7 4-7-4V6z" fill="#fff"/><path d="M12 5l4 2.3v4.6L12 14l-4-2.1V7.3z" fill="#c9a227"/>'; }
  else if (type === 'snapshot' || /snapshot|\d+w\d+/.test(n)) { cls = 'ico-snap'; inner = '<circle cx="12" cy="12" r="7" fill="#fff"/><circle cx="12" cy="12" r="3.2" fill="#7cc4ff"/>'; }
  else if (type === 'old' || /alpha|beta|^[abc]\d/.test(n)) { cls = 'ico-old'; inner = '<rect x="6" y="7" width="12" height="10" rx="1.5" fill="#fff"/><rect x="6" y="7" width="12" height="3" rx="1.5" fill="#8b5a2b"/>'; }
  else if (/fabulously|optimi|modpack/.test(n)) { cls = 'ico-pack'; inner = '<rect x="5" y="5" width="14" height="14" rx="2" fill="#fff"/>'; }
  else { cls = 'ico-van'; inner = '<rect x="5" y="9" width="14" height="9" rx="1.5" fill="#7a5230"/><rect x="5" y="6" width="14" height="4" rx="1" fill="#5bbf5c"/>'; }
  return '<span class="ver-ico ' + cls + '"><svg viewBox="0 0 24 24" width="22" height="22">' + inner + '</svg></span>';
}
function guessType() { return ''; }

async function refreshVersions() {
  localVersions = await window.api.listVersions();
  $('st-count').textContent = localVersions.length;
  const list = $('version-list');
  if (!localVersions.length) {
    list.innerHTML = '<li class="empty">暂无本地版本，请先在原版启动器下载，或到设置里指向已有 .minecraft 目录</li>';
    return;
  }
  // 最近使用排序：有使用记录的在前面（按时间倒序），其余保持原顺序
  const recent = (cfg && cfg.recentVersions) || {};
  localVersions.sort((a, b) => (recent[b] || 0) - (recent[a] || 0));
  list.innerHTML = '';
  const metas = await Promise.all(localVersions.map((v) => window.api.versionInfo({ name: v }).catch(() => ({ ok: false }))));
  localVersions.forEach((v, i) => {
    const meta = metas[i] && metas[i].ok ? metas[i].info : { loader: '原版', mcVersion: v, mods: 0, libraries: 0 };
    const li = document.createElement('li');
    if (v === selectedVersion) li.classList.add('selected');
    const loaderTag = meta.loader && meta.loader !== '原版' ? `<span class="tg loader">${meta.loader}</span>` : '';
    const isRecent = recent[v] && (Date.now() - recent[v] < 7 * 24 * 3600 * 1000);
    li.innerHTML = `<div class="ver-left">
        ${verIcon(v, guessType(v))}
        <div class="ver-main">
          <div class="ver-name">${esc(v)}${isRecent ? ' <span class="ver-recent-tag">最近</span>' : ''}</div>
          <div class="ver-tags">
            <span class="tg mc">MC ${esc(meta.mcVersion || v)}</span>
            ${loaderTag}
            <span class="tg">📚 ${meta.libraries} 支持库</span>
            ${meta.mods ? `<span class="tg">🧩 ${meta.mods} Mod</span>` : ''}
          </div>
        </div>
      </div>
      <div class="ver-right">
        <button class="btn ghost ver-manage-btn" title="管理模组与支持库">⚙ 管理</button>
        <button class="btn danger ver-del-btn" style="display:none" title="删除版本">🗑 删除</button>
      </div>`;
    li.querySelector('.ver-manage-btn').onclick = (e) => { e.stopPropagation(); openVersionDetail(v); };
    li.querySelector('.ver-del-btn').onclick = async (e) => {
      e.stopPropagation();
      // 二次确认：要求输入版本名，防止误删重要版本
      const input = prompt(`确定删除版本「${v}」吗？\n\n将移入回收站（.trash），可在文件管理器手动恢复。\n\n如确定，请输入该版本的名称：`);
      if (input === null) return;
      if (input.trim() !== v) { alert('名称不一致，已取消删除。'); return; }
      const r = await window.api.versionDelete({ name: v });
      if (r.ok) { log('data', `已删除版本：${v}（可在 .trash 恢复）`); if (selectedVersion === v) { selectedVersion = ''; cfg.version = ''; updateHomeVersion(); } await refreshVersions(); }
      else alert('删除失败：' + r.error);
    };
    li.onclick = () => {
      selectedVersion = v;
      cfg.version = v;
      markVersionUsed(v);
      updateHomeVersion();
      refreshVersions();
    };
    list.appendChild(li);
  });
  if (!selectedVersion && localVersions.length) {
    selectedVersion = localVersions[0];
    cfg.version = selectedVersion;
    updateHomeVersion();
    refreshVersions();
  }
}

// ---------- 版本选择 ----------
// ---------- 原版下载版本列表（自定义下拉，带图标） ----------
let vanillaVerList = [];

async function loadVanillaVersions(opts = {}) {
  const force = !!opts.force;
  const type = $('sel-van-type').value;
  $('vp-label').textContent = '加载中…';
  $('vp-ico').innerHTML = '';
  const t0 = performance.now();
  const r = await window.api.versionManifest({ type, force });
  if (!r.ok) { $('vp-label').textContent = '加载失败'; const h = $('van-cache-hint'); if (h) h.textContent = r.error || ''; return; }
  const ms = Math.round(performance.now() - t0);
  vanillaVerList = r.list;
  // 缓存提示
  const hint = $('van-cache-hint');
  if (hint) hint.textContent = `共 ${r.list.length} 个版本 · ${ms}ms${force ? '（已刷新）' : ''}`;
  // 默认选第一个
  if (r.list.length) selectVanillaVersion(r.list[0].id, type);
  else { $('vp-label').textContent = '无可用版本'; $('sel-van-ver').value = ''; }
  renderVanillaPicker('');
  renderVanillaCards('');
}

// 渲染“全部可用版本”卡片列表（点击直接选中/安装）
function renderVanillaCards(filter) {
  const wrap = $('van-card-list');
  if (!wrap) return;
  const q = String(filter || '').trim().toLowerCase();
  const type = $('sel-van-type').value;
  const list = vanillaVerList.filter((v) => !q || v.id.toLowerCase().includes(q));
  if (!list.length) { wrap.innerHTML = '<div class="empty">无匹配版本</div>'; return; }
  wrap.innerHTML = '';
  const frag = document.createDocumentFragment();
  list.slice(0, 300).forEach((v) => {
    const el = document.createElement('div');
    el.className = 'ver-card';
    const tagCls = v.type === 'release' ? '' : (v.type === 'snapshot' ? 'snapshot' : 'old');
    const tagTxt = v.type === 'release' ? '正式版' : (v.type === 'snapshot' ? '快照' : '远古');
    const date = v.time ? new Date(v.time).toLocaleDateString() : '';
    el.innerHTML = `${verIcon(v.id, type)}<div class="vc-id">${esc(v.id)}</div>` +
      `<div class="vc-meta">${date}</div>` +
      `<span class="vc-tag ${tagCls}">${tagTxt}</span>`;
    el.onclick = () => {
      selectVanillaVersion(v.id, type);
      $('vp-label').textContent = v.id;
      // 滚到表单（若在上方）提示已选中
      if ($('btn-van-install')) $('btn-van-install').focus();
    };
    frag.appendChild(el);
  });
  wrap.appendChild(frag);
}

function selectVanillaVersion(id, type) {
  $('sel-van-ver').value = id;
  $('vp-ico').innerHTML = verIcon(id, type || $('sel-van-type').value);
  $('vp-label').textContent = id;
  loadLoaderVersions();
  if ($('chk-optifine') && $('chk-optifine').checked) loadAddonVersions();
}

function renderVanillaPicker(filter) {
  const ul = $('ver-picker-list');
  const q = String(filter || '').trim().toLowerCase();
  const type = $('sel-van-type').value;
  const list = vanillaVerList.filter((v) => !q || v.id.toLowerCase().includes(q));
  ul.innerHTML = '';
  if (!list.length) { ul.innerHTML = '<li class="empty">无匹配版本</li>'; return; }
  list.slice(0, 200).forEach((v) => {
    const li = document.createElement('li');
    li.innerHTML = `${verIcon(v.id, type)}<span class="vpl-name">${esc(v.id)}</span>` + (v.type && v.type !== 'release' ? `<span class="vpl-type">${esc(v.type)}</span>` : '');
    li.onclick = () => { selectVanillaVersion(v.id, type); $('ver-picker-drop').style.display = 'none'; };
    ul.appendChild(li);
  });
}

if ($('ver-picker-btn')) {
  $('ver-picker-btn').onclick = (e) => {
    e.stopPropagation();
    const d = $('ver-picker-drop');
    d.style.display = d.style.display === 'none' ? 'block' : 'none';
    if (d.style.display === 'block') { $('ver-picker-search').value = ''; renderVanillaPicker(''); $('ver-picker-search').focus(); }
  };
  $('ver-picker-search').oninput = (e) => renderVanillaPicker(e.target.value);
  document.addEventListener('click', (e) => {
    const p = $('ver-picker');
    if (p && !p.contains(e.target)) $('ver-picker-drop').style.display = 'none';
  });
}

$('sel-van-type').onchange = () => loadVanillaVersions();
if ($('in-van-list-search')) $('in-van-list-search').oninput = (e) => renderVanillaCards(e.target.value);
if ($('btn-refresh-manifest')) $('btn-refresh-manifest').onclick = async () => {
  $('btn-refresh-manifest').disabled = true;
  try { await loadVanillaVersions({ force: true }); } finally { $('btn-refresh-manifest').disabled = false; }
};
$('sel-van-loader').onchange = loadLoaderVersions;

// 加载加载器版本列表（无加载器时禁用）
async function loadLoaderVersions() {
  const kind = $('sel-van-loader').value;
  const sel = $('sel-van-loaderver');
  if (kind === 'vanilla') {
    sel.disabled = true;
    sel.innerHTML = '<option>（无需选择）</option>';
    return;
  }
  const mcVersion = $('sel-van-ver').value;
  if (!mcVersion) {
    sel.innerHTML = '<option>请先选择游戏版本</option>';
    return;
  }
  sel.disabled = false;
  sel.innerHTML = '<option>加载中…</option>';
  const r = await window.api.loaderVersions({ kind, mcVersion });
  if (!r.ok) { sel.innerHTML = '<option>加载失败（该版本可能不支持）</option>'; return; }
  if (!r.list.length) { sel.innerHTML = '<option>该版本无可用加载器</option>'; return; }
  sel.innerHTML = '';
  r.list.forEach((v) => {
    const o = document.createElement('option');
    o.value = v.version;
    o.textContent = v.version + (v.stable ? ' ✓' : ' (测试版)');
    sel.appendChild(o);
  });
}

$('btn-van-install').onclick = async () => {
  const ver = $('sel-van-ver').value;
  if (!ver) return alert('请选择要下载的版本');
  const kind = $('sel-van-loader').value;
  const wantOptifine = $('chk-optifine').checked;
  const btn = $('btn-van-install');
  btn.disabled = true;
  btn.textContent = '安装中…';

  // 1) 装主版本（原版或带加载器）
  let instanceName;
  if (kind === 'vanilla') {
    log('data', `==== 开始下载原版 ${ver} ====`);
    const r = await window.api.installVanilla({ version: ver });
    if (!r.ok) {
      btn.disabled = false; btn.textContent = '⬇ 下载并安装';
      log('data', '下载失败：' + r.error);
      return alert('下载失败：' + r.error);
    }
    instanceName = ver;
    log('data', `原版 ${ver} 安装完成`);
  } else {
    const lv = $('sel-van-loaderver').value;
    if (!lv || lv.startsWith('加载') || lv.startsWith('该版本') || lv.startsWith('请先')) {
      btn.disabled = false; btn.textContent = '⬇ 下载并安装';
      return alert('请选择加载器版本');
    }
    instanceName = `${ver}-${kind}${lv}`;
    log('data', `==== 安装 ${kind} ${lv} (MC ${ver}) ====`);
    const r = await window.api.loaderInstall({ kind, mcVersion: ver, loaderVersion: lv, instanceName });
    if (!r.ok) {
      btn.disabled = false; btn.textContent = '⬇ 下载并安装';
      log('data', '安装失败：' + r.error);
      return alert('安装失败：' + r.error);
    }
    log('data', `${kind} ${lv} 安装完成`);
  }

  // 2) 勾选了 OptiFine，继续叠加到同一个版本
  if (wantOptifine) {
    const raw = $('sel-addon-ver').value;
    if (raw && !raw.startsWith('选择') && !raw.startsWith('加载') && !raw.startsWith('该版本')) {
      let addonVersion;
      try { addonVersion = JSON.parse(raw); } catch {}
      if (addonVersion) {
        log('data', `==== 叠加 OptiFine ${addonVersion.label || addonVersion.version} ====`);
        const r2 = await window.api.addonInstall({ kind: 'optifine', baseVersion: instanceName, addonVersion });
        if (r2.ok) log('data', `OptiFine 已一并装入 ${instanceName}`);
        else log('data', 'OptiFine 叠加失败：' + r2.error);
      }
    }
  }

  btn.disabled = false;
  btn.textContent = '⬇ 下载并安装';
  await refreshVersions();
  const msg = wantOptifine ? '游戏和 OptiFine 已装进同一个版本！' : '安装完成！';
  alert(msg);
};

// ---------- 组件勾选（OptiFine 等，一次下完） ----------
async function loadAddonVersions() {
  const kind = $('sel-van-loader').value;
  const checked = $('chk-optifine').checked;
  const sel = $('sel-addon-ver');
  const row = $('row-addon-ver');

  // 更新勾选框高亮
  document.querySelectorAll('.addon-check').forEach((c) => {
    c.classList.toggle('checked', c.querySelector('input').checked);
  });

  // 未勾选 OptiFine：隐藏版本选择行
  if (!checked) {
    row.style.display = 'none';
    return;
  }

  const mcVersion = $('sel-van-ver').value;
  if (!mcVersion) {
    row.style.display = 'none';
    return;
  }

  // OptiFine 需要 Forge/Fabric 基座；纯原版叠加体验不佳但仍允许
  row.style.display = 'flex';
  sel.innerHTML = '<option>加载中…</option>';
  const r = await window.api.addonVersions({ kind: 'optifine', mcVersion });
  if (!r.ok) { sel.innerHTML = '<option>加载失败</option>'; return; }
  if (!r.list.length) { sel.innerHTML = '<option>该版本无可用 OptiFine</option>'; return; }
  sel.innerHTML = '';
  r.list.forEach((v) => {
    const o = document.createElement('option');
    o.value = JSON.stringify(v);
    o.textContent = (v.label || v.version) + (v.forge ? ` (需 ${v.forge})` : '');
    sel.appendChild(o);
  });
}

if ($('chk-optifine')) {
  $('chk-optifine').onchange = loadAddonVersions;
}

// ---------- 版本详情：模组 / 支持库 ----------
let vdCurrent = '';
let vdTab = 'mods';

async function openVersionDetail(name) {
  vdCurrent = name;
  $('version-detail').style.display = 'block';
  $('vd-title').textContent = '版本详情：' + name;
  const info = await window.api.versionInfo({ name });
  if (info.ok) {
    const m = info.info;
    $('vd-meta').innerHTML =
      `<span class="tg mc">MC ${esc(m.mcVersion)}</span>` +
      `<span class="tg loader">${esc(m.loader)}</span>` +
      `<span class="tg">📚 ${m.libraries} 支持库</span>` +
      `<span class="tg">🧩 ${m.mods} Mod</span>`;
  }
  setVdTab(vdTab);
  $('version-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function setVdTab(tab) {
  vdTab = tab;
  document.querySelectorAll('.vd-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $('vd-panel-mods').style.display = tab === 'mods' ? 'block' : 'none';
  $('vd-panel-libs').style.display = tab === 'libs' ? 'block' : 'none';
  const sp = $('vd-panel-settings');
  if (sp) sp.style.display = tab === 'settings' ? 'block' : 'none';
  if (tab === 'mods') loadMods();
  else if (tab === 'libs') loadLibs();
  else if (tab === 'settings') loadInstanceSettings();
}

// 实例独立启动设置
async function loadInstanceSettings() {
  const r = await window.api.instanceSettingsGet({ name: vdCurrent });
  const s = (r && r.ok && r.settings) || {};
  $('in-inst-mem').value = s.maxMemory || '';
  $('in-inst-java').value = s.javaPath || '';
  $('in-inst-jvm').value = s.jvmArgs || '';
  $('in-inst-game').value = s.gameArgs || '';
}
if ($('btn-inst-save')) $('btn-inst-save').onclick = async () => {
  const mem = $('in-inst-mem').value.trim();
  const settings = {};
  if (mem) settings.maxMemory = Number(mem);
  if ($('in-inst-java').value.trim()) settings.javaPath = $('in-inst-java').value.trim();
  if ($('in-inst-jvm').value.trim()) settings.jvmArgs = $('in-inst-jvm').value.trim();
  if ($('in-inst-game').value.trim()) settings.gameArgs = $('in-inst-game').value.trim();
  const r = await window.api.instanceSettingsSet({ name: vdCurrent, settings });
  if (r && r.ok) { alert('已保存该实例的启动设置' + (Object.keys(settings).length ? '' : '（已清空，将使用全局设置）')); }
  else alert('保存失败：' + ((r && r.error) || '未知错误'));
};
if ($('btn-inst-mem-clear')) $('btn-inst-mem-clear').onclick = () => { $('in-inst-mem').value = ''; };
if ($('btn-inst-java-pick')) $('btn-inst-java-pick').onclick = async () => {
  const p = await window.api.pickJava();
  if (p) $('in-inst-java').value = p;
};

document.querySelectorAll('.vd-tab').forEach((b) => { b.onclick = () => setVdTab(b.dataset.tab); });

$('btn-vd-close').onclick = () => { $('version-detail').style.display = 'none'; };

async function loadMods() {
  const ul = $('mod-list');
  ul.innerHTML = '<li class="empty">加载中…</li>';
  const r = await window.api.modsList({ version: vdCurrent });
  if (!r.ok) { ul.innerHTML = `<li class="empty">加载失败：${r.error}</li>`; return; }
  $('mod-count').textContent = r.list.length + ' 个模组';
  if (!r.list.length) { ul.innerHTML = '<li class="empty">暂无模组，点上方“导入 Mod”添加</li>'; return; }
  ul.innerHTML = '';
  r.list.forEach((mod) => {
    const li = document.createElement('li');
    li.className = mod.disabled ? 'mod-item disabled' : 'mod-item';
    li.innerHTML = `<div class="mod-info">
        <span class="mod-name">${esc(mod.name)}</span>
        <span class="mod-size">${mod.sizeKB > 1024 ? (mod.sizeKB/1024).toFixed(1)+' MB' : mod.sizeKB+' KB'}</span>
      </div>
      <div class="mod-actions">
        <label class="switch"><input type="checkbox" ${mod.disabled ? '' : 'checked'}><span></span></label>
        <button class="btn ghost mod-del">🗑</button>
      </div>`;
    li.querySelector('input').onchange = async (e) => {
      // 勾选=启用，取消=禁用
      const wantDisabled = !e.target.checked;
      await window.api.modsToggle({ version: vdCurrent, file: mod.file, disabled: wantDisabled });
      loadMods();
    };
    li.querySelector('.mod-del').onclick = async () => {
      if (!confirm(`删除模组「${mod.name}」？`)) return;
      await window.api.modsDelete({ version: vdCurrent, file: mod.file });
      loadMods();
    };
    ul.appendChild(li);
  });
}

async function loadLibs() {
  const ul = $('lib-list');
  ul.innerHTML = '<li class="empty">加载中…</li>';
  const r = await window.api.versionLibraries({ name: vdCurrent });
  if (!r.ok) { ul.innerHTML = `<li class="empty">加载失败：${r.error}</li>`; return; }
  if (!r.list.length) { ul.innerHTML = '<li class="empty">该版本无支持库记录</li>'; return; }
  ul.innerHTML = '';
  r.list.forEach((l) => {
    const li = document.createElement('li');
    li.className = 'lib-item';
    const parts = l.name.split(':');
    li.innerHTML = `<span class="lib-name">${esc(parts[1] || l.name)}</span><span class="lib-ver">${esc(parts[2] || '')}</span><span class="lib-ok ${l.present ? 'ok' : 'miss'}">${l.present ? '✓' : '缺'}</span>`;
    ul.appendChild(li);
  });
}

if ($('btn-mod-add')) $('btn-mod-add').onclick = async () => {
  const r = await window.api.modsAdd({ version: vdCurrent });
  if (r.ok && r.added) { log('data', `已导入 ${r.added} 个模组`); loadMods(); }
};
if ($('btn-mod-open')) $('btn-mod-open').onclick = () => window.api.modsOpen({ version: vdCurrent });

// 检查已装 Mod 的更新
if ($('btn-mod-check-updates')) $('btn-mod-check-updates').onclick = async () => {
  const btn = $('btn-mod-check-updates');
  const list = $('mod-list');
  btn.disabled = true; btn.textContent = '检查中…';
  const r = await window.api.modCheckUpdates({ version: vdCurrent });
  btn.disabled = false; btn.textContent = '🔄 检查更新';
  if (!r || !r.ok) { alert('检查失败：' + ((r && r.error) || '未知错误')); return; }
  if (!r.list.length) { alert(`已扫描 ${r.total || 0} 个 Mod，均无 Modrinth 可查的新版本。`); return; }
  // 在 mod 列表上方插入更新提示
  let panel = $('dyn-mod-update-panel');
  if (!panel) {
    panel = document.createElement('div');
    panel.id = 'dyn-mod-update-panel';
    panel.className = 'dyn-mod-update-panel';
    list.parentNode.insertBefore(panel, list);
  }
  panel.innerHTML = `<div class="mup-head">🔄 发现 ${r.list.length} 个可更新 Mod：</div>` +
    r.list.map((u, i) => {
      const tag = u.compatible ? '<span class="tg mc">兼容</span>' : '<span class="tg loader" style="background:rgba(224,128,63,.16);color:#b5621f">需核实</span>';
      return `<div class="mup-item" data-i="${i}">
        <div class="mup-body"><div class="mup-name">${esc(u.file)}</div><div class="mup-sub">新版：${esc(u.version)} ${tag}</div></div>
        <button class="btn primary mini" data-act="up">⬆ 更新</button>
      </div>`;
    }).join('') +
    `<div class="row end"><button class="btn ghost mini" id="mup-close">关闭</button></div>`;
  panel.querySelectorAll('[data-act="up"]').forEach((b) => {
    b.onclick = async () => {
      const u = r.list[+b.closest('.mup-item').dataset.i];
      if (!u.download) return alert('该更新无直接下载地址');
      b.disabled = true; b.textContent = '更新中…';
      // 先删旧文件，再下新文件
      try { await window.api.modsDelete({ version: vdCurrent, file: u.file }); } catch {}
      const rr = await window.api.modInstall({ version: vdCurrent, url: u.download, filename: u.filename });
      if (rr && rr.ok) { b.textContent = '✔ 完成'; log('data', `已更新 Mod ${u.file} -> ${u.version}`); loadMods(); }
      else { b.disabled = false; b.textContent = '⬆ 更新'; alert('更新失败：' + ((rr && rr.error) || '未知')); }
    };
  });
  const cl = panel.querySelector('#mup-close');
  if (cl) cl.onclick = () => panel.remove();
};

// ---------- 下载 Mod（Modrinth / CurseForge，自动筛选兼容版本） ----------
let modStoreLoaded = false;

if ($('btn-mod-download')) $('btn-mod-download').onclick = () => {
  const s = $('mod-store');
  s.style.display = s.style.display === 'none' ? 'block' : 'none';
  if (s.style.display === 'block' && !modStoreLoaded) { modStoreLoaded = true; loadModStore(''); }
};
if ($('btn-mod-store-close')) $('btn-mod-store-close').onclick = () => { $('mod-store').style.display = 'none'; };
if ($('btn-mod-search')) $('btn-mod-search').onclick = () => loadModStore($('in-mod-query').value.trim());
if ($('in-mod-query')) $('in-mod-query').onkeydown = (e) => { if (e.key === 'Enter') loadModStore($('in-mod-query').value.trim()); };
if ($('sel-mod-source')) $('sel-mod-source').onchange = () => loadModStore($('in-mod-query').value.trim());

async function loadModStore(query) {
  const list = $('mod-store-list');
  const source = $('sel-mod-source').value;
  list.innerHTML = '<div class="empty">加载中…</div>';
  $('mod-ver-panel').style.display = 'none';
  const r = $('sel-mod-source').value === 'all'
    ? await window.api.searchAll({ kind: 'mod', query, mcVersion: vdCurrent })
    : await window.api.modSearch({ source, query, version: vdCurrent });
  if (!r.ok) { list.innerHTML = `<div class="empty">搜索失败：${esc(r.error)}</div>`; $('mod-store-filter').textContent = ''; return; }
  if (!r.list.length) { list.innerHTML = '<div class="empty">未找到兼容该版本的 Mod</div>'; }
  else renderCards(list, r.list, (p) => openDetail('mod', p));
  $('mod-store-filter').textContent = `当前实例：MC ${r.mc || '?'}${r.loader ? ' · ' + r.loader : ' · 无加载器（原版不能装 Mod，建议选 Fabric/Forge 版本）'}`;
}

async function openModVersions(pack, source) {
  // 兼容旧调用：直接打开详情页
  openDetail('mod', Object.assign({}, pack, { source }));
}

// ---------- 管理游戏版本（显示删除按钮） ----------
let manageMode = false;
if ($('btn-manage-toggle')) {
  $('btn-manage-toggle').onclick = () => {
    manageMode = !manageMode;
    $('manage-bar').style.display = manageMode ? 'flex' : 'none';
    $('btn-manage-toggle').textContent = manageMode ? '✔ 完成管理' : '🗂 管理游戏版本';
    document.querySelectorAll('.ver-del-btn').forEach((b) => { b.style.display = manageMode ? '' : 'none'; });
  };
}

// ---------- 回收站（恢复已删除的版本） ----------
async function loadTrash() {
  const ul = $('trash-list');
  if (!ul) return;
  ul.innerHTML = '<li class="empty">加载中…</li>';
  const r = await window.api.trashList();
  if (!r.ok) { ul.innerHTML = `<li class="empty">读取失败：${esc(r.error || '')}</li>`; return; }
  if (!r.list.length) { ul.innerHTML = '<li class="empty">回收站为空</li>'; return; }
  ul.innerHTML = '';
  r.list.forEach((it) => {
    const li = document.createElement('li');
    const when = it.deletedAt ? new Date(it.deletedAt).toLocaleString() : '未知时间';
    li.innerHTML = `<div class="ver-left"><div class="ver-main">
        <div class="ver-name">${esc(it.origName)}</div>
        <div class="ver-tags"><span class="tg">🗑 删除于 ${esc(when)}</span><span class="tg">${it.sizeMB} MB</span></div>
      </div></div>
      <div class="ver-right"><button class="btn primary ver-restore-btn">♻️ 恢复</button></div>`;
    li.querySelector('.ver-restore-btn').onclick = async (e) => {
      e.stopPropagation();
      const rr = await window.api.trashRestore({ dir: it.dir });
      if (rr.ok) { log('data', `已恢复版本：${rr.restored}`); await loadTrash(); await refreshVersions(); }
      else alert('恢复失败：' + rr.error);
    };
    ul.appendChild(li);
  });
}

if ($('btn-trash-open')) {
  $('btn-trash-open').onclick = () => {
    const p = $('trash-panel');
    p.style.display = 'block';
    loadTrash();
  };
}
if ($('btn-trash-close')) $('btn-trash-close').onclick = () => { $('trash-panel').style.display = 'none'; };

// ---------- 独立 Mod 下载页 ----------
let modPageLoaded = false;
let modPageTargets = [];

async function loadModPage() {
  modPageLoaded = true;
  // 填充“安装到版本”下拉
  const sel = $('sel-mod-target');
  localVersions = await window.api.listVersions();
  modPageTargets = localVersions;
  sel.innerHTML = '<option value="">不指定（仅浏览）</option>';
  const metas = await Promise.all(localVersions.map((v) => window.api.versionInfo({ name: v }).catch(() => ({ ok: false }))));
  localVersions.forEach((v, i) => {
    const m = metas[i] && metas[i].ok ? metas[i].info : {};
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v + (m.mcVersion ? `  (MC ${m.mcVersion}${m.loader && m.loader !== '原版' ? ' · ' + m.loader : ''})` : '');
    sel.appendChild(o);
  });
  if (selectedVersion && localVersions.includes(selectedVersion)) sel.value = selectedVersion;
  // 填充 MC 版本下拉（取正式版）
  const mcSel = $('sel-mod-mc');
  const mani = await window.api.versionManifest({ type: 'release' });
  if (mani.ok) {
    mcSel.innerHTML = '<option value="">不限</option>';
    mani.list.slice(0, 60).forEach((v) => {
      const o = document.createElement('option');
      o.value = v.id; o.textContent = v.id; mcSel.appendChild(o);
    });
  }
  // 若已预选版本，让 MC 筛选与之对齐并禁用
  if (sel.value) {
    const idx = localVersions.indexOf(sel.value);
    const m = idx >= 0 && metas[idx] && metas[idx].ok ? metas[idx].info : {};
    if (m.mcVersion) {
      if (![...mcSel.options].some((o) => o.value === m.mcVersion)) {
        const o = document.createElement('option'); o.value = m.mcVersion; o.textContent = m.mcVersion; mcSel.appendChild(o);
      }
      mcSel.value = m.mcVersion;
      mcSel.disabled = true;
    }
  }
  loadModPageGrid('');
}

async function loadModPageGrid(query) {
  const grid = $('mod-grid');
  const source = $('sel-modsrc').value;
  const target = $('sel-mod-target').value;
  const mcSel = $('sel-mod-mc').value;
  grid.innerHTML = '<div class="empty">加载中…</div>';
  $('mod-qver-panel').style.display = 'none';
  const params = { source, query };
  if (target) params.version = target;
  else if (mcSel) { params.mc = mcSel; if (localVersions.length) params.loader = ''; }
  const r = await window.api.modSearch(params);
  if (!r.ok) { grid.innerHTML = `<div class="empty">搜索失败：${esc(r.error)}</div>`; return; }
  $('mod-list-title').textContent = query ? `🔍 搜索结果：${query}` : '🔥 热门 Mod（按下载量）';
  if (!r.list.length) { grid.innerHTML = '<div class="empty">未找到结果</div>'; return; }
  renderCards(grid, r.list, (p) => openDetail('mod', p));
}

async function openModPageVersions(pack, source) {
  // 兼容旧调用：直接打开详情页
  openDetail('mod', Object.assign({}, pack, { source }));
}

if ($('btn-modq-search')) $('btn-modq-search').onclick = () => loadModPageGrid($('in-modq').value.trim());
if ($('in-modq')) $('in-modq').onkeydown = (e) => { if (e.key === 'Enter') loadModPageGrid($('in-modq').value.trim()); };
if ($('sel-modsrc')) $('sel-modsrc').onchange = () => loadModPageGrid($('in-modq').value.trim());
if ($('sel-mod-mc')) $('sel-mod-mc').onchange = () => loadModPageGrid($('in-modq').value.trim());
if ($('sel-mod-target')) $('sel-mod-target').onchange = async () => {
  // 选定目标版本后，MC 版本筛选自动同步为该实例的 MC 版本，并禁用（避免冲突）
  const t = $('sel-mod-target').value;
  if (t) {
    const info = await window.api.versionInfo({ name: t });
    if (info.ok && info.info.mcVersion) {
      const sel = $('sel-mod-mc');
      if (![...sel.options].some((o) => o.value === info.info.mcVersion)) {
        const o = document.createElement('option'); o.value = info.info.mcVersion; o.textContent = info.info.mcVersion; sel.appendChild(o);
      }
      sel.value = info.info.mcVersion;
      sel.disabled = true;
    }
  } else {
    $('sel-mod-mc').disabled = false;
  }
  loadModPageGrid($('in-modq').value.trim());
};

// ---------- 服务器版本列表 ----------
async function loadServerVersions() {
  const type = $('sel-srv-type').value;
  const sel = $('sel-srv-mcver');
  sel.innerHTML = '<option>加载中…</option>';
  const r = await window.api.serverVersions({ type });
  if (!r.ok) { sel.innerHTML = '<option>加载失败</option>'; return; }
  sel.innerHTML = '';
  r.list.forEach((v) => {
    const id = typeof v === 'string' ? v : v.id;
    const o = document.createElement('option');
    o.value = id;
    o.textContent = id;
    sel.appendChild(o);
  });
  // 默认选个常见版本
  const prefer = ['1.21.4', '1.21.1', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2', '1.16.5'];
  for (const p of prefer) {
    if (r.list.some((v) => (typeof v === 'string' ? v : v.id) === p)) { sel.value = p; break; }
  }
}
$('sel-srv-type').onchange = loadServerVersions;

// ---------- Java ----------
async function detectJava() {
  const found = await window.api.detectJava();
  const list = $('java-list');
  list.innerHTML = '';
  if (found.length) {
    $('st-java').textContent = `已找到 ${found.length} 个`;
    found.forEach((p) => {
      const li = document.createElement('li');
      li.textContent = '✔ ' + p;
      li.style.cursor = 'pointer';
      li.onclick = () => { $('in-java').value = p; };
      list.appendChild(li);
    });
  } else {
    $('st-java').textContent = '未找到，请手动指定';
    list.innerHTML = '<li>未自动检测到 Java，请在下方手动浏览选择 java.exe</li>';
  }
}

// ---------- 事件绑定 ----------
$('btn-open-mc').onclick = () => window.api.openPath(cfg.mcDir);
if ($('home-version')) $('home-version').onclick = (e) => { e.stopPropagation(); toggleHomePicker(); };
if ($('btn-log-clear')) $('btn-log-clear').onclick = () => { $('log-box').textContent = ''; logLines = 0; const c=$('log-count'); if(c) c.textContent='0 条'; };
if ($('btn-log-copy')) $('btn-log-copy').onclick = async () => {
  const txt = $('log-box').textContent || '';
  if (!txt) return;
  try { await navigator.clipboard.writeText(txt); $('btn-log-copy').textContent = '✔ 已复制'; setTimeout(()=>{ $('btn-log-copy').textContent='📋 复制全部'; }, 1500); }
  catch { alert('复制失败，请手动选中复制'); }
};
$('btn-refresh').onclick = refreshVersions;
$('btn-detect-java').onclick = detectJava;
$('btn-about-repo').onclick = () => window.api.openPath('https://github.com/');
$('btn-about-issues').onclick = () => window.api.openPath('https://github.com/');
if ($('about-repo-link')) $('about-repo-link').onclick = (e) => { e.preventDefault(); window.api.openPath('https://github.com/'); };
if ($('about-issues-link')) $('about-issues-link').onclick = (e) => { e.preventDefault(); window.api.openPath('https://github.com/'); };

// 法律文档弹窗
document.querySelectorAll('.legal-link').forEach((b) => {
  b.onclick = async () => {
    const doc = b.dataset.doc;
    const modal = $('legal-modal');
    $('legal-title').textContent = b.textContent.trim();
    $('legal-content').textContent = '加载中…';
    modal.style.display = 'flex';
    const r = await window.api.legal(doc);
    $('legal-content').textContent = r.ok ? r.content : ('无法加载文档：' + (r.error || '未知错误'));
  };
});
if ($('legal-close')) $('legal-close').onclick = () => { $('legal-modal').style.display = 'none'; };
if ($('legal-modal')) $('legal-modal').onclick = (e) => { if (e.target.id === 'legal-modal') $('legal-modal').style.display = 'none'; };

// ---------- 存档与备份页 ----------
let dataLoaded = false;
let currentWorld = '';
let currentInstance = '';
let dataTab = 'worlds';

function loadDataPage() {
  dataLoaded = true;
  switchDataTab(dataTab);
}

function switchDataTab(tab) {
  dataTab = tab;
  document.querySelectorAll('.data-tab').forEach((b) => b.classList.toggle('active', b.dataset.dtab === tab));
  document.querySelectorAll('.data-panel').forEach((p) => (p.style.display = 'none'));
  const panel = $('dpanel-' + tab);
  if (panel) panel.style.display = '';
  if (tab === 'worlds') loadWorlds();
  else if (tab === 'instances') loadInstances();
  else if (tab === 'shots') loadShots();
  else if (tab === 'import') loadImportables();
}
document.querySelectorAll('.data-tab').forEach((b) => { b.onclick = () => switchDataTab(b.dataset.dtab); });

async function loadWorlds() {
  const ul = $('world-list');
  if (!ul) return;
  ul.innerHTML = '<li class="empty">加载中…</li>';
  const r = await window.api.worldList();
  if (!r.ok) { ul.innerHTML = `<li class="empty">加载失败：${esc(r.error)}</li>`; return; }
  if (!r.list.length) { ul.innerHTML = '<li class="empty">还没有存档。进游戏创建一个世界后会出现在这里。</li>'; return; }
  ul.innerHTML = '';
  r.list.forEach((w) => {
    const li = document.createElement('li');
    li.className = 'data-item';
    const iconHtml = w.hasIcon
      ? `<img class="w-ico" src="file://${encodeURI(w.iconPath.replace(/\\/g, '/'))}" onerror="this.style.display='none'">`
      : '<div class="w-ico w-ico-fallback">🌍</div>';
    const date = w.lastPlayed ? new Date(w.lastPlayed).toLocaleString() : '—';
    li.innerHTML = `${iconHtml}
      <div class="data-body">
        <div class="data-name">${esc(w.name)}</div>
        <div class="data-sub">大小 ${esc(w.sizeText)} · 最后修改 ${esc(date)} · 备份 ${w.backups} 份</div>
      </div>
      <div class="data-actions">
        <button class="btn primary mini" data-act="backup">💾 备份</button>
        <button class="btn ghost mini" data-act="restore">♻️ 备份列表</button>
        <button class="btn ghost mini" data-act="del">🗑 删除</button>
      </div>`;
    li.querySelector('[data-act="backup"]').onclick = async () => {
      const b = li.querySelector('[data-act="backup"]');
      b.disabled = true; b.textContent = '备份中…';
      const rr = await window.api.worldBackup({ name: w.name });
      b.disabled = false; b.textContent = '💾 备份';
      if (rr.ok) { log('data', `已备份世界 ${w.name}（${rr.sizeText}）`); loadWorlds(); }
      else alert('备份失败：' + rr.error);
    };
    li.querySelector('[data-act="restore"]').onclick = () => openWorldBackups(w.name);
    li.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm(`确定删除存档「${w.name}」？\n会移入回收站（.trash），可手动恢复。`)) return;
      const rr = await window.api.worldDelete({ name: w.name });
      if (rr.ok) { log('data', `已删除世界 ${w.name}（移入回收站）`); loadWorlds(); }
      else alert('删除失败：' + rr.error);
    };
    ul.appendChild(li);
  });
}

async function openWorldBackups(name) {
  currentWorld = name;
  const panel = $('world-bk-panel');
  const ul = $('world-bk-list');
  if (!panel || !ul) return;
  panel.style.display = '';
  $('wbk-title').textContent = `💾 「${name}」的备份`;
  ul.innerHTML = '<li class="empty">加载中…</li>';
  const r = await window.api.worldBackups({ name });
  if (!r.ok) { ul.innerHTML = `<li class="empty">加载失败：${esc(r.error)}</li>`; return; }
  if (!r.list.length) { ul.innerHTML = '<li class="empty">该世界还没有备份。</li>'; return; }
  ul.innerHTML = '';
  r.list.forEach((b) => {
    const li = document.createElement('li');
    li.className = 'data-item';
    const date = b.ts ? new Date(b.ts).toLocaleString() : '—';
    li.innerHTML = `<div class="w-ico w-ico-fallback">🗜️</div>
      <div class="data-body">
        <div class="data-name">${esc(date)}</div>
        <div class="data-sub">大小 ${esc(b.sizeText)}</div>
      </div>
      <div class="data-actions">
        <button class="btn primary mini" data-act="restore">♻️ 还原</button>
        <button class="btn ghost mini" data-act="del">🗑 删除</button>
      </div>`;
    li.querySelector('[data-act="restore"]').onclick = async () => {
      if (!confirm('还原会用该备份覆盖当前世界（覆盖前会自动再备份一份）。继续？')) return;
      const rr = await window.api.worldRestore({ file: b.file });
      if (rr.ok) { log('data', `已还原世界 ${rr.world}`); loadWorlds(); openWorldBackups(currentWorld); }
      else alert('还原失败：' + rr.error);
    };
    li.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm('删除这个备份？')) return;
      const rr = await window.api.worldBackupDelete({ file: b.file });
      if (rr.ok) openWorldBackups(currentWorld); else alert('删除失败：' + rr.error);
    };
    ul.appendChild(li);
  });
}

async function loadInstances() {
  const ul = $('inst-list');
  if (!ul) return;
  ul.innerHTML = '<li class="empty">加载中…</li>';
  const r = await window.api.listVersions();
  const list = Array.isArray(r) ? r : ((r && (r.list || r.versions)) || []);
  if (!list.length) { ul.innerHTML = '<li class="empty">还没有本地实例。</li>'; return; }
  ul.innerHTML = '';
  list.forEach((v) => {
    const name = typeof v === 'string' ? v : v.name;
    const li = document.createElement('li');
    li.className = 'data-item';
    li.innerHTML = `<div class="w-ico w-ico-fallback">📦</div>
      <div class="data-body"><div class="data-name">${esc(name)}</div><div class="data-sub">点击“备份”打包整个实例</div></div>
      <div class="data-actions">
        <button class="btn primary mini" data-act="backup">💾 备份</button>
        <button class="btn ghost mini" data-act="list">♻️ 备份列表</button>
      </div>`;
    li.querySelector('[data-act="backup"]').onclick = async () => {
      const b = li.querySelector('[data-act="backup"]');
      b.disabled = true; b.textContent = '打包中…';
      const rr = await window.api.instanceBackup({ name });
      b.disabled = false; b.textContent = '💾 备份';
      if (rr.ok) { log('data', `已备份实例 ${name}（${rr.sizeText}）`); alert('备份完成：' + rr.sizeText); }
      else alert('备份失败：' + rr.error);
    };
    li.querySelector('[data-act="list"]').onclick = () => openInstanceBackups(name);
    ul.appendChild(li);
  });
}

async function openInstanceBackups(name) {
  currentInstance = name;
  const panel = $('inst-bk-panel');
  const ul = $('inst-bk-list');
  if (!panel || !ul) return;
  panel.style.display = '';
  $('ibk-title').textContent = `📦 「${name}」的实例备份`;
  ul.innerHTML = '<li class="empty">加载中…</li>';
  const r = await window.api.instanceBackups({ name });
  if (!r.ok) { ul.innerHTML = `<li class="empty">加载失败：${esc(r.error)}</li>`; return; }
  if (!r.list.length) { ul.innerHTML = '<li class="empty">该实例还没有备份。</li>'; return; }
  ul.innerHTML = '';
  r.list.forEach((b) => {
    const li = document.createElement('li');
    li.className = 'data-item';
    const date = b.ts ? new Date(b.ts).toLocaleString() : '—';
    li.innerHTML = `<div class="w-ico w-ico-fallback">🗜️</div>
      <div class="data-body"><div class="data-name">${esc(date)}</div><div class="data-sub">大小 ${esc(b.sizeText)}</div></div>
      <div class="data-actions">
        <button class="btn primary mini" data-act="restore">♻️ 还原</button>
        <button class="btn ghost mini" data-act="del">🗑 删除</button>
      </div>`;
    li.querySelector('[data-act="restore"]').onclick = async () => {
      if (!confirm('还原会用该备份覆盖当前实例（覆盖前会自动再备份一份）。继续？')) return;
      const rr = await window.api.instanceRestore({ file: b.file });
      if (rr.ok) { log('data', `已还原实例 ${rr.instance}`); await refreshVersions(); openInstanceBackups(currentInstance); }
      else alert('还原失败：' + rr.error);
    };
    li.querySelector('[data-act="del"]').onclick = async () => {
      if (!confirm('删除这个备份？')) return;
      const rr = await window.api.instanceBackupDelete({ file: b.file });
      if (rr.ok) openInstanceBackups(currentInstance); else alert('删除失败：' + rr.error);
    };
    ul.appendChild(li);
  });
}

async function loadShots() {
  const grid = $('shot-list');
  if (!grid) return;
  grid.innerHTML = '<div class="empty">加载中…</div>';
  const r = await window.api.shotList();
  if (!r.ok) { grid.innerHTML = `<div class="empty">加载失败：${esc(r.error)}</div>`; return; }
  if (!r.list.length) { grid.innerHTML = '<div class="empty">还没有截图。游戏中按 F2 截图后会出现在这里。</div>'; return; }
  grid.innerHTML = '';
  r.list.forEach((s) => {
    const d = document.createElement('div');
    d.className = 'shot-card';
    const url = 'file://' + encodeURI(s.path.replace(/\\/g, '/'));
    d.innerHTML = `<img src="${url}" loading="lazy" onerror="this.parentNode.classList.add('shot-broken')">
      <div class="shot-meta">${esc(new Date(s.mtime).toLocaleString())} · ${esc(s.sizeText)}</div>`;
    d.onclick = () => window.api.shotShow({ file: s.file });
    grid.appendChild(d);
  });
}

async function loadImportables() {
  const ul = $('import-list');
  if (!ul) return;
  ul.innerHTML = '<li class="empty">扫描中…</li>';
  const r = await window.api.importList();
  if (!r.ok) { ul.innerHTML = `<li class="empty">扫描失败：${esc(r.error)}</li>`; return; }
  if ($('import-dir-hint')) $('import-dir-hint').textContent = `扫描目录：${r.dir}（缺失的库/resources 会在首次启动时自动补齐）`;
  if (!r.list.length) { ul.innerHTML = '<li class="empty">未发现官方启动器里的版本（或官方启动器未安装）。</li>'; return; }
  ul.innerHTML = '';
  r.list.forEach((v) => {
    const li = document.createElement('li');
    li.className = 'data-item';
    li.innerHTML = `<div class="w-ico w-ico-fallback">${v.hasJar ? '🎮' : '📄'}</div>
      <div class="data-body"><div class="data-name">${esc(v.name)}</div><div class="data-sub">大小 ${esc(v.sizeText)}${v.extras && v.extras.length ? ' · 含 ' + esc(v.extras.join('/')) : ''}${v.hasJar ? '' : ' · 无 jar，需重新下载'}</div></div>
      <div class="data-actions"></div>`;
    const act = li.querySelector('.data-actions');
    if (v.already) {
      act.innerHTML = '<span class="hint" style="margin:0">已存在</span>';
    } else {
      act.innerHTML = '<button class="btn primary mini">📥 导入</button>';
      act.querySelector('button').onclick = async () => {
        const b = act.querySelector('button'); b.disabled = true; b.textContent = '导入中…';
        const rr = await window.api.importVersion({ name: v.name });
        if (rr.ok) { log('data', `已导入版本 ${v.name}`); await refreshVersions(); loadImportables(); }
        else { alert('导入失败：' + rr.error); b.disabled = false; b.textContent = '📥 导入'; }
      };
    }
    ul.appendChild(li);
  });
}

// 绑定存档页按钮
if ($('btn-world-open')) $('btn-world-open').onclick = () => window.api.worldOpen();
if ($('btn-world-refresh')) $('btn-world-refresh').onclick = () => loadWorlds();
if ($('btn-wbk-close')) $('btn-wbk-close').onclick = () => { $('world-bk-panel').style.display = 'none'; };
if ($('btn-inst-refresh')) $('btn-inst-refresh').onclick = () => loadInstances();
if ($('btn-ibk-close')) $('btn-ibk-close').onclick = () => { $('inst-bk-panel').style.display = 'none'; };
if ($('btn-shot-open')) $('btn-shot-open').onclick = () => window.api.shotOpen();
if ($('btn-shot-refresh')) $('btn-shot-refresh').onclick = () => loadShots();
if ($('btn-import-refresh')) $('btn-import-refresh').onclick = () => loadImportables();

// 检查更新（优化版：显示发布说明/大小/时间；区分错误；可选安装版/免安装版；带下载进度）
async function runCheckUpdate(silent, prefer) {
  const el = $('update-result');
  const btn = $('btn-check-update');
  const notes = $('update-notes');
  if (notes) { notes.style.display = 'none'; notes.innerHTML = ''; }
  if (el) el.innerHTML = silent ? '' : '正在检查更新…';
  if (btn && !silent) { btn.disabled = true; btn.textContent = '检查中…'; }
  const r = await window.api.checkUpdateP({ prefer: prefer || 'installer' });
  if (btn) { btn.disabled = false; btn.textContent = '🔍 检查更新'; }
  if (!r.ok) {
    if (silent) return; // 静默检查失败不打扰用户
    const map = {
      NO_RELEASE: '该仓库还没有发布版本。',
      RATE_LIMIT: 'GitHub 请求过于频繁，请稍后再试。',
      TIMEOUT: '请求超时，请检查网络后重试。',
      OFFLINE: '网络不可用（可能无法访问 GitHub）。'
    };
    el.innerHTML = `⚠ 检查失败：${esc(map[r.error] || r.hint || r.raw || '未知错误')}`;
    return;
  }
  if (r.hasUpdate) {
    const sizeTxt = r.size ? ` · ${(r.size / 1048576).toFixed(1)} MB` : '';
    const dateTxt = r.publishedAt ? ` · ${String(r.publishedAt).slice(0, 10)}` : '';
    const pre = r.prerelease ? ' <span class="upd-pre">预发布</span>' : '';
    const hasInst = r.installer && r.installer.url;
    const hasPort = r.portable && r.portable.url;
    el.innerHTML =
      `🎉 发现新版本 <b>${esc(r.latest)}</b>（当前 ${esc(r.current)}）${pre}${sizeTxt}${dateTxt}` +
      `<div class="upd-actions">` +
      (hasInst ? `<a href="#" class="btn primary upd-dl-btn" id="upd-auto">⚡ 一键更新（自动下载并安装）</a>` : '') +
      (hasInst ? `<a href="#" class="btn upd-dl-btn" id="upd-dl-inst">⬇ 下载安装版${r.installer.size ? ' (' + (r.installer.size / 1048576).toFixed(0) + 'MB)' : ''}</a>` : '') +
      (hasPort ? `<a href="#" class="btn upd-dl-btn" id="upd-dl-port">⬇ 下载免安装版${r.portable.size ? ' (' + (r.portable.size / 1048576).toFixed(0) + 'MB)' : ''}</a>` : '') +
      (!hasInst && !hasPort && r.downloadUrl ? `<a href="#" class="btn primary upd-dl-btn" id="upd-dl-any">⬇ 下载新版本</a>` : '') +
      (r.url ? ` <a href="#" id="upd-page" class="upd-link">查看发布页</a>` : '') +
      `</div>` +
      `<div class="upd-progress-wrap" id="upd-prog-wrap" style="display:none"><div class="progress-bar"><div class="progress-inner" id="upd-prog"></div></div><div class="progress-text" id="upd-prog-text"></div></div>`;

    const startDownload = (asset) => doDownloadUpdate(asset);
    const bInst = $('upd-dl-inst'); if (bInst) bInst.onclick = (e) => { e.preventDefault(); startDownload(r.installer); };
    const bPort = $('upd-dl-port'); if (bPort) bPort.onclick = (e) => { e.preventDefault(); startDownload(r.portable); };
    const bAny = $('upd-dl-any'); if (bAny) bAny.onclick = (e) => { e.preventDefault(); startDownload({ url: r.downloadUrl, name: r.downloadName }); };
    const bAuto = $('upd-auto');
    if (bAuto) bAuto.onclick = (e) => { e.preventDefault(); autoUpdate(r.installer || { url: r.downloadUrl, name: r.downloadName }); };
    const pg = $('upd-page'); if (pg) pg.onclick = (e) => { e.preventDefault(); window.api.openPath(r.url); };

    if (notes && r.notes && r.notes.trim()) {
      notes.style.display = 'block';
      notes.innerHTML = `<div class="upd-notes-title">📝 更新内容</div><div class="upd-notes-body"></div>`;
      notes.querySelector('.upd-notes-body').textContent = r.notes.trim();
    }
  } else {
    el.textContent = `✅ 已是最新版本（${esc(r.current)}）`;
  }
}

// 一键更新：弹出进度弹窗 → 后台下载 → 静默安装/重启 → 自动重启新版本
async function autoUpdate(asset) {
  if (!asset || !asset.url) return;
  // 打开更新进度弹窗
  const mask = $('upd-modal');
  if (mask) mask.style.display = 'flex';
  if ($('upd-modal-title')) $('upd-modal-title').textContent = '正在更新';
  if ($('upd-modal-prog')) $('upd-modal-prog').style.width = '0%';
  if ($('upd-modal-text')) $('upd-modal-text').textContent = '正在下载更新包…';
  const wrap = $('upd-prog-wrap');
  if (wrap) { wrap.style.display = ''; $('upd-prog').style.width = '0%'; $('upd-prog-text').textContent = '正在后台下载更新包…'; }
  const setModal = (t, pct) => {
    if (pct != null && $('upd-modal-prog')) $('upd-modal-prog').style.width = pct + '%';
    if (t && $('upd-modal-text')) $('upd-modal-text').textContent = t;
  };
  let r;
  try {
    r = await window.api.autoUpdateSilent({ url: asset.url, name: asset.name });
  } catch (e) {
    r = { ok: false, error: String(e && e.message ? e.message : e) };
  }
  if (r.ok) {
    const doneMsg = r.relaunched
      ? '下载完成，正在重启到新版本，请稍候…'
      : '下载完成，正在静默安装并自动重启，请稍候…';
    setModal(doneMsg, 100);
    if ($('upd-modal-title')) $('upd-modal-title').textContent = '更新完成';
    if ($('upd-prog')) $('upd-prog').style.width = '100%';
    if ($('upd-prog-text')) $('upd-prog-text').textContent = doneMsg;
    return;
  }
  // 免安装版：下载到文件夹，交给用户手动替换
  if (r.fallback) {
    setModal('已下载完成，等待手动替换', 100);
    if ($('upd-modal-title')) $('upd-modal-title').textContent = '已下载更新包';
    if ($('upd-prog')) $('upd-prog').style.width = '100%';
    if ($('upd-prog-text'))
      $('upd-prog-text').innerHTML =
        '✔ 免安装版已下载到 updates 文件夹，请关闭本程序后手动覆盖替换。' +
        '<a href="#" id="upd-open-folder" class="upd-link">打开位置</a>';
    const of = $('upd-open-folder');
    if (of) of.onclick = (e) => { e.preventDefault(); window.api.openUpdateFolder(); };
    window.api.openUpdateFolder();
    return;
  }
  setModal('更新失败：' + (r.error || '未知错误'));
  if ($('upd-modal-title')) $('upd-modal-title').textContent = '更新失败';
  if ($('upd-prog-text')) $('upd-prog-text').textContent = '更新失败：' + (r.error || '未知错误');
  // 失败时 3 秒后自动关闭弹窗，让用户能看到结果
  setTimeout(() => { if ($('upd-modal')) $('upd-modal').style.display = 'none'; }, 3000);
}

// 下载更新包（带进度），完成后提供打开位置
async function doDownloadUpdate(asset) {
  if (!asset || !asset.url) return;
  const wrap = $('upd-prog-wrap');
  if (wrap) { wrap.style.display = ''; $('upd-prog').style.width = '0%'; $('upd-prog-text').textContent = '开始下载…'; }
  const r = await window.api.downloadUpdate({ url: asset.url, name: asset.name });
  if (r.ok) {
    if ($('upd-prog')) $('upd-prog').style.width = '100%';
    if ($('upd-prog-text')) $('upd-prog-text').innerHTML = `✔ 下载完成，已保存到 updates 文件夹。<a href="#" id="upd-open-folder" class="upd-link">打开位置</a>`;
    const of = $('upd-open-folder');
    if (of) of.onclick = (e) => { e.preventDefault(); window.api.openUpdateFolder(); };
    window.api.openUpdateFolder();
  } else {
    if ($('upd-prog-text')) $('upd-prog-text').textContent = '下载失败：' + r.error;
  }
}

if ($('btn-check-update')) $('btn-check-update').onclick = () => runCheckUpdate(false, 'installer');
// 启动后自动静默检查（只在真有新版本时才提示）
setTimeout(() => { if (!document.hidden) runCheckUpdate(true, 'installer'); }, 4000);

$('btn-pick-mc').onclick = async () => {
  const p = await window.api.pickDir();
  if (p) $('in-mcdir').value = p;
};
$('btn-pick-java').onclick = async () => {
  const p = await window.api.pickJava();
  if (p) $('in-java').value = p;
};

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

// ---------- 整合包 / 光影包 / 详情页 ----------
let packLoaded = false;
let shaderLoaded = false;
let detailCtx = null; // { kind:'pack'|'shader', pack }

// 格式化下载量
function fmtNum(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// 格式化字节大小
function fmtBytes(b) {
  b = Number(b) || 0;
  if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
}

// 格式化剩余时间
function fmtEta(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec >= 3600) return Math.floor(sec / 3600) + 'h' + Math.floor((sec % 3600) / 60) + 'm';
  if (sec >= 60) return Math.floor(sec / 60) + 'm' + (sec % 60) + 's';
  return sec + 's';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderCards(container, list, onPick) {
  container.innerHTML = '';
  if (!list.length) {
    container.innerHTML = '<div class="empty">未找到结果</div>';
    return;
  }
  list.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'pack-card';
    if (p.id) card.dataset.packId = p.id;
    const iconHtml = p.icon
      ? `<div class="pk-icon"><img src="${p.icon}" onerror="this.style.display='none';this.parentNode.classList.add('pk-icon-fallback')"></div>`
      : '<div class="pk-icon pk-icon-fallback"></div>';
    card.innerHTML = `${iconHtml}
      <div class="pk-body">
        <div class="pk-title">${esc(p.title)}${p.zhName ? `<span class="pk-zh">${esc(p.zhName)}</span>` : ''}</div>
        <div class="pk-desc">${esc(p.description || '')}</div>
        <div class="pk-meta">
          <span class="pk-dl">⬇ ${fmtNum(p.downloads || 0)} 下载</span>
          <span class="pk-tag">${esc(p.author || (p.source === 'curseforge' ? 'CurseForge' : 'Modrinth'))}</span>
        </div>
      </div>`;
    card.onclick = () => onPick(p);
    container.appendChild(card);
  });
}

$('btn-pack-search').onclick = async () => {
  const source = $('sel-pack-source').value;
  const query = $('in-pack-query').value.trim();
  if (!query) return loadPackTop();
  const list = $('pack-list');
  $('pack-list-title').textContent = '🔍 搜索结果：' + query;
  list.innerHTML = '<div class="empty">搜索中…</div>';
  const res = source === 'all'
    ? await window.api.searchAll({ kind: 'modpack', query })
    : await window.api.packSearch({ source, query, type: 'modpack' });
  if (!res.ok) { list.innerHTML = `<div class="empty">搜索失败：${res.error}</div>`; return; }
  renderCards(list, res.list, (p) => openDetail('pack', p));
};

async function loadPackTop() {
  packLoaded = true;
  const list = $('pack-list');
  $('pack-list-title').textContent = '🔥 热门整合包（按下载量）';
  list.innerHTML = '<div class="empty">加载中…</div>';
  const res = await window.api.packTop({ type: 'modpack', offset: 0 });
  if (!res.ok) { list.innerHTML = `<div class="empty">加载失败：${res.error}</div>`; return; }
  renderCards(list, res.list, (p) => openDetail('pack', p));
}

// 光影
$('btn-shader-search').onclick = async () => {
  const query = $('in-shader-query').value.trim();
  if (!query) return loadShaderTop();
  const list = $('shader-list');
  $('shader-list-title').textContent = '🔍 搜索结果：' + query;
  list.innerHTML = '<div class="empty">搜索中…</div>';
  const res = await window.api.shaderSearch({ query });
  if (!res.ok) { list.innerHTML = `<div class="empty">搜索失败：${res.error}</div>`; return; }
  renderCards(list, res.list, (p) => openDetail('shader', p));
};

async function loadShaderTop() {
  shaderLoaded = true;
  const list = $('shader-list');
  $('shader-list-title').textContent = '🔥 热门光影包（按下载量）';
  list.innerHTML = '<div class="empty">加载中…</div>';
  const res = await window.api.packTop({ type: 'shader', offset: 0 });
  if (!res.ok) { list.innerHTML = `<div class="empty">加载失败：${res.error}</div>`; return; }
  renderCards(list, res.list, (p) => openDetail('shader', p));
}

// ---------- 资源包 ----------
let rpackLoaded = false;
function switchShaderTab(tab) {
  document.querySelectorAll('[data-stab]').forEach((b) => b.classList.toggle('active', b.dataset.stab === tab));
  const sp = $('spanel-shader'), rp = $('spanel-rpack');
  if (sp) sp.style.display = tab === 'shader' ? '' : 'none';
  if (rp) rp.style.display = tab === 'rpack' ? '' : 'none';
  if (tab === 'rpack' && !rpackLoaded) loadRpackTop();
}
document.querySelectorAll('[data-stab]').forEach((b) => { b.onclick = () => switchShaderTab(b.dataset.stab); });

async function loadRpackTop() {
  rpackLoaded = true;
  const list = $('rpack-list');
  if (!list) return;
  $('rpack-list-title').textContent = '🔥 热门资源包（按下载量）';
  list.innerHTML = '<div class="empty">加载中…</div>';
  const res = await window.api.rpackSearch({ query: '' });
  if (!res.ok) { list.innerHTML = `<div class="empty">加载失败：${res.error}</div>`; return; }
  renderCards(list, res.list, (p) => openDetail('rpack', p));
}
if ($('btn-rpack-search')) $('btn-rpack-search').onclick = async () => {
  const q = $('in-rpack-query').value.trim();
  const list = $('rpack-list');
  if (!q) return loadRpackTop();
  $('rpack-list-title').textContent = '🔍 搜索结果：' + q;
  list.innerHTML = '<div class="empty">搜索中…</div>';
  const res = await window.api.rpackSearch({ query: q });
  if (!res.ok) { list.innerHTML = `<div class="empty">搜索失败：${res.error}</div>`; return; }
  renderCards(list, res.list, (p) => openDetail('rpack', p));
};
if ($('btn-rpack-open')) $('btn-rpack-open').onclick = () => window.api.rpackOpen();
if ($('in-rpack-query')) $('in-rpack-query').onkeydown = (e) => { if (e.key === 'Enter') $('btn-rpack-search').click(); };

// ---------- 独立详情页 ----------
async function openDetail(kind, pack) {
  detailCtx = { kind, pack };
  // 切到详情页
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  $('page-detail').classList.add('active');
  document.querySelector('.content').scrollTop = 0;

  const isMod = kind === 'mod';
  const isRpack = kind === 'rpack';
  const source = pack.source || (isMod ? ($('sel-modsrc') && $('sel-modsrc').value) || 'modrinth' : 'modrinth');
  detailCtx.source = source;

  // 顶部信息
  $('detail-icon').src = pack.icon || '';
  $('detail-title').textContent = pack.title;
  const kindLabel = kind === 'shader' ? '光影包' : isRpack ? '资源包' : isMod ? 'Mod' : '整合包';
  $('detail-meta').innerHTML =
    `<span class="tg dl">⬇ ${fmtNum(pack.downloads || 0)} 下载</span>` +
    `<span class="tg">${kindLabel}</span>` +
    `<span class="tg">${esc(pack.author || (source === 'curseforge' ? 'CurseForge' : 'Modrinth'))}</span>`;
  $('detail-desc').textContent = pack.description || '';

  // Mod 需要指定“安装到版本”
  const targetRow = $('detail-mod-target-row');
  if (isMod) {
    targetRow.style.display = 'flex';
    await fillDetailTargets(pack);
    $('btn-detail-install').textContent = '⬇ 下载此 Mod';
  } else {
    targetRow.style.display = 'none';
    $('btn-detail-install').textContent = kind === 'shader' ? '⬇ 一键安装光影包' : isRpack ? '⬇ 一键安装资源包' : '⬇ 一键安装整合包';
  }
  $('detail-progress-card').style.display = 'none';
  $('detail-steps').innerHTML = '';

  // 加载完整信息
  const infoRes = await window.api.projectDetail({ id: pack.id, source });
  if (infoRes.ok && infoRes.info) {
    const i = infoRes.info;
    if (i.icon) $('detail-icon').src = i.icon;
    if (i.description) $('detail-desc').textContent = i.description;
    const cats = (i.categories || []).slice(0, 4).map((c) => `<span class="tg">${esc(c)}</span>`).join('');
    $('detail-meta').innerHTML =
      `<span class="tg dl">⬇ ${fmtNum(i.downloads || 0)} 下载</span>` +
      `<span class="tg">❤ ${fmtNum(i.followers || 0)}</span>` +
      `<span class="tg">${kindLabel}</span>` + cats +
      (pack.zhName ? `<span class="tg">中文常用名：${esc(pack.zhName)}</span>` : '');
  } else if (pack.zhName) {
    $('detail-meta').innerHTML += `<span class="tg">中文常用名：${esc(pack.zhName)}</span>`;
  }

  // 加载全部版本
  $('detail-ver-title').textContent = isMod ? '全部可用版本（自动筛选兼容当前实例）' : '全部可用版本';
  const ul = $('detail-ver-list');
  ul.innerHTML = '<li class="empty">加载中…</li>';
  const res = isRpack
    ? await window.api.rpackVersions({ id: pack.id, mc: '' })
    : await window.api.packVersions({ source, id: pack.id, version: isMod ? ($('sel-detail-target') && $('sel-detail-target').value) || '' : undefined });
  if (!res.ok) { ul.innerHTML = `<li class="empty">加载失败：${res.error}</li>`; return; }
  renderVersions(ul, res.list, (v) => installVersion(v));
}

// 填充 Mod 详情页的“安装到版本”下拉
async function fillDetailTargets(pack) {
  const sel = $('sel-detail-target');
  const list = await window.api.listVersions();
  sel.innerHTML = '';
  if (!list.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = '（没有本地版本，请先下载或安装整合包）';
    sel.appendChild(o);
    return;
  }
  const metas = await Promise.all(list.map((v) => window.api.versionInfo({ name: v }).catch(() => ({ ok: false }))));
  list.forEach((v, i) => {
    const m = metas[i] && metas[i].ok ? metas[i].info : {};
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v + (m.mcVersion ? `  (MC ${m.mcVersion}${m.loader && m.loader !== '原版' ? ' · ' + m.loader : ''})` : '');
    sel.appendChild(o);
  });
  if (selectedVersion && list.includes(selectedVersion)) sel.value = selectedVersion;
}

$('btn-detail-back').onclick = () => {
  let back = 'modpack';
  if (detailCtx && detailCtx.kind === 'shader') back = 'shader';
  else if (detailCtx && detailCtx.kind === 'rpack') back = 'shader';
  else if (detailCtx && detailCtx.kind === 'mod') back = 'mod';
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  $('page-' + back).classList.add('active');
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === back));
};

$('btn-detail-page').onclick = () => {
  if (!detailCtx) return;
  const slug = detailCtx.pack.slug || detailCtx.pack.id;
  const src = detailCtx.source || detailCtx.pack.source || 'modrinth';
  if (src === 'curseforge') window.api.openPath(`https://www.curseforge.com/minecraft/search?search=${encodeURIComponent(detailCtx.pack.title)}`);
  else window.api.openPath(`https://modrinth.com/project/${slug}`);
};

// 渲染版本列表
function renderVersions(ul, list, onDownload) {
  ul.innerHTML = '';
  if (!list.length) { ul.innerHTML = '<li class="empty">没有可用版本</li>'; return; }
  list.forEach((v) => {
    const li = document.createElement('li');
    const mcTags = (v.mc || []).map((m) => `<span class="tg mc">${esc(m)}</span>`).join('');
    const loaderTags = (v.loaders || []).map((l) => `<span class="tg loader">${esc(l)}</span>`).join('');
    const typeCls = v.type === 'beta' ? 'beta' : v.type === 'alpha' ? 'alpha' : 'rel';
    const typeTag = v.type ? `<span class="tg ${typeCls}">${v.type}</span>` : '';
    const dlTag = v.downloads != null ? `<span class="ver-dl">⬇ ${fmtNum(v.downloads)}</span>` : '';
    li.innerHTML = `
      <div class="ver-left">
        <div class="ver-name">${esc(v.name || v.version)}</div>
        <div class="ver-tags">${typeTag}${mcTags}${loaderTags}</div>
      </div>
      <div class="ver-right">${dlTag}<button class="ver-download-btn">安装</button></div>`;
    li.querySelector('.ver-download-btn').onclick = (e) => { e.stopPropagation(); onDownload(v); };
    li.onclick = () => onDownload(v);
    ul.appendChild(li);
  });
}

// 一键安装某个版本
async function installVersion(v) {
  if (!detailCtx) return;
  const { kind, pack } = detailCtx;

  // Mod：下载到指定实例的 mods 文件夹
  if (kind === 'mod') {
    const target = $('sel-detail-target') ? $('sel-detail-target').value : '';
    if (!target) { alert('请先在上方「安装到版本」里选一个要装进的版本'); return; }
    const f = (v.files || []).find((x) => x.primary) || (v.files || [])[0];
    if (!f) return alert('该版本没有可下载文件');
    const card = $('detail-progress-card');
    card.style.display = 'block';
    $('detail-progress-title').textContent = '下载 Mod：' + pack.title;
    $('detail-progress').style.width = '30%';
    $('detail-progress-text').textContent = '正在下载…';
    $('detail-steps').innerHTML = '';
    addStep('下载到「' + target + '」的 mods 文件夹');
    log('data', `开始下载 Mod：${pack.title} / ${f.filename} → ${target}`);
    const r = await window.api.modInstall({ version: target, url: f.url, filename: f.filename });
    if (r && r.ok) {
      addStep('下载完成', 'done');
      $('detail-progress').style.width = '100%';
      $('detail-progress-text').textContent = '下载完成';
      alert(`已下载到「${target}」的 mods 文件夹：\n${f.filename}`);
    } else {
      addStep('下载失败：' + (r ? r.error : '未知错误'), 'err');
      $('detail-progress-text').textContent = '下载失败';
    }
    return;
  }

  // 资源包：下载到 .minecraft/resourcepacks
  if (kind === 'rpack') {
    const f = (v.files || []).find((x) => x.primary) || (v.files || [])[0];
    if (!f) return alert('该版本没有可下载文件');
    const card = $('detail-progress-card');
    card.style.display = 'block';
    $('detail-progress-title').textContent = '安装资源包：' + pack.title;
    $('detail-progress').style.width = '30%';
    $('detail-progress-text').textContent = '正在下载…';
    $('detail-steps').innerHTML = '';
    addStep('下载到 resourcepacks');
    log('data', `开始下载资源包：${pack.title} / ${f.filename}`);
    const r = await window.api.rpackInstall({ url: f.url, filename: f.filename });
    if (r && r.ok) {
      addStep('下载完成', 'done');
      $('detail-progress').style.width = '100%';
      $('detail-progress-text').textContent = '下载完成，可在游戏“选项 → 资源包”中启用';
    } else {
      addStep('下载失败：' + (r ? r.error : '未知错误'), 'err');
      $('detail-progress-text').textContent = '下载失败';
    }
    return;
  }

  const card = $('detail-progress-card');
  card.style.display = 'block';
  $('detail-progress-title').textContent = (kind === 'shader' ? '安装光影包' : '安装整合包') + '：' + pack.title;
  $('detail-progress').style.width = '0%';
  $('detail-progress-text').textContent = '准备中…';
  $('detail-steps').innerHTML = '';
  $('btn-detail-install').disabled = true;

  addStep('开始安装 ' + (v.name || v.version));
  log('data', `开始一键安装：${pack.title} / ${v.name || v.version}`);

  const res = kind === 'shader'
    ? await window.api.shaderInstallFull({ id: pack.id, versionId: v.id })
    : await window.api.packInstallFull({ id: pack.id, versionId: v.id, name: pack.title });

  if (res && res.ok) {
    addStep('安装完成', 'done');
    $('detail-progress').style.width = '100%';
    $('detail-progress-text').textContent = '安装完成';
    alert((kind === 'shader' ? '光影包' : '整合包') + '安装完成！\n位置：' + (res.file || res.instanceDir || ''));
    if (kind === 'pack') refreshVersions();
  } else {
    addStep('安装失败：' + (res ? res.error : '未知错误'), 'err');
    $('detail-progress-text').textContent = '安装失败';
  }
  $('btn-detail-install').disabled = false;
}

function addStep(label, state) {
  const li = document.createElement('li');
  const icon = state === 'done' ? '✔' : state === 'err' ? '✖' : state === 'run' ? '⏳' : '•';
  li.className = state || '';
  li.innerHTML = `<span class="step-ico">${icon}</span><span>${esc(label)}</span>`;
  $('detail-steps').appendChild(li);
  $('detail-steps').scrollTop = $('detail-steps').scrollHeight;
}

// 一键安装按钮（安装最新版）
$('btn-detail-install').onclick = () => {
  const first = $('detail-ver-list').querySelector('li');
  if (!first) return alert('没有可用版本');
  first.click();
};

// ---------- 服务器 ----------
$('btn-srv-pick').onclick = async () => {
  const p = await window.api.pickDir();
  if (p) $('in-srv-dir').value = p;
};
$('btn-srv-quick').onclick = async () => {
  // 一键快速建服：自动应用推荐配置（Paper + 推荐内存），填好默认目录后直接创建
  const d = await window.api.serverQuickDefaults();
  if (d && d.ok) {
    $('sel-srv-type').value = d.type || 'paper';
    await loadServerVersions();
    if ($('in-srv-mem')) $('in-srv-mem').value = d.memory;
    if ($('in-srv-mem-range')) $('in-srv-mem-range').value = d.memory;
    if ($('srv-mem-label')) $('srv-mem-label').textContent = d.memory + ' MB';
  }
  if (!$('in-srv-dir').value.trim()) {
    const mc = ($('in-mcdir') && $('in-mcdir').value.trim()) || 'D:\\.minecraft';
    const base = mc.replace(/[\\/]versions.*$/, '').replace(/[\\/]\.minecraft$/, '');
    $('in-srv-dir').value = ($('in-mcdir') ? mc.split('\\').slice(0, -1).join('\\') : 'D:') + '\\mc-server';
  }
  $('srv-log').textContent += '\n===== ⚡ 一键快速建服（自动推荐配置）=====\n';
  $('btn-srv-create').click();
};

$('btn-srv-create').onclick = async () => {
  const opts = {
    dir: $('in-srv-dir').value.trim(),
    type: $('sel-srv-type').value,
    mcVersion: $('sel-srv-mcver').value,
    memory: $('in-srv-mem').value.trim(),
    gamemode: ($('sel-srv-gamemode') || {}).value || 'survival',
    difficulty: ($('sel-srv-difficulty') || {}).value || 'easy',
    maxPlayers: parseInt(($('in-srv-maxplayers') || {}).value || '20', 10) || 20,
    port: parseInt(($('in-srv-port') || {}).value || '25565', 10) || 25565,
    motd: ($('in-srv-motd') || {}).value || 'A Minecraft Server',
    onlineMode: $('chk-srv-online') ? $('chk-srv-online').checked : false,
    pvp: $('chk-srv-pvp') ? $('chk-srv-pvp').checked : true,
    commandBlock: $('chk-srv-commandblock') ? $('chk-srv-commandblock').checked : false,
    whitelist: $('chk-srv-whitelist') ? $('chk-srv-whitelist').checked : false,
    javaPath: $('in-java').value.trim()
  };
  if (!opts.dir || !opts.mcVersion) return alert('请填写服务器目录并选择 MC 版本');
  cfg.serverDir = opts.dir;
  await window.api.setConfig(cfg);
  const btn = $('btn-srv-create');
  btn.disabled = true;
  $('srv-log').textContent += `\n===== 创建服务器 (${opts.type} ${opts.mcVersion}) =====\n`;
  try {
    const r = await window.api.serverCreate(opts);
    if (!r || !r.ok) {
      $('srv-log').textContent += '\n✖ 创建失败：' + ((r && r.error) || '未知错误') + '\n';
    } else {
      $('srv-log').textContent += '\n✔ 创建完成！现在可以点「▶ 启动服务器」开服。\n';
    }
  } catch (e) {
    $('srv-log').textContent += '\n✖ 创建异常：' + (e.message || e) + '\n';
  } finally {
    btn.disabled = false;
    if ($('srv-progress')) $('srv-progress').style.width = '0%';
  }
};
$('btn-srv-start').onclick = async () => {
  const dir = $('in-srv-dir').value.trim();
  if (!dir) return alert('请先选择服务器目录');
  $('srv-log').textContent += '\n===== 启动服务器 =====\n';
  bindChat();
  // 记录主机名（用于聊天栏区分自己的消息）
  try { myHostName = ($('in-username') && $('in-username').value.trim()) || 'Host'; } catch {}
  const btn = $('btn-srv-start');
  btn.disabled = true;
  try {
    const r = await window.api.serverStart({
      dir,
      javaPath: $('in-java').value.trim(),
      memory: $('in-srv-mem').value.trim(),
      type: $('sel-srv-type').value
    });
    if (!r || !r.ok) {
      $('srv-log').textContent += '\n✖ 启动失败：' + ((r && r.error) || '未知错误') + '\n';
    } else {
      setTimeout(refreshOnline, 2000);
      setTimeout(refreshServerStatus, 500);
    }
  } catch (e) {
    $('srv-log').textContent += '\n✖ 启动异常：' + (e.message || e) + '\n';
  } finally {
    btn.disabled = false;
  }
};
$('btn-srv-stop').onclick = async () => {
  const r = await window.api.serverStop();
  if (r && !r.ok) $('srv-log').textContent += '\n停止失败：' + (r.error || '') + '\n';
  setTimeout(refreshServerStatus, 500);
};

// ---------- 内网穿透 ----------
if ($('btn-tun-dl')) $('btn-tun-dl').onclick = async () => {
  $('tun-log').textContent += '\n===== 下载 frp 客户端 =====\n';
  const r = await window.api.tunnelDownload();
  if (!r.ok) $('tun-log').textContent += '下载失败：' + r.error + '\n';
  else $('tun-log').textContent += '✔ 客户端就绪：' + r.exe + '\n';
};
if ($('btn-tun-start')) $('btn-tun-start').onclick = async () => {
  const addr = $('in-tun-addr').value.trim();
  if (!addr) return alert('请填写 frp 服务端地址');
  $('tun-log').textContent += '\n===== 启动隧道 =====\n';
  const r = await window.api.tunnelStart({
    serverAddr: addr,
    serverPort: parseInt($('in-tun-sport').value, 10) || 7000,
    localPort: parseInt($('in-tun-lport').value, 10) || 25565,
    remotePort: parseInt($('in-tun-rport').value, 10) || 25565,
    token: $('in-tun-token').value.trim()
  });
  if (!r.ok) $('tun-log').textContent += '启动失败：' + r.error + '\n';
  else $('tun-log').textContent += '✔ 隧道已启动，朋友可连：' + r.remote + '\n';
};
if ($('btn-tun-stop')) $('btn-tun-stop').onclick = async () => { await window.api.tunnelStop(); };
document.querySelectorAll('.tun-link').forEach((a) => {
  a.onclick = (e) => { e.preventDefault(); window.api.openPath(a.dataset.url); };
});

// ---------- 联机地址 ----------
async function refreshNetInfo() {
  const lan = $('net-lan'), pub = $('net-pub'), port = $('net-port'), on = $('net-online');
  if (!lan) return;
  lan.textContent = '检测中…'; pub.textContent = '检测中…';
  const dir = $('in-srv-dir').value.trim();
  const r = await window.api.serverInfo({ dir });
  if (!r || !r.ok) { lan.textContent = '获取失败'; pub.textContent = '获取失败'; return; }
  lan.textContent = r.lanAddr || '未检测到局域网 IP';
  lan.dataset.copy = r.lanAddr || '';
  pub.textContent = r.publicAddress || r.publicAddr || (r.public && r.public.ip ? r.public.ip : '获取失败');
  pub.dataset.copy = pub.textContent === '获取失败' ? '' : pub.textContent;
  port.textContent = r.port;
  on.textContent = r.onlineMode ? '开启（仅正版可进）' : '关闭（离线可进）';
  on.className = r.onlineMode ? 'ok' : 'off';
  const tip = $('net-tip');
  if (tip) {
    if (!r.lanAddr) tip.textContent = '未检测到局域网 IP，请检查网络连接。';
    else tip.innerHTML = `同一局域网：把 <strong>${esc(r.lanAddr)}</strong> 发给朋友，他在多人游戏里「添加服务器」粘贴即可。公网联机：把 <strong>${esc((r.public && r.public.ip) ? r.public.ip + ':' + r.port : '公网IP:端口')}</strong> 发给朋友，并确保已在路由器做端口映射（或使用内网穿透）。`;
  }
}
async function copyText(t, btn) {
  if (!t) return;
  try { await navigator.clipboard.writeText(t); } catch {}
  if (btn) { const o = btn.textContent; btn.textContent = '已复制'; setTimeout(() => { btn.textContent = o; }, 1200); }
}
if ($('btn-net-refresh')) $('btn-net-refresh').onclick = refreshNetInfo;
if ($('btn-toggle-online')) $('btn-toggle-online').onclick = async () => {
  const dir = $('in-srv-dir').value.trim();
  if (!dir) return alert('请先填写服务器目录');
  const info = await window.api.serverInfo({ dir });
  if (!info || !info.ok) return alert('读取服务器信息失败：' + ((info && info.error) || '未知错误'));
  const next = !info.onlineMode; // 取反
  const r = await window.api.serverUpdateProps({ dir, updates: { 'online-mode': next ? 'true' : 'false' } });
  if (!r || !r.ok) return alert('修改失败：' + ((r && r.error) || '未知错误'));
  await refreshNetInfo();
  const tip = $('net-tip');
  if (tip) tip.textContent = next
    ? '已开启正版验证：仅正版账号可进入，离线账号会报“无效会话”。重启服务器后生效。'
    : '已关闭正版验证：离线账号也可以进入。重启服务器后生效。';
};
if ($('btn-copy-lan')) $('btn-copy-lan').onclick = () => copyText($('net-lan').dataset.copy || $('net-lan').textContent, $('btn-copy-lan'));
if ($('btn-copy-pub')) $('btn-copy-pub').onclick = () => copyText($('net-pub').dataset.copy || $('net-pub').textContent, $('btn-copy-pub'));

// ---------- 服务器存档备份 ----------
function fmtTime(ms) {
  if (!ms) return '—';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
async function refreshServerBackup() {
  const box = $('srvw-list');
  if (!box) return;
  const info = await window.api.serverWorldInfo();
  if (info && info.ok && info.info) {
    const i = info.info;
    $('srvw-name').textContent = i.worldName || 'world';
    const partsTxt = (i.parts && i.parts.length > 1) ? '（' + i.parts.length + ' 个维度）' : '';
    $('srvw-size').textContent = '存档大小：' + (i.exists ? i.sizeText + partsTxt : '未生成');
    $('srvw-count').textContent = '备份数量：' + (i.backups || 0);
    $('srvw-mtime').textContent = '最后修改：' + (i.exists ? fmtTime(i.mtime) : '—');
  }
  const r = await window.api.serverWorldBackups();
  const list = (r && r.ok ? r.list : []) || [];
  if (!list.length) {
    box.innerHTML = '<div class="srvw-empty">还没有备份。点「💾 立即备份存档」创建第一个备份。</div>';
    return;
  }
  box.innerHTML = list.map((b) => `
    <div class="srvw-row">
      <div class="srvw-main">
        <div class="srvw-title">🗺 ${esc(b.world || 'world')} · ${fmtTime(b.ts || b.mtime)}</div>
        <div class="srvw-sub">${esc(b.sizeText || '')}${b.note ? ' · ' + esc(b.note) : ''}</div>
      </div>
      <button class="btn mini" data-act="restore" data-file="${esc(b.file)}">恢复</button>
      <button class="btn mini ghost" data-act="del" data-file="${esc(b.file)}">删除</button>
    </div>`).join('');
  box.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.onclick = async () => {
      const file = btn.dataset.file;
      if (btn.dataset.act === 'restore') {
        if (!confirm('恢复后当前存档会被覆盖（已自动先备份一份）。建议先停止服务器。\n确定恢复这个备份？')) return;
        const rr = await window.api.serverWorldRestore({ file });
        if (!rr || !rr.ok) return alert('恢复失败：' + ((rr && rr.error) || '未知错误'));
        alert('已恢复存档。重启服务器后生效。');
      } else {
        if (!confirm('确定删除这个备份？不可恢复。')) return;
        const rr = await window.api.serverWorldBackupDelete({ file });
        if (!rr || !rr.ok) return alert('删除失败：' + ((rr && rr.error) || '未知错误'));
      }
      refreshServerBackup();
    };
  });
}
if ($('btn-srvw-backup')) $('btn-srvw-backup').onclick = async () => {
  const btn = $('btn-srvw-backup');
  const o = btn.textContent; btn.textContent = '备份中…'; btn.disabled = true;
  const st = await window.api.serverStatus();
  if (st && st.running && !confirm('服务器正在运行，存档可能写入一半导致备份不完整。\n建议先停止服务器。仍要继续备份吗？')) {
    btn.textContent = o; btn.disabled = false; return;
  }
  const r = await window.api.serverWorldBackup({ note: '手动备份' });
  btn.textContent = o; btn.disabled = false;
  if (!r || !r.ok) return alert('备份失败：' + ((r && r.error) || '未知错误'));
  alert('备份完成：' + (r.sizeText || ''));
  refreshServerBackup();
};
if ($('btn-srvw-refresh')) $('btn-srvw-refresh').onclick = refreshServerBackup;
if ($('btn-srvw-open')) $('btn-srvw-open').onclick = () => window.api.serverWorldOpen();

// ---------- 服务器：自动存档 ----------
async function loadAutoBackup() {
  if (!$('chk-auto-backup')) return;
  const r = await window.api.serverAutoBackupGet();
  if (r && r.ok) {
    $('chk-auto-backup').checked = !!r.enabled;
    $('in-auto-backup-interval').value = r.intervalMin;
    $('in-auto-backup-keep').value = r.keep;
  }
}
if ($('btn-auto-backup-save')) $('btn-auto-backup-save').onclick = async () => {
  const r = await window.api.serverAutoBackupSet({
    enabled: $('chk-auto-backup').checked,
    intervalMin: parseInt($('in-auto-backup-interval').value, 10),
    keep: parseInt($('in-auto-backup-keep').value, 10)
  });
  if (!r || !r.ok) return alert('保存失败：' + ((r && r.error) || '未知错误'));
  const hint = $('auto-backup-hint');
  if (hint) hint.textContent = r.enabled
    ? `已开启：每 ${r.intervalMin} 分钟自动备份一次，保留最近 ${r.keep} 份。`
    : '已关闭自动存档。';
  alert(r.enabled ? `自动存档已开启（每 ${r.intervalMin} 分钟，保留 ${r.keep} 份）` : '自动存档已关闭');
};
if ($('btn-auto-backup-now')) $('btn-auto-backup-now').onclick = async () => {
  const btn = $('btn-auto-backup-now');
  const o = btn.textContent; btn.textContent = '备份中…'; btn.disabled = true;
  const r = await window.api.serverAutoBackupRunNow();
  btn.textContent = o; btn.disabled = false;
  if (!r || !r.ok) return alert('备份失败：' + ((r && r.error) || '未知错误'));
  alert('已备份：' + (r.sizeText || ''));
  refreshServerBackup();
};

// ---------- 服务器：自动更新 ----------
async function checkServerUpdateUI(auto) {
  if (!$('btn-srvu-check')) return;
  const btn = $('btn-srvu-check');
  const o = btn.textContent; btn.textContent = '检查中…'; btn.disabled = true;
  const r = await window.api.serverUpdateCheck();
  btn.textContent = o; btn.disabled = false;
  if (!r || !r.ok) {
    if (!auto) alert('检查失败：' + ((r && r.error) || '未知错误'));
    return;
  }
  $('srvu-type').textContent = '类型：' + (r.type || '未知');
  $('srvu-current').textContent = '当前：' + (r.current || '—');
  $('srvu-latest').textContent = '最新：' + (r.latest || '—');
  const note = $('srvu-note');
  if (note) note.textContent = r.note || '';
  const apply = $('btn-srvu-apply');
  if (apply) { apply.disabled = !(r.canUpdate && r.hasUpdate); }
  if (auto && r.canUpdate && r.hasUpdate) {
    try { window.__srvUpdNotified || (window.__srvUpdNotified = false); } catch {}
  }
}
if ($('btn-srvu-check')) $('btn-srvu-check').onclick = () => checkServerUpdateUI(false);
if ($('btn-srvu-apply')) $('btn-srvu-apply').onclick = async () => {
  const st = await window.api.serverStatus();
  if (st && st.running) return alert('请先停止服务器，再执行更新。');
  if (!confirm('即将下载最新服务端并替换当前 server.jar（旧文件会自动备份）。\n更新后需重新启动服务器。确定继续？')) return;
  const btn = $('btn-srvu-apply');
  const o = btn.textContent; btn.textContent = '更新中…'; btn.disabled = true;
  const r = await window.api.serverUpdateApply();
  btn.textContent = o; btn.disabled = false;
  if (!r || !r.ok) return alert('更新失败：' + ((r && r.error) || '未知错误'));
  alert('已更新到最新版！重启服务器后生效。');
  checkServerUpdateUI(false);
};
$('btn-srv-open').onclick = () => window.api.openPath($('in-srv-dir').value.trim());
$('btn-srv-cmd').onclick = async () => {
  const c = $('in-srv-cmd').value.trim();
  if (!c) return;
  await window.api.serverCmd(c);
  $('in-srv-cmd').value = '';
};

// ---------- 服务器：玩家管理（给/撤管理员权限等） ----------
const SRV_PLAYER_RE = /^[A-Za-z0-9_]{1,16}$/;
function srvPlayerName() {
  const el = $('in-srv-player');
  const name = el ? el.value.trim() : '';
  if (!name) { alert('请先输入玩家名（游戏内 ID）'); return null; }
  if (!SRV_PLAYER_RE.test(name)) { alert('玩家名只能包含字母、数字、下划线，长度 1-16（区分大小写）。'); return null; }
  return name;
}
async function srvRunPlayerCmd(maker, verb, confirmMsg) {
  const name = srvPlayerName();
  if (!name) return;
  if (confirmMsg && !confirm(confirmMsg.replace('%s', name))) return;
  await window.api.serverCmd(maker(name));
}
if ($('btn-srv-op')) $('btn-srv-op').onclick = () => srvRunPlayerCmd((n) => 'op ' + n, '给管理员', '确认把 %s 设为管理员（OP）？他将拥有全部权限。');
if ($('btn-srv-deop')) $('btn-srv-deop').onclick = () => srvRunPlayerCmd((n) => 'deop ' + n, '撤销管理员');
if ($('btn-srv-kick')) $('btn-srv-kick').onclick = () => srvRunPlayerCmd((n) => 'kick ' + n, '踢出', '确认把 %s 踢出服务器？');
if ($('btn-srv-ban')) $('btn-srv-ban').onclick = () => srvRunPlayerCmd((n) => 'ban ' + n, '封禁', '确认永久封禁 %s？他已无法再进入服务器。');

// ---------- 服务器：常用指令快捷键 ----------
(function () {
  const wrap = $('quick-cmds');
  if (!wrap) return;
  wrap.addEventListener('click', async (e) => {
    const btn = e.target.closest('.qcmd');
    if (!btn) return;
    const cmd = btn.getAttribute('data-cmd');
    if (!cmd) return;
    btn.disabled = true;
    const old = btn.textContent;
    try {
      await window.api.serverCmd(cmd);
      btn.textContent = '✓ 已发送';
    } catch (err) {
      btn.textContent = '✗ 失败';
    }
    setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 900);
  });
})();

$('btn-launch').onclick = async () => {
  if (!selectedVersion) {
    alert('请先在「版本选择」里选一个版本');
    return;
  }
  cfg.username = $('in-username').value.trim() || 'Steve';
  cfg.mcDir = $('in-mcdir').value.trim();
  cfg.javaPath = $('in-java').value.trim();
  cfg.maxMemory = $('in-mem').value.trim();
  cfg.version = selectedVersion;
  await window.api.setConfig(cfg);

  const btn = $('btn-launch');
  btn.disabled = true;
  btn.textContent = '启动中…';
  $('progress-wrap').classList.add('show');
  $('progress-inner').style.width = '0%';
  $('progress-text').textContent = '准备启动…';
  log('data', `==== 开始启动 ${selectedVersion} ====`);

  // 已登录正版时，启动前尝试静默续期令牌（令牌有效期短，过期会进不了服务器）
  if (msLoggedIn) {
    try {
      const acct = await window.api.account();
      if (acct && acct.obtainedAt && Date.now() - acct.obtainedAt > 20 * 60 * 60 * 1000) {
        log('data', '登录令牌较旧，正在静默续期…');
        const rr = await window.api.msRefresh({});
        if (!rr.ok) log('data', '令牌续期失败（' + rr.error + '），将用旧令牌启动；若无法进入正版服务器请重新登录');
      }
    } catch {}
  }

  const res = await window.api.launch({
    version: selectedVersion,
    username: cfg.username,
    maxMemory: cfg.maxMemory,
    javaPath: cfg.javaPath,
    jvmArgs: (cfg.jvmArgs || '')
  });
  if (!res.ok) {
    log('data', '启动失败：' + res.error);
    $('progress-text').textContent = '启动失败：' + res.error;
    btn.disabled = false;
    btn.textContent = '▶ 启动游戏';
  } else {
    log('data', '启动命令已发出，游戏进程运行中…');
    markVersionUsed(selectedVersion);
    // 启动成功后自动最小化启动器（可在设置里关闭）
    if (cfg.minimizeOnLaunch !== false) {
      try { window.api.minimizeWin(); } catch {}
    }
  }
};

// ---------- 服务器聊天栏 + 在线玩家 ----------
let chatBound = false;
let myHostName = 'Host';

function chatAppend(html) {
  const box = $('chat-log');
  if (!box) return;
  const hint = box.querySelector('.chat-hint');
  if (hint) hint.remove();
  const div = document.createElement('div');
  div.innerHTML = html;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  // 限制最多 400 条
  while (box.children.length > 400) box.removeChild(box.firstChild);
}

function chatRenderOnline(o) {
  const n = $('chat-online-n');
  const badge = $('chat-online');
  const wrap = $('chat-players');
  if (n) n.textContent = (o && o.count) || 0;
  if (badge) badge.classList.toggle('off', !(o && o.running));
  if (!wrap) return;
  const players = (o && o.players) || [];
  wrap.innerHTML = players.length
    ? players.map((p) => `<span class="chat-player">${esc(p)}</span>`).join('')
    : '<span class="chat-empty">暂无玩家在线</span>';
}

// 把聊天监听全局绑定（init 时调用），不依赖是否切到服务器页
function ensureChatGlobals() {
  if (ensureChatGlobals._done) return;
  ensureChatGlobals._done = true;
  if (window.api.onServerChat) {
    window.api.onServerChat((ev) => {
      if (!ev) return;
      if (ev.type === 'chat') {
        const mine = ev.name === myHostName;
        chatAppend(`<div class="chat-msg chat${mine ? ' mine' : ''}"><span class="cm-name">${esc(ev.name)}:</span><span class="cm-text">${esc(ev.text)}</span></div>`);
      } else if (ev.type === 'join') {
        chatAppend(`<div class="chat-sys join">✦ ${esc(ev.name)} 加入了游戏</div>`);
      } else if (ev.type === 'leave') {
        chatAppend(`<div class="chat-sys leave">✦ ${esc(ev.name)} 离开了游戏</div>`);
      } else if (ev.type === 'death') {
        chatAppend(`<div class="chat-sys death">☠ ${esc(ev.text)}</div>`);
      } else if (ev.type === 'system' && ev.text) {
        chatAppend(`<div class="chat-sys">${esc(ev.text)}</div>`);
      }
    });
  }
  if (window.api.onServerOnline) {
    window.api.onServerOnline((o) => chatRenderOnline(o));
  }
  if (window.api.onServerAutoBackup) {
    window.api.onServerAutoBackup((d) => {
      if (!d || !d.ok) return;
      try { refreshServerBackup(); } catch {}
      const hint = document.getElementById('auto-backup-hint');
      if (hint) hint.textContent = '上次自动存档：' + new Date(d.at || Date.now()).toLocaleTimeString() + ' · ' + (d.sizeText || '');
    });
  }
}

function bindChat() {
  ensureChatGlobals();
  if (chatBound) return;
  chatBound = true;
  const send = async () => {
    const inp = $('in-chat-msg');
    const text = (inp.value || '').trim();
    if (!text) return;
    const r = await window.api.serverSay({ text, name: myHostName });
    if (r && r.ok) {
      chatAppend(`<div class="chat-msg chat mine"><span class="cm-name">${esc(myHostName)}:</span><span class="cm-text">${esc(text)}</span></div>`);
      inp.value = '';
    } else {
      chatAppend(`<div class="chat-sys">发送失败：${esc((r && r.error) || '服务器未运行')}</div>`);
    }
  };
  if ($('btn-chat-send')) $('btn-chat-send').onclick = send;
  if ($('in-chat-msg')) $('in-chat-msg').onkeydown = (e) => { if (e.key === 'Enter') send(); };
}

// 切到服务器页时刷新在线状态
async function refreshOnline() {
  try {
    const r = await window.api.serverOnline();
    if (r && r.ok) chatRenderOnline({ count: r.online.count, players: r.online.players, running: r.running });
  } catch {}
  refreshServerStatus();
}

// 刷新顶部状态条
async function refreshServerStatus() {
  const dot = $('srv-dot');
  const txt = $('srv-status-text');
  const sub = $('srv-status-sub');
  const chipOnline = $('srv-status-online');
  const chipAddr = $('srv-chip-addr');
  if (!txt) return;
  let st = { running: false, state: 'stopped', uptime: 0 };
  try { st = await window.api.serverStatus(); } catch {}
  let online = 0;
  try { const o = await window.api.serverOnline(); if (o && o.ok) online = o.online.count; } catch {}
  if (chipOnline) chipOnline.textContent = online;
  const running = st && st.running;
  if (dot) dot.className = 'srv-dot' + (running ? ' on' : '');
  if (running) {
    txt.textContent = '运行中';
    const up = st.uptime ? '已运行 ' + Math.floor(st.uptime / 60) + ' 分 ' + (st.uptime % 60) + ' 秒' : '';
    if (sub) sub.textContent = up + (st.dir ? '　' + st.dir : '');
  } else {
    txt.textContent = '已停止';
    if (sub) sub.textContent = '点「▶ 启动服务器」开服；首次启动需生成世界，稍等片刻';
  }
  // 地址 chip
  if (chipAddr) {
    try {
      const dir = ($('in-srv-dir') || {}).value ? $('in-srv-dir').value.trim() : '';
      const info = await window.api.serverInfo({ dir });
      chipAddr.textContent = info && info.lanAddr ? info.lanAddr : '—';
    } catch { chipAddr.textContent = '—'; }
  }
}

// ---------- 一键邀请 ----------
let lastInvite = '';
let lastAddr = '';
async function genInvite() {
  const dir = ($('in-srv-dir') || {}).value ? $('in-srv-dir').value.trim() : '';
  const r = await window.api.serverInfo({ dir });
  const cfg = await window.api.getConfig();
  const motd = (r && r.motd) || 'Minecraft Server';
  const port = (r && r.port) || 25565;
  const lan = (r && r.lanAddr) || '';
  const pub = (r && r.publicAddr) || '';
  lastAddr = lan || pub || '';
  const lines = [];
  lines.push(`【${motd}】邀请你一起玩 Minecraft！`);
  if (lan) lines.push(`同一局域网：${lan}`);
  if (pub) lines.push(`远程联机：${pub}`);
  if (!lan && !pub) lines.push('（未检测到可用地址，请先启动服务器并检查网络）');
  lines.push('进服方法：游戏里「多人游戏 → 添加服务器」粘贴地址即可。');
  lastInvite = lines.join('\n');
  const ta = $('invite-text');
  if (ta) ta.value = lastInvite;
  return lastInvite;
}

if ($('btn-invite-gen')) $('btn-invite-gen').onclick = () => genInvite();
if ($('btn-copy-invite')) $('btn-copy-invite').onclick = async (e) => {
  const t = lastInvite || (await genInvite());
  await copyText(t, e.target);
};
if ($('btn-copy-addr')) $('btn-copy-addr').onclick = async (e) => {
  const t = lastAddr || (await genInvite(), lastAddr);
  await copyText(t, e.target);
};

// 切到服务器页：刷新在线名单（聊天监听已在 init 全局绑定）
document.querySelectorAll('.nav-item[data-page="server"]').forEach((b) => {
  b.addEventListener('click', () => {
    bindChat();
    refreshOnline();
    // 若服务器在运行，顺便让服务端回吐一次 list（拿到准确人数/名单）
    if (window.api.serverRefreshOnline) window.api.serverRefreshOnline().catch(() => {});
  });
});

// 在线名单定时轮询（仅在服务器页可见时）
setInterval(() => {
  const page = document.getElementById('page-server');
  if (page && page.classList.contains('active') && window.api.serverOnline) refreshOnline();
}, 5000);

init();
