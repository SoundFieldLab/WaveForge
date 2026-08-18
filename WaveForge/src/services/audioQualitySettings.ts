import type { MusicPlatform } from './platforms'
﻿export type AudioQualityPreference =
  | 'auto'
  | 'standard'
  | 'high'
  | 'very-high'
  | 'lossless'
  | 'hi-res'

export interface AudioQualitySettings {
  netease: AudioQualityPreference
  qq: AudioQualityPreference
  spotify: AudioQualityPreference
  kugou: AudioQualityPreference
  soda: AudioQualityPreference
}

export const AUDIO_QUALITY_SETTINGS_KEY = 'audioQualitySettings'
export const AUDIO_QUALITY_SETTINGS_EVENT = 'waveforge-audio-quality-changed'

export const DEFAULT_AUDIO_QUALITY_SETTINGS: AudioQualitySettings = {
  netease: 'auto',
  qq: 'auto',
  spotify: 'auto',
  kugou: 'auto',
  soda: 'auto',
}

const QUALITY_VALUES: AudioQualityPreference[] = [
  'auto',
  'standard',
  'high',
  'very-high',
  'lossless',
  'hi-res',
]

const isQualityPreference = (value: unknown): value is AudioQualityPreference => (
  typeof value === 'string' && QUALITY_VALUES.includes(value as AudioQualityPreference)
)

export function loadAudioQualitySettings(): AudioQualitySettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_AUDIO_QUALITY_SETTINGS }

  try {
    const parsed = JSON.parse(localStorage.getItem(AUDIO_QUALITY_SETTINGS_KEY) || '{}') as Partial<AudioQualitySettings>
    return {
      netease: isQualityPreference(parsed.netease) ? parsed.netease : DEFAULT_AUDIO_QUALITY_SETTINGS.netease,
      qq: isQualityPreference(parsed.qq) ? parsed.qq : DEFAULT_AUDIO_QUALITY_SETTINGS.qq,
      spotify: isQualityPreference(parsed.spotify) ? parsed.spotify : DEFAULT_AUDIO_QUALITY_SETTINGS.spotify,
      kugou: isQualityPreference(parsed.kugou) ? parsed.kugou : DEFAULT_AUDIO_QUALITY_SETTINGS.kugou,
      soda: isQualityPreference(parsed.soda) ? parsed.soda : DEFAULT_AUDIO_QUALITY_SETTINGS.soda,
    }
  } catch {
    return { ...DEFAULT_AUDIO_QUALITY_SETTINGS }
  }
}

export function saveAudioQualitySettings(patch: Partial<AudioQualitySettings>): AudioQualitySettings {
  const next = {
    ...loadAudioQualitySettings(),
    ...patch,
  }
  if (!isQualityPreference(next.netease)) next.netease = DEFAULT_AUDIO_QUALITY_SETTINGS.netease
  if (!isQualityPreference(next.qq)) next.qq = DEFAULT_AUDIO_QUALITY_SETTINGS.qq
  if (!isQualityPreference(next.spotify)) next.spotify = DEFAULT_AUDIO_QUALITY_SETTINGS.spotify
  if (!isQualityPreference(next.kugou)) next.kugou = DEFAULT_AUDIO_QUALITY_SETTINGS.kugou
  if (!isQualityPreference(next.soda)) next.soda = DEFAULT_AUDIO_QUALITY_SETTINGS.soda

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(AUDIO_QUALITY_SETTINGS_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(AUDIO_QUALITY_SETTINGS_EVENT, { detail: next }))
  }
  return next
}

export function getAudioQualityPreference(platform: MusicPlatform): AudioQualityPreference {
  // Apple 无独立音质（播放走载体平台）；spotify 未登录也走载体，返回中性默认
  const settings = loadAudioQualitySettings()
  if (platform === 'apple') return settings.netease
  if (platform === 'spotify') return settings.spotify
  if (platform === 'kugou') return settings.kugou
  if (platform === 'soda') return settings.soda
  return settings[platform as 'netease' | 'qq']
}

export function getPlatformVipState(platform: MusicPlatform): boolean {
  if (typeof localStorage === 'undefined') return false
  if (platform === 'apple' || platform === 'spotify' || platform === 'soda') return false
  if (platform === 'kugou') return localStorage.getItem('kugou_vip') === 'true'
  return localStorage.getItem(platform === 'netease' ? 'netease_vip' : 'qq_vip') === 'true'
}

/**
 * 返回会传给本地 API 的设置快照。服务端仍会按实际接口返回结果逐级降级，
 * 这里的 VIP 状态只用于选择合理的候选顺序，避免反复请求明显不可用的音质。
 */
export function getAudioQualityRequest(platform: MusicPlatform): {
  preference: AudioQualityPreference
  isVip: boolean
} {
  return {
    preference: getAudioQualityPreference(platform),
    isVip: getPlatformVipState(platform),
  }
}
