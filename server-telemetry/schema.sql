-- Cubik 使用统计数据库结构（Cloudflare D1 / SQLite）
-- 执行：wrangler d1 execute cubik-telemetry --file=./schema.sql --remote

CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id  TEXT,      -- 匿名随机 UUID（可为空）
  version    TEXT,      -- 应用版本
  platform   TEXT,      -- win32 / darwin / linux
  arch       TEXT,      -- x64 / arm64
  first_run  INTEGER,   -- 1 = 该设备首次启动
  country    TEXT,      -- 粗粒度国家码（来自 Cloudflare，可空）
  day        TEXT,      -- YYYY-MM-DD
  ts         INTEGER,   -- 毫秒时间戳
  os_ver     TEXT,      -- 操作系统大版本（如 10 / 11）
  lang       TEXT,      -- 界面语言（如 zh-CN）
  channel    TEXT       -- 版本渠道（stable / pre）
);

CREATE INDEX IF NOT EXISTS idx_events_day ON events(day);
CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);
CREATE INDEX IF NOT EXISTS idx_events_version ON events(version);

-- 按天 + 版本聚合（加速统计查询）
CREATE TABLE IF NOT EXISTS daily (
  day     TEXT,
  version TEXT,
  count   INTEGER DEFAULT 0,
  PRIMARY KEY (day, version)
);
