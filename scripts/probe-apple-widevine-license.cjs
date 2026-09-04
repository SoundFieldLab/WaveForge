/**
 * Apple Music Widevine L3 严格端到端探针（与生产协议一致）。
 *
 * 不接受命令行 token；从当前 Electron userData 的 http://127.0.0.1:3000 localStorage
 * 内存读取 dev token / media-user-token，不打印、不落盘。Cookie 由本地 license 代理
 * 从 apple-web-cookies.json 读取。实时 generateRequest → POST flat body → 同一 session.update。
 *
 * 用法（先关闭 WaveForge，保持 dev server/local-server 在跑）：
 *   node_modules/.bin/electron scripts/probe-apple-widevine-license.cjs [songId]
 */
const { app, BrowserWindow, components, ipcMain } = require('electron')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const songId = String(process.argv[2] || process.env.APPLE_SONG_ID || '1272353153')
const WEBPLAYBACK_URL = 'https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/webPlayback'
const LICENSE_URL = 'https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense'
const WIDEVINE_SYSTEM_ID = Buffer.from('edef8ba979d64acea3c827dcd51d21ed', 'hex')
const log = (...args) => console.log('[AppleL3Probe]', ...args)

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex')
}

function buildWidevinePsshV0(kid) {
  if (kid.length !== 16) throw new Error(`KID 长度异常: ${kid.length}`)
  const data = Buffer.concat([Buffer.from([0x08, 0x01, 0x12, 0x10]), kid])
  const box = Buffer.alloc(32 + data.length)
  box.writeUInt32BE(box.length, 0)
  box.write('pssh', 4, 'ascii')
  box.writeUInt32BE(0, 8) // version 0 + flags
  WIDEVINE_SYSTEM_ID.copy(box, 12)
  box.writeUInt32BE(data.length, 28)
  data.copy(box, 32)
  return box
}

function dataUriBytes(uri) {
  const idx = String(uri).indexOf('base64,')
  if (idx < 0) throw new Error('CENC key URI 非 base64 data URI')
  return Buffer.from(String(uri).slice(idx + 7).trim(), 'base64')
}

async function fetchText(url) {
  const res = await fetch(url)
  const text = await res.text()
  if (!res.ok) throw new Error(`GET ${new URL(url).hostname} HTTP ${res.status}`)
  return text
}

async function getCredentials(win) {
  await win.loadURL('http://127.0.0.1:3000/')
  const creds = await win.webContents.executeJavaScript(`(() => ({
    developerToken: localStorage.getItem('appleDeveloperToken') || '',
    mediaUserToken: localStorage.getItem('appleMediaUserToken') || ''
  }))()`)
  if (!creds.developerToken || !creds.mediaUserToken) throw new Error('WaveForge localStorage 中无 Apple 登录凭据')
  log('credentials: present (values redacted)')
  return creds
}

async function getPlaybackAsset(creds) {
  const res = await fetch(WEBPLAYBACK_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.developerToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Apple-Music-User-Token': creds.mediaUserToken,
      Origin: 'https://music.apple.com',
      Referer: 'https://music.apple.com/',
    },
    body: JSON.stringify({ salableAdamId: songId }),
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : null
  if (!res.ok || !data?.songList?.[0]) throw new Error(`webPlayback HTTP ${res.status}: ${text.slice(0, 220)}`)
  return data.songList[0]
}

async function resolveCenc(item) {
  const urls = (Array.isArray(item.assets) ? item.assets : [])
    .map(a => a?.URL || a?.url).filter(Boolean)
    .map(u => String(u).replace(/^manifest:\/\//, 'https://'))
    .sort((a, b) => (/\.rphq\./i.test(a) ? 0 : 1) - (/\.rphq\./i.test(b) ? 0 : 1))
  for (const url of urls) {
    const text = await fetchText(url)
    if (!text.includes('ISO-23001-7')) continue
    const keyLine = text.split('\n').find(line => line.startsWith('#EXT-X-KEY')) || ''
    const keyUri = (keyLine.match(/URI="([^"]+)"/) || [])[1] || ''
    const kid = dataUriBytes(keyUri)
    return { url, keyUri, kid }
  }
  throw new Error('webPlayback 未返回 CENC 清单')
}

function readAppleWebCookieHeader() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'apple-web-cookies.json'), 'utf8'))
    return typeof data?.cookie === 'string' ? data.cookie : ''
  } catch { return '' }
}

ipcMain.handle('apple-l3-probe-license', async (_event, p) => {
  const cookie = readAppleWebCookieHeader()
  const body = {
    challenge: p.challenge,
    uri: p.uri,
    'key-system': 'com.widevine.alpha',
    adamId: p.adamId,
    isLibrary: false,
    'user-initiated': true,
  }
  const res = await fetch(LICENSE_URL, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Authorization: `Bearer ${p.developerToken}`,
      'Media-User-Token': p.mediaUserToken,
      'X-Apple-Renewal': 'true',
      Origin: 'https://music.apple.com',
      Referer: 'https://music.apple.com/',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  })
  return { http: res.status, text: await res.text(), cookiePresent: Boolean(cookie) }
})

async function main() {
  log('0) ECS components.whenReady')
  await components.whenReady()
  log('components:', JSON.stringify(components.status()))

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      preload: path.join(__dirname, 'probe-apple-l3-preload.cjs'),
    },
  })
  const creds = await getCredentials(win)

  log('1) webPlayback', songId)
  const item = await getPlaybackAsset(creds)
  const cenc = await resolveCenc(item)
  const pssh = buildWidevinePsshV0(cenc.kid)
  const adamId = String(item.songId || songId)
  log('CENC:', cenc.url.split('/').pop(), `kid=${cenc.kid.toString('hex')}`, `psshBytes=${pssh.length}`, `psshSha256=${sha256(pssh)}`)

  const certUrl = String(item['widevine-cert-url'] || item['hls-key-cert-url'] || '')
  if (!certUrl) throw new Error('webPlayback 无 Widevine server certificate URL')
  const cert = Buffer.from(await (await fetch(certUrl)).arrayBuffer())
  log('server certificate:', `bytes=${cert.length}`, `sha256=${sha256(cert)}`)

  // 切到安全上下文以执行 EME；凭据只作为内存参数传入，不写 DOM/storage。
  await win.loadURL('https://music.apple.com/')
  const payload = {
    psshB64: pssh.toString('base64'),
    certB64: cert.toString('base64'),
    keyUri: cenc.keyUri,
    adamId,
    developerToken: creds.developerToken,
    mediaUserToken: creds.mediaUserToken,
  }

  log('2) realtime EME generateRequest → flat license body → session.update')
  const result = await win.webContents.executeJavaScript(`(async (p) => {
    const b64ToBytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const bytesToB64 = bytes => {
      let out = ''; const chunk = 0x8000;
      for (let i = 0; i < bytes.length; i += chunk) out += String.fromCharCode(...bytes.subarray(i, i + chunk));
      return btoa(out);
    };
    const sha = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map(x => x.toString(16).padStart(2, '0')).join('');
    const out = { stage: 'start', events: [] };
    try {
      const access = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
        initDataTypes: ['cenc'],
        audioCapabilities: [{ contentType: 'audio/mp4; codecs="mp4a.40.2"', robustness: 'SW_SECURE_CRYPTO' }],
        distinctiveIdentifier: 'optional',
        persistentState: 'optional',
        sessionTypes: ['temporary'],
      }]);
      out.stage = 'access';
      const keys = await access.createMediaKeys();
      out.stage = 'keys';
      const certOk = await keys.setServerCertificate(b64ToBytes(p.certB64));
      out.certOk = certOk;
      const session = keys.createSession('temporary');
      const final = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ ok:false, error:'message timeout' }), 30000);
        session.addEventListener('keystatuseschange', () => {
          out.events.push('keystatuseschange:' + Array.from(session.keyStatuses.values()).join(','));
        });
        session.addEventListener('message', async ev => {
          try {
            const challenge = new Uint8Array(ev.message);
            const challengeHash = await sha(challenge);
            out.events.push('message:' + ev.messageType + ':' + challenge.length);
            const response = await window.__appleL3Probe.requestLicense({
              challenge: bytesToB64(challenge),
              uri: p.keyUri,
              adamId: p.adamId,
              developerToken: p.developerToken,
              mediaUserToken: p.mediaUserToken,
            });
            const { http, text } = response;
            let data = null; try { data = JSON.parse(text); } catch {}
            let payload = data;
            if (payload && Array.isArray(payload['license-responses'])) payload = payload['license-responses'][0];
            const licenseB64 = payload?.license || payload?.licenseResponse || '';
            if (!licenseB64) {
              clearTimeout(timer);
              resolve({ ok:false, challengeHash, challengeBytes:challenge.length, http,
                appleStatus:payload?.status, errorCode:payload?.errorCode, responseHead:text.slice(0,220) });
              return;
            }
            const license = b64ToBytes(licenseB64);
            await session.update(license);
            await new Promise(r => setTimeout(r, 500));
            clearTimeout(timer);
            resolve({ ok:true, challengeHash, challengeBytes:challenge.length, http,
              licenseBytes:license.length, keyStatuses:Array.from(session.keyStatuses.values()) });
          } catch (e) {
            clearTimeout(timer); resolve({ ok:false, error:String(e && (e.stack || e.message || e)) });
          }
        }, { once:true });
        session.generateRequest('cenc', b64ToBytes(p.psshB64)).catch(e => {
          clearTimeout(timer); resolve({ ok:false, error:'generateRequest: ' + String(e) });
        });
      });
      return { ...out, ...final };
    } catch (e) { return { ...out, ok:false, error:String(e && (e.stack || e.message || e)) }; }
  })(${JSON.stringify(payload)})`, true)

  // 永不输出凭据；result 只含 hash/长度/status。
  log('RESULT:', JSON.stringify(result, null, 2))
  await win.close()
  app.exit(result?.ok ? 0 : 3)
}

app.whenReady().then(main).catch(error => {
  log('FATAL:', error?.stack || error?.message || String(error))
  app.exit(2)
})
