/**
 * Folia 歌词页 —— WaveForge 适配层。
 *
 * 渲染 vendored 的 Project Folia 歌词可视化器（12 种样式：流光/倾诉/商籁等，
 * 见 src/vendor/folia）。把 WaveForge 的 LyricLine[] / PlaybackTimeStore / 音频分析器
 * 桥接为 folia 的 Line[] / MotionValue 时间线 / AudioBands。
 *
 * UI 设计来源：Project Folia（https://github.com/chthollyphile/folia-major，AGPL-3.0）
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useMotionValue } from 'framer-motion'
import type { LyricLine } from '../services/musicApi'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import type { AudioAnalyzerStore } from '../hooks/useAudioAnalyzer'
import { ensureFoliaI18n } from '../vendor/folia/i18n'
import { resolveReadableThemeColor } from '../services/foliaReadableColor'
import VisualizerRenderer from '../vendor/folia/components/visualizer/VisualizerRenderer'
import { hasVisualizerMode, DEFAULT_VISUALIZER_MODE } from '../vendor/folia/components/visualizer/registry'
import { DEFAULT_TEMPERA_TUNING, DEFAULT_SONNET_TUNING, type Line, type Theme, type Word, type VisualizerMode } from '../vendor/folia/types'
import type { VisualizerBackgroundConfig } from '../vendor/folia/components/visualizer/backgrounds/definition'

ensureFoliaI18n()

export function scaleAnalyzerSnapshotForFolia(snapshot: { overall: number; bass: number; mid: number; high: number }) {
  return {
    overall: snapshot.overall * 255,
    bass: snapshot.bass * 255,
    lowMid: (snapshot.bass + snapshot.mid) * 127.5,
    mid: snapshot.mid * 255,
    vocal: (snapshot.mid * 0.4 + snapshot.high * 0.6) * 255,
    treble: snapshot.high * 255,
  }
}

export interface FoliaLyricsPageProps {
  lyrics: LyricLine[]
  currentIndex: number
  playbackTimeStore: PlaybackTimeStore
  timeOffset: number
  isPlaying: boolean
  playerTheme: 'dark' | 'light'
  accentColor: string
  songTitle: string
  songArtist: string
  songAlbum?: string
  coverUrl?: string
  trackId: string | number
  translationEnabled: boolean
  romanEnabled: boolean
  onSeek?: (time: number) => void
  analyzerStore?: AudioAnalyzerStore
  /** folia 样式 id（classic/cadenza/.../sonnet），由 App 层持久化与切换 */
  foliaStyle: string
  /** 是否使用 Folia 自己的背景（latent 封面取色 shader）：关闭后 folia 层透明，露出 WaveForge 封面背景 */
  foliaBackgroundEnabled?: boolean
  /** WaveForge MV 背景激活时置 true：folia 背景层完全透明（transparent），MV 视频露出 */
  mvBackgroundActive?: boolean
}

/** LyricLine[]（行秒 + 逐字毫秒）→ folia Line[]（全秒制），translation/罗马音/对唱 agent 一并映射 */
function convertLyricsToFoliaLines(
  lyrics: LyricLine[],
  trackId: string | number,
  translationEnabled: boolean,
  romanEnabled: boolean,
): Line[] {
  return lyrics.map((line, index) => {
    const words: Word[] = (line.words || []).map(word => ({
      text: word.word,
      startTime: line.time + word.startTime / 1000,
      endTime: line.time + (word.startTime + word.duration) / 1000,
    }))
    const endTime = words.length > 0 ? words[words.length - 1].endTime : line.time + 3
    return {
      words,
      startTime: line.time,
      endTime,
      fullText: line.text,
      translation: translationEnabled ? line.translation : undefined,
      romanization: romanEnabled ? line.roman : undefined,
      id: `${trackId}-${index}`,
      agentId: line.agent,
    }
  })
}

export function FoliaLyricsPage({
  lyrics,
  currentIndex,
  playbackTimeStore,
  timeOffset,
  isPlaying,
  playerTheme,
  accentColor,
  songTitle,
  songArtist,
  songAlbum,
  coverUrl,
  trackId,
  translationEnabled,
  romanEnabled,
  onSeek,
  analyzerStore,
  foliaStyle,
  foliaBackgroundEnabled = true,
  mvBackgroundActive,
}: FoliaLyricsPageProps) {
  const mode: VisualizerMode = hasVisualizerMode(foliaStyle) ? foliaStyle : DEFAULT_VISUALIZER_MODE

  // ── 播放时间 → MotionValue（rAF 外推）──
  // 60fps 门控：claddagh/tilt 等样式订阅 currentTime.on('change') 对整行字符逐个写样式，
  // 120/240Hz 下每秒成千上万次 DOM 写是卡顿主因；歌词动画 60fps 肉眼无差
  const currentTime = useMotionValue(0)
  const timeTickRef = useRef(0)
  useEffect(() => {
    let raf = 0
    let anchorTime = 0
    let anchorWall = performance.now()
    let playing = false
    let lastFrame = 0
    const FRAME_MIN_INTERVAL_MS = 1000 / 60
    const syncClock = () => {
      const snapshot = playbackTimeStore.getSnapshot()
      anchorTime = snapshot.currentTime
      anchorWall = performance.now()
      playing = snapshot.isPlaying
      currentTime.set(anchorTime + timeOffset)
    }
    const tick = (now: number) => {
      if (lastFrame && now - lastFrame < FRAME_MIN_INTERVAL_MS) {
        if (playing && document.visibilityState === 'visible') raf = requestAnimationFrame(tick)
        else raf = 0
        return
      }
      lastFrame = now
      const extrapolated = playing ? Math.min(0.5, (now - anchorWall) / 1000) : 0
      currentTime.set(anchorTime + extrapolated + timeOffset)
      if (playing && document.visibilityState === 'visible') raf = requestAnimationFrame(tick)
      else raf = 0
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
  }, [playbackTimeStore, timeOffset, currentTime])

  // ── 音频分析器 → folia AudioBands（30Hz 快照直接映射为 MotionValue）──
  const audioPower = useMotionValue(0)
  const bassBand = useMotionValue(0)
  const lowMidBand = useMotionValue(0)
  const midBand = useMotionValue(0)
  const vocalBand = useMotionValue(0)
  const trebleBand = useMotionValue(0)
  const spectrumBand = useMotionValue<Uint8Array>(new Uint8Array(0))
  // 双缓冲复用：每次仍交替不同引用以触发 MotionValue 订阅，但不再每个 analyzer tick
  // 分配新 Uint8Array，保持频谱精度/刷新率与所有 Folia 效果不变。
  const spectrumBuffersRef = useRef<[Uint8Array, Uint8Array]>([new Uint8Array(0), new Uint8Array(0)])
  const spectrumBufferIndexRef = useRef(0)
  const audioBands = useMemo(() => ({
    bass: bassBand,
    lowMid: lowMidBand,
    mid: midBand,
    vocal: vocalBand,
    treble: trebleBand,
    spectrum: spectrumBand,
  }), [bassBand, lowMidBand, midBand, vocalBand, trebleBand, spectrumBand])
  useEffect(() => {
    if (!analyzerStore) return
    const update = () => {
      const snapshot = analyzerStore.getSnapshot()
      const scaled = scaleAnalyzerSnapshotForFolia(snapshot)
      audioPower.set(scaled.overall)
      bassBand.set(scaled.bass)
      lowMidBand.set(scaled.lowMid)
      midBand.set(scaled.mid)
      vocalBand.set(scaled.vocal)
      trebleBand.set(scaled.treble)
      const spectrum = snapshot.spectrum
      let buffers = spectrumBuffersRef.current
      if (buffers[0].length !== spectrum.length) {
        buffers = [new Uint8Array(spectrum.length), new Uint8Array(spectrum.length)]
        spectrumBuffersRef.current = buffers
        spectrumBufferIndexRef.current = 0
      }
      const nextIndex = spectrumBufferIndexRef.current ^ 1
      const bins = buffers[nextIndex]
      spectrumBufferIndexRef.current = nextIndex
      for (let i = 0; i < spectrum.length; i++) bins[i] = Math.round(spectrum[i] * 255)
      spectrumBand.set(bins)
    }
    update()
    return analyzerStore.subscribe(update)
  }, [analyzerStore, audioPower, bassBand, lowMidBand, midBand, vocalBand, trebleBand, spectrumBand])

  // ── 歌词行转换 ──
  const lines = useMemo(
    () => convertLyricsToFoliaLines(lyrics, trackId, translationEnabled, romanEnabled),
    [lyrics, trackId, translationEnabled, romanEnabled],
  )

  // ── 主题映射（从封面主题色构建多彩词色 + 让背景跟封面走）──
  const theme: Theme = useMemo(() => {
    const isDark = playerTheme === 'dark'
    // 封面主色往往很深，直接用作 accent/secondary（翻译/字幕/次文字色）会在深色背景上
    // 发黑发灰、可读性差。做可读性校正：深色主题下过暗 → 提亮，浅色主题下过亮 → 压暗，
    // 保留色相。背景的封面取色走独立通道（useCoverColorBg），不受此校正影响。
    const readableAccent = resolveReadableThemeColor(accentColor, isDark)
    // 从校正后的主题色衍生 3 级词色：明亮 → 主题 → 暖灰，folia 各样式用 wordColors 给词缀着色
    const wordColors = [
      { word: 'accent', color: readableAccent },
      { word: 'bright', color: isDark ? '#f5f6fa' : '#1c1d22' },
      { word: 'warm', color: isDark ? '#c9b8a8' : '#5c4a3a' },
    ]
    return {
      name: 'waveforge',
      // 背景色在 useCoverColorBg 开启时被封面取色覆盖（仅作兜底），提亮至深灰避免纯黑阅读感
      backgroundColor: isDark ? '#15171f' : '#f4f4f7',
      primaryColor: isDark ? '#f5f6fa' : '#1c1d22',
      accentColor: readableAccent,
      secondaryColor: readableAccent,
      fontStyle: 'sans' as const,
      animationIntensity: 'normal' as const,
      wordColors,
    }
  }, [playerTheme, accentColor])

  // ── 背景配置：开启封面取色，让 folia 背景（Latent shader）跟封面主题色动态变化，
  // 而不是固定暗色（这是"folia 多彩/我们暗色"的根因）。
  // 透明条件：MV 背景激活（MV 视频露出）或用户关闭「使用 Folia 背景」（露出 WaveForge 封面背景）。
  const background = useMemo<VisualizerBackgroundConfig | undefined>(
    () => (mvBackgroundActive || !foliaBackgroundEnabled ? { transparent: true } : { common: { useCoverColorBg: true } }),
    [mvBackgroundActive, foliaBackgroundEnabled],
  )
  const visualizerTunings = useMemo(() => ({
    tempera: { ...DEFAULT_TEMPERA_TUNING, textureResolution: 1 },
    sonnet: { ...DEFAULT_SONNET_TUNING, textureResolution: 1 },
  }), [])

  const [rendererReady, setRendererReady] = useState(false)
  useEffect(() => {
    // 样式切换时重挂载（folia 各样式自持渲染循环/场景，重挂载最稳）
    setRendererReady(false)
    const timer = window.setTimeout(() => setRendererReady(true), 0)
    return () => window.clearTimeout(timer)
  }, [mode])

  return (
    <div className="absolute inset-0 overflow-hidden">
      {rendererReady && lines.length > 0 && (
        <VisualizerRenderer
          mode={mode}
          currentTime={currentTime}
          currentLineIndex={currentIndex}
          lines={lines}
          theme={theme}
          isDaylight={playerTheme === 'light'}
          audioPower={audioPower}
          audioBands={audioBands}
          showText
          songTitle={songTitle}
          songArtist={songArtist}
          songAlbum={songAlbum ?? null}
          coverUrl={coverUrl ?? null}
          seed={String(trackId)}
          background={background}
          visualizerTunings={visualizerTunings}
          paused={!isPlaying}
          onLyricLineSeek={onSeek}
        />
      )}
    </div>
  )
}

/**
 * 按"对 folia 渲染有实际影响"的属性做浅比较——App 播放中每秒都重渲染（currentTime 等
 * React state），若不做隔离，整个 folia 树（几百个 motion 组件）每秒被级联重渲染，
 * 且 classic 等样式的 variants 对象在组件体内每次新建，重渲染会让已激活的逐词动画
 * 重新解析 → 卡顿。原版 Folia 的 currentTime 是 MotionValue 不触发 React 重渲染，
 * 树只在换行/切歌时重绘；此比较器恢复同样的节奏（换行/切歌/样式/主题变化才重渲染）。
 * songTitle/songArtist/songAlbum/coverUrl 等按值比较（App 内联 join 每次是新字符串，
 * 但内容不变时不值得重渲染）。
 */
function foliaPropsEqual(prev: FoliaLyricsPageProps, next: FoliaLyricsPageProps): boolean {
  return (
    prev.lyrics === next.lyrics &&
    prev.currentIndex === next.currentIndex &&
    prev.playbackTimeStore === next.playbackTimeStore &&
    prev.timeOffset === next.timeOffset &&
    prev.isPlaying === next.isPlaying &&
    prev.playerTheme === next.playerTheme &&
    prev.accentColor === next.accentColor &&
    prev.songTitle === next.songTitle &&
    prev.songArtist === next.songArtist &&
    prev.songAlbum === next.songAlbum &&
    prev.coverUrl === next.coverUrl &&
    prev.trackId === next.trackId &&
    prev.translationEnabled === next.translationEnabled &&
    prev.romanEnabled === next.romanEnabled &&
    prev.onSeek === next.onSeek &&
    prev.analyzerStore === next.analyzerStore &&
    prev.foliaStyle === next.foliaStyle &&
    prev.foliaBackgroundEnabled === next.foliaBackgroundEnabled &&
    prev.mvBackgroundActive === next.mvBackgroundActive
  )
}

export default memo(FoliaLyricsPage, foliaPropsEqual)
