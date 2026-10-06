// Mod：下载 Mod / 管理版本 / 回收站 / 独立 Mod 下载页 / MC百科卡片
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
  if (source === 'mcmod') {
    if (!query) {
      // 无关键词：显示 MC百科热门 Mod（带封面）
      list.innerHTML = '<div class="empty">加载热门…</div>';
      const r = await window.api.mcmodHot({ kind: 'mod', limit: 30 });
      if (!r.ok) { list.innerHTML = `<div class="empty">加载失败：${esc(r.error)}
</div>`; $('mod-store-filter').textContent = ''; return; }
      if (!r.list.length) list.innerHTML = '<div class="empty">暂时取不到热门列表，可直接在上方输入关键词搜索</div>';
      else renderMcmodCards(list, r.list, (p) => openMcmodDetail(p));
      $('mod-store-filter').textContent = '来源：MC百科 · 🔥 热门 Mod（按下载量，输入关键词可搜索）';
      return;
    }
    const r = await window.api.mcmodSearch({ query, kind: 'mod' });
    if (!r.ok) { list.innerHTML = `<div class="empty">搜索失败：${esc(r.error)}</div>`; $('mod-store-filter').textContent = ''; return; }
    if (!r.list.length) list.innerHTML = '<div class="empty">MC百科未找到结果</div>';
    else renderMcmodCards(list, r.list, (p) => openMcmodDetail(p));
    $('mod-store-filter').textContent = '来源：MC百科（中文搜索，点开看前置 Mod）';
    return;
  }
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
  // MC百科（mcmod）中文搜索源
  if (source === 'mcmod') {
    if (!query) {
      const r = await window.api.mcmodHot({ kind: 'mod', limit: 30 });
      if (!r.ok) { grid.innerHTML = `<div class="empty">加载失败：${esc(r.error)}</div>`; return; }
      $('mod-list-title').textContent = '🔥 MC百科 热门 Mod（按下载量）';
      if (!r.list.length) { grid.innerHTML = '<div class="empty">暂时取不到热门列表，可直接在上方输入中文名搜索</div>'; return; }
      renderMcmodCards(grid, r.list, (p) => openMcmodDetail(p));
      return;
    }
    const r = await window.api.mcmodSearch({ query, kind: 'mod' });
    if (!r.ok) { grid.innerHTML = `<div class="empty">搜索失败：${esc(r.error)}</div>`; return; }
    $('mod-list-title').textContent = `🔍 MC百科搜索结果：${query}`;
    if (!r.list.length) { grid.innerHTML = '<div class="empty">MC百科未找到结果（试试更完整的中文名）</div>'; return; }
    renderMcmodCards(grid, r.list, (p) => openMcmodDetail(p));
    return;
  }
  const params = { source, query };
  if (target) params.version = target;
  else if (mcSel) { params.mc = mcSel; if (localVersions.length) params.loader = ''; }
  const r = await window.api.modSearch(params);
  if (!r.ok) { grid.innerHTML = `<div class="empty">搜索失败：${esc(r.error)}</div>`; return; }
  $('mod-list-title').textContent = query ? `🔍 搜索结果：${query}` : '🔥 热门 Mod（按下载量）';
  if (!r.list.length) { grid.innerHTML = '<div class="empty">未找到结果</div>'; return; }
  renderCards(grid, r.list, (p) => openDetail('mod', p));
}

// 渲染 MC百科 结果卡片（显示中文名/英文名/简介，点开看前置 Mod）
function renderMcmodCards(container, list, onPick) {
  container.innerHTML = '';
  if (!list.length) { container.innerHTML = '<div class="empty">未找到结果</div>'; return; }
  list.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'pack-card';
    const enHtml = p.enName ? `<span class="pk-zh" style="background:rgba(120,150,220,.12);color:var(--text-soft)">${esc(p.enName)}</span>` : '';
    const iconHtml = p.icon
      ? `<div class="pk-icon"><img src="${esc(p.icon)}" referrerpolicy="no-referrer" onerror="this.style.display='none';this.parentNode.classList.add('pk-icon-fallback')"></div>`
      : '<div class="pk-icon pk-icon-fallback"></div>';
    card.innerHTML = `
      ${iconHtml}
      <div class="pk-body">
        <div class="pk-title">${esc(p.title)}
          ${p.zhName && p.zhName !== p.title ? `<span class="pk-zh">${esc(p.zhName)}</span>` : ''}${enHtml}
        </div>
        <div class="pk-desc">${esc(p.description || '')}</div>
        <div class="pk-meta">
          <span class="pk-tag">📚 MC百科</span>
          <span class="pk-tag">${p.kind === 'modpack' ? '整合包' : 'Mod'}</span>
          ${(p.categories || []).slice(0, 2).map((c) => `<span class="pk-tag">${esc(c)}</span>`).join('')}
        </div>
      </div>`;
    card.onclick = () => onPick(p);
    container.appendChild(card);
  });
}

// MC百科 详情：展示条目信息 + 前置 Mod（依赖），可跳转百科下载
async function openMcmodDetail(pack) {
  detailCtx = { kind: 'mcmod', pack };
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
  document.querySelectorAll('.page').forEach((pg) => pg.classList.remove('active'));
  $('page-detail').classList.add('active');
  document.querySelector('.content').scrollTop = 0;

  $('detail-icon').src = '';
  $('detail-title').textContent = pack.title + (pack.zhName && pack.zhName !== pack.title ? '（' + pack.zhName + '）' : '');
  $('detail-meta').innerHTML =
    `<span class="tg">📚 MC百科</span>` +
    `<span class="tg">${pack.kind === 'modpack' ? '整合包' : 'Mod'}</span>` +
    (pack.enName ? `<span class="tg">${esc(pack.enName)}</span>` : '') +
    (pack.shortName ? `<span class="tg">简称：${esc(pack.shortName)}</span>` : '');
  $('detail-desc').textContent = pack.description || '';
  $('detail-mod-target-row').style.display = 'none';
  $('btn-detail-install').textContent = '🌐 打开 MC百科页面（下载）';
  $('detail-progress-card').style.display = 'none';
  $('detail-steps').innerHTML = '';

  // 前置 Mod 面板
  const ul = $('detail-ver-list');
  $('detail-ver-title').textContent = '前置 Mod（装本 Mod 之前请先装）';
  ul.innerHTML = '<li class="empty">加载前置信息中…</li>';
  const r = await window.api.mcmodPrereqs({ id: pack.id, kind: pack.kind });
  if (!r || !r.ok) { ul.innerHTML = `<li class="empty">读取失败：${esc((r && r.error) || '')}</li>`; return; }
  const prereqs = r.prereqs || [];
  const dependents = r.dependents || [];
  let html = '';
  if (prereqs.length) {
    html += prereqs.map((q) => `<li><div class="ver-left"><div class="ver-name">🧩 ${esc(q.name)}</div><div class="ver-tags">${q.scope ? `<span class="tg">${esc(q.scope)}</span>` : ''}<span class="tg">前置 Mod</span></div></div><div class="ver-right"><button class="btn mini" data-open="${esc(q.url)}">查看</button></div></li>`).join('');
  } else {
    html += '<li class="empty">✅ 无前置 Mod（可直接安装）</li>';
  }
  if (dependents.length) {
    html += `<li class="empty" style="text-align:left;padding:8px 4px">↓ 另有 ${dependents.length} 个 Mod 依赖它（如 ${esc(dependents.slice(0, 3).map((d) => d.name).join('、'))}…）</li>`;
  }
  ul.innerHTML = html;
  ul.querySelectorAll('button[data-open]').forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); window.api.openPath(b.dataset.open); };
  });
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

