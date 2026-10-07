// 设置：服务器版本列表 / Java 检测 / 事件绑定
// 项目地址（与 constants.js 保持一致）
var REPO_URL = 'https://github.com/cubiklauncher/cubik';
var ISSUES_URL = REPO_URL + '/issues';

// ---------- 服务器版本列表 ----------
async function loadServerVersions() {
  const type = $('sel-srv-type').value;
  const sel = $('sel-srv-mcver');
  const t0 = Date.now();
  const myReq = ++srvVerReqSeq;
  sel.disabled = true;
  sel.innerHTML = '<option>加载中…（首次需要联网获取版本，约 1-3 秒）</option>';
  let r;
  try {
    r = await window.api.serverVersions({ type });
  } catch (e) {
    r = { ok: false, error: e.message || String(e) };
  }
  // 丢弃过期响应（用户又切了类型）
  if (myReq !== srvVerReqSeq) return;
  sel.disabled = false;
  if (!r || !r.ok) {
    sel.innerHTML = '<option value="">加载失败，请重试</option>';
    log('error', `获取 ${type} 可用版本失败：${(r && r.error) || '未知错误'}（点击「服务器类型」重新选择可重试）`);
    sel.title = '加载失败：' + ((r && r.error) || '未知错误') + '，切换类型可重试';
    return;
  }
  const ids = r.list.map((v) => (typeof v === 'string' ? v : v.id)).filter(Boolean);
  if (!ids.length) { sel.innerHTML = '<option value="">该类型暂无可用版本</option>'; return; }
  sel.innerHTML = '';
  ids.forEach((id) => {
    const o = document.createElement('option');
    o.value = id; o.textContent = id; sel.appendChild(o);
  });
  // 默认选个常见版本（优先常见正式版，否则选第一个）
  const prefer = ['1.21.4', '1.21.1', '1.21', '1.20.6', '1.20.4', '1.20.1', '1.19.4', '1.18.2', '1.16.5'];
  let picked = '';
  for (const p of prefer) { if (ids.includes(p)) { picked = p; break; } }
  sel.value = picked || ids[0];
  log('data', `服务端类型 ${type}：加载到 ${ids.length} 个可用版本（${Date.now() - t0}ms），当前选 ${sel.value}`);
}
let srvVerReqSeq = 0;
$('sel-srv-type').onchange = () => loadServerVersions();

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
  try { await navigator.clipboard.writeText(txt); $('btn-log-copy').textContent = '✔ 已复制'; setTimeout(()=>{ $('btn-log-copy').innerHTML = icon('list') + ' 复制全部'; }, 1500); }
  catch { alert('复制失败，请手动选中复制'); }
};
$('btn-refresh').onclick = refreshVersions;
$('btn-detect-java').onclick = detectJava;
$('btn-about-repo').onclick = () => window.api.openPath(REPO_URL);
$('btn-about-issues').onclick = () => window.api.openPath(ISSUES_URL);
if ($('about-repo-link')) $('about-repo-link').onclick = (e) => { e.preventDefault(); window.api.openPath(REPO_URL); };
if ($('about-issues-link')) $('about-issues-link').onclick = (e) => { e.preventDefault(); window.api.openPath(ISSUES_URL); };

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

