import { debugLog } from '../../utils/debugLog'

/**
 * 频响补偿设计服务（独立模块，与响度归一化、节拍分析完全解耦）
 *
 * 调用 Python 独立补偿服务（3004 `/compensation`）把目标补偿曲线（ISO 226 等响度自适应 /
 * 场景预设 / 自定义频段）离散为多段 Biquad 滤波器参数，返回给音效引擎用
 * Web Audio BiquadFilterNode 构建补偿链。设计结果按 (mode+preset+volume 档位) 缓存。
 *
 * 方法论见《音频频响补偿技术解析.md》：目标曲线设定 → 多段滤波补偿 → 场景化预设 → 自适应。
 */

export type CompensationMode = 'auto' | 'preset' | 'custom'

export interface CompensationSegment {
  type: 'lowshelf' | 'peaking' | 'highshelf'
  frequency: number
  q: number
  gain: number // dB
}

export interface CompensationDesign {
  segments: CompensationSegment[]
  label: string
  mode: CompensationMode
  preset?: string
  volume?: number
}

const COMPENSATION_SERVICE_URL = 'http://localhost:3004'
const DESIGN_TIMEOUT_MS = 15_000
const PYTHON_HEALTHY_CACHE_MS = 30_000
const PYTHON_UNAVAILABLE_RETRY_MS = 5_000
const CACHE_KEY = 'waveforge:compensation-cache'
const CACHE_MAX_ENTRIES = 60
/** auto 模式下音量分档，避免拖动音量时频繁重新设计（±5% 内复用缓存） */
const VOLUME_QUANTUM = 5

export const COMPENSATION_PRESETS: Array<{ id: string; name: string }> = [
  { id: 'flat', name: '监听平直' },
  { id: 'bass', name: '低频补偿' },
  { id: 'vocal', name: '人声突出' },
  { id: 'warm', name: '温暖' },
  { id: 'bright', name: '通透' },
  { id: 'night', name: '夜间温和' },
]

interface DesignCacheEntry {
  design: CompensationDesign
  at: number
}

function loadCache(): Record<string, DesignCacheEntry> {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, DesignCacheEntry>
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveCache(cache: Record<string, DesignCacheEntry>): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache))
  } catch {
    // 忽略存储失败（配额/隐私模式）
  }
}

function cacheKeyFor(
  mode: CompensationMode,
  preset: string,
  volume: number | null,
  customBands?: Array<{ frequency: number; gain: number }>,
): string {
  if (mode === 'preset') return `preset:${preset}`
  // custom 模式缓存键必须包含频段指纹：否则用户拖动自定义频段后 design() 命中旧缓存永不更新。
  // 指纹与引擎侧 compensationDesignKey()（`custom:${JSON.stringify(bands || [])}`）保持一致。
  if (mode === 'custom') return `custom:${JSON.stringify(customBands || [])}`
  const bucket = volume === null ? 100 : Math.round(volume / VOLUME_QUANTUM) * VOLUME_QUANTUM
  return `auto:${Math.max(0, Math.min(100, bucket))}`
}

export class CompensationService {
  private memoryCache = new Map<string, CompensationDesign>()
  private pythonHealthyAt = 0
  private pythonUnavailableUntil = 0
  private inflight = new Map<string, Promise<CompensationDesign | null>>()
  private requestSeq = 0

  private isPythonReady(): boolean {
    const now = Date.now()
    return now < this.pythonHealthyAt || now >= this.pythonUnavailableUntil
  }

  private remember(key: string, design: CompensationDesign): void {
    // 内存层同样做最旧淘汰（与 localStorage 层 CACHE_MAX_ENTRIES 上限对齐）：
    // delete 后 set 让新条目排到队尾（Map 保序），超限时从头淘汰最旧。
    this.memoryCache.delete(key)
    this.memoryCache.set(key, design)
    while (this.memoryCache.size > CACHE_MAX_ENTRIES) {
      const oldestKey = this.memoryCache.keys().next().value
      if (oldestKey === undefined) break
      this.memoryCache.delete(oldestKey)
    }
    const cache = loadCache()
    cache[key] = { design, at: Date.now() }
    const entries = Object.entries(cache)
    if (entries.length > CACHE_MAX_ENTRIES) {
      entries.sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0))
      for (const [oldKey] of entries.slice(CACHE_MAX_ENTRIES)) delete cache[oldKey]
    }
    saveCache(cache)
  }

  private getCached(key: string): CompensationDesign | null {
    const mem = this.memoryCache.get(key)
    if (mem) return mem
    const persisted = loadCache()[key]
    if (persisted?.design?.segments?.length) {
      this.memoryCache.set(key, persisted.design)
      return persisted.design
    }
    return null
  }

  /**
   * 设计频响补偿。mode='auto' 时按系统音量等响度自适应；preset/custom 按配置。
   * 服务不可用/失败返回 null（引擎回退到内置近似）。
   */
  async design(mode: CompensationMode, preset: string, volume: number | null, customBands?: Array<{ frequency: number; gain: number }>): Promise<CompensationDesign | null> {
    const key = cacheKeyFor(mode, preset, volume, customBands)
    const cached = this.getCached(key)
    if (cached) return cached

    if (!this.isPythonReady()) return null
    const existing = this.inflight.get(key)
    if (existing) return existing

    const seq = ++this.requestSeq
    const task = (async () => {
      const controller = new AbortController()
      const timeoutId = window.setTimeout(() => controller.abort(new DOMException('compensation design timed out', 'TimeoutError')), DESIGN_TIMEOUT_MS)
      try {
        const body: Record<string, unknown> = { mode }
        if (mode === 'auto') body.volume = volume ?? 100
        if (mode === 'preset') body.preset = preset
        if (mode === 'custom') body.bands = customBands || []
        const response = await fetch(`${COMPENSATION_SERVICE_URL}/compensation`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!response.ok) {
          this.pythonUnavailableUntil = Date.now() + PYTHON_UNAVAILABLE_RETRY_MS
          return null
        }
        const data = await response.json() as Partial<CompensationDesign>
        if (!Array.isArray(data.segments) || data.segments.length === 0 || seq !== this.requestSeq) return null
        const design: CompensationDesign = {
          segments: data.segments,
          label: typeof data.label === 'string' ? data.label : '频响补偿',
          mode,
          preset: typeof data.preset === 'string' ? data.preset : undefined,
          volume: typeof data.volume === 'number' ? data.volume : undefined,
        }
        this.pythonHealthyAt = Date.now() + PYTHON_HEALTHY_CACHE_MS
        this.remember(key, design)
        debugLog(`[Compensation] 设计完成: ${design.label} (${design.segments.length} 段)`)
        return design
      } catch {
        this.pythonUnavailableUntil = Date.now() + PYTHON_UNAVAILABLE_RETRY_MS
        return null
      } finally {
        window.clearTimeout(timeoutId)
        this.inflight.delete(key)
      }
    })()

    this.inflight.set(key, task)
    return task
  }

  /** 使在途设计结果失效（引擎模式/音量变化时调用） */
  invalidate(): void {
    this.requestSeq++
  }
}

export const compensationService = new CompensationService()
