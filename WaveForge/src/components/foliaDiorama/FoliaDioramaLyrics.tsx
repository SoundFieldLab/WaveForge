/**
 * folia Diorama（镜台）歌词模式 —— WaveForge 适配层。
 *
 * 把 WaveForge 的 LyricLine[] / PlaybackTimeStore / currentIndex 桥接为 folia 的
 * Line[] / MotionValue 时间线 / 全局走廊索引，并渲染 R3F Canvas（CameraRig + DioramaScene）。
 * 切歌 / 单曲循环时按 folia 的 sequencer 语义把新走廊段铺到世界另一处，相机一气呵成飞过去。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Canvas } from '@react-three/fiber'
import { useMotionValue } from 'framer-motion'
import type { LyricLine, LyricWord } from '../../services/musicApi'
import type { PlaybackTimeStore } from '../../audio/playbackTimeStore'
import { DEFAULT_DIORAMA_TUNING, type Line, type Word } from './types'
import { resolveDioramaMotionParams } from './cameraPath'
import {
  appendSegment,
  createSequencerState,
  pruneSegments,
  updateActiveSegmentLines,
  type SequencerState,
} from './dioramaSequencer'
import { pickTransitionOffset, TRANSITION_DURATION } from './dioramaTransition'
import CameraRig from './CameraRig'
import DioramaScene from './DioramaScene'
import DioramaPostFx from './dioramaPostFx'
import { buildDioramaFontSpec, measureDioramaText } from './dioramaTextRaster'
import { EMPTY_AUDIO_PULSE_STORE, type AudioPulseStore } from '../../hooks/useAudioPulse'
import type { AudioAnalyzerStore } from '../../hooks/useAudioAnalyzer'

const FONT_STACK =
  '"PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "HarmonyOS Sans SC", system-ui, -apple-system, sans-serif'

/** folia 的 Word 时间是歌曲内的绝对秒：行内毫秒 + 行起始时间 */
const convertWord = (word: LyricWord, lineTime: number): Word => ({
  text: word.word || ' ',
  startTime: lineTime + (word.startTime ?? 0) / 1000,
  endTime: lineTime + ((word.startTime ?? 0) + (word.duration ?? 400)) / 1000,
})

/** WaveForge LyricLine[] → folia Line[]（1:1 索引，空行保留但 fullText 为空）。 */
export const convertLyricsToFoliaLines = (lyrics: LyricLine[]): Line[] => {
  const withEnd = lyrics.map((line, index) => {
    const next = lyrics[index + 1]
    const endTime = next ? Math.max(line.time + 0.4, next.time - 0.12) : line.time + 6
    return { line, endTime }
  })
  return withEnd.map(({ line, endTime }, index) => ({
    words: (line.words ?? []).filter(w => w.word?.trim()).map(word => convertWord(word, line.time)),
    startTime: line.time,
    endTime,
    fullText: line.text?.trim() ?? '',
    translation: line.translation || undefined,
    romanization: line.roman || undefined,
    id: `${index}`,
    songPart: 'verse',
    blockIndex: Math.floor(index / 4),
    isChorus: false,
  }))
}

interface FoliaDioramaLyricsProps {
  /** 已转换的 folia 行（含空行占位，1:1 对齐 currentIndex）。 */
  lines: Line[]
  currentIndex: number
  playbackTimeStore: PlaybackTimeStore
  timeOffset: number
  isPlaying: boolean
  accentColor: string
  /** 歌曲标识：变化时按 folia 语义铺新走廊段并飞过去。 */
  trackKey: string
  translationEnabled?: boolean
  romanEnabled?: boolean
  onSeek?: (time: number) => void
  /** 音律脉冲（星河/光晕/阵型随音乐律动）。 */
  pulseStore?: AudioPulseStore
  /** 音频频段分析（波形河/节拍环）。 */
  analyzerStore?: AudioAnalyzerStore
  /** 歌曲封面：高斯模糊后融入天球背景。 */
  coverUrl?: string
}

export default function FoliaDioramaLyrics({
  lines,
  currentIndex,
  playbackTimeStore,
  timeOffset,
  isPlaying,
  accentColor,
  trackKey,
  translationEnabled = false,
  romanEnabled = false,
  onSeek,
  pulseStore,
  analyzerStore,
  coverUrl,
}: FoliaDioramaLyricsProps) {
  const currentTime = useMotionValue(0)
  const sequencerRef = useRef<SequencerState | null>(null)
  if (!sequencerRef.current) sequencerRef.current = createSequencerState()
  const epochRef = useRef(0)
  const roundRef = useRef(0)
  const lastIndexRef = useRef(-1)
  const lastTrackKeyRef = useRef<string | null>(null)
  const activeLineWidthRef = useRef(0)

  const [globalIndex, setGlobalIndex] = useState(0)
  const [transitionEpoch, setTransitionEpoch] = useState(0)
  const [outgoingGlobalIndex, setOutgoingGlobalIndex] = useState<number | null>(null)
  // 切歌/循环过渡飞行中：星河加速，强化"飞向下一首"的速度感
  const [flightActive, setFlightActive] = useState(false)
  const effectivePulse = pulseStore ?? EMPTY_AUDIO_PULSE_STORE

  const beginFlight = () => {
    setFlightActive(true)
    window.setTimeout(() => setFlightActive(false), (TRANSITION_DURATION + 0.4) * 1000)
  }

  // ── 播放时间 → MotionValue（rAF 外推，保证逐帧平滑） ───────────────────────────────────
  useEffect(() => {
    let raf = 0
    let anchorTime = 0
    let anchorWall = performance.now()
    let playing = false
    const syncClock = () => {
      const snapshot = playbackTimeStore.getSnapshot()
      anchorTime = snapshot.currentTime
      anchorWall = performance.now()
      playing = snapshot.isPlaying
      currentTime.set(anchorTime + timeOffset)
    }
    const tick = (now: number) => {
      const extrapolated = playing ? Math.min(0.5, (now - anchorWall) / 1000) : 0
      currentTime.set(anchorTime + extrapolated + timeOffset)
      raf = requestAnimationFrame(tick)
    }
    syncClock()
    const unsubscribe = playbackTimeStore.subscribe(syncClock)
    raf = requestAnimationFrame(tick)
    return () => {
      unsubscribe()
      cancelAnimationFrame(raf)
    }
  }, [currentTime, playbackTimeStore, timeOffset])

  // ── 切歌：铺新走廊段（首曲在原点，之后铺到远处并飞过去） ──────────────────────────────
  useEffect(() => {
    const sequencer = sequencerRef.current
    if (!sequencer) return
    const isFirst = sequencer.segments.length === 0
    epochRef.current += 1
    const epoch = epochRef.current
    const origin = isFirst ? { x: 0, y: 0, z: 0 } : pickTransitionOffset(trackKey, epoch)
    const segment = appendSegment(sequencer, {
      seed: trackKey,
      lines,
      round: roundRef.current,
      placementOrigin: origin,
    })
    lastTrackKeyRef.current = trackKey
    lastIndexRef.current = currentIndex
    const target = segment.globalStart + Math.max(0, currentIndex)
    if (!isFirst) setOutgoingGlobalIndex(globalIndexRef.current)
    setGlobalIndex(target)
    setTransitionEpoch(epoch)
    if (!isFirst) beginFlight()
    window.setTimeout(() => setOutgoingGlobalIndex(null), (TRANSITION_DURATION + 0.6) * 1000)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackKey])

  // ── 歌词晚到：切歌后新歌歌词异步加载完成时，原位重建当前段（避免显示上一首歌的歌词） ──
  const [linesEpoch, setLinesEpoch] = useState(0)
  useEffect(() => {
    const sequencer = sequencerRef.current
    if (!sequencer || sequencer.segments.length === 0) return
    const active = sequencer.segments[sequencer.segments.length - 1]
    // 仅当当前段仍是同一首歌时才重建（seed 即 trackKey；切歌铺的新段若已含正确歌词则幂等）
    if (active.seed === trackKey) {
      updateActiveSegmentLines(sequencer, lines)
      setLinesEpoch(epoch => epoch + 1)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines])

  // 记录 globalIndex 的即时值供切歌时读取（避免闭包过期）
  const globalIndexRef = useRef(0)
  useEffect(() => {
    globalIndexRef.current = globalIndex
  }, [globalIndex])

  // ── 行推进 / 单曲循环 ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    const sequencer = sequencerRef.current
    if (!sequencer || sequencer.segments.length === 0) return
    const segment = sequencer.segments[sequencer.segments.length - 1]
    const previous = lastIndexRef.current
    lastIndexRef.current = currentIndex

    // 单曲循环 / 跳回开头：铺新一轮走廊段（无缝飞过去）
    if (previous >= 0 && currentIndex < previous - 1) {
      roundRef.current += 1
      epochRef.current += 1
      const epoch = epochRef.current
      const origin = pickTransitionOffset(trackKey, epoch)
      const next = appendSegment(sequencer, {
        seed: trackKey,
        lines,
        round: roundRef.current,
        placementOrigin: origin,
      })
      setOutgoingGlobalIndex(globalIndexRef.current)
      setGlobalIndex(next.globalStart + Math.max(0, currentIndex))
      setTransitionEpoch(epoch)
      beginFlight()
      window.setTimeout(() => setOutgoingGlobalIndex(null), (TRANSITION_DURATION + 0.6) * 1000)
      return
    }

    setGlobalIndex(segment.globalStart + Math.max(0, Math.min(currentIndex, lines.length - 1)))
    pruneSegments(sequencer, globalIndexRef.current - 10)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex])

  // ── 运动参数（默认 normal 强度） ───────────────────────────────────────────────────────
  const motion = useMemo(() => resolveDioramaMotionParams(DEFAULT_DIORAMA_TUNING, 'normal'), [])

  // ── 活动行世界宽度（供 CameraRig 的 sung-word 横移取景使用真实测量值） ─────────────────
  const activeLine = lines[Math.max(0, Math.min(currentIndex, lines.length - 1))]
  const activeWorldWidth = useMemo(() => {
    if (!activeLine?.fullText) return 0
    const advancePx = Math.max(1, Math.ceil(measureDioramaText(activeLine.fullText, buildDioramaFontSpec(FONT_STACK, 700))))
    return (advancePx / 128) * 0.62 // 与 DioramaScene 的 LINE_FONT_SIZE 一致
  }, [activeLine])
  activeLineWidthRef.current = activeWorldWidth

  // ── 底部字幕覆盖（翻译 / 罗马音 / 下一行提示） ────────────────────────────────────────
  const activeText = activeLine?.fullText || ''
  const activeTranslation = translationEnabled ? activeLine?.translation : undefined
  const activeRoman = romanEnabled ? activeLine?.romanization : undefined
  const nextLine = lines[currentIndex + 1]

  // ── WebGL 后台恢复兜底 ────────────────────────────────────────────────────────────────
  // 窗口后台一段时间后，Chromium 可能释放/丢失 GPU 上下文或停滞 rAF，切回前台 3D 画布会空白。
  // 用 key 重建整个 Canvas（纹理/缓冲全量重建），保证歌词必然恢复显示。
  const canvasHostRef = useRef<HTMLDivElement>(null)
  const [canvasRecoveryKey, setCanvasRecoveryKey] = useState(0)

  useEffect(() => {
    const host = canvasHostRef.current
    if (!host) return
    let lastHiddenAt = 0

    // 监听 canvas 上的上下文丢失/恢复（事件不冒泡，必须挂在 canvas 元素上）
    const attachCanvasListeners = () => {
      const canvas = host.querySelector('canvas')
      if (!canvas) return undefined
      const onContextLost = (event: Event) => {
        event.preventDefault() // 允许浏览器尝试恢复
      }
      const onContextRestored = () => {
        // 上下文恢复后强制重建，清除丢失期间失效的纹理/缓冲
        setCanvasRecoveryKey(k => k + 1)
      }
      canvas.addEventListener('webglcontextlost', onContextLost)
      canvas.addEventListener('webglcontextrestored', onContextRestored)
      return () => {
        canvas.removeEventListener('webglcontextlost', onContextLost)
        canvas.removeEventListener('webglcontextrestored', onContextRestored)
      }
    }
    const detach = attachCanvasListeners()

    const onVisibility = () => {
      if (document.hidden) {
        lastHiddenAt = performance.now()
      } else if (lastHiddenAt > 0 && performance.now() - lastHiddenAt > 1500) {
        // 后台超过 1.5s 切回：重建画布，规避上下文丢失/渲染停滞导致的空白
        lastHiddenAt = 0
        setCanvasRecoveryKey(k => k + 1)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('focus', onVisibility)
    return () => {
      detach?.()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('focus', onVisibility)
    }
  }, [canvasRecoveryKey])

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#05060c]">
      <div ref={canvasHostRef} className="absolute inset-0">
        <Canvas
          key={canvasRecoveryKey}
          dpr={[1, 2]}
          flat
          camera={{ fov: 55, near: 0.1, far: 140, position: [0, 0.6, 9] }}
          gl={{ powerPreference: 'high-performance' }}
          className="h-full w-full"
        >
          <DioramaScene
            currentTime={currentTime}
            sequencer={sequencerRef.current}
            globalIndex={globalIndex}
            motion={motion}
            fontStack={FONT_STACK}
            accentColor={accentColor}
            outgoingGlobalIndex={outgoingGlobalIndex}
            onSeek={onSeek}
            pulseStore={effectivePulse}
            flightActive={flightActive}
            analyzerStore={analyzerStore}
            linesEpoch={linesEpoch}
            coverUrl={coverUrl}
          />
          <CameraRig
            currentTime={currentTime}
            sequencer={sequencerRef.current}
            globalIndex={globalIndex}
            activeLineWidthRef={activeLineWidthRef}
            motion={motion}
            transitionEpoch={transitionEpoch}
          />
          {/* HDR UnrealBloom：发光体真实泛光（flat=NoToneMapping 与 OutputPass 配套）；
              强度 0.28 + 门槛 0.85：柔和的氛围辉光，歌词点亮可见但不刺眼 */}
          <DioramaPostFx strength={0.28} radius={0.45} threshold={0.85} />
        </Canvas>
      </div>

      {/* 底部字幕：当前行翻译/罗马音 + 下一行提示（毛玻璃药丸） */}
      <div className="pointer-events-none absolute inset-x-0 bottom-7 z-10 flex flex-col items-center gap-1.5 px-8 text-center">
        {activeRoman && (
          <span className="max-w-[72vw] truncate rounded-full bg-black/25 px-4 py-1 text-[12px] font-medium tracking-[0.14em] text-white/50 backdrop-blur-md">
            {activeRoman}
          </span>
        )}
        {activeTranslation && (
          <span className="max-w-[72vw] truncate rounded-full bg-black/30 px-5 py-1.5 text-[15px] font-medium text-white/85 backdrop-blur-md">
            {activeTranslation}
          </span>
        )}
        {nextLine?.fullText && (
          <span className="mt-0.5 max-w-[58vw] truncate text-[11px] font-semibold tracking-[0.08em] text-white/35">
            下一句 · {nextLine.fullText}
          </span>
        )}
      </div>
      <div aria-live="polite" className="sr-only">{activeText}</div>
    </div>
  )
}
