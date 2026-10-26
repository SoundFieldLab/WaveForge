/**
 * Folia 各模式的参数（tuning）持久化与面板主题。
 *
 * 上游把这些调参放在它自己的设置 store（zustand + IndexedDB）里，WaveForge 没有那套外壳，
 * 所以这里用 localStorage 存一份 per-mode 的 bundle，整包注入 FoliaLyricsPage 的
 * `visualizerTunings`。可用的模式 key 从 tuning registry 现取，不写死清单——
 * 新增模式时会自动纳入，改名时也不会留下读不出来的死键。
 */
import { resolveReadableThemeColor } from '../services/foliaReadableColor'
import { colorWithAlpha } from '../vendor/folia/components/visualizer/colorMix'
import { getVisualizerTuningModes } from '../vendor/folia/components/visualizer/tuningRegistry'
import type { VisualizerTuningBundle } from '../vendor/folia/components/visualizer/tuningRegistry'
import {
    DEFAULT_CADENZA_TUNING,
    DEFAULT_CAPPELLA_TUNING,
    DEFAULT_CLADDAGH_TUNING,
    DEFAULT_CLASSIC_TUNING,
    DEFAULT_DIORAMA_TUNING,
    DEFAULT_FUME_TUNING,
    DEFAULT_LUMIERE_TUNING,
    DEFAULT_MONET_TUNING,
    DEFAULT_PARTITA_TUNING,
    DEFAULT_PENDOLO_TUNING,
    DEFAULT_SONNET_TUNING,
    DEFAULT_TEMPERA_TUNING,
    DEFAULT_TILT_TUNING,
    type Theme,
} from '../vendor/folia/types'
import { DEFAULT_HANABI_TUNING } from '../vendor/folia/types'

export const FOLIA_TUNINGS_KEY = 'waveforge_folia_tunings'

/**
 * WaveForge 侧对个别模式的默认覆盖：凝彩/商籁的纹理分辨率降到 1。
 * 这两个是重 Pixi 模式，默认分辨率在本机（尤其 TV/集显）会明显掉帧，降一档观感几乎无差。
 */
export const WAVEFORGE_FOLIA_TUNING_DEFAULTS: VisualizerTuningBundle = {
  tempera: { ...DEFAULT_TEMPERA_TUNING, textureResolution: 1 },
  sonnet: { ...DEFAULT_SONNET_TUNING, textureResolution: 1 },
}

/**
 * 面板与可视化器共用的 folia 主题：从封面主题色 + 明暗推导。
 * 与 FoliaLyricsPage 里那份必须一致，否则面板配色会和实际渲染的主题对不上。
 */
export function buildFoliaTheme(input: { playerTheme: 'dark' | 'light'; accentColor: string }): Theme {
  const isDark = input.playerTheme === 'dark'
  // 封面主色往往很深，直接用作 accent/secondary 会在深色背景上发黑发灰、可读性差。
  // 做可读性校正：深色主题下过暗 → 提亮，浅色主题下过亮 → 压暗，保留色相。
  const readableAccent = resolveReadableThemeColor(input.accentColor, isDark)
  return {
    name: 'waveforge',
    backgroundColor: isDark ? '#15171f' : '#f4f4f7',
    primaryColor: isDark ? '#f5f6fa' : '#1c1d22',
    accentColor: readableAccent,
    secondaryColor: readableAccent,
    fontStyle: 'sans',
    animationIntensity: 'normal',
    wordColors: [
      { word: 'accent', color: readableAccent },
      { word: 'bright', color: isDark ? '#f5f6fa' : '#1c1d22' },
      { word: 'warm', color: isDark ? '#c9b8a8' : '#5c4a3a' },
    ],
  }
}

/** 面板控制卡的背景与滑块样式（取自上游 VisPlayground 的同名计算）。 */
export function buildFoliaPanelStyles(theme: Theme, isDaylight: boolean) {
  return {
    controlCardBg: colorWithAlpha(theme.backgroundColor, isDaylight ? 0.42 : 0.52),
    rangeInputClass: [
      'w-full h-1.5 rounded-full appearance-none cursor-pointer',
      '[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-3.5 [&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:hover:scale-125 [&::-webkit-slider-thumb]:transition-transform',
      '[&::-moz-range-thumb]:w-3.5 [&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:transition-transform',
      isDaylight
        ? 'bg-black/15 [&::-webkit-slider-thumb]:bg-zinc-700 [&::-moz-range-thumb]:bg-zinc-700'
        : 'bg-white/10 [&::-webkit-slider-thumb]:bg-white [&::-moz-range-thumb]:bg-white',
    ].join(' '),
  }
}

/** 各模式面板的基线值（面板滑块显示的就是「基线 + 用户改动」）。 */
export const FOLIA_MODE_DEFAULT_TUNINGS: Record<string, Record<string, unknown>> = {
  classic: { ...DEFAULT_CLASSIC_TUNING },
  cadenza: { ...DEFAULT_CADENZA_TUNING },
  partita: { ...DEFAULT_PARTITA_TUNING },
  fume: { ...DEFAULT_FUME_TUNING },
  claddagh: { ...DEFAULT_CLADDAGH_TUNING },
  cappella: { ...DEFAULT_CAPPELLA_TUNING },
  tilt: { ...DEFAULT_TILT_TUNING },
  monet: { ...DEFAULT_MONET_TUNING },
  diorama: { ...DEFAULT_DIORAMA_TUNING },
  pendolo: { ...DEFAULT_PENDOLO_TUNING },
  sonnet: { ...DEFAULT_SONNET_TUNING },
  tempera: { ...DEFAULT_TEMPERA_TUNING },
  lumiere: { ...DEFAULT_LUMIERE_TUNING },
  hanabi: { ...DEFAULT_HANABI_TUNING },
}

/**
 * 面板要编辑的值 = 基线 + 用户改动。
 *
 * 刻意**不含上下文推导值**：绘光在 MV 背景下的 `darkField: 0` 是运行时算出来的，
 * 如果面板显示它，用户随手拖一下别的滑块就会把这个 0 当成用户设置写进去，
 * MV 关掉之后暗场再也回不来。渲染路径用 resolveLumiereTuning 的推导值，面板用这份。
 */
export function resolvePanelTuning(bundle: VisualizerTuningBundle, mode: string): Record<string, unknown> {
  const base = WAVEFORGE_FOLIA_TUNING_DEFAULTS[mode as keyof VisualizerTuningBundle]
    ?? FOLIA_MODE_DEFAULT_TUNINGS[mode]
    ?? {}
  const override = bundle[mode as keyof VisualizerTuningBundle]
  return { ...base, ...(override as Record<string, unknown> | undefined) }
}

/**
 * 读取用户保存的 per-mode 调参。
 * 只接受 registry 认识模式、且值为普通对象——脏值一律丢弃而不是让整包失效，
 * 这样一个模式的数据坏掉不会连累其它模式。
 */
export function readFoliaTunings(): VisualizerTuningBundle {
  try {
    const raw = localStorage.getItem(FOLIA_TUNINGS_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const allowed = new Set<string>(getVisualizerTuningModes())
    const bundle: Record<string, unknown> = {}
    for (const [mode, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!allowed.has(mode)) continue
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      bundle[mode] = value
    }
    return bundle as VisualizerTuningBundle
  } catch {
    return {}
  }
}

export function writeFoliaTunings(bundle: VisualizerTuningBundle): void {
  try {
    localStorage.setItem(FOLIA_TUNINGS_KEY, JSON.stringify(bundle))
  } catch (error) {
    console.warn('保存 Folia 调参失败:', error)
  }
}

/** 该模式在 bundle 里是否已有用户改动（决定面板顶部是否显示「恢复默认」）。 */
export function hasFoliaTuningOverride(bundle: VisualizerTuningBundle, mode: string): boolean {
  return Boolean(bundle[mode as keyof VisualizerTuningBundle])
}
