# Cubik 功能补全清单（本轮）

目标：把审计出的 8 项缺口全部实现。

1. [ ] 存档（世界）管理：列出 saves/ 世界、备份为 zip、恢复、删除到回收站、打开文件夹
2. [ ] 实例级备份/还原：打包整个 versions/<实例> 目录为 zip → 还原（先备份现有再覆盖）
3. [ ] 资源包管理：Modrinth project_type:resourcepack 下载 + 本地 resourcepacks 管理
4. [ ] 游戏内皮肤/披风设置：用 auth.js 已拿到的 skins/capes 数据做 UI（上传皮肤）
5. [ ] Mod 更新检查：列出实例 mods 的更新版本（Modrinth 按 hash 查最新版本）
6. [ ] 游戏截图管理：浏览/打开/另存 screenshots/
7. [ ] 一键导入官方启动器版本：从 %APPDATA%\.minecraft\versions 复制已有版本
8. [ ] 多实例独立 Java/内存配置：per-instance 覆盖全局

完成后：check.js 全过 → bump 版本 → 重打包 → 记 memory
