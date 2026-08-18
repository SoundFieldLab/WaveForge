import { debugLog } from '../../utils/debugLog'
import type { AudioEffectsEngine } from './AudioEffectsEngine'

/**
 * 响度归一化服务（独立模块，与节拍分析完全解耦）
 *
 * 流程：按曲目调用 Python 节拍服务的独立 `/lufs` 端点测量 ITU-R BS.1770 积分响度，
 * 换算成把整曲对齐到目标响度所需的增益，并施加到音效引擎的链首归一化增益节点。
 * 测量结果缓存于内存 + localStorage（按 trackKey），切歌时秒级生效、不重复测量。
 *
 * 归一化总开关位于调音室（AudioEffectsSettings.normalizationEnabled）。
 */

// 目标响度：-14 LUFS（主流流媒体采用的串流式响度标准）
export const TARGET_LUFS = -14
// 单曲增益上限：防止过度拉高把安静曲目推爆（前端还有 -6dB 保护限幅器兜底）
export const MAX_GAIN_DB = 9
export const MIN_GAIN_DB = -9

const PYTHON_BEAT_SERVICE_URL = 'http://localhost:3003'
const LUFS_TIMEOUT_MS = 60_000
const PYTHON_HEALTHY_CACHE_MS = 30_000
const PYTHON_UNAVAILABLE_RETRY_MS = 5_000
const CACHE_KEY = 'waveforge:lufs-cache'
const CACHE_MAX_ENTRIES = 300

/** 由整曲响度换算归一化增益（dB）：目标响度 - 实际响度，clamp 到 ±9dB */
export function gainDbForLufs(lufs: number): number {
  if (!Number.isFinite(lufs)) return 0
  const gain = TARGET_LUFS - lufs
  return Math.max(MIN_GAIN_DB, Math.min(MAX_GAIN_DB, gain))
}

interface LufsCacheEntry {
  lufs: number
  at: number
}

function loadLufsCache(): Record<string, LufsCacheEntry> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, LufsCacheEntry>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveLufsCache(cache: Record<string, LufsCacheEntry>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // 忽略存储失败（配额/隐私模式）
  }
}

export class LoudnessNormalizationService {
  private memoryCache = new Map<string, number>()
  private pythonHealthyAt = 0
  private pythonUnavailableUntil = 0
  private inflight = new Map<string, Promise<number | null>>()
  /** 单调递增的操作序号：切歌/开关变化使旧 apply 的测量结果作废，防止迟到的结果覆盖新歌增益 */
  private applySeq = 0

  /** 从缓存读取（内存优先，其次 localStorage 持久层） */
  getCachedLufs(trackKey: string): number | null {
    const key = trackKey.trim()
    if (!key) return null
    const mem = this.memoryCache.get(key)
    if (typeof mem === 'number') return mem
    const persisted = loadLufsCache()[key]
    if (persisted && typeof persisted.lufs === 'number') {
      this.memoryCache.set(key, persisted.lufs)
      return persisted.lufs
    }
    return null
  }

  private remember(key: string, lufs: number): void {
    // 内存层同样做最旧淘汰（与 localStorage 层 CACHE_MAX_ENTRIES 上限对齐）：
    // delete 后 set 让新条目排到队尾（Map 保序），超限时从头淘汰最旧。
    this.memoryCache.delete(key)
    this.memoryCache.set(key, lufs)
    while (this.memoryCache.size > CACHE_MAX_ENTRIES) {
      const oldestKey = this.memoryCache.keys().next().value
      if (oldestKey === undefined) break
      this.memoryCache.delete(oldestKey)
    }
    const cache = loadLufsCache()
    cache[key] = { lufs, at: Date.now() }
    const entries = Object.entries(cache)
    if (entries.length > CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
      for (const [oldKey] of entries.slice(CACHE_MAX_ENTRIES)) delete cache[oldKey]
    }
    saveLufsCache(cache)
  }

  private isPythonReady(): boolean {
    const now = Date.now()
    return now < this.pythonHealthyAt || now >= this.pythonUnavailableUntil
  }

  private async resolveLocalPath(url: string, trackKey: string): Promise<string | null> {
    if (!url.startsWith('http://') && !url.startsWith('https://')) return url
    if (!window.electron?.audioDownload) return null
    try {
      return await window.electron.audioDownload.prepare(url, trackKey)
    } catch (error) {
      debugLog('[Loudness] 音频下载失败:', error)
      return null
    }
  }

  /** 测量单曲响度（LUFS）；服务不可用/失败返回 null。并发去重 + 结果缓存 */
  async measure(trackKey: string, url: string): Promise<number | null> {
    const key = trackKey.trim()
    if (!key) return null
    const cached = this.getCachedLufs(key)
    if (cached !== null) return cached
    const existing = this.inflight.get(key)
    if (existing) return existing

    const task = (async () => {
      if (!this.isPythonReady()) return null
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(new DOMException('lufs timed out', 'TimeoutError')), LUFS_TIMEOUT_MS)
      try {
        const audioPath = await this.resolveLocalPath(url, key)
        if (!audioPath) return null
        const response = await fetch(`${PYTHON_BEAT_SERVICE_URL}/lufs`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ trackKey: key, audioPath }),
          signal: controller.signal,
        })
        if (!response.ok) {
          this.pythonUnavailableUntil = Date.now() + PYTHON_UNAVAILABLE_RETRY_MS
          return null
        }
        const data = await response.json() as { integratedLufs?: number }
        const lufs = typeof data.integratedLufs === 'number' && Number.isFinite(data.integratedLufs) ? data.integratedLufs : null
        if (lufs === null) return null
        this.pythonHealthyAt = Date.now() + PYTHON_HEALTHY_CACHE_MS
        this.remember(key, lufs)
        return lufs
      } catch {
        this.pythonUnavailableUntil = Date.now() + PYTHON_UNAVAILABLE_RETRY_MS
        return null
      } finally {
        window.clearTimeout(timeoutId)
      }
    })()

    this.inflight.set(key, task)
    try {
      return await task
    } finally {
      this.inflight.delete(key)
    }
  }

  /**
   * 对当前歌曲应用归一化增益。由调用方在切歌 / 开关变化时触发：
   * - 引擎关闭归一化 → 立即回退原声（0dB）
   * - 测量失败（服务不可用等）→ 回退原声，不影响播放
   */
  async apply(engine: AudioEffectsEngine, trackKey: string, url: string): Promise<void> {
    // 记录本次操作的序号；测量是异步的（最长 60s），期间可能已切歌或关闭归一化。
    const seq = ++this.applySeq
    if (!engine.getSettings().normalizationEnabled) {
      engine.setNormalizationGain(null)
      return
    }
    const lufs = await this.measure(trackKey, url)
    // 序号不匹配 = 期间有更新 apply/reset，迟到的结果直接丢弃，避免把上一首的增益套到当前歌上
    if (seq !== this.applySeq) return
    if (lufs === null) {
      engine.setNormalizationGain(null)
      return
    }
    const gain = gainDbForLufs(lufs)
    engine.setNormalizationGain(gain)
    debugLog(`[Loudness] 归一化 ${trackKey}: ${lufs} LUFS → ${gain >= 0 ? '+' : ''}${gain.toFixed(1)}dB`)
  }

  /** 关闭归一化（引擎置 0dB） */
  reset(engine: AudioEffectsEngine): void {
    // 递增序号使在途 apply 失效，防止其稍后重新施加增益
    this.applySeq += 1
    engine.setNormalizationGain(null)
  }
}

export const loudnessNormalizationService = new LoudnessNormalizationService()
