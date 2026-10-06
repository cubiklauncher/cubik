// 整合包：整合包 / 光影 / 资源包 / 独立详情页 / 前置 Mod
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

  // Mod 需要指定“安装到版本”；资源包同样可指定实例目录（不选则装到全局 .minecraft）
  const targetRow = $('detail-mod-target-row');
  if (isMod) {
    targetRow.style.display = 'flex';
    $('detail-target-label').textContent = '安装到版本:';
    await fillDetailTargets(pack);
    $('btn-detail-install').textContent = '⬇ 下载此 Mod';
  } else if (isRpack) {
    targetRow.style.display = 'flex';
    $('detail-target-label').textContent = '安装到实例（可选）:';
    await fillDetailTargets(pack, true);
    $('btn-detail-install').textContent = '⬇ 一键安装资源包';
  } else {
    targetRow.style.display = 'none';
    $('btn-detail-install').textContent = kind === 'shader' ? '⬇ 一键安装光影包' : '⬇ 一键安装整合包';
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
  // Mod：立刻展示第一个兼容版本的前置（下载前就能看到）
  if (isMod && res.list && res.list.length) {
    try { await showModDeps(res.list[0], pack, $('sel-detail-target') && $('sel-detail-target').value); } catch {}
  } else if (!isMod) {
    const dt = $('detail-deps-title'), dl = $('detail-deps-list');
    if (dt) dt.style.display = 'none';
    if (dl) dl.style.display = 'none';
  }
}

// 填充 Mod 详情页的“安装到版本”下拉；opt 为 true 时首项为“全局 .minecraft（所有实例可用）”
async function fillDetailTargets(pack, opt) {
  const sel = $('sel-detail-target');
  const list = await window.api.listVersions();
  sel.innerHTML = '';
  if (opt) {
    const g = document.createElement('option');
    g.value = '';
    g.textContent = '全局 .minecraft（所有实例可用）';
    sel.appendChild(g);
  }
  if (!list.length) {
    const o = document.createElement('option');
    o.value = ''; o.textContent = opt ? '（没有本地实例）' : '（没有本地版本，请先下载或安装整合包）';
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
  else if (detailCtx && detailCtx.kind === 'mcmod') back = 'mod';
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
  $('page-' + back).classList.add('active');
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.page === back));
};

$('btn-detail-page').onclick = () => {
  if (!detailCtx) return;
  if (detailCtx.kind === 'mcmod' && detailCtx.pack && detailCtx.pack.mcmodUrl) { window.api.openPath(detailCtx.pack.mcmodUrl); return; }
  const slug = detailCtx.pack.slug || detailCtx.pack.id;
  const src = detailCtx.source || detailCtx.pack.source || 'modrinth';
  if (src === 'curseforge') window.api.openPath(`https://www.curseforge.com/minecraft/search?search=${encodeURIComponent(detailCtx.pack.title)}`);
  else window.api.openPath(`https://modrinth.com/project/${slug}`);
};

// 渲染版本列表
// ---------- 前置 Mod（依赖）展示与安装 ----------
// 把已装/已下载的文件名记下来，避免重复安装
const installedDepNames = new Set();

async function showModDeps(v, pack, target) {
  const titleEl = $('detail-deps-title');
  const listEl = $('detail-deps-list');
  if (!titleEl || !listEl) return;
  titleEl.style.display = 'block';
  listEl.style.display = 'block';
  titleEl.textContent = '📦 前置 Mod（依赖）';
  listEl.innerHTML = '<li class="empty">查询前置中…</li>';
  window.__hasRequiredDeps = false;

  // 当前目标实例的 MC 版本 / 加载器
  let mcVersion = '', loader = '';
  try {
    const mi = await window.api.versionInfo({ name: target });
    if (mi && mi.ok) { mcVersion = mi.info.mcVersion || ''; loader = (mi.info.loader && mi.info.loader !== '原版') ? mi.info.loader : ''; }
  } catch {}

  const source = (detailCtx && detailCtx.source) || pack.source || 'modrinth';
  const r = await window.api.modDeps({
    source,
    id: pack.id,
    versionId: v.id,
    mcVersion,
    loader: loader || undefined
  });
  if (!r || !r.ok) {
    titleEl.style.display = 'none'; listEl.style.display = 'none';
    return;
  }
  const deps = (r.dependencies || []).filter((d) => d.type === 'required' || d.type === 'optional' || d.type === 'incompatible');
  if (!deps.length) {
    titleEl.textContent = '📦 前置 Mod（依赖）';
    listEl.innerHTML = '<li class="empty">✅ 无前置 Mod（可直接用）</li>';
    return;
  }

  const required = deps.filter((d) => d.type === 'required');
  const optional = deps.filter((d) => d.type === 'optional');
  window.__hasRequiredDeps = required.length > 0;

  titleEl.textContent = `📦 前置 Mod（依赖）${required.length ? ` — ⚠️ ${required.length} 个必需` : ''}`;
  listEl.innerHTML = '';

  const makeRow = (d, kindLabel, cls) => {
    const li = document.createElement('li');
    const icon = d.icon ? `<img src="${esc(d.icon)}" referrerpolicy="no-referrer" style="width:32px;height:32px;border-radius:6px;object-fit:cover;flex:none" onerror="this.style.display='none'">` : '';
    const canInstall = d.file && d.file.url;
    const fileTag = canInstall ? `<span class="tg" style="font-size:11px">${esc(d.file.filename)}</span>` : '';
    li.innerHTML = `
      <div class="ver-left" style="display:flex;align-items:center;gap:10px;min-width:0">
        ${icon}
        <div style="min-width:0">
          <div class="ver-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(d.title || d.slug || d.id)}</div>
          <div class="ver-tags"><span class="tg ${cls}">${kindLabel}</span>${fileTag}</div>
        </div>
      </div>
      <div class="ver-right"></div>`;
    const right = li.querySelector('.ver-right');
    if (canInstall) {
      const btn = document.createElement('button');
      btn.className = 'btn mini';
      btn.textContent = installedDepNames.has(d.file.filename) ? '已安装' : '安装';
      if (installedDepNames.has(d.file.filename)) btn.disabled = true;
      btn.onclick = async (e) => {
        e.stopPropagation();
        btn.disabled = true; btn.textContent = '安装中…';
        const rr = await window.api.modInstallDep({ version: target, url: d.file.url, filename: d.file.filename });
        if (rr && rr.ok) {
          installedDepNames.add(d.file.filename);
          btn.textContent = '已安装';
          addStep(`已安装前置：${d.title || d.file.filename}`, 'done');
        } else {
          btn.disabled = false; btn.textContent = '重试';
          addStep(`前置安装失败：${d.title} — ${(rr && rr.error) || ''}`, 'err');
        }
      };
      right.appendChild(btn);
    } else {
      right.innerHTML = '<span class="hint" style="margin:0">无适配版本</span>';
    }
    return li;
  };

  required.forEach((d) => listEl.appendChild(makeRow(d, '必需前置', 'dl')));
  optional.forEach((d) => listEl.appendChild(makeRow(d, '可选前置', 'mc')));

  const incompat = deps.filter((d) => d.type === 'incompatible');
  incompat.forEach((d) => {
    const li = document.createElement('li');
    li.innerHTML = `<div class="ver-left"><div class="ver-name" style="color:#f87171">⛔ ${esc(d.title || d.id)}</div><div class="ver-tags"><span class="tg" style="background:rgba(248,113,113,.15);color:#f87171">不兼容</span></div></div>`;
    listEl.appendChild(li);
  });
}

// ---------- 前置 Mod 面板--------
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
    // Mod：点选版本时先刷新前置预览（不下载）
    li.querySelector('.ver-download-btn').addEventListener('mouseenter', () => {
      if (detailCtx && detailCtx.kind === 'mod') {
        const t = $('sel-detail-target') && $('sel-detail-target').value;
        showModDeps(v, detailCtx.pack, t).catch(() => {});
      }
    });
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
      // 下载成功后：自动拉取并展示/安装前置 Mod
      try { await showModDeps(v, pack, target); } catch {}
      alert(`已下载到「${target}」的 mods 文件夹：\n${f.filename}` + (window.__hasRequiredDeps ? '\n\n⚠️ 该 Mod 有必需前置，请看下方「前置 Mod」列表并安装' : ''));
    } else {
      addStep('下载失败：' + (r ? r.error : '未知错误'), 'err');
      $('detail-progress-text').textContent = '下载失败';
    }
    return;
  }

  // 资源包：全量安装到目标实例目录（含内置前置），不选实例则装到全局 .minecraft/resourcepacks
  if (kind === 'rpack') {
    const target = $('sel-detail-target') ? $('sel-detail-target').value : '';
    const card = $('detail-progress-card');
    card.style.display = 'block';
    $('detail-progress-title').textContent = '安装资源包：' + pack.title;
    $('detail-progress').style.width = '0%';
    $('detail-progress-text').textContent = '准备中…';
    $('detail-steps').innerHTML = '';
    addStep(target ? '下载到「' + target + '」的 resourcepacks 文件夹' : '下载到全局 .minecraft/resourcepacks 文件夹');
    log('data', `开始一键安装资源包：${pack.title} / ${v.name || v.id}` + (target ? ` → ${target}` : ''));
    $('btn-detail-install').disabled = true;
    const r = await window.api.rpackInstallFull({ id: pack.id, versionId: v.id, version: target, name: pack.title, source: detailCtx.source || 'modrinth' });
    $('btn-detail-install').disabled = false;
    if (r && r.ok) {
      addStep(`下载完成（${r.count} 个文件）`, 'done');
      $('detail-progress').style.width = '100%';
      $('detail-progress-text').textContent = target ? '安装完成，可在该实例“选项 → 资源包”中启用' : '下载完成，可在游戏“选项 → 资源包”中启用';
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

