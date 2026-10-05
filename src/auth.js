// auth.js - 微软正版登录（OAuth 2.0 设备代码流 + Xbox Live + XSTS + Minecraft 服务）
// 使用 live.com 设备码流（无需注册私有 Azure 应用，兼容 Minecraft 官方登录流程）
const https = require('https');

const CLIENT_ID = '00000000402b5328'; // 微软 Xbox Live 公共客户端（Minecraft 登录通用）
const SCOPE = 'service::user.auth.xboxlive.com::MBI_SSL';
const DEVICE_CODE_URL = 'https://login.live.com/oauth20_connect.srf';
const TOKEN_URL = 'https://login.live.com/oauth20_token.srf';
const REDIRECT_URI = 'https://login.live.com/oauth20_desktop.srf';
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate';
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize';
const MC_AUTH_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox';
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile';
const MC_ENTITLEMENTS_URL = 'https://api.minecraftservices.com/entitlements/mcstore';

// 简单 JSON POST / GET（带超时）
function reqJson(method, url, { headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const opts = {
      method,
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: Object.assign(
        { 'User-Agent': 'Cubik/1.0', Accept: 'application/json' },
        data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {},
        headers
      )
    };
    const req = https.request(opts, (res) => {
      let b = '';
      res.on('data', (d) => (b += d));
      res.on('end', () => {
        let parsed = null;
        try { parsed = b ? JSON.parse(b) : null; } catch { parsed = b; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(parsed);
        else {
          const err = new Error('HTTP ' + res.statusCode);
          err.status = res.statusCode;
          err.body = parsed;
          reject(err);
        }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 表单 POST（OAuth token 端点需要 x-www-form-urlencoded）
function reqForm(url, params) {
  const body = new URLSearchParams(params).toString();
  return reqJson('POST', url, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
}

// 1) 发起设备代码流：返回 user_code（给用户看）与 device_code（内部轮询用）
async function startDeviceCode() {
  const r = await reqForm(DEVICE_CODE_URL, {
    client_id: CLIENT_ID,
    scope: SCOPE,
    response_type: 'device_code',
    redirect_uri: REDIRECT_URI
  });
  return {
    deviceCode: r.device_code,
    userCode: r.user_code,
    verificationUri: r.verification_uri || 'https://www.microsoft.com/link',
    interval: r.interval || 5,
    expiresIn: r.expires_in || 900,
    message: r.message
  };
}

// 2) 轮询换取微软令牌
async function pollToken(deviceCode, interval, expiresIn, onStatus) {
  const deadline = Date.now() + expiresIn * 1000;
  let wait = interval;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait * 1000));
    try {
      const r = await reqForm(TOKEN_URL, {
        client_id: CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
        redirect_uri: REDIRECT_URI
      });
      return r; // { access_token, refresh_token, expires_in }
    } catch (e) {
      const code = e.body && e.body.error;
      if (code === 'authorization_pending') { onStatus && onStatus('等待你在网页完成登录…'); continue; }
      if (code === 'slow_down') { wait += 5; onStatus && onStatus('请求过快，稍等…'); continue; }
      if (code === 'expired_token') throw new Error('设备码已过期，请重新登录');
      if (code === 'authorization_declined') throw new Error('你拒绝了授权');
      throw new Error('登录失败：' + (e.body && e.body.error_description ? e.body.error_description : e.message));
    }
  }
  throw new Error('登录超时，请重试');
}

// 3) 微软令牌 -> Xbox Live
async function msToXbl(msAccessToken, onStatus) {
  onStatus && onStatus('正在验证 Xbox Live…');
  const r = await reqJson('POST', XBL_URL, {
    body: {
      Properties: { AuthMethod: 'RPS', SiteName: 'user.auth.xboxlive.com', RpsTicket: 'd=' + msAccessToken },
      RelyingParty: 'http://auth.xboxlive.com',
      TokenType: 'JWT'
    }
  });
  return { token: r.Token, uhs: r.DisplayClaims.xui[0].uhs };
}

// 4) Xbox Live -> XSTS
async function xblToXsts(xblToken, onStatus) {
  onStatus && onStatus('正在获取 XSTS 授权…');
  const r = await reqJson('POST', XSTS_URL, {
    body: {
      Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
      RelyingParty: 'rp://api.minecraftservices.com/',
      TokenType: 'JWT'
    }
  }).catch((e) => {
    const xerr = e.body && e.body.XErr;
    if (xerr === 2148916233) throw new Error('该微软账号还没有 Xbox 档案，请先到 xbox.com 创建');
    if (xerr === 2148916235) throw new Error('该地区不支持 Xbox Live');
    if (xerr === 2148916238) throw new Error('该账号是未成年人账号，需先加入家庭组');
    throw e;
  });
  return r.Token;
}

// 5) XSTS -> Minecraft 访问令牌
async function xstsToMinecraft(xstsToken, uhs, onStatus) {
  onStatus && onStatus('正在登录 Minecraft 服务…');
  const r = await reqJson('POST', MC_AUTH_URL, {
    body: { identityToken: `XBL3.0 x=${uhs};${xstsToken}` }
  });
  return r.access_token;
}

// 6) 获取游戏档案（名称、UUID、皮肤）
async function getMcProfile(mcAccessToken) {
  const r = await reqJson('GET', MC_PROFILE_URL, { headers: { Authorization: 'Bearer ' + mcAccessToken } });
  return { id: r.id, name: r.name, skins: r.skins || [], capes: r.capes || [] };
}

// 7) 检查是否拥有正版
async function checkEntitlements(mcAccessToken) {
  try {
    const r = await reqJson('GET', MC_ENTITLEMENTS_URL, { headers: { Authorization: 'Bearer ' + mcAccessToken } });
    return (r.items || []).length > 0;
  } catch {
    return false;
  }
}

// 完整登录流程（deviceCode 由 startDeviceCode 得到后调用）
async function loginFlow(deviceCode, interval, expiresIn, onStatus) {
  const token = await pollToken(deviceCode, interval, expiresIn, onStatus);
  const xbl = await msToXbl(token.access_token, onStatus);
  const xsts = await xblToXsts(xbl.token, onStatus);
  const mc = await xstsToMinecraft(xsts, xbl.uhs, onStatus);
  const profile = await getMcProfile(mc);
  const owns = await checkEntitlements(mc);
  return {
    accessToken: mc,
    refreshToken: token.refresh_token,       // 用于后续静默续期
    msRefresh: token.refresh_token,
    uuid: profile.id,
    name: profile.name,
    skins: profile.skins,
    capes: profile.capes,
    owns,
    obtainedAt: Date.now()
  };
}

// 用 refresh_token 静默续期
async function refreshFlow(msRefreshToken, onStatus) {
  const token = await reqForm(TOKEN_URL, {
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: msRefreshToken,
    scope: SCOPE,
    redirect_uri: REDIRECT_URI
  });
  const xbl = await msToXbl(token.access_token, onStatus);
  const xsts = await xblToXsts(xbl.token, onStatus);
  const mc = await xstsToMinecraft(xsts, xbl.uhs, onStatus);
  const profile = await getMcProfile(mc);
  return {
    accessToken: mc,
    refreshToken: token.refresh_token || msRefreshToken,
    msRefresh: token.refresh_token || msRefreshToken,
    uuid: profile.id,
    name: profile.name,
    skins: profile.skins,
    capes: profile.capes,
    owns: true,
    obtainedAt: Date.now()
  };
}

// 取皮肤头像 URL（crafatar 支持按 UUID 取；正版皮肤）
function avatarUrl(uuid, size = 64) {
  if (!uuid) return '';
  return `https://crafatar.com/avatars/${String(uuid).replace(/-/g, '')}?size=${size}&overlay`;
}
function bodyUrl(uuid) {
  if (!uuid) return '';
  return `https://crafatar.com/renders/body/${String(uuid).replace(/-/g, '')}?size=256`;
}

module.exports = {
  startDeviceCode,
  loginFlow,
  refreshFlow,
  avatarUrl,
  bodyUrl,
  CLIENT_ID
};
