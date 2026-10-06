// 自动拆分自 main.js —— launchBlock
const { ipcMain, dialog, shell } = require('electron');

module.exports = function register(ctx) {
  const { loadConfig, LAUNCHER_DATA, getMLC, ensureJava, modpack, path, fs, activeAccount, applyFastLaunch, mergeVersionJson, resolveBaseMcVersion, extractNatives, repairCorruptLibraries, trimMemoryLater } = ctx;
  const __win = () => ctx.getWin();

// ---------- 启动游戏 ----------
ipcMain.handle('mc:launch', async (_e, opts) => {
  const cfg = loadConfig();
  const version = opts.version || cfg.version;
  const send = (level, msg) => __win().webContents.send('mc:log', { level, msg: String(msg) });

  // 实例独立启动设置：覆盖全局（仅对独立实例生效）
  const ov = (cfg.instanceOverrides && version && cfg.instanceOverrides[version]) || {};
  if (ov.maxMemory) cfg.maxMemory = ov.maxMemory;
  if (ov.autoJava !== undefined) cfg.autoJava = ov.autoJava;
  if (ov.jvmArgs !== undefined && opts.jvmArgs === undefined) opts = Object.assign({}, opts, { jvmArgs: ov.jvmArgs });
  if (ov.gameArgs !== undefined) cfg.gameArgs = ov.gameArgs;

  // 自动准备 Java
  let javaPath = opts.javaPath || ov.javaPath || cfg.javaPath;
  if (cfg.autoJava && !javaPath && version) {
    try {
      // 解析实例的真实基础 MC 版本（读取 inheritsFrom 链），避免从实例名误判 Java 版本
      const baseMc = resolveBaseMcVersion(cfg.mcDir, version);
      javaPath = await ensureJava(
        baseMc || version,
        cfg.mcDir,
        (got, total) => __win().webContents.send('mc:progress', { type: 'Java下载', task: got, total }),
        (m) => send('debug', m)
      );
    } catch (e) {
      send('debug', '自动下载 Java 失败：' + e.message + '，将尝试系统 Java');
    }
  }

  const { Client } = getMLC();
  launcher = new Client();
  // 启动提速：MCLC 每次启动都会对全部 assets（1.4 万+ 文件）逐个计算 SHA1 校验，
  // 未变时纯属浪费（实测 25~50 秒）。这里把 checkSum 打补丁：对已校验过且自上次
  // 校验后未被修改的 assets / libraries，直接返回 true，跳过重复哈希。
  applyFastLaunch(launcher, cfg.mcDir, send);
  launcher.on('debug', (m) => send('debug', m));
  launcher.on('data', (m) => send('data', m));
  launcher.on('progress', (p) => __win().webContents.send('mc:progress', p));
  launcher.on('close', (code) => {
    __win().webContents.send('mc:close', code);
    // 游戏已关闭：清理启动器闲置内存（回收 V8/GC 后的工作集），降低后台占用
    trimMemoryLater();
  });

  // 启动前自检：扫描该版本依赖的 libraries，修复损坏的 jar（下载中断会导致 zip 损坏，游戏直接崩溃）
  if (version) {
    try {
      await repairCorruptLibraries(cfg.mcDir, version, send);
    } catch (e) {
      send('debug', '库完整性自检失败（已跳过）：' + (e && e.message ? e.message : e));
    }
  }

  let auth;
  try {
    // 优先使用微软正版账号（当前激活的）
    const acc = activeAccount(cfg);
    if (acc && acc.accessToken && acc.uuid) {
      // 令牌可能已过期：这里不主动验证，启动失败会提示重新登录
      auth = {
        access_token: acc.accessToken,
        client_token: acc.uuid,
        uuid: acc.uuid,
        name: acc.name,
        user_properties: '{}'
      };
    } else {
      const { Authenticator } = getMLC();
      auth = await Authenticator.getAuth(opts.username || cfg.username);
    }
  } catch (e) {
    return { ok: false, error: '离线认证失败：' + (e && e.message ? e.message : e) };
  }

  // 若选中的是独立实例（versions/<id>/<id>.json 存在且其顶层为 inheritsFrom 或含 mods），
  // 用 custom + gameDirectory 启动，否则 mods/光影包不会生效。
  const fs = require('fs');
  const pathMod = require('path');
  const instDir = pathMod.join(cfg.mcDir, 'versions', version);
  const instJson = pathMod.join(instDir, version + '.json');
  let isInstance = false;
  if (fs.existsSync(instJson)) {
    try {
      const prof = JSON.parse(fs.readFileSync(instJson, 'utf8'));
      // 有 inheritsFrom（Fabric/Forge 实例）或自带 mods 目录→当成独立实例启动
      isInstance = !!prof.inheritsFrom;
    } catch {}
  }
  if (!isInstance && fs.existsSync(pathMod.join(instDir, 'mods'))) isInstance = true;

  const launchOpts = {
    authorization: auth,
    root: cfg.mcDir,
    version: isInstance
      ? { number: version, type: 'release', custom: version }
      : { number: version, type: 'release' },
    memory: { max: String(opts.maxMemory || cfg.maxMemory), min: '1024' },
    javaPath: javaPath || undefined
  };
  // 自定义 JVM / 游戏参数
  const customArgs = String(opts.jvmArgs !== undefined ? opts.jvmArgs : cfg.jvmArgs || '').trim();
  if (customArgs) {
    launchOpts.customArgs = customArgs.split(/\s+/).filter(Boolean);
  }
  // 额外游戏参数（附加到游戏命令行）
  const gameArgs = String(cfg.gameArgs || '').trim();
  if (gameArgs) {
    launchOpts.gameArgs = gameArgs.split(/\s+/).filter(Boolean);
  }
  if (isInstance) {
    launchOpts.overrides = { gameDirectory: instDir };
    // 将实例 JSON 与其 inheritsFrom 链的基座版本合并成一个完整 JSON，
    // 因为 MCLC 不自动解析 inheritsFrom，否则会缺少基座的库（jopt-simple 等）导致启动失败。
    try {
      const merged = mergeVersionJson(cfg.mcDir, version);
      if (merged) {
        const mergedPath = pathMod.join(LAUNCHER_DATA, 'meta', `${version}.json`);
        fs.mkdirSync(pathMod.dirname(mergedPath), { recursive: true });
        fs.writeFileSync(mergedPath, JSON.stringify(merged, null, 2));
        launchOpts.overrides.versionJson = mergedPath;
      }
    } catch (e) {
      send('debug', '合并版本 JSON 失败（将直接启动）：' + e.message);
    }
  }

  // 提取原生库（.dll）到游戏目录（MCLC 对 MC ≥1.19 不再自己提取，否则会因缺少
  // lwjgl_opengl.dll 等直接崩溃退出）
  try {
    const cwdNatives = isInstance ? instDir : cfg.mcDir;
    const nativesDir = await extractNatives(cfg.mcDir, version, cwdNatives, send);
    if (nativesDir) {
      launchOpts.overrides = launchOpts.overrides || {};
      launchOpts.overrides.natives = nativesDir;
    }
  } catch (e) {
    send('debug', '原生库提取失败（已跳过）：' + (e && e.message ? e.message : e));
  }

  try {
    await launcher.launch(launchOpts);
    // 启动成功：持久化本次已验证的文件集合，下次启动直接跳过这些校验
    try { require('minecraft-launcher-core/components/handler').prototype.__fastSave && require('minecraft-launcher-core/components/handler').prototype.__fastSave(); } catch {}
    return { ok: true };
  } catch (err) {
    // 即使启动失败也保存已校验结果（下次仍可复用未变文件的校验）
    try { require('minecraft-launcher-core/components/handler').prototype.__fastSave && require('minecraft-launcher-core/components/handler').prototype.__fastSave(); } catch {}
    const raw = String(err && err.message ? err.message : err);
    return { ok: false, error: humanizeError(raw) };
  }
});

// 把原始报错翻译成人话
function humanizeError(raw) {
  const r = raw.toLowerCase();
  if (r.includes('enoent') && r.includes('java')) return '未找到 Java。请到「设置」里指定 java.exe，或开启自动下载 Java。';
  if (r.includes('version') && (r.includes('not found') || r.includes('does not exist')))
    return '找不到所选版本，可能尚未下载完成。请到「版本选择」重新下载后再试。';
  if (r.includes('eacces') || r.includes('permission')) return '文件权限不足，请尝试以管理员身份运行，或换一个游戏目录。';
  if (r.includes('out of memory') || r.includes('heap')) return '内存不足，请在「设置」里调低最大内存分配。';
  if (r.includes('etimedout') || r.includes('enotfound') || r.includes('econnrefused'))
    return '网络连接失败，请检查网络或切换下载源。';
  if (r.includes('missing') && r.includes('asset')) return '游戏资源文件缺失，请在「版本选择」重新下载该版本。';
  if (r.includes('unsupportedclassversion') || r.includes('class file version'))
    return 'Java 版本不对：该游戏版本需要更新的 Java。请到「设置」里手动指定正确的 java.exe（如 1.17+ 需 Java 17，1.20.5+/1.21+ 需 Java 21），或开启「自动下载 Java」。';
  return raw;
}


};
