/**
 * Apple Music WebView2 播放面桥接服务
 *
 * 架构：
 *   WaveForge (Electron) → HTTP → apple_bridge.py (pywebview) → WebView2 → music.apple.com
 *
 * Apple 歌曲在 Electron 原生 CENC 失败时可通过 WebView2 兼容窗口播放，
 * WaveForge 通过带会话认证的 HTTP 控制播放并读取进度（歌词/UI 同步）。
 *
 * bridge 进程生命周期：首次 Apple 歌曲时自动启动（由主进程 spawn），退出时跟随主进程关闭。
 */

const BRIDGE_PORT = 18790
const BRIDGE_URL = `http://127.0.0.1:${BRIDGE_PORT}`
const POLL_INTERVAL = 200 // ms
const SPAWN_FAILURE_RETRY_MS = 60_000

export interface ApplePlaybackState {
  ready: boolean
  authorized: boolean
  playing: boolean
  /** MusicKit 原始播放状态码（0 none / 1 loading / 2 playing / 3 paused / 4 stopped / 5 ended / 6 seeking / 7 stalled / 8 waiting） */
  status?: number
  position: number
  duration: number
  title: string
  artist: string
  /** MusicKit playbackStatus === 5（歌曲播完） */
  ended: boolean
}

export interface AppleSpectrum {
  bins: number[] // 0..255 × 64（对数分 bin，40Hz~16kHz）
  enabled: boolean
}

let pollTimer: number | null = null
let pollController: AbortController | null = null
let polling = false
let pollFailures = 0
let cachedState: ApplePlaybackState = {
  ready: false, authorized: false, playing: false,
  position: 0, duration: 0, title: '', artist: '', ended: false,
}
let stateListeners: Array<(s: ApplePlaybackState) => void> = []
let spawnFailedAt = 0
let sessionToken = ''

function bridgeFetch(path: string, init: RequestInit = {}) {
  if (!sessionToken) return Promise.reject(new Error('Apple bridge session is unavailable'))
  const headers = new Headers(init.headers)
  headers.set('X-WaveForge-Bridge-Token', sessionToken)
  return fetch(`${BRIDGE_URL}${path}`, { ...init, headers })
}

/** 检查 bridge 是否在跑 */
export async function checkBridgeRunning(): Promise<boolean> {
  try {
    const res = await bridgeFetch(`/ping`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) {
      const d = await res.json()
      if (d.ok) {
        // 立即拉一次状态：保证 ensureBridgeRunning 返回后 authorized/position 等字段已就绪，
        // 否则调用方马上读 getState() 会拿到过期缓存（authorized 误判 false → 走载体）
        try {
          const sres = await bridgeFetch(`/state`, { signal: AbortSignal.timeout(2000) })
          if (sres.ok) {
            const s: ApplePlaybackState = await sres.json()
            cachedState = s
            stateListeners.forEach(fn => { try { fn(s) } catch { /* 忽略 */ } })
          }
        } catch { /* 轮询稍后补上 */ }
        return true
      }
    }
  } catch { /* 不在跑 */ }
  return false
}

/** 请求主进程启动 bridge（通过 window.electron IPC） */
export async function ensureBridgeRunning(): Promise<boolean> {
  // 先检查已有实例
  if (await checkBridgeRunning()) return true

  // 启动失败负缓存：60s 内不再重试（避免每首歌都等 20s 启动超时）
  if (spawnFailedAt && Date.now() - spawnFailedAt < SPAWN_FAILURE_RETRY_MS) return false

  // 通过 Electron IPC 启动 bridge 进程
  try {
    const electron = (window as any).electron
    if (electron?.spawnAppleBridge) {
      const result = await electron.spawnAppleBridge()
      if (!result?.ok || typeof result.token !== 'string' || !result.token) {
        spawnFailedAt = Date.now()
        return false
      }
      sessionToken = result.token
    } else {
      // 没有 IPC 通道（纯浏览器模式）：无法自动启动
      console.warn('[AppleBridge] bridge 未运行且无法自动启动（需要 Electron 环境）')
      spawnFailedAt = Date.now()
      return false
    }
  } catch {
    spawnFailedAt = Date.now()
    return false
  }

  // 等待 bridge 就绪（最多 20 秒——WebView2 初始化 + 页面加载）
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500))
    if (await checkBridgeRunning()) return true
  }
  console.warn('[AppleBridge] bridge 启动超时')
  spawnFailedAt = Date.now()
  return false
}

/** 开始单飞状态轮询：上一请求完成后再安排下一次，避免慢响应堆叠。 */
function startPolling() {
  if (polling) return
  polling = true
  const poll = async () => {
    if (!polling) return
    pollController = new AbortController()
    const timeout = window.setTimeout(() => pollController?.abort(), 3000)
    try {
      const res = await bridgeFetch('/state', { signal: pollController.signal })
      if (res.ok) {
        const s: ApplePlaybackState = await res.json()
        const prev = cachedState
        pollFailures = 0
        cachedState = s
        if (
          prev.ready !== s.ready
          || prev.playing !== s.playing
          || prev.ended !== s.ended
          || Math.abs(prev.position - s.position) > 0.1
        ) {
          stateListeners.forEach(fn => { try { fn(s) } catch { /* 忽略 */ } })
        }
      } else {
        markPollFailure()
      }
    } catch {
      if (polling) markPollFailure()
    } finally {
      window.clearTimeout(timeout)
      pollController = null
      if (polling) pollTimer = window.setTimeout(poll, POLL_INTERVAL)
    }
  }
  void poll()
}

function stopPolling() {
  polling = false
  if (pollTimer !== null) {
    clearTimeout(pollTimer)
    pollTimer = null
  }
  pollController?.abort()
  pollController = null
}

/** 连续轮询失败：bridge 可能被手关/崩溃 → 标记不可用并通知订阅者 */
function markPollFailure() {
  pollFailures += 1
  if (pollFailures >= 3 && cachedState.ready) {
    cachedState = { ...cachedState, ready: false, playing: false, ended: false }
    stateListeners.forEach(fn => { try { fn(cachedState) } catch { /* 忽略 */ } })
  }
}

/** 获取缓存状态（同步，用于 UI 高频读取） */
export function getState(): ApplePlaybackState {
  return { ...cachedState }
}

/** bridge 是否就绪（缓存值，同步；用于跳过无效的载体预载等门控） */
export function isBridgeReady(): boolean {
  return cachedState.ready
}

/** 注册状态监听器 */
export function onStateChange(fn: (s: ApplePlaybackState) => void): () => void {
  stateListeners.push(fn)
  startPolling()
  return () => {
    stateListeners = stateListeners.filter(f => f !== fn)
    if (stateListeners.length === 0) stopPolling()
  }
}

/** 播放指定歌曲（失败返回 false，触发上层静默回退） */
export async function bridgePlay(catalogId: string): Promise<boolean> {
  if (!(await ensureBridgeRunning())) return false
  try {
    const res = await bridgeFetch(`/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ catalogId }),
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return false
    const d = await res.json().catch(() => null)
    return Boolean(d?.ok)
  } catch { return false }
}

/** 暂停 */
export async function bridgePause() {
  try { await bridgeFetch(`/pause`, { method: 'POST', signal: AbortSignal.timeout(5000) }) } catch {}
}

/** 恢复播放 */
export async function bridgeResume() {
  try { await bridgeFetch(`/resume`, { method: 'POST', signal: AbortSignal.timeout(5000) }) } catch {}
}

/** 跳转 */
export async function bridgeSeek(position: number) {
  try {
    await bridgeFetch(`/seek`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ position }), signal: AbortSignal.timeout(5000),
    })
  } catch {}
}

/** 音量 */
export async function bridgeVolume(volume: number) {
  try {
    await bridgeFetch(`/volume`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ volume }), signal: AbortSignal.timeout(5000),
    })
  } catch {}
}

/** 音量斜坡（基础交叉淡化）：durationMs 内线性渐变到 to；新的绝对音量/换歌/seek 会撞销在途斜坡 */
export async function bridgeFade(to: number, durationMs: number) {
  try {
    await bridgeFetch(`/fade`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, durationMs }), signal: AbortSignal.timeout(5000),
    })
  } catch {}
}

/** 停止播放（不清轮询——切歌后可能立即再次 bridgePlay） */
export async function bridgeStopPlayback() {
  try { await bridgeFetch(`/stop`, { method: 'POST', signal: AbortSignal.timeout(3000) }) } catch {}
}

/** 显示播放面窗口（登录引导/设置入口用） */
export async function bridgeShowWindow() {
  try { await bridgeFetch(`/show`, { method: 'POST', signal: AbortSignal.timeout(5000) }) } catch {}
}

/** 隐藏播放面窗口 */
export async function bridgeHideWindow() {
  try { await bridgeFetch(`/hide`, { method: 'POST', signal: AbortSignal.timeout(5000) }) } catch {}
}

/** 读取 WASAPI 频谱（bridge 未启用采集时 bins 为全零） */
export async function fetchBridgeSpectrum(): Promise<AppleSpectrum | null> {
  try {
    const res = await bridgeFetch(`/spectrum`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    const d = await res.json()
    return { bins: Array.isArray(d.bins) ? d.bins : [], enabled: Boolean(d.enabled) }
  } catch { return null }
}

/** 停止播放并断开轮询（不再使用 bridge 时调用） */
export async function bridgeStop() {
  stopPolling()
  await bridgeStopPlayback()
  cachedState.ready = false
  sessionToken = ''
}
