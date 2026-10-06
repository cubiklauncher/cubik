# Cubik 功能补全清单（本轮）

目标：把审计出的 8 项缺口全部实现（2026-10-06 完成）。

1. [x] 存档（世界）管理：列出 saves/ 世界、备份为 zip、恢复、删除到回收站、打开文件夹
2. [x] 实例级备份/还原：打包整个 versions/<实例> 目录为 zip → 还原（先备份现有再覆盖）
3. [x] 资源包管理：Modrinth project_type:resourcepack 下载 + 本地 resourcepacks 管理
4. [x] 游戏内皮肤/披风设置：正版账号上传皮肤（multipart）、披风启停
5. [x] Mod 更新检查：按 sha1 向 Modrinth version_files/update 批量查最新版本，一键更新
6. [x] 游戏截图管理：浏览/打开/定位 screenshots/
7. [x] 一键导入官方启动器版本：从 %APPDATA%\.minecraft\versions 复制已有版本
8. [x] 多实例独立 Java/内存配置：per-instance 覆盖全局（instanceOverrides）

验证：check.js 全过；GUI 自测 13 页/12 导航；data 页 worldItems=2、instItems=3；rpack 后端搜索返回正常。
