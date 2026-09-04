/**
 * 插件系统核心类型定义。
 *
 * 一个插件 = 一份 PluginManifest（元信息 + 可选运行时代码）。
 * 内置插件（如 DG_LAB）由代码注册；第三方插件通过「导入插件」安装，
 * 其 manifest 持久化在 localStorage，可选携带一段受限运行时 code。
 */

/** 插件来源：内置（随应用发布，不可卸载）或导入（用户安装，可卸载）。 */
export type PluginSource = 'builtin' | 'imported'

/** 使用须知：entry 为「首次查看详情」弹窗文案，consent 为「首次开启功能」确认文案。 */
export interface PluginNotice {
  entry: string[]
  consent: string[]
}

export interface PluginManifest {
  /** 唯一标识（内置约定为 kebab-case 如 'dglab'；导入插件由 manifest 提供）。 */
  id: string
  name: string
  version: string
  /** 开发者/作者。 */
  developer: string
  /** 一句话简介（卡片展示）。 */
  description: string
  /** 更新日期（卡片/详情展示，格式自由，建议 YYYY-MM-DD）。 */
  updated: string
  /** Logo：图片 URL（渲染为 <img>）；缺省用 iconColor 渐变 + 名称首字。 */
  icon?: string
  /** Logo 渐变色（缺省用平台强调色）。 */
  iconColor?: string
  /** 运行截图（详情页展示；缺省渲染为渐变占位图块）。 */
  screenshots?: string[]
  /** 详细介绍段落。 */
  detail?: string[]
  /** 需要「使用须知」门控（如 DG_LAB）。 */
  requireNotice?: boolean
  notice?: PluginNotice
  /** 导入插件的运行时代码（可选，受限沙箱执行）。 */
  code?: string
  /** 启用后需要保持实时音频分析器运行。 */
  needsAudio?: boolean
  source: PluginSource
  installedAt?: number
}

/** DG_LAB 波形（设计器曲线或设备帧）。 */
export interface WavePoint {
  x: number
  y: number
  anchor?: number
}

/** 归一化的设备波形帧：频率（0-255）+ 强度（0-200）。 */
export interface WaveFrame {
  freq: number
  strength: number
}

export interface WavePoints {
  p1?: WavePoint[]
  p2?: WavePoint[]
  p3?: WavePoint[]
}

export type WaveSource = 'combined' | 'pulse' | 'generated'

export interface WaveDef {
  id: string
  name: string
  nameEn?: string
  source: WaveSource
  /** 设计器波形：原样保留参数组，保证可回导 DG-Lab App。 */
  params?: Record<string, number | string>
  points?: WavePoints
  /** 脉冲波形：直接设备帧。 */
  frames?: WaveFrame[]
  importedAt: number
}

/** 插件在渲染端的生命周期上下文（导入插件沙箱可用 API）。 */
export interface PluginContext {
  /** 订阅实时音频分析数据（30fps），返回退订函数。 */
  audio: {
    subscribe: (listener: (data: import('../hooks/useAudioAnalyzer').AudioAnalyzerData) => void) => () => void
  }
  storage: {
    get: (key: string) => string | null
    set: (key: string, value: string) => void
  }
  toast: (message: string, type?: 'success' | 'error' | 'info') => void
  log: (...args: unknown[]) => void
}

/** 插件生命周期：插件启用/停用时由注册表回调。 */
export interface PluginRuntime {
  onEnable?: (ctx: PluginContext) => void | Promise<void>
  onDisable?: () => void | Promise<void>
}
