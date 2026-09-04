/**
 * WaveForge 音频引擎 v3 —— 公共出口（index）
 *
 * 出处/许可：
 *  - 本文件仅为模块聚合出口，无算法实现；各导出模块的出处/许可见各自源文件头部注释。
 *
 * 说明：
 *  - 导出内容：全部类型 + EngineV3 + 场景预设 + 分享串编解码 + 频谱分析器 +
 *    听力分析 + 声源分离队列 + Worklet 处理器名 + 全部 dsp 模块；
 *  - 注意：AudioWorklet 处理器模块在 AudioWorkletGlobalScope 外无法裸加载
 *    （见 worklet/AudioEffectsProcessor.ts 注释），故此处不直接 import 该模块
 *    （在 Node/测试环境其类定义 extends AudioWorkletProcessor 会抛 ReferenceError），
 *    改为本地转发同名常量（与 worklet 模块保持一致），融合时按需打包。
 */

/** AudioWorklet 处理器注册名（与 worklet/AudioEffectsProcessor.ts 中常量一致） */
export const WORKLET_PROCESSOR_NAME = 'waveforge-v3-effects'

export * from './types'
export { EngineV3 } from './engine/EngineV3'
export { EngineV3Host } from './integration/EngineV3Host'
export type { V3HostHandle, V3HostMode, V3HostOptions, V3AudioContextLike, V3AudioNodeLike } from './integration/EngineV3Host'
export { SCENE_PRESETS, getSceneById, SCENE_IDS } from './engine/ScenePresets'
export { encodeShareCode, decodeShareCode, SHARE_CODEC_VERSION } from './engine/ShareCodec'
export { SpectrumAnalyzer } from './analysis/Spectrum'
export { HearingTest } from './analysis/HearingTest'
export type { AudiogramPoint } from './analysis/HearingTest'
export { SeparationQueue, OnnxStemSeparator, DEFAULT_STEMS } from './offline/Separator'
export type { SeparationStem, StemSeparatorAdapter, SeparationTask } from './offline/Separator'

// —— dsp 全部模块 ——
export * from './dsp/fft'
export * from './dsp/biquad'
export * from './dsp/EqChain'
export * from './dsp/MidSide'
export * from './dsp/Deesser'
export * from './dsp/Compressor'
export * from './dsp/Limiter'
export * from './dsp/BassEnhancer'
export * from './dsp/Convolver'
export * from './dsp/ReverbSimple'
export * from './dsp/LufsMeter'
export * from './dsp/LoudnessComp'
export * from './dsp/Resampler'
export * from './dsp/Stretch'
export * from './dsp/PitchYin'
export {
  computeFeatures,
  computeRms,
  computeZcr,
  spectralCentroid,
  spectralRolloff,
  spectralFlatness,
  spectralCrest,
} from './dsp/features'
export type { FeatureInput } from './dsp/features'