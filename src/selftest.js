// 自动化自测：设置 CUBIK_SELFTEST=1 时运行（用于开发期回归验证）。
// 由 main.js 的 createWindow 在窗口就绪后调用：attachSelfTest(win, app)。
// 逻辑与原 main.js 内联版本完全一致，仅做搬家，未改任何行为。
const path = require('path');
const fs = require('fs');

function attachSelfTest(win, app) {
  win.once('ready-to-show', async () => {
    if (!process.env.CUBIK_SELFTEST) return;
    if (process.env.CUBIK_SELFTEST === 'manifest') {
      try {
        const out = await win.webContents.executeJavaScript(`(async () => {
          const r1t = performance.now();
          const r1 = await window.api.versionManifest({ type: 'release' });
          const ms1 = Math.round(performance.now() - r1t);
          const r2t = performance.now();
          const r2 = await window.api.versionManifest({ type: 'release' });
          const ms2 = Math.round(performance.now() - r2t);
          const srcs = await window.api.sourceList();
          return JSON.stringify({ first:{ok:r1.ok,n:r1.list?r1.list.length:0,ms:ms1}, cached:{ok:r2.ok,n:r2.list?r2.list.length:0,ms:ms2}, sources:srcs.map(s=>s.key) });
        })()`);
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), out);
      } catch (e) { try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'ERR ' + e.message); } catch {} }
      setTimeout(() => app.quit(), 300);
      return;
    }
    if (process.env.CUBIK_SELFTEST === 'newserver') {
      try {
        const out = await win.webContents.executeJavaScript(`(async () => {
          const r = {};
          try {
            const nav = document.querySelector('.nav-item[data-page="server"]');
            if (nav) { nav.click(); await new Promise(x => setTimeout(x, 700)); }
            r.listShown = document.getElementById('srv-list-card').style.display !== 'none';
            const nb = document.getElementById('btn-srv-new');
            r.btnExists = !!nb;
            r.btnText = nb ? nb.textContent : '';
            let clicked = false;
            if (nb) {
              nb.addEventListener('click', function onclk(){ clicked = true; }, true);
              nb.click();
              await new Promise(x => setTimeout(x, 300));
            }
            r.handlerFired = clicked;
            // 捕获点击处理函数内部的异常（防止处理器抛错而不弹出提示）
            try { await window.__doNewServer(); r.awaitOk = true; } catch (e) { r.awaitErr = String(e && e.message); }
            r.dirFilled = (document.getElementById('in-srv-dir') || {}).value || '';
            r.listStayed = document.getElementById('srv-list-card').style.display !== 'none';
            r.mvHidden = document.getElementById('srv-manage-view').style.display === 'none';
            r.optsOpen = !!(document.getElementById('srv-options') || {}).open;
            r.verOpts = document.querySelectorAll('#sel-srv-mcver option').length;
            r.verVal = (document.getElementById('sel-srv-mcver') || {}).value || '';
            r.verDisabled = !!(document.getElementById('sel-srv-mcver') || {}).disabled;
            r.logTail = (document.getElementById('log-box') || {}).textContent ? document.getElementById('log-box').textContent.slice(-600) : '';
            // 直接调 API 看是否报错
            try {
              const vr = await window.api.serverVersions({ type: 'vanilla' });
              r.apiOk = !!(vr && vr.ok);
              r.apiN = vr && vr.list ? vr.list.length : -1;
              r.apiErr = (vr && vr.error) || '';
            } catch (e) { r.apiThrow = String(e && e.message); }
            // 再等 2.5s，看版本下拉是否从“加载中”变成真实列表
            await new Promise(x => setTimeout(x, 2500));
            r.verOpts2 = document.querySelectorAll('#sel-srv-mcver option').length;
            r.verVal2 = (document.getElementById('sel-srv-mcver') || {}).value || '';
            r.verDisabled2 = !!(document.getElementById('sel-srv-mcver') || {}).disabled;
            r.logTail2 = (document.getElementById('log-box') || {}).textContent ? document.getElementById('log-box').textContent.slice(-400) : '';
          } catch (e) { r.err = String(e && e.stack || e); }
          return JSON.stringify(r);
        })()`);
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), out);
        console.log('SELFTEST_NEWSRV ' + out);
      } catch (e) { try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'ERR ' + e.message); } catch {} }
      setTimeout(() => app.quit(), 400);
      return;
    }
    if (process.env.CUBIK_SELFTEST === 'launchcheck') {
      try {
        await new Promise((r) => setTimeout(r, 2500));
        const out = await win.webContents.executeJavaScript(`(async () => {
          const list = await window.api.listVersions();
          const results = [];
          for (const v of list) {
            const r = { version: v };
            try {
              const info = await window.api.versionInfo({ name: v });
              r.info = info.ok ? { loader: info.info.loader, mc: info.info.mcVersion, mods: info.info.mods, libs: info.info.libraries, hasJar: info.info.hasJar } : { err: info.error };
              const libs = await window.api.libraries({ name: v });
              if (libs.ok) {
                const missing = libs.list.filter(x => !x.present);
                r.libsTotal = libs.list.length;
                r.libsMissing = missing.length;
              }
            } catch (e) { r.err = e.message; }
            results.push(r);
          }
          return JSON.stringify(results);
        })()`);
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), out);
      } catch (e) { try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'ERR ' + e.message); } catch {} }
      setTimeout(() => app.quit(), 300);
      return;
    }
    if (process.env.CUBIK_SELFTEST === 'trash') {
      try {
        await new Promise((r) => setTimeout(r, 2500));
        const out = await win.webContents.executeJavaScript(`(async () => {
          const res = {};
          const t = await window.api.trashList();
          res.trash = { ok: t.ok, count: t.list ? t.list.length : 0, sample: t.list && t.list[0] ? t.list[0].origName : null };
          document.querySelector('.nav-item[data-page="versions"]').click();
          await new Promise(r => setTimeout(r, 1500));
          const btn = document.getElementById('btn-trash-open');
          res.trashBtnExists = !!btn;
          if (btn) { btn.click(); await new Promise(r => setTimeout(r, 1500)); }
          const panel = document.getElementById('trash-panel');
          res.panelShown = panel ? panel.style.display !== 'none' : false;
          res.trashItems = document.querySelectorAll('#trash-list li:not(.empty)').length;
          res.verItems = document.querySelectorAll('#version-list li:not(.empty)').length;
          return JSON.stringify(res);
        })()`);
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), out);
      } catch (e) { try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'ERR ' + e.message); } catch {} }
      setTimeout(() => app.quit(), 300);
      return;
    }
    if (process.env.CUBIK_SELFTEST === 'homever') {
      try {
        await new Promise((r) => setTimeout(r, 2500));
        const out = await win.webContents.executeJavaScript(`(async () => {
          const res = {};
          document.querySelector('.nav-item[data-page="home"]').click();
          await new Promise(r => setTimeout(r, 1200));
          const lv = document.getElementById('home-version');
          const lb = document.getElementById('btn-launch');
          res.home = {
            active: document.getElementById('page-home').classList.contains('active'),
            versionText: lv ? lv.textContent : null,
            launchBtn: lb ? lb.textContent.trim() : null,
            launchDisabled: lb ? lb.disabled : null,
            username: document.getElementById('in-username') ? document.getElementById('in-username').value : null,
            memVal: document.getElementById('in-mem') ? document.getElementById('in-mem').value : null
          };
          res.navOrder = [...document.querySelectorAll('.nav-item')].map(b => b.dataset.page);
          document.querySelector('.nav-item[data-page="versions"]').click();
          await new Promise(r => setTimeout(r, 2500));
          const vlist = document.getElementById('version-list');
          res.versions = {
            active: document.getElementById('page-versions').classList.contains('active'),
            itemCount: vlist ? vlist.querySelectorAll('li:not(.empty)').length : 0,
            firstText: vlist && vlist.querySelector('li') ? vlist.querySelector('li').textContent.trim().slice(0,100) : null,
            empty: vlist ? !!vlist.querySelector('.empty') : null
          };
          document.querySelector('.nav-item[data-page="vanilla"]').click();
          await new Promise(r => setTimeout(r, 3000));
          const vcards = document.querySelectorAll('#van-card-list .ver-card');
          res.vanilla = {
            active: document.getElementById('page-vanilla').classList.contains('active'),
            cardCount: vcards.length,
            firstCard: vcards[0] ? vcards[0].textContent.trim().slice(0,60) : null,
            cacheHint: document.getElementById('van-cache-hint') ? document.getElementById('van-cache-hint').textContent : null
          };
          // 下载中心（新增）
          try {
            res.dl = {};
            res.dl.nav = !!document.querySelector('.nav-item[data-page="downloads"]');
            res.dl.fns = [typeof dlStart, typeof dlUpdate, typeof dlFinish, typeof dlRender, typeof dlClearFinished].join(',');
            document.querySelector('.nav-item[data-page="downloads"]').click();
            await new Promise(r => setTimeout(r, 300));
            res.dl.pageActive = document.getElementById('page-downloads').classList.contains('active');
            res.dl.emptyText = (document.getElementById('dl-task-list').textContent || '').trim().slice(0, 20);
            const tid = dlStart('测试：安装整合包', 'pack', null);
            dlUpdate(tid, { pct: 37, done: 370, total: 1000, label: '测试：安装整合包' });
            await new Promise(r => setTimeout(r, 120));
            res.dl.taskCount = document.querySelectorAll('#dl-task-list .dl-task').length;
            res.dl.taskPct = (document.querySelector('#dl-task-list .dl-task-pct') || {}).textContent;
            res.dl.taskPhase = (document.querySelector('#dl-task-list .dl-task-phase') || {}).textContent;
            res.dl.badge = document.getElementById('nav-dl-badge').textContent;
            dlFinish(tid, { ok: true, label: '测试：安装整合包' });
            await new Promise(r => setTimeout(r, 120));
            res.dl.done = document.querySelectorAll('#dl-task-list .dl-task.done').length;
            const tid2 = dlStart('测试：下载 Mod', 'mod', function(){});
            dlFinish(tid2, { ok: false, error: '网络超时' });
            await new Promise(r => setTimeout(r, 120));
            res.dl.err = document.querySelectorAll('#dl-task-list .dl-task.err').length;
            res.dl.retryBtn = document.querySelectorAll('#dl-task-list [data-dl-retry]').length;
            res.dl.summary = document.getElementById('dl-summary').textContent;
            dlClearFinished();
            await new Promise(r => setTimeout(r, 120));
            res.dl.cleared = document.querySelectorAll('#dl-task-list .dl-task').length;
            document.querySelector('.nav-item[data-page="home"]').click();
          } catch (e) { res.dlErr = e.message; }
          return JSON.stringify(res);
        })()`);
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), out);
        // 截图版本管理页
        await win.webContents.executeJavaScript(`document.querySelector('.nav-item[data-page="versions"]').click()`);
        await new Promise((r) => setTimeout(r, 1500));
        const png = await win.webContents.capturePage();
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-ver-shot.png'), png.toPNG());
        // 截图下载中心页（造几个任务）
        try {
          await win.webContents.executeJavaScript(`
            (function(){
              document.querySelector('.nav-item[data-page="downloads"]').click();
              dlTasks.length = 0;
              var a = dlStart('安装整合包：科技空岛', 'pack', null); dlUpdate(a,{pct:63,done:630,total:1000,label:'安装整合包：科技空岛'});
              var b = dlStart('下载 Mod：JEI 物品管理器', 'mod', null); dlFinish(b,{ok:true,label:'下载 Mod：JEI 物品管理器'});
              var c = dlStart('下载光影包：BSL Shaders', 'shader', function(){}); dlFinish(c,{ok:false,error:'连接超时，请重试'});
              dlRender();
            })()
          `);
          await new Promise((r) => setTimeout(r, 600));
          const pngDl = await win.webContents.capturePage();
          require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-dl-shot.png'), pngDl.toPNG());
          await win.webContents.executeJavaScript(`dlTasks.length = 0; dlRender(); document.querySelector('.nav-item[data-page="home"]').click();`);
        } catch (e) {}
      } catch (e) { try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'ERR ' + e.message); } catch {} }
      setTimeout(() => app.quit(), 300);
      return;
    }
    if (process.env.CUBIK_SELFTEST === 'launch') {
      // 测试启动游戏，捕获错误
      try {
        await new Promise((r) => setTimeout(r, 2000));
        const out = await win.webContents.executeJavaScript(`(async () => {
          const list = await window.api.listVersions();
          if (!list.length) return 'NO_VERSIONS';
          const v = list.find(x => /Fabulously/i.test(x)) || list[0];
          const res = await window.api.launch({ version: v, username: 'Steve', maxMemory: '2048', javaPath: '' });
          await new Promise(r => setTimeout(r, 8000));
          const logs = document.getElementById('log-box') ? document.getElementById('log-box').textContent.slice(-3000) : '';
          return JSON.stringify({ version: v, res, logs });
        })()`);
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), out);
      } catch (e) { try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'ERR ' + e.message); } catch {} }
      setTimeout(() => app.quit(), 400);
      return;
    }
    try {
      await new Promise((r) => setTimeout(r, 2500));
      const state = await win.webContents.executeJavaScript(`(async () => {
        document.querySelector('.nav-item[data-page="server"]').click();
        await new Promise(r => setTimeout(r, 4000));
        const srv = {
          lan: document.getElementById('net-lan').textContent,
          pub: document.getElementById('net-pub').textContent,
          port: document.getElementById('net-port').textContent,
          online: document.getElementById('net-online').textContent,
          pages: document.querySelectorAll('.page').length,
          navs: document.querySelectorAll('.nav-item').length
        };
        // 测试 Mod 页：搜索结果点卡片 -> 跳到详情页
        document.querySelector('.nav-item[data-page="mod"]').click();
        // 轮询等待卡片出现（最多 12s）
        let cards = [];
        for (let i = 0; i < 24; i++) {
          await new Promise(r => setTimeout(r, 500));
          cards = document.querySelectorAll('#mod-grid .pack-card');
          if (cards.length) break;
        }
        if (cards.length) cards[0].click();
        await new Promise(r => setTimeout(r, 4000));
        srv.modCards = cards.length;
        srv.detailActive = document.getElementById('page-detail').classList.contains('active');
        srv.detailTitle = document.getElementById('detail-title').textContent;
        srv.detailVers = document.querySelectorAll('#detail-ver-list li').length;
        srv.targetRowShown = document.getElementById('detail-mod-target-row').style.display !== 'none';
        srv.targetOpts = document.querySelectorAll('#sel-detail-target option').length;
        srv.installBtn = document.getElementById('btn-detail-install').textContent;
        srv.detailClasses = document.getElementById('page-detail').className;
        srv.activePages = [...document.querySelectorAll('.page.active')].map(p => p.id).join(',');
        // 新增功能核对
        srv.accountCard = !!document.getElementById('btn-ms-login');
        srv.jvmArgsInput = !!document.getElementById('in-jvmargs');
        srv.srvGamemode = !!document.getElementById('sel-srv-gamemode');
        srv.legalLinks = document.querySelectorAll('.legal-link').length;
        srv.tutCollapse = document.querySelectorAll('.tut-collapse').length;
        srv.homeAvatar = !!document.getElementById('home-avatar');
        srv.acctList = !!document.getElementById('acct-list');
        srv.srvTypeForge = !!document.querySelector('#sel-srv-type option[value="forge"]');
        srv.tunnelCard = !!document.getElementById('btn-tun-start');
        srv.autoUpdBtn = true;
        // 新增：服务器存档备份卡
        srv.srvwCard = !!document.getElementById('btn-srvw-backup');
        srv.srvwList = !!document.getElementById('srvw-list');
        srv.srvAuto = !!document.getElementById('chk-auto-backup');
        srv.srvUpdCard = !!document.getElementById('btn-srvu-check');
        srv.srvModCard = !!document.getElementById('btn-srvm-search');
        srv.srvModListEl = !!document.getElementById('srvm-list');
        srv.srvListCard = !!document.getElementById('srv-list-box');
        srv.srvListNewBtn = !!document.getElementById('btn-srv-new');
        srv.srvManageView = !!document.getElementById('srv-manage-view');
        srv.srvManageBack = !!document.getElementById('btn-srv-manage-back');
        srv.srvManageBtn = !!document.querySelector('.srv-manage');
        srv.srvManageHiddenByDefault = document.getElementById('srv-manage-view').style.display === 'none';
        srv.srvNewDirBtn = !!document.getElementById('btn-srv-newdir');
        srv.srvPickBtn = !!document.getElementById('btn-srv-pick');
        try {
          const sl = await window.api.serverList();
          srv.srvListOk = !!(sl && sl.ok);
          srv.srvListN = sl && sl.list ? sl.list.length : -1;
          srv.srvListActive = sl && sl.activeServerId;
        } catch (e) { srv.srvListErr = String(e && e.message); }
        try {
          const mr = await window.api.srvModList({});
          srv.srvModOk = !!(mr && mr.ok);
          srv.srvModType = mr && mr.type;
          srv.srvModCount = mr && mr.list ? mr.list.length : -1;
        } catch (e) { srv.srvModErr = String(e && e.message); }
        srv.srvUpdApply = !!document.getElementById('btn-srvu-apply');
        // 资源列表加载计时（验证不再被中文名爬取阻塞）
        try {
          const tp = performance.now();
          const pr = await window.api.packTop({ type: 'modpack', offset: 0 });
          srv.packTopMs = Math.round(performance.now() - tp);
          srv.packTopN = pr && pr.list ? pr.list.length : 0;
        } catch (e) { srv.packTopMs = -1; }
        // 中文搜索优化验证（含中文时应能命中）
        try {
          const cr = await window.api.searchAll({ kind: 'mod', query: '钠', mcVersion: '1.20.1', loader: 'fabric' });
          srv.zhSearchOk = !!(cr && cr.ok && cr.list && cr.list.length);
          srv.zhSearchFirst = (cr && cr.list && cr.list[0]) ? cr.list[0].title : '';
          srv.zhSearchN = cr && cr.list ? cr.list.length : 0;
        } catch (e) { srv.zhSearchOk = false; }
        // MC百科搜索源验证
        try {
          const mr = await window.api.mcmodSearch({ query: '机械动力', kind: 'mod' });
          srv.mcmodOk = !!(mr && mr.ok && mr.list && mr.list.length);
          srv.mcmodFirst = mr && mr.list && mr.list[0] ? mr.list[0].title : '';
          srv.mcmodN = mr && mr.list ? mr.list.length : 0;
          if (mr && mr.list && mr.list[0]) {
            const pr = await window.api.mcmodPrereqs({ id: mr.list[0].id, kind: mr.list[0].kind });
            srv.mcmodPrereqN = pr && pr.prereqs ? pr.prereqs.length : -1;
            srv.mcmodPrereqFirst = pr && pr.prereqs && pr.prereqs[0] ? pr.prereqs[0].name : '';
          }
        } catch (e) { srv.mcmodOk = false; srv.mcmodErr = String(e && e.message); }
        // mcmod 源下拉选项
        try { srv.mcmodOption = !!document.querySelector('#sel-modsrc option[value="mcmod"]') && !!document.querySelector('#sel-mod-source option[value="mcmod"]'); } catch {}
        // 服务端类型切换 → MC 版本下拉随之更新
        try {
          const nav = document.querySelector('.nav-item[data-page="server"]');
          if (nav) { nav.click(); await new Promise(r => setTimeout(r, 400)); }
          const typeSel = document.getElementById('sel-srv-type');
          const verSel = document.getElementById('sel-srv-mcver');
          const snap = async (t) => {
            typeSel.value = t;
            typeSel.dispatchEvent(new Event('change'));
            await new Promise(r => setTimeout(r, 3500));
            return { n: verSel.options.length, v: verSel.value };
          };
          srv.srvTypePaper = await snap('paper');
          srv.srvTypeNeo = await snap('neoforge');
          srv.srvTypeNeo2 = await snap('neoforge');
          srv.srvTypeForge = await snap('forge');
          srv.srvTypeFabric = await snap('fabric');
        } catch (e) { srv.srvTypeErr = String(e && e.message); }
        // 列表→管理视图切换
        try {
          const rp = document.querySelector('.nav-item[data-page="srvmanage"]');
          if (rp) { rp.click(); await new Promise(r => setTimeout(r, 1500)); }
          srv.navSrvManage = !!document.querySelector('.nav-item[data-page="srvmanage"]');
          srv.navSrvManageLabel = (document.querySelector('.nav-item[data-page="srvmanage"] .ni-label') || {}).textContent || '';
          srv.pageSrvManage = !!document.getElementById('page-srvmanage');
          srv.mgrOwnListBox = !!document.getElementById('srv-mgr-list-box');
          srv.listPageNoManageView = !document.querySelector('#page-server #srv-manage-view');
          srv.mgrOnManagePage = document.getElementById('page-srvmanage').classList.contains('active');
          srv.mgrListItems = document.querySelectorAll('#srv-mgr-list-box .srv-item').length;
          srv.mgrTitle2 = (document.getElementById('srv-manage-title') || {}).textContent || '';
          const mb = document.querySelector('#srv-mgr-list-box .srv-mgr-manage');
          if (mb) { mb.click(); await new Promise(r => setTimeout(r, 1000)); }
          srv.mgrManageBtnWorks = document.getElementById('page-srvmanage').classList.contains('active');
          const nv = document.querySelector('.nav-item[data-page="server"]');
          if (nv) { nv.click(); await new Promise(r => setTimeout(r, 400)); }
          srv.mgrBackedToServerPage = document.getElementById('page-server').classList.contains('active');
        } catch (e) { srv.mgrErr = String(e && e.message); }
        // 「新建服务器」流程：直接去「服务器」页看建服表单默认目录（不应是已有服务器目录）
        try {
          const sp = document.querySelector('.nav-item[data-page="server"]');
          if (sp) { sp.click(); await new Promise(r => setTimeout(r, 1200)); }
          srv.newLandedOnServerPage = document.getElementById('page-server').classList.contains('active');
          srv.newDirFilled = (document.getElementById('in-srv-dir') || {}).value || '';
          srv.newVerSelOpts = document.querySelectorAll('#sel-srv-mcver option').length;
          srv.newServerPageCards = [...document.querySelectorAll('#page-server .card h2, #page-server .card summary')].map(h => h.textContent.trim()).join(' | ');
          srv.newManageHasCreateBtn = !!document.getElementById('btn-srv-goto-create');
        } catch (e) { srv.newErr = String(e && e.message); }
        // 服务器页卡片顺序（验证重排）
        srv.srvCardOrder = [...document.querySelectorAll('#page-server .card, #page-server details.card')].map(function(c){
          var h = c.querySelector('h2') || c.querySelector('.tut-summary') || c.querySelector('summary');
          if (h) return h.textContent.trim().replace(/[\s\S]*$/,'').slice(0,16);
          if (c.classList.contains('srv-status-card')) return '状态';
          if (c.querySelector('label')) return '建服表单';
          return c.className.slice(0,16);
        }).join(' | ');
        // 新增：存档与备份页 / 资源包 / 实例设置
        srv.dataNav = !!document.querySelector('.nav-item[data-page="data"]');
        document.querySelector('.nav-item[data-page="data"]').click();
        await new Promise(r => setTimeout(r, 1500));
        srv.dataPageActive = document.getElementById('page-data').classList.contains('active');
        srv.dataTabs = document.querySelectorAll('.data-tab').length;
        srv.worldItems = document.querySelectorAll('#world-list .data-item').length;
        // 切到实例备份 tab
        const instTab = document.querySelector('[data-dtab="instances"]');
        if (instTab) { instTab.click(); await new Promise(r => setTimeout(r, 1200)); }
        srv.instItems = document.querySelectorAll('#inst-list .data-item').length;
        // 资源包 tab
        srv.rpackNav = !!document.querySelector('.nav-item[data-page="shader"]');
        document.querySelector('.nav-item[data-page="shader"]').click();
        await new Promise(r => setTimeout(r, 300));
        const rpTab = document.querySelector('[data-stab="rpack"]');
        if (rpTab) { rpTab.click(); await new Promise(r => setTimeout(r, 3000)); }
        srv.rpackCards = document.querySelectorAll('#rpack-list .pack-card').length;
        // 新增：全局下载进度条
        srv.gpExists = !!document.getElementById('global-progress');
        document.querySelector('.nav-item[data-page="home"]').click();
        updateGlobalProgress({ pct: 42, done: 420, total: 1000, label: '测试下载' });
        await new Promise(r => setTimeout(r, 150));
        const gpEl = document.getElementById('global-progress');
        srv.gpVisible = gpEl.style.display !== 'none';
        srv.gpLabel = document.getElementById('gp-label').textContent;
        srv.gpPct = document.getElementById('gp-pct').textContent;
        srv.gpWidth = document.getElementById('gp-inner').style.width;
        finishGlobalProgress({ label: '测试下载', ok: true });
        await new Promise(r => setTimeout(r, 150));
        srv.gpDone = gpEl.classList.contains('gp-ok');
        // 服务器页新增元素
        srv.srvStatusBar = !!document.getElementById('srv-status-text');
        srv.srvChatLog = !!document.getElementById('chat-log');
        srv.srvStatusChip = !!document.getElementById('srv-status-online');
        // 服务器控制：玩家管理 + 常用指令
        srv.srvPlayerInput = !!document.getElementById('in-srv-player');
        srv.srvOpBtn = !!document.getElementById('btn-srv-op');
        srv.srvDeopBtn = !!document.getElementById('btn-srv-deop');
        srv.srvKickBtn = !!document.getElementById('btn-srv-kick');
        srv.srvBanBtn = !!document.getElementById('btn-srv-ban');
        srv.quickCmdCount = document.querySelectorAll('#quick-cmds .qcmd').length;
        srv.quickCmdFirst = (document.querySelector('#quick-cmds .qcmd') || {}).getAttribute ? document.querySelector('#quick-cmds .qcmd').getAttribute('data-cmd') : '';
        // 新增：主页版本切换器 / 使用习惯设置 / 最近排序
        srv.homeVerSwitch = !!document.getElementById('home-ver-pop');
        srv.minOnLaunch = !!document.getElementById('in-min-on-launch');
        srv.notifyDone = !!document.getElementById('in-notify-done');
        // 更新进度弹窗
        srv.updModal = !!document.getElementById('upd-modal');
        srv.updModalProg = !!document.getElementById('upd-modal-prog');
        srv.updModalText = !!document.getElementById('upd-modal-text');
        // 模拟打开弹窗并驱动进度
        const um = document.getElementById('upd-modal');
        if (um) {
          um.style.display = 'flex';
          const mp = document.getElementById('upd-modal-prog');
          const mt = document.getElementById('upd-modal-text');
          if (mp) mp.style.width = '55%';
          if (mt) mt.textContent = '下载中 55% (42.0/76.0 MB)';
          srv.updModalVisible = um.style.display !== 'none';
          srv.updModalWidth = mp ? mp.style.width : '';
          um.style.display = 'none';
        }
        window.api.listVersions().then(list => { srv.localVers = list.length; });
        // 模拟最近使用排序
        if (!window.__cfg) window.__cfg = {};
        return JSON.stringify(srv);
      })()`);
      console.log('SELFTEST_STATE ' + state);
      try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'SELFTEST_STATE ' + state); } catch {}
      // 回到主页截图（用于人工核对侧边栏分组/顺序）
      try {
        await win.webContents.executeJavaScript(`document.querySelector('.nav-item[data-page="home"]').click()`);
        await new Promise((r) => setTimeout(r, 700));
        const pngNav = await win.webContents.capturePage();
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-nav-shot.png'), pngNav.toPNG());
      } catch (e) {}
      // 截图：进入服务器管理页
      try {
        // 下载中心截图（先造几个任务）
        await win.webContents.executeJavaScript(`
          (function(){
            document.querySelector('.nav-item[data-page="downloads"]').click();
            try{
              dlTasks.length = 0;
              var a = dlStart('安装整合包：科技空岛', 'pack', null); dlUpdate(a,{pct:63,done:630,total:1000,label:'安装整合包：科技空岛'});
              var b = dlStart('下载 Mod：JEI', 'mod', null); dlUpdate(b,{pct:100,done:1,total:1,label:'下载 Mod：JEI'}); dlFinish(b,{ok:true,label:'下载 Mod：JEI'});
              var c = dlStart('下载光影包：BSL Shaders', 'shader', function(){}); dlFinish(c,{ok:false,error:'连接超时，请重试'});
              dlRender();
            }catch(e){}
          })()
        `);
        await new Promise((r) => setTimeout(r, 700));
        const pngDl = await win.webContents.capturePage();
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-dl-shot.png'), pngDl.toPNG());
      } catch (e) {}
      // 截图：进入服务器管理页
      try {
        await win.webContents.executeJavaScript(`document.querySelector('.nav-item[data-page="srvmanage"]').click()`);
        await new Promise((r) => setTimeout(r, 1500));
        const pngMg = await win.webContents.capturePage();
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-srvmanage.png'), pngMg.toPNG());
        await win.webContents.executeJavaScript(`document.querySelector('.content').scrollTop = 400`);
        await new Promise((r) => setTimeout(r, 500));
        const pngMg2 = await win.webContents.capturePage();
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-srvmanage2.png'), pngMg2.toPNG());
      } catch (e) {}
      // 截图（用于人工核对渲染）—— 切到服务器页
      try {
        await win.webContents.executeJavaScript("document.querySelector('.nav-item[data-page=\"server\"]').click()");
        await new Promise((r) => setTimeout(r, 1000));
        // 滚到“控制”卡片（玩家管理 + 常用指令）
        await win.webContents.executeJavaScript(`
          (function(){
            var cards = document.querySelectorAll('#page-server .card');
            for (var i=0;i<cards.length;i++){
              var h = cards[i].querySelector('h2');
              if (h && /控制/.test(h.textContent)) { cards[i].scrollIntoView({block:'start'}); return true; }
            }
            return false;
          })()
        `);
        await new Promise((r) => setTimeout(r, 800));
        const png = await win.webContents.capturePage();
        require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-srv-shot.png'), png.toPNG());
        // 额外截图1：服务器页顶部（状态 + 建服表单）
        try {
          await win.webContents.executeJavaScript(`document.getElementById('page-server').scrollIntoView({block:'start'}); document.querySelector('.content').scrollTop = 0;`);
          await new Promise((r) => setTimeout(r, 500));
          const pngTop = await win.webContents.capturePage();
          require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-srv-top.png'), pngTop.toPNG());
        } catch (e) {}
        // 额外截图2：服务器页“联机地址→一键邀请→使用说明”区域
        try {
          await win.webContents.executeJavaScript(`document.getElementById('tunnel-card').scrollIntoView({block:'end'});`);
          await new Promise((r) => setTimeout(r, 500));
          const pngBot = await win.webContents.capturePage();
          require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-srv-bot.png'), pngBot.toPNG());
        } catch (e) {}
        // 额外：滚动到服务器存档备份卡并截图
        try {
          await win.webContents.executeJavaScript(`(() => {
            const c = document.getElementById('srv-backup-card');
            if (c) { c.scrollIntoView({ block: 'center' }); return true; }
            return false;
          })()`);
          await new Promise((r) => setTimeout(r, 600));
          const png2 = await win.webContents.capturePage();
          require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-srvw-shot.png'), png2.toPNG());
          // 再滚到服务端自动更新卡
          await win.webContents.executeJavaScript(`(() => {
            const c = document.getElementById('srv-update-card');
            if (c) { c.scrollIntoView({ block: 'center' }); return true; }
            return false;
          })()`);
          await new Promise((r) => setTimeout(r, 500));
          const png3 = await win.webContents.capturePage();
          require('fs').writeFileSync(require('path').join(__dirname, '..', 'tmp-srvu-shot.png'), png3.toPNG());
        } catch (e) {}
      } catch (e) {}
    } catch (e) { console.log('SELFTEST_ERROR ' + e.message); try { require('fs').writeFileSync(require('path').join(__dirname, '..', 'selftest-out.txt'), 'SELFTEST_ERROR ' + e.message); } catch {} }
    setTimeout(() => app.quit(), 2600);
  });
}

module.exports = { attachSelfTest };
