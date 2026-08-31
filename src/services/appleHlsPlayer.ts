/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 原生 HLS 播放（hls.js 驱动 + Widevine EME 解密）
 *
 * 引擎接线：useAudioPlayer 的 loadAndPlay 在收到含 appleHls 元数据的 .m3u8
 * URL 时调用 attachAppleHls，用 hls.js 加载选定的媒体清单并等待首个分片就绪
 * （含 EME license 协商），随后由引擎照常 play()。切歌/卸载时 detachAppleHls
 * 销毁实例，避免与备用 deck 的普通音源互相干扰。
 */
import { getAppleCredentials } from './appleAuth'
import { createAppleHlsConfig, type AppleNativeStream } from './applePlayback'
import type Hls from 'hls.js'

/** 按 deck 媒体元素跟踪当前 hls 实例（deck 元素长期复用，用 WeakMap 免泄漏） */
const hlsByDeck = new WeakMap<HTMLMediaElement, Hls>()

export function isHlsUrl(url: string): boolean {
  return /\.m3u8(\?|$)/i.test(url || '')
}

export function getActiveHls(element: HTMLMediaElement | null): Hls | undefined {
  return element ? hlsByDeck.get(element) : undefined
}

/** 销毁某 deck 上挂载的 hls 实例（同时断开其 MSE 管线） */
export function detachAppleHls(element: HTMLMediaElement | null): void {
  if (!element) return
  const instance = hlsByDeck.get(element)
  if (instance) {
    try { instance.destroy() } catch { /* 忽略销毁异常 */ }
    hlsByDeck.delete(element)
  }
}

/**
 * 把 hls.js 挂到媒体元素并加载 Apple 的 HLS 流。
 * 同时支持 audio 与 video 元素（音乐视频/直播视频走同一管线）。
 * resolve：首个分片缓冲就绪（canplay/loadeddata/MANIFEST_PARSED 之一）；
 * reject：致命错误（清单/分段/EME license 失败）或超时。
 * 注意：本函数接管 src，调用方之后不要再对同一元素赋值 src 或调 load()。
 */
export async function attachAppleHls(element: HTMLMediaElement, stream: AppleNativeStream): Promise<void> {
  const { default: HlsConstructor } = await import('hls.js')
  detachAppleHls(element)
  if (!HlsConstructor.isSupported()) {
    throw new Error('当前环境不支持 HLS 播放')
  }
  const credentials = getAppleCredentials()
  const hls = new HlsConstructor(
    createAppleHlsConfig(stream, {
      developerToken: credentials.developerToken,
      mediaUserToken: credentials.mediaUserToken,
    }),
  )
  hlsByDeck.set(element, hls)
  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timeout = window.setTimeout(() => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Apple HLS 加载超时'))
    }, 35_000)
    const cleanup = () => {
      window.clearTimeout(timeout)
      hls.off(HlsConstructor.Events.FRAG_BUFFERED, onFragmentBuffered)
      hls.off(HlsConstructor.Events.ERROR, onError)
      element.removeEventListener('canplay', onReady)
      element.removeEventListener('loadeddata', onReady)
    }
    const settleResolve = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const onReady = () => settleResolve()
    // 只有首个加密分片真正进入 MSE 缓冲后才宣告成功；MANIFEST_PARSED/LEVEL_LOADED
    // 仅说明清单可读，此时 EME license 可能尚未取得，过早 resolve 会让 UI 假播放 0:00。
    const onFragmentBuffered = () => settleResolve()
    const onError = (_event: string, data: { fatal?: boolean; details?: string; type?: string }) => {
      // EME license / 密钥失败不会标 fatal，主动识别以尽快失败（而非等 35s 超时）
      const detail = String(data?.details || '')
      const type = String(data?.type || '')
      const keyRelated = /KEY|LICENSE|EME|DRM/i.test(detail + type)
      // 任何 hls.js 错误都对主控台转发便于定位（不弹 UI）
      try {
        const bridge = (window as any).electron
        if (bridge && typeof bridge.log === 'function') {
          bridge.log(`[AppleHLS] error type=${type} details=${detail} fatal=${data?.fatal === true} msg=${String((data as any)?.error?.message || (data as any)?.frag?.url || '').slice(0, 120)}`)
        }
      } catch { /* 忽略 */ }
      if (data?.fatal === true || keyRelated) {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`Apple HLS 加载失败（${detail || type || '未知错误'}）`))
      }
    }
    hls.on(HlsConstructor.Events.FRAG_BUFFERED, onFragmentBuffered)
    hls.on(HlsConstructor.Events.ERROR, onError)
    element.addEventListener('canplay', onReady, { once: true })
    element.addEventListener('loadeddata', onReady, { once: true })
    hls.attachMedia(element)
    hls.loadSource(stream.url)
  })
}