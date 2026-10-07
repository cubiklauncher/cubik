// 支持作者（About 页）+ 整合包创作 / 导出
// ---------- 支持作者（About 页） ----------
async function initSupportCard() {
  if (!$('btn-support-star')) return;
  $('btn-support-star').onclick = () => window.api.openPath('https://github.com/cubiklauncher/cubik');
  $('btn-support-issues').onclick = () => window.api.openPath('https://github.com/cubiklauncher/cubik/issues');
  // 收款码：从常量读取，为空显示占位提示；有值则渲染 <img>
  try {
    const s = await window.api.appSupport();
    if (s && s.ok === false) return;
    const wechat = s && s.wechat ? s.wechat : '';
    const alipay = s && s.alipay ? s.alipay : '';
    renderQr('support-qr-wechat', wechat, '作者暂未上传收款码');
    renderQr('support-qr-alipay', alipay, '作者暂未上传收款码');
  } catch {}
}
function renderQr(id, src, placeholder) {
  const box = $(id);
  if (!box) return;
  if (src) {
    box.innerHTML = '';
    const img = document.createElement('img');
    img.src = src;
    img.alt = '赞赏收款码';
    img.onerror = () => { box.innerHTML = `<span class="support-qr-ph">${placeholder}</span>`; };
    box.appendChild(img);
  } else {
    box.innerHTML = `<span class="support-qr-ph">${placeholder}</span>`;
  }
}

// ---------- 整合包创作 / 导出 ----------
let exportLoaded = false;

async function loadExportInstances() {
  const sel = $('sel-export-instance');
  if (!sel) return;
  sel.innerHTML = '<option>加载本地实例中…</option>';
  const list = await window.api.listVersions();
  sel.innerHTML = '';
  if (!list.length) {
    sel.innerHTML = '<option value="">（没有本地实例，请先下载或安装一个整合包）</option>';
    return;
  }
  const metas = await Promise.all(list.map((v) => window.api.versionInfo({ name: v }).catch(() => ({ ok: false }))));
  list.forEach((v, i) => {
    const m = metas[i] && metas[i].ok ? metas[i].info : {};
    const o = document.createElement('option');
    o.value = v;
    o.textContent = v + (m.mcVersion ? `  (MC ${m.mcVersion}${m.loader && m.loader !== '原版' ? ' · ' + m.loader : ''} · ${m.mods || 0} 模组)` : '');
    sel.appendChild(o);
  });
  // 自动填入名称
  if (list.length) $('in-export-name').value = list[0];
}

function ensureExportLoaded() {
  if (exportLoaded) return;
  exportLoaded = true;
  loadExportInstances();
  if ($('btn-export-dir')) $('btn-export-dir').onclick = async () => {
    const p = await window.api.pickDir();
    if (p) $('in-export-dir').value = p;
  };
  if ($('btn-export-pack')) $('btn-export-pack').onclick = doExportPack;
}

async function doExportPack() {
  const instanceName = $('sel-export-instance') ? $('sel-export-instance').value : '';
  const packName = ($('in-export-name').value || '').trim();
  if (!instanceName) return alert('请先选择要导出的源实例');
  if (!packName) return alert('请填写整合包名称');
  const res = $('export-result');
  res.textContent = '正在导出，请稍候…';
  const btn = $('btn-export-pack');
  btn.disabled = true;
  const r = await window.api.packExport({
    instanceName,
    packName,
    packVersion: ($('in-export-version').value || '').trim(),
    author: ($('in-export-author').value || '').trim(),
    description: ($('in-export-desc').value || '').trim(),
    outDir: ($('in-export-dir').value || '').trim()
  });
  btn.disabled = false;
  if (r && r.ok) {
    res.innerHTML = `✔ 导出完成：${esc(r.file)}（${r.modsCount} 个模组，MC ${r.mcVersion}，加载器 ${r.loader}）`;
    // 提供「打开所在文件夹」入口
    const openBtn = document.createElement('button');
    openBtn.className = 'btn ghost';
    openBtn.style.marginLeft = '10px';
    openBtn.textContent = '打开所在文件夹';
    openBtn.onclick = () => window.api.openPath(r.dir);
    res.appendChild(openBtn);
  } else {
    res.textContent = '导出失败：' + ((r && r.error) || '未知错误');
  }
}

// 关于页 / 整合包页初始化（在 init 完成后由 core 调用）
function initSupportAndExport() {
  initSupportCard();
  ensureExportLoaded();
}

// 切到整合包页时刷新实例列表（保持最新）
if (window.__exportRefresh) { /* 由 core navToPage 触发 */ }
