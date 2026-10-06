// 版本：版本列表 / 原版下载 / 组件勾选 / 版本详情
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
  if ($('qa-ver-count')) $('qa-ver-count').textContent = localVersions.length ? localVersions.length + ' 个版本' : '暂无版本';
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

