/**
 * 模式切换转场动画设置（全局功能设置：对所有模式的切换生效）
 *
 * 两个开关：
 *  - modeTransitionStyle：'complex'（复杂 · Steam 风格描边动画 + 模式专属音效，默认）
 *                         | 'simple'（简易 · 原版加载徽章动画）
 *  - modeTransitionSound：复杂转场的音效开关（默认开；简易转场不发声）
 *
 * 与 globalSettingsRegistry（镜像到传统/探索/桌面设置页）和
 * SettingsPanel 个性化页（简约模式 UI）共用同一存储键 + 同一事件，保证三端同步。
 */

import { parseStoredBoolean } from '../utils/storage'

export type ModeTransitionStyle = 'complex' | 'simple'

const STYLE_KEY = 'modeTransitionStyle'
const SOUND_KEY = 'modeTransitionSound'

export const MODE_TRANSITION_STYLE_EVENT = 'modeTransitionStyleChanged'
export const MODE_TRANSITION_SOUND_EVENT = 'modeTransitionSoundChanged'

export function getModeTransitionStyle(): ModeTransitionStyle {
  if (typeof localStorage === 'undefined') return 'complex'
  return localStorage.getItem(STYLE_KEY) === 'simple' ? 'simple' : 'complex'
}

export function setModeTransitionStyle(style: ModeTransitionStyle): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STYLE_KEY, style)
  } catch { /* 配额满忽略 */ }
  window.dispatchEvent(new CustomEvent<ModeTransitionStyle>(MODE_TRANSITION_STYLE_EVENT, { detail: style }))
  // 通知镜像设置界面重读注册表（与其他全局设置同一通道）
  import('./globalSettingsRegistry').then(({ notifyGlobalSettingChanged }) => notifyGlobalSettingChanged()).catch(() => undefined)
}

export function isModeTransitionSoundEnabled(): boolean {
  if (typeof localStorage === 'undefined') return true
  return parseStoredBoolean(localStorage.getItem(SOUND_KEY), true)
}

export function setModeTransitionSoundEnabled(enabled: boolean): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(SOUND_KEY, JSON.stringify(enabled))
  } catch { /* 配额满忽略 */ }
  window.dispatchEvent(new CustomEvent<boolean>(MODE_TRANSITION_SOUND_EVENT, { detail: enabled }))
  import('./globalSettingsRegistry').then(({ notifyGlobalSettingChanged }) => notifyGlobalSettingChanged()).catch(() => undefined)
}
