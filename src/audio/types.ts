import type { StemChoreography } from './stemTransitionPlanner'

export type PlaybackMode = 'sequential' | 'shuffle' | 'repeat'

export type TransitionStrategy =
  | 'smart-rendered'
  | 'smart-rendered-v2'
  /** AutoMix Enhanced：QQ 官方智能混音三档（Lite / Advanced / Extreme），云端切点 + 官方效果链 */
  | 'smart-rendered-qq'
  | 'beat-crossfade'
  | 'fixed-crossfade'
  | 'gapless'
  | 'none'

/** AutoMix Enhanced 档位 */
export type QQAutoMixTier = 'lite' | 'advanced' | 'extreme'

/** 云端档匹配用的曲目身份（QQ 曲库直接给 mid；其他平台给歌名/歌手做联想匹配） */
export interface QQTrackRef {
  mid?: string
  title?: string
  artist?: string
  trackId?: string
}

/** AutoMix Pro（v2）特效强度档位 */
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

/** AutoMix Pro（v2）过渡特效编排计划 */
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
  /** Enhanced 实际生效档位（与请求档位不同即说明发生了降级，展示用） */
  qqAppliedTier?: string
  /** 档位降级原因（如"未能在 QQ 音乐匹配到：前曲、后曲"） */
  tierFallbackReason?: string
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
  /** 源文件音频格式（Python 分析提供真实文件格式；浏览器回退提供解码前容器格式）。
   *  过渡格式预检（多声道→固定交叉）与后续无缝裁剪消费 */
  audioFormat?: { sampleRate: number; channels: number }
  /** 逐帧 RMS 包络（浏览器回退分析计算；MV 对齐包络互相关用） */
  rmsEnvelope?: number[]
  /** 包络互相关峰值（≥0.6 表示 MV 与歌曲同录音；网格置信度失效时可兜底用包络偏移） */
  envelopePeak?: number
  /** 包络互相关偏移（秒；仅 envelopePeak ≥0.6 且突出度达标时可信） */
  envelopeOffset?: number
  /** 包络峰突出度：主峰 − ±2s 外次峰。phonk 等重复结构的相关曲线平坦、多个局部峰
   *  几乎等高，绝对峰值（≥0.6）挡不住 argmax 落在错误的重复段上（实测 Одна 偏移
   *  错 ~4-5s ≈ 一句歌词）；突出度不足 = 偏移不可信 */
  envelopeProminence?: number
  /** 包络段投票共识偏移（秒，可选）：30s 段独立找局部峰、≥2 段聚到同一偏移的中位。
   *  与全曲峰一致（≤5s）= 峰可信旁证，供 MV 对齐"投票一致救援"（峰 0.45-0.6 的 live） */
  envelopeVoteOffset?: number
  /** 网格与 MV onset 的贴合度（gridOnsetConfidence，未混入锚点/清晰度偏置）。
   *  拍点提示模式下 confidence 是"拿歌曲节拍自证"的循环分数（恒≈1），对齐判定
   *  必须用这份独立证据（俺の彼女 回归） */
  gridBaseConfidence?: number
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
  /** 源曲全曲时长（秒）。云端切点（Enhanced）会落在曲中，渲染下载缓存的时长闸
   *  需要「全曲时长」而不是「过渡终点」——否则误判截断并永久降级固定交叉。 */
  sourceTrackDuration?: number
  targetTrackDuration?: number
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
  /** AutoMix Enhanced 专用：Q 官方智能混音档位与两首曲目的匹配身份（仅 'smart-rendered-qq' 使用） */
  qq?: {
    tier: QQAutoMixTier
    source: QQTrackRef
    target: QQTrackRef
  }
  /** AutoMix Enhanced 实际生效档位（云端档不可用时为 'lite'，由渲染结果回填） */
  qqAppliedTier?: string
  /** AutoMix Enhanced 过渡手法说明（worker 渲染 meta 透传；过渡调试弹窗展示） */
  qqTechniques?: string[]
  /** AutoMix Pro（v2）专用字段：v1 计划恒为 undefined，不参与 v1 的 plan.id 构造 */
  v2?: {
    /** Enhanced 默认后端：Folia Beat This + HTDemucs；仅 v2 使用。 */
    backend?: 'folia-htdemucs' | 'djtransgan'
    /** Beat This 是否为该计划提供了有效节拍/小节网格。 */
    beatProvider?: 'beat_this' | 'fallback'
    /** Folia 过渡专用 stem 证据与交接计划。 */
    folia?: {
      beatProvider: 'beat_this' | 'fallback'
      maxStemWindowSeconds: number
      sourceDownbeats: number[]
      targetDownbeats: number[]
    }
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
    /** 目标窗口逐拍 vocalness（无 stem 时的渲染期人声 ducking fallback） */
    targetVocalness?: number[]
    /** HTDemucs 需要分离的 v2-only 窗口；模型缺失/失败时保持现有 full-mix DSP */
    stemRequirement?: {
      source: { role: 'tail'; startTime: number; duration: number }
      target: { role: 'head'; startTime: number; duration: number }
      model: 'htdemucs'
      modelVersion: string
    }
    /** HTDemucs 实际证据精炼后的四轨交接计划；仅 stem 渲染路径消费 */
    stemChoreography?: StemChoreography
    /** Stem artifact 指纹（v2 缓存键用；不会进入 v1 plan） */
    stemFingerprint?: string
    /** 当前 v2 渲染请求使用的临时四轨 artifact；只含 renderer 所需路径/窗口信息 */
    stemArtifacts?: {
      source: { cacheKey: string; startSeconds: number; duration: number; files: Record<'drums' | 'bass' | 'vocals' | 'other', string> }
      target: { cacheKey: string; startSeconds: number; duration: number; files: Record<'drums' | 'bass' | 'vocals' | 'other', string> }
    }
    /** DJTransGAN 学到的推子/EQ 自动化参数（严格受 aiMix 可选开关控制） */
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
  /** 渲染器返回的过渡缓冲真实时长（秒）。动画窗口用它替代写死的模型窗口常量，
   *  模型换档时前端不再静默错位。仅渲染完成后由 TransitionRenderer 回填。 */
  renderedDuration?: number
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
  /**
   * 曲目身份（AutoMix Enhanced 云端档匹配用）：必须由 App 侧随元数据一起注入。
   * 缺失时 `qqTrackRef` 会得到空身份 → 云端档（advanced/extreme）100% 降级为 lite。
   */
  songId?: string | number
  mid?: string
  name?: string
  artists?: string[]
  /** Apple Music 原生 HLS 音源元数据（url 为 .m3u8 时由引擎用 hls.js 播放） */
  appleHls?: import('../services/applePlayback').AppleNativeStream
  /** 预载管线完成通知；用于瞬时失败后由队列层决定是否重试。 */
  onPreloadSettled?: (success: boolean) => void
}

export interface PlaybackEngineState {
  isPlaying?: boolean
  currentTime?: number
  duration?: number
  /** 直播流（Apple 电台等）：时长置 0，UI 显示直播指示、禁拖动 */
  live?: boolean
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
  /** 渲染过渡缓冲内当前可听到的目标歌曲绝对时间（MV 目标槽同步用） */
  transitionTargetTime?: number
  transitionStartTime?: number | null // 当前音轨进入计划过渡的时间点（秒）
  /** 过渡窗口的合成终点（源曲时间轴，= plan.sourceEndTime）：AI 长混音的合成时间
   *  会超过源曲时长，进度条用它作为分母而不是 duration（否则恒 100%） */
  transitionSourceEndTime?: number | null
  transitionFromTrackKey?: string  // 前一曲的 trackKey
  transitionToTrackKey?: string    // 下一曲的 trackKey
  transitionStyle?: 'energetic' | 'atmospheric' | 'clean' | undefined // v2 过渡风格标签（UI 提示用）
  transitionDebug?: TransitionDebugInfo // 过渡调试信息（过渡调试弹窗用）
}
