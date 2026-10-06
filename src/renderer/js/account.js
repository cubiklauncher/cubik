// 账号：微软多账号 + 皮肤披风
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

