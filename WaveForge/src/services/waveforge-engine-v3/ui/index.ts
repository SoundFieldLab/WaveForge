/**
 * WaveForge v3 调音室 UI —— 公共出口
 *
 * 导出：主面板 V3MixingStudio、引擎桥（createV3UiBridge + 类型）、
 * 设计语言（useV3Theme）、参数 hooks（useV3Params/DeepPartial/deepMerge）。
 * 融合侧只 import 本文件即可。
 */

export { default as V3MixingStudio } from './V3MixingStudio'
export type { V3MixingStudioProps } from './V3MixingStudio'
export { createV3UiBridge, MAX_MY_SCENES } from './bridge'
export type { V3UiBridge, V3HearingSession } from './bridge'
export { useV3Theme } from './theme'
export type { V3Theme } from './theme'
export { useV3Params, deepMerge } from './hooks'
export type { DeepPartial, V3ParamsController } from './hooks'
export { autoBoostAtVolume, COMP_PRESETS, CUSTOM_BAND_FREQUENCIES } from './modalsLoudness'
export { REVERB_TYPES, HARMONIC_TYPES } from './modalsSpatial'
export { IEQ_CURVES } from './modalsDynamics'
export { EqCurveEditor } from './eqCurveEditor'
export type { EqPoint } from './eqCurveEditor'
