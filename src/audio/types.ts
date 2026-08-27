export type PlaybackMode = 'sequential' | 'shuffle' | 'repeat'

export type TransitionStrategy =
  | 'smart-rendered'
  | 'smart-rendered-v2'
  | 'beat-crossfade'
  | 'fixed-crossfade'
  | 'gapless'
  | 'none'

/** AutoMix 增强版（v2）特效强度档位 */
export type TransitionIntensity = 'subtle' | 'standard' | 'strong'

/** 调性检测结果（Krumhansl-Schmuckler，Camelot 记法） */
export interface KeyDetection {
  /** 主音（0-11，C=0） */
  tonic: number
  mode: 'major' | 'minor'
  /** 0-1 检测置信度 */
  confidence: number
  /** Camelot 编号（1-12） */
  camelot: number
}

/** AutoMix 增强版（v2）过渡特效编排计划 */
export interface V2Choreography {
  /** 过渡风格标签（UI 展示用） */
  style: 'energetic' | 'atmospheric' | 'clean'
  intensity: TransitionIntensity
  /** 特效开关 */
  riser: boolean
  noiseSweep: boolean
  drumFill: boolean
  tempoRampUp: boolean
  reverbDip: boolean
  echoOut: boolean
  bassSwap: boolean
  filterSweep: boolean
  /** 鼓点填充占用的拍数（落在过渡尾部，导向目标 downbeat） */
  drumFillBeats: number
  /** 0-1 调性兼容度（同调=1，相邻/关系调次之） */
  keyCompat: number
  /** 目标开头相对源结尾的能量差（绝对值，0-1） */
  energyDelta: number
  /** riser 起始拍（相对过渡窗口；按 source 乐句锚定，缺省=beatCount-3） */
  riserStartBeat?: number
  /** 混响虚化起始拍（相对过渡窗口；缺省=beatCount*0.55） */
  reverbStartBeat?: number
  /** riser 终止频率 Hz（调性驱动；缺省 2400） */
  riserEndFreq?: number
}

/** 过渡调试信息（调试弹窗展示用，从过渡计划摘要而来） */
export interface TransitionDebugInfo {
  /** 引擎：v1 / v2 / 兜底计划 */
  engine: 'v1' | 'v2' | 'fallback'
  strategy: TransitionStrategy
  fallbackReason?: string
  sourceTrackKey: string
  targetTrackKey: string
  beatCount: number
  sourceBpm: number
  targetBpm: number
  confidence: number
  rendererVersion: string
  sourceStartTime: number
  sourceEndTime: number
  targetStartTime: number
  targetEndTime: number
  /** v2 风格标签 */
  style?: V2Choreography['style']
  /** 强度档位 */
  intensity?: TransitionIntensity
  /** 实际编排的 DJ 效果清单（中文名，展示用） */
  effects?: string[]
  /** 调性兼容度 0-1 */
  keyCompat?: number
  /** 响度补偿 dB */
  gainOffsetDb?: number
  /** 分析来源（调试用：librosa / beat_this / browser / metadata） */
  sourceProvider?: string
  targetProvider?: string
}

export type TransitionState =
  | 'idle'
  | 'loading-current'
  | 'playing'
  | 'preparing-next'
  | 'armed'
  | 'running-transition'
  | 'committed'
  | 'cancelled'
  | 'failed'

export interface BeatTrackingResult {
  beats: number[]
  downbeats: number[]
  beatConfidence: number[]
  downbeatConfidence: number[]
  estimatedBpm: number
  meter?: number
  confidence: number
}

export interface SectionMarker {
  time: number
  beatIndex: number
  type: 'intro' | 'verse' | 'chorus' | 'bridge' | 'drop' | 'break' | 'outro' | 'unknown'
  confidence: number
}

export interface BeatFeatureFrame {
  beatIndex: number
  time: number
  loudness: number
  rms: number
  chroma: number[]
  timbre: number[]
  vocalness: number
  energy: number
}

export interface DJEffectsPlan {
  enabled: boolean
  profile: 'smooth' | 'energetic'
  intensity: number
  bassSwap: boolean
  filterSweep: boolean
  echoOut: boolean
  sweepFx: boolean
  echoDelayBeats: number
  echoFeedback: number
}

export interface TrackAnalysis {
  schemaVersion: number
  trackKey: string
  duration: number
  provider: 'beat_this' | 'librosa-fallback' | 'browser-fallback' | 'electron-unavailable' | 'metadata-only' | 'tv-metadata-only'
  beats: number[]
  downbeats: number[]
  beatConfidence: number[]
  downbeatConfidence: number[]
  estimatedBpm: number
  meter?: number
  confidence: number
  sections: SectionMarker[]
  beatFeatures: BeatFeatureFrame[]
  /** ITU-R BS.1770 积分响度（LUFS，Python 分析提供；响度归一化用） */
  integratedLufs?: number
  introSilence: number
  outroSilence: number
  /** 逐帧 RMS 包络（浏览器回退分析计算；MV 对齐包络互相关用） */
  rmsEnvelope?: number[]
  /** 包络互相关峰值（≥0.6 表示 MV 与歌曲同录音；网格置信度失效时可兜底用包络偏移） */
  envelopePeak?: number
  /** 包络互相关偏移（秒；仅 envelopePeak ≥0.6 时可信） */
  envelopeOffset?: number
  sourceSignature?: string
  analysisVersion: string
  createdAt: number
  lastAccessAt: number
}

export interface TransitionPlan {
  id: string
  sourceTrackKey: string
  targetTrackKey: string
  sourceStartTime: number
  sourceEndTime: number
  targetStartTime: number
  targetEndTime: number
  beatCount: number
  sourceBpm: number
  targetBpm: number
  tempoRamp: number[]
  sourceDownbeatIndex: number
  targetDownbeatIndex: number
  sourceSection?: SectionMarker
  targetSection?: SectionMarker
  sourceBeatTimes?: number[]  // Beat positions in seconds for progressive stretching
  targetBeatTimes?: number[]  // Beat positions in seconds for progressive stretching
  djEffects?: DJEffectsPlan
  /** AutoMix 增强版（v2）专用字段：v1 计划恒为 undefined，不参与 v1 的 plan.id 构造 */
  v2?: {
    key?: { source?: KeyDetection; target?: KeyDetection }
    choreography?: V2Choreography
    intensity?: TransitionIntensity
    aiMix?: boolean
    /** true = BPM 差过大（15~100），不做节拍对齐拉伸，只做特效过渡（riser/混响虚化/扫频等） */
    withoutBeatGrid?: boolean
    /** 部分同步（Apple 专利）：BPM 整数倍（140↔70 等）时快曲跳拍对齐慢曲网格的跳拍数（2/3/4） */
    partialSyncN?: number
    /** 谐波变调：过渡窗口内目标曲变调到源曲主音的半音数（±1~2，0=不变调） */
    pitchShiftSemitones?: number
    /** 目标窗口逐拍 vocalness（渲染期人声 ducking 用） */
    targetVocalness?: number[]
    /** DJTransGAN 学到的推子/EQ 自动化参数（v2 短过渡用；[prev_fo, next_fi]） */
    automation?: Array<{ band: number[][][]; fader: number[][][][] }>
  }
  gainCurve: { source: number[]; target: number[] }
  /** 响度补偿（dB）：作用于 target 侧，正数=抬高目标，负数=压低目标（clamp ±3.5dB） */
  gainOffsetDb?: number
  confidence: number
  strategy: TransitionStrategy
  fallbackReason?: string
  analysisVersion: string
  rendererVersion: string
  /** AI 长混音专用：缓冲尾段渐出/目标 deck 提前渐入的重叠窗口（秒），掩蔽 handoff 速度台阶 */
  overlapSeconds?: number
  /** AI 长混音专用：混音尾段 target 内容相对原曲的播放速度比（<1 慢 / >1 快）。
   *  handoff 时 deck 以此 playbackRate 起步，overlap 窗口内渐回 1.0（post-settle） */
  mixSpeedRatio?: number
}

export interface RenderedTransition {
  id: string
  url: string
  duration: number
  sourceTrackKey: string
  targetTrackKey: string
  createdAt: number
}

export interface TransitionCommit {
  sourceTrackKey: string
  targetTrackKey: string
  targetIndex?: number
  targetTime: number
  strategy: TransitionStrategy
  isVisualSwitch?: boolean  // true = 仅视觉切换，false/undefined = 真正的歌曲切换
}

export interface PreloadTrack {
  url: string
  trackKey?: string
  index?: number
  duration?: number
  albumId?: string
  albumCover?: string
  /** Apple Music 原生 HLS 音源元数据（url 为 .m3u8 时由引擎用 hls.js 播放） */
  appleHls?: import('../services/applePlayback').AppleNativeStream
}

export interface PlaybackEngineState {
  isPlaying?: boolean
  currentTime?: number
  duration?: number
  volume?: number
  buffered?: number
  ended?: boolean
  transitioning?: boolean
  seamlessTransition?: boolean
  transitionState?: TransitionState
  transitionStrategy?: TransitionStrategy
  fallbackReason?: string
  transitionCommit?: TransitionCommit
  visualSwitchCommit?: TransitionCommit
  transitionProgress?: number  // 过渡进度 0-1
  transitionDuration?: number  // 过渡总时长（秒）
  transitionStartTime?: number | null // 当前音轨进入计划过渡的时间点（秒）
  transitionFromTrackKey?: string  // 前一曲的 trackKey
  transitionToTrackKey?: string    // 下一曲的 trackKey
  transitionStyle?: 'energetic' | 'atmospheric' | 'clean' | undefined // v2 过渡风格标签（UI 提示用）
  transitionDebug?: TransitionDebugInfo // 过渡调试信息（过渡调试弹窗用）
}
