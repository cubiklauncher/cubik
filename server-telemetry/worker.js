// Cubik 使用统计后端 —— Cloudflare Worker + D1 (SQLite)
//
// 接口：
//   POST /report   启动器上报心跳（匿名）
//   GET  /stats    公开统计（官网展示用，CORS 开放）
//   GET  /admin    详细统计（需 Authorization: Bearer <ADMIN_TOKEN>）
//
// 部署：
//   1) npm i -g wrangler && wrangler login
//   2) wrangler d1 create cubik-telemetry           # 记下 database_id
//   3) 把 database_id 填入 wrangler.toml
//   4) wrangler d1 execute cubik-telemetry --file=./schema.sql --remote
//   5) wrangler secret put ADMIN_TOKEN              # 设置后台密码
//   6) wrangler deploy
//
// 环境变量（wrangler.toml [vars] 或 secret）：
//   ADMIN_TOKEN  后台访问令牌
//   ALLOW_ORIGIN 允许的跨域来源，默认 https://cubiklauncher.github.io

const DEFAULT_ORIGIN = 'https://cubiklauncher.github.io';

function cors(origin, allow) {
  const ok = !allow || allow === '*' || origin === allow;
  return {
    'Access-Control-Allow-Origin': ok ? (allow === '*' ? '*' : (origin || allow)) : allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

function json(data, status, extra) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {})
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const allow = env.ALLOW_ORIGIN || DEFAULT_ORIGIN;
    const H = cors(origin, allow);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: H });

    // ---------- 上报 ----------
    if (url.pathname === '/report' && request.method === 'POST') {
      let b;
      try { b = await request.json(); } catch { return json({ error: 'bad json' }, 400, H); }

      const v = String(b.v || '').slice(0, 24) || 'unknown';
      const p = String(b.p || '').slice(0, 16) || 'unknown';
      const a = String(b.a || '').slice(0, 16) || 'unknown';
      const f = b.f ? 1 : 0;
      const d = String(b.d || '').slice(0, 64) || '';
      const ov = String(b.o || '').slice(0, 16) || '';   // OS 大版本
      const lg = String(b.l || '').slice(0, 12) || '';   // 界面语言
      const ch = String(b.r || '').slice(0, 12) || '';   // 版本渠道
      // 匿名：不存原始 IP，仅存粗粒度国家（Cloudflare 提供，可能为空）
      const country = (request.cf && request.cf.country) || '';
      const day = new Date().toISOString().slice(0, 10);

      try {
        const stmts = [
          env.DB.prepare(
            'INSERT INTO events (device_id, version, platform, arch, first_run, country, day, ts, os_ver, lang, channel) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
          ).bind(d, v, p, a, f, country, day, Date.now(), ov, lg, ch),
          env.DB.prepare(
            `INSERT INTO daily (day, version, count) VALUES (?,?,1)
             ON CONFLICT(day, version) DO UPDATE SET count = count + 1`
          ).bind(day, v)
        ];
        // 去重：同一设备同一天只记一次"活跃"（总启动次数仍全记）
        await env.DB.batch(stmts);
      } catch (e) {
        return json({ error: 'db', detail: String(e && e.message || e) }, 500, H);
      }
      return json({ ok: true }, 200, H);
    }

    // ---------- 公开统计 ----------
    if (url.pathname === '/stats' && request.method === 'GET') {
      try {
        const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM events').first();
        const devices = await env.DB.prepare('SELECT COUNT(DISTINCT device_id) AS c FROM events WHERE device_id != ""').first();
        const today = new Date().toISOString().slice(0, 10);
        const todayRow = await env.DB.prepare('SELECT COUNT(DISTINCT device_id) AS c FROM events WHERE day = ?').bind(today).first();
        return json({
          total_launches: total ? total.c : 0,
          total_devices: devices ? devices.c : 0,
          today_active: todayRow ? todayRow.c : 0,
          updated_at: new Date().toISOString()
        }, 200, H);
      } catch (e) {
        return json({ error: 'db', detail: String(e && e.message || e) }, 500, H);
      }
    }

    // ---------- 后台（需 Token） ----------
    if (url.pathname === '/admin' && request.method === 'GET') {
      const auth = request.headers.get('Authorization') || '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) {
        return json({ error: 'unauthorized' }, 401, H);
      }
      try {
        const total = await env.DB.prepare('SELECT COUNT(*) AS c FROM events').first();
        const devices = await env.DB.prepare('SELECT COUNT(DISTINCT device_id) AS c FROM events WHERE device_id != ""').first();
        const byVersion = await env.DB.prepare(
          'SELECT version, COUNT(*) AS c FROM events GROUP BY version ORDER BY c DESC LIMIT 20'
        ).all();
        const byPlatform = await env.DB.prepare(
          'SELECT platform, COUNT(*) AS c FROM events GROUP BY platform ORDER BY c DESC LIMIT 10'
        ).all();
        const byCountry = await env.DB.prepare(
          'SELECT country, COUNT(*) AS c FROM events WHERE country != "" GROUP BY country ORDER BY c DESC LIMIT 20'
        ).all();
        const byOs = await env.DB.prepare(
          'SELECT platform, os_ver, COUNT(*) AS c FROM events GROUP BY platform, os_ver ORDER BY c DESC LIMIT 20'
        ).all();
        const byLang = await env.DB.prepare(
          'SELECT lang, COUNT(*) AS c FROM events WHERE lang != "" GROUP BY lang ORDER BY c DESC LIMIT 15'
        ).all();
        const byChannel = await env.DB.prepare(
          'SELECT channel, COUNT(*) AS c FROM events WHERE channel != "" GROUP BY channel ORDER BY c DESC LIMIT 5'
        ).all();
        const last14 = await env.DB.prepare(
          `SELECT day, COUNT(DISTINCT device_id) AS active, COUNT(*) AS launches
           FROM events WHERE day >= date('now','-14 day')
           GROUP BY day ORDER BY day DESC`
        ).all();
        const firstRuns = await env.DB.prepare('SELECT COUNT(*) AS c FROM events WHERE first_run = 1').first();
        return json({
          total_launches: total ? total.c : 0,
          total_devices: devices ? devices.c : 0,
          new_devices: firstRuns ? firstRuns.c : 0,
          by_version: byVersion.results || [],
          by_platform: byPlatform.results || [],
          by_country: byCountry.results || [],
          by_os: byOs.results || [],
          by_lang: byLang.results || [],
          by_channel: byChannel.results || [],
          daily: last14.results || [],
          updated_at: new Date().toISOString()
        }, 200, H);
      } catch (e) {
        return json({ error: 'db', detail: String(e && e.message || e) }, 500, H);
      }
    }

    return json({ error: 'not found' }, 404, H);
  }
};
