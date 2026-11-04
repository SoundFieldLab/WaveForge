'use strict';

// 汽水音乐扫码登录 —— Android/nodejs-mobile 端（无 Electron）。
//
// 与 desktop/qishui-auth-v6.cjs 同一协议族（Passport Web QR：get_qrcode →
// check_qrconnect → .qishui.com 会话 Cookie），但签名执行宿主不同：
//   - 桌面端：隐藏 BrowserWindow 里跑 bdms SDK（webRequest 捕获签名 URL）
//   - 本模块：MainActivity 的 1×1 离屏 WebView 加载同一份 security_host.html，
//     bdms 在页面里拦截 XHR 加 a_bogus —— 请求打向本模块挂的**同源代理**，
//     代理转发时顺手记录最后一个 passport 请求 URL（替代 Electron 的
//     webRequest.onBeforeSendHeaders 捕获），并自维护 cookie jar
//     （解析上游 Set-Cookie + 确认帧 session_cookie，不依赖浏览器 jar）。
//
// 路由（MainActivity / 渲染端调用，挂在 3001 本机服务上，需 local token）：
//   POST /api/soda/app-qr/start   → 生成二维码 { image(base64), token, expiresInMs }
//   GET  /api/soda/app-qr/poll    → { status: waiting|scanned|success|expired|error, cookie?, profile? }
//   POST /api/soda/app-qr/cancel  → 清理会话
//
// 凭据落盘：filesDir/waveforge-userdata/soda-qr-login.json（0o600）。
// 二次验证（error_code=2046）：security_host.html 内建 MFA 组件在 WebView 里完成，
// 本模块经 sign executor 通道把 decision 递给页面（与桌面端 secondVerify 等价）。

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const QRCode = require('qrcode');

const API_BASE = 'https://api.qishui.com';
const AID = '386088';
const APP_VERSION = '3.5.2';
const SDK_VERSION = '2.4.13';
const VERIFY_SDK_VERSION = '1.0.29';
const SECURE_SDK_VERSION = '3.3.5';
const BDMS_VERSION = '1.0.0.41';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) SodaMusic/3.2.1 Chrome/136.0.7103.59 ' +
  'Electron/36.4.0-rs.22.release.main.1 TTElectron/36.4.0-rs.22.release.main.1 Safari/537.36';

// 资产目录：构建脚本把 desktop/qishui-auth-v6/ 的 6 个文件打进 APK 资产
// （nodejs-project/qishui-auth-assets/）。
function assetDir() {
  return path.join(__dirname, 'qishui-auth-assets');
}
const ASSETS = new Map([
  ['security_seed.html', 'text/html; charset=utf-8'],
  ['security_host.html', 'text/html; charset=utf-8'],
  ['react.js', 'text/javascript; charset=utf-8'],
  ['react-dom.js', 'text/javascript; charset=utf-8'],
  ['sdk-glue.js', 'text/javascript; charset=utf-8'],
  ['bdms.js', 'text/javascript; charset=utf-8'],
]);

const SESSION_COOKIE_KEYS = new Set([
  'sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'sid_ucp_v1', 'ssid_ucp_v1',
  'uid_tt', 'uid_tt_ss', 'sid_ucp_sso_v1', 'ssid_ucp_sso_v1', 'odin_tt', 'passport_assist_verify_token',
  'ttwid', 'msToken', 'uiin', 'client_key',
]);

function parseCookieString(raw) {
  const result = {};
  String(raw || '').split(';').forEach(pair => {
    const index = pair.indexOf('=');
    if (index > 0) result[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  });
  return result;
}

function buildCookieString(values) {
  return Object.entries(values)
    .filter(([name]) => name)
    .map(([name, value]) => name + '=' + value)
    .join('; ');
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomDigits(length, firstMax = 9) {
  let value = String(crypto.randomInt(1, Math.max(2, firstMax + 1)));
  while (value.length < length) value += String(crypto.randomInt(0, 10));
  return value;
}

function normalizeBizParams(value) {
  if (!value) return {};
  let source = value;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch (_) {
      const parsed = new URLSearchParams(source);
      return Object.fromEntries(parsed.entries());
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('二次验证 biz_params 格式无效');
  }
  const result = {};
  for (const [key, item] of Object.entries(source)) {
    if (item == null) continue;
    result[String(key)] = typeof item === 'object' ? JSON.stringify(item) : String(item);
  }
  return result;
}

function mergeDecision(envelope) {
  const data = envelope && envelope.data && typeof envelope.data === 'object' ? envelope.data : {};
  const decision = { ...(envelope || {}), ...data };
  delete decision.data;
  return decision;
}

function officialScanUrl(indexUrl, computerName) {
  const source = new URL(String(indexUrl || ''));
  const token = source.searchParams.get('token');
  if (!token) throw new Error('qrcode_index_url 缺少 token');
  const target = new URL('https://bff-pc.qishui.com/light/invoke/scan_login');
  target.searchParams.set('token', token);
  target.searchParams.set('os', 'Windows');
  target.searchParams.set('computer_name', computerName || 'Windows-PC');
  return target.toString().replace(/\+/g, '%20');
}

function safeProfileParse(raw) {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

class QishuiAuthNodeRuntime {
  constructor(options = {}) {
    // options.configFile：凭据/设备指纹持久化路径
    // options.log：日志函数（不打印任何凭据字段）
    this.configFile = String(options.configFile || path.join(os.tmpdir(), 'waveforge-soda-qr.json'));
    this.log = typeof options.log === 'function' ? options.log : () => undefined;
    this.assetServer = null;
    this.assetPort = 0;
    this.assetToken = crypto.randomBytes(18).toString('hex');
    this.msToken = '';
    this.browserInfo = null;
    // 签名执行通道：页面 XHR → 本模块代理（捕获签名 URL + 转发上游）。
    // 本模块自己发出的协议请求也需要 a_bogus —— 把待签名请求排队，宿主 WebView
    // 的 security_host 页面经 /pending-sign 轮询取任务、以 XHR 打同源代理执行，
    // 响应回写 /sign-result。与桌面端 executeJavaScript('window.__qishuiRequest')
    // 语义等价，只是方向反过来（Node 等页面，而非页面等 Node）。
    this.signQueue = new Map();
    this.signSeq = 0;
    this.lastPassportUrl = '';
    this.lastXMsToken = '';
    this.jar = {}; // 本模块自维护的会话 cookie（键值对）
    this.initializing = null;
  }

  readConfig() {
    try {
      return JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
    } catch (_) {
      return {};
    }
  }

  writeConfig(patch) {
    const next = { ...this.readConfig(), ...(patch || {}) };
    try {
      fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
      fs.writeFileSync(this.configFile, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
      try { fs.chmodSync(this.configFile, 0o600); } catch (_) {}
    } catch (error) {
      this.log(`[汽水扫码] 凭据落盘失败（不阻塞登录）: ${error && error.message || error}`);
    }
  }

  ensureIdentity() {
    const config = this.readConfig();
    const patch = {};
    if (!config.deviceId) patch.deviceId = randomDigits(16, 8);
    if (!config.installId) patch.installId = randomDigits(15, 8);
    if (!config.verifyPortraitId) patch.verifyPortraitId = crypto.randomUUID() + '.login';
    if (!config.computerName) patch.computerName = 'Android-' + crypto.randomBytes(3).toString('hex').toUpperCase();
    if (Object.keys(patch).length) this.writeConfig(patch);
    const current = this.readConfig();
    return {
      deviceId: String(current.deviceId),
      installId: String(current.installId),
      verifyPortraitId: String(current.verifyPortraitId),
      computerName: String(current.computerName || 'Android'),
    };
  }

  commonParams(identity) {
    return {
      passport_jssdk_version: SDK_VERSION,
      passport_jssdk_type: 'normal',
      is_from_ttaccountsdk: '1',
      aid: AID,
      language: 'zh',
      account_sdk_source: 'web',
      p_js_v: SDK_VERSION,
      p_js_t: 'pro',
      p_zt: SECURE_SDK_VERSION,
      p_ver: VERIFY_SDK_VERSION,
      request_host: 'app%3A%2F%2Fresources',
      p_bd: BDMS_VERSION,
      biz_trace_id: crypto.randomBytes(4).toString('hex'),
      is_new_login: '1',
      is_from_iesaccountsaas: '1',
      device_id: identity.deviceId,
      install_id: identity.installId,
      did: identity.deviceId,
      iid: identity.installId,
      device_platform: 'PC',
      version_code: APP_VERSION,
      account_sdk_source_info: String((this.browserInfo && this.browserInfo.encrypted) || ''),
      msToken: this.msToken,
    };
  }

  requestHeaders(identity, bizTraceId) {
    const traceId = crypto.randomBytes(16).toString('hex');
    return {
      Accept: 'application/json, text/javascript',
      'User-Agent': UA,
      'x-tt-passport-verify-portrait': identity.verifyPortraitId,
      'x-tt-passport-trace-id': bizTraceId,
      'x-tt-trace-id': `00-${traceId}-${traceId.slice(0, 16)}-01`,
    };
  }

  // ── asset server：页面资产 + 同源代理（与桌面端逐字段对齐）─────────────
  async startAssetServer() {
    if (this.assetServer) return;
    const runtime = this;
    this.assetServer = http.createServer((request, response) => {
      try {
        const url = new URL(request.url, 'http://127.0.0.1');
        const prefix = '/' + runtime.assetToken + '/';
        if (!url.pathname.startsWith(prefix)) {
          response.writeHead(404).end('not found');
          return;
        }
        const name = url.pathname.slice(prefix.length);
        // 签名任务通道：页面轮询取任务 / 回写结果
        if (name === 'sign/pending') {
          const tasks = [];
          for (const [id, task] of runtime.signQueue) {
            tasks.push({ id, ...task });
            if (tasks.length >= 8) break;
          }
          response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          response.end(JSON.stringify({ tasks }));
          return;
        }
        if (name === 'sign/result' && request.method === 'POST') {
          const chunks = [];
          request.on('data', c => chunks.push(c));
          request.on('end', () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
              const id = String(body.id || '');
              // browser-info：页面就绪上报（替代桌面端 executeJavaScript('__qishuiBrowserInfo')）
              if (id === 'browser-info') {
                const info = safeProfileParse(body.body);
                if (info) {
                  runtime.browserInfo = { encrypted: String(info.encrypted || JSON.stringify(info)) };
                  runtime.log('[汽水扫码] 安全组件页面就绪（browserInfo 已上报）');
                }
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end('{"ok":true}');
                return;
              }
              const pending = runtime.signQueue.get(id);
              if (pending) {
                runtime.signQueue.delete(id);
                if (body.error) pending.reject(new Error(String(body.error)));
                else pending.resolve({ status: Number(body.status) || 0, body: String(body.body || ''), headers: body.headers || {} });
              }
              response.writeHead(200, { 'Content-Type': 'application/json' });
              response.end('{"ok":true}');
            } catch (error) {
              response.writeHead(400).end('bad result');
            }
          });
          return;
        }
        // 同源代理：bdms 拦截的 passport XHR → 转发上游（Host 改写、Set-Cookie 域剥除、jar 捕获）
        if (name.startsWith('passport/')) {
          // 记录签名 URL（替代桌面端 webRequest.onBeforeSendHeaders）
          runtime.lastPassportUrl = API_BASE + '/' + name + url.search;
          const target = API_BASE + '/' + name + url.search;
          const chunks = [];
          request.on('data', c => chunks.push(c));
          request.on('end', async () => {
            try {
              const body = Buffer.concat(chunks);
              const upstreamHeaders = { ...(request.headers || {}) };
              delete upstreamHeaders.host;
              delete upstreamHeaders.origin;
              delete upstreamHeaders.referer;
              upstreamHeaders.host = 'api.qishui.com';
              // jar 注入：同源代理下浏览器收不到跨域 Set-Cookie，由本 jar 兜底
              const jarCookie = buildCookieString(runtime.jar);
              if (jarCookie) upstreamHeaders.cookie = jarCookie;
              const upstream = await fetch(target, {
                method: request.method,
                headers: upstreamHeaders,
                body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
              });
              const responseHeaders = {};
              upstream.headers.forEach((value, headerName) => {
                if (/content-encoding|transfer-encoding|content-length|set-cookie/i.test(headerName)) return;
                responseHeaders[headerName] = value;
              });
              const upstreamSetCookies = upstream.headers.getSetCookie ? upstream.headers.getSetCookie() : [];
              // jar 捕获（解析 Set-Cookie 第一段 name=value；会话键白名单过滤）
              for (const setCookie of upstreamSetCookies) {
                const pair = setCookie.split(';')[0];
                const eq = pair.indexOf('=');
                if (eq > 0) {
                  const cookieName = pair.slice(0, eq).trim();
                  const cookieValue = pair.slice(eq + 1).trim();
                  if (SESSION_COOKIE_KEYS.has(cookieName) || /^tt_/i.test(cookieName)) {
                    runtime.jar[cookieName] = cookieValue;
                  }
                }
              }
              const xMsToken = upstream.headers.get('x-ms-token');
              if (xMsToken) runtime.lastXMsToken = xMsToken;
              const responseBody = Buffer.from(await upstream.arrayBuffer());
              response.writeHead(upstream.status, responseHeaders);
              response.end(responseBody);
            } catch (proxyError) {
              response.writeHead(502).end('proxy error: ' + (proxyError && proxyError.message || 'unknown'));
            }
          });
          return;
        }
        const type = ASSETS.get(name);
        if (!type) {
          response.writeHead(404).end('not found');
          return;
        }
        const file = path.join(assetDir(), name);
        if (!fs.existsSync(file)) {
          response.writeHead(500).end('missing auth asset');
          return;
        }
        response.writeHead(200, {
          'Content-Type': type,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        });
        fs.createReadStream(file).pipe(response);
      } catch (error) {
        try { response.writeHead(500).end('internal error'); } catch (_) {}
      }
    });
    // 监听本机回环；nodejs-mobile 与主 WebView 同进程组，3001 已被 express 占用，
    // 这里绑临时端口（0 = 内核分配）。
    await new Promise((resolve, reject) => {
      this.assetServer.once('error', reject);
      this.assetServer.listen(0, '127.0.0.1', () => {
        this.assetPort = this.assetServer.address().port;
        resolve();
      });
    });
  }

  get assetBase() {
    return `http://127.0.0.1:${this.assetPort}/${this.assetToken}`;
  }

  // ── 签名请求：排队 → 页面 XHR 执行 → 结果回写 ──────────────────────────
  async request(method, pathname, params, data) {
    await this.initialize();
    const identity = this.ensureIdentity();
    const query = { ...this.commonParams(identity), ...(params || {}) };
    const url = new URL(pathname, API_BASE);
    for (const [name, value] of Object.entries(query)) {
      if (value != null) url.searchParams.set(name, String(value));
    }
    const headers = this.requestHeaders(identity, query.biz_trace_id);
    let body = null;
    if (data != null) {
      body = new URLSearchParams();
      for (const [name, value] of Object.entries(data)) {
        if (value != null) body.set(name, typeof value === 'object' ? JSON.stringify(value) : String(value));
      }
      body = body.toString();
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['x-ss-stub'] = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
    }
    const payload = {
      method: String(method || 'GET').toUpperCase(),
      url: url.toString(),
      headers,
      body,
      timeout: 30000,
    };
    // 排队等页面执行（同源代理转发时签名生效）
    const response = await new Promise((resolve, reject) => {
      const id = 's' + (++this.signSeq);
      const entry = { payload, resolve, reject };
      this.signQueue.set(id, entry);
      // 45s 超时兜底（页面未起/卡死时任务不悬挂）
      setTimeout(() => {
        if (this.signQueue.has(id)) {
          this.signQueue.delete(id);
          reject(new Error('签名执行超时（安全组件页面未就绪）'));
        }
      }, 45000).unref?.();
    });
    if (!response || response.status < 200 || response.status >= 400) {
      throw new Error(`汽水登录接口 HTTP ${response && response.status || 0}: ${String(response && response.body || '').slice(0, 300)}`);
    }
    let envelope;
    try {
      envelope = JSON.parse(response.body || '{}');
    } catch (_) {
      throw new Error('汽水登录接口返回了无效 JSON');
    }
    // 校验签名确实生效（与桌面端同一道防线）
    let signedQuery;
    try {
      signedQuery = new URL(this.lastPassportUrl).searchParams;
    } catch (_) {
      signedQuery = new URLSearchParams();
    }
    const aBogus = signedQuery.get('a_bogus') || '';
    const signedMsToken = signedQuery.get('msToken') || '';
    if (aBogus.length !== 44 || signedMsToken !== this.msToken) {
      throw new Error('汽水安全参数注入失败：a_bogus 或 msToken 缺失');
    }
    return envelope;
  }

  async initialize() {
    if (this.browserInfo && this.msToken && this.assetServer) return true;
    if (this.initializing) return this.initializing;
    this.initializing = this._initialize().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  async _initialize() {
    this.ensureIdentity();
    await this.startAssetServer();
    // jar 里可能有历史会话（凭据文件），恢复进 jar
    const saved = this.readConfig();
    if (saved.cookie) this.jar = { ...parseCookieString(saved.cookie), ...this.jar };
    // msToken：与桌面端同规则（凭据文件里的优先，长度不对则新生成）
    let storedToken = String(saved.msToken || '');
    if (!/^[A-Za-z0-9_-]{118}==$/.test(storedToken)) {
      storedToken = crypto.randomBytes(88).toString('base64url') + '==';
    }
    this.msToken = storedToken;
    this.writeConfig({ msToken: this.msToken });
    // browserInfo 由页面加载 security_host.html 后经 sign 通道首条任务前上报；
    // 这里先放占位（页面就绪检测由 waitForPageReady 完成）。
    this.log('[汽水扫码] 资产服务已启动（等待安全组件页面就绪）');
    return true;
  }

  // 宿主（MainActivity）在 WebView onPageFinished 后调用：页面已加载 security_host.html
  async markPageReady(browserInfoEncrypted) {
    this.browserInfo = { encrypted: String(browserInfoEncrypted || '') };
    this.log('[汽水扫码] 安全组件页面就绪');
  }

  async waitForPageReady(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.browserInfo && this.assetServer) return true;
      await delay(200);
    }
    throw new Error('汽水安全组件页面加载超时（离屏 WebView 未就绪）');
  }

  async getQrCode() {
    await this.initialize();
    await this.waitForPageReady();
    const identity = this.ensureIdentity();
    const envelope = await this.request('GET', '/passport/web/get_qrcode/', {
      next: API_BASE,
      need_logo: 'false',
      need_short_url: 'false',
    });
    const data = envelope.data || {};
    if (envelope.message !== 'success' || Number(data.error_code) !== 0) {
      throw new Error(`二维码生成失败：code=${data.error_code} ${data.description || envelope.message || ''}`);
    }
    const scanUrl = officialScanUrl(data.qrcode_index_url, identity.computerName);
    const qrDataUrl = await QRCode.toDataURL(scanUrl, {
      errorCorrectionLevel: 'M',
      margin: 2,
      width: 360,
      color: { dark: '#000000', light: '#ffffff' },
    });
    envelope.data = { ...data, qrcode: qrDataUrl, scan_url: scanUrl };
    return envelope;
  }

  async checkQrConnect(token) {
    await this.initialize();
    const identity = this.ensureIdentity();
    const body = {
      need_logo: 'false',
      need_short_url: 'false',
      is_frontier: 'true',
      token: String(token || ''),
      is_new_login: '1',
      next: API_BASE,
    };
    let envelope = await this.request('POST', '/passport/web/check_qrconnect/', {}, body);
    let data = envelope.data || {};
    if (Number(data.error_code) === 2046) {
      // 二次验证：decision 递给页面 MFA 组件（与桌面端 secondVerify 等价）。
      // 宿主页面流程：pending-sign 轮询会带上 verify 任务，页面内建组件处理。
      const decision = mergeDecision(envelope);
      if (!decision.verify_portrait_id) decision.verify_portrait_id = identity.verifyPortraitId;
      const bizParams = normalizeBizParams(decision.biz_params);
      const verified = await this.runSecondVerify(decision);
      if (!verified || verified.status !== true) {
        const error = new Error(verified && verified.message || '二次验证未完成');
        error.code = 'QISHUI_MFA_CANCELLED';
        throw error;
      }
      envelope = await this.request(
        'POST',
        '/passport/web/check_qrconnect/',
        { isResend: 'true' },
        { ...body, ...bizParams },
      );
      data = envelope.data || {};
      if (Number(data.error_code) === 2046) {
        throw new Error('二次验证已通过，但服务端仍返回 2046；请重新刷新二维码');
      }
    }
    if (Number(data.error_code) === 0 && (String(data.status) === '3' || String(data.status) === 'confirmed' || data.session_cookie)) {
      this.persistSessionCookies(data.session_cookie || '');
    }
    return envelope;
  }

  // 二次验证任务：页面端有内建 MFA UI（security_host.html 的 expandVerifyCenterDecision），
  // 通过 verify 任务类型下发，结果回写。用户在手机上看到验证界面（宿主把 WebView 显示出来）。
  runSecondVerify(decision) {
    return new Promise((resolve) => {
      const id = 'v' + (++this.signSeq);
      const entry = {
        payload: { kind: 'verify', decision },
        resolve,
        reject: () => resolve({ status: false, message: '二次验证超时' }),
      };
      this.signQueue.set(id, entry);
      setTimeout(() => {
        if (this.signQueue.has(id)) {
          this.signQueue.delete(id);
          resolve({ status: false, message: '二次验证超时' });
        }
      }, 120000).unref?.();
    });
  }

  persistSessionCookies(sessionCookie) {
    const current = parseCookieString(this.readConfig().cookie || '');
    Object.assign(current, parseCookieString(sessionCookie || ''));
    // jar 里捕获的 Set-Cookie 会话键并入
    for (const [name, value] of Object.entries(this.jar)) {
      if (SESSION_COOKIE_KEYS.has(name) || /^tt_/i.test(name)) current[name] = value;
    }
    const headerToken = this.lastXMsToken || '';
    if (headerToken && !current.msToken) current.msToken = headerToken;
    const filtered = {};
    for (const [name, value] of Object.entries(current)) {
      if (SESSION_COOKIE_KEYS.has(name) || /^tt_/i.test(name)) filtered[name] = value;
    }
    const cookie = buildCookieString(filtered);
    this.writeConfig({ cookie, msToken: this.msToken || current.msToken || '' });
    this.log(`[汽水扫码] 会话 Cookie 已落盘（${Object.keys(filtered).length} 个会话键）`);
  }

  readSessionCookie() {
    return String(this.readConfig().cookie || '');
  }

  cancel() {
    this.signQueue.forEach((entry, id) => {
      this.signQueue.delete(id);
      try { entry.reject(new Error('会话已取消')); } catch (_) { try { entry.resolve({ status: 0, body: '' }); } catch (_) {} }
    });
    this.log('[汽水扫码] 会话已取消');
  }
}

function createQishuiAuthNode(options) {
  return new QishuiAuthNodeRuntime(options);
}

module.exports = { createQishuiAuthNode, API_BASE };
