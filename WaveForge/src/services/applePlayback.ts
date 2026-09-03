/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 原生音源（Cider 同款：webPlayback 私有接口 + HLS + Widevine EME）
 *
 * 数据链路（依据 MusicKit JS v3 SDK 逆向成果）：
 * 1. POST play.itunes.apple.com/WebObjects/MZPlay.woa/wa/webPlayback
 *    body: {"salableAdamId":"<catalogSongId>"}
 *    headers: Authorization: Bearer <developerToken> + X-Apple-Music-User-Token
 *    响应 songList[0] 直接携带：songId、HLS 主清单（attributes.assetUrl /
 *    offers[0].hlsUrl）与 EME keyURLs（hls-key-cert-url / hls-key-server-url /
 *    widevine-cert-url）
 * 2. 拉主清单 → 选最佳 AAC 变体（CODECS="mp4a.40.2"，复用 SDK 的变体解析正则）
 * 3. hls.js（emeEnabled + drmSystems.widevine）播放；license 请求按 SDK 协议
 *    封装 JSON（license-requests → challenge/uri/key-system/adam-id），
 *    license 响应 JSON 的 license 字段（base64）交给 MediaKeySession.update()
 *
 * 依赖环境：
 * - 渲染进程必须有 Widevine CDM（Chrome/Edge 原生有；Electron 由主进程启动时
 *   注入 Edge/Chrome 的 CDM，见 desktop/main.cjs findWidevineCdm）
 * - 无 Widevine 或取流失败 → 上层回退网易云/QQ 载体匹配（原有路径不变）
 */
import { getAppleCredentials } from './appleAuth'
import { recordAppleAcceptanceEvent } from './appleAcceptanceDiagnostics'
import { ensureAppleWebDevToken, prepareAppleDeveloperToken, shouldRefreshAppleDeveloperToken } from './appleMusicToken'

const APPLE_WEBPLAYBACK_URL = 'https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/webPlayback'

export interface AppleNativeStream {
  /** 选定的媒体播放清单（.m3u8）URL */
  url: string
  /** 主清单（变体集合）URL */
  masterUrl: string
  /** vasic1 → EME 密钥服务配置（证书 / license 服务） */
  hlsKeyCertUrl?: string
  hlsKeyServerUrl?: string
  widevineCertUrl?: string
  /** license 请求的 adam-id（webPlayback 返回的 songId，与 SDK 一致） */
  licenseAdamId?: string
  /** 触发的曲目 id（诊断用） */
  songId: string
  /** CENC 清单中原始的 EXT-X-KEY data: URI（license 请求的 uri 字段必须用它，而非改写后的 PSSH URI） */
  cencKeyUri?: string
  /** 当前流改写清单对应的 blob URL；由挂载该流的播放器负责释放 */
  manifestObjectUrl?: string
  /** 直播流（电台/直播视频）：时长按 Infinity 处理，不做进度/切歌 */
  live?: boolean
}

/** 原生音源总开关（localStorage，默认开） */
export function isAppleNativeStreamEnabled(): boolean {
  return localStorage.getItem('appleNativeStream') !== 'false'
}

/** 最近一次原生取流的失败原因（供 UI 提示/诊断；成功或未尝试时为空） */
let lastNativeFailReason = ''

// Apple license 明确拒绝（例如 -1021）后，本会话内不重复消耗 30s HLS/EME 超时；
// 上层会立即走 WebView2 兼容播放。-1021 可能来自 VMP、session、限流或服务端状态，
// 不能再解释为“Apple 整类拒绝 L3/MF 才可用”。重启应用会重新探活一次。
let cencRejected = false
export function markCencRejected(): void {
  cencRejected = true
  console.warn('[ApplePlayback] CENC license 本会话被拒，后续直接走兼容播放（重启后重新探活）')
}
function isCencRejected(): boolean {
  return cencRejected
}

/** 最近一次 EME 能力检测的失败原因（供 UI 提示） */
let lastEmeFailReason = ''
export function getAppleNativeFailReason(): string {
  return lastNativeFailReason || lastEmeFailReason || ''
}
function setNativeFailReason(reason: string): void {
  lastNativeFailReason = reason
  console.warn('[ApplePlayback] 原生音源不可用：' + reason)
  forwardToMainLog('[ApplePlayback] 原生音源不可用：' + reason)
}
function setEmeFailReason(reason: string): void {
  lastEmeFailReason = reason
  console.warn('[ApplePlayback] Widevine EME 不可用：' + reason)
  forwardToMainLog('[ApplePlayback] Widevine EME 不可用：' + reason)
}
/** 转发到主进程控制台（开发者查看的后台窗口），不产生任何 UI 提示 */
function forwardToMainLog(message: string): void {
  try {
    const bridge = (window as any).electron
    if (bridge && typeof bridge.log === 'function') bridge.log(message)
  } catch { /* 无桥（纯浏览器）时忽略 */ }
}

// ─────────────────────────── webPlayback 取流 ───────────────────────────

interface AppleWebPlaybackItem {
  songId?: unknown
  assets?: Array<{ URL?: unknown; url?: unknown }>
  attributes?: {
    assetUrl?: unknown
    offers?: Array<{ hlsUrl?: unknown }>
  }
  'hls-key-cert-url'?: unknown
  'hls-key-server-url'?: unknown
  'widevine-cert-url'?: unknown
}

interface ApplePlaybackRequestResult<T> {
  ok: boolean
  status: number
  data?: T
  error?: string
}

async function runWebPlaybackRequest(
  songId: string,
  developerToken: string,
  mediaUserToken: string,
): Promise<ApplePlaybackRequestResult<AppleWebPlaybackItem>> {
  const bridge = (window as any).electron?.applePlayback
  if (typeof bridge === 'function') {
    try {
      const result = await bridge(songId, developerToken, mediaUserToken)
      const songList = Array.isArray(result?.data?.songList) ? result.data.songList : []
      return { ok: Boolean(result?.ok), status: Number(result?.status) || 0, data: songList[0], error: result?.error }
    } catch (error) {
      return { ok: false, status: 0, error: `主进程取流调用失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  try {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(APPLE_WEBPLAYBACK_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${developerToken}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'X-Apple-Music-User-Token': mediaUserToken,
          Origin: 'https://music.apple.com',
          Referer: 'https://music.apple.com/',
        },
        body: JSON.stringify({ salableAdamId: String(songId) }),
        signal: controller.signal,
      })
      const data = await response.json().catch(() => null)
      const songList = Array.isArray(data?.songList) ? data.songList : []
      return { ok: response.ok, status: response.status, data: songList[0] }
    } finally {
      window.clearTimeout(timeout)
    }
  } catch (error) {
    return { ok: false, status: 0, error: `浏览器直连 webPlayback 被拦截（CORS/网络）：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 主进程代理取流（Electron）；纯浏览器退化为直连（大概率 CORS 失败 → null） */
async function fetchWebPlayback(songId: string, developerToken: string, mediaUserToken: string): Promise<AppleWebPlaybackItem | null> {
  let token = developerToken
  try {
    token = await prepareAppleDeveloperToken(token)
  } catch (error) {
    setNativeFailReason(error instanceof Error ? error.message : String(error))
    return null
  }

  let result = await runWebPlaybackRequest(songId, token, mediaUserToken)
  if ((result.status === 401 || result.status === 403) && shouldRefreshAppleDeveloperToken(token)) {
    try {
      const refreshedToken = await ensureAppleWebDevToken(true)
      if (refreshedToken && refreshedToken !== token) {
        localStorage.setItem('appleDeveloperToken', refreshedToken)
        token = refreshedToken
        result = await runWebPlaybackRequest(songId, token, mediaUserToken)
      }
    } catch {
      // 保留第一次响应；MUT/订阅错误不得覆盖当前有效 Developer Token。
    }
  }
  if (!result.ok) {
    setNativeFailReason(result.error || `webPlayback HTTP ${result.status || '?'}`)
    return null
  }
  return result.data || null
}

/** 取文本（Electron 走主进程代理避开 CORS；浏览器直连兜底） */
async function fetchText(url: string): Promise<string | null> {
  const bridge = (window as any).electron?.appleFetchUrl
  if (typeof bridge === 'function') {
    try {
      const result = await bridge(url)
      if (!result?.ok) return null
      return typeof result.text === 'string' ? result.text : null
    } catch {
      return null
    }
  }
  try {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 20000)
    const response = await fetch(url, { signal: controller.signal })
    window.clearTimeout(timeout)
    if (!response.ok) return null
    return await response.text()
  } catch {
    return null
  }
}

// ─────────────────────────── HLS 主清单解析 ───────────────────────────

function resolveUrl(uri: string, base: string): string {
  try {
    const resolved = new URL(uri, base).href
    if (resolved.startsWith('http://') || resolved.startsWith('https://')) return resolved
    return uri
  } catch {
    return uri
  }
}

// ─────────────────────────── CENC/Widevine 清单处理 ───────────────────────────

export function releaseAppleNativeStream(stream: AppleNativeStream | null | undefined): void {
  const objectUrl = stream?.manifestObjectUrl
  if (!objectUrl) return
  stream!.manifestObjectUrl = undefined
  try { URL.revokeObjectURL(objectUrl) } catch { /* 忽略 */ }
  recordAppleAcceptanceEvent('manifest-revoked')
}

function bytesFromBase64(b64: string): Uint8Array {
  const binary = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary')
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[])
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64')
}

const WIDEVINE_SYSTEM_ID = new Uint8Array([
  0xed, 0xef, 0x8b, 0xa9, 0x79, 0xd6, 0x4a, 0xce, 0xa3, 0xc8, 0x27, 0xdc, 0xd5, 0x1d, 0x21, 0xed,
])

/**
 * KID → Widevine PSSH（与 MusicKit JS 实测形态逐字节同构，Chrome 抓包验证）：
 * pssh v0（version+flags=0）+ widevine systemId + dataSize=20 +
 * data = protobuf `08 01 12 10 <KID 原文>`（field1=1, field2=16字节 KID）。
 * 不要改成 pssh v1 kid-list 形态：license 请求的 content_id 会随之改变，
 * Apple 服务器解析失败会返回 -1021（表面上是 CDM_EXPIRED）。
 */
function buildWidevinePssh(kid: Uint8Array): Uint8Array {
  const data = new Uint8Array(20)
  data[0] = 0x08
  data[1] = 0x01 // field 1 (varint): version = 1
  data[2] = 0x12
  data[3] = 0x10 // field 2 (bytes): length 16
  data.set(kid, 4)
  const box = new Uint8Array(32 + data.length)
  const view = new DataView(box.buffer)
  view.setUint32(0, box.length)
  box.set([0x70, 0x73, 0x73, 0x68], 4) // 'pssh'
  view.setUint32(8, 0) // version 0 + flags
  box.set(WIDEVINE_SYSTEM_ID, 12)
  view.setUint32(28, data.length)
  box.set(data, 32)
  return box
}

/** webPlayback 资产 → 候选清单 URL 列表（CENC 命名 rphq/rpsl 优先，FairPlay cphq/cpsl 与 identity ibhp* 靠后） */
function collectManifestCandidates(item: AppleWebPlaybackItem | null): string[] {
  if (!item) return []
  const urls: string[] = []
  const push = (raw: unknown) => {
    if (typeof raw !== 'string' || !raw) return
    const url = raw.startsWith('manifest://') ? raw.replace(/^manifest:\/\//, 'https://') : raw
    if ((url.startsWith('http://') || url.startsWith('https://')) && !urls.includes(url)) urls.push(url)
  }
  for (const asset of Array.isArray(item.assets) ? item.assets : []) {
    push(asset?.URL ?? asset?.url)
  }
  push(item.attributes?.assetUrl)
  push(item.attributes?.offers?.[0]?.hlsUrl)
  const score = (url: string) => (/\.rphq\./i.test(url) ? 0 : /\.rpsl\./i.test(url) ? 1 : 2)
  return urls.sort((a, b) => score(a) - score(b))
}

/**
 * 改写 CENC 清单为 hls.js 可用的 Widevine 形态：
 * - EXT-X-KEY：ISO-23001-7 + 裸 KID 不在 hls.js 支持列表（会被静默忽略）→
 *   换成 METHOD=SAMPLE-AES-CTR + widevine uuid keyFormat + data: PSSH URI，
 *   hls.js 会把 data: 字节直接当 pssh/initData 建 license 会话
 * - 分片与 EXT-X-MAP 的相对 URI 绝对化（清单以 blob: URL 加载，相对路径失锚）
 */
function rewriteCencManifest(text: string, manifestUrl: string, psshB64: string): string {
  return text.split('\n').map(line => {
    const trimmed = line.trim()
    if (!trimmed) return line
    if (trimmed.startsWith('#EXT-X-KEY')) {
      return `#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI="data:text/plain;base64,${psshB64}",KEYFORMAT="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"`
    }
    if (trimmed.startsWith('#EXT-X-MAP')) {
      return trimmed.replace(/URI="([^"]+)"/, (_all, uri: string) => `URI="${resolveUrl(uri, manifestUrl)}"`)
    }
    if (trimmed.startsWith('#')) return line
    return resolveUrl(trimmed, manifestUrl)
  }).join('\n')
}

/** 取流 + 选变体，返回可直接交给 hls.js 的媒体清单 URL 与 EME 配置 */
export async function resolveAppleNativeStream(songId: string): Promise<AppleNativeStream | null> {
  if (!isAppleNativeStreamEnabled()) return null
  if (!songId) return null
  // license 刚被 Apple 整类拒绝过：跳过本轮（回退载体），等冷却期过后再试
  if (isCencRejected()) {
    setNativeFailReason('CENC license 冷却期内（近期被 Apple 拒绝），跳过取流')
    return null
  }
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) {
    setNativeFailReason('AM 凭据缺失（developerToken/mediaUserToken 未配置）')
    return null
  }

  const item = await fetchWebPlayback(songId, credentials.developerToken, credentials.mediaUserToken)
  const licenseAdamId = item && item.songId ? String(item.songId) : songId
  const hasKeys = Boolean(item && (item['hls-key-cert-url'] || item['hls-key-server-url'] || item['widevine-cert-url']))

  // Chromium/hls.js 无法解 FairPlay（com.apple.streamingkeydelivery），必须选
  // CENC（METHOD=ISO-23001-7，Widevine/PlayReady 通用加密）资产变体；assets[0]
  // 通常是 FairPlay 专用（cphq/cpsl），直接用会「清单就绪但静默卡死 0:00」。
  const candidates = collectManifestCandidates(item)
  let cencUrl = ''
  let cencText = ''
  for (const candidate of candidates) {
    const text = await fetchText(candidate)
    if (!text || !text.includes('ISO-23001-7')) continue
    cencUrl = candidate
    cencText = text
    break
  }
  if (!cencUrl) {
    setNativeFailReason(`webPlayback 资产中无 CENC(Widevine) 清单（仅 FairPlay/identity 变体，共 ${candidates.length} 个，Chromium 无法解密）`)
    return null
  }

  const keyUriMatch = /#EXT-X-KEY:[^\n]*URI="([^"]+)"/.exec(cencText)
  const cencKeyUri = keyUriMatch ? keyUriMatch[1] : ''
  const kidB64 = cencKeyUri.includes('base64,') ? cencKeyUri.slice(cencKeyUri.indexOf('base64,') + 7).trim() : ''
  let kid = new Uint8Array(0)
  try { kid = bytesFromBase64(kidB64) } catch { /* 无效 KID 走下方兜底 */ }
  if (!kid.length) {
    setNativeFailReason('CENC 清单缺少可解析的 EXT-X-KEY KID（data: URI）')
    return null
  }

  // KID → Widevine PSSH v1（hls.js 对 widevine keyFormat 的 data: URI 直接当作
  // pssh/initData 使用，必须是完整 pssh box，裸 KID 无法让 CDM 生成 challenge）
  const psshB64 = base64FromBytes(buildWidevinePssh(kid))
  // 改写清单：KEY 行换 hls.js 支持的 widevine 形态 + 分片/EXT-X-MAP URI 绝对化
  // （清单以 blob: URL 交给 hls.js，相对路径会失锚）
  const manifest = rewriteCencManifest(cencText, cencUrl, psshB64)
  const manifestObjectUrl = URL.createObjectURL(new Blob([manifest], { type: 'application/vnd.apple.mpegurl' }))
  // 追加 .m3u8 伪后缀（fragment）：让 isHlsUrl() 等按 URL 形态的 HLS 判定继续生效；
  // blob: 取内容时 fragment 被浏览器忽略，对 hls.js 无副作用。
  const blobUrl = `${manifestObjectUrl}#apple-hls.m3u8`
  recordAppleAcceptanceEvent('manifest-created')

  lastNativeFailReason = ''
  forwardToMainLog(`[ApplePlayback] CENC/Widevine HLS 就绪: keys=${hasKeys ? 'yes' : 'no'}`)
  return {
    url: blobUrl,
    masterUrl: cencUrl,
    hlsKeyCertUrl: item ? String(item['hls-key-cert-url'] || '') : undefined,
    hlsKeyServerUrl: item ? String(item['hls-key-server-url'] || '') : undefined,
    widevineCertUrl: item ? String(item['widevine-cert-url'] || '') : undefined,
    licenseAdamId,
    songId,
    cencKeyUri,
    manifestObjectUrl,
  }
}

// ─────────────────────────── 电台直播取流（/v1/play/assets） ───────────────────────────

/** 电台 resource 的 playParams（来自 /v1/catalog/{sf}/stations/{id}） */
export interface AppleRadioPlayParams {
  id?: string
  kind?: string
  format?: string
  stationHash?: string
  hasDrm?: boolean
  mediaType?: string
}

const APPLE_PLAY_ASSETS_URL = 'https://api.music.apple.com/v1/play/assets'

async function runPlayAssetsRequest(
  query: string,
  developerToken: string,
  mediaUserToken: string,
): Promise<ApplePlaybackRequestResult<any>> {
  const bridge = (window as any).electron?.applePlayAssets
  if (typeof bridge === 'function') {
    try {
      const result = await bridge(query, developerToken, mediaUserToken)
      return { ok: Boolean(result?.ok), status: Number(result?.status) || 0, data: result?.data, error: result?.error }
    } catch (error) {
      return { ok: false, status: 0, error: `主进程 play/assets 调用失败：${error instanceof Error ? error.message : String(error)}` }
    }
  }

  try {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch(`${APPLE_PLAY_ASSETS_URL}?${query}`, {
        headers: {
          Authorization: `Bearer ${developerToken}`,
          Accept: 'application/json',
          'X-Apple-Music-User-Token': mediaUserToken,
          Origin: 'https://music.apple.com',
          Referer: 'https://music.apple.com/',
        },
        signal: controller.signal,
      })
      return { ok: response.ok, status: response.status, data: await response.json().catch(() => null) }
    } finally {
      window.clearTimeout(timeout)
    }
  } catch (error) {
    return { ok: false, status: 0, error: `浏览器直连 play/assets 被拦截（CORS/网络）：${error instanceof Error ? error.message : String(error)}` }
  }
}

/** 主进程代理取流（Electron）；纯浏览器退化直连（大概率 CORS 失败 → null） */
async function fetchPlayAssets(
  query: string,
  developerToken: string,
  mediaUserToken: string,
): Promise<any | null> {
  let token = developerToken
  try {
    token = await prepareAppleDeveloperToken(token)
  } catch (error) {
    setNativeFailReason(error instanceof Error ? error.message : String(error))
    return null
  }

  let result = await runPlayAssetsRequest(query, token, mediaUserToken)
  if ((result.status === 401 || result.status === 403) && shouldRefreshAppleDeveloperToken(token)) {
    try {
      const refreshedToken = await ensureAppleWebDevToken(true)
      if (refreshedToken && refreshedToken !== token) {
        localStorage.setItem('appleDeveloperToken', refreshedToken)
        token = refreshedToken
        result = await runPlayAssetsRequest(query, token, mediaUserToken)
      }
    } catch {
      // 保留第一次响应；MUT/订阅错误不得覆盖当前有效 Developer Token。
    }
  }
  if (!result.ok) {
    setNativeFailReason(result.error || `play/assets HTTP ${result.status || '?'}`)
    return null
  }
  return result.data
}

/**
 * 电台直播取流（Cider/MusicKit v3 同款）：
 * GET /v1/play/assets?<playParams>&keyFormat=web → results.assets[0] 携带
 * HLS 主清单 url 与 EME keyURLs（keyServerUrl / widevineKeyCertificateUrl）。
 * 返回的流交给既有 hls.js 管线（live 标记 → liveDurationInfinity）。
 */
export async function resolveAppleRadioStream(
  stationId: string,
  playParams?: AppleRadioPlayParams,
): Promise<AppleNativeStream | null> {
  if (!stationId) return null
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) {
    setNativeFailReason('AM 凭据缺失（developerToken/mediaUserToken 未配置）')
    return null
  }

  const params: Record<string, string> = { keyFormat: 'web' }
  if (playParams?.id) params.id = String(playParams.id)
  else params.id = stationId
  if (playParams?.kind) params.kind = String(playParams.kind)
  else params.kind = 'radioStation'
  if (playParams?.format) params.format = String(playParams.format)
  if (playParams?.stationHash) params.stationHash = String(playParams.stationHash)
  if (playParams?.hasDrm !== undefined) params.hasDrm = String(playParams.hasDrm)
  if (playParams?.mediaType) params.mediaType = String(playParams.mediaType)
  const query = new URLSearchParams(params).toString()

  const data = await fetchPlayAssets(query, credentials.developerToken, credentials.mediaUserToken)
  const assets: any[] = Array.isArray(data?.results?.assets) ? data.results.assets : []
  const candidates = assets.filter(asset => typeof (asset?.url || asset?.URL) === 'string')
  const asset = candidates.find(asset => {
    const keyServer = asset?.keyServerUrl || asset?.['hls-key-server-url']
    const certificate = asset?.widevineKeyCertificateUrl || asset?.['widevine-cert-url']
    return Boolean(keyServer && certificate)
  }) || candidates.find(asset => !asset?.hasDrm && !asset?.keyServerUrl) || candidates[0]
  const masterUrl = typeof (asset?.url || asset?.URL) === 'string' ? String(asset.url || asset.URL) : ''
  if (!masterUrl) {
    setNativeFailReason('play/assets 未返回可用 HLS 主清单（订阅态异常 / 地区限制 / 电台不可用）')
    return null
  }
  const resolved = masterUrl.startsWith('manifest://') ? masterUrl.replace(/^manifest:\/\//, 'https://') : masterUrl
  lastNativeFailReason = ''
  const licenseAdamId = playParams?.id ? String(playParams.id) : stationId
  forwardToMainLog(`[ApplePlayback] 电台直播 HLS 就绪: ${resolved.slice(0, 96)} keys=${asset?.keyServerUrl ? 'yes' : 'NO'} adam-id=${licenseAdamId.slice(0, 40)}`)
  return {
    url: resolved,
    masterUrl: resolved,
    hlsKeyServerUrl: typeof (asset?.keyServerUrl || asset?.['hls-key-server-url']) === 'string'
      ? String(asset.keyServerUrl || asset['hls-key-server-url']) : undefined,
    widevineCertUrl: typeof (asset?.widevineKeyCertificateUrl || asset?.['widevine-cert-url']) === 'string'
      ? String(asset.widevineKeyCertificateUrl || asset['widevine-cert-url']) : undefined,
    licenseAdamId,
    songId: stationId,
    live: true,
  }
}

// ─────────────────────────── EME 能力检测 ───────────────────────────

let emeCapabilityPromise: Promise<boolean> | null = null

/**
 * 当前环境是否支持 Apple 原生音源所需的 Widevine EME：
 * Chrome/Edge 原生支持；Electron 需主进程启动时注入 CDM 才能通过。
 * CDM 初始化是异步的（注入后首个请求可能仍未就绪），失败结果不缓存，
 * 下一次播放自动重试；成功结果缓存本次会话。
 */
export function isAppleEmeCapable(): Promise<boolean> {
  if (emeCapabilityPromise) return emeCapabilityPromise
  emeCapabilityPromise = (async () => {
    try {
      const { default: HlsConstructor } = await import('hls.js')
      if (!HlsConstructor.isSupported()) {
        setEmeFailReason('hls.js 不支持当前浏览器')
        return false
      }
      const navigatorWithEme = navigator as Navigator & {
        requestMediaKeySystemAccess?: (keySystem: string, configs: Array<Record<string, unknown>>) => Promise<unknown>
      }
      if (typeof navigatorWithEme.requestMediaKeySystemAccess !== 'function' || typeof (window as any).MediaKeys !== 'function') {
        setEmeFailReason('浏览器无 EME API（requestMediaKeySystemAccess/MediaKeys）')
        return false
      }
      const access = await navigatorWithEme.requestMediaKeySystemAccess('com.widevine.alpha', [
        {
          initDataTypes: ['cenc', 'keyids'],
          audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }],
          distinctiveIdentifier: 'optional',
          persistentState: 'optional',
        },
      ])
      const result = Boolean(access)
      if (!result) {
        setEmeFailReason('requestMediaKeySystemAccess 返回空（CDM 可能尚未就绪）')
        emeCapabilityPromise = null // 失败不缓存：CDM 可能尚未就绪，下次重试
      } else {
        lastEmeFailReason = ''
      }
      return result
    } catch (error) {
      emeCapabilityPromise = null
      setEmeFailReason(`requestMediaKeySystemAccess 拒绝：${error instanceof Error ? error.message : String(error)}`)
      return false
    }
  })()
  return emeCapabilityPromise
}

// ─────────────────────────── hls.js EME 接线 ───────────────────────────

/** 标准 base64（bytes → string），challenge 按 SDK 编码口径提交 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[])
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(binary, 'binary').toString('base64')
}

/**
 * 构建 hls.js 播放 Apple HLS 流的配置：
 * - emeEnabled + drmSystems.widevine（licenseUrl + serverCertificateUrl）
 * - licenseXhrSetup：把 raw challenge 包装成 Apple license 服务的 JSON 协议
 *   （与 MusicKit JS createLicenseChallengeBody 的目录歌曲分支一致：平铺对象，
 *   字段 challenge/uri/key-system/adamId/isLibrary/user-initiated）
 * - licenseResponseCallback：license 响应 JSON → MediaKeySession.update 的 ArrayBuffer
 */
export function createAppleHlsConfig(
  stream: AppleNativeStream,
  options?: { developerToken?: string; mediaUserToken?: string },
): Record<string, unknown> {
  const { developerToken = '', mediaUserToken = '' } = options || {}
  return {
    emeEnabled: Boolean(stream.hlsKeyServerUrl),
    widevineLicenseUrl: stream.hlsKeyServerUrl,
    drmSystems: {
      widevine: {
        licenseUrl: stream.hlsKeyServerUrl,
        ...(stream.widevineCertUrl ? { serverCertificateUrl: stream.widevineCertUrl } : {}),
      },
      // hls.js 的证书/license 查找用完整密钥系统名（drmSystems["com.widevine.alpha"]），
      // 只写短名 widevine 时 serverCertificateUrl 会被跳过 → CDM 无证书 → 发 2 字节
      // SERVICE_CERTIFICATE_REQUEST 被当 license 请求 → 服务器 500
      'com.widevine.alpha': {
        licenseUrl: stream.hlsKeyServerUrl,
        ...(stream.widevineCertUrl ? { serverCertificateUrl: stream.widevineCertUrl } : {}),
      },
    },
    drmSystemOptions: {
      audioEncryptionScheme: 'cenc',
      videoEncryptionScheme: 'cenc',
    },
    // 直播流（电台）：时长置 Infinity 而非滑动窗口（避免进度条在窗口内来回走），
    // 音轨不追赶直播边缘（maxLiveSyncPlaybackRate=1，防止变速追尾）
    ...(stream.live ? { liveDurationInfinity: true, maxLiveSyncPlaybackRate: 1 } : {}),
    // hls.js 1.7 签名：licenseXhrSetup(xhr, url, keyContext, licenseChallenge)——
    // 注意没有 hls 实例参数（旧版五参写法会把 url 字符串当 xhr 用 → o.open is not a function）
    licenseXhrSetup: (xhr: XMLHttpRequest, url: string, keyContext: any, licenseChallenge: Uint8Array) => {
      recordAppleAcceptanceEvent('license-request')
      // 桌面端经本地 API 服务器代理（补 music.apple.com Origin/Referer；渲染进程直连时
      // Apple license 服务做来源校验，返回 200 + 无 license 的错误 JSON）
      const desktop = typeof window !== 'undefined' && Boolean((window as any).electron)
      const endpoint = desktop ? 'http://localhost:3001/api/apple/license' : (stream.hlsKeyServerUrl || url)
      if (!xhr.readyState) xhr.open('POST', endpoint, true)
      xhr.setRequestHeader('Content-Type', 'application/json')
      xhr.setRequestHeader('Accept', 'application/json')
      if (developerToken) xhr.setRequestHeader('Authorization', `Bearer ${developerToken}`)
      if (mediaUserToken) {
        // 本地代理兼容两种入站头并统一转发 Apple 私有 license 所需的 Media-User-Token。
        // 直接发送规范名，避免 token 在代理边界丢失。
        xhr.setRequestHeader('Media-User-Token', mediaUserToken)
      }
      xhr.setRequestHeader('X-Apple-Renewal', 'true')
      // uri 必须用清单里原始的 CENC data: KID URI（改写后的 PSSH URI 服务器不认），
      // 平铺协议同 MusicKit JS：无 license-requests 包裹、无 id、字段为 adamId
      const body = {
        challenge: bytesToBase64(licenseChallenge instanceof Uint8Array ? licenseChallenge : new Uint8Array(licenseChallenge)),
        uri: stream.cencKeyUri || (keyContext?.decryptdata?.uri as string) || '',
        'key-system': 'com.widevine.alpha',
        adamId: stream.licenseAdamId || stream.songId,
        isLibrary: false,
        'user-initiated': true,
      }
      return JSON.stringify(body)
    },
    // hls.js 1.7 签名：licenseResponseCallback(xhr, url, keyContext)，返回即最终 license 字节
    licenseResponseCallback: (xhr: XMLHttpRequest, _url: string, _keyContext: any) => {
      // hls.js 的 license XHR 是 responseType=arraybuffer，responseText 恒为空，
      // 需从 xhr.response（ArrayBuffer）解码后解析 JSON
      const raw: unknown = xhr.response
      let text = ''
      if (raw instanceof ArrayBuffer) {
        text = new TextDecoder().decode(raw)
      } else if (typeof (xhr as any).responseText === 'string' && (xhr as any).responseText) {
        text = (xhr as any).responseText
      } else if (typeof raw === 'string') {
        text = raw
      }
      let data: any = null
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        data = null
      }
      // 兼容平铺（{status, license}）与数组（{license-responses:[...]}）两种形态
      let payload: any = data
      if (payload && Array.isArray(payload['license-responses']) && payload['license-responses'].length) {
        payload = payload['license-responses'][0]
      }
      if (payload && typeof payload.status === 'number' && payload.status !== 0) {
        recordAppleAcceptanceEvent('license-failure')
        forwardToMainLog(`[ApplePlayback] license 响应被拒 status=${payload.status}`)
        // -1021 = CDM 身份类被 Apple 拒绝（Electron 经典 L3 CDM）：进入冷却，
        // 后续 Apple 歌曲跳过 CENC 空转直接走载体（10 分钟后自动重试）
        if (payload.status === -1021) markCencRejected()
        // -1002（failureType 2002）= Apple 账号会话过期：可感知提示引导重新登录，而非静默回退
        if (payload.status === -1002 && typeof window !== 'undefined') {
          try {
            window.dispatchEvent(new CustomEvent('app-toast', {
              detail: { message: 'Apple Music 登录会话已过期，请重新登录后再试', type: 'error' },
            }))
          } catch { /* 忽略 */ }
        }
        throw new Error(`[ApplePlayback] license 被拒 status=${payload.status}`)
      }
      const b64: unknown = payload?.license ?? payload?.licenseResponse
      if (typeof b64 !== 'string' || !b64) {
        recordAppleAcceptanceEvent('license-failure')
        forwardToMainLog(`[ApplePlayback] license 响应缺少 license 字段(HTTP ${xhr.status})`)
        throw new Error('[ApplePlayback] license 响应缺少 license 字段')
      }
      const binary = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary')
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      recordAppleAcceptanceEvent('license-success')
      return bytes.buffer as ArrayBuffer
    },
  }
}