/**
 * WE 场景音频响应频谱总线
 *
 * App 在挂载时注册音频源（本地 analyser / 外部播放 WASAPI 频谱），本模块在有订阅者时
 * 自驱动 rAF 采样成 64 bin（0..1 响度）频谱——App 的桌面频谱 tick 是 100ms setTimeout，
 * 对音频可视化太粗，场景壁纸需要每帧级别的跟随。
 * 无订阅者自动停表；采样失败/未播放输出全 0（WE 静置语义一致）。
 */

export interface WeAudioSource {
  /** 本地播放的 AnalyserNode（首播才创建，可能为 null） */
  getAnalyser: () => AnalyserNode | null
  /** 外部播放（WebView2/WASAPI loopback）的频谱，64 对数 bin，0..255；无则返回 null */
  getExternalSpectrum: () => ArrayLike<number> | null
  /** 当前是否有音频在播（本地未暂停 或 外部播放激活） */
  isActive: () => boolean
}

const SPECTRUM_BINS = 64

type Listener = (spectrum: Float32Array) => void

let source: WeAudioSource | null = null
const listeners = new Set<Listener>()
let rafId = 0
/** 采样缓冲（Uint8 复用，避免每帧分配） */
let sampleBuffer: Uint8Array | null = null
/** 对外发布的频谱（复用同一实例） */
const publishedSpectrum = new Float32Array(SPECTRUM_BINS)

/** 注册音频源（App 挂载时调用一次；重复注册以最后一次为准） */
export function registerWeAudioSource(next: WeAudioSource): void {
  source = next
}

export function unregisterWeAudioSource(): void {
  source = null
}

function sampleFrame(): void {
  rafId = 0
  if (listeners.size > 0) {
    let next: ArrayLike<number> | null = null
    let active = false
    try {
      active = source ? source.isActive() : false
      if (active && source) {
        const external = source.getExternalSpectrum()
        const analyser = source.getAnalyser()
        if (external && external.length > 0) {
          next = external
        } else if (analyser) {
          if (!sampleBuffer || sampleBuffer.length !== analyser.frequencyBinCount) {
            sampleBuffer = new Uint8Array(analyser.frequencyBinCount)
          }
          analyser.getByteFrequencyData(sampleBuffer)
          next = sampleBuffer
        }
      }
    } catch {
      next = null
    }

    if (next && next.length > 0) {
      // 源 bins（64 或 analyser.frequencyBinCount）对数重采样到 64 输出 bins。
      // 线性取 bin 会让低频挤在一起、高频全是 0；WE 的 g_Audio 也是对数感知分布。
      const srcBins = next.length
      for (let bin = 0; bin < SPECTRUM_BINS; bin += 1) {
        const start = Math.floor(Math.pow(bin / SPECTRUM_BINS, 1.6) * srcBins * 0.82)
        const end = Math.max(start + 1, Math.floor(Math.pow((bin + 1) / SPECTRUM_BINS, 1.6) * srcBins * 0.82))
        let energy = 0
        for (let index = start; index < end && index < srcBins; index += 1) {
          const v = next[index] ?? 0
          energy += v * v
        }
        const rms = Math.sqrt(energy / Math.max(1, end - start))
        // 高频段按频段位置补增益（与 App 桌面频谱同一观感基准），钳到 0..1
        const gain = 0.9 + (bin / SPECTRUM_BINS) * 0.55
        const level = Math.min(1, Math.pow(rms / 255, 0.85) * gain)
        // 轻微平滑：攻击快、释放慢，避免频谱闪烁
        const previous = publishedSpectrum[bin]
        publishedSpectrum[bin] += (level - previous) * (level > previous ? 0.55 : 0.22)
      }
    } else {
      // 静音/暂停：衰减到 0 而不是瞬间清零（视觉更自然）
      for (let bin = 0; bin < SPECTRUM_BINS; bin += 1) {
        publishedSpectrum[bin] *= 0.9
        if (publishedSpectrum[bin] < 0.004) publishedSpectrum[bin] = 0
      }
    }
    for (const listener of listeners) {
      try {
        listener(publishedSpectrum)
      } catch { /* 单个订阅者异常不影响其他 */ }
    }
  }

  if (listeners.size > 0) {
    rafId = requestAnimationFrame(sampleFrame)
  }
}

/** 订阅每帧频谱；返回退订函数。首个订阅者出现时启动 rAF 循环。 */
export function subscribeWeSpectrum(listener: Listener): () => void {
  listeners.add(listener)
  if (!rafId && listeners.size === 1) {
    rafId = requestAnimationFrame(sampleFrame)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && rafId) {
      cancelAnimationFrame(rafId)
      rafId = 0
    }
  }
}
