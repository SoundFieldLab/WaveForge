/**
 * 学歌模式根（ViewMode='singalong'，与共振同级的全屏界面）。
 *
 * 布局：
 *   背景：当前歌封面模糊+暗化（无歌时紫色极光兜底）；
 *   左侧：双模式控制（跟唱：麦克风/实时音高/成绩；自学：进度/调速台）+ 伴奏分轨控制；
 *   右侧：自己的靠左逐句列表——活动行用 LyricWordFillLine（播放页 soft 填充同源）渲染逐字，
 *         其余行静态；罗马音逐字用 RomanWordLine；PB/新纪录/循环徽标逐行挂载；
 *   底部：句间导航 + 播放控制 + 进度条（句刻度点）+ 队列切歌。
 *
 * 选歌：右上「选歌」抽屉（平台歌单 + 搜索 + 队列），点歌经 onSongSelect 原地开播（playsInPlace）。
 *
 * 历史教训（勿回退）：逐字填充自研过五轮（整行 clip-path 均分错位 / 逐词 mask 带僵硬 /
 * rAF 直写被 React 重渲重置 / 柔和复刻仍不达观感 / 整面板复用丢布局），最终 =
 * 自己的逐句列表布局 + LyricsDisplay soft 路径逐行提取的 LyricWordFillLine（见 test/singalongKaraoke.test.ts）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Mic, MicOff, Play, Pause, Repeat, RotateCcw, X, Trophy, ChevronLeft, ChevronRight,
  AlertTriangle, BookOpen, GraduationCap, CheckCircle2, Circle, Gauge, ListMusic, Search,
  Music2, History, Keyboard, Type, Crown, PauseCircle, AudioLines, Loader2, Download, ScrollText,
} from 'lucide-react'
import type { SongSelectHandler } from '../../types/playbackNavigation'
import type { Song, LyricLine } from '../../services/musicApi'
import type { PlaybackTimeStore } from '../../audio/playbackTimeStore'
import type { ModeSelectionMode } from '../../components/ModeSelectionCards'
import type { TrackStemControlState } from '../../hooks/useAudioPlayer'
import CachedImage from '../../components/CachedImage'
import LyricWordFillLine, { RomanWordLine } from '../../components/LyricWordFill'
import ModeSelectionPanel, { MODE_SELECTION_CLOSE_MS } from '../../components/ModeSelectionPanel'
import { SING_ALONG_PLUGIN_ID, singAlongMicTracker } from '../../plugins/SingAlongPlugin'
import { selectSingableLines } from '../../plugins/clients/singalong/nowPlaying'
import { MicPitchTracker, type PitchSample } from '../../plugins/clients/singalong/micPitchTracker'
import { SingAlongTracker, hasAnyPitchReference, type ScoredLine } from '../../plugins/clients/singalong/lineTracker'
import { frequencyToNoteName, aggregateLineScores, scoreLabel, PitchStabilizer } from '../../plugins/clients/singalong/pitch'
import {
  loadMasteredLines,
  saveMasteredLines,
  loadSingAlongSettings,
  saveSingAlongSettings,
} from '../../plugins/clients/singalong/settings'
import {
  getSongRecord,
  getLineBest,
  recordLineScore,
  recordSongAttempt,
  getAllSongRecords,
  removeSongRecord,
  type LineRecord,
} from '../../plugins/clients/singalong/records'
import { PLAYBACK_SPEED_OPTIONS, savePlaybackSpeedSettings, loadPlaybackSpeedSettings } from '../../services/playbackSpeedSettings'
import SingAlongSongPicker from './SingAlongSongPicker'
import {
  exportAccompaniment,
  fetchAndCacheStems,
  remixStems,
  encodeAudioBlob,
  accompanimentFileName,
  isExportDisclaimerAccepted,
  acceptExportDisclaimer,
  SINGALONG_EXPORT_DISCLAIMER,
  EXPORT_QUALITIES,
  type ExportFormat,
  type RenderedStems,
} from '../../plugins/clients/singalong/accompanimentExport'

const ACCENT = '#7c5cff'

/** 分数 → 颜色。 */
function scoreColor(score: number): string {
  if (score >= 85) return '#34d399'
  if (score >= 70) return '#facc15'
  if (score >= 50) return '#fb923c'
  return '#f87171'
}

function lineText(line: LyricLine): string {
  return (line.text || '').trim()
}

function lineEndSeconds(line: LyricLine): number {
  let end = line.endTime ?? line.time + 4
  if (line.words?.length) {
    const last = line.words[line.words.length - 1]
    end = Math.max(end, line.time + (last.startTime + last.duration) / 1000)
  }
  return end
}

export interface SingAlongViewProps {
  playerTheme?: 'dark' | 'light'
  currentSong: Song | null
  /** App 层歌词（canonical；本视图自行做可唱行过滤） */
  lyrics: LyricLine[]
  lyricOffset: number
  isPlaying: boolean
  playbackTimeStore: PlaybackTimeStore
  /** 选歌开播（App handleSongSelect：原地换队列+播放，模式保持在学歌） */
  onSongSelect: SongSelectHandler
  onTogglePlay: () => void
  onSeek: (time: number) => void
  /** 当前队列与下标：上一首/下一首按钮直接用（免得依赖 App 内部逻辑） */
  playlist: Song[]
  currentIndex: number
  /** 分轨控制（伴奏模式）：App 注入；null = 该环境没有分轨能力。enable 返回 false = 不可用/失败 */
  stemControl: {
    state: TrackStemControlState
    enable: () => Promise<boolean> | boolean | void
    setVocalLevel: (level: number) => void
    setStemGains: (gains: { vocals?: number; drums?: number; bass?: number; other?: number }) => void
    returnToOriginal: () => void
    /** 拿整曲音频的本地缓存路径（伴奏导出用）。 */
    prepareInput: (song: Song) => Promise<string>
    /** 分轨桥直通（伴奏导出用；无桌面桥时为 null）。 */
    stemsBridge: {
      ensureWindow: (request: { inputPath: string; trackId: string; generationToken: string; requestId?: string; chunkSeconds?: 5 | 10; start: number; duration: number; priority?: number }) => Promise<unknown>
      readChunk: (filePath: string) => Promise<ArrayBuffer>
    } | null
  } | null
  onSelectMode: (mode: ModeSelectionMode) => void
}

type PracticeMode = 'karaoke' | 'selfstudy'

export default function SingAlongView({
  playerTheme = 'dark',
  currentSong,
  lyrics,
  lyricOffset,
  isPlaying,
  playbackTimeStore,
  onSongSelect,
  onTogglePlay,
  onSeek,
  playlist,
  currentIndex,
  stemControl,
  onSelectMode,
}: SingAlongViewProps) {
  const dark = playerTheme === 'dark'
  const timeSnapshot = useSyncExternalStore(
    playbackTimeStore.subscribe,
    playbackTimeStore.getSnapshot,
    playbackTimeStore.getSnapshot,
  )
  const currentTime = timeSnapshot.currentTime
  const [, forceTick] = useState(0)

  const lines = useMemo(() => selectSingableLines(lyrics), [lyrics])
  const [mode, setMode] = useState<PracticeMode>('karaoke')
  const [micOn, setMicOn] = useState(false)
  const [micError, setMicError] = useState('')
  const [liveNote, setLiveNote] = useState<string | null>(null)
  const [liveCents, setLiveCents] = useState<number | null>(null)
  const [scoredLines, setScoredLines] = useState<ScoredLine[]>([])
  const [masteredLines, setMasteredLines] = useState<Set<number>>(new Set())
  const [pickerOpen, setPickerOpen] = useState(false)
  const [modePanelOpen, setModePanelOpen] = useState(false)
  const [isTopHovered, setIsTopHovered] = useState(false)
  const [loopTarget, setLoopTarget] = useState<number | null>(null)
  const [slowSpeed, setSlowSpeed] = useState(() => loadPlaybackSpeedSettings().speed)
  const [pendingSummary, setPendingSummary] = useState<{ songName: string; lines: ScoredLine[]; summary: { total: number; pitch: number; rhythm: number }; at: number; newPb?: boolean } | null>(null)
  // ── 新增能力的状态 ──
  const [settings, setSettings] = useState(() => loadSingAlongSettings())
  const [showRecords, setShowRecords] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const [lineRecords, setLineRecords] = useState<Record<string, LineRecord>>({})
  const [songBest, setSongBest] = useState<number>(0)
  const [newBestLine, setNewBestLine] = useState<number | null>(null)
  /** 伴奏模式：vocal 增益 1=原唱 0.35=小声 0=纯伴奏。 */
  const [vocalMode, setVocalMode] = useState<'original' | 'low' | 'off' | 'custom'>('original')
  /** 逐句停顿：当前是否处于「等用户」的暂停窗口（显示倒计时）。 */
  const [pauseCountdown, setPauseCountdown] = useState<number | null>(null)
  /** 伴奏模式失败提示（可重试）。 */
  const [stemHint, setStemHint] = useState('')
  /** 自定义四轨面板开关（独立控制每轨增益，人声可到 120%）。 */
  const [stemCustomOpen, setStemCustomOpen] = useState(false)
  const [customGains, setCustomGains] = useState({ vocals: 1, drums: 1, bass: 1, other: 1 })
  /** 伴奏导出弹窗：开/关、四轨增益、音质、格式、试听。 */
  const [exportOpen, setExportOpen] = useState(false)
  const [exportDisclaimerOpen, setExportDisclaimerOpen] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [exportStage, setExportStage] = useState<'mixing' | 'encoding' | null>(null)
  const [exportProgress, setExportProgress] = useState(0)
  const [exportError, setExportError] = useState('')
  const [exportGains, setExportGains] = useState({ vocals: 0, drums: 1, bass: 1, other: 1 })
  const [exportFormat, setExportFormat] = useState<ExportFormat>('wav')
  const [exportQualityIndex, setExportQualityIndex] = useState(1)
  const [previewUrl, setPreviewUrl] = useState<string | null>(null)
  /** 实时重混后的续播意图（PreviewPlayer 挂载新音频时应用）。 */
  const [previewResume, setPreviewResume] = useState<{ position: number; playing: boolean } | null>(null)
  const previewAudioRef = useRef<HTMLAudioElement | null>(null)
  /** 已拉取缓存的四轨（生成一次后重混/试听/导出复用，不再走分轨桥网络）。 */
  const exportStemsRef = useRef<RenderedStems | null>(null)
  const remixThrottleRef = useRef<number | null>(null)
  const exportGainsRef = useRef(exportGains)
  exportGainsRef.current = exportGains
  const previewUrlRef = useRef<string | null>(null)
  previewUrlRef.current = previewUrl
  /** 麦克风设备列表（选择用）。 */
  const [micDevices, setMicDevices] = useState<MediaDeviceInfo[]>([])

  const micTrackerRef = useRef<MicPitchTracker | null>(null)
  const trackerRef = useRef<SingAlongTracker | null>(null)
  const modeRef = useRef<PracticeMode>('karaoke')
  const loopTargetRef = useRef<number | null>(null)
  const lyricsScrollRef = useRef<HTMLDivElement | null>(null)
  const lastScoredSongKeyRef = useRef('')
  const settingsRef = useRef(settings)
  const pauseStateRef = useRef<{ line: number; timer: number | null }>({ line: -1, timer: null })

  modeRef.current = mode
  loopTargetRef.current = loopTarget
  settingsRef.current = settings

  const songKey = currentSong
    ? `${currentSong.platform || 'netease'}:${currentSong.mid || currentSong.id}`
    : ''

  /* ------------------------------ 麦克风（跟唱模式） ------------------------------ */

  // 音高稳定器：修"鬼畜"（八度纠错 + 跳变门限 + 指数平滑），见 pitch.ts
  const pitchStabilizerRef = useRef<PitchStabilizer | null>(null)

  const startMic = useCallback(async (deviceId?: string) => {
    setMicError('')
    // 设备切换：先停旧的再按新 deviceId 启动
    const previous = micTrackerRef.current
    if (previous?.isRunning) await previous.stop()
    let tracker = micTrackerRef.current
    if (!tracker) {
      tracker = new MicPitchTracker()
      micTrackerRef.current = tracker
    }
    if (!pitchStabilizerRef.current) pitchStabilizerRef.current = new PitchStabilizer()
    pitchStabilizerRef.current.reset()
    let nullFrames = 0
    tracker.onSample = (sample: PitchSample) => {
      // 评分采样用原始值（评分自己按帧中位数聚合）；显示走稳定器
      trackerRef.current?.onPitchSample(sample)
      const stabilized = pitchStabilizerRef.current!.push(sample.frequency)
      if (sample.frequency == null) {
        nullFrames += 1
        // 连续 ~350ms 无声才熄灭显示（换气间隙不闪）
        if (nullFrames > 15) { setLiveNote(null); setLiveCents(null) }
        return
      }
      nullFrames = 0
      if (stabilized != null) {
        setLiveNote(frequencyToNoteName(stabilized))
        const clamped = Math.min(1, Math.max(0, (Math.log2(stabilized / 75)) / Math.log2(800 / 75)))
        setLiveCents(clamped)
      }
    }
    tracker.onLevel = () => { /* 电平并入刻度条，不再单独显示 */ }
    try {
      const target = deviceId ?? settingsRef.current.micDeviceId ?? ''
      // 首次未授权时 enumerateDevices 只有占位标签，先要一次权限再枚举才有名字
      await tracker.start(target || undefined)
      setMicOn(true)
      void navigator.mediaDevices?.enumerateDevices?.().then(devices => {
        setMicDevices(devices.filter(device => device.kind === 'audioinput'))
      }).catch(() => undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMicError(message.includes('Permission denied') || message.includes('NotAllowed')
        ? '麦克风权限被拒绝：请在系统设置中允许 WaveForge 使用麦克风，或改用「自学跟读」模式。'
        : message.includes('NotFound') || message.includes('Requested device not found')
          ? '找不到所选麦克风：设备可能已断开，请在麦克风设置里换一个。'
          : `麦克风启动失败：${message}`)
    }
  }, [])

  const stopMic = useCallback(async () => {
    const tracker = micTrackerRef.current
    if (tracker) {
      await tracker.stop()
      tracker.onSample = null
      tracker.onLevel = null
    }
    setMicOn(false)
    setLiveNote(null)
    setLiveCents(null)
  }, [])

  // 换模式离开跟唱 → 停麦
  useEffect(() => {
    if (mode !== 'karaoke' && micOn) void stopMic()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  /* ------------------------------ 跟唱 tracker 生命周期 ------------------------------ */

  useEffect(() => {
    if (lines.length === 0) {
      trackerRef.current = null
      return
    }
    trackerRef.current = new SingAlongTracker(lines, {
      onLineScored: (scored) => {
        setScoredLines(previous => {
          const next = [...previous]
          const index = next.findIndex(item => item.line === scored.line)
          if (index >= 0) next[index] = scored
          else next.push(scored)
          return next
        })
        // 写练习记录：超过该句历史最佳才刷新（新纪录给动效）
        const key = lastScoredSongKeyRef.current
        if (key) {
          const isPb = recordLineScore(key, scored.line.time, scored.score)
          const record = getLineBest(key, scored.line.time)
          if (record) {
            setLineRecords(previous => ({ ...previous, [String(scored.line.time)]: record }))
          }
          if (isPb) {
            setNewBestLine(lines.findIndex(line => line.time === scored.line.time))
            window.setTimeout(() => setNewBestLine(current => (current === lines.findIndex(line => line.time === scored.line.time) ? null : current)), 2600)
          }
        }
      },
    })
    return () => {
      trackerRef.current = null
    }
  }, [lines])

  // 歌曲切换：跟唱成绩留底弹出；自学进度 + 练习记录读新歌的
  useEffect(() => {
    if (lastScoredSongKeyRef.current === songKey) return
    const previousKey = lastScoredSongKeyRef.current
    const previousSongName = currentSong?.name || ''
    lastScoredSongKeyRef.current = songKey
    if (previousKey && scoredLines.length > 0) {
      const summary = aggregateLineScores(scoredLines.map(scored => scored.score))
      // 整曲结算写记录（练习次数 +1 + 最近练习 + 整曲 PB 判定）
      const newPb = recordSongAttempt(previousKey, summary, scoredLines.length)
      setPendingSummary({
        songName: previousSongName,
        lines: [...scoredLines],
        summary,
        at: Date.now(),
        newPb,
      })
    }
    setScoredLines([])
    setLoopTarget(null)
    setMasteredLines(songKey ? loadMasteredLines(songKey) : new Set())
    // 新歌的逐句 PB 与整曲最佳
    const record = songKey ? getSongRecord(songKey) : null
    setLineRecords(record?.lines || {})
    setSongBest(record?.bestTotal || 0)
    setNewBestLine(null)
    // 伴奏导出的四轨缓存必须跟着作废：否则下一首歌点「生成并试听」
    // 会直接重混上一首的音轨（严重串台）
    exportStemsRef.current = null
    setPreviewUrl(null)
    previewAudioRef.current?.pause()
    previewAudioRef.current = null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [songKey])

  /* ------------------------------ 进度驱动（行推进 + 循环 + 逐句停顿） ------------------------------ */

  const activeLineRef = useRef(-1)
  const [activeLine, setActiveLine] = useState(-1)
  useEffect(() => {
    let raf = 0
    const tick = () => {
      raf = 0
      const snapshot = playbackTimeStore.getSnapshot()
      const progress = snapshot.currentTime
      // 单句循环：两种模式都生效（跟唱 = 卡拉OK循环练，自学 = 反复听这句）
      const target = loopTargetRef.current
      if (target != null && target < lines.length && snapshot.isPlaying) {
        const line = lines[target]
        if (progress > lineEndSeconds(line) + 0.5) {
          onSeek(Math.max(0, line.time - 0.15))
        }
      }
      if (trackerRef.current && modeRef.current === 'karaoke') {
        const index = trackerRef.current.update(progress)
        if (index !== activeLineRef.current) {
          activeLineRef.current = index
          setActiveLine(index)
        }
      } else if (modeRef.current === 'selfstudy') {
        let index = -1
        for (let i = 0; i < lines.length; i += 1) {
          if (lines[i].time <= progress) index = i
          else break
        }
        if (index !== activeLineRef.current) {
          activeLineRef.current = index
          setActiveLine(index)
        }
      }
      // 逐句停顿：开着且在播放、且刚跨过一句的结尾 → 暂停等用户，倒计时结束后自动续播
      if (settingsRef.current.pauseAfterLine && snapshot.isPlaying && !pauseStateRef.current.timer) {
        const current = activeLineRef.current
        if (current >= 0 && current < lines.length) {
          const end = lineEndSeconds(lines[current])
          const nextStart = current + 1 < lines.length ? lines[current + 1].time : Number.POSITIVE_INFINITY
          // 只在「句尾已过、下一句还没开始」的窗口里暂停（有间隙的句子才停，密排歌词不停）
          if (progress > end && progress < nextStart - 0.4 && pauseStateRef.current.line !== current) {
            pauseStateRef.current = { line: current, timer: null }
            onTogglePlay()
            const duration = settingsRef.current.pauseDuration
            let remaining = duration
            setPauseCountdown(remaining)
            const countdown = window.setInterval(() => {
              remaining -= 1
              if (remaining <= 0) {
                window.clearInterval(countdown)
                pauseStateRef.current = { line: -1, timer: null }
                setPauseCountdown(null)
                // 用户没手动恢复就自动续播
                if (!playbackTimeStore.getSnapshot().isPlaying) onTogglePlay()
              } else {
                setPauseCountdown(remaining)
              }
            }, 1000)
            pauseStateRef.current = { line: current, timer: countdown }
          }
        }
      }
      // 用户在停顿窗口手动续播 → 收掉倒计时
      if (pauseStateRef.current.timer && snapshot.isPlaying) {
        window.clearInterval(pauseStateRef.current.timer)
        pauseStateRef.current = { line: -1, timer: null }
        setPauseCountdown(null)
      }
      forceTick(value => (value + 1) % 1000000)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      if (pauseStateRef.current.timer) window.clearInterval(pauseStateRef.current.timer)
    }
  }, [lines, playbackTimeStore, onSeek, onTogglePlay])

  // 打开界面按设置自动开麦（仅跟唱模式；自学不需要麦克风）
  useEffect(() => {
    if (modeRef.current === 'karaoke' && loadSingAlongSettings().autoStartMic) void startMic()
    return () => {
      // 离开学歌界面：停麦 + 还原慢速 + 还原人声（伴奏模式不能泄漏到普通播放）
      const tracker = micTrackerRef.current
      if (tracker) {
        void tracker.stop()
        tracker.onSample = null
        tracker.onLevel = null
      }
      micTrackerRef.current = null
      setMicOn(false)
      if (loadPlaybackSpeedSettings().speed !== 1) savePlaybackSpeedSettings(1)
      if (vocalModeRef.current !== 'original') stemControl?.returnToOriginal()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    saveSingAlongSettings(settings)
  }, [settings])

  /* ------------------------------ 伴奏模式（分轨人声控制） ------------------------------ */

  const vocalModeRef = useRef<'original' | 'low' | 'off' | 'custom'>('original')
  vocalModeRef.current = vocalMode
  /** 待应用的伴奏档位：分离就绪后由 pump 生效（分离期间滑增益会被下个 enable 重置）。 */
  const pendingVocalTargetRef = useRef<'low' | 'off' | null>(null)

  /**
   * 点击即分离（点「伴奏/人声小」立刻触发，不用不加载）：
   * 1. 立刻把 UI 档位切过去并标记意图；
   * 2. 若分轨尚未激活 → 调 enable()（内部防重入：in-flight 时复用同一 promise，不会互踩 generation）；
   * 3. enable 成功（激活或已激活）→ 应用目标人声增益；
   * 4. enable 返回 false（不支持/失败）→ UI 回原唱并显示失败提示条（可点重试）。
   */
  const changeVocalMode = useCallback((next: 'original' | 'low' | 'off') => {
    setVocalMode(next)
    setStemHint('')
    if (!stemControl) return
    if (next === 'original') {
      pendingVocalTargetRef.current = null
      stemControl.returnToOriginal()
      return
    }
    pendingVocalTargetRef.current = next
    const targetLevel = next === 'low' ? 0.35 : 0
    const applyTarget = () => {
      if (pendingVocalTargetRef.current !== next) return
      stemControl.setVocalLevel(targetLevel)
      pendingVocalTargetRef.current = null
    }
    if (stemControl.state.active) {
      applyTarget()
      return
    }
    void Promise.resolve(stemControl.enable()).then(result => {
      if (result === false) {
        // 失败：档位回原唱 + 提示（保留 reason 给重试按钮）
        if (pendingVocalTargetRef.current === next) pendingVocalTargetRef.current = null
        setVocalMode('original')
        setStemHint(stemControl.state.reason || '分轨准备失败，点「伴奏」重试')
        return
      }
      // enable 成功 = 激活（status partial/ready）。首次分离刚就绪时增益已随 mixer 重建为 1，这里落目标值
      applyTarget()
    }).catch(() => {
      if (pendingVocalTargetRef.current === next) pendingVocalTargetRef.current = null
      setVocalMode('original')
      setStemHint('分轨准备失败，点「伴奏」重试')
    })
  }, [stemControl])

  // 换歌时伴奏模式跟着重置到原唱（新歌要重新分离，避免旧增益串台）
  useEffect(() => {
    setVocalMode('original')
    setStemHint('')
    setStemCustomOpen(false)
    pendingVocalTargetRef.current = null
    setCustomGains({ vocals: 1, drums: 1, bass: 1, other: 1 })
  }, [songKey])

  /** 自定义面板：单轨独立调节（人声 0~1.2 可增益；进入自定义即按需启用分轨）。 */
  const changeCustomGain = useCallback((stem: 'vocals' | 'drums' | 'bass' | 'other', gain: number) => {
    setCustomGains(previous => ({ ...previous, [stem]: gain }))
    if (!stemControl) return
    const apply = () => stemControl.setStemGains({ [stem]: gain })
    if (stemControl.state.active) {
      apply()
      return
    }
    setVocalMode('custom')
    pendingVocalTargetRef.current = null
    void Promise.resolve(stemControl.enable()).then(result => {
      if (result === false) {
        setVocalMode('original')
        setStemHint(stemControl.state.reason || '分轨准备失败，稍后重试')
        return
      }
      apply()
    }).catch(() => {
      setVocalMode('original')
      setStemHint('分轨准备失败，稍后重试')
    })
  }, [stemControl])

  /** 拉取并缓存四轨（首次生成：唯一要走分轨桥网络链路的一步）。 */
  const fetchExportStems = useCallback(async (onProgress?: (value: number) => void): Promise<RenderedStems> => {
    if (!stemControl?.stemsBridge) throw new Error('分轨桥不可用（仅在桌面版可用）')
    const exportSong = currentSong
    if (!exportSong) throw new Error('请先播放这首歌')
    const inputPath = await stemControl.prepareInput(exportSong)
    const quality = EXPORT_QUALITIES[exportQualityIndex]
    return fetchAndCacheStems({
      bridge: stemControl.stemsBridge as Parameters<typeof fetchAndCacheStems>[0]['bridge'],
      inputPath,
      trackId: songKey,
      duration: Math.max(1, (exportSong.duration || 0) / 1000),
      onProgress,
      sampleRate: quality.sampleRate,
    })
  }, [stemControl, currentSong, songKey, exportQualityIndex])

  /**
   * 生成一次（拉轨 + 按当前增益重混），产物留在弹窗里：
   * 之后拖增益滑杆 → remixStems 本地重混（秒级、不重新拉轨）＝实时调整；
   * 进度条试听、确认导出都用这份缓存。增益统一读 ref：滑杆拖动与生成本身不会各用一份旧值。
   */
  const ensureExportRendered = useCallback(async (onProgress?: (value: number) => void) => {
    if (exportStemsRef.current) {
      return remixStems(exportStemsRef.current, exportGainsRef.current)
    }
    const cached = await fetchExportStems(onProgress)
    exportStemsRef.current = cached
    return remixStems(cached, exportGainsRef.current)
  }, [fetchExportStems])

  /** 试听：用已生成的混音走进度条播放（可拖动）。 */
  const startPreview = useCallback(async () => {
    setExportError('')
    try {
      setExporting(true)
      setExportStage('mixing')
      setExportProgress(0)
      const buffer = await ensureExportRendered(setExportProgress)
      const blob = await encodeAudioBlob(buffer, 'wav', 0)
      const url = URL.createObjectURL(blob)
      // PreviewPlayer 挂载新 url 时自动起播（resume 意图传 0/true）
      setPreviewResume({ position: 0, playing: true })
      setPreviewUrl(url)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : '生成失败，请重试')
    } finally {
      setExporting(false)
      setExportStage(null)
    }
  }, [ensureExportRendered])

  /** 确认导出：先过免责声明（首次），按格式/音质编码后下载。 */
  const startExport = useCallback(async () => {
    if (!stemControl || !stemControl.stemsBridge) return
    const exportSong = currentSong
    if (!exportSong) return
    setExportError('')
    // 免责声明：未确认过先弹框（确认一次后不再弹）
    if (!isExportDisclaimerAccepted()) {
      setExportDisclaimerOpen(true)
      return
    }
    previewAudioRef.current?.pause()
    setPreviewUrl(null)
    setExporting(true)
    setExportStage('mixing')
    setExportProgress(0)
    try {
      const quality = EXPORT_QUALITIES[exportQualityIndex]
      const buffer = await ensureExportRendered(setExportProgress)
      setExportStage('encoding')
      const blob = await encodeAudioBlob(buffer, exportFormat, quality.kbps)
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      // 文件名规范：[伴奏]歌手名-歌曲名（a.download 映射到保存对话框默认名）
      anchor.download = `${accompanimentFileName(exportSong)}.${exportFormat === 'wav' ? 'wav' : 'mp3'}`
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 15_000)
      setExportOpen(false)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : '导出失败，请重试')
    } finally {
      setExporting(false)
      setExportStage(null)
    }
  }, [stemControl, currentSong, exportFormat, exportQualityIndex, ensureExportRendered])

  /** 增益滑杆拖动（生成后）：本地重混立即生效——实时调整。 */
  const changeExportGain = useCallback((stem: 'vocals' | 'drums' | 'bass' | 'other', gain: number) => {
    setExportGains(previous => ({ ...previous, [stem]: gain }))
    if (!exportStemsRef.current) return
    const cached = exportStemsRef.current
    // 拖动节流：滑杆松手/停 120ms 才重混（拖动过程只改数字不重算）
    if (remixThrottleRef.current) window.clearTimeout(remixThrottleRef.current)
    remixThrottleRef.current = window.setTimeout(() => {
      remixThrottleRef.current = null
      if (!exportStemsRef.current) return
      void remixStems(cached, exportGainsRef.current).then(buffer => {
        // 播放中保持位置无缝换源：PreviewPlayer 的音频元素经共享 ref 读位置
        const audio = previewAudioRef.current
        const position = audio?.currentTime ?? 0
        const wasPlaying = audio ? !audio.paused : false
        return encodeAudioBlob(buffer, 'wav', 0).then(blob => {
          const old = previewUrlRef.current
          const url = URL.createObjectURL(blob)
          if (old) URL.revokeObjectURL(old)
          setPreviewUrl(url)
          setPreviewResume({ position, playing: wasPlaying })
        })
      }).catch(() => undefined)
    }, 120)
  }, [])

  // 弹窗关闭：收掉在途的节流重混 + 停试听 + 回收 blob URL（否则关窗后还在换源/出声）
  useEffect(() => {
    if (exportOpen) return
    if (remixThrottleRef.current) { window.clearTimeout(remixThrottleRef.current); remixThrottleRef.current = null }
    previewAudioRef.current?.pause()
    const url = previewUrlRef.current
    if (url) window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }, [exportOpen])

  // 组件卸载：同上
  useEffect(() => () => {
    if (remixThrottleRef.current) window.clearTimeout(remixThrottleRef.current)
    previewAudioRef.current?.pause()
    const url = previewUrlRef.current
    if (url) window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }, [])

  /* ------------------------------ 键盘快捷键 ------------------------------ */

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      // 输入框聚焦时不抢按键
      const target = event.target as HTMLElement | null
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
      switch (event.key) {
        case ' ': event.preventDefault(); onTogglePlay(); break
        case 'ArrowLeft': event.preventDefault(); stepLineRef.current(-1); break
        case 'ArrowRight': event.preventDefault(); stepLineRef.current(1); break
        case 'r': case 'R': {
          const base = loopTargetRef.current ?? activeLineRef.current
          if (base >= 0 && base < lines.length) onSeek(Math.max(0, lines[base].time - 0.15))
          break
        }
        case 'l': case 'L': setLoopTarget(current => (current == null ? Math.max(0, activeLineRef.current) : null)); break
        case 'm': case 'M': if (modeRef.current === 'karaoke') void (micOnRef.current ? stopMic() : startMic()); break
        case 's': case 'S': setMode(current => (current === 'karaoke' ? 'selfstudy' : 'karaoke')); break
        case 'p': case 'P': setSettings(current => ({ ...current, pauseAfterLine: !current.pauseAfterLine })); break
        default: break
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [lines, onSeek, onTogglePlay, startMic, stopMic])

  const micOnRef = useRef(micOn)
  micOnRef.current = micOn
  const stepLineRef = useRef<(delta: number) => void>(() => undefined)

  /* ------------------------------ 派生数据 ------------------------------ */

  const pitchReferenceAvailable = useMemo(() => hasAnyPitchReference(lines), [lines])
  const summary = useMemo(() => aggregateLineScores(scoredLines.map(scored => scored.score)), [scoredLines])
  const scoreOfLine = useCallback((index: number): ScoredLine | undefined =>
    scoredLines.find(scored => lines.indexOf(scored.line) === index), [scoredLines, lines])
  const masteredCount = masteredLines.size
  const progressPercent = lines.length > 0 ? Math.round(masteredCount / lines.length * 100) : 0

  // 歌词滚动跟随：当前句滚到视口上 1/3（LyricsDisplay 时代的同款跟随，作用于逐句列表容器）
  useEffect(() => {
    if (activeLine < 0 || !lyricsScrollRef.current) return
    const element = lyricsScrollRef.current.querySelector<HTMLElement>(`[data-line-index="${activeLine}"]`)
    if (element) {
      const container = lyricsScrollRef.current
      const target = element.offsetTop - container.clientHeight * 0.34
      container.scrollTo({ top: Math.max(0, target), behavior: 'smooth' })
    }
  }, [activeLine])

  /* ------------------------------ 交互 ------------------------------ */
  // 点句跳转/循环锚定/学会标记在这里；逐字填充由 LyricWordFillLine（播放页同源）渲染

  const jumpToLine = useCallback((index: number) => {
    const line = lines[index]
    if (!line) return
    setLoopTarget(index)
    onSeek(Math.max(0, line.time - 0.15))
  }, [lines, onSeek])

  const toggleMastered = useCallback((index: number) => {
    const line = lines[index]
    if (!line || !songKey) return
    setMasteredLines(previous => {
      const next = new Set(previous)
      if (next.has(line.time)) next.delete(line.time)
      else next.add(line.time)
      saveMasteredLines(songKey, next)
      return next
    })
  }, [lines, songKey])

  const stepLine = useCallback((delta: number) => {
    const base = loopTarget ?? activeLine
    const next = Math.max(0, Math.min(lines.length - 1, (base < 0 ? 0 : base) + delta))
    jumpToLine(next)
  }, [loopTarget, activeLine, lines.length, jumpToLine])
  // 键盘快捷键经 ref 调用（handler 依赖稳定，不随 activeLine 重挂）
  stepLineRef.current = stepLine

  const applyPracticeSpeed = useCallback((speed: number) => {
    setSlowSpeed(savePlaybackSpeedSettings(speed).speed)
  }, [])

  const song = currentSong
  const coverUrl = song?.album?.picUrl || ''
  const stemReady = stemControl?.state.status === 'ready' || stemControl?.state.status === 'partial'
  const stemSeparating = stemControl?.state.status === 'separating'
  const stemUnavailable = stemControl?.state.status === 'unavailable'
  const stemFailed = stemControl?.state.status === 'failed' || stemHint !== ''

  return (
    <div className={`relative h-full w-full overflow-hidden ${dark ? 'text-white' : 'text-black/85'}`}>
      {/* ── 背景层：封面模糊 + 暗化遮罩（无歌时紫色极光）── */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {coverUrl ? (
          <motion.div
            key={coverUrl}
            initial={{ opacity: 0, scale: 1.08 }}
            animate={{ opacity: 1, scale: 1.12 }}
            transition={{ duration: 1.2, ease: 'easeOut' }}
            className="absolute inset-0"
            style={{ filter: 'blur(90px) saturate(140%) brightness(0.55)' }}
          >
            {/* background 角色固定 256 档小图：全屏 90px 模糊下 256 已是超采样，512/1024 档只会
                让代理取图/解码更慢（之前「背景半天出不来」的主因）；critical 直排下载队列首位 */}
            <CachedImage src={coverUrl} alt="" platform={song?.platform} retainPrevious role="background" priority="critical" className="h-full w-full object-cover" fit="cover" />
          </motion.div>
        ) : (
          <div className="absolute inset-0" style={{ background: 'linear-gradient(155deg, #171230 0%, #100d20 55%, #090814 100%)' }}>
            <span className="absolute rounded-full" style={{ width: 720, height: 720, left: '-12%', top: '-22%', background: 'radial-gradient(circle, rgba(124,92,255,0.5), transparent 70%)', filter: 'blur(40px)' }} />
            <span className="absolute rounded-full" style={{ width: 640, height: 640, right: '-10%', top: '10%', background: 'radial-gradient(circle, rgba(52,211,153,0.32), transparent 70%)', filter: 'blur(40px)' }} />
          </div>
        )}
        {/* 顶部/底部压暗，保证文字可读 */}
        <div className="absolute inset-0" style={{ background: dark ? 'linear-gradient(180deg, rgba(6,7,14,0.55) 0%, rgba(6,7,14,0.25) 30%, rgba(6,7,14,0.35) 70%, rgba(6,7,14,0.78) 100%)' : 'linear-gradient(180deg, rgba(244,244,248,0.72) 0%, rgba(244,244,248,0.45) 30%, rgba(244,244,248,0.5) 70%, rgba(244,244,248,0.85) 100%)' }} />
      </div>

      {/* ── 内容层 ── */}
      <div className="relative z-10 flex h-full flex-col">
        {/* 顶栏 */}
        <div className="flex items-center justify-between gap-4 px-8 pt-5">
          <div className="flex min-w-0 items-center gap-4">
            {coverUrl && (
              <div className="h-14 w-14 shrink-0 overflow-hidden rounded-2xl shadow-lg" style={{ boxShadow: '0 10px 30px rgba(0,0,0,0.35)' }}>
                <CachedImage src={coverUrl} alt={song?.name || ''} platform={song?.platform} retainPrevious role="compact" priority="critical" className="h-full w-full object-cover" fit="cover" />
              </div>
            )}
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: ACCENT, boxShadow: `0 0 10px ${ACCENT}` }} />
                <h2 className="truncate text-xl font-bold tracking-tight">学歌</h2>
                <button
                  type="button"
                  onClick={() => setPickerOpen(true)}
                  className="flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-transform hover:scale-[1.04]"
                  style={{ background: 'rgba(124,92,255,0.16)', color: dark ? '#c4b5fd' : '#5b3fd4' }}
                  title="从歌单或搜索里选一首来学"
                >
                  <ListMusic className="h-3.5 w-3.5" />
                  选歌
                </button>
              </div>
              <p className="mt-1 truncate text-sm" style={{ color: dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)' }}>
                {song ? `${song.name} — ${song.artists.map((artist: { name: string }) => artist.name).join(', ')}` : '还没有选歌：点「选歌」挑一首开始学，或去播放任意歌曲'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2.5">
            {/* 模式切换 */}
            <div className="flex items-center gap-1 rounded-2xl p-1" style={{ background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }}>
              {([
                { id: 'karaoke' as const, label: '跟唱练习', icon: Mic },
                { id: 'selfstudy' as const, label: '自学跟读', icon: BookOpen },
              ]).map(item => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setMode(item.id)}
                  className="flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-semibold transition-colors"
                  style={mode === item.id
                    ? { background: `linear-gradient(135deg, ${ACCENT}cc, ${ACCENT}99)`, color: '#fff' }
                    : { color: dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)' }}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </button>
              ))}
            </div>
            {mode === 'karaoke' && (
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => (micOn ? stopMic() : startMic())}
                className={`flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold ${micOn ? '' : 'text-white'}`}
                style={{
                  background: micOn ? 'rgba(52,211,153,0.16)' : `linear-gradient(135deg, ${ACCENT}cc, ${ACCENT}99)`,
                  color: micOn ? '#34d399' : '#fff',
                  border: micOn ? '1px solid rgba(52,211,153,0.4)' : '1px solid transparent',
                }}
                title={micOn ? '关闭麦克风' : '开启麦克风开始练习'}
              >
                {micOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
                {micOn ? '练习中' : '开始练习'}
              </motion.button>
            )}
            {/* 伴奏控制（分轨人声）：跟唱/自学两模式都可用；点击即触发分离，不用不加载 */}
            {stemControl && (
              <div className="relative flex items-center gap-1 rounded-2xl p-1" style={{ background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)' }}
                title={stemFailed || stemUnavailable
                  ? `${stemControl.state.reason || '分轨不可用'}（点「伴奏」重试）`
                  : '伴奏模式：点「伴奏/人声小」开始分离人声（首次需加载模型，约 10–20 秒）；「自定义」可独立调四轨，人声最高 120% 方便逐句对照'}>
                <AudioLines className={`ml-1.5 h-3.5 w-3.5 ${stemSeparating ? 'animate-pulse' : ''}`}
                  style={{ color: vocalMode !== 'original' || stemCustomOpen ? ACCENT : dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)' }} />
                {([
                  { id: 'original' as const, label: '原唱' },
                  { id: 'low' as const, label: '人声小' },
                  { id: 'off' as const, label: '伴奏' },
                  { id: 'custom' as const, label: '自定义' },
                ]).map(item => (
                  <button
                    key={item.id}
                    type="button"
                    disabled={stemControl.state.locked}
                    onClick={() => {
                      if (item.id === 'custom') {
                        setStemCustomOpen(value => !value)
                        return
                      }
                      setStemCustomOpen(false)
                      changeVocalMode(item.id)
                    }}
                    className="rounded-lg px-2 py-1 text-[11px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-35"
                    style={item.id === 'custom'
                      ? (stemCustomOpen ? { background: ACCENT, color: '#fff' } : { color: dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)' })
                      : vocalMode === item.id
                        ? { background: item.id === 'original' ? (dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)') : ACCENT, color: item.id === 'original' ? (dark ? '#fff' : '#000') : '#fff' }
                        : { color: dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)' }}
                  >
                    {item.label}
                  </button>
                ))}
                {/* 分离中：按钮组下方细进度条（在整组容器上绝对定位） */}
                {stemSeparating && (
                  <div className="absolute inset-x-2 -bottom-0.5 h-0.5 overflow-hidden rounded-full" style={{ background: 'rgba(124,92,255,0.25)' }}>
                    <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${Math.round((stemControl.state.progress || 0.05) * 100)}%`, background: `linear-gradient(90deg, ${ACCENT}, #34d399)` }} />
                  </div>
                )}
              </div>
            )}
            {/* 工具：伴奏导出 / 练习记录 / 快捷键 / 显示设置 */}
            {stemControl?.stemsBridge && (
              <motion.button
                whileHover={{ scale: 1.05 }}
                whileTap={{ scale: 0.95 }}
                onClick={() => { setExportError(''); setExportOpen(true) }}
                className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs font-semibold text-white transition-colors"
                style={{ background: `linear-gradient(135deg, ${ACCENT}cc, ${ACCENT}99)` }}
                title="导出伴奏：可调四轨、试听、选音质与格式"
                aria-label="导出伴奏"
              >
                <Download className="h-4 w-4" />
                导出伴奏
              </motion.button>
            )}
            <button
              onClick={() => setShowRecords(true)}
              className="rounded-xl p-2 transition-colors hover:bg-white/10"
              aria-label="练习记录" title="练习记录（历史最佳/练习次数）"
            >
              <History className={`h-5 w-5 ${dark ? 'text-white/70' : 'text-black/60'}`} />
            </button>
            <button
              onClick={() => setShowShortcuts(value => !value)}
              className="rounded-xl p-2 transition-colors hover:bg-white/10"
              aria-label="快捷键" title="键盘快捷键"
            >
              <Keyboard className={`h-5 w-5 ${dark ? 'text-white/70' : 'text-black/60'}`} />
            </button>
            <button
              onClick={() => setSettings(current => ({ ...current, showTranslation: !current.showTranslation }))}
              className="rounded-xl p-2 transition-colors hover:bg-white/10"
              aria-label="翻译显示"
              title={`翻译：${settings.showTranslation ? '开' : '关'}`}
            >
              <Type className={`h-5 w-5 ${dark ? 'text-white/70' : 'text-black/60'}`} style={{ opacity: settings.showTranslation ? 1 : 0.45 }} />
            </button>
          </div>
        </div>

        {/* 顶部悬浮模式切换（与其他模式同款：顶部 hover 出下箭头 → 面板下拉） */}
        <div
          className="absolute left-1/2 top-0 z-40 h-8 w-32 -translate-x-1/2"
          onMouseEnter={() => setIsTopHovered(true)}
          onMouseLeave={() => setIsTopHovered(false)}
        >
          <AnimatePresence>
            {isTopHovered && !modePanelOpen && (
              <motion.button
                aria-label="打开模式选择"
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                onClick={() => setModePanelOpen(true)}
                className={`absolute left-1/2 top-0 flex -translate-x-1/2 items-center justify-center rounded-b-2xl border border-t-0 backdrop-blur-md ${dark ? 'border-white/20 bg-white/10 hover:bg-white/20' : 'border-black/15 bg-black/5 hover:bg-black/10'}`}
                style={{ width: '200px', height: '32px' }}
              >
                <svg className={`h-6 w-6 ${dark ? 'text-white' : 'text-black/70'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path d="M19 9l-7 7-7-7" strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} />
                </svg>
              </motion.button>
            )}
          </AnimatePresence>
        </div>

        {micError && (
          <div className="mx-8 mt-3 flex items-center gap-2 rounded-xl border border-red-400/30 px-3.5 py-2.5 text-xs"
            style={{ background: 'rgba(248,113,113,0.12)', color: '#fca5a5' }}>
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="flex-1">{micError}</span>
            <button onClick={() => { setMode('selfstudy'); setMicError('') }}
              className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold text-white" style={{ background: ACCENT }}>
              切自学跟读
            </button>
          </div>
        )}

        {/* 伴奏失败/不可用提示条：带重试（点击「伴奏」档也能重试） */}
        {stemControl && (stemFailed || stemUnavailable) && (
          <div className="mx-8 mt-3 flex items-center gap-2 rounded-xl border px-3.5 py-2.5 text-xs"
            style={{ background: 'rgba(250,204,21,0.10)', borderColor: 'rgba(250,204,21,0.35)', color: '#fde68a' }}>
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="flex-1">
              {stemHint || stemControl.state.reason || '分轨不可用'}
              <span className="ml-2 text-[10px] opacity-70">
                {stemControl.state.status === 'unavailable' && stemControl.state.reason?.includes('模型') ? '（设置 → 音效实验室 里可安装分轨模型）' : ''}
              </span>
            </span>
            <button
              onClick={() => { setStemHint(''); changeVocalMode('off') }}
              className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold text-white"
              style={{ background: ACCENT }}
            >
              重试分离
            </button>
          </div>
        )}

        {/* 快捷键速查（悬浮小卡） */}
        <AnimatePresence>
          {showShortcuts && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="absolute right-8 top-[68px] z-40 w-72 rounded-2xl border border-white/10 p-4 shadow-2xl"
              style={{ background: 'rgba(16,13,28,0.96)', backdropFilter: 'blur(20px)' }}
            >
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-white/85">键盘快捷键</p>
                <button onClick={() => setShowShortcuts(false)} className="rounded-lg p-1 hover:bg-white/10" aria-label="关闭快捷键速查">
                  <X className="h-3.5 w-3.5 text-white/50" />
                </button>
              </div>
              <div className="mt-2.5 space-y-1.5 text-xs">
                {([
                  ['空格', '播放 / 暂停'],
                  ['← / →', '上一句 / 下一句'],
                  ['R', '重听当前句'],
                  ['L', '单句循环开关'],
                  ['M', '麦克风开关'],
                  ['S', '跟唱 ↔ 自学切换'],
                  ['P', '逐句停顿开关'],
                ]).map(([key, label]) => (
                  <div key={key} className="flex items-center justify-between">
                    <kbd className="rounded-md border border-white/15 bg-white/[0.07] px-2 py-0.5 font-mono text-[10px] text-white/80">{key}</kbd>
                    <span className="text-white/55">{label}</span>
                  </div>
                ))}
              </div>
              {/* 麦克风选择 */}
              <div className="mt-3 border-t border-white/10 pt-2.5">
                <p className="text-xs font-bold text-white/85">麦克风</p>
                <select
                  value={settings.micDeviceId}
                  onChange={(event) => {
                    const deviceId = event.target.value
                    setSettings(current => ({ ...current, micDeviceId: deviceId }))
                    // 正在练习时立即切设备；没开麦则下次开麦生效
                    if (micOn) void startMic(deviceId || undefined)
                  }}
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-white/[0.06] px-2 py-1.5 text-xs text-white/80 outline-none"
                >
                  <option value="" className="bg-[#16121f]">系统默认麦克风</option>
                  {micDevices.map(device => (
                    <option key={device.deviceId} value={device.deviceId} className="bg-[#16121f]">
                      {device.label || `麦克风 ${device.deviceId.slice(0, 8)}…`}
                    </option>
                  ))}
                </select>
                {micDevices.length === 0 && (
                  <p className="mt-1 text-[10px] text-white/35">开一次麦克风后即可选择具体设备（浏览器授权前不暴露设备名）</p>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 自定义四轨面板（伴奏模式下拉悬浮卡）：独立控制每轨，人声最高 120%；含伴奏导出 */}
        <AnimatePresence>
          {stemCustomOpen && stemControl && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="absolute right-8 top-[68px] z-40 w-80 rounded-2xl border border-white/10 p-4 shadow-2xl"
              style={{ background: 'rgba(16,13,28,0.96)', backdropFilter: 'blur(20px)' }}
            >
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-white/85">自定义分轨 · 独立控制</p>
                <button onClick={() => setStemCustomOpen(false)} className="rounded-lg p-1 hover:bg-white/10" aria-label="关闭自定义分轨">
                  <X className="h-3.5 w-3.5 text-white/50" />
                </button>
              </div>
              {stemControl.state.status === 'separating' && (
                <div className="mt-2 rounded-lg px-2.5 py-1.5 text-[11px] text-white/60" style={{ background: 'rgba(124,92,255,0.12)' }}>
                  正在分离 {Math.round((stemControl.state.progress || 0) * 100)}% · 首次约 10–20 秒
                </div>
              )}
              <div className="mt-3 space-y-2.5">
                {([
                  { key: 'vocals' as const, label: '人声', hint: '练唱时可拉到 120% 放大原声对照' },
                  { key: 'drums' as const, label: '鼓组', hint: '' },
                  { key: 'bass' as const, label: '贝斯', hint: '' },
                  { key: 'other' as const, label: '其他乐器', hint: '' },
                ]).map(item => {
                  const value = Math.round(customGains[item.key] * 100)
                  return (
                    <div key={item.key}>
                      <div className="flex items-center justify-between text-[11px]">
                        <span className="text-white/70">{item.label}{item.hint && <span className="ml-1.5 text-white/30">{item.hint}</span>}</span>
                        <span className="font-semibold tabular-nums" style={{ color: value !== 100 ? '#c4b5fd' : 'rgba(255,255,255,0.45)' }}>{value}%</span>
                      </div>
                      <input
                        type="range" min="0" max="120" step="5" value={value}
                        disabled={stemControl.state.locked || stemControl.state.status === 'separating'}
                        onChange={event => changeCustomGain(item.key, Number(event.target.value) / 100)}
                        className="singalong-range mt-1 h-1.5 w-full cursor-pointer appearance-none rounded-full disabled:cursor-not-allowed disabled:opacity-50"
                        style={{ background: `linear-gradient(to right, ${ACCENT} 0%, ${ACCENT} ${value / 1.2}%, rgba(255,255,255,0.12) ${value / 1.2}%, rgba(255,255,255,0.12) 100%)` }}
                      />
                    </div>
                  )
                })}
              </div>
              <div className="mt-3 flex items-center gap-2">
                <button
                  onClick={() => { setCustomGains({ vocals: 1, drums: 1, bass: 1, other: 1 }); stemControl.setStemGains({ vocals: 1, drums: 1, bass: 1, other: 1 }) }}
                  className="flex-1 rounded-xl py-2 text-[11px] font-semibold text-white/70 transition-colors hover:bg-white/10"
                  style={{ background: 'rgba(255,255,255,0.06)' }}
                >
                  全部还原
                </button>
                <button
                  onClick={() => setExportOpen(true)}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl py-2 text-[11px] font-semibold text-white transition-colors"
                  style={{ background: `linear-gradient(135deg, ${ACCENT}cc, ${ACCENT}99)` }}
                  title="打开导出弹窗：可按当前增益试听并导出"
                >
                  <Download className="h-3.5 w-3.5" />
                  导出伴奏…
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 主体：左控制面板 + 右歌词（宽屏）/ 纯歌词列（窄屏） */}
        <div className="flex min-h-0 flex-1 gap-6 px-8 pb-2 pt-4">
          {/* 左侧：实时音高 + 成绩 / 自学进度 */}
          <div className="hidden w-64 shrink-0 flex-col gap-4 lg:flex">
            {mode === 'karaoke' ? (
              <>
                {/* 实时音高刻度 */}
                <div className="rounded-3xl p-4" style={{ background: dark ? 'rgba(20,16,34,0.72)' : 'rgba(255,255,255,0.72)', backdropFilter: 'blur(24px)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)' }}>
                  <p className="text-xs font-semibold" style={{ color: dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.65)' }}>你的音高</p>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-3xl font-black tabular-nums" style={{ color: liveNote ? '#fff' : 'rgba(255,255,255,0.25)' }}>
                      {liveNote ?? '—'}
                    </span>
                    <span className="text-xs" style={{ color: dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)' }}>{micOn ? (liveNote ? '正在发声' : '等待发声') : '麦克风未开'}</span>
                  </div>
                  {/* 音高指针条 */}
                  <div className="relative mt-3 h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.1)' }}>
                    {liveCents != null && (
                      <span
                        className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 border-white transition-[left] duration-75"
                        style={{ left: `calc(${Math.round(liveCents * 100)}% - 7px)`, background: ACCENT, boxShadow: `0 0 10px ${ACCENT}` }}
                      />
                    )}
                  </div>
                  <div className="mt-1.5 flex justify-between text-[10px]" style={{ color: dark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.3)' }}>
                    <span>低</span><span>高</span>
                  </div>
                </div>
                {/* 本曲成绩 */}
                <div className="flex-1 rounded-3xl p-4" style={{ background: dark ? 'rgba(20,16,34,0.72)' : 'rgba(255,255,255,0.72)', backdropFilter: 'blur(24px)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)' }}>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold" style={{ color: dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.65)' }}>本曲成绩</p>
                    <Trophy className="h-4 w-4" style={{ color: scoreColor(summary.total) }} />
                  </div>
                  {scoredLines.length > 0 ? (
                    <>
                      <div className="mt-2 flex items-baseline gap-2">
                        <span className="text-4xl font-black tabular-nums" style={{ color: scoreColor(summary.total) }}>{summary.total}</span>
                        <span className="text-xs" style={{ color: dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.65)' }}>{scoreLabel(summary.total)}</span>
                      </div>
                      <div className="mt-2 space-y-1 text-xs" style={{ color: dark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)' }}>
                        <div className="flex justify-between"><span>音准</span><span className="tabular-nums">{summary.pitch}</span></div>
                        <div className="flex justify-between"><span>节奏</span><span className="tabular-nums">{summary.rhythm}</span></div>
                        <div className="flex justify-between"><span>已唱</span><span className="tabular-nums">{scoredLines.length}/{lines.length} 句</span></div>
                      </div>
                    </>
                  ) : (
                    <p className="mt-3 text-xs leading-relaxed" style={{ color: dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)' }}>
                      {lines.length === 0 ? '这首歌没有可用歌词' : pitchReferenceAvailable ? '跟着歌词唱，每句唱完自动出分' : '这首歌词没有逐字时间轴：仅评节奏（该唱的时候有没有唱）'}
                    </p>
                  )}
                  {/* 历史最佳（练习记录）：本次成绩下面始终可对照 */}
                  {songBest > 0 && (
                    <div className="mt-3 flex items-center gap-2 rounded-xl px-3 py-2" style={{ background: 'rgba(250,204,21,0.08)' }}>
                      <Crown className="h-3.5 w-3.5" style={{ color: scoreColor(songBest) }} />
                      <span className="text-[11px]" style={{ color: dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.65)' }}>
                        历史最佳 <b className="tabular-nums" style={{ color: scoreColor(songBest) }}>{songBest}</b>
                      </span>
                    </div>
                  )}
                </div>
                {/* 逐句停顿开关 */}
                <button
                  onClick={() => setSettings(current => ({ ...current, pauseAfterLine: !current.pauseAfterLine }))}
                  className="flex items-center gap-2 rounded-2xl px-4 py-2.5 text-left text-xs transition-colors"
                  style={{
                    background: settings.pauseAfterLine ? 'rgba(124,92,255,0.14)' : dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.55)',
                    color: settings.pauseAfterLine ? '#c4b5fd' : dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)',
                  }}
                  title="每句播完自动暂停等你跟读，倒计时结束自动继续（快捷键 P）"
                >
                  <PauseCircle className="h-4 w-4" />
                  逐句停顿{settings.pauseAfterLine ? ' · 开' : ''}
                </button>
              </>
            ) : (
              <>
                {/* 自学进度 */}
                <div className="rounded-3xl p-4" style={{ background: dark ? 'rgba(20,16,34,0.72)' : 'rgba(255,255,255,0.72)', backdropFilter: 'blur(24px)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)' }}>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-semibold" style={{ color: dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.65)' }}>学习进度</p>
                    <GraduationCap className="h-4 w-4" style={{ color: progressPercent >= 100 ? '#34d399' : ACCENT }} />
                  </div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-4xl font-black tabular-nums" style={{ color: progressPercent >= 100 ? '#34d399' : dark ? '#fff' : '#000' }}>{progressPercent}%</span>
                    <span className="text-xs" style={{ color: dark ? 'rgba(255,255,255,0.75)' : 'rgba(0,0,0,0.65)' }}>{masteredCount}/{lines.length} 句</span>
                  </div>
                  <div className="mt-3 h-2 rounded-full" style={{ background: 'rgba(255,255,255,0.1)' }}>
                    <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${progressPercent}%`, background: 'linear-gradient(90deg, #7c5cff, #34d399)' }} />
                  </div>
                </div>
                {/* 调速台：选中档实心紫+白字（用户实测半透明紫在灰玻璃上不可读） */}
                <div className="rounded-3xl p-4" style={{ background: dark ? 'rgba(20,16,34,0.72)' : 'rgba(255,255,255,0.72)', backdropFilter: 'blur(24px)', boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.08)' }}>
                  <div className="flex items-center gap-2">
                    <Gauge className="h-4 w-4" style={{ color: dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)' }} />
                    <p className="text-xs font-semibold" style={{ color: dark ? 'rgba(255,255,255,0.65)' : 'rgba(0,0,0,0.6)' }}>调速台</p>
                    <span className="ml-auto text-xs font-bold tabular-nums" style={{ color: slowSpeed === 1 ? (dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)') : '#c4b5fd' }}>
                      {slowSpeed === 1 ? '原速' : `${slowSpeed}x`}
                    </span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-1.5">
                    {PLAYBACK_SPEED_OPTIONS.filter(option => option <= 2).map(option => (
                      <button
                        key={option}
                        type="button"
                        onClick={() => applyPracticeSpeed(option)}
                        className="rounded-xl py-2 text-xs font-bold transition-colors"
                        style={slowSpeed === option
                          ? { background: `linear-gradient(135deg, #8b6cff, #6d4df0)`, color: '#fff', boxShadow: '0 4px 14px rgba(109,77,240,0.45)' }
                          : { background: dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)', color: dark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)' }}
                      >
                        {option === 1 ? '原速' : `${option}x`}
                      </button>
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 右侧歌词：学歌自己的靠左逐句列表（一栏一栏）。
              逐字效果用 LyricWordFillLine（从播放页 LyricsDisplay soft 路径逐行提取的同源实现，
              与播放页同参数：灰底字+填充层 clip-path 推进+柔光大羽化+字上浮）。
              点歌词整行 = 跳到该句并循环（loopTarget 锚定该行，见 onSeek 包裹）。 */}
          <div
            ref={lyricsScrollRef}
            className="singalong-scroll min-h-0 flex-1 overflow-y-auto pr-1"
            style={{ maskImage: 'linear-gradient(180deg, transparent 0%, #000 6%, #000 94%, transparent 100%)', WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, #000 6%, #000 94%, transparent 100%)' }}
          >
            {lines.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-4" style={{ color: dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)' }}>
                <ListMusic className="h-12 w-12" />
                <p className="text-base">{song ? '这首歌没有可用的歌词（或纯音乐/电台直播），学不了' : '还没有选歌：点上方「选歌」挑一首开始学'}</p>
                {!song && (
                  <button
                    onClick={() => setPickerOpen(true)}
                    className="flex items-center gap-2 rounded-2xl px-5 py-2.5 text-sm font-semibold text-white"
                    style={{ background: `linear-gradient(135deg, ${ACCENT}cc, ${ACCENT}99)` }}
                  >
                    <Search className="h-4 w-4" />
                    去选歌
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2 py-6">
                {lines.map((line, index) => {
                  const isActive = index === activeLine
                  const isLoopTarget = loopTarget === index
                  const scored = mode === 'karaoke' ? scoreOfLine(index) : undefined
                  const linePb = mode === 'karaoke' ? lineRecords[String(line.time)] : undefined
                  const isMastered = masteredLines.has(line.time)
                  const nearActive = Math.abs(index - activeLine) <= 1
                  const sizeClass = isActive
                    ? (settings.lyricSize === 'large' ? 'text-5xl' : 'text-4xl')
                    : nearActive ? (settings.lyricSize === 'large' ? 'text-3xl' : 'text-2xl') : 'text-xl'
                  const opacity = isActive ? 1 : nearActive ? 0.62 : 0.32
                  const isNewBest = newBestLine === index
                  const romanText = (line.roman || '').trim()
                  return (
                    <div
                      key={`${line.time}-${index}`}
                      data-line-index={index}
                      onClick={() => jumpToLine(index)}
                      className={`group relative cursor-pointer rounded-3xl px-5 py-3 transition-all duration-300 ${isActive ? '' : 'hover:bg-white/[0.04]'}`}
                      style={isActive
                        ? { background: dark ? 'rgba(124,92,255,0.13)' : 'rgba(124,92,255,0.08)' }
                        : isLoopTarget ? { background: dark ? 'rgba(124,92,255,0.06)' : 'rgba(124,92,255,0.04)' } : undefined}
                    >
                      <div className="flex items-start gap-3">
                        {mode === 'selfstudy' && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); toggleMastered(index) }}
                            className="mt-1.5 shrink-0 p-0.5 transition-transform hover:scale-110"
                            title={isMastered ? '取消「已学会」' : '标记这句学会了'}
                            aria-label={isMastered ? '取消已学会' : '标记已学会'}
                          >
                            {isMastered
                              ? <CheckCircle2 className="h-6 w-6" style={{ color: '#34d399' }} />
                              : <Circle className="h-6 w-6 text-white/25" />}
                          </button>
                        )}
                        <div className="min-w-0 flex-1">
                          {isActive && line.words && line.words.length > 0 ? (
                            /* 活动行：播放页同源逐字填充（LyricWordFillLine） */
                            <LyricWordFillLine
                              lyric={line}
                              currentTime={currentTime}
                              lyricOffset={lyricOffset}
                              // 与播放页 activeLyricColor 同值：浅色主题下填充层用深色（白底上白色会隐形）
                              activeColor={dark ? 'rgba(255,255,255,1)' : 'rgba(15,15,15,0.92)'}
                              dark={dark}
                              size={sizeClass}
                              onPlayWord={(timeSeconds) => {
                                onSeek(Math.max(0, timeSeconds))
                                if (!isPlaying) onTogglePlay()
                              }}
                            />
                          ) : (
                            <p className={`${sizeClass} font-bold leading-snug transition-all duration-300`} style={{ opacity }}>
                              {lineText(line)}
                            </p>
                          )}
                          {/* 罗马音：优先逐字（romanWords 按主行词时间对齐点亮），行级 roman 兜底；
                              比翻译更醒目（学唱主要看它） */}
                          {line.romanWords && line.romanWords.length > 0 ? (
                            <p className={`mt-1 text-lg font-semibold tracking-wide ${dark ? 'text-emerald-200/90' : 'text-emerald-800/80'} ${isActive ? '' : 'opacity-55'}`}>
                              {isActive
                                ? <RomanWordLine lyric={line} currentTime={currentTime} lyricOffset={lyricOffset} dark={dark} />
                                : line.romanWords.map((word: { word: string }) => word.word).join('')}
                            </p>
                          ) : romanText ? (
                            <p className={`mt-1 text-lg font-semibold tracking-wide ${dark ? 'text-emerald-200/90' : 'text-emerald-800/80'} ${isActive ? '' : 'opacity-55'}`}>
                              {romanText}
                            </p>
                          ) : null}
                          {settings.showTranslation && line.translation && (
                            <p className={`mt-0.5 text-xs transition-opacity ${isActive ? 'opacity-50' : 'opacity-30'}`}>
                              {line.translation}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2 pt-1.5">
                          {scored && (
                            <span className="rounded-lg px-2.5 py-1 text-sm font-bold tabular-nums"
                              style={{ color: scoreColor(scored.score.total), background: `${scoreColor(scored.score.total)}22` }}
                              title={`音准 ${scored.score.pitch} · 节奏 ${scored.score.rhythm}`}>
                              {scored.score.total}
                            </span>
                          )}
                          {!scored && linePb && (
                            <span className="rounded-lg px-2 py-1 text-[10px] font-bold tabular-nums"
                              style={{ color: scoreColor(linePb.best), background: `${scoreColor(linePb.best)}14` }}
                              title={`这句历史最佳 ${linePb.best}（音准 ${linePb.pitch ?? '—'} · 节奏 ${linePb.rhythm ?? '—'}）`}>
                              PB {linePb.best}
                            </span>
                          )}
                          {isLoopTarget && (
                            <span className="rounded-lg px-2 py-1 text-[10px] font-bold" style={{ color: '#b9a5ff', background: 'rgba(124,92,255,0.16)' }}>
                              循环中
                            </span>
                          )}
                          {isNewBest && (
                            <motion.span
                              initial={{ scale: 0.6, opacity: 0 }}
                              animate={{ scale: 1, opacity: 1 }}
                              exit={{ opacity: 0 }}
                              className="rounded-lg px-2 py-1 text-[10px] font-black"
                              style={{ color: '#0b0a12', background: 'linear-gradient(135deg, #fbbf24, #f59e0b)', boxShadow: '0 0 16px rgba(245,158,11,0.55)' }}
                            >
                              新纪录!
                            </motion.span>
                          )}
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>

          {/* 循环句浮动信息（右上角，含评分） */}
          {loopTarget != null && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              className="pointer-events-none absolute right-10 top-[72px] z-20 flex items-center gap-2 rounded-2xl px-3.5 py-2 shadow-lg"
              style={{ background: 'rgba(20,16,34,0.88)', backdropFilter: 'blur(16px)' }}
            >
              <Repeat className="h-3.5 w-3.5" style={{ color: '#c4b5fd' }} />
              <span className="text-xs font-semibold text-white/85">循环第 {loopTarget + 1}/{lines.length} 句</span>
              {(() => {
                const scored = scoreOfLine(loopTarget)
                return scored ? (
                  <span className="rounded-lg px-2 py-0.5 text-xs font-bold tabular-nums"
                    style={{ color: scoreColor(scored.score.total), background: `${scoreColor(scored.score.total)}22` }}>
                    {scored.score.total}
                  </span>
                ) : null
              })()}
            </motion.div>
          )}
        </div>

        {/* 底部控制条 */}
        <div className="px-8 pb-5 pt-2">
          <div className="flex items-center justify-between gap-6 rounded-3xl px-6 py-3.5" style={{ background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.6)', backdropFilter: 'blur(24px)' }}>
            <div className="flex items-center gap-2">
              <button onClick={() => stepLine(-1)} className="rounded-full p-2.5 text-white/75 transition-colors hover:bg-white/10" title="上一句">
                <ChevronLeft className="h-5 w-5" />
              </button>
              <motion.button
                whileHover={{ scale: 1.06 }}
                whileTap={{ scale: 0.94 }}
                onClick={onTogglePlay}
                className="rounded-full p-3.5 text-white shadow-lg"
                style={{ background: `linear-gradient(135deg, ${ACCENT}dd, ${ACCENT}aa)` }}
                title={isPlaying ? '暂停' : '播放'}
              >
                {isPlaying ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
              </motion.button>
              <button onClick={() => stepLine(1)} className="rounded-full p-2.5 text-white/75 transition-colors hover:bg-white/10" title="下一句">
                <ChevronRight className="h-5 w-5" />
              </button>
              <button
                onClick={() => (loopTarget != null ? jumpToLine(loopTarget) : activeLine >= 0 ? jumpToLine(activeLine) : onSeek(0))}
                className="rounded-full p-2.5 text-white/75 transition-colors hover:bg-white/10"
                title={loopTarget != null ? '重听循环句' : '重听当前句'}
              >
                <RotateCcw className="h-5 w-5" />
              </button>
              <button
                onClick={() => setLoopTarget(current => (current == null ? Math.max(0, activeLine) : null))}
                className="flex items-center gap-1.5 rounded-xl px-3.5 py-2 text-xs font-semibold transition-colors"
                style={loopTarget != null
                  ? { background: 'rgba(124,92,255,0.2)', color: '#c4b5fd' }
                  : { background: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)', color: dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)' }}
                title={loopTarget != null ? '退出单句循环' : '循环练当前句（点击歌词任意句也能开始）'}
              >
                <Repeat className="h-4 w-4" />
                {loopTarget != null ? '循环中' : '单句循环'}
              </button>
            </div>

            {/* 进度条（点击跳转） */}
            <div className="flex min-w-0 flex-1 items-center gap-3">
              <span className="shrink-0 text-xs tabular-nums" style={{ color: dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)' }}>
                {formatTime(currentTime)}
              </span>
              <Seekbar
                currentTime={currentTime}
                duration={timeSnapshot.duration}
                onSeek={onSeek}
                dark={dark}
                marks={lines.map(line => ({ at: line.time, mastered: mode === 'selfstudy' && masteredLines.has(line.time) }))}
              />
              <span className="shrink-0 text-xs tabular-nums" style={{ color: dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)' }}>
                {formatTime(timeSnapshot.duration)}
              </span>
            </div>

            {/* 队列切歌 */}
            <div className="flex shrink-0 items-center gap-2">
              <button
                onClick={() => {
                  // 传 sourceIndex：同名歌在队列里出现多次时按位置精确定位
                  if (currentIndex > 0 && playlist[currentIndex - 1]) onSongSelect(playlist[currentIndex - 1], playlist, undefined, currentIndex - 1)
                }}
                disabled={currentIndex <= 0}
                className="rounded-full p-2.5 text-white/75 transition-colors hover:bg-white/10 disabled:opacity-30"
                title="队列上一首"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <button
                onClick={() => {
                  if (currentIndex >= 0 && currentIndex < playlist.length - 1 && playlist[currentIndex + 1]) onSongSelect(playlist[currentIndex + 1], playlist, undefined, currentIndex + 1)
                }}
                disabled={currentIndex < 0 || currentIndex >= playlist.length - 1}
                className="rounded-full p-2.5 text-white/75 transition-colors hover:bg-white/10 disabled:opacity-30"
                title="队列下一首"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 选歌抽屉 */}
      <SingAlongSongPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        currentSong={currentSong}
        onPickSong={(song, songs) => {
          onSongSelect(song, songs)
          setPickerOpen(false)
        }}
      />

      {/* 上一首成绩单浮层 */}
      <AnimatePresence>
        {pendingSummary && (
          <motion.div
            key={pendingSummary.at}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-30 flex items-center justify-center p-6"
            style={{ background: 'rgba(5,8,14,0.6)', backdropFilter: 'blur(10px)' }}
            onClick={() => setPendingSummary(null)}
          >
            <motion.div
              initial={{ scale: 0.94, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.94, y: 12 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-3xl border border-white/10 bg-[#14111f]/95 p-6 shadow-2xl"
            >
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl" style={{ background: `${ACCENT}26` }}>
                  <Trophy className="h-6 w-6" style={{ color: scoreColor(pendingSummary.summary.total) }} />
                </div>
                <div>
                  <h3 className="text-base font-bold text-white">
                    上一首成绩 · {pendingSummary.songName}
                    {pendingSummary.newPb && (
                      <motion.span
                        initial={{ scale: 0.7, rotate: -6 }}
                        animate={{ scale: 1, rotate: 0 }}
                        className="ml-2 inline-block rounded-lg px-2 py-0.5 align-middle text-[11px] font-black"
                        style={{ color: '#0b0a12', background: 'linear-gradient(135deg, #fbbf24, #f59e0b)', boxShadow: '0 0 16px rgba(245,158,11,0.55)' }}
                      >
                        新纪录!
                      </motion.span>
                    )}
                  </h3>
                  <p className="mt-0.5 text-xs text-white/50">
                    总分 <b style={{ color: scoreColor(pendingSummary.summary.total) }}>{pendingSummary.summary.total}</b>
                    <span className="mx-1.5">·</span>音准 {pendingSummary.summary.pitch}
                    <span className="mx-1.5">·</span>节奏 {pendingSummary.summary.rhythm}
                    <span className="mx-1.5">·</span>{scoreLabel(pendingSummary.summary.total)}
                  </p>
                </div>
              </div>
              <div className="singalong-scroll mt-4 max-h-56 space-y-1.5 overflow-y-auto pr-1">
                {pendingSummary.lines.map((scored, index) => {
                  // 对照该句历史最佳：超过 PB 标星
                  const pb = getLineBest(lastScoredSongKeyRef.current || '', scored.line.time)
                  const beatsPb = pb && pb.best < scored.score.total
                  return (
                    <div key={index} className="flex items-center gap-2.5 text-xs">
                      <span className="w-6 text-right text-white/35">{index + 1}</span>
                      <span className="flex-1 truncate text-white/70">{lineText(scored.line)}</span>
                      {pb && <span className="text-[10px] text-white/30">PB {pb.best}</span>}
                      <span className="font-bold" style={{ color: scoreColor(scored.score.total) }}>
                        {scored.score.total}
                        {beatsPb && <Crown className="ml-1 inline h-3 w-3 text-amber-300" />}
                      </span>
                    </div>
                  )
                })}
              </div>
              <button
                onClick={() => setPendingSummary(null)}
                className="mt-5 w-full rounded-xl py-2.5 text-sm font-semibold text-white"
                style={{ background: `linear-gradient(135deg, ${ACCENT}cc, ${ACCENT}99)` }}
              >
                继续练习
              </button>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 逐句停顿：等待跟读的倒计时浮标（不挡歌词） */}
      <AnimatePresence>
        {pauseCountdown != null && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="pointer-events-none absolute left-1/2 top-20 z-30 -translate-x-1/2 rounded-2xl px-5 py-2.5 shadow-2xl"
            style={{ background: 'rgba(16,13,28,0.92)', backdropFilter: 'blur(16px)' }}
          >
            <div className="flex items-center gap-3">
              <PauseCircle className="h-5 w-5" style={{ color: ACCENT }} />
              <div>
                <p className="text-sm font-bold text-white">轮到你了 · {pauseCountdown}s 后继续</p>
                <p className="text-[10px] text-white/45">跟着刚才那句唱，按空格提前继续</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 练习记录（全部歌曲） */}
      <AnimatePresence>
        {showRecords && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-40 flex items-center justify-center p-6"
            style={{ background: 'rgba(5,8,14,0.62)', backdropFilter: 'blur(10px)' }}
            onClick={() => setShowRecords(false)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.95, y: 12 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-lg rounded-3xl border border-white/10 bg-[#14111f]/95 p-6 shadow-2xl"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2.5">
                  <History className="h-5 w-5" style={{ color: ACCENT }} />
                  <h3 className="text-base font-bold text-white">练习记录</h3>
                </div>
                <button onClick={() => setShowRecords(false)} className="rounded-xl p-2 hover:bg-white/10" aria-label="关闭练习记录">
                  <X className="h-4 w-4 text-white/60" />
                </button>
              </div>
              <RecordsList
                songKey={songKey}
                onRepractice={() => setShowRecords(false)}
                onPick={(target) => {
                  const item = playlist.find(s => `${s.platform || 'netease'}:${s.mid || s.id}` === target)
                  if (item) {
                    onSongSelect(item, playlist)
                    setShowRecords(false)
                  }
                }}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 导出伴奏弹窗（宽面板双栏）：左 = 四轨增益，右 = 试听/格式/音质/导出 */}
      <AnimatePresence>
        {exportOpen && stemControl && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            style={{ background: 'rgba(5,8,14,0.72)', backdropFilter: 'blur(10px)' }}
            onClick={() => { previewAudioRef.current?.pause(); setPreviewUrl(null); setExportOpen(false) }}
          >
            <motion.div
              initial={{ scale: 0.96, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.96, y: 12 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-2xl rounded-3xl border border-white/10 bg-[#14111f]/97 shadow-2xl overflow-hidden"
            >
              {/* 标题栏 */}
              <div className="flex items-center justify-between border-b border-white/[0.07] px-6 py-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-2xl" style={{ background: `${ACCENT}22` }}>
                    <Download className="h-5 w-5" style={{ color: '#c4b5fd' }} />
                  </div>
                  <div>
                    <h3 className="text-base font-bold text-white">导出伴奏</h3>
                    <p className="text-[11px] text-white/45">{currentSong ? `${currentSong.name} — ${currentSong.artists.map((artist: { name: string }) => artist.name).join(', ')}` : '未在播放'}</p>
                  </div>
                </div>
                <button onClick={() => { previewAudioRef.current?.pause(); setPreviewUrl(null); setExportOpen(false) }} className="rounded-xl p-2 hover:bg-white/10" aria-label="关闭导出弹窗">
                  <X className="h-4 w-4 text-white/60" />
                </button>
              </div>

              {/* 双栏主体 */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-0">
                {/* 左栏：分轨混音 */}
                <div className="border-b border-white/[0.07] px-6 py-5 md:border-b-0 md:border-r">
                  <p className="text-xs font-bold text-white/85">分轨混音</p>
                  <p className="mt-0.5 text-[10px] text-white/35">默认去人声（纯伴奏）；拖高人声可导出带提词的练习版</p>
                  <div className="mt-4 space-y-3.5">
                    {([
                      { key: 'vocals' as const, label: '人声', hint: '0 = 去人声' },
                      { key: 'drums' as const, label: '鼓组', hint: '' },
                      { key: 'bass' as const, label: '贝斯', hint: '' },
                      { key: 'other' as const, label: '其他乐器', hint: '拉到 0 只留节奏组' },
                    ]).map(item => {
                      const value = Math.round(exportGains[item.key] * 100)
                      return (
                        <div key={item.key}>
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-semibold text-white/80">{item.label}{item.hint && <span className="ml-1.5 text-[10px] font-normal text-white/30">{item.hint}</span>}</span>
                            <span className="font-bold tabular-nums" style={{ color: value !== 100 && !(item.key === 'vocals' && value === 0) ? '#c4b5fd' : 'rgba(255,255,255,0.45)' }}>{value}%</span>
                          </div>
                          <input
                            type="range" min="0" max="120" step="5" value={value}
                            onChange={event => changeExportGain(item.key, Number(event.target.value) / 100)}
                            className="singalong-range mt-1.5 h-1.5 w-full cursor-pointer appearance-none rounded-full"
                            style={{ background: `linear-gradient(to right, ${ACCENT} 0%, ${ACCENT} ${value / 1.2}%, rgba(255,255,255,0.12) ${value / 1.2}%, rgba(255,255,255,0.12) 100%)` }}
                          />
                        </div>
                      )
                    })}
                  </div>
                  <button
                    type="button"
                    onClick={() => setExportGains({ vocals: 0, drums: 1, bass: 1, other: 1 })}
                    className="mt-4 w-full rounded-xl py-2 text-[11px] font-semibold text-white/65 transition-colors hover:bg-white/10"
                    style={{ background: 'rgba(255,255,255,0.06)' }}
                  >
                    恢复默认（去人声）
                  </button>
                </div>

                {/* 右栏：试听 + 格式/音质 + 导出 */}
                <div className="px-6 py-5">
                  <p className="text-xs font-bold text-white/85">试听</p>
                  {/* 生成后进度条试听：可拖动听任意位置；增益滑杆拖动实时重混 */}
                  {previewUrl ? (
                    <PreviewPlayer url={previewUrl} audioRef={previewAudioRef} resume={previewResume} onEnded={() => setPreviewUrl(null)} />
                  ) : (
                    <button
                      type="button"
                      onClick={() => void startPreview()}
                      disabled={exporting}
                      className="mt-2.5 flex w-full items-center justify-center gap-1.5 rounded-xl py-2.5 text-xs font-semibold text-white/85 transition-colors disabled:opacity-50"
                      style={{ background: 'rgba(255,255,255,0.08)' }}
                      title="生成伴奏并进入试听（生成后可拖动进度条、实时调增益）"
                    >
                      <Play className="h-4 w-4" />
                      {exporting ? `生成中 ${Math.round(exportProgress * 100)}%` : '生成并试听'}
                    </button>
                  )}

                  <p className="mt-5 text-xs font-bold text-white/85">格式与音质</p>
                  <div className="mt-2.5 flex gap-2">
                    {(['wav', 'mp3'] as ExportFormat[]).map(format => (
                      <button
                        key={format}
                        type="button"
                        onClick={() => setExportFormat(format)}
                        className="flex-1 rounded-xl py-2 text-xs font-bold uppercase transition-colors"
                        style={exportFormat === format
                          ? { background: `linear-gradient(135deg, #8b6cff, #6d4df0)`, color: '#fff' }
                          : { background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}
                      >
                        {format}
                      </button>
                    ))}
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-1.5">
                    {EXPORT_QUALITIES.map((quality, index) => (
                      <button
                        key={quality.label}
                        type="button"
                        onClick={() => {
                          setExportQualityIndex(index)
                          // 音质变化影响合成采样率：作废缓存，下次重新拉轨
                          exportStemsRef.current = null
                        }}
                        className="rounded-xl py-2 text-[10px] font-bold transition-colors"
                        style={exportQualityIndex === index
                          ? { background: `linear-gradient(135deg, #8b6cff, #6d4df0)`, color: '#fff' }
                          : { background: 'rgba(255,255,255,0.08)', color: 'rgba(255,255,255,0.7)' }}
                      >
                        {quality.label}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 truncate text-[10px] text-white/35">
                    文件名：{currentSong ? `${accompanimentFileName(currentSong)}.${exportFormat}` : '[伴奏]歌手名-歌曲名'}
                  </p>

                  {exporting && (
                    <div className="mt-3">
                      <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full transition-[width]" style={{ width: `${Math.round(exportProgress * 100)}%`, background: `linear-gradient(90deg, ${ACCENT}, #34d399)` }} />
                      </div>
                      <p className="mt-1 text-center text-[10px] text-white/40">
                        {exportStage === 'encoding' ? '正在编码…' : exportProgress < 1 ? '正在分离分轨（首次较慢）…' : '正在合成…'}
                      </p>
                    </div>
                  )}
                  {exportError && (
                    <p className="mt-2 rounded-lg px-2.5 py-1.5 text-[11px]" style={{ background: 'rgba(248,113,113,0.12)', color: '#fca5a5' }}>
                      {exportError}
                    </p>
                  )}

                  <button
                    type="button"
                    onClick={() => void startExport()}
                    disabled={exporting}
                    className="mt-4 w-full rounded-xl py-3 text-sm font-bold text-white transition-colors disabled:opacity-50"
                    style={{ background: `linear-gradient(135deg, #8b6cff, #6d4df0)`, boxShadow: '0 6px 20px rgba(109,77,240,0.4)' }}
                  >
                    {exporting ? `导出中 ${Math.round(exportProgress * 100)}%` : '确认导出'}
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 伴奏导出免责声明（版权警示，首次使用必须确认） */}
      <AnimatePresence>
        {exportDisclaimerOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-50 flex items-center justify-center p-6"
            style={{ background: 'rgba(5,8,14,0.72)', backdropFilter: 'blur(10px)' }}
          >
            <motion.div
              initial={{ scale: 0.94, y: 12 }}
              animate={{ scale: 1, y: 0 }}
              exit={{ scale: 0.94, y: 12 }}
              className="w-full max-w-md rounded-3xl border border-amber-400/25 bg-[#1a1520]/95 p-6 shadow-2xl"
            >
              <div className="flex items-center gap-2.5">
                <div className="flex h-10 w-10 items-center justify-center rounded-2xl" style={{ background: 'rgba(250,204,21,0.14)' }}>
                  <ScrollText className="h-5 w-5 text-amber-300" />
                </div>
                <h3 className="text-base font-bold text-white">伴奏导出 · 版权免责声明</h3>
              </div>
              <div className="mt-4 max-h-64 space-y-2.5 overflow-y-auto pr-1 singalong-scroll">
                {SINGALONG_EXPORT_DISCLAIMER.map((paragraph, index) => (
                  <p key={index} className={`text-xs leading-relaxed ${index === 1 ? 'font-semibold text-amber-200/90' : 'text-white/60'}`}>
                    {paragraph}
                  </p>
                ))}
              </div>
              <div className="mt-5 flex items-center gap-2.5">
                <button
                  onClick={() => setExportDisclaimerOpen(false)}
                  className="flex-1 rounded-xl py-2.5 text-sm font-semibold text-white/70 transition-colors hover:bg-white/10"
                  style={{ background: 'rgba(255,255,255,0.07)' }}
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    acceptExportDisclaimer()
                    setExportDisclaimerOpen(false)
                    void startExport()
                  }}
                  className="flex-1 rounded-xl py-2.5 text-sm font-semibold text-white"
                  style={{ background: 'linear-gradient(135deg, #f59e0bcc, #d9770699)' }}
                >
                  我已知晓并同意
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 模式选择面板（顶部箭头下拉）：与其他模式同一套「先播过渡再切」链路 */}
      <AnimatePresence>
        {modePanelOpen && (
          <ModeSelectionPanel
            currentMode="singalong"
            onClose={() => setModePanelOpen(false)}
            onSelect={(selected) => {
              setModePanelOpen(false)
              if (selected === 'singalong') return
              window.dispatchEvent(new CustomEvent('viewModeTransitionStart', { detail: selected }))
              window.setTimeout(() => {
                localStorage.setItem('viewMode', selected)
                onSelectMode(selected)
              }, MODE_SELECTION_CLOSE_MS)
            }}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

/** 练习记录列表：全部练过的歌（最佳分/次数/最近时间），支持删除与跳回再练。 */
function RecordsList({ songKey, onPick }: { songKey: string; onRepractice: () => void; onPick: (songKey: string) => void }) {
  const [records, setRecords] = useState(() => getAllSongRecords())
  useEffect(() => {
    const refresh = () => setRecords(getAllSongRecords())
    window.addEventListener('waveforge:singalong-records', refresh)
    return () => window.removeEventListener('waveforge:singalong-records', refresh)
  }, [])
  if (records.length === 0) {
    return <p className="mt-6 text-center text-sm text-white/35">还没有练习记录：去唱一首吧</p>
  }
  return (
    <div className="singalong-scroll mt-4 max-h-72 space-y-1.5 overflow-y-auto pr-1">
      {records.map(({ songKey: key, record }) => {
        const [platform, id] = key.split(':')
        const isCurrent = key === songKey
        return (
          <div key={key} className={`flex items-center gap-3 rounded-2xl px-3 py-2 ${isCurrent ? 'bg-white/[0.07]' : 'hover:bg-white/[0.04]'}`}>
            <div className="min-w-0 flex-1">
              <p className={`truncate text-sm font-semibold ${isCurrent ? 'text-[#c4b5fd]' : 'text-white/85'}`}>
                记录 {platform} · {String(id).slice(0, 10)}
                {isCurrent && <span className="ml-1.5 rounded bg-white/10 px-1 py-0.5 text-[9px]">当前</span>}
              </p>
              <p className="text-[10px] text-white/40">
                练了 {record.practiceCount} 次 · 最近 {new Date(record.lastAt).toLocaleDateString('zh-CN')}
              </p>
            </div>
            <span className="rounded-lg px-2.5 py-1 text-sm font-bold tabular-nums" style={{ color: scoreColor(record.bestTotal), background: `${scoreColor(record.bestTotal)}18` }}>
              {record.bestTotal}
            </span>
            <button
              onClick={() => onPick(key)}
              className="rounded-lg p-1.5 text-white/45 transition-colors hover:bg-white/10 hover:text-white"
              title="回到这首歌再练"
              aria-label="再练"
            >
              <Play className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => { removeSongRecord(key) }}
              className="rounded-lg p-1.5 text-white/35 transition-colors hover:bg-red-500/15 hover:text-red-400"
              title="删除这条记录"
              aria-label="删除记录"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
/** 进度条：句起始位置画刻度点（自学模式下已学会的句是绿点）。 */
function Seekbar({ currentTime, duration, onSeek, dark, marks }: {
  currentTime: number
  duration: number
  onSeek: (time: number) => void
  dark: boolean
  marks: { at: number; mastered: boolean }[]
}) {
  const barRef = useRef<HTMLDivElement | null>(null)
  const percent = duration > 0 ? Math.min(100, Math.max(0, currentTime / duration * 100)) : 0
  const handlePointer = (event: React.PointerEvent<HTMLDivElement>) => {
    const bar = barRef.current
    if (!bar || duration <= 0) return
    const rect = bar.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
    onSeek(ratio * duration)
  }
  return (
    <div
      ref={barRef}
      className="relative h-2.5 min-w-0 flex-1 cursor-pointer rounded-full"
      style={{ background: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)' }}
      onPointerDown={handlePointer}
    >
      <div className="absolute inset-y-0 left-0 rounded-full" style={{ width: `${percent}%`, background: `linear-gradient(90deg, ${ACCENT}88, ${ACCENT})` }} />
      {duration > 0 && marks.map((mark, index) => (
        <span
          key={index}
          className="absolute top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
          style={{
            left: `${mark.at / duration * 100}%`,
            background: mark.mastered ? '#34d399' : dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.3)',
            boxShadow: mark.mastered ? '0 0 6px rgba(52,211,153,0.8)' : 'none',
          }}
        />
      ))}
      <span
        className="absolute top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-full border-2 border-white shadow"
        style={{ left: `calc(${percent}% - 7px)`, background: ACCENT }}
      />
    </div>
  )
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, '0')}`
}

/**
 * 导出弹窗内的试听播放器：audio 元素 + 可拖动进度条（用户自己听任意位置）。
 * url 变化（实时重混换源）时保留播放位置。
 */
function PreviewPlayer({ url, audioRef, resume, onEnded }: {
  url: string
  /** 共享给父级（实时重混换源时读播放位置/播放态）。 */
  audioRef: React.RefObject<HTMLAudioElement | null>
  /** 挂载新音频后的起播意图（位置/是否播放）。 */
  resume: { position: number; playing: boolean } | null
  onEnded: () => void
}) {
  const [playing, setPlaying] = useState(false)
  const [position, setPosition] = useState(0)
  const [duration, setDuration] = useState(0)
  const [volume, setVolume] = useState(0.9)
  const resumeRef = useRef(resume)
  resumeRef.current = resume

  useEffect(() => {
    const audio = new Audio(url)
    audioRef.current = audio
    audio.onloadedmetadata = () => {
      setDuration(audio.duration || 0)
      // 应用起播意图（重混换源 = 保持原位置；生成 = 从头播）
      const intent = resumeRef.current
      if (intent && Number.isFinite(audio.duration)) {
        audio.currentTime = Math.min(intent.position, Math.max(0, audio.duration - 0.05))
      }
    }
    audio.onended = () => { setPlaying(false); onEnded() }
    audio.onplay = () => setPlaying(true)
    audio.onpause = () => setPlaying(false)
    audio.volume = volume
    const intent = resumeRef.current
    if (!intent || intent.playing) void audio.play().catch(() => undefined)
    return () => {
      audio.pause()
      audioRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume
  }, [volume])

  const toggle = () => {
    const audio = audioRef.current
    if (!audio) return
    if (audio.paused) void audio.play()
    else audio.pause()
  }

  const seek = (ratio: number) => {
    const audio = audioRef.current
    if (!audio || !Number.isFinite(audio.duration)) return
    audio.currentTime = ratio * audio.duration
    setPosition(audio.currentTime)
  }

  return (
    <div className="mt-2.5 rounded-2xl p-3" style={{ background: 'rgba(124,92,255,0.08)', boxShadow: 'inset 0 0 0 1px rgba(124,92,255,0.2)' }}>
      <div className="flex items-center gap-2.5">
        <motion.button
          whileHover={{ scale: 1.06 }}
          whileTap={{ scale: 0.94 }}
          onClick={toggle}
          className="shrink-0 rounded-full p-2.5 text-white"
          style={{ background: `linear-gradient(135deg, #8b6cff, #6d4df0)` }}
          aria-label={playing ? '暂停试听' : '继续试听'}
        >
          {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </motion.button>
        <div className="min-w-0 flex-1">
          {/* 进度条（可拖动） */}
          <div
            className="relative h-2 cursor-pointer rounded-full"
            style={{ background: 'rgba(255,255,255,0.12)' }}
            onPointerDown={(event) => {
              const rect = event.currentTarget.getBoundingClientRect()
              seek((event.clientX - rect.left) / rect.width)
            }}
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full pointer-events-none"
              style={{ width: duration > 0 ? `${Math.min(100, position / duration * 100)}%` : '0%', background: `linear-gradient(90deg, ${ACCENT}, #34d399)` }}
            />
            <span
              className="absolute top-1/2 h-3 w-3 -translate-y-1/2 rounded-full border-2 border-white pointer-events-none"
              style={{ left: duration > 0 ? `calc(${Math.min(100, position / duration * 100)}% - 6px)` : '0%', background: ACCENT }}
            />
          </div>
          <div className="mt-1 flex items-center justify-between text-[10px] tabular-nums text-white/45">
            <span>{formatTime(position)}</span>
            {/* 音量（试听独立，不影响导出内容） */}
            <span className="flex items-center gap-1.5">
              <Gauge className="h-3 w-3 text-white/35" />
              <input
                type="range" min="0" max="100" value={Math.round(volume * 100)}
                onChange={event => setVolume(Number(event.target.value) / 100)}
                className="singalong-range h-1 w-20 cursor-pointer appearance-none rounded-full"
                style={{ background: `linear-gradient(to right, ${ACCENT} 0%, ${ACCENT} ${volume * 100}%, rgba(255,255,255,0.12) ${volume * 100}%, rgba(255,255,255,0.12) 100%)` }}
              />
            </span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
