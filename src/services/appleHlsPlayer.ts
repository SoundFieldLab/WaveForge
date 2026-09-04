/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/** Apple Music 原生 HLS：每个媒体 deck 独立拥有 hls.js / EME / manifest blob。 */
import { getAppleCredentials } from './appleAuth'
import { createAppleHlsConfig, releaseAppleNativeStream, type AppleNativeStream } from './applePlayback'
import { recordAppleAcceptanceEvent } from './appleAcceptanceDiagnostics'
import type Hls from 'hls.js'

type DeckHlsState = {
  hls: Hls
  stream: AppleNativeStream
  generation: number
  cancel?: () => void
  persistentErrorHandler?: (event: string, data: { fatal?: boolean; details?: string; type?: string }) => void
}

const hlsByDeck = new WeakMap<HTMLMediaElement, DeckHlsState>()
const generationByDeck = new WeakMap<HTMLMediaElement, number>()

export function isHlsUrl(url: string): boolean {
  return /\.m3u8(?:[?#]|$)/i.test(url || '')
}

export function getActiveHls(element: HTMLMediaElement | null): Hls | undefined {
  return element ? hlsByDeck.get(element)?.hls : undefined
}

export function getActiveAppleStream(element: HTMLMediaElement | null): AppleNativeStream | undefined {
  return element ? hlsByDeck.get(element)?.stream : undefined
}

export function detachAppleHls(element: HTMLMediaElement | null): void {
  if (!element) return
  generationByDeck.set(element, (generationByDeck.get(element) || 0) + 1)
  const state = hlsByDeck.get(element)
  if (!state) return
  hlsByDeck.delete(element)
  if (state.cancel) {
    state.cancel()
    return
  }
  if (state.persistentErrorHandler) {
    try { state.hls.off((state.hls.constructor as typeof import('hls.js').default).Events.ERROR, state.persistentErrorHandler) } catch { /* ignore */ }
  }
  try { state.hls.destroy() } catch { /* ignore */ }
  recordAppleAcceptanceEvent('hls-destroyed')
  releaseAppleNativeStream(state.stream)
}

export async function attachAppleHls(
  element: HTMLMediaElement,
  stream: AppleNativeStream,
  onFatalAfterReady?: (error: Error) => void,
): Promise<void> {
  detachAppleHls(element)
  const generation = (generationByDeck.get(element) || 0) + 1
  generationByDeck.set(element, generation)
  const { default: HlsConstructor } = await import('hls.js')
  if (generationByDeck.get(element) !== generation) {
    releaseAppleNativeStream(stream)
    throw new Error('Apple HLS 加载已被更新请求取代')
  }
  if (!HlsConstructor.isSupported()) {
    releaseAppleNativeStream(stream)
    throw new Error('当前环境不支持 HLS 播放')
  }

  let hls: Hls
  try {
    const credentials = getAppleCredentials()
    hls = new HlsConstructor(createAppleHlsConfig(stream, {
      developerToken: credentials.developerToken,
      mediaUserToken: credentials.mediaUserToken,
    }))
  } catch (error) {
    releaseAppleNativeStream(stream)
    throw error
  }

  const state: DeckHlsState = { hls, stream, generation }
  hlsByDeck.set(element, state)
  recordAppleAcceptanceEvent('hls-attached')
  const isCurrent = () => hlsByDeck.get(element) === state && generationByDeck.get(element) === generation
  const disposeFailedAttach = () => {
    if (hlsByDeck.get(element) === state) hlsByDeck.delete(element)
    try { hls.destroy() } catch { /* ignore */ }
    recordAppleAcceptanceEvent('hls-destroyed')
    releaseAppleNativeStream(stream)
  }
  const describeError = (data: { details?: string; type?: string }) => {
    const detail = String(data?.details || '')
    const type = String(data?.type || '')
    return new Error(`Apple HLS 加载失败（${detail || type || '未知错误'}）`)
  }
  const forwardError = (data: { fatal?: boolean; details?: string; type?: string }) => {
    try {
      const bridge = (window as any).electron
      if (bridge && typeof bridge.log === 'function') {
        bridge.log(`[AppleHLS] error type=${String(data?.type || '')} details=${String(data?.details || '')} fatal=${data?.fatal === true}`)
      }
    } catch { /* ignore */ }
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false
    const timeout = window.setTimeout(() => settleReject(new Error('Apple HLS 加载超时')), 35_000)
    const cleanupLoadingListeners = () => {
      window.clearTimeout(timeout)
      hls.off(HlsConstructor.Events.FRAG_BUFFERED, onFragmentBuffered)
      hls.off(HlsConstructor.Events.ERROR, onLoadingError)
    }
    const settleResolve = () => {
      if (settled) return
      if (!isCurrent()) {
        settleReject(new Error('Apple HLS 加载已被更新请求取代'))
        return
      }
      settled = true
      state.cancel = undefined
      cleanupLoadingListeners()
      const persistentErrorHandler = (_event: string, data: { fatal?: boolean; details?: string; type?: string }) => {
        forwardError(data)
        const keyRelated = /KEY|LICENSE|EME|DRM/i.test(String(data?.details || '') + String(data?.type || ''))
        if (!isCurrent() || (!data?.fatal && !keyRelated)) return
        const error = describeError(data)
        detachAppleHls(element)
        onFatalAfterReady?.(error)
      }
      state.persistentErrorHandler = persistentErrorHandler
      hls.on(HlsConstructor.Events.ERROR, persistentErrorHandler)
      recordAppleAcceptanceEvent('hls-ready')
      resolve()
    }
    const settleReject = (error: Error) => {
      if (settled) return
      settled = true
      cleanupLoadingListeners()
      disposeFailedAttach()
      reject(error)
    }
    state.cancel = () => settleReject(new Error('Apple HLS 加载已取消'))
    const onFragmentBuffered = () => settleResolve()
    const onLoadingError = (_event: string, data: { fatal?: boolean; details?: string; type?: string }) => {
      forwardError(data)
      const keyRelated = /KEY|LICENSE|EME|DRM/i.test(String(data?.details || '') + String(data?.type || ''))
      if (data?.fatal || keyRelated) settleReject(describeError(data))
    }
    hls.on(HlsConstructor.Events.FRAG_BUFFERED, onFragmentBuffered)
    hls.on(HlsConstructor.Events.ERROR, onLoadingError)
    try {
      hls.attachMedia(element)
      hls.loadSource(stream.url)
    } catch (error) {
      settleReject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
