/**
 * 音频引擎适配层 —— 统一接口与类型
 *
 * 设计目标：v1/v2/v3（及未来新引擎）都实现 IAudioEngineAdapter，App.tsx 只依赖
 * 这个接口，不再写版本分支。新引擎接入只需写 Adapter + 注册表加一行。
 *
 * UI 双模式（studioMode）：
 *  - 'custom'：引擎自带调音室 UI（连外壳自己渲染），adapter 的 renderStudio
 *    返回该引擎的调音室组件。v1/v2/v3 都是此模式。
 *  - 'generic'：引擎无 UI，adapter 返回通用调音室（GenericMixingStudio），
 *    通过 IAudioEngineUiBridge 接口驱动参数读写/导出。未来无 UI 引擎用此模式。
 *
 * 详见 docs/音频引擎适配层.md（随本模块一同更新）。
 */

import type { AudioEngineVersion } from '../audioEngineVersion'
import type { PlaybackTimeStore } from '../../audio/playbackTimeStore'

// ==================== 引擎清单（每个引擎用独立文件声明自己） ====================

/**
 * 引擎清单：每个引擎用独立文件（engines/v1.ts 等）导出此接口的实例，
 * 适配层注册表自动收集。新增引擎只需加一个清单文件 + 在 index.ts 的
 * import 列表里加一行，不需要改 switch-case 或写死版本列表。
 */
export interface EngineManifest {
  /** 引擎唯一标识（如 'v1'/'v2'/'v3'，未来 'v4'...），用作 localStorage key 和切换按钮 key */
  readonly id: string
  /** 引擎显示名（切换按钮 tooltip / 适配层日志用），由引擎自己声明 */
  readonly displayName: string
  /** 引擎描述（一句话简介，供 UI 提示用） */
  readonly description: string
  /** 适配器工厂：创建该引擎的 IAudioEngineAdapter 实例 */
  readonly createAdapter: (opts?: EngineAdapterOptions) => IAudioEngineAdapter
}

/** 适配器构造选项（传给 createAdapter，如 V2 的 onLowVolumeHint 回调） */
export interface EngineAdapterOptions {
  /** 低音量提示 toast 回调（V2 用） */
  onLowVolumeHint?: (message: string) => void
}

// ==================== 音频图句柄（三引擎同形） ====================

/**
 * 音频图句柄：由 useAudioPlayer 产出，传给引擎 attach。
 * v1/v2/v3 的 attach 都接受同形结构（audioContext + masterGain + analyser）。
 */
export interface AudioGraphHandle {
  audioContext: AudioContext
  masterGain: GainNode
  analyser: AnalyserNode
}

// ==================== 调音室公共 Props ====================

/** 所有调音室模式共用的跨切面 props */
export interface MixingStudioCommonProps {
  onClose: () => void
  playerTheme: 'dark' | 'light'
  /** 打开按钮的锚点位置（弹窗从按钮侧弹出/关闭时收缩回按钮） */
  anchorRect: { x: number; y: number; width: number; height: number } | null
  /** 当前引擎版本 id（切换入口高亮当前按钮） */
  engineVersion: string
  /** 请求切换引擎（App 负责热/冷切换与弹窗） */
  onSwitchEngine: (version: string) => void
  /** 可用引擎列表（由适配层注册表动态提供，调音室据此动态渲染版本按钮） */
  availableEngines: EngineManifest[]
}

/** renderStudio 接收的完整 props（公共 + 播放信息） */
export interface RenderStudioProps extends MixingStudioCommonProps {
  /** 当前播放音频 URL（导出用；v3 调音室不直接用，由 adapter 注入 exportMp3 闭包） */
  sourceUrl?: string
  /** 当前播放时长（秒，导出用） */
  sourceDuration?: number
  /** 导出文件基名（当前歌曲名；保存时自动追加 -Modified 后缀） */
  exportFileName?: string
  /** 播放时钟 store（可选）：App 注入给自定义调音室（v3「随曲目播放」读 currentTime）；缺省 = 独立运行 */
  playbackTimeStore?: PlaybackTimeStore
}

// ==================== 引擎能力描述 ====================

/**
 * 引擎能力：App 按能力决定行为，不写版本分支。
 * 例：supportsSystemVolume=false 时 App 不轮询系统音量；
 *     supportsLoudnessNormalization=false 时 App 不调响度归一化。
 */
export interface EngineCapabilities {
  /** 支持系统音量 → 等响度补偿（v1=false, v2/v3=true） */
  supportsSystemVolume: boolean
  /** 支持响度归一化（v1/v3=false，v3 引擎内实时实现；v2=true 走外部服务） */
  supportsLoudnessNormalization: boolean
  /** 支持低音量提示 toast（v2=true，v3=false） */
  supportsLowVolumeHint: boolean
}

// ==================== 通用调音室 UI 驱动接口 ====================

/**
 * 通用调音室 UI 桥：仅 generic 模式的引擎需要实现。
 * custom 模式的引擎自带 UI，不需要实现此接口（getUiBridge 返回 null）。
 */
export interface IAudioEngineUiBridge {
  /** 读参数（引擎原生形态，通用 UI 以 JSON 展示） */
  getParams(): unknown
  /** 写参数（引擎原生形态） */
  setParams(p: unknown): void
  /** 参数的结构化描述（若提供，通用 UI 渲染 EQ 滑块/音效开关；否则只显示 JSON） */
  getParamSchema(): ParamSchema | null
  /** 离线导出 MP3 */
  exportMp3(sourceUrl: string, durationSeconds: number): Promise<void>
  /** 场景列表（可选） */
  getScenes?(): Array<{ id: string; name: string }>
  /** 应用场景（可选） */
  applyScene?(id: string): void
}

/** 参数结构化描述（通用 UI 用） */
export interface ParamSchema {
  /** EQ 频段（通用 UI 渲染滑块） */
  eqBands?: Array<{ frequency: number; gain: number; label?: string }>
  /** 音效开关列表（通用 UI 渲染开关） */
  effects?: Array<{ key: string; label: string; enabled: boolean }>
}

// ==================== UI 模式 ====================

/**
 * 调音室 UI 模式：
 *  - 'custom'：引擎自带 UI（含外壳），adapter.renderStudio 返回引擎组件
 *  - 'generic'：引擎无 UI，adapter.renderStudio 返回 GenericMixingStudio
 */
export type StudioMode = 'custom' | 'generic'

// ==================== 统一适配器接口 ====================

/**
 * 音频引擎统一适配器接口。
 * 每个引擎（v1/v2/v3/未来）实现此接口，App.tsx 只依赖它。
 */
export interface IAudioEngineAdapter {
  /** 引擎版本标识 */
  readonly version: AudioEngineVersion
  /** 引擎能力描述 */
  readonly capabilities: EngineCapabilities
  /** 调音室 UI 模式 */
  readonly studioMode: StudioMode

  // —— 生命周期 ——

  /** 接入音频图（幂等：同一 handle 重复调用直接复用）。v1/v2 同步，v3 异步（worklet 注册） */
  attach(handle: AudioGraphHandle): Promise<void>
  /** 拆除链路并恢复 masterGain→analyser 直连 */
  dispose(): void
  /** 是否已接入音频图 */
  isAttached(): boolean

  // —— 系统音量 → 等响度补偿 ——

  /** 系统音量（0-100）告知引擎；v1 no-op，v2/v3 据此调整频响补偿 */
  setSystemVolume(volume: number): void

  // —— 响度归一化（per-song LUFS 对齐） ——

  /** 按曲目施加响度归一化（v1/v3 no-op；v2 调外部 Python 服务测量+施加增益） */
  applyLoudnessNormalization(trackKey: string, url: string): void
  /** 重置响度归一化增益（v1/v3 no-op） */
  resetLoudnessNormalization(): void

  // —— 离线导出 ——

  /** 离线导出 MP3（内部触发浏览器下载） */
  exportMp3(sourceUrl: string, durationSeconds: number): Promise<void>

  // —— 调音室渲染 ——

  /**
   * 渲染调音室（按 studioMode 分两条路径）：
   *  - custom：返回引擎自带的调音室组件（含外壳）
   *  - generic：返回 GenericMixingStudio（通过 getUiBridge() 驱动）
   */
  renderStudio(props: RenderStudioProps): React.ReactNode

  // —— 通用 UI 桥（仅 generic 模式） ——

  /** 通用 UI 桥；custom 模式返回 null */
  getUiBridge(): IAudioEngineUiBridge | null

  // —— 导出状态（事件驱动，供 App 订阅重渲染） ——

  /** 当前是否正在导出 */
  isExporting(): boolean
  /** 订阅导出状态变化；返回取消订阅函数 */
  onExportingChange?(cb: (exporting: boolean) => void): () => void
}
