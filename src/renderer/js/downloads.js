// 下载中心：统一任务队列（查看 / 重试 / 取消 / 清理）
// 依赖：core.js 提供的 $、esc、log、goPage（全局函数）
// 说明：本模块只做「前端任务簿记」——收集各下载/安装流程的进度事件，
// 汇总成一个可回溯的列表；真正的下载逻辑仍在各业务模块里（不重复实现）。

// 任务模型：{ id, label, kind, phase: 'wait'|'run'|'done'|'err'|'cancel',
//            pct, done, total, error, startedAt, endedAt, retry }
const dlTasks = [];
let dlSeq = 0;
let dlPanelBuilt = false;

// 当前「活跃」任务（同一时刻一般是 1 个：主下载/安装流程是串行的）
let dlActiveId = null;

function dlNow() { return Date.now(); }

function dlFmtDur(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  return m + ' 分 ' + (s % 60) + ' 秒';
}

function dlFmtSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + ' ' + u[i];
}

// 开始一个任务（由业务模块在发起下载时调用）
function dlStart(label, kind, retryFn) {
  const id = ++dlSeq;
  const t = {
    id, label: label || '下载任务', kind: kind || 'download',
    phase: 'run', pct: 0, done: 0, total: 0,
    startedAt: dlNow(), endedAt: 0, error: '', retry: retryFn || null
  };
  dlTasks.unshift(t);
  dlActiveId = id;
  dlRender();
  dlBadge();
  return id;
}

// 更新任务进度
function dlUpdate(id, p) {
  const t = dlTasks.find((x) => x.id === id);
  if (!t) return;
  if (p && p.label) t.label = p.label;
  if (p && p.pct != null) t.pct = p.pct;
  if (p && p.done != null) t.done = p.done;
  if (p && p.total != null) t.total = p.total;
  dlRender();
}

// 结束任务（成功或失败）
function dlFinish(id, d) {
  const t = dlTasks.find((x) => x.id === id);
  if (!t) return;
  const ok = !d || d.ok !== false;
  t.phase = ok ? 'done' : 'err';
  t.pct = ok ? 100 : t.pct;
  t.error = (d && d.error) || '';
  t.endedAt = dlNow();
  if (dlActiveId === id) dlActiveId = null;
  dlRender();
  dlBadge();
}

// 手动取消（仅从列表移除；真实下载由上游看门狗/流程自行结束）
function dlCancel(id) {
  const t = dlTasks.find((x) => x.id === id);
  if (!t) return;
  if (t.phase === 'run') { t.phase = 'cancel'; t.endedAt = dlNow(); }
  if (dlActiveId === id) dlActiveId = null;
  dlRender();
  dlBadge();
}

// 重试失败任务
function dlRetry(id) {
  const t = dlTasks.find((x) => x.id === id);
  if (!t || !t.retry) return;
  t.phase = 'run'; t.pct = 0; t.done = 0; t.total = 0; t.error = '';
  t.startedAt = dlNow(); t.endedAt = 0;
  dlActiveId = id;
  dlRender();
  try { t.retry(); } catch (e) { dlFinish(id, { ok: false, error: e.message }); }
}

// 清理已完成/已取消的任务
function dlClearFinished() {
  for (let i = dlTasks.length - 1; i >= 0; i--) {
    const p = dlTasks[i].phase;
    if (p === 'done' || p === 'err' || p === 'cancel') dlTasks.splice(i, 1);
  }
  dlRender();
  dlBadge();
}

function dlBadge() {
  const n = dlTasks.filter((t) => t.phase === 'run').length;
  const el = $('nav-dl-badge');
  if (el) { el.textContent = n ? String(n) : ''; el.style.display = n ? '' : 'none'; }
}

function dlSummary() {
  const run = dlTasks.filter((t) => t.phase === 'run').length;
  const err = dlTasks.filter((t) => t.phase === 'err').length;
  const done = dlTasks.filter((t) => t.phase === 'done').length;
  const parts = [];
  if (run) parts.push('进行中 ' + run);
  if (done) parts.push('已完成 ' + done);
  if (err) parts.push('失败 ' + err);
  return parts.join(' · ') || '暂无任务';
}

function dlRender() {
  const list = $('dl-task-list');
  if (!list) return;
  const sum = $('dl-summary');
  if (sum) sum.textContent = dlSummary();
  if (!dlTasks.length) {
    list.innerHTML = '<li class="empty">暂无下载任务。发起下载 / 安装后，任务会出现在这里。</li>';
    return;
  }
  const phaseText = { run: '进行中', done: '已完成', err: '失败', cancel: '已取消', wait: '排队中' };
  const frag = document.createDocumentFragment();
  dlTasks.forEach((t) => {
    const li = document.createElement('li');
    li.className = 'dl-task ' + t.phase;
    const dur = t.endedAt ? dlFmtDur(t.endedAt - t.startedAt) : (t.phase === 'run' ? dlFmtDur(dlNow() - t.startedAt) : '');
    const sizeInfo = t.total ? ` (${t.done || 0}/${t.total})` : '';
    const canRetry = t.phase === 'err' && t.retry;
    li.innerHTML =
      `<div class="dl-task-top">` +
        `<span class="dl-task-label" title="${esc(t.label)}">${esc(t.label)}</span>` +
        `<span class="dl-task-phase">${phaseText[t.phase] || t.phase}${dur ? ' · ' + dur : ''}</span>` +
      `</div>` +
      `<div class="dl-task-bar"><div class="dl-task-inner" style="width:${t.phase === 'done' ? 100 : (t.pct || 0)}%"></div></div>` +
      `<div class="dl-task-foot">` +
        `<span class="dl-task-pct">${t.phase === 'done' ? '100%' : (t.pct || 0) + '%'}${sizeInfo}</span>` +
        `<span class="dl-task-ops">` +
          (canRetry ? `<button class="dl-op" data-dl-retry="${t.id}">重试</button>` : '') +
          (t.phase === 'run' ? `<button class="dl-op" data-dl-cancel="${t.id}">取消</button>` : '') +
        `</span>` +
      `</div>` +
      (t.error ? `<div class="dl-task-err">${esc(t.error)}</div>` : '');
    frag.appendChild(li);
  });
  list.innerHTML = '';
  list.appendChild(frag);
  // 事件委托
  list.querySelectorAll('[data-dl-retry]').forEach((b) => {
    b.onclick = () => dlRetry(Number(b.dataset.dlRetry));
  });
  list.querySelectorAll('[data-dl-cancel]').forEach((b) => {
    b.onclick = () => dlCancel(Number(b.dataset.dlCancel));
  });
}

function buildDownloadCenterUI() {
  if (dlPanelBuilt) return;
  dlPanelBuilt = true;
  // 侧边栏入口已在 HTML 中静态声明（data-page="downloads"），无需动态注入
  if ($('dl-clear')) $('dl-clear').onclick = () => dlClearFinished();
  dlRender();
  dlBadge();
}

// 由各业务模块的进度回调间接驱动：
// 当没有显式登记的任务时，用首个进度事件自动建一个任务（无需改动每个业务模块）
function dlHookInstallProgress(p) {
  if (dlActiveId == null) {
    if (p && (p.total || p.pct != null || p.label)) dlStart(p.label || '下载任务', 'download');
    else return;
  }
  dlUpdate(dlActiveId, p);
}
function dlHookInstallDone(d) {
  if (dlActiveId == null) return;
  dlFinish(dlActiveId, d);
}
