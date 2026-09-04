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
import type { LyricBackgroundVocal, LyricLine, LyricWord } from '../../services/musicApi'
import type { PlaybackTimeStore } from '../../audio/playbackTimeStore'
import { DEFAULT_DIORAMA_TUNING, type Line, type Word } from './types'
import { resolveDioramaMotionParams } from './cameraPath'
import { useDioramaSequencer } from './useDioramaSequencer'
import CameraRig from './CameraRig'
import DioramaScene from './DioramaScene'
import DioramaPostFx from './dioramaPostFx'
import { DIORAMA_RASTER_FONT_PX, buildDioramaFontSpec, measureDioramaText } from './dioramaTextRaster'
import { EMPTY_AUDIO_PULSE_STORE, type AudioPulseStore } from '../../hooks/useAudioPulse'
import type { AudioAnalyzerStore } from '../../hooks/useAudioAnalyzer'

// 字体栈：拉丁字体在前（西文歌词用 SF/Segoe 的拉丁字形，比中文字体的西文部分精致得多），
// 中文按平台最优顺序回退；canvas 逐字形 fallback，不会影响中文字形选择
const FONT_STACK =
  '"SF Pro Display", "SF Pro Text", "Segoe UI Variable Display", "Segoe UI", "Inter", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "HarmonyOS Sans SC", "Noto Sans CJK SC", "Source Han Sans SC", system-ui, -apple-system, sans-serif'

/** folia 的 Word 时间是歌曲内的绝对秒：行内毫秒 + 行起始时间 */
const convertWord = (word: LyricWord, lineTime: number): Word => ({
  text: word.word || ' ',
  startTime: lineTime + (word.startTime ?? 0) / 1000,
  endTime: lineTime + ((word.startTime ?? 0) + (word.duration ?? 400)) / 1000,
})

const convertBackgroundVocal = (vocal: LyricBackgroundVocal): NonNullable<Line['backgroundVocals']>[number] => ({
  text: vocal.text,
  startTime: vocal.time,
  endTime: vocal.endTime,
  words: (vocal.words || []).map(word => convertWord(word, vocal.time)),
  agentId: vocal.agentId || vocal.agent,
  translation: vocal.translation,
  romanization: vocal.romanization || vocal.roman,
  alternateTexts: vocal.alternateTexts?.map(text => ({
    role: text.role,
    language: text.language || text.lang,
    text: text.text,
  })),
})

/** WaveForge LyricLine[] → folia Line[]（1:1 索引，空行保留但 fullText 为空）。 */
export const convertLyricsToFoliaLines = (lyrics: LyricLine[]): Line[] => {
  const withEnd = lyrics.map((line, index) => {
    const next = lyrics[index + 1]
    const endTime = line.endTime ?? (next ? Math.max(line.time + 0.4, next.time - 0.12) : line.time + 6)
    return { line, endTime }
  })
  // 简化副歌检测：trimmed 文本重复出现 ≥2 次的行判为副歌（副歌天然复现）。
  // 空行/过短（<2 字）不参与，避免误判。真实副歌检测复杂，此处仅做视觉差异化标记。
  const textCount = new Map<string, number>()
  for (const { line } of withEnd) {
    const text = (line.text ?? '').trim()
    if (text.length < 2) continue
    textCount.set(text, (textCount.get(text) ?? 0) + 1)
  }
  return withEnd.map(({ line, endTime }, index) => {
    const text = (line.text ?? '').trim()
    const isChorus = text.length >= 2 && (textCount.get(text) ?? 0) >= 2
    // 修正 word.startTime 倒置：保证点亮顺序按词序（=视觉文字顺序）。
    // 数据源有时前两个词的 startTime 倒置（第一词晚于第二词）→
    // 视觉"先第二个点亮再第一个点亮"。强制本词 startTime ≥ 前一词 endTime
    // 即可保证点亮顺序与词序一致。保留原 duration，时间向后平移而非压缩。
    let prevEnd = line.time
    const words = (line.words ?? [])
      .filter(w => w.word?.trim())
      .map(word => {
        const w = convertWord(word, line.time)
        if (w.startTime < prevEnd) {
          const dur = Math.max(0.05, w.endTime - w.startTime)
          w.startTime = prevEnd
          w.endTime = prevEnd + dur
        }
        prevEnd = w.endTime
        return w
      })
    return {
      words,
      startTime: line.time,
      endTime,
      fullText: text,
      translation: line.translation || undefined,
      romanization: line.roman || undefined,
      agentId: line.agentId || line.agent,
      alternateTexts: line.alternateTexts?.map(text => ({
        role: text.role,
        language: text.language || text.lang,
        text: text.text,
      })),
      backgroundVocals: line.backgroundVocals?.map(convertBackgroundVocal),
      id: `${index}`,
      songPart: isChorus ? 'chorus' : 'verse',
      blockIndex: Math.floor(index / 4),
      isChorus,
    }
  })
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
  /** MV 背景激活时：Canvas alpha 透明 + 3D 内置背景层退场，让下层 MV 视频可见。 */
  mvBackgroundActive?: boolean
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
  mvBackgroundActive = false,
}: FoliaDioramaLyricsProps) {
  const currentTime = useMotionValue(0)
  // sequencer 状态机（切歌铺段 / 歌词晚到原位重建 / 行推进与循环）抽到 hook：5 state + 4 ref + 4 effect
  // + setTimeout 跟踪全在 hook 内，主组件只保留 rAF 时间同步与 WebGL 恢复（与 sequencer 无关）。
  const {
    sequencer,
    globalIndex,
    transitionEpoch,
    outgoingGlobalIndex,
    flightActive,
    linesEpoch,
  } = useDioramaSequencer({ lines, currentIndex, trackKey })
  const effectivePulse = pulseStore ?? EMPTY_AUDIO_PULSE_STORE
  const activeLineWidthRef = useRef(0)

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
      // 未播放或窗口隐藏时停帧（Electron backgroundThrottling 关闭，隐藏后 rAF 仍全速）
      if (playing && document.visibilityState === 'visible') {
        raf = requestAnimationFrame(tick)
      } else {
        raf = 0
      }
    }
    syncClock()
    const unsubscribe = playbackTimeStore.subscribe(syncClock)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && raf === 0 && playing) raf = requestAnimationFrame(tick)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    raf = requestAnimationFrame(tick)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      cancelAnimationFrame(raf)
    }
  }, [currentTime, playbackTimeStore, timeOffset])

  // ── 运动参数（默认 normal 强度） ───────────────────────────────────────────────────────
  const motion = useMemo(() => resolveDioramaMotionParams(DEFAULT_DIORAMA_TUNING, 'normal'), [])

  // ── 活动行世界宽度（供 CameraRig 的 sung-word 横移取景使用真实测量值） ─────────────────
  const activeLine = lines[Math.max(0, Math.min(currentIndex, lines.length - 1))]
  const activeWorldWidth = useMemo(() => {
    if (!activeLine?.fullText) return 0
    const advancePx = Math.max(1, Math.ceil(measureDioramaText(activeLine.fullText, buildDioramaFontSpec(FONT_STACK))))
    return (advancePx / DIORAMA_RASTER_FONT_PX) * 0.62 // 与 DioramaScene 的 LINE_FONT_SIZE 一致
  }, [activeLine])
  activeLineWidthRef.current = activeWorldWidth

  // ── 底部字幕覆盖（翻译 / 罗马音；无下一句提示） ────────────────────────────────────────
  const activeText = activeLine?.fullText || ''
  const activeTranslation = translationEnabled ? activeLine?.translation : undefined
  const activeRoman = romanEnabled ? activeLine?.romanization : undefined

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
    <div className={`relative h-full w-full overflow-hidden ${mvBackgroundActive ? 'bg-transparent' : 'bg-[#05060c]'}`}>
      <div ref={canvasHostRef} className="absolute inset-0">
        <Canvas
          key={canvasRecoveryKey}
          dpr={[1, 2]}
          flat
          camera={{ fov: 55, near: 0.1, far: 140, position: [0, 0.6, 9] }}
          // MV 背景激活时启用 alpha 透明，让下层 MV 视频透过 Canvas 可见；
          // 否则保持默认（不透明）以获得更好的深度清晰度与性能。
          gl={{ powerPreference: 'high-performance', alpha: mvBackgroundActive }}
          className="h-full w-full"
        >
          <DioramaScene
            currentTime={currentTime}
            sequencer={sequencer}
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
            mvBackgroundActive={mvBackgroundActive}
          />
          <CameraRig
            currentTime={currentTime}
            sequencer={sequencer}
            globalIndex={globalIndex}
            activeLineWidthRef={activeLineWidthRef}
            motion={motion}
            transitionEpoch={transitionEpoch}
          />
          {/* HDR UnrealBloom：发光体真实泛光（flat=NoToneMapping 与 OutputPass 配套）；
              强度 0.24 + 门槛 0.92：亮封面背景不会击穿阈值引发闪白，歌词点亮仍可见 */}
          <DioramaPostFx strength={0.24} radius={0.45} threshold={0.92} />
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
      </div>
      <div aria-live="polite" className="sr-only">{activeText}</div>
    </div>
  )
}
