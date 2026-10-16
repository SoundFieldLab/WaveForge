/**
 * DG-LAB 实时波形：A=左声道、B=右声道。
 * - 包络（默认）：音量包络波形，自右向左滚动（安静段落平、主歌中等、副歌/鼓点高）；
 * - 频谱：左右声道实时频谱柱状（对数频段分布），直观看到低频鼓点/高频细节。
 * 右侧数字为各通道当前强度。
 *
 * 性能：绘制按目标帧率节流（包络 30fps / 频谱 24fps）。原来每个 vsync 都重绘，
 * 在 120/144Hz 屏上就是每秒 120-144 次全画布重绘 + 两条发光曲线，是控制台里最重的一块；
 * 被跳过的帧仍然采样（代价极低）并取区间峰值，鼓点不会因为降频而漏掉。
 */

import { useEffect, useRef } from 'react'
import type { DGLabStatus } from '../plugins/clients/DGLabClient'
import { getGlobalAudioAnalysers } from '../plugins/clients/DGLabClient'

const GOLD = '#FFE89C'
const CYAN = '#22d3ee'
const BG = '#0b0b0e'

/** 重绘目标帧率：包络比频谱需要更连贯的滚动，给得高一点。 */
const TARGET_FPS = { envelope: 30, spectrum: 24 } as const

export interface DGLabVizMode {
  /** 包络：时域音量包络滚动（现有手感）。 */
  envelope: 'envelope'
  /** 频谱：左右声道频域柱状。 */
  spectrum: 'spectrum'
}
export type DGLabVizModeId = DGLabVizMode[keyof DGLabVizMode]

interface DGLabVizCanvasProps {
  status: DGLabStatus
  height?: number
  mode?: DGLabVizModeId
}

export default function DGLabVizCanvas({ status, height = 190, mode = 'envelope' }: DGLabVizCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const envARef = useRef<number[]>([])
  const envBRef = useRef<number[]>([])
  const timeBufRef = useRef<Uint8Array | null>(null)
  const freqBufRef = useRef<Uint8Array | null>(null)
  const freqAEnvRef = useRef<number[]>([])
  const freqBEnvRef = useRef<number[]>([])
  const statusRef = useRef(status)
  statusRef.current = status

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const frameMs = 1000 / TARGET_FPS[mode]
    let raf = 0
    /** 下一次允许重绘的时间点：用累加而非「上次重绘 + 间隔」，否则实际帧率会被 vsync 周期量化拖慢。 */
    let nextPaint = 0
    /** 被节流跳过的帧里累计的通道峰值（包络模式），重绘后清零。 */
    let peakA = 0
    let peakB = 0
    /** 频谱栏连续「无输入」的重绘次数：超过阈值才提示，避免安静段落误报。 */
    let silentPaints = 0
    /** 频谱柱渐变按「声道+高度」缓存：48 柱 × 2 声道每帧新建 96 个渐变太浪费。 */
    const gradCache = new Map<string, CanvasGradient>()

    const ensureBufs = (analyser: AnalyserNode | null) => {
      if (!analyser) return
      if (!timeBufRef.current) timeBufRef.current = new Uint8Array(analyser.frequencyBinCount)
      if (!freqBufRef.current) freqBufRef.current = new Uint8Array(analyser.frequencyBinCount)
    }

    /** 取一次时域峰值（绝对幅度）；无分析器时返回 0，由调用方回退到强度值。 */
    const samplePeak = (analyser: AnalyserNode | null): number => {
      if (!analyser || !timeBufRef.current) return 0
      analyser.getByteTimeDomainData(timeBufRef.current)
      let peak = 0
      const buf = timeBufRef.current
      for (let i = 0; i < buf.length; i += 1) {
        const v = Math.abs(buf[i] - 128) / 128
        if (v > peak) peak = v
      }
      return peak
    }

    const loop = (ts: number) => {
      raf = requestAnimationFrame(loop)
      // 窗口隐藏时只保留 rAF 链、不重绘（主窗口 backgroundThrottling=false，后台不会自动停帧）
      // 窗口隐藏时只保留 rAF 链、不重绘（主窗口 backgroundThrottling=false，后台不会自动停帧）
      if (document.hidden) {
        nextPaint = 0
        return
      }
      const now = typeof ts === 'number' && ts > 0 ? ts : performance.now()

      if (now < nextPaint) {
        // 未到重绘时间：包络仍逐帧采样并累计峰值，避免漏掉短促鼓点
        if (mode !== 'spectrum') {
          const { left, right } = getGlobalAudioAnalysers()
          ensureBufs(left)
          peakA = Math.max(peakA, samplePeak(left))
          peakB = Math.max(peakB, samplePeak(right))
        }
        return
      }
      nextPaint = Math.max(now, nextPaint) + frameMs

      const cw = canvas.clientWidth || 320
      const ch = canvas.clientHeight || height
      // 每帧重读 dpr：窗口在不同缩放的显示器间移动时它会变，缓存旧值会让
      // 后备存储分辨率与新屏不匹配（波形发糊）
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const targetW = Math.round(cw * dpr)
      const targetH = Math.round(ch * dpr)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        gradCache.clear() // 画布尺寸变了，渐变坐标失效
      }
      ctx.fillStyle = BG
      ctx.fillRect(0, 0, cw, ch)

      const { left, right } = getGlobalAudioAnalysers()
      ensureBufs(left)
      const out = statusRef.current.out
      const laneH = ch / 2
      const padX = 40
      const waveW = cw - padX - 8

      if (mode === 'spectrum') {
        // 左右声道频域柱状：对数取 48 柱，逐柱 attack/decay 平滑（快起慢落）
        const BINS = 48
        /** 长时间无输入（暂停/静音/未播放）时给一句说明，避免看起来像坏了。 */
        const drawSpectrumLane = (label: 'A' | 'B', analyser: AnalyserNode | null, env: number[], getInt: () => number, color: string): number => {
          const y0 = label === 'A' ? 0 : laneH
          const baseline = y0 + laneH
          // 零线：无信号时也能看出这一栏是「空闲的频谱」，而不是没画
          ctx.fillStyle = 'rgba(255,255,255,0.08)'
          ctx.fillRect(padX, baseline - 1, waveW, 1)
          ctx.fillStyle = color
          ctx.font = 'bold 11px system-ui, sans-serif'
          ctx.textAlign = 'left'
          ctx.fillText(label === 'A' ? 'A·左' : 'B·右', 4, y0 + 14)
          ctx.fillStyle = 'rgba(255,255,255,0.85)'
          ctx.font = 'bold 12px system-ui, sans-serif'
          ctx.fillText(String(Math.round(getInt())), 4, y0 + 30)
          if (!analyser || !freqBufRef.current) return -1
          analyser.getByteFrequencyData(freqBufRef.current)
          const buf = freqBufRef.current
          const nyq = analyser.context.sampleRate / 2
          const barW = waveW / BINS
          const gap = Math.max(1, barW * 0.25)
          const maxIdx = buf.length - 1
          let laneMax = 0
          for (let b = 0; b < BINS; b += 1) {
            // 20Hz..12kHz 对数分柱
            const f0 = Math.round(20 * Math.pow(12000 / 20, b / BINS))
            const f1 = Math.round(20 * Math.pow(12000 / 20, (b + 1) / BINS))
            const i0 = Math.max(1, Math.floor((f0 / nyq) * buf.length))
            const i1 = Math.min(maxIdx, Math.max(i0 + 1, Math.ceil((f1 / nyq) * buf.length)))
            let sum = 0
            for (let i = i0; i < i1; i += 1) sum += buf[i]
            const raw = Math.min(1, (sum / Math.max(1, i1 - i0)) / 255)
            if (raw > laneMax) laneMax = raw
            const target = Math.pow(Math.max(0.02, raw), 0.9)
            const cur = env[b] ?? target
            env[b] = target >= cur ? cur + (target - cur) * 0.65 : cur + (target - cur) * 0.2
            const h = env[b] * (laneH * 0.92)
            const x = padX + b * barW + gap / 2
            const key = `${label}:${Math.round(h)}`
            let grad = gradCache.get(key)
            if (!grad) {
              grad = ctx.createLinearGradient(0, y0 + laneH - h, 0, y0 + laneH)
              grad.addColorStop(0, `${color}DD`)
              grad.addColorStop(1, `${color}22`)
              gradCache.set(key, grad)
            }
            ctx.fillStyle = grad
            ctx.globalAlpha = 0.9
            ctx.fillRect(x, y0 + laneH - h, barW - gap, h)
            ctx.globalAlpha = 1
          }
          return laneMax
        }
        const maxA = drawSpectrumLane('A', left, freqAEnvRef.current, () => out?.A ?? 0, GOLD)
        const maxB = drawSpectrumLane('B', right, freqBEnvRef.current, () => out?.B ?? 0, CYAN)
        if (maxA < 0 || maxB < 0) {
          silentPaints = 0
          ctx.fillStyle = 'rgba(255,255,255,0.4)'
          ctx.font = '12px system-ui, sans-serif'
          ctx.textAlign = 'center'
          ctx.fillText('等待音频图建立（开始播放后显示）', cw / 2, laneH + 4)
        } else if (Math.max(maxA, maxB) < 0.012) {
          silentPaints += 1
          if (silentPaints > 60) {
            ctx.fillStyle = 'rgba(255,255,255,0.4)'
            ctx.font = '12px system-ui, sans-serif'
            ctx.textAlign = 'center'
            ctx.fillText('当前没有音频输入（暂停 / 静音 / 未接入音频）', cw / 2, laneH + 4)
          }
        } else {
          silentPaints = 0
        }
      } else {
        // 包络：每次重绘取一次通道峰值（绝对幅度），右进左出滚动
        const drawLane = (label: 'A' | 'B', analyser: AnalyserNode | null, env: number[], peak: number, getInt: () => number, color: string) => {
          const y0 = label === 'A' ? 0 : laneH
          const baseline = y0 + laneH * 0.62
          const value = clamp01(peak || (getInt() / 200))
          const cols = Math.max(1, Math.floor(waveW / 2))
          if (env.length === 0) {
            // 首次绘制（刚打开控制台/刚切模式）：用当前值铺满，
            // 否则慢刷新下只画出一小段，看起来像「没有波形」
            for (let i = 0; i < cols; i += 1) env.push(value)
          } else {
            env.push(value)
          }
          while (env.length > cols) env.shift()

          const step = waveW / Math.max(1, cols - 1)
          ctx.beginPath()
          env.forEach((v, i) => {
            const x = padX + i * step
            const y = baseline - clamp01(v) * (laneH * 0.9)
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          })
          ctx.lineTo(padX + (env.length - 1) * step, baseline)
          ctx.lineTo(padX, baseline)
          ctx.closePath()
          const grad = ctx.createLinearGradient(0, baseline - laneH * 0.9, 0, baseline)
          grad.addColorStop(0, `${color}66`)
          grad.addColorStop(1, `${color}05`)
          ctx.fillStyle = grad
          ctx.fill()
          ctx.beginPath()
          env.forEach((v, i) => {
            const x = padX + i * step
            const y = baseline - clamp01(v) * (laneH * 0.9)
            if (i === 0) ctx.moveTo(x, y)
            else ctx.lineTo(x, y)
          })
          ctx.strokeStyle = color
          ctx.lineWidth = 1.6
          ctx.shadowColor = color
          ctx.shadowBlur = 5
          ctx.stroke()
          ctx.shadowBlur = 0

          ctx.fillStyle = color
          ctx.font = 'bold 11px system-ui, sans-serif'
          ctx.textAlign = 'left'
          ctx.fillText(label === 'A' ? 'A·左' : 'B·右', 4, y0 + 14)
          ctx.fillStyle = 'rgba(255,255,255,0.85)'
          ctx.font = 'bold 12px system-ui, sans-serif'
          ctx.fillText(String(Math.round(getInt())), 4, y0 + 30)
        }

        drawLane('A', left, envARef.current, peakA, () => out?.A ?? 0, GOLD)
        drawLane('B', right, envBRef.current, peakB, () => out?.B ?? 0, CYAN)
        peakA = 0
        peakB = 0
      }
    }
    raf = requestAnimationFrame(loop)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      envARef.current = []
      envBRef.current = []
      freqAEnvRef.current = []
      freqBEnvRef.current = []
      gradCache.clear()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height, mode])

  return (
    <canvas
      ref={canvasRef}
      className="w-full rounded-xl border border-white/10"
      style={{ background: BG, display: 'block', height }}
    />
  )
}

function clamp01(v: number) {
  return Math.min(1, Math.max(0, v))
}
