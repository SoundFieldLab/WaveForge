'use strict';

// QQ 音乐 App 扫码登录（channel 'qq' / tmeLoginType 6，MQTT 推送通道）。
//
// 这段协议横跨 QIMEI 引导、musicu RPC 与一个自定义 MQTT5 握手，任何一层换实现都会让签名或
// 字段大小写对不上，因此这里自包含成单文件：只依赖 node:crypto、node:fs、node:path 和 ws，
// HTTP 一律走全局 fetch，Electron 主进程可以直接 require，不需要 axios/undici 之类的额外依赖。
//
// 日志只输出阶段、状态与错误码。qrcodeID、token、musickey、musicid 都属于登录凭据的一部分，
// 一旦进日志就会随崩溃报告或用户反馈外泄，所以任何一条日志都不允许携带它们。

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const LOG_PREFIX = '[QQ音乐扫码]';

const MUSICU_URL = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
const QIMEI_URL = 'https://api.tencentmusic.com/tme/trpc/proxy';
const MQTT_HOST = 'mu.y.qq.com';
const MQTT_INITIAL_PATH = '/ws/handshake';
const APP_CLIENT_VERSION = 14090008;
const MOBILE_LOGIN_TYPE = 6;
const QR_TTL_MS = 3 * 60 * 1000;
const QIMEI_TTL_MS = 24 * 60 * 60 * 1000;
const WS_CONNECT_TIMEOUT_MS = 20 * 1000;
const MQTT_PACKET_TIMEOUT_MS = 20 * 1000;
const MQTT_PING_INTERVAL_MS = 30 * 1000;
const MQTT_KEEP_ALIVE_SECONDS = 45;
const MQTT_MAX_REDIRECTS = 3;

const QIMEI_SECRET = 'ZdJqM15EeO2zWc08';
const QIMEI_APP_KEY = '0AND0HD6FE4HY80F';
const CHANNEL_ID = '10003505';
const PACKAGE_ID = 'com.tencent.qqmusic';
// header 里的 sign 是「appid + 固定盐 + 秒级时间戳」拼接后的 MD5，中间没有分隔符。
const QIMEI_HEADER_SIGN_PREFIX = 'qimei_qq_androidpzAuCmaFAaFaHrdakPjLIEqKrGnSOOvH';

// QIMEI 引导用的腾讯固定公钥。模数与指数是从上游实现注释里的 PEM 离线抽取的，
// 运行时用 JWK 还原，省掉一个 PEM/DER 解析器，也避免 PEM 换行被手抄错。
const QIMEI_RSA_MODULUS_HEX =
  'c4231830a2eb5fc2827170641e79d80fec51bda9a22e4b4ab37d1f205a4ae44d928cda25879f66a3429051663312a12' +
  '7faf8a246bdaaf63918417e90d7c95b5908aa6a2d0f852e4a6770294a548ac1c2fe8f1f252fb826f4ac86ab9a00e7ce4' +
  '7d002a56e7c4b51eb889acc60ca6adbc9f72e81f4d31b1dd7464805264530ab1d';
let cachedQimeiPublicKey = null;

function getQimeiPublicKey() {
  if (!cachedQimeiPublicKey) {
    cachedQimeiPublicKey = crypto.createPublicKey({
      key: {
        kty: 'RSA',
        n: Buffer.from(QIMEI_RSA_MODULUS_HEX, 'hex').toString('base64url'),
        e: Buffer.from([0x01, 0x00, 0x01]).toString('base64url'),
      },
      format: 'jwk',
    });
  }
  return cachedQimeiPublicKey;
}

// ---------------------------------------------------------------------------
// 日志与取值收窄
// ---------------------------------------------------------------------------

function logStatus(status) {
  console.log(`${LOG_PREFIX} ${status}`);
}

function logWarn(status, detail) {
  const text = detail instanceof Error ? detail.message : detail === undefined ? '' : String(detail);
  console.warn(`${LOG_PREFIX} ${status}${text ? `（${text}）` : ''}`);
}

// 上游 JSON 一律视作不可信输入，所有字段都经这几个函数收窄，避免把畸形值带进协议。
const isDictionary = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const dictionaryOf = (value) => (isDictionary(value) ? value : {});
const stringOf = (value) => (typeof value === 'string' ? value : '');
const identifierOf = (value) => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');
const numberOf = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};
const parseDictionary = (value) => {
  if (isDictionary(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    return dictionaryOf(JSON.parse(value));
  } catch {
    return {};
  }
};
const md5 = (...values) => crypto.createHash('md5').update(values.join('')).digest('hex');

// ---------------------------------------------------------------------------
// 随机素材
// ---------------------------------------------------------------------------

const randomHex = (length) => crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);

const randomDigits = (length) => {
  let value = '';
  for (let index = 0; index < length; index += 1) value += String(crypto.randomInt(10));
  return value;
};

// IMEI 必须过 Luhn：不带校验位的随机串会被 QIMEI 侧当成无效字段，设备指纹随之不像真机。
function randomImei() {
  const digits = randomDigits(14).split('').map(Number);
  let sum = 0;
  for (let index = 0; index < digits.length; index += 1) {
    let digit = digits[index];
    if (index % 2 === 1) digit = digit * 2 > 9 ? digit * 2 - 9 : digit * 2;
    sum += digit;
  }
  digits.push((10 - (sum % 10)) % 10);
  return digits.join('');
}

// ---------------------------------------------------------------------------
// 设备身份：一次生成、长期复用
// ---------------------------------------------------------------------------

const DEVICE_STATE_VERSION = 1;
const REQUIRED_DEVICE_TEXT_FIELDS = [
  'display',
  'product',
  'device',
  'board',
  'model',
  'fingerprint',
  'procVersion',
  'imei',
  'brand',
  'androidId',
  'openUdid',
  'osRelease',
];
const OPTIONAL_DEVICE_TEXT_FIELDS = ['qimei', 'qimei36', 'sessionUid', 'sessionSid'];

function isAndroidDevice(value) {
  if (!isDictionary(value)) return false;
  if (!Number.isFinite(value.sdk)) return false;
  if (value.qimeiSavedAt !== undefined && !Number.isFinite(value.qimeiSavedAt)) return false;
  if (!REQUIRED_DEVICE_TEXT_FIELDS.every((key) => typeof value[key] === 'string' && value[key].length > 0)) return false;
  return OPTIONAL_DEVICE_TEXT_FIELDS.every((key) => value[key] === undefined || (typeof value[key] === 'string' && value[key].length > 0));
}

function createAndroidDevice() {
  return {
    display: `QMAPI.${randomDigits(6)}.001`,
    product: 'iarim',
    device: 'sagit',
    board: 'eomam',
    model: 'MI 6',
    fingerprint: `xiaomi/iarim/sagit:10/eomam.200122.001/${randomDigits(7)}:user/release-keys`,
    procVersion: `Linux 5.4.0-54-generic-${randomHex(8)} (android-build@google.com)`,
    imei: randomImei(),
    brand: 'Xiaomi',
    androidId: randomHex(16),
    openUdid: randomHex(32),
    osRelease: '10',
    sdk: 29,
  };
}

function loadDeviceState(statePath) {
  if (!statePath) return null;
  try {
    if (!fs.existsSync(statePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const device = isDictionary(parsed) ? parsed.device : null;
    if (!isAndroidDevice(device)) {
      logWarn('本地设备状态不可用，重新生成');
      return null;
    }
    return device;
  } catch (error) {
    logWarn('本地设备状态读取失败，重新生成', error);
    return null;
  }
}

function saveDeviceState(statePath, device) {
  if (!statePath) return;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, `${JSON.stringify({ version: DEVICE_STATE_VERSION, device }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  } catch (error) {
    // 写失败只降级为内存内复用：只读盘/无权限不该阻断登录，代价只是重启后重新注册一次设备。
    logWarn('设备状态写入失败，本次仅在内存中复用', error);
  }
}

// ---------------------------------------------------------------------------
// musicu 请求公共部分
// ---------------------------------------------------------------------------

// musicu 在当前协议里不下发需要回传的用户级 cookie，进程内共享一个 jar 足够；
// 保留它是为了不丢掉上游可能设置的追踪类 cookie。
const cookieJar = new Map();

function absorbSetCookies(response) {
  let list = [];
  try {
    list = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  } catch {
    list = [];
  }
  for (const entry of list) {
    const pair = String(entry).split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (value) cookieJar.set(name, value);
    else cookieJar.delete(name);
  }
}

const jarCookieHeader = () => Array.from(cookieJar, ([name, value]) => `${name}=${value}`).join('; ');

// 后传入的 header 覆盖先传入的同名 cookie，这样显式凭据总是压过 jar 里的旧值。
function mergeCookieHeaders(...headers) {
  const merged = new Map();
  for (const header of headers) {
    for (const item of String(header || '').split(';')) {
      const separator = item.indexOf('=');
      if (separator <= 0) continue;
      const name = item.slice(0, separator).trim();
      const value = item.slice(separator + 1).trim();
      if (name) merged.set(name, value);
    }
  }
  return Array.from(merged, ([name, value]) => `${name}=${value}`).join('; ');
}

async function postJson(url, body, headers, phase) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const wrapped = new Error(`${phase}连接 QQ 音乐服务器失败，请检查网络后重试`);
    wrapped.phase = phase;
    wrapped.cause = error;
    throw wrapped;
  }
  const text = await response.text().catch(() => '');
  absorbSetCookies(response);
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }
  return { status: response.status, json, text };
}

function buildAndroidComm(device, credential, overrides = {}) {
  return {
    ct: 11,
    cv: APP_CLIENT_VERSION,
    v: APP_CLIENT_VERSION,
    chid: CHANNEL_ID,
    tmeAppID: 'qqmusic',
    QIMEI: device.qimei ?? '',
    QIMEI36: device.qimei36 ?? '',
    OpenUDID: device.openUdid,
    udid: device.openUdid,
    OpenUDID2: device.openUdid,
    aid: device.androidId,
    os_ver: device.osRelease,
    phonetype: device.model,
    devicelevel: String(device.sdk),
    newdevicelevel: String(device.sdk),
    rom: device.fingerprint,
    ...(device.sessionUid ? { uid: device.sessionUid } : {}),
    ...(device.sessionSid ? { sid: device.sessionSid } : {}),
    // authst 是 QQ 音乐凭据本身，绝不出现在日志里。
    ...(credential
      ? { qq: credentialMusicId(credential), authst: credential.musickey, tmeLoginType: credential.loginType }
      : {}),
    ...overrides,
  };
}

// str_musicid 才是真实账号，musicid 在部分通道里只是占位符；"0" 视为缺失。
function credentialMusicId(credential) {
  const stringId = identifierOf(credential.str_musicid).trim();
  const rawId = identifierOf(credential.musicid).trim();
  return ((stringId && stringId !== '0' ? stringId : '') || (rawId && rawId !== '0' ? rawId : '') || stringId || rawId);
}

// 上游调用统一入口：comm 里带设备与（可选）凭据，返回 req_0.data。
async function callMusicu(device, phase, moduleName, methodName, param, credential, overrides = {}) {
  const headers = { 'User-Agent': `QQMusic ${APP_CLIENT_VERSION}(android ${device.osRelease})` };
  const explicitCookies = credential ? credentialCookieHeader(credential) : '';
  const mergedCookies = mergeCookieHeaders(jarCookieHeader(), explicitCookies);
  if (mergedCookies) headers.Cookie = mergedCookies;

  const { status, json, text } = await postJson(
    MUSICU_URL,
    { comm: buildAndroidComm(device, credential, overrides), req_0: { module: moduleName, method: methodName, param } },
    headers,
    phase,
  );

  const body = dictionaryOf(json);
  const item = dictionaryOf(body.req_0);
  const globalCode = numberOf(body.code) ?? 0;
  const upstreamCode = numberOf(item.code);
  if (!Object.keys(item).length || globalCode !== 0 || (upstreamCode ?? 0) !== 0) {
    // 原始响应只挂在错误对象上、限 200 字且不写日志：里面可能带二维码 ID 之类的上游标识。
    const detail = `HTTP ${status}，code=${globalCode}${upstreamCode === undefined ? '' : `，upstream=${upstreamCode}`}`;
    logWarn(`接口调用失败（${phase}）`, detail);
    const error = new Error(`QQ 音乐接口异常（${phase}）`);
    error.phase = phase;
    error.httpStatus = status;
    error.globalCode = globalCode;
    error.upstreamCode = upstreamCode;
    error.upstreamBody = typeof text === 'string' ? text.slice(0, 200) : '';
    throw error;
  }
  return dictionaryOf(item.data);
}

// cookie 形式对 musicu 与旧 CGI 都成立；id 这里取 str_musicid 非空优先，含 "0" 也照用。
function credentialCookieHeader(credential) {
  const musicid = identifierOf(credential.str_musicid) || String(credential.musicid);
  return [
    `uin=${musicid}`,
    `qqmusic_uin=${musicid}`,
    `qm_keyst=${credential.musickey}`,
    `qqmusic_key=${credential.musickey}`,
  ].join('; ');
}

// ---------------------------------------------------------------------------
// QIMEI 引导
// ---------------------------------------------------------------------------

const DATED_BEACON_KEYS = new Set([1, 2, 13, 14, 17, 18, 21, 22, 25, 26, 29, 30, 33, 34, 37, 38]);

function randomBeaconId(now = new Date()) {
  const month = `${now.toISOString().slice(0, 7)}-01`;
  const first = randomDigits(6);
  const second = randomDigits(9);
  const fields = [];
  for (let key = 1; key <= 40; key += 1) {
    if (DATED_BEACON_KEYS.has(key)) fields.push(`k${key}:${month}${first}.${second}`);
    else if (key === 3) fields.push('k3:0000000000000000');
    else if (key === 4) fields.push(`k4:${randomHex(16).replace(/0/g, '1')}`);
    else fields.push(`k${key}:${crypto.randomInt(10000)}`);
  }
  return `${fields.join(';')};`;
}

function buildQimeiPayload(device, now = new Date()) {
  const uptime = new Date(now.getTime() - crypto.randomInt(14401) * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const reserved = {
    harmony: '0',
    clone: '0',
    containe: '',
    oz: 'UhYmelwouA+V2nPWbOvLTgN2/m8jwGB+yUB5v9tysQg=',
    oo: 'Xecjt+9S1+f8Pz2VLSxgpw==',
    kelong: '0',
    uptimes: uptime,
    multiUser: '0',
    bod: device.brand,
    dv: device.device,
    firstLevel: '',
    manufact: device.brand,
    name: device.model,
    host: 'se.infra',
    kernel: device.procVersion,
  };
  return {
    androidId: device.androidId,
    platformId: 1,
    appKey: QIMEI_APP_KEY,
    appVersion: '14.9.0.8',
    beaconIdSrc: randomBeaconId(now),
    brand: device.brand,
    channelId: CHANNEL_ID,
    cid: '',
    imei: device.imei,
    imsi: '',
    mac: '',
    model: device.model,
    networkType: 'unknown',
    oaid: '',
    osVersion: `Android ${device.osRelease},level ${device.sdk}`,
    qimei: '',
    qimei36: '',
    sdkVersion: '1.2.13.6',
    targetSdkVersion: '33',
    audit: '',
    userId: '{}',
    packageId: PACKAGE_ID,
    deviceType: 'Phone',
    sdkName: '',
    reserved: JSON.stringify(reserved),
  };
}

function buildQimeiRequest(device, now = new Date()) {
  const cryptKey = randomHex(16);
  const nonce = randomHex(16);
  const timestamp = Math.floor(now.getTime() / 1000);
  // key 与 IV 都是这 16 个 hex 字符重新按 UTF-8 编码得到的 16 字节，
  // 不是 hex 解码出的 8 字节——上游两侧都按前者实现。
  const keyBytes = Buffer.from(cryptKey, 'utf8');
  const encryptedKey = crypto.publicEncrypt(
    { key: getQimeiPublicKey(), padding: crypto.constants.RSA_PKCS1_PADDING },
    keyBytes,
  );
  const cipher = crypto.createCipheriv('aes-128-cbc', keyBytes, keyBytes);
  const encryptedPayload = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(buildQimeiPayload(device, now)), 'utf8')),
    cipher.final(),
  ]);
  const key = encryptedKey.toString('base64');
  const params = encryptedPayload.toString('base64');
  const extra = `{"appKey":"${QIMEI_APP_KEY}"}`;
  return {
    headers: {
      Host: 'api.tencentmusic.com',
      method: 'GetQimei',
      service: 'trpc.tme_datasvr.qimeiproxy.QimeiProxy',
      appid: 'qimei_qq_android',
      sign: md5(QIMEI_HEADER_SIGN_PREFIX, String(timestamp)),
      'user-agent': 'QQMusic',
      timestamp: String(timestamp),
    },
    body: {
      app: 0,
      os: 1,
      qimeiParams: {
        key,
        params,
        time: String(timestamp),
        nonce,
        // 签名里用的是毫秒时间戳，字段 time 仍是秒，这个不一致是协议本身如此。
        sign: md5(key, params, String(timestamp * 1000), nonce, QIMEI_SECRET, extra),
        extra,
      },
    },
  };
}

// 返回是否重新取过 QIMEI，调用方据此决定要不要落盘。
async function ensureQimei(device) {
  const fresh =
    device.qimei && device.qimei36 && device.qimeiSavedAt && Date.now() - device.qimeiSavedAt < QIMEI_TTL_MS;
  if (fresh) {
    logStatus('QIMEI 命中缓存');
    return false;
  }
  const request = buildQimeiRequest(device);
  const { status, json, text } = await postJson(QIMEI_URL, request.body, request.headers, 'QIMEI 初始化');
  // 上游是两层 data：外层 body 的 data 是 JSON 字符串，解析后的 data 里才是 q16/q36。
  const outer = dictionaryOf(json);
  const inner = parseDictionary(outer.data);
  const data = dictionaryOf(inner.data);
  const qimei = stringOf(data.q16);
  const qimei36 = stringOf(data.q36);
  if (!qimei || !qimei36) {
    const outerCode = numberOf(outer.code);
    const innerCode = numberOf(inner.code);
    logWarn('QIMEI 获取失败', `HTTP ${status}${outerCode === undefined ? '' : `，code=${outerCode}`}`);
    const error = new Error('QQ 音乐设备标识初始化失败，请稍后重试');
    error.httpStatus = status;
    error.outerCode = outerCode;
    error.innerCode = innerCode;
    error.upstreamBody = typeof text === 'string' ? text.slice(0, 200) : '';
    throw error;
  }
  device.qimei = qimei;
  device.qimei36 = qimei36;
  device.qimeiSavedAt = Date.now();
  logStatus('QIMEI 获取成功');
  return true;
}

// ---------------------------------------------------------------------------
// musicu 业务调用
// ---------------------------------------------------------------------------

// CreateQRCode 之前必须先拿会话：uid/sid 会进 comm，缺了它上游会把请求当成无会话客户端。
async function refreshAndroidSession(device) {
  const data = await callMusicu(
    device,
    'get-session',
    'music.getSession.session',
    'GetSession',
    { uid: device.sessionUid ?? '', vkey: 0, caller: 0 },
    undefined,
  );
  const session = dictionaryOf(data.session);
  const uid = identifierOf(session.uid);
  const sid = identifierOf(session.sid);
  if (!uid || !sid) throw new Error('QQ 音乐设备会话获取失败，请稍后重试');
  device.sessionUid = uid;
  device.sessionSid = sid;
  device.sessionVkey = session.vkey;
}

async function createNativeQr(device) {
  const data = await callMusicu(
    device,
    'create-qr',
    'music.login.LoginServer',
    'CreateQRCode',
    { tmeAppID: 'qqmusic', ct: 11, cv: APP_CLIENT_VERSION },
    undefined,
    // 建码这一路的 comm 用另一套 ct/cv（23/0），而 param 里仍是 11/14090008，
    // 两者不一致是协议要求，不能“统一”掉。
    { ct: 23, cv: 0 },
  );
  const qrcodeId = stringOf(data.qrcodeID);
  const encoded = stringOf(data.qrcode).split(',').pop() ?? '';
  const image = Buffer.from(encoded, 'base64');
  if (!qrcodeId || image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('QQ 音乐二维码数据无效，请重试');
  }
  return {
    qrcodeId,
    imageUrl: `data:image/png;base64,${image.toString('base64')}`,
    expiresIn: numberOf(data.expiresIn),
  };
}

function credentialFrom(value, defaultLoginType) {
  const musicid = value.musicid ?? value.str_musicid;
  const musickey = stringOf(value.musickey);
  if ((!stringOf(musicid) && typeof musicid !== 'number') || !musickey) {
    throw new Error('QQ 音乐登录凭据不完整');
  }
  return {
    ...value,
    musicid,
    musickey,
    loginType: numberOf(value.loginType) ?? defaultLoginType,
  };
}

async function exchangeQqLogin(device, qrcodeId, payload) {
  const cookies = dictionaryOf(dictionaryOf(payload).cookies);
  const musicid = stringOf(dictionaryOf(cookies.qqmusic_uin).value);
  const token = stringOf(dictionaryOf(cookies.qqmusic_key).value);
  if (!musicid || !token) throw new Error('扫码结果缺少登录凭据');

  try {
    const data = await callMusicu(
      device,
      'credential-exchange',
      'music.login.LoginServer',
      'Login',
      { musicid: Number(musicid), qrCodeID: qrcodeId, token },
      undefined,
      { tmeLoginType: MOBILE_LOGIN_TYPE },
    );
    return credentialFrom(data, MOBILE_LOGIN_TYPE);
  } catch (error) {
    // 兜底：上游偶尔只认 MQTT 里那把 token 当 musickey。先用它查一次用户，
    // 查不到就把原始错误抛回去，避免把一份查不了用户的凭据当成登录成功。
    const direct = { musicid, str_musicid: musicid, musickey: token, loginType: MOBILE_LOGIN_TYPE };
    try {
      await callMusicu(device, 'get-login-user', 'music.UserInfo.userInfoServer', 'GetLoginUserInfo', {}, direct);
    } catch {
      throw error;
    }
    logWarn('凭据交换失败，已回退到扫码直接凭据');
    return direct;
  }
}

// ---------------------------------------------------------------------------
// MQTT5 编解码
// ---------------------------------------------------------------------------

function encodeVariableInteger(input) {
  let value = input;
  const bytes = [];
  do {
    let digit = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) digit |= 0x80;
    bytes.push(digit);
  } while (value > 0);
  return Buffer.from(bytes);
}

function decodeVariableInteger(buffer, offset = 0) {
  let multiplier = 1;
  let value = 0;
  for (let bytes = 0; bytes < 4; bytes += 1) {
    if (offset + bytes >= buffer.length) return null;
    const digit = buffer[offset + bytes];
    value += (digit & 0x7f) * multiplier;
    if ((digit & 0x80) === 0) return { value, bytes: bytes + 1 };
    multiplier *= 128;
  }
  throw new Error('MQTT 变长整数解析失败');
}

function encodeUtf8(value) {
  const data = Buffer.from(value, 'utf8');
  const size = Buffer.allocUnsafe(2);
  size.writeUInt16BE(data.length);
  return Buffer.concat([size, data]);
}

function readUtf8(buffer, offset) {
  const length = buffer.readUInt16BE(offset);
  const start = offset + 2;
  return { value: buffer.subarray(start, start + length).toString('utf8'), next: start + length };
}

// 属性区：Authentication Method（0x15）必须排在 User Property（0x26）前面，
// 且整段前缀一个变长整数长度，这是本协议握手能通过的前提。
function encodeProperties(authMethod, properties) {
  const chunks = [];
  if (authMethod) chunks.push(Buffer.from([0x15]), encodeUtf8(authMethod));
  for (const [key, value] of properties) chunks.push(Buffer.from([0x26]), encodeUtf8(key), encodeUtf8(value));
  const data = Buffer.concat(chunks);
  return Buffer.concat([encodeVariableInteger(data.length), data]);
}

const wrapPacket = (header, body) => Buffer.concat([Buffer.from([header]), encodeVariableInteger(body.length), body]);

function buildConnectPacket(clientId, qrcodeId) {
  const keepAlive = Buffer.allocUnsafe(2);
  keepAlive.writeUInt16BE(MQTT_KEEP_ALIVE_SECONDS);
  const properties = encodeProperties('pass', [
    ['tmeAppID', 'qqmusic'],
    ['business', 'management'],
    ['hashTag', qrcodeId],
    ['clientTag', 'management.user'],
    ['userID', qrcodeId],
  ]);
  return wrapPacket(
    0x10,
    Buffer.concat([
      encodeUtf8('MQTT'),
      Buffer.from([0x05, 0x02]), // MQTT 5 + clean start
      keepAlive,
      properties,
      encodeUtf8(clientId),
    ]),
  );
}

function buildSubscribePacket(qrcodeId) {
  const packetId = Buffer.from([0x00, 0x01]);
  const properties = encodeProperties(null, [
    ['authorization', 'tmelogin'],
    ['pubsub', 'unicast'],
  ]);
  return wrapPacket(
    0x82,
    Buffer.concat([packetId, properties, encodeUtf8(`management.qrcode_login/${qrcodeId}`), Buffer.from([0x00])]),
  );
}

function skipProperty(buffer, offset, id) {
  if ([0x03, 0x08, 0x12, 0x15, 0x1a, 0x1c, 0x1f].includes(id)) return readUtf8(buffer, offset).next;
  if ([0x13, 0x21, 0x22, 0x23].includes(id)) return offset + 2;
  if ([0x02, 0x11, 0x18, 0x27].includes(id)) return offset + 4;
  if ([0x01, 0x17, 0x19, 0x24, 0x25, 0x28, 0x29, 0x2a].includes(id)) return offset + 1;
  if ([0x09, 0x16].includes(id)) return offset + 2 + buffer.readUInt16BE(offset);
  if (id === 0x0b) {
    const value = decodeVariableInteger(buffer, offset);
    if (!value) throw new Error('MQTT 属性长度截断');
    return offset + value.bytes;
  }
  throw new Error(`不支持的 MQTT 属性 0x${id.toString(16)}`);
}

function parseProperties(buffer, offset) {
  const length = decodeVariableInteger(buffer, offset);
  if (!length) throw new Error('MQTT 属性长度截断');
  let cursor = offset + length.bytes;
  const end = cursor + length.value;
  const userProperties = {};
  const values = { userProperties };
  while (cursor < end) {
    const id = buffer[cursor];
    cursor += 1;
    if (id === 0x26) {
      const key = readUtf8(buffer, cursor);
      const value = readUtf8(buffer, key.next);
      userProperties[key.value] = value.value;
      cursor = value.next;
    } else if (id === 0x1c || id === 0x1f) {
      const value = readUtf8(buffer, cursor);
      values[id === 0x1c ? 'serverReference' : 'reasonString'] = value.value;
      cursor = value.next;
    } else {
      cursor = skipProperty(buffer, cursor, id);
    }
  }
  return { values, next: end };
}

function parseConnack(packet) {
  const remaining = decodeVariableInteger(packet, 1);
  if (!remaining) throw new Error('MQTT CONNACK 截断');
  const offset = 1 + remaining.bytes;
  return { reasonCode: packet[offset + 1], ...parseProperties(packet, offset + 2).values };
}

function parsePublish(packet) {
  const remaining = decodeVariableInteger(packet, 1);
  if (!remaining) throw new Error('MQTT PUBLISH 截断');
  let cursor = 1 + remaining.bytes;
  cursor = readUtf8(packet, cursor).next;
  if (((packet[0] >> 1) & 0x03) > 0) cursor += 2;
  const properties = parseProperties(packet, cursor);
  const users = dictionaryOf(properties.values.userProperties);
  const raw = packet.subarray(properties.next).toString('utf8');
  return { type: stringOf(users.type) || null, payload: raw ? parseDictionary(raw) : null };
}

// WebSocket 帧与 MQTT 包不是一一对应：一帧可能半包或多包，必须按 remaining length 切分并留残包。
function splitPackets(buffer) {
  const packets = [];
  let cursor = 0;
  while (cursor < buffer.length) {
    const remaining = decodeVariableInteger(buffer, cursor + 1);
    if (!remaining) break;
    const end = cursor + 1 + remaining.bytes + remaining.value;
    if (end > buffer.length) break;
    packets.push(buffer.subarray(cursor, end));
    cursor = end;
  }
  return { packets, rest: buffer.subarray(cursor) };
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value) && value.every(Buffer.isBuffer)) return Buffer.concat(value);
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  throw new Error('不支持的 MQTT 数据帧');
}

function packetTimeoutError() {
  const error = new Error('等待 MQTT 报文超时');
  error.code = 'MQTT_PACKET_TIMEOUT';
  return error;
}

// 把 WS 数据流还原成有序的 MQTT 包队列；错误/关闭会让所有等待者以同一个终态错误结束。
function createPacketQueue() {
  let buffered = Buffer.alloc(0);
  const packets = [];
  const waiters = [];
  let terminalError = null;

  const settle = () => {
    while (waiters.length && packets.length) {
      const waiter = waiters.shift();
      waiter.resolve(packets.shift());
    }
    while (terminalError && waiters.length) {
      waiters.shift().reject(terminalError);
    }
  };

  return {
    onData(value) {
      let chunk;
      try {
        chunk = toBuffer(value);
      } catch (error) {
        terminalError = error;
        settle();
        return;
      }
      const split = splitPackets(Buffer.concat([buffered, chunk]));
      buffered = split.rest;
      packets.push(...split.packets);
      settle();
    },
    onError() {
      if (!terminalError) terminalError = new Error('MQTT 连接中断');
      settle();
    },
    onClose() {
      if (!terminalError) terminalError = new Error('MQTT 连接已关闭');
      settle();
    },
    next(timeoutMs) {
      if (packets.length) return Promise.resolve(packets.shift());
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolve, reject) => {
        const waiter = { resolve, reject };
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(packetTimeoutError());
        }, timeoutMs);
        waiter.resolve = (packet) => {
          clearTimeout(timer);
          resolve(packet);
        };
        waiter.reject = (error) => {
          clearTimeout(timer);
          reject(error);
        };
      });
    },
  };
}

// ---------------------------------------------------------------------------
// MQTT 连接 / 订阅 / 消费
// ---------------------------------------------------------------------------

function openMqttConnection(WebSocketImpl, pathname) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    try {
      // 子协议必须是 mqtt：服务端会据此走 WebSocket 上的 MQTT5 通道，缺失直接拒绝连接。
      socket = new WebSocketImpl(`wss://${MQTT_HOST}${pathname}`, 'mqtt');
    } catch (error) {
      reject(new Error('MQTT 连接创建失败'));
      return;
    }
    const queue = createPacketQueue();
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        socket.terminate();
      } catch {
        try {
          socket.close();
        } catch {
          /* 已经断开 */
        }
      }
      reject(new Error('MQTT 连接超时'));
    }, WS_CONNECT_TIMEOUT_MS);

    socket.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners('error');
      socket.on('message', (value) => queue.onData(value));
      socket.on('error', () => queue.onError());
      socket.on('close', () => queue.onClose());
      resolve({
        send: (data) => socket.send(data),
        close: () => {
          try {
            socket.close();
          } catch {
            /* 已经断开 */
          }
        },
        queue,
      });
    });
    socket.once('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('MQTT 连接失败'));
    });
  });
}

// 服务端返回 0x9c/0x9d 时会给出新的 Server Reference；初始 path 末段不含 ':'，
// 所以是追加成 /ws/handshake/<reference>，前缀变化时才是替换末段。
function redirectPath(pathname, reference) {
  const parts = pathname.replace(/\/$/, '').split('/');
  const last = parts[parts.length - 1];
  if (last && last.includes(':')) parts[parts.length - 1] = reference;
  else parts.push(reference);
  return parts.join('/');
}

async function connectMqtt(WebSocketImpl, qrcodeId) {
  let pathname = MQTT_INITIAL_PATH;
  for (let redirects = 0; redirects <= MQTT_MAX_REDIRECTS; redirects += 1) {
    const connection = await openMqttConnection(WebSocketImpl, pathname);
    // clientId 每次尝试都重新生成：跳转后是另一台接入机，复用会被当成重放的旧会话。
    connection.send(buildConnectPacket(`${Date.now()}${randomDigits(4)}`, qrcodeId));
    const connack = parseConnack(await connection.queue.next(MQTT_PACKET_TIMEOUT_MS));
    const reasonCode = numberOf(connack.reasonCode) ?? -1;
    if (reasonCode === 0) return connection;
    connection.close();
    const reference = stringOf(connack.serverReference);
    if (![0x9c, 0x9d].includes(reasonCode) || !reference || redirects === MQTT_MAX_REDIRECTS) {
      throw new Error(`MQTT 接入被拒绝（0x${reasonCode.toString(16)}）`);
    }
    logStatus(`MQTT 接入点跳转（0x${reasonCode.toString(16)}）`);
    pathname = redirectPath(pathname, reference);
  }
  throw new Error('MQTT 跳转次数超限');
}

async function subscribeToQrEvents(connection, qrcodeId, onEvent) {
  connection.send(buildSubscribePacket(qrcodeId));
  for (;;) {
    const packet = await connection.queue.next(MQTT_PACKET_TIMEOUT_MS);
    const type = packet[0] >> 4;
    if (type === 9) {
      const reasonCode = packet[packet.length - 1] ?? 0x80;
      if (reasonCode >= 0x80) throw new Error(`MQTT 订阅被拒绝（0x${reasonCode.toString(16)}）`);
      return;
    }
    // SUBACK 之前到达的 PUBLISH 不能丢：unicast 订阅一旦错过就不会补发。
    if (type === 3) onEvent(parsePublish(packet));
  }
}

const TERMINAL_EVENT_TYPES = new Set(['cookies', 'canceled', 'timeout', 'loginFailed']);

async function consumeQrEvents(connection, onEvent, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let sawTerminal = false;
  while (!sawTerminal) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    let packet;
    try {
      packet = await connection.queue.next(remaining);
    } catch (error) {
      // 本地时限到点与上游 timeout 事件等价，都归为“二维码过期”，不是连接故障。
      if (error && error.code === 'MQTT_PACKET_TIMEOUT') break;
      throw error;
    }
    if (packet[0] >> 4 !== 3) continue;
    const event = parsePublish(packet);
    onEvent(event);
    sawTerminal = TERMINAL_EVENT_TYPES.has(event.type ?? '');
  }
  if (!sawTerminal) onEvent({ type: 'timeout', payload: null });
}

// ready 在 SUBACK 时才 settle：CONNECT 申请的是 clean session，订阅又是 unicast，
// 订阅建立前上游发布的事件既不会保留也不会重放，早展示的二维码会直接丢事件。
function createQqMqttListener({ wsImpl, qrcodeId, onEvent, timeoutMs }) {
  let activeConnection = null;
  let pingTimer = null;
  let closed = false;
  let readySettled = false;
  let resolveReady = () => undefined;
  let rejectReady = () => undefined;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const done = (async () => {
    try {
      const connection = await connectMqtt(wsImpl, qrcodeId);
      activeConnection = connection;
      pingTimer = setInterval(() => {
        // 连接已经关掉时 send 会抛错，直接吞掉并把连接标记为不可用，
        // 不能让一次 keepalive 心跳变成未捕获异常。
        if (closed || !activeConnection) return;
        try {
          activeConnection.send(Buffer.from([0xc0, 0x00]));
        } catch {
          closed = true;
        }
      }, MQTT_PING_INTERVAL_MS);

      await subscribeToQrEvents(connection, qrcodeId, onEvent);
      onEvent({ type: 'waiting', payload: null });
      readySettled = true;
      resolveReady();
      await consumeQrEvents(connection, onEvent, timeoutMs);
    } catch (error) {
      if (!readySettled) {
        readySettled = true;
        rejectReady(error);
        throw error;
      }
      onEvent({ type: 'error', message: (error && error.message) || 'MQTT 连接异常' });
    } finally {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = null;
      if (activeConnection) {
        activeConnection.close();
        activeConnection = null;
      }
    }
  })();
  done.catch(() => undefined);

  return {
    ready,
    done,
    close: () => {
      closed = true;
      if (activeConnection) {
        activeConnection.close();
        activeConnection = null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

const TERMINAL_STATES = new Set(['success', 'expired', 'error', 'canceled']);

const EXPIRED_MESSAGES = {
  canceled: '扫码登录已取消',
  timeout: '二维码已过期，请重新获取',
  loginFailed: '手机端拒绝了本次登录',
};

function createQqMusicQrLogin({ statePath, wsImpl } = {}) {
  const WebSocketImpl = wsImpl || require('ws');

  let device = null;
  let qrcodeId = null;
  let image = null;
  let expiresInMs = 0;
  let state = 'idle'; // idle | starting | waiting | scanned | exchanging | success | expired | error
  let message = '';
  let cookie = null;
  let listener = null;
  let exchangeTask = null;

  function setState(next, detail) {
    state = next;
    if (detail !== undefined) message = detail;
  }

  function closeListener() {
    if (!listener) return;
    try {
      listener.close();
    } catch {
      /* 已经断开 */
    }
    listener = null;
  }

  function handleEvent(event) {
    const type = event && event.type;
    // 终态之后任何事件都不再改变结果，避免一次迟到的 timeout 把已成功的登录翻掉。
    if (TERMINAL_STATES.has(state) || state === 'idle') return;

    if (type === 'waiting') {
      if (state === 'starting' || state === 'waiting') setState('waiting');
      return;
    }
    if (type === 'scanned') {
      if (state !== 'exchanging') setState('scanned');
      return;
    }
    if (type === 'cookies' || type === 'authorized') {
      // authorized 与 cookies 可能先后到达，只允许触发一次换凭据，否则会拿同一把 token 换两遍。
      if (exchangeTask) return;
      setState('exchanging');
      logStatus('已扫码，正在换取登录凭据');
      exchangeTask = (async () => {
        try {
          const credential = await exchangeQqLogin(device, qrcodeId, event.payload);
          // 换凭据是网络往返，期间用户可能已经关掉弹窗；取消要优先于一个迟到的成功。
          if (state === 'canceled' || state === 'error') return;
          cookie = credentialCookieHeader(credential);
          setState('success');
          logStatus('登录成功');
          closeListener();
        } catch (error) {
          setState('error', `登录凭据交换失败：${error && error.message ? error.message : '未知错误'}`);
          logWarn('登录失败', error && error.phase ? `${error.phase} 阶段` : '凭据交换');
        }
      })();
      return;
    }
    if (type === 'canceled' || type === 'timeout' || type === 'loginFailed') {
      setState('expired', EXPIRED_MESSAGES[type] || '二维码已过期，请重新获取');
      logStatus('扫码流程结束');
      return;
    }
    if (type === 'error') {
      setState('error', event.message || 'MQTT 连接异常');
      logWarn('MQTT 连接异常', event.message);
    }
  }

  async function start() {
    if (!TERMINAL_STATES.has(state) && state !== 'idle') throw new Error('扫码登录已在进行中');
    closeListener();
    device = null;
    qrcodeId = null;
    image = null;
    cookie = null;
    exchangeTask = null;
    message = '';
    setState('starting');

    try {
      device = loadDeviceState(statePath);
      if (device) {
        logStatus('已载入本地设备身份');
      } else {
        device = createAndroidDevice();
        saveDeviceState(statePath, device);
        logStatus('已生成新的设备身份');
      }

      if (await ensureQimei(device)) saveDeviceState(statePath, device);

      await refreshAndroidSession(device);
      // sessionUid/sessionSid 要随设备一起落盘，重启后才不会重新注册设备。
      saveDeviceState(statePath, device);
      logStatus('设备会话就绪');

      const qr = await createNativeQr(device);
      qrcodeId = qr.qrcodeId;
      image = qr.imageUrl;
      expiresInMs = qr.expiresIn && qr.expiresIn > 0 ? Math.min(QR_TTL_MS, qr.expiresIn * 1000) : QR_TTL_MS;
      logStatus('二维码已生成，正在建立推送通道');

      const created = createQqMqttListener({
        wsImpl: WebSocketImpl,
        qrcodeId,
        onEvent: handleEvent,
        timeoutMs: expiresInMs,
      });
      listener = created;
      await created.ready;
      setState('waiting');
      logStatus('推送通道就绪，等待扫码');

      return { image, expiresInMs };
    } catch (error) {
      closeListener();
      setState('error', (error && error.message) || '扫码登录启动失败');
      const detail = [error && error.phase ? `${error.phase} 阶段` : '', error && error.message ? error.message : '']
        .filter(Boolean)
        .join('，');
      logWarn('启动失败', detail);
      throw error;
    }
  }

  async function poll() {
    if (state === 'success') return { status: 'success', cookie, message: '登录成功' };
    if (state === 'expired' || state === 'canceled') return { status: 'expired', message: message || '二维码已过期' };
    if (state === 'error') return { status: 'error', message: message || '扫码登录失败' };
    if (state === 'scanned' || state === 'exchanging') return { status: 'scanned', message: '二维码已扫描' };
    return { status: 'waiting', message: '等待扫码' };
  }

  // 幂等：渲染进程在弹窗关闭时是 fire-and-forget 调用的，重复调用不该报错。
  function cancel() {
    closeListener();
    if (!TERMINAL_STATES.has(state)) setState('canceled', EXPIRED_MESSAGES.canceled);
    logStatus('已取消扫码登录');
  }

  return { start, poll, cancel };
}

module.exports = { createQqMusicQrLogin };
