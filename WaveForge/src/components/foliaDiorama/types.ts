/**
 * folia（AGPL-3.0, github.com/chthollyphile/folia-major）Diorama 歌词模式的
 * 本地类型子集 —— 仅保留移植所需字段，接口与 folia 保持一致。
 */

export interface Word {
  text: string
  startTime: number // 秒
  endTime: number // 秒
  syllables?: LyricSyllable[]
}

export interface LyricSyllable {
  text: string
  startTime: number
  endTime: number
}

export interface LineRenderHints {
  rawDuration: number
  timingClass: 'normal' | 'short' | 'micro'
  renderEndTime: number
  lineTransitionMode: 'normal' | 'fast' | 'none'
  wordRevealMode: 'normal' | 'fast' | 'instant'
}

export interface Line {
  words: Word[]
  startTime: number
  endTime: number
  fullText: string
  translation?: string
  id?: string
  songPart?: string
  blockIndex?: number
  romanization?: string
  renderHints?: LineRenderHints
  isChorus?: boolean
}

export interface DioramaGeometryVisibility {
  enabled: boolean
  mode: 'clouds' | 'strands' | 'blobs' | 'ribbons' | 'rings'
  strands: boolean
  blobs: boolean
  ribbons: boolean
  rings: boolean
}

export const DEFAULT_DIORAMA_GEOMETRY_VISIBILITY: DioramaGeometryVisibility = {
  enabled: true,
  mode: 'clouds',
  strands: true,
  blobs: true,
  ribbons: true,
  rings: true,
}

export interface DioramaTuning {
  cameraSpeed: number
  motionAmount: number
  audioReactivity: number
  geometryVisibility: DioramaGeometryVisibility
  particleDensity: number
  particleScale: number
  particleGlowEnabled: boolean
  particleGlowIntensity: number
  showParticles: boolean
  backgroundParticleCircumference: number
  backgroundParticleRadial: number
  glowEnabled: boolean
  glowIntensity: number
  soulEnabled: boolean
  soulIntensity: number
  soulActiveEnabled: boolean
}

export const DEFAULT_DIORAMA_TUNING: DioramaTuning = {
  cameraSpeed: 1,
  motionAmount: 1,
  audioReactivity: 1,
  geometryVisibility: DEFAULT_DIORAMA_GEOMETRY_VISIBILITY,
  particleDensity: 576,
  particleScale: 1,
  particleGlowEnabled: true,
  particleGlowIntensity: 0.65,
  showParticles: true,
  backgroundParticleCircumference: 28,
  backgroundParticleRadial: 2,
  glowEnabled: true,
  glowIntensity: 1,
  soulEnabled: true,
  soulIntensity: 1,
  soulActiveEnabled: false,
}

/** 主题只用到 animationIntensity（驱动 calm/normal/chaotic 子模式）。 */
export interface Theme {
  animationIntensity?: 'calm' | 'normal' | 'chaotic'
}
