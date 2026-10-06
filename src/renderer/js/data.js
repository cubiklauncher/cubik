// 数据：存档与备份页
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

