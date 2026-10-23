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
import type { LyricAlternateText, LyricBackgroundVocal, LyricLine, LyricWord } from '../services/musicApi'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import type { AudioAnalyzerStore } from '../hooks/useAudioAnalyzer'
import { ensureFoliaI18n } from '../vendor/folia/i18n'
import { buildFoliaTheme } from './foliaTunings'
import VisualizerRenderer from '../vendor/folia/components/visualizer/VisualizerRenderer'
import { hasVisualizerMode, DEFAULT_VISUALIZER_MODE } from '../vendor/folia/components/visualizer/registry'
import { SMART_BEAT_SETTINGS_EVENT, readSmartBeatSettings } from '../vendor/folia/components/visualizer/smartBeatSettings'
import { SMART_BEAT_EFFECT_IDS } from '../vendor/folia/components/visualizer/sonnet/smartBeat'
import { DEFAULT_TEMPERA_TUNING, DEFAULT_SONNET_TUNING, type Line, type LyricAlternateText as FoliaAlternateText, type LyricBackgroundVocal as FoliaBackgroundVocal, type Theme, type Word, type VisualizerMode } from '../vendor/folia/types'
import type { VisualizerBackgroundConfig } from '../vendor/folia/components/visualizer/backgrounds/definition'
import type { VisualizerTuningBundle } from '../vendor/folia/components/visualizer/tuningRegistry'
import { usePerfMode } from '../tv/perfMode'
import { buildWordSegments, resolveLumiereRenderQuality, resolveLumiereTuning } from './foliaLumiereSupport'

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
  /** 用户在参数面板里保存的 per-mode 调参（键为 folia 模式 id）；未设置的项用默认值 */
  userTunings?: VisualizerTuningBundle
  /** 模式退出动画期间为 false：保留静态视觉帧，但停止时钟与频谱订阅。 */
  active?: boolean
}

/** LyricLine[]（行秒 + 逐字毫秒）→ folia Line[]（全秒制），完整保留字幕、对唱和背景和声。 */
const convertWords = (words: LyricWord[] | undefined, lineTime: number): Word[] => (words || []).map(word => ({
  text: word.word,
  startTime: lineTime + word.startTime / 1000,
  endTime: lineTime + (word.startTime + word.duration) / 1000,
}))

const convertAlternateTexts = (
  alternateTexts: LyricAlternateText[] | undefined,
  translationEnabled: boolean,
  romanEnabled: boolean,
): FoliaAlternateText[] | undefined => {
  const filtered = alternateTexts?.filter(text => {
    const role = text.role || text.type
    return (role !== 'translation' || translationEnabled) && (role !== 'romanization' || romanEnabled)
  }).map(text => ({
    role: text.role || text.type || 'alternate',
    language: text.language || text.lang,
    text: text.text,
  }))
  return filtered?.length ? filtered : undefined
}

const convertBackgroundVocal = (
  vocal: LyricBackgroundVocal,
  translationEnabled: boolean,
  romanEnabled: boolean,
): FoliaBackgroundVocal => {
  const words = convertWords(vocal.words, vocal.time)
  return {
    text: vocal.text,
    startTime: vocal.time,
    endTime: vocal.endTime ?? words.at(-1)?.endTime ?? vocal.time + 3,
    words,
    agentId: vocal.agentId || vocal.agent,
    translation: translationEnabled ? vocal.translation : undefined,
    romanization: romanEnabled ? (vocal.romanization || vocal.roman) : undefined,
    alternateTexts: convertAlternateTexts(vocal.alternateTexts, translationEnabled, romanEnabled),
  }
}

export function convertLyricsToFoliaLines(
  lyrics: LyricLine[],
  trackId: string | number,
  translationEnabled: boolean,
  romanEnabled: boolean,
): Line[] {
  return lyrics.map((line, index) => {
    const words = convertWords(line.words, line.time)
    const endTime = line.endTime ?? words.at(-1)?.endTime ?? lyrics[index + 1]?.time ?? line.time + 3
    const backgroundVocals = line.backgroundVocals?.map(vocal => (
      convertBackgroundVocal(vocal, translationEnabled, romanEnabled)
    ))
    return {
      words,
      startTime: line.time,
      endTime,
      fullText: line.text,
      translation: translationEnabled ? line.translation : undefined,
      romanization: romanEnabled ? line.roman : undefined,
      alternateTexts: convertAlternateTexts(line.alternateTexts, translationEnabled, romanEnabled),
      id: `${trackId}-${index}`,
      agentId: line.agentId || line.agent,
      backgroundVocals: backgroundVocals?.length ? backgroundVocals : undefined,
      // 绘光按词排版（虚词缩小 / 最长实词放大）优先用提供方的逐字时间轴切词，
      // 而不是让 Intl.Segmenter 现场猜（尤其中文容易切错）。仅在能精确重建整行时才给。
      wordSegments: buildWordSegments(line.text, line.words),
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
  userTunings,
  active = true,
}: FoliaLyricsPageProps) {
  const mode: VisualizerMode = hasVisualizerMode(foliaStyle) ? foliaStyle : DEFAULT_VISUALIZER_MODE
  const perfMode = usePerfMode()

  // ── 智能动感模式（Smart Beat）：设置读取 + 拍脉冲采样 ──
  // 设置存 localStorage（visualizer_smart_beat），面板/命令面板改动经事件通知到这里；
  // 拍脉冲来自 analyzerStore 快照的 beat/accent（onset 检测），renderFrame 每帧经
  // smartBeatSample 读取——不走 MotionValue（拍事件是离散的，值通道会丢拍）。
  const [smartBeatSettings, setSmartBeatSettings] = useState(() => readSmartBeatSettings({
    enabled: true,
    effects: {
      [SMART_BEAT_EFFECT_IDS.beatZoom]: { on: true, strength: 1 },
      [SMART_BEAT_EFFECT_IDS.downbeatZoom]: { on: true, strength: 1 },
      [SMART_BEAT_EFFECT_IDS.beatRotation]: { on: true, strength: 1 },
      [SMART_BEAT_EFFECT_IDS.tear]: { on: true, strength: 1 },
      [SMART_BEAT_EFFECT_IDS.flare]: { on: true, strength: 1 },
      [SMART_BEAT_EFFECT_IDS.iconPop]: { on: true, strength: 1 },
    },
  }))
  useEffect(() => {
    const reload = () => setSmartBeatSettings(readSmartBeatSettings({
      enabled: true,
      effects: {
        [SMART_BEAT_EFFECT_IDS.beatZoom]: { on: true, strength: 1 },
        [SMART_BEAT_EFFECT_IDS.downbeatZoom]: { on: true, strength: 1 },
        [SMART_BEAT_EFFECT_IDS.beatRotation]: { on: true, strength: 1 },
        [SMART_BEAT_EFFECT_IDS.tear]: { on: true, strength: 1 },
        [SMART_BEAT_EFFECT_IDS.flare]: { on: true, strength: 1 },
        [SMART_BEAT_EFFECT_IDS.iconPop]: { on: true, strength: 1 },
      },
    }))
    window.addEventListener(SMART_BEAT_SETTINGS_EVENT, reload)
    return () => window.removeEventListener(SMART_BEAT_SETTINGS_EVENT, reload)
  }, [])
  const smartBeatSample = useMemo(() => {
    if (!analyzerStore) return undefined
    return () => {
      const snapshot = analyzerStore.getSnapshot()
      return { beat: snapshot.beat, accent: snapshot.accent, bass: snapshot.bass }
    }
  }, [analyzerStore])
  const smartBeatToggles = useMemo(() => smartBeatSettings.effects, [smartBeatSettings])

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
      // 暂停时 tick 会把 raf 归零；恢复播放时若时钟未在跑，需确定性重启
      if (playing && active && document.visibilityState === 'visible' && raf === 0) {
        raf = requestAnimationFrame(tick)
      }
    }
    const tick = (now: number) => {
      if (lastFrame && now - lastFrame < FRAME_MIN_INTERVAL_MS) {
        if (playing && active && document.visibilityState === 'visible') raf = requestAnimationFrame(tick)
        else raf = 0
        return
      }
      lastFrame = now
      const extrapolated = playing ? Math.min(0.5, (now - anchorWall) / 1000) : 0
      currentTime.set(anchorTime + extrapolated + timeOffset)
      if (playing && active && document.visibilityState === 'visible') raf = requestAnimationFrame(tick)
      else raf = 0
    }
    syncClock()
    const unsubscribe = playbackTimeStore.subscribe(syncClock)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && raf === 0 && playing && active) raf = requestAnimationFrame(tick)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    raf = requestAnimationFrame(tick)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      cancelAnimationFrame(raf)
    }
  }, [playbackTimeStore, timeOffset, currentTime, active])

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
    if (!analyzerStore || !active) return
    // 频谱快照是视觉调用的源头之一：分析器按音频帧率高频推送，
    // 若逐一 set() 会把 7 个 MotionValue 以 60-120Hz 扇出给所有可视化器的
    // change 订阅（逐字符 DOM 写 + 布局）。限 30Hz 推送在视觉上无感知差异，
    // 却能把这条风暴直接减半以上；播放暂停时整体停推，避免静默空转。
    let lastPushWall = 0
    const update = () => {
      const now = performance.now()
      const snapshot = analyzerStore.getSnapshot()
      if (now - lastPushWall < 1000 / 30) return
      lastPushWall = now
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
  }, [analyzerStore, active, audioPower, bassBand, lowMidBand, midBand, vocalBand, trebleBand, spectrumBand])

  // ── 歌词行转换 ──
  const lines = useMemo(
    () => convertLyricsToFoliaLines(lyrics, trackId, translationEnabled, romanEnabled),
    [lyrics, trackId, translationEnabled, romanEnabled],
  )

  // ── 主题映射（从封面主题色构建多彩词色 + 让背景跟封面走）──
  // 与参数面板共用 buildFoliaTheme：两边必须一致，否则面板配色会和实际渲染的主题对不上
  const theme: Theme = useMemo(
    () => buildFoliaTheme({ playerTheme, accentColor }),
    [playerTheme, accentColor],
  )

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
    // 用户显式调过的值覆盖上面的 WaveForge 默认；lumiere 放在最后，它的 darkField
    // 必须由上下文（MV 背景 / 是否用 folia 背景）决定，不能被持久化值覆盖回不透明。
    ...userTunings,
    lumiere: resolveLumiereTuning({
      mvBackgroundActive: Boolean(mvBackgroundActive),
      foliaBackgroundEnabled,
      renderQuality: resolveLumiereRenderQuality(perfMode),
      userTuning: userTunings?.lumiere,
    }),
  }), [mvBackgroundActive, foliaBackgroundEnabled, perfMode, userTunings])

  const [rendererReady, setRendererReady] = useState(false)
  useEffect(() => {
    // 样式切换时重挂载（folia 各样式自持渲染循环/场景，重挂载最稳）
    setRendererReady(false)
    const timer = window.setTimeout(() => setRendererReady(true), 0)
    return () => window.clearTimeout(timer)
  }, [mode])

  return (
    <div className="absolute inset-0 overflow-hidden">
      {rendererReady && active && lines.length > 0 && (
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
          smartBeatToggles={smartBeatToggles}
          smartBeatSample={smartBeatSample}
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
    prev.mvBackgroundActive === next.mvBackgroundActive &&
    prev.active === next.active
  )
}

export default memo(FoliaLyricsPage, foliaPropsEqual)
