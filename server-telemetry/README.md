# Cubik 使用统计后端（Cloudflare Worker + D1）

匿名统计 Cubik 启动器的使用情况，并提供官网公开数字 + 管理员后台。

## 数据与隐私
- 仅采集：应用版本、平台(win/mac/linux)、架构、是否首次启动、匿名随机设备 ID、粗粒度国家码。
- **不采集**：用户名、微软账号、原始 IP、文件路径、设备指纹。
- 设备 ID 为本地生成的随机 UUID，用户删除本地配置即彻底断开。
- 启动器设置中可关闭统计（`launcher-config.json` 里 `"telemetry": false`）。

## 接口
| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/report` | 启动器上报（匿名） |
| GET  | `/stats`  | 公开统计（官网展示，CORS 开放） |
| GET  | `/admin`  | 详细统计（需 `Authorization: Bearer <ADMIN_TOKEN>`） |

## 部署步骤
```bash
npm i -g wrangler
wrangler login

# 1. 创建数据库，记下输出的 database_id
wrangler d1 create cubik-telemetry

# 2. 把 database_id 填进 wrangler.toml
#    [[d1_databases]] database_id = "..."

# 3. 建表（远程）
wrangler d1 execute cubik-telemetry --file=./schema.sql --remote

# 4. 设置后台密码（自定义一个强令牌）
wrangler secret put ADMIN_TOKEN

# 5. 部署
wrangler deploy
```

部署完成后会得到一个地址，例如：
`https://cubik-telemetry.<你的子域>.workers.dev`

## 接入
1. **启动器**：把 `src/telemetry.js` 里的 `TELEMETRY_ENDPOINT` 改成上面的地址 → 发新版。
2. **官网**：在 `js/main.js` 里把统计展示区的 `API` 改成同一地址，即可显示公开数字。
3. **后台**：打开 `admin.html`（可直接双击本地文件，或访问 `https://.../admin.html`），
   填入 `ADMIN_TOKEN` 即可查看日活 / 版本 / 平台 / 地区分布。

## 成本
Cloudflare 免费额度：Worker 每天 10 万请求、D1 每天 500 万行读 + 10 万行写，个人项目完全够用。
