// mcmod.js - MC 百科（mcmod.cn）中文搜索源
// 用途：搜索中文 Mod / 整合包，拿到中文名、百科链接、简介，以及「前置 Mod（依赖）」信息。
// mcmod.cn 本身不托管下载文件（它链接到 CurseForge/Modrinth），因此这里提供：
//   1) 中文搜索（返回百科条目，带 available 标记，可跳转百科）
//   2) 前置/依赖关系解析（服务器 & 客户端装机时避免漏装前置）
const https = require('https');

const UA = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

function getText(url, tries = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: UA },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          let next;
          try { next = new URL(res.headers.location, url).href; } catch { next = res.headers.location; }
          return getText(next, tries).then(resolve, reject);
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            if (tries > 1) return setTimeout(() => getText(url, tries - 1).then(resolve, reject), 700);
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          resolve(body);
        });
        res.on('error', (e) => {
          if (tries > 1) return setTimeout(() => getText(url, tries - 1).then(resolve, reject), 700);
          reject(e);
        });
      }
    );
    req.setTimeout(20000, () => req.destroy(new Error('请求超时：' + url)));
    req.on('error', (e) => {
      if (tries > 1) return setTimeout(() => getText(url, tries - 1).then(resolve, reject), 700);
      reject(e);
    });
  });
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// 解析搜索结果页：区分「Mod」与「整合包」两类结果
// mcmod 搜索 URL: https://search.mcmod.cn/s?key=xxx&filter=0
// 结果块：<div class="result-item">...<a href="https://www.mcmod.cn/class/459.html">[JEI] JEI物品管理器 (Just Enough Items)</a>...<div class="body">简介</div>
function parseSearchResults(html, kindFilter = '') {
  const out = [];
  const re = /<div class="result-item">([\s\S]*?)<\/div>\s*<div class="foot">/g;
  let m;
  while ((m = re.exec(html))) {
    const block = m[1];
    const linkM = block.match(/href="(https?:\/\/(?:www\.)?mcmod\.cn\/(class|modpack)\/(\d+)\.html)"[^>]*>([\s\S]*?)<\/a>/);
    if (!linkM) continue;
    const url = linkM[1];
    const urlKind = linkM[2]; // class | modpack
    const id = linkM[3];
    const rawTitle = stripTags(linkM[4]);
    // 标题形如：「[JEI] JEI物品管理器 (Just Enough Items)」
    let shortName = '';
    let zhName = rawTitle;
    let enName = '';
    const bracketM = rawTitle.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (bracketM) {
      shortName = bracketM[1].trim();
      zhName = bracketM[2].trim();
    }
    const parenM = zhName.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (parenM) { zhName = parenM[1].trim(); enName = parenM[2].trim(); }
    const bodyM = block.match(/<div class="body">([\s\S]*?)<\/div>/);
    const desc = bodyM ? stripTags(bodyM[1]).slice(0, 200) : '';
    // 分类
    const cats = [];
    const catRe = /class="c_\d+"[^>]*><\/a>|href="[^"]*\/category\/(\d+)-1\.html"[^>]*>([^<]*)<\/a>/g;
    let cm;
    while ((cm = catRe.exec(block))) { if (cm[2]) cats.push(stripTags(cm[2])); }

    const kind = urlKind === 'modpack' ? 'modpack' : 'mod';
    if (kindFilter && kind !== kindFilter) continue;
    out.push({
      source: 'mcmod',
      id: id,
      title: shortName || zhName || rawTitle,
      zhName: zhName && zhName !== shortName ? zhName : '',
      enName,
      shortName,
      description: desc,
      authors: '',
      url,
      mcmodUrl: url,
      kind,
      categories: cats,
      downloads: 0,
      icon: '',
    });
  }
  return out;
}

// 搜索（中文优先）
// 注意：mcmod 对频繁请求会返回「壳页」（约 20KB，无搜索结果列表），需检测并重试。
async function searchMcmod(query, kindFilter = '') {
  const url = `https://search.mcmod.cn/s?key=${encodeURIComponent(query)}&filter=0`;
  let html = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    html = await getText(url);
    // 有结果就是成功；有「找到约」但0条也算成功（真的无结果）
    if (html.includes('search-result-list')) break;
    // 壳页：等待后重试
    await new Promise((r) => setTimeout(r, 600 + attempt * 700));
  }
  return parseSearchResults(html, kindFilter);
}

// 解析一个百科条目的「前置 Mod / 依赖关系」
// class 页里：<span ...>XXX的前置Mod:</span><ul><li><a ... data-original-title="..." href="/class/31030.html">MezzConfig</a></li></ul>
// 以及 <legend>内置</legend> / <legend>通用</legend> 两段（内置=必须前置，通用=可选/被依赖）
async function fetchPrereqs(id, kind = 'class') {
  const url = `https://www.mcmod.cn/${kind}/${id}.html`;
  const html = await getText(url);
  const prereqs = [];   // 前置 Mod（装这个 Mod 之前必须先装）
  const dependents = []; // 依赖它的 Mod（可选信息）
  const seen = new Set();

  // 逐段按 fieldset 切分，用 legend 判断是「内置」还是「通用」
  const fsRe = /<fieldset>([\s\S]*?)<\/fieldset>/g;
  let fm;
  while ((fm = fsRe.exec(html))) {
    const seg = fm[1];
    const legendM = seg.match(/<legend>([^<]*)<\/legend>/);
    const legend = legendM ? stripTags(legendM[1]) : '';
    // 「前置Mod」段：包含 “的前置Mod:”
    if (/前置Mod/.test(seg)) {
      const ulRe = /<ul>([\s\S]*?)<\/ul>/g;
      let um;
      while ((um = ulRe.exec(seg))) {
        const liRe = /<li>\s*<a[^>]*href="\/class\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/g;
        let lm;
        while ((lm = liRe.exec(um[1]))) {
          const pid = lm[1];
          const name = stripTags(lm[2]);
          const key = 'p:' + pid;
          if (seen.has(key)) continue;
          seen.add(key);
          prereqs.push({ id: pid, name, url: `https://www.mcmod.cn/class/${pid}.html`, scope: legend || '' });
        }
      }
    }
    // 「依赖XXX的Mod」段（被依赖）
    if (/依赖.*的Mod/.test(legend) || /这些Mod需要安装/.test(seg)) {
      const ulRe = /<ul>([\s\S]*?)<\/ul>/g;
      let um;
      while ((um = ulRe.exec(seg))) {
        const liRe = /<li>\s*<a[^>]*href="\/class\/(\d+)\.html"[^>]*>([\s\S]*?)<\/a>\s*<\/li>/g;
        let lm;
        while ((lm = liRe.exec(um[1]))) {
          const key = 'd:' + lm[1];
          if (seen.has(key)) continue;
          seen.add(key);
          dependents.push({ id: lm[1], name: stripTags(lm[2]), url: `https://www.mcmod.cn/class/${lm[1]}.html`, scope: legend || '' });
        }
      }
    }
  }

  // 提取标题（中文名）
  let title = '';
  const tM = html.match(/<title>([^<]*)<\/title>/);
  if (tM) title = stripTags(tM[1]).replace(/[-_]\s*MC百科.*$/, '').trim();

  return { ok: true, id, url, title, prereqs, dependents };
}

// 给搜索结果批量补「前置 Mod」数量（并发受限，防止被封）
// 只处理前 N 条，避免一次抓太多页面
async function attachPrereqs(items, limit = 8) {
  const slice = items.slice(0, limit);
  await Promise.allSettled(slice.map(async (it) => {
    try {
      const r = await fetchPrereqs(it.id, it.kind === 'modpack' ? 'modpack' : 'class');
      it.prereqCount = r.prereqs.length;
      it.prereqNames = r.prereqs.map((p) => p.name);
    } catch { it.prereqCount = -1; }
  }));
  return items;
}

module.exports = { searchMcmod, fetchPrereqs, attachPrereqs, parseSearchResults };
