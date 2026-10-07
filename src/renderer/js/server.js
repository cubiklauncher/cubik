// 服务器：建服 / 管理 / 装 Mod / 存档备份 / 自动更新 / 玩家 / 指令 / 聊天 / 穿透 / 联机 / init
// ---------- 服务器 ----------
// 按已下载整合包建服：扫描本机整合包，选中后自动定类型/版本并带上它的模组
let srvPackList = [];
async function loadSrvPackOptions() {
  const sel = $('sel-srv-pack');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— 不使用整合包（手动选类型/版本）—</option>';
  let r;
  try { r = await window.api.localPacksList({}); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r || !r.ok) { $('srv-pack-info').textContent = '读取整合包失败：' + ((r && r.error) || ''); return; }
  srvPackList = r.list || [];
  if (!srvPackList.length) {
    $('srv-pack-info').textContent = '未在本机找到已下载的整合包（在「实例」里装好包后会自动出现）';
    return;
  }
  srvPackList.forEach((p) => {
    const opt = document.createElement('option');
    opt.value = p.name;
    const ld = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }[p.loader] || '原版/未知';
    opt.textContent = `${p.name}　—　MC ${p.mcVersion || '?'} · ${ld}` + (p.modsCount ? ` · ${p.modsCount} 模组` : '');
    sel.appendChild(opt);
  });
  if (cur && srvPackList.some((p) => p.name === cur)) sel.value = cur;
}

async function applySrvPack(name) {
  const info = $('srv-pack-info');
  const modsUl = $('srv-pack-mods');
  const carryWrap = $('srv-pack-carry-wrap');
  if (!name) {
    if (info) info.textContent = '';
    if (modsUl) { modsUl.style.display = 'none'; modsUl.innerHTML = ''; }
    if (carryWrap) carryWrap.style.display = 'none';
    window.__srvPackInfo = null;
    return;
  }
  const p = srvPackList.find((x) => x.name === name);
  if (!p) return;
  // 自动填服务端类型
  if ($('sel-srv-type') && (p.loader === 'fabric' || p.loader === 'forge' || p.loader === 'neoforge')) {
    $('sel-srv-type').value = p.loader;
    try { await loadServerVersions(); } catch {}
  } else if ($('sel-srv-type') && !p.loader) {
    $('sel-srv-type').value = 'vanilla';
    try { await loadServerVersions(); } catch {}
  }
  // 自动选 MC 版本（等版本列表就绪）
  if ($('sel-srv-mcver') && p.mcVersion) {
    const sel = $('sel-srv-mcver');
    const t0 = Date.now();
    const loading = (s) => !s || s.disabled || !s.value || /加载中/.test(s.options[0] ? s.options[0].textContent : '');
    while (loading(sel) && Date.now() - t0 < 12000) await new Promise((r) => setTimeout(r, 200));
    const has = Array.prototype.some.call(sel.options, (o) => o.value === p.mcVersion);
    if (has) sel.value = p.mcVersion;
  }
  const ld = { fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }[p.loader] || '原版（无加载器）';
  if (info) {
    const warn = (p.loader === 'fabric' || p.loader === 'forge' || p.loader === 'neoforge' || !p.loader)
      ? ''
      : '<br><span style="color:#e0a030">⚠ 未识别出加载器，建议手动确认服务端类型</span>';
    info.innerHTML = `已选整合包：<b>${esc(p.name)}</b><br>MC 版本：<b>${esc(p.mcVersion || '未知')}</b>　加载器：<b>${ld}</b>　模组：<b>${p.modsCount || 0}</b> 个${warn}`;
  }
  // 列出模组
  if (modsUl) {
    modsUl.style.display = 'block';
    modsUl.innerHTML = '<li class="empty">加载模组列表…</li>';
    const r = await window.api.localPacksMods({ name });
    const list = (r && r.ok ? r.list : []) || [];
    modsUl.innerHTML = list.length
      ? list.map((m) => `<li class="mod-item"><div class="mod-left"><div class="mod-name">${esc(m.file)}</div><div class="ver-tags"><span class="tg">${m.sizeKB} KB</span></div></div></li>`).join('')
      : '<li class="empty">该整合包 mods 目录为空</li>';
  }
  if (carryWrap) carryWrap.style.display = (p.modsCount > 0) ? 'flex' : 'none';
  window.__srvPackInfo = { name: p.name, loader: p.loader || '', mcVersion: p.mcVersion || '' };
  log('data', `已选择整合包「${p.name}」：MC ${p.mcVersion} · ${ld} · ${p.modsCount} 模组，建服时将自动带上`);
}

if ($('sel-srv-pack')) $('sel-srv-pack').onchange = () => applySrvPack($('sel-srv-pack').value);
if ($('btn-srv-pack-refresh')) $('btn-srv-pack-refresh').onclick = async () => { await loadSrvPackOptions(); if ($('sel-srv-pack').value) applySrvPack($('sel-srv-pack').value); };

// ---------- 建服时挑 Mod ----------
// 已勾选待安装的 Mod：[{ id, source, title, mcVersion, loader, url, filename }]
let srvPickedMods = [];

// 根据当前选的建服类型/版本推导 loader 与 mcVersion
function srvPickFilter() {
  const type = $('sel-srv-type') ? $('sel-srv-type').value : 'vanilla';
  const mcVersion = $('sel-srv-mcver') ? $('sel-srv-mcver').value : '';
  // 若选了整合包，优先用整合包推导的版本/加载器
  const packName = $('sel-srv-pack') ? $('sel-srv-pack').value : '';
  const loaderMap = { fabric: 'fabric', forge: 'forge', neoforge: 'neoforge' };
  let loader = loaderMap[type] || '';
  let mc = mcVersion;
  if (packName && window.__srvPackInfo && window.__srvPackInfo.name === packName) {
    if (window.__srvPackInfo.loader) loader = String(window.__srvPackInfo.loader).toLowerCase();
    if (window.__srvPackInfo.mcVersion) mc = window.__srvPackInfo.mcVersion;
  }
  return { type, mcVersion: mc, loader, supported: !!loader };
}

function renderSrvPickedMods() {
  const ul = $('srvmod-picked');
  const hint = $('srvmod-picked-hint');
  if (!ul) return;
  ul.innerHTML = '';
  srvPickedMods.forEach((m, i) => {
    const li = document.createElement('li');
    li.className = 'srvmod-picked-item';
    li.innerHTML = `<span class="srvmod-picked-name" title="${esc(m.title)}">${esc(m.title)}</span>` +
      `<span class="srvmod-picked-ver">${esc(m.mcVersion ? 'MC ' + m.mcVersion : '')}${m.loader ? ' · ' + esc(m.loader) : ''}</span>` +
      `<button class="srvmod-picked-del" data-i="${i}" title="移除">${icon('close')}</button>`;
    ul.appendChild(li);
  });
  ul.querySelectorAll('[data-i]').forEach((b) => {
    b.onclick = () => { srvPickedMods.splice(Number(b.dataset.i), 1); renderSrvPickedMods(); renderSrvModResults(); };
  });
  if (hint) hint.textContent = srvPickedMods.length ? `已选 ${srvPickedMods.length} 个 Mod，创建服务器时自动安装。` : '';
}

function renderSrvModResults(list, filter, errText) {
  const box = $('srvmod-results');
  if (!box) return;
  if (errText) { box.innerHTML = `<div class="empty">${esc(errText)}</div>`; return; }
  if (!list || !list.length) { box.innerHTML = '<div class="empty">未找到兼容该版本/加载器的 Mod</div>'; return; }
  box.innerHTML = '';
  list.slice(0, 24).forEach((p) => {
    const picked = srvPickedMods.some((m) => m.id === p.id && m.source === (p.source || 'modrinth'));
    const el = document.createElement('button');
    el.className = 'srvmod-result' + (picked ? ' picked' : '');
    el.type = 'button';
    el.title = p.title;
    el.innerHTML = (p.icon ? `<img src="${esc(p.icon)}" alt="">` : `<span class="srvmod-result-ph">${icon('puzzle')}</span>`) +
      `<span class="srvmod-result-name">${esc(p.title)}</span>` +
      `<span class="srvmod-result-add">${picked ? icon('check') : icon('plus')}</span>`;
    el.onclick = () => pickServerMod(p, filter);
    box.appendChild(el);
  });
}

async function pickServerMod(pack, filter) {
  const key = pack.source || 'modrinth';
  const already = srvPickedMods.findIndex((m) => m.id === pack.id && m.source === key);
  if (already >= 0) { srvPickedMods.splice(already, 1); renderSrvPickedMods(); renderSrvModResults(window.__srvModLastList || [], filter); return; }
  // 拉取兼容版本（取第一个匹配）
  const res = await window.api.packVersions({
    source: key, id: pack.id,
    mc: filter && filter.mcVersion ? filter.mcVersion : undefined,
    loader: filter && filter.loader ? filter.loader : undefined
  });
  let vlist = (res && res.ok ? res.list : []) || [];
  if (!vlist.length) {
    const all = await window.api.packVersions({ source: key, id: pack.id });
    vlist = (all && all.ok ? all.list : []) || [];
  }
  const v = vlist[0];
  const f = v && ((v.files || []).find((x) => x.primary) || (v.files || [])[0]);
  if (!f) { alert('该 Mod 没有可下载的版本'); return; }
  srvPickedMods.push({
    id: pack.id, source: key, title: pack.title,
    mcVersion: (filter && filter.mcVersion) || '', loader: (filter && filter.loader) || '',
    url: f.url, filename: f.filename
  });
  renderSrvPickedMods();
  renderSrvModResults(window.__srvModLastList || [], filter);
}

async function searchServerModsForCreate() {
  const box = $('srvmod-results');
  if (!box) return;
  const filter = srvPickFilter();
  const hint = $('srvmod-filter-hint');
  if (hint) hint.textContent = filter.supported
    ? `筛选条件：MC ${filter.mcVersion || '不限'} · ${filter.loader}`
    : `当前服务端类型不支持 Mod（仅 Fabric / Forge / NeoForge 可装 Mod）`;
  if (!filter.supported) { box.innerHTML = '<div class="empty">当前服务端类型不支持 Mod。请改选 Fabric / Forge / NeoForge，或使用「插件」而非 Mod。</div>'; return; }
  const q = ($('in-srvmod-query') && $('in-srvmod-query').value.trim()) || '';
  box.innerHTML = '<div class="empty">加载中…</div>';
  const p = { kind: 'mod', query: q };
  if (filter.mcVersion) p.mcVersion = filter.mcVersion;
  if (filter.loader) p.loader = filter.loader;
  const r = await window.api.searchAll(p);
  if (!r || !r.ok) { box.innerHTML = `<div class="empty">搜索失败：${esc((r && r.error) || '')}</div>`; return; }
  window.__srvModLastList = r.list || [];
  renderSrvModResults(window.__srvModLastList, filter);
}

if ($('btn-srvmod-search')) $('btn-srvmod-search').onclick = () => searchServerModsForCreate();
if ($('in-srvmod-query')) $('in-srvmod-query').onkeydown = (e) => { if (e.key === 'Enter') searchServerModsForCreate(); };
if ($('sel-srv-type')) $('sel-srv-type').addEventListener('change', () => { if ($('srvmod-results') && $('srvmod-results').children.length) searchServerModsForCreate(); });

$('btn-srv-pick').onclick = async () => {
  const p = await window.api.pickDir();
  if (p) { $('in-srv-dir').value = p; }
};
// 新建（或选择）一个文件夹作为服务器目录
if ($('btn-srv-newdir')) $('btn-srv-newdir').onclick = async () => {
  const cur = $('in-srv-dir').value.trim();
  const p = await window.api.pickNewDir(cur ? { defaultPath: cur } : {});
  if (p) { $('in-srv-dir').value = p; log('data', '已选定服务器目录：' + p); }
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
    $('in-srv-dir').value = await suggestNewServerDirAsync();
  }
  if ($('srv-create-log')) $('srv-create-log').textContent += '\n===== ⚡ 一键快速建服（自动推荐配置）=====\n';
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
  const packName = $('sel-srv-pack') ? $('sel-srv-pack').value : '';
  const wantCarry = packName && (!$('chk-srv-pack-carry') || $('chk-srv-pack-carry').checked);
  cfg.serverDir = opts.dir;
  await window.api.setConfig(cfg);
  const btn = $('btn-srv-create');
  btn.disabled = true;
  const clog = $('srv-create-log');
  const cstatus = $('create-status');
  if (clog) clog.textContent = '';
  if (cstatus) { cstatus.style.display = 'none'; cstatus.className = 'create-status'; }
  const wlog = (t) => { if (clog) { clog.textContent += t; clog.scrollTop = clog.scrollHeight; } if ($('srv-log')) $('srv-log').textContent += t; };
  const status = (html, cls) => { if (!cstatus) return; cstatus.style.display = ''; cstatus.className = 'create-status' + (cls ? ' ' + cls : ''); cstatus.innerHTML = html; };
  status('⏳ 正在创建服务器… 下载服务端并写入配置，请稍候（首次约十几秒）');
  wlog(`\n===== 创建服务器 (${opts.type} ${opts.mcVersion}) =====\n`);
  try {
    const r = await window.api.serverCreate(opts);
    if (!r || !r.ok) {
      wlog('\n✖ 创建失败：' + ((r && r.error) || '未知错误') + '\n');
      status('✖ 创建失败：' + ((r && r.error) || '未知错误') + '<br><span class="hint">可展开下方「创建日志」看详情，或点「创建服务器」重试。</span>', 'err');
    } else {
      wlog('\n✔ 创建完成！\n');
      // 按整合包建服：把该包的模组复制到服务器 mods
      if (wantCarry) {
        wlog(`\n导入整合包「${packName}」的模组到服务器 mods…\n`);
        status('⏳ 正在导入整合包模组…');
        try {
          const cr = await window.api.localPacksCarry({ packName, dir: opts.dir });
          if (cr && cr.ok) {
            wlog(`✔ 已导入 ${cr.carried} 个模组` + (cr.skipped && cr.skipped.length ? `，跳过 ${cr.skipped.length} 个同名` : '') + '\n');
          } else {
            wlog('✖ 导入整合包模组失败：' + ((cr && cr.error) || '未知错误') + '\n');
          }
        } catch (e) { wlog('✖ 导入整合包模组异常：' + (e.message || e) + '\n'); }
      }
      status('✔ 创建完成！正在跳转到「服务器管理」…', 'ok');
      // 建服时挑选的 Mod：批量安装到新服务器 mods
      if (srvPickedMods.length) {
        const pickFilter = srvPickFilter();
        if (!pickFilter.supported) {
          wlog('\n⚠ 当前服务端不支持 Mod，已跳过 ' + srvPickedMods.length + ' 个勾选的 Mod\n');
        } else {
          wlog(`\n正在安装 ${srvPickedMods.length} 个勾选的 Mod…\n`);
          status('⏳ 正在安装勾选的 Mod…');
          try {
            const mr = await window.api.srvModInstallMany({ dir: opts.dir, files: srvPickedMods.map((m) => ({ url: m.url, filename: m.filename })) });
            if (mr && mr.ok) {
              wlog(`✔ 已安装 ${mr.installed} 个 Mod` + (mr.failed && mr.failed.length ? `，${mr.failed.length} 个失败` : '') + '\n');
              (mr.failed || []).forEach((x) => wlog(`  ✖ ${x.filename}：${x.error}\n`));
              srvPickedMods = []; renderSrvPickedMods(); renderSrvModResults([]);
            } else {
              wlog('✖ 批量安装 Mod 失败：' + ((mr && mr.error) || '未知错误') + '\n');
            }
          } catch (e) { wlog('✖ 批量安装 Mod 异常：' + (e.message || e) + '\n'); }
        }
      }
      status('✔ 创建完成！正在跳转到「服务器管理」…', 'ok');
      // 自动把新建的服务器加入列表并设为当前
      try {
        const lr = await window.api.serverList();
        const already = lr && lr.ok && (lr.list || []).some((s) => s.dir === opts.dir);
        if (!already) {
          const ar = await window.api.serverAdd({ dir: opts.dir, name: opts.dir.split(/[\\/]/).pop() || 'Server', type: opts.type, mcVersion: opts.mcVersion, memory: parseInt(opts.memory, 10) || 2048 });
          if (ar && ar.ok) srvActiveId = ar.activeServerId;
        }
        try { await loadServerList(); } catch {}
        // 建完后切到「服务器管理」页，方便直接启动/管理
        setTimeout(() => { try { enterServerManage(opts.dir.split(/[\\/]/).pop() || '服务器'); } catch {} }, 900);
      } catch {}
    }
  } catch (e) {
    wlog('\n✖ 创建异常：' + (e.message || e) + '\n');
    status('✖ 创建异常：' + (e.message || e), 'err');
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

// ---------- 多服务器列表 ----------
let srvActiveId = '';
// 兼容旧调用：刷新「服务器管理」页的服务器列表
async function loadServerList() { await loadServerListIntoManage(); }

// 「服务器」页的已有服务器概览（只读，点卡片跳去管理）
async function renderServerOverview() {
  const box = $('srv-ov-box');
  if (!box) return;
  const r = await window.api.serverList();
  if (!r || !r.ok) { box.innerHTML = `<div class="empty">读取失败：${esc((r && r.error) || '')}</div>`; return; }
  const list = r.list || [];
  if ($('srv-ov-count')) $('srv-ov-count').textContent = list.length ? `共 ${list.length} 个` : '';
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有服务器，在下方填表即可创建第一个 👇</div>';
    return;
  }
  const typeLabel = (t) => ({ vanilla: '原版', paper: 'Paper', spigot: 'Spigot', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }[t] || t || '未知');
  box.innerHTML = list.map((s) => {
    const t = s.detectedType || s.type || '';
    const mc = s.detectedMc || s.mcVersion || '';
    const state = s.running ? '<span class="srv-ov-dot on">● 运行中</span>' : '<span class="srv-ov-dot off">● 已停止</span>';
    return `<div class="srv-ov-item${s.isActive ? ' active' : ''}">
      <span class="srv-ov-name">${esc(s.name)}${s.isActive ? '<span class="srv-item-badge">当前</span>' : ''}</span>
      <span class="srv-ov-meta">${esc(typeLabel(t))}${mc ? ' · MC ' + esc(mc) : ''}</span>
      ${state}
    </div>`;
  }).join('');
  box.querySelectorAll('.srv-ov-item').forEach((el) => {
    el.style.cursor = 'pointer';
    el.onclick = () => goPage('srvmanage');
  });
}
if ($('btn-srv-ov-manage')) $('btn-srv-ov-manage').onclick = () => goPage('srvmanage');

// 把当前激活服务器的目录同步到建服表单/内存/端口等
async function syncServerDirToUI() {
  const r = await window.api.serverList();
  if (!r || !r.ok) return;
  const act = (r.list || []).find((s) => s.id === r.activeServerId);
  if (!act) return;
  srvActiveId = act.id;
  if ($('in-srv-dir')) $('in-srv-dir').value = act.dir;
  // 同步到界面配置
  if (typeof cfg === 'object' && cfg) { cfg.serverDir = act.dir; cfg.activeServerId = act.id; }
  // 版本/类型回填（若已识别到）
  if (act.detectedMc && $('sel-srv-mcver')) {
    const opt = [...$('sel-srv-mcver').options].find((o) => o.value === act.detectedMc);
    if (opt) $('sel-srv-mcver').value = act.detectedMc;
  }
  if ((act.detectedType || act.type) && $('sel-srv-type')) {
    const t = act.detectedType || act.type;
    const opt = [...$('sel-srv-type').options].find((o) => o.value === t);
    if (opt) $('sel-srv-type').value = t;
  }
  if (act.memory && window.srvMemSlider) window.srvMemSlider.set(act.memory);
}

// 进入「服务器管理」（切到 srvmanage 页面）
async function enterServerManage(name) {
  if (name && $('srv-manage-title')) $('srv-manage-title').innerHTML = icon('wrench') + ' 正在管理：' + esc(name);
  await loadServerListIntoManage(name);
  goPage('srvmanage');
}

// 返回服务器列表页
function exitServerManage() {
  goPage('server');
}
// 返回按钮已移除（改用侧栏导航）；不引用不存在的 DOM


// 把「我的服务器」列表渲染到管理页（点卡片切换，点🛠管理进入）
async function loadServerListIntoManage(activeName) {
  const box = $('srv-mgr-list-box');
  if (!box) return;
  box.innerHTML = '<div class="empty">加载中…</div>';
  const r = await window.api.serverList();
  if (!r || !r.ok) { box.innerHTML = `<div class="empty">读取失败：${esc((r && r.error) || '')}</div>`; return; }
  srvActiveId = r.activeServerId || '';
  const list = r.list || [];
  const act = list.find((s) => s.id === srvActiveId);
  if ($('srv-manage-title')) {
    $('srv-manage-title').innerHTML = icon('wrench') + ' 正在管理：' + esc(activeName || (act && act.name) || '服务器');
  }
  const cnt = $('srv-mgr-count');
  if (cnt) cnt.textContent = list.length ? `共 ${list.length} 个` : '';
  if (!list.length) {
    box.innerHTML = '<div class="empty">还没有服务器，请到「服务器」页新建或添加</div>';
    return;
  }
  const typeLabel = (t) => ({ vanilla: '原版', paper: 'Paper', spigot: 'Spigot', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge' }[t] || t || '未知');
  box.innerHTML = list.map((s) => {
    const t = s.detectedType || s.type || '';
    const mc = s.detectedMc || s.mcVersion || '';
    const tags = [
      `<span class="tg">${esc(typeLabel(t))}</span>`,
      mc ? `<span class="tg">MC ${esc(mc)}</span>` : '',
      s.running ? '<span class="tg on">● 运行中</span>' : '',
      !s.exists ? '<span class="tg miss">目录不存在</span>' : '',
    ].join('');
    return `
    <div class="srv-item${s.isActive ? ' active' : ''}" data-id="${esc(s.id)}">
      <div class="srv-item-main">
        <div class="srv-item-name">${esc(s.name)}${s.isActive ? '<span class="srv-item-badge">当前</span>' : ''}</div>
        <div class="srv-item-dir" title="${esc(s.dir)}">${esc(s.dir)}</div>
        <div class="srv-item-tags">${tags}</div>
      </div>
      <div class="srv-item-actions">
        <button class="btn mini primary srv-mgr-manage" data-id="${esc(s.id)}" title="管理这个服务器">${icon('wrench')} 管理</button>
        <button class="btn mini srv-mgr-rename" data-id="${esc(s.id)}" title="重命名">${icon('edit')}</button>
        <button class="btn mini ghost srv-mgr-remove" data-id="${esc(s.id)}" title="移出列表">${icon('trash')}</button>
      </div>
    </div>`;
  }).join('');
  // 点卡片切换当前服务器
  box.querySelectorAll('.srv-item').forEach((el) => {
    el.onclick = async (e) => {
      if (e.target.closest('.srv-mgr-manage') || e.target.closest('.srv-mgr-rename') || e.target.closest('.srv-mgr-remove')) return;
      const id = el.dataset.id;
      if (id === srvActiveId) return;
      const rr = await window.api.serverSwitch({ id });
      if (!rr || !rr.ok) return alert('切换失败：' + ((rr && rr.error) || '未知错误'));
      log('data', `已切换到服务器：${rr.server.name}（${rr.server.dir}）`);
      await syncServerDirToUI();
      await loadServerListIntoManage(rr.server.name);
      refreshServerBackup(); loadServerMods(); refreshServerStatus(); checkServerUpdateUI(true);
    };
  });
  // 重命名
  box.querySelectorAll('.srv-mgr-rename').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      const cur = list.find((s) => s.id === id);
      const name = prompt('重命名服务器：', cur ? cur.name : '');
      if (name == null) return;
      const rr = await window.api.serverRename({ id, name });
      if (!rr || !rr.ok) return alert('重命名失败：' + ((rr && rr.error) || '未知错误'));
      loadServerListIntoManage(cur ? name : '');
    };
  });
  // 移出列表
  box.querySelectorAll('.srv-mgr-remove').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      const cur = list.find((s) => s.id === id);
      if (!confirm('从列表移除服务器？\n' + (cur ? cur.name + '\n' + cur.dir : '') + '\n\n（只从列表移除，不会删除服务器文件）')) return;
      const rr = await window.api.serverRemove({ id });
      if (!rr || !rr.ok) return alert('移除失败：' + ((rr && rr.error) || '未知错误'));
      await syncServerDirToUI();
      loadServerListIntoManage();
      refreshServerBackup(); loadServerMods(); refreshServerStatus(); checkServerUpdateUI(true);
    };
  });
  // 点「🛠 管理」：切换并刷新管理页
  box.querySelectorAll('.srv-mgr-manage').forEach((b) => {
    b.onclick = async (e) => {
      e.stopPropagation();
      const id = b.dataset.id;
      const cur = list.find((s) => s.id === id);
      if (id !== srvActiveId) {
        const rr = await window.api.serverSwitch({ id });
        if (!rr || !rr.ok) return alert('切换失败：' + ((rr && rr.error) || '未知错误'));
        await syncServerDirToUI();
      }
      await loadServerListIntoManage(cur ? cur.name : '');
      refreshServerBackup(); loadServerMods(); refreshServerStatus(); checkServerUpdateUI(true); loadAutoBackup(); refreshNetInfo();
    };
  });
}

// 计算一个全新的服务器目录建议：D:\mc-server、D:\mc-server2、…（避开列表里已有的以及磁盘上已存在的）
async function suggestNewServerDirAsync() {
  const cfgMc = (cfg && cfg.mcDir) || 'D:\\.minecraft';
  const drive = (cfgMc.match(/^[A-Za-z]:/) || ['D:'])[0];
  const base = drive + '\\mc-server';
  const used = new Set();
  try {
    const lr = await window.api.serverList();
    (lr && lr.ok ? lr.list : []).forEach((s) => { if (s && s.dir) used.add(String(s.dir).toLowerCase()); });
  } catch {}
  let n = 1, cand = base;
  while (used.has(cand.toLowerCase())) { n += 1; cand = base + n; }
  return cand;
}
// 同步版本（启动时用，没有已有列表信息，仅避开当前目录）
function suggestNewServerDir(cfgObj) {
  const cfgMc = (cfgObj && cfgObj.mcDir) || 'D:\\.minecraft';
  const drive = (cfgMc.match(/^[A-Za-z]:/) || ['D:'])[0];
  const base = drive + '\\mc-server';
  // 若默认目录恰好等于现有服务器目录，则加数字区分
  const cur = (cfgObj && cfgObj.serverDir) || '';
  if (cur && cur.toLowerCase() === base.toLowerCase()) return base + '2';
  return base;
}

// 进入服务器页时：若建服目录还是旧的（指向已有服务器目录）或为空，刷新为全新建议目录
async function refreshCreateDirDefault() {
  const el = $('in-srv-dir');
  if (!el) return;
  const cur = el.value.trim();
  const cfgServerDir = (cfg && cfg.serverDir) || '';
  const stale = !cur || (cfgServerDir && cur.toLowerCase() === cfgServerDir.toLowerCase());
  if (stale) {
    try { el.value = await suggestNewServerDirAsync(); } catch {}
  }
}

async function doNewServer() {
  // 新建：推荐一个全新的目录（D:\mc-server、D:\mc-server2…自动避开已有服务器）
  const dirEl = $('in-srv-dir');
  if (!dirEl) { alert('界面未就绪，请重新打开服务器页再试'); return; }
  const base = await suggestNewServerDirAsync();
  dirEl.value = base;
  if ($('srv-options')) $('srv-options').open = true;
  log('data', '新建服务器：已填入建议目录 ' + base + '，可直接用或点「选择文件夹/新建文件夹」换成其它位置，然后选类型与版本点「创建服务器」');
  const form = dirEl.closest('.card');
  if (form) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  // 关键：若 MC 版本列表还在“加载中”，帮用户等它加载完（否则看起来就像“新建不了”）
  const verSel = $('sel-srv-mcver');
  const stillLoading = (s) => !!s && (s.disabled || !s.value || /加载中/.test(s.options[0] ? s.options[0].textContent : ''));
  if (stillLoading(verSel)) {
    const t0 = Date.now();
    const type = $('sel-srv-type').value;
    while (stillLoading(verSel)) {
      if (Date.now() - t0 > 12000) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!verSel.disabled && verSel.value) {
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      log('data', `版本列表已就绪（${type}，用时 ${secs}s），当前选 ${verSel.value}。可以直接点「创建服务器」了。`);
    } else {
      log('error', '版本列表加载较慢或失败：请检查网络，或在「服务器类型」下拉里重新选一次重试。');
    }
  }
}
// 暴露给按钮绑定 / 自动化测试 / 错误重试
window.__doNewServer = doNewServer;
if ($('btn-srv-add-existing')) $('btn-srv-add-existing').onclick = async () => {
  const dir = await window.api.pickDir();
  if (!dir) return;
  const r = await window.api.serverAdd({ dir, name: dir.split(/[\\/]/).pop() || 'Server' });
  if (!r || !r.ok) return alert('添加失败：' + ((r && r.error) || '未知错误'));
  log('data', `已添加服务器：${r.server.name}（${r.server.dir}）`);
  await syncServerDirToUI();
  loadServerList();
  refreshServerBackup(); loadServerMods(); refreshServerStatus(); checkServerUpdateUI(true);
};

// ---------- 服务器装 Mod ----------
let srvModDirPath = null;
async function loadServerMods() {
  const ul = $('srvm-list');
  if (!ul) return;
  ul.innerHTML = '<li class="empty">加载中…</li>';
  const r = await window.api.srvModList({});
  if (!r || !r.ok) { ul.innerHTML = `<li class="empty">读取失败：${esc((r && r.error) || '')}</li>`; return; }
  srvModDirPath = r.dir;
  // 顶部信息
  const typeLabel = { paper: 'Paper', spigot: 'Spigot', fabric: 'Fabric', forge: 'Forge', neoforge: 'NeoForge', vanilla: '原版' }[r.type] || (r.type || '未知');
  $('srvm-type').textContent = '服务端：' + typeLabel;
  $('srvm-mcver').textContent = '游戏版本：' + (r.mcVersion || '未知');
  const sup = r.supports === true ? '✅ 可装 Mod' : r.supports === false ? '⚠ 需插件（非 Mod）' : '—（请先创建服务器）';
  $('srvm-support').textContent = 'Mod 支持：' + sup;
  $('srvm-support').style.color = r.supports === false ? '#e0a030' : '';

  const list = r.list || [];
  $('srvm-count').textContent = list.length ? `共 ${list.length} 个` : '';
  if (!list.length) {
    const msg = r.type === 'unknown' || !r.type ? '还没有服务器，请先在上方创建服务器' : (r.supports === false ? '当前服务端是 ' + typeLabel + '，请用「插件」而非 Mod' : '还没有装 Mod，在上方搜索并安装吧');
    ul.innerHTML = `<li class="empty">${msg}</li>`;
    return;
  }
  ul.innerHTML = list.map((m) => {
    const sz = m.size ? (m.size / 1048576).toFixed(1) + ' MB' : '';
    return `
    <li class="mod-item${m.disabled ? ' off' : ''}">
      <div class="mod-left">
        <div class="mod-name" title="${esc(m.file)}">${esc(m.file.replace(/\.disabled$/i, ''))}</div>
        <div class="ver-tags"><span class="tg">${sz}</span>${m.disabled ? '<span class="tg">已停用</span>' : ''}</div>
      </div>
      <div class="mod-actions">
        <label class="switch" title="${m.disabled ? '启用' : '停用'}"><input type="checkbox" class="srvm-toggle" data-file="${esc(m.file)}" ${m.disabled ? '' : 'checked'}><span></span></label>
        <button class="btn mini ghost srvm-del" data-file="${esc(m.file)}" title="删除">${icon('trash')}</button>
      </div>
    </li>`;
  }).join('');
  ul.querySelectorAll('.srvm-toggle').forEach((cb) => {
    cb.onchange = async () => {
      const file = cb.dataset.file;
      const wantDisabled = !cb.checked;
      const rr = await window.api.srvModToggle({ file, disabled: wantDisabled });
      if (!rr || !rr.ok) { alert('操作失败：' + ((rr && rr.error) || '未知错误')); cb.checked = !cb.checked; return; }
      loadServerMods();
    };
  });
  ul.querySelectorAll('.srvm-del').forEach((btn) => {
    btn.onclick = async () => {
      const file = btn.dataset.file;
      if (!confirm('确定删除这个 Mod？\n' + file)) return;
      const rr = await window.api.srvModDelete({ file });
      if (!rr || !rr.ok) return alert('删除失败：' + ((rr && rr.error) || '未知错误'));
      loadServerMods();
    };
  });
}

async function searchServerMods(query) {
  const grid = $('srvm-store-list');
  if (!grid) return;
  grid.style.display = 'grid';
  grid.innerHTML = '<div class="empty">加载中…</div>';
  $('srvm-ver-panel').style.display = 'none';
  const info = await window.api.srvModList({});
  const mcVersion = info && info.mcVersion ? info.mcVersion : '';
  const loaderMap = { fabric: 'fabric', forge: 'forge', neoforge: 'neoforge' };
  const loader = info && loaderMap[info.type] ? loaderMap[info.type] : '';
  if (info && info.supports === false) {
    grid.innerHTML = `<div class="empty">当前服务端是 ${esc(info.type)}，它用的是「插件」而不是 Mod。<br>请到服务端目录的 plugins 文件夹放插件，或换成 Fabric/Forge/NeoForge 服务端。</div>`;
    return;
  }
  const p = { kind: 'mod', query };
  if (mcVersion) p.mcVersion = mcVersion;
  if (loader) p.loader = loader;
  const r = await window.api.searchAll(p);
  if (!r || !r.ok) { grid.innerHTML = `<div class="empty">搜索失败：${esc((r && r.error) || '')}</div>`; return; }
  $('srvm-filter').textContent = `筛选条件：MC ${mcVersion || '不限'}${loader ? ' · ' + loader : ' · 无加载器'}`;
  if (!r.list || !r.list.length) { grid.innerHTML = '<div class="empty">未找到兼容该服务器版本/加载器的 Mod</div>'; return; }
  renderCards(grid, r.list, (p2) => openServerModVersions(p2, { mcVersion, loader }));
}

async function openServerModVersions(pack, filter) {
  const panel = $('srvm-ver-panel');
  const ul = $('srvm-ver-list');
  panel.style.display = 'block';
  $('srvm-ver-title').textContent = '选择要装到服务器的版本：' + pack.title;
  ul.innerHTML = '<li class="empty">加载中…</li>';
  const source = pack.source || 'modrinth';
  const res = await window.api.packVersions({
    source, id: pack.id,
    mc: filter && filter.mcVersion ? filter.mcVersion : undefined,
    loader: filter && filter.loader ? filter.loader : undefined
  });
  if (!res || !res.ok) { ul.innerHTML = `<li class="empty">加载失败：${esc((res && res.error) || '')}</li>`; return; }
  // 兼容旧版本：若未筛到，回退拉全部版本
  let list = res.list || [];
  if (!list.length) {
    const all = await window.api.packVersions({ source, id: pack.id });
    list = (all && all.ok ? all.list : []) || [];
    if (list.length) $('srvm-ver-title').textContent = '（无完全匹配的版本，显示全部）要装到服务器的版本：' + pack.title;
  }
  renderVersions(ul, list, (v) => installServerMod(pack, v, filter));
}

async function installServerMod(pack, v, filter) {
  const f = (v.files || []).find((x) => x.primary) || (v.files || [])[0];
  if (!f) return alert('该版本没有可下载文件');
  const wrap = $('srvm-progress-wrap');
  const bar = $('srvm-progress');
  wrap.style.display = 'block';
  bar.style.width = '25%';
  log('data', `开始下载服务端 Mod：${pack.title} / ${f.filename}`);
  const r = await window.api.srvModInstall({ url: f.url, filename: f.filename });
  if (r && r.ok) {
    bar.style.width = '100%';
    alert('已安装到服务器 mods 文件夹：\n' + f.filename + (filter && filter.mcVersion ? `\n\n（筛选：MC ${filter.mcVersion}${filter.loader ? ' · ' + filter.loader : ''}）` : '') + '\n\n重启服务器后生效。');
    loadServerMods();
    setTimeout(() => { wrap.style.display = 'none'; bar.style.width = '0'; }, 1500);
  } else {
    bar.style.width = '0';
    wrap.style.display = 'none';
    alert('安装失败：' + ((r && r.error) || '未知错误'));
  }
}

if ($('btn-srvm-search')) $('btn-srvm-search').onclick = () => searchServerMods($('in-srvm-query').value.trim());
if ($('in-srvm-query')) $('in-srvm-query').onkeydown = (e) => { if (e.key === 'Enter') searchServerMods($('in-srvm-query').value.trim()); };
if ($('btn-srvm-refresh')) $('btn-srvm-refresh').onclick = () => loadServerMods();
if ($('btn-srvm-open')) $('btn-srvm-open').onclick = () => window.api.srvModOpen({});
if (window.api.onSrvModProgress) window.api.onSrvModProgress((d) => {
  if (d && d.total) { const bar = $('srvm-progress'); if (bar) bar.style.width = Math.round((d.got / d.total) * 100) + '%'; }
});

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
    box.innerHTML = '<div class="srvw-empty">还没有备份。点「' + icon('save') + ' 立即备份存档」创建第一个备份。</div>';
    return;
  }
  box.innerHTML = list.map((b) => `
    <div class="srvw-row">
      <div class="srvw-main">
        <div class="srvw-title">${icon('map')} ${esc(b.world || 'world')} · ${fmtTime(b.ts || b.mtime)}</div>
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
    btn.innerHTML = icon('play') + ' 启动游戏';
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

