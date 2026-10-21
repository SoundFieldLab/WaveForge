/** HSE 浅色薄荷规范：正文清晰，交互表面保留玻璃反光与层次。 */

export interface HSETheme {
  dark: boolean
  accentColor: string
  accentGlow: string
  accentDim: string
  accentFrom: string
  accentTo: string
  accentGradient: string
  panelBg: string
  panelBorder: string
  panelHighlight: string
  cardBg: string
  cardBorder: string
  cardGlow: string
  navBg: string
  navActiveBg: string
  navActiveBorder: string
  navHoverBg: string
  textPrimary: string
  textSecondary: string
  textTertiary: string
  textMuted: string
  inputBg: string
  trackBg: string
  trackFill: string
  statusOk: string
  statusWarn: string
  glassBlur: string
  glassCardBlur: string
  sliderTrack: (value: number, min: number, max: number) => string
}

const COLORS = {
  canvas: '#F5F9F7',
  surface: '#FBFDFC',
  accent: '#006A63',
  accentSoft: '#C8EDE4',
  text: '#153A37',
  secondary: '#536B66',
  muted: '#758983',
  border: '#DCE9E5',
  track: '#D7E2DE',
  blue: '#DCECF8',
  apricot: '#F6E2D3',
}

export function createHSETheme(): HSETheme {
  const accentColor = COLORS.accent
  return {
    dark: false,
    accentColor,
    accentGlow: 'rgba(0,106,99,0.16)',
    accentDim: COLORS.accentSoft,
    accentFrom: '#168D7A',
    accentTo: accentColor,
    accentGradient: 'linear-gradient(155deg, #08776A 0%, #005C54 100%)',
    panelBg: COLORS.surface,
    panelBorder: COLORS.border,
    panelHighlight: 'linear-gradient(150deg, #FFFFFF 0%, #F5FAF7 62%, #EEF7F1 100%)',
    cardBg: 'linear-gradient(150deg, rgba(255,255,255,0.98) 0%, rgba(248,252,250,0.94) 100%)',
    cardBorder: COLORS.border,
    cardGlow: 'inset 0 1px 0 rgba(255,255,255,0.98), 0 2px 8px rgba(41,84,67,0.035)',
    navBg: COLORS.surface,
    navActiveBg: 'linear-gradient(145deg, rgba(225,247,237,0.96), rgba(174,223,205,0.7))',
    navActiveBorder: accentColor,
    navHoverBg: '#EEF6F3',
    textPrimary: 'text-[#153A37]',
    textSecondary: 'text-[#536B66]',
    textTertiary: 'text-[#5F756F]',
    textMuted: 'text-[#5F756F]',
    inputBg: '#F3F8F6',
    trackBg: COLORS.track,
    trackFill: accentColor,
    statusOk: '#16845D',
    statusWarn: '#A85116',
    glassBlur: 'blur(14px) saturate(125%)',
    glassCardBlur: 'none',
    sliderTrack: (value: number, min: number, max: number) => {
      const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)))
      return `linear-gradient(to right, ${accentColor} 0%, ${accentColor} ${ratio * 100}%, ${COLORS.track} ${ratio * 100}%, ${COLORS.track} 100%)`
    },
  }
}

/** Keep legacy effect modals on the same palette while preserving their existing contract. */
export function toLegacyTheme(t: HSETheme): {
  dark: boolean
  accentColor: string
  accentGradient: string
  accentFrom: string
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
  sliderTrack: (value: number, min: number, max: number) => string
} {
  return {
    dark: false,
    accentColor: t.accentColor,
    accentGradient: t.accentGradient,
    accentFrom: t.accentFrom,
    accentTo: t.accentTo,
    glassPanel: t.panelBg,
    glassPanelHighlight: t.panelHighlight,
    glassCard: t.cardBg,
    glassBorder: t.cardBorder,
    glassBlur: t.glassBlur,
    glassCardBlur: t.glassCardBlur,
    textPrimary: t.textPrimary,
    textSecondary: t.textSecondary,
    textTertiary: t.textTertiary,
    inputBg: t.inputBg,
    sliderTrack: t.sliderTrack,
  }
}


export function useHSETheme(): HSETheme { return createHSETheme() }

/** 语义变量仅为快照新增空间控件适配，颜色来自主程序。 */
export function themeVariables(theme: HSETheme): import('react').CSSProperties {
  return {
    '--md-sys-color-primary': theme.accentColor,
    '--md-sys-color-primary-container': theme.accentDim,
    '--md-sys-color-secondary': '#536B66', '--md-sys-color-tertiary': '#416986',
    '--md-sys-color-error': '#A6362A', '--md-sys-color-background': '#F5F9F7',
    '--md-sys-color-surface': '#FBFDFC', '--md-sys-color-surface-container': '#FFFFFF',
    '--md-sys-color-surface-container-high': '#EEF6F3',
    '--md-sys-color-on-surface': '#153A37', '--md-sys-color-on-surface-variant': '#536B66',
    '--md-sys-color-outline-variant': theme.cardBorder,
  } as import('react').CSSProperties
}
