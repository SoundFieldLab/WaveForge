import { useEffect, useRef, useSyncExternalStore } from 'react'
import {
  buildLogBandEdges,
  applyAttackDecay,
  spectrumDbMap,
  SPECTRUM_MIN_FREQ,
  SPECTRUM_MAX_FREQ,
} from '../utils/spectrum'

/** 对数频谱段数（45Hz~12kHz 按对数均分），供频谱可视化按频段取能。 */
export const ANALYZER_SPECTRUM_BANDS = 24

/** 单声道（左/右）频段能量：供 DG-LAB 立体声 A/B 映射使用。 */
export interface ChannelBands {
  bass: number
  mid: number
  high: number
  overall: number
}

const EMPTY_CHANNEL: ChannelBands = Object.freeze({ bass: 0, mid: 0, high: 0, overall: 0 })

export interface AudioAnalyzerData {
  bass: number
  mid: number
  high: number
  overall: number
  beat: number
  accent: number
  flux: number
  /** 24 段对数频谱（低→高，对数压缩到 0..1）。分析器未启用时为全零。 */
  spectrum: Float32Array
  /** 左声道频段能量（音效后最终听感信号；无 L/R 分析器时为全零）。 */
  left: ChannelBands
  /** 右声道频段能量。 */
  right: ChannelBands
}

export interface AudioAnalyzerStore {
  getSnapshot: () => AudioAnalyzerData
  subscribe: (listener: () => void) => () => void
  /** 后台消费者租约：持有期间窗口隐藏后仍继续分析；返回释放函数。 */
  retainBackground: () => () => void
  hasBackgroundConsumers: () => boolean
}

const EMPTY_ANALYSIS: AudioAnalyzerData = Object.freeze({
  bass: 0, mid: 0, high: 0, overall: 0, beat: 0, accent: 0, flux: 0,
  spectrum: new Float32Array(ANALYZER_SPECTRUM_BANDS),
  left: EMPTY_CHANNEL,
  right: EMPTY_CHANNEL,
})
const clamp = (value: number) => Math.min(1, Math.max(0, value))
const logCompress = (value: number, amount = 6) => Math.log1p(amount * clamp(value)) / Math.log1p(amount)

// ── 外部播放源（WebView2 播放面）频谱参数 ──
// bridge /spectrum 输出 N 个对数均分 bin（40Hz~16kHz，0-255，WASAPI loopback 采集）
const EXT_BIN_COUNT = 64
const EXT_F_MIN = 40
const EXT_F_MAX = 16000
/** 24 段对数频谱边界（20Hz~12kHz）：外部源按此边界在 64 对数 bin 上取能 */
const EXT_BAND_EDGES = buildLogBandEdges(ANALYZER_SPECTRUM_BANDS, 20, 12000)

/** 外部播放源接口：active 为 true 时分析器走 bridge 频谱管线（本地 analyser 无音频流） */
export interface ExternalAnalyzerSource {
  active: boolean
  getBins: () => Uint8Array | null
}

export function shouldRunAudioAnalyzer(
  visibility: DocumentVisibilityState,
  hasListeners: boolean,
  hasBackgroundConsumers: boolean,
): boolean {
  return hasListeners && (visibility === 'visible' || hasBackgroundConsumers)
}

function createAnalyzerStore(): AudioAnalyzerStore & {
  publish: (value: AudioAnalyzerData) => void
  hasListeners: () => boolean
  setStartCallback: (callback: (() => void) | null) => void
} {
  let snapshot = EMPTY_ANALYSIS
  const listeners = new Set<() => void>()
  // 有新订阅者出现时重启 rAF 循环（由 effect 注入当前的 start 函数）
  let startCallback: (() => void) | null = null
  let backgroundConsumers = 0
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      startCallback?.()
      return () => listeners.delete(listener)
    },
    retainBackground: () => {
      backgroundConsumers += 1
      startCallback?.()
      let released = false
      return () => {
        if (released) return
        released = true
        backgroundConsumers = Math.max(0, backgroundConsumers - 1)
      }
    },
    hasBackgroundConsumers: () => backgroundConsumers > 0,
    publish: value => {
      snapshot = value
      listeners.forEach(listener => listener())
    },
    hasListeners: () => listeners.size > 0,
    setStartCallback: callback => {
      startCallback = callback
    },
  }
}

/**
 * Samples the playback analyser without putting the 30 FPS stream in the parent
 * React state. Only visual components that explicitly subscribe are reconciled.
 */
export function useAudioAnalyzer(
  analyser: AnalyserNode | null,
  enabled = true,
  leftAnalyser?: AnalyserNode | null,
  rightAnalyser?: AnalyserNode | null,
  external?: ExternalAnalyzerSource,
): AudioAnalyzerStore {
  const storeRef = useRef<ReturnType<typeof createAnalyzerStore> | null>(null)
  if (!storeRef.current) storeRef.current = createAnalyzerStore()

  useEffect(() => {
    const store = storeRef.current!

    // ── 外部播放源（WebView2 播放面）管线 ──
    // 音频在 WebView2 进程解密播放，本地 AnalyserNode 无音频流；
    // 由 bridge /spectrum（WASAPI loopback）提供 64 对数 bin，映射到与本地管线同口径的输出
    if (external?.active && external.getBins) {
      const getBins = external.getBins
      const updateInterval = 1000 / 30
      let animationFrame = 0
      let lastUpdateTime = 0
      let disposed = false
      const smoothedSpectrum = new Float32Array(ANALYZER_SPECTRUM_BANDS)
      const previousBins = new Float32Array(EXT_BIN_COUNT)
      let previousOverall = 0
      let beatPulse = 0
      let lastBeatTime = -1000

      const stop = () => {
        if (animationFrame) {
          cancelAnimationFrame(animationFrame)
          animationFrame = 0
        }
      }

      /** 对数 bin（0..1）在 [f0,f1] 频段上的能量：均值+RMS+峰值混合（与本地管线同口径） */
      const bandEnergy = (bins: Float32Array, f0: number, f1: number) => {
        const n = bins.length
        const span = Math.log(EXT_F_MAX / EXT_F_MIN)
        const lo = Math.max(0, Math.floor(n * Math.log(Math.max(f0, EXT_F_MIN) / EXT_F_MIN) / span))
        const hi = Math.min(n, Math.max(lo + 1, Math.ceil(n * Math.log(Math.min(f1, EXT_F_MAX) / EXT_F_MIN) / span)))
        let sum = 0
        let squares = 0
        let peak = 0
        for (let index = lo; index < hi; index += 1) {
          const value = bins[index]
          sum += value
          squares += value * value
          if (value > peak) peak = value
        }
        const count = Math.max(1, hi - lo)
        return (sum / count) * 0.42 + Math.sqrt(squares / count) * 0.43 + peak * 0.15
      }

      const analyze = (now: number) => {
        animationFrame = 0
        if (disposed) return
        if (!shouldRunAudioAnalyzer(document.visibilityState, store.hasListeners(), store.hasBackgroundConsumers())) return
        if (now - lastUpdateTime >= updateInterval) {
          lastUpdateTime = now

          // bridge bins（可能非 64 长）→ 固定 64 bin（取峰值重采样，0..1）
          const raw = getBins()
          const bins = new Float32Array(EXT_BIN_COUNT)
          if (raw && raw.length > 0) {
            for (let i = 0; i < EXT_BIN_COUNT; i += 1) {
              const src = Math.floor(i * raw.length / EXT_BIN_COUNT)
              const dst = Math.min(raw.length, Math.max(src + 1, Math.floor((i + 1) * raw.length / EXT_BIN_COUNT)))
              let peak = 0
              for (let k = src; k < dst; k += 1) peak = Math.max(peak, raw[k])
              bins[i] = peak / 255
            }
          }

          let positiveFlux = 0
          for (let index = 0; index < EXT_BIN_COUNT; index += 1) {
            positiveFlux += Math.max(0, bins[index] - previousBins[index])
            previousBins[index] = bins[index]
          }
          const rawFlux = positiveFlux / EXT_BIN_COUNT

          const rawBass = bandEnergy(bins, 45, 190)
          const rawMid = bandEnergy(bins, 190, 2600)
          const rawHigh = bandEnergy(bins, 2600, 12000)
          const rawOverall = rawBass * 0.38 + rawMid * 0.42 + rawHigh * 0.2
          const overallOnset = Math.max(0, rawOverall - previousOverall)
          previousOverall = rawOverall

          const beatDetected = overallOnset > 0.02 && now - lastBeatTime > 115
          if (beatDetected) {
            beatPulse = Math.max(beatPulse, Math.min(1, 0.42 + overallOnset / 0.12))
            lastBeatTime = now
          } else beatPulse *= 0.72

          // 24 段对数频谱（20Hz~12kHz），dB 映射 + attack/decay 平滑（与本地管线一致）
          const spectrum = new Float32Array(ANALYZER_SPECTRUM_BANDS)
          for (let k = 0; k < ANALYZER_SPECTRUM_BANDS; k += 1) {
            spectrum[k] = spectrumDbMap(bandEnergy(bins, EXT_BAND_EDGES[k], EXT_BAND_EDGES[k + 1]))
          }
          const smoothed = applyAttackDecay(smoothedSpectrum, spectrum, 0.12, 0.34)
          smoothedSpectrum.set(smoothed)

          // loopback 为混音单声道：L/R 用同一份能量（DG-LAB 立体声映射退化为同相）
          const mono: ChannelBands = {
            bass: logCompress(rawBass * 1.14),
            mid: logCompress(rawMid * 1.08),
            high: logCompress(rawHigh * 1.12),
            overall: logCompress(rawOverall * 1.1),
          }
          store.publish({
            bass: mono.bass,
            mid: mono.mid,
            high: mono.high,
            overall: mono.overall,
            beat: beatPulse,
            accent: beatPulse * 0.85,
            flux: logCompress(rawFlux * 12, 4),
            spectrum: smoothed,
            left: mono,
            right: mono,
          })
        }
        if (shouldRunAudioAnalyzer(document.visibilityState, store.hasListeners(), store.hasBackgroundConsumers())) {
          animationFrame = requestAnimationFrame(analyze)
        }
      }

      const start = () => {
        if (disposed) return
        if (animationFrame || !shouldRunAudioAnalyzer(document.visibilityState, store.hasListeners(), store.hasBackgroundConsumers())) return
        animationFrame = requestAnimationFrame(analyze)
      }
      const handleVisibilityChange = () => {
        if (!shouldRunAudioAnalyzer(document.visibilityState, store.hasListeners(), store.hasBackgroundConsumers())) stop()
        else start()
      }
      document.addEventListener('visibilitychange', handleVisibilityChange)
      store.setStartCallback(start)
      start()
      return () => {
        disposed = true
        stop()
        document.removeEventListener('visibilitychange', handleVisibilityChange)
        store.setStartCallback(null)
        if (store.getSnapshot() !== EMPTY_ANALYSIS) store.publish(EMPTY_ANALYSIS)
      }
    }

    if (!enabled || !analyser) {
      if (store.getSnapshot() !== EMPTY_ANALYSIS) store.publish(EMPTY_ANALYSIS)
      return
    }

    const data = new Uint8Array(analyser.frequencyBinCount)
    const leftData = leftAnalyser ? new Uint8Array(leftAnalyser.frequencyBinCount) : null
    const rightData = rightAnalyser ? new Uint8Array(rightAnalyser.frequencyBinCount) : null
    const updateInterval = 1000 / 30
    let animationFrame = 0
    let lastUpdateTime = 0
    let disposed = false

    // 取消待执行帧；后续由 start() 依据「有订阅者 + 窗口可见」决定是否续帧
    const stop = () => {
      if (animationFrame) {
        cancelAnimationFrame(animationFrame)
        animationFrame = 0
      }
    }
    let bassBaseline = 0
    let overallBaseline = 0
    let beatPulse = 0
    let accentPulse = 0
    let lastBeatTime = -1000
    let lastAccentTime = -1000
    let analyzedFrames = 0
    let previousBass = 0
    let previousOverall = 0
    let fluxBaseline = 0
    const previousSpectrum = new Float32Array(data.length)
    // 频谱平滑状态：attack/decay 逐频段（上升快、回落慢）
    const smoothedSpectrum = new Float32Array(ANALYZER_SPECTRUM_BANDS)
    // 对数频段边界（20Hz~12kHz），与采样率无关，可预先计算
    const bandEdges = buildLogBandEdges(ANALYZER_SPECTRUM_BANDS, SPECTRUM_MIN_FREQ, SPECTRUM_MAX_FREQ)

    const measureBand = (minimumFrequency: number, maximumFrequency: number) => {
      const nyquist = analyser.context.sampleRate / 2
      const start = Math.max(1, Math.floor(minimumFrequency / nyquist * data.length))
      const end = Math.min(data.length, Math.max(start + 1, Math.ceil(maximumFrequency / nyquist * data.length)))
      let sum = 0
      let squares = 0
      let peak = 0
      for (let index = start; index < end; index += 1) {
        const value = data[index] / 255
        sum += value
        squares += value * value
        peak = Math.max(peak, value)
      }
      const count = Math.max(1, end - start)
      return (sum / count) * 0.42 + Math.sqrt(squares / count) * 0.43 + peak * 0.15
    }

    /** DG-LAB 左右声道频段能量（音效后最终听感信号）。 */
    const measureChannel = (node: AnalyserNode, buf: Uint8Array): ChannelBands => {
      const nyquist = node.context.sampleRate / 2
      const band = (f0: number, f1: number) => {
        const start = Math.max(1, Math.floor(f0 / nyquist * buf.length))
        const end = Math.min(buf.length, Math.max(start + 1, Math.ceil(f1 / nyquist * buf.length)))
        let sum = 0
        let squares = 0
        let peak = 0
        for (let i = start; i < end; i += 1) {
          const v = buf[i] / 255
          sum += v
          squares += v * v
          if (v > peak) peak = v
        }
        const count = Math.max(1, end - start)
        return (sum / count) * 0.42 + Math.sqrt(squares / count) * 0.43 + peak * 0.15
      }
      const bass = band(45, 190)
      const mid = band(190, 2600)
      const high = band(2600, 12000)
      const overall = bass * 0.38 + mid * 0.42 + high * 0.2
      return {
        bass: logCompress(bass * 1.14),
        mid: logCompress(mid * 1.08),
        high: logCompress(high * 1.12),
        overall: logCompress(overall * 1.1),
      }
    }

    const analyze = (now: number) => {
      animationFrame = 0
      if (disposed) return
      // 无消费者或窗口隐藏时进入空闲：不采样、不续帧，避免 Electron
      // backgroundThrottling 关闭后 rAF 在后台仍全速空转。
      if ((document.visibilityState === 'hidden' && !store.hasBackgroundConsumers()) || !store.hasListeners()) return
      if (now - lastUpdateTime >= updateInterval) {
        lastUpdateTime = now
        analyser.getByteFrequencyData(data)

        const rawBass = measureBand(45, 190)
        const rawMid = measureBand(190, 2600)
        const rawHigh = measureBand(2600, 12000)
        const rawOverall = rawBass * 0.38 + rawMid * 0.42 + rawHigh * 0.2
        const nyquist = analyser.context.sampleRate / 2
        // 24 段对数频谱（20Hz~12kHz）：供 3D 频谱河等按频段取能；
        // 每段取均值+峰值混合后做 dB 映射（-72dB 地板 / -12dB 天花板），
        // 再逐频段 attack/decay 平滑——低频下探到 20Hz、动态更细腻、回落更自然
        const spectrum = new Float32Array(ANALYZER_SPECTRUM_BANDS)
        for (let k = 0; k < ANALYZER_SPECTRUM_BANDS; k += 1) {
          const f0 = bandEdges[k]
          const f1 = bandEdges[k + 1]
          const start = Math.max(1, Math.floor(f0 / nyquist * data.length))
          const end = Math.min(data.length, Math.max(start + 1, Math.ceil(f1 / nyquist * data.length)))
          let sum = 0
          let peak = 0
          for (let idx = start; idx < end; idx += 1) {
            const v = data[idx] / 255
            sum += v
            if (v > peak) peak = v
          }
          spectrum[k] = spectrumDbMap((sum / Math.max(1, end - start)) * 0.62 + peak * 0.38)
        }
        const smoothed = applyAttackDecay(smoothedSpectrum, spectrum, 0.12, 0.34)
        smoothedSpectrum.set(smoothed)
        const fluxStart = Math.max(1, Math.floor(45 / nyquist * data.length))
        const fluxEnd = Math.min(data.length, Math.ceil(10000 / nyquist * data.length))
        let positiveFlux = 0
        for (let index = fluxStart; index < fluxEnd; index += 1) {
          const magnitude = data[index] / 255
          positiveFlux += Math.max(0, magnitude - previousSpectrum[index])
          previousSpectrum[index] = magnitude
        }
        const rawFlux = positiveFlux / Math.max(1, fluxEnd - fluxStart)

        if (analyzedFrames === 0) {
          bassBaseline = rawBass
          overallBaseline = rawOverall
        }
        const bassDelta = Math.max(0, rawBass - bassBaseline)
        const overallDelta = Math.max(0, rawOverall - overallBaseline)
        const bassOnset = Math.max(0, rawBass - previousBass)
        const overallOnset = Math.max(0, rawOverall - previousOverall)
        const fluxOnset = Math.max(0, rawFlux - fluxBaseline)
        const beatThreshold = 0.022 + bassBaseline * 0.09
        const accentThreshold = 0.018 + overallBaseline * 0.075
        const beatDetected = analyzedFrames > 5
          && (bassDelta > beatThreshold || bassOnset > 0.035)
          && now - lastBeatTime > 115
        const accentDetected = analyzedFrames > 5
          && (overallDelta > accentThreshold || overallOnset > 0.025 || fluxOnset > 0.008
            || (rawMid - overallBaseline) > accentThreshold * 1.45)
          && now - lastAccentTime > 90

        if (beatDetected) {
          const onsetStrength = Math.max(bassDelta, bassOnset * 1.65)
          beatPulse = Math.max(beatPulse, Math.min(1, 0.42 + onsetStrength / Math.max(0.065, beatThreshold * 1.8)))
          lastBeatTime = now
        } else beatPulse *= 0.72

        if (accentDetected) {
          const onsetStrength = Math.max(overallDelta, overallOnset * 1.7, fluxOnset * 5.5)
          accentPulse = Math.max(accentPulse, Math.min(1, 0.34 + onsetStrength / Math.max(0.055, accentThreshold * 1.9)))
          lastAccentTime = now
        } else accentPulse *= 0.78

        bassBaseline += (rawBass - bassBaseline) * (rawBass > bassBaseline ? 0.035 : 0.012)
        overallBaseline += (rawOverall - overallBaseline) * (rawOverall > overallBaseline ? 0.04 : 0.014)
        fluxBaseline += (rawFlux - fluxBaseline) * (rawFlux > fluxBaseline ? 0.05 : 0.018)
        previousBass = rawBass
        previousOverall = rawOverall
        analyzedFrames += 1

        // DG-LAB 左右声道频段能量（音效后最终听感信号；无 L/R 分析器时保持全零）
        let chLeft: ChannelBands = EMPTY_CHANNEL
        let chRight: ChannelBands = EMPTY_CHANNEL
        if (leftData && rightData && leftAnalyser && rightAnalyser) {
          leftAnalyser.getByteFrequencyData(leftData)
          rightAnalyser.getByteFrequencyData(rightData)
          chLeft = measureChannel(leftAnalyser, leftData)
          chRight = measureChannel(rightAnalyser, rightData)
        }

        store.publish({
          bass: logCompress(rawBass * 1.14),
          mid: logCompress(rawMid * 1.08),
          high: logCompress(rawHigh * 1.12),
          overall: logCompress(rawOverall * 1.1),
          beat: beatPulse,
          accent: accentPulse,
          flux: logCompress(fluxOnset * 12, 4),
          spectrum: smoothed,
          left: chLeft,
          right: chRight,
        })
      }
      // 仅在有订阅者且窗口可见时续帧（无消费者 = 无脉冲组件挂载，如桌面模式/首页）
      if (store.hasListeners() && (document.visibilityState === 'visible' || store.hasBackgroundConsumers())) {
        animationFrame = requestAnimationFrame(analyze)
      }
    }

    const start = () => {
      if (disposed) return
      if (animationFrame || (document.visibilityState === 'hidden' && !store.hasBackgroundConsumers()) || !store.hasListeners()) return
      animationFrame = requestAnimationFrame(analyze)
    }

    // 窗口隐藏时停帧；回到可见且有订阅者时恢复（参考桌面频谱/WeatherMap 的门控）
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && !store.hasBackgroundConsumers()) stop()
      else start()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)

    store.setStartCallback(start)
    start()
    return () => {
      disposed = true
      stop()
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      store.setStartCallback(null)
      if (store.getSnapshot() !== EMPTY_ANALYSIS) store.publish(EMPTY_ANALYSIS)
    }
  }, [analyser, enabled, leftAnalyser, rightAnalyser, external?.active])

  return storeRef.current
}

export function useAudioAnalyzerSnapshot(store: AudioAnalyzerStore): AudioAnalyzerData {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
