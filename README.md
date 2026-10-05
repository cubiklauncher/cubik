<div align="center">

# Cubik

**简洁易用的 Minecraft 启动器**

整合包 / 光影包一键安装 · 原版游戏下载 · 服务器创建管理

</div>

---

## ✨ 功能特性

| 功能 | 说明 |
| --- | --- |
| 🧩 **整合包一键安装** | 从 Modrinth 搜索并安装整合包，自动完成「下载 → 解压 → 装模组 → 装加载器 → 建独立实例」全流程 |
| ⚙️ **全加载器支持** | 自动识别并安装 **Fabric / Forge / NeoForge / 原版**，装完即可启动 |
| ✨ **光影包一键安装** | 搜索热门光影包，一键下载到 `shaderpacks`，游戏内直接启用 |
| 📦 **原版 / 加载器下载** | 正式版 / 快照 / 远古版本一键下载；可选安装 **Fabric / Forge / NeoForge** 加载器，自动补齐依赖库与全部资源文件 |
| 🖥️ **服务器管理** | 创建原版 / Paper / Fabric 服务器，内置 **Aikar 性能调优参数**，支持启停与发送指令 |
| ☕ **Java 自动管理** | 按游戏版本自动匹配并下载对应的 Java 运行时，无需手动配置 |
| 🧠 **内存智能分配** | 根据物理内存推荐合理分配值，滑块调节，避免爆内存或浪费 |
| 🌐 **国内加速** | 内置 BMCLAPI 镜像源，国内下载速度更快 |
| 💎 **液态玻璃界面** | 现代毛玻璃风格 UI，清爽好看 |

## 🚀 快速开始

### 下载使用

1. 从 Releases 下载 `Cubik-x.x.x-x64.exe`（安装版）或 `Cubik-x.x.x-portable.exe`（免安装版）
2. 运行即可。首次使用建议先到「设置」确认游戏目录与下载源（默认 BMCLAPI 国内镜像）

### 从源码运行

```bash
git clone <repo-url>
cd cubik
npm install
npm start
```

> 若 `npm install` 后缺少 Electron，请先清除环境变量 `NODE_ENV`（`NODE_ENV=production` 会导致 npm 跳过 devDependencies），或改用 `npm install --include=dev`。

### 打包

```bash
npm run dist            # 同时生成 NSIS 安装包 + 免安装版
npm run dist:portable   # 只生成免安装版
```

产物输出在 `dist/` 目录。

## 📁 数据目录

| 路径 | 用途 |
| --- | --- |
| `D:\.minecraft` | 游戏目录（可在设置中修改） |
| `D:\CubikLauncher` | 配置、缓存、临时文件 |

> 默认全部放在 D 盘，避免占用系统盘空间。若电脑没有 D 盘，请到「设置」中修改为其他磁盘。

## ❓ 常见问题

**Q：启动时提示找不到 Java？**
A：到「设置」中开启「自动下载 Java」，或手动指定已安装的 `java.exe`。

**Q：整合包装完后在哪里启动？**
A：整合包会作为独立实例出现在「版本选择」页，选中它点「启动游戏」即可，版本之间互不干扰。

**Q：内存应该分配多少？**
A：整合包建议 4G~8G；原版 2G~4G。设置在「设置」页，滑块上方会给出建议值。

**Q：下载很慢？**
A：确认「设置 → 下载源」选择的是「BMCLAPI 国内镜像」。

## ⚖️ 免责声明

- Cubik 是**独立的第三方开源启动器**，与 Mojang Studios / Microsoft **无任何关联**。
- Minecraft 是 Mojang Studios 的商标。
- 本软件**不包含任何游戏本体文件**，仅提供下载与管理工具。
- 请支持购买正版游戏。

## 📜 开源协议

[MIT License](LICENSE)

---

<div align="center">Made with ❤️ for the Minecraft community</div>
