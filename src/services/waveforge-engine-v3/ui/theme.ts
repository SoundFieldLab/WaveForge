/** 旧面板主题接口；视觉令牌与主程序 HSE 保持一致。 */
import { useHSETheme, toLegacyTheme } from './hse-theme'

export interface V3Theme {
  dark: boolean
  accentColor: string
  /** 主程序 HSE 主控渐变 */
  accentGradient: string
  /** 主控线条颜色 */
  accentFrom: string
  /** 主控渐变终点颜色 */
  accentTo: string
  glassPanel: string
  glassPanelHighlight: string
  glassCard: string
  glassBorder: string
  glassBlur: string
  glassCardBlur: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  inputBg: string
  /** 滑块的实色填充与中性剩余轨道 */
  sliderTrack: (value: number, min: number, max: number) => string
}


export function useV3Theme(_playerTheme: 'dark' | 'light'): V3Theme {
  return toLegacyTheme(useHSETheme())
}
