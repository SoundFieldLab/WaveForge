export type PlaybackMode = 'sequential' | 'shuffle' | 'repeat'

export type TransitionStrategy =
  | 'smart-rendered'
  | 'beat-crossfade'
  | 'fixed-crossfade'
  | 'gapless'
  | 'none'

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
  gainCurve: { source: number[]; target: number[] }
  confidence: number
  strategy: TransitionStrategy
  fallbackReason?: string
  analysisVersion: string
  rendererVersion: string
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
}
