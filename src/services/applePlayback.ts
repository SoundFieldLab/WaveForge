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
}

/** 原生音源总开关（localStorage，默认开） */
export function isAppleNativeStreamEnabled(): boolean {
  return localStorage.getItem('appleNativeStream') !== 'false'
}

/** 最近一次原生取流的失败原因（供 UI 提示/诊断；成功或未尝试时为空） */
let lastNativeFailReason = ''
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
  assets?: Array<{ URL?: unknown }>
  attributes?: {
    assetUrl?: unknown
    offers?: Array<{ hlsUrl?: unknown }>
  }
  'hls-key-cert-url'?: unknown
  'hls-key-server-url'?: unknown
  'widevine-cert-url'?: unknown
}

/** 主进程代理取流（Electron）；纯浏览器退化为直连（大概率 CORS 失败 → null） */
async function fetchWebPlayback(songId: string, developerToken: string, mediaUserToken: string): Promise<AppleWebPlaybackItem | null> {
  const bridge = (window as any).electron?.applePlayback
  if (typeof bridge === 'function') {
    try {
      const result = await bridge(songId, developerToken, mediaUserToken)
      if (!result?.ok) {
        setNativeFailReason(`webPlayback HTTP ${result?.status || '?'}${result?.error ? '（' + result.error + '）' : ''}`)
        return null
      }
      const songList = Array.isArray(result?.data?.songList) ? result.data.songList : []
      return (songList[0] as AppleWebPlaybackItem) || null
    } catch (error) {
      setNativeFailReason(`主进程取流调用失败：${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
  // 浏览器直连兜底（amp-api 与 itunes 域通常无 CORS 放行，仅开发模式可用）
  try {
    const controller = new AbortController()
    const timeout = window.setTimeout(() => controller.abort(), 15000)
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
    window.clearTimeout(timeout)
    if (!response.ok) {
      setNativeFailReason(`浏览器直连 webPlayback HTTP ${response.status}（建议检查主进程 IPC）`)
      return null
    }
    const data = await response.json().catch(() => null)
    const songList = Array.isArray(data?.songList) ? data.songList : []
    return (songList[0] as AppleWebPlaybackItem) || null
  } catch (error) {
    setNativeFailReason(`浏览器直连 webPlayback 被拦截（CORS/网络）：${error instanceof Error ? error.message : String(error)}`)
    return null
  }
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

interface HlsVariant {
  bandwidth: number
  codec: string
  url: string
}

function resolveUrl(uri: string, base: string): string {
  try {
    const resolved = new URL(uri, base).href
    if (resolved.startsWith('http://') || resolved.startsWith('https://')) return resolved
    return uri
  } catch {
    return uri
  }
}

/** 解析主清单（#EXT-X-STREAM-INF 变体列表），与 SDK fetchPlaylistAssets 同口径 */
function parseMasterVariants(text: string, baseUrl: string): HlsVariant[] {
  const variants: HlsVariant[] = []
  const re = /#EXT-X-STREAM-INF:([^\n]*)[\r\n]+([^\r\n]+)/g
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    const attrs = match[1]
    const uri = String(match[2]).trim()
    const codecs = /CODECS="([^"]*)"/.exec(attrs)?.[1] || ''
    const bandwidth = Number(/(?:^|,)BANDWIDTH=(\d+)/.exec(attrs)?.[1] || 0)
    if (!uri) continue
    variants.push({ bandwidth, codec: codecs, url: resolveUrl(uri, baseUrl) })
  }
  return variants
}

/** 选最佳音质变体：优先 AAC-LC（mp4a.40.2，Chromium 解码最稳），同级取最高码率 */
function pickBestVariant(variants: HlsVariant[]): HlsVariant | null {
  if (variants.length === 0) return null
  const aac = variants
    .filter(variant => /mp4a\.40\.2/i.test(variant.codec))
    .sort((a, b) => b.bandwidth - a.bandwidth)
  const pool = aac.length > 0 ? aac : [...variants].sort((a, b) => b.bandwidth - a.bandwidth)
  return pool[0]
}

function findMasterUrl(item: AppleWebPlaybackItem | null): string | null {
  if (!item) return null
  const candidates: unknown[] = [
    item.attributes?.assetUrl,
    item.attributes?.offers?.[0]?.hlsUrl,
    item.assets?.[0]?.URL,
  ]
  for (const raw of candidates) {
    if (typeof raw !== 'string' || !raw) continue
    const url = raw.startsWith('manifest://') ? raw.replace(/^manifest:\/\//, 'https://') : raw
    if (url.startsWith('http://') || url.startsWith('https://')) return url
  }
  return null
}

/** 取流 + 选变体，返回可直接交给 hls.js 的媒体清单 URL 与 EME 配置 */
export async function resolveAppleNativeStream(songId: string): Promise<AppleNativeStream | null> {
  if (!isAppleNativeStreamEnabled()) return null
  if (!songId) return null
  const credentials = getAppleCredentials()
  if (!credentials.developerToken || !credentials.mediaUserToken) {
    setNativeFailReason('AM 凭据缺失（developerToken/mediaUserToken 未配置）')
    return null
  }

  const item = await fetchWebPlayback(songId, credentials.developerToken, credentials.mediaUserToken)
  const masterUrl = findMasterUrl(item)
  if (!masterUrl) {
    setNativeFailReason('webPlayback 未返回可用的 HLS 主清单（非目录曲目 / 订阅态异常 / token 校验失败）')
    return null
  }

  let playableUrl = masterUrl
  let pickedCodec = ''
  const masterText = await fetchText(masterUrl)
  if (!masterText) {
    setNativeFailReason('主清单拉取失败（HLS 清单网络/代理问题）')
    return null
  }
  if (masterText.includes('#EXT-X-STREAM-INF')) {
    const variants = parseMasterVariants(masterText, masterUrl)
    const best = pickBestVariant(variants)
    if (best) {
      playableUrl = best.url
      pickedCodec = best.codec || ''
    }
  }
  lastNativeFailReason = ''
  // license adam-id 采用 webPlayback 返回的 songId（与 MusicKit SDK 一致；订阅态下
  // 该 id 才是 license 服务按歌曲聚合的正确键，传 salableAdamId 可能导致授权失败）
  const licenseAdamId = item && item.songId ? String(item.songId) : songId
  const hasKeys = Boolean(item && (item['hls-key-cert-url'] || item['hls-key-server-url'] || item['widevine-cert-url']))
  forwardToMainLog(`[ApplePlayback] 原生 HLS 就绪: ${playableUrl.slice(0, 96)} codec=${pickedCodec || '?'} keys=${hasKeys ? 'yes' : 'NO'} adam-id=${licenseAdamId.slice(0, 40)}`)

  // 极端兜底：主清单/变体解析失败时仍把主清单交给 hls.js（hls.js 可自己处理）
  return {
    url: playableUrl,
    masterUrl,
    hlsKeyCertUrl: item ? String(item['hls-key-cert-url'] || '') : undefined,
    hlsKeyServerUrl: item ? String(item['hls-key-server-url'] || '') : undefined,
    widevineCertUrl: item ? String(item['widevine-cert-url'] || '') : undefined,
    licenseAdamId,
    songId,
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
 * - licenseXhrSetup：把 raw challenge 包装成 Apple webPlaybackLicense 的 JSON 协议
 *   （与 MusicKit JS 的 createLicenseChallengeBody 完全一致），其返回值即请求体
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
    },
    drmSystemOptions: {
      audioEncryptionScheme: 'cenc',
      videoEncryptionScheme: 'cenc',
    },
    licenseXhrSetup: (_hls: unknown, xhr: XMLHttpRequest, _url: string, keyContext: any, licenseChallenge: Uint8Array) => {
      xhr.open('POST', stream.hlsKeyServerUrl || _url, true)
      xhr.setRequestHeader('Content-Type', 'application/json')
      xhr.setRequestHeader('Accept', 'application/json')
      if (developerToken) xhr.setRequestHeader('Authorization', `Bearer ${developerToken}`)
      if (mediaUserToken) xhr.setRequestHeader('X-Apple-Music-User-Token', mediaUserToken)
      xhr.setRequestHeader('X-Apple-Renewal', 'true')
      const keyUri = (keyContext?.decryptdata?.uri as string) || ''
      const payload = {
        'license-requests': [
          {
            challenge: bytesToBase64(licenseChallenge instanceof Uint8Array ? licenseChallenge : new Uint8Array(licenseChallenge)),
            uri: keyUri,
            'key-system': 'com.widevine.alpha',
            'adam-id': stream.licenseAdamId || stream.songId,
            id: 1,
          },
        ],
      }
      return JSON.stringify(payload)
    },
    licenseResponseCallback: (_hls: unknown, xhr: XMLHttpRequest) => {
      // hls.js 的 license XHR 是 responseType=arraybuffer，responseText 恒为空，
      // 需从 xhr.response（ArrayBuffer）解码后解析 JSON
      const raw: unknown = (xhr as any).response
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
      const b64: unknown = data?.license ?? data?.licenseResponse
      if (typeof b64 !== 'string' || !b64) {
        throw new Error('[ApplePlayback] license 响应缺少 license 字段')
      }
      const binary = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary')
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes.buffer as ArrayBuffer
    },
  }
}