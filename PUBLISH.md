# Cubik 发布指引（GitHub）

本文件说明如何把 Cubik 发布到 GitHub 并启用自动更新。

## 一、前置

- 安装 Git：https://git-scm.com/download/win
- 安装 GitHub CLI（gh）：https://cli.github.com/  （或手动在网页建仓库）
- 拥有 GitHub 账号

## 二、改常量（一次即可）

编辑 `src/constants.js`，把占位符改成你的真实仓库：

```js
const OFFICIAL_SITE = 'https://github.com/<你的用户名>/cubik';
const REPO_URL      = 'https://github.com/<你的用户名>/cubik';
const UPDATE_REPO   = '<你的用户名>/cubik';   // 关键：检查更新用，格式 owner/repo
```

> ⚠️ `UPDATE_REPO` 必须是 `用户名/仓库名` 格式，否则「检查更新」会失败。

## 三、初始化并推送（命令行）

```powershell
cd D:\mc-launcher
git init
git add .
git commit -m "first commit: Cubik v1.0.8"
git branch -M main
git remote add origin https://github.com/<你的用户名>/cubik.git
git push -u origin main
```

或用 gh 一步建仓库并推送：

```powershell
cd D:\mc-launcher
gh auth login          # 按提示登录
gh repo create cubik --public --source=. --push
```

## 四、发布一个版本（触发自动打包）

推送一个 tag 即可自动编译出 exe 并创建 Release：

```powershell
git tag v1.0.8
git push origin v1.0.8
```

GitHub Actions（`.github/workflows/release.yml`）会自动：
1. 在 Windows 环境编译 nsis + portable
2. 上传到 Release（含更新说明）
3. 启动器内的「检查更新」即可读到该版本

> 在仓库的 Actions 页面可查看构建进度，首次构建约 5～10 分钟。

## 五、验证自动更新

1. 装一个旧版本（比如 v1.0.7）
2. 发一个新 tag（比如 v1.0.8）
3. 打开旧版启动器 → 关于页 → 「检查更新」，应能发现新版本
4. 点「⚡ 一键更新」会自动下载安装包、启动安装程序并退出

## 六、本地打包（不依赖 CI）

```powershell
cd D:\mc-launcher
$env:ELECTRON_BUILDER_BINARIES_MIRROR="https://registry.npmmirror.com/-/binary/electron-builder-binaries/"
npx electron-builder --win nsis portable
```

产物在 `dist/` 目录。

## 七、发布前检查清单

- [ ] `src/constants.js` 的 `UPDATE_REPO` / `REPO_URL` / `OFFICIAL_SITE` 已改成真实仓库
- [ ] `src/constants.js` 的 `APP_VERSION` 与 `package.json` 的 `version` 一致
- [ ] 法律文件（LICENSE / PRIVACY / TERMS / DISCLAIMER / THIRD-PARTY-NOTICES）中的作者信息正确
- [ ] 已购买/拥有正版 Minecraft（法律合规）
- [ ] 不含任何游戏本体文件
