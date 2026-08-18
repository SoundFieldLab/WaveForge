/**
 * 音频引擎适配层 —— 工厂 + 注册表（自动收集引擎清单）
 *
 * 每个引擎用独立清单文件（engines/v1.ts 等）声明自己的 id/displayName/createAdapter。
 * 此处 import 清单文件并注册。新增引擎只需：
 *   1. 写 engines/v4.ts 导出 EngineManifest
 *   2. 在下方 import 列表加一行 + REGISTRY 数组加一项
 * App.tsx 和调音室 UI 不需要改任何代码——版本按钮自动动态渲染。
 */

import type { EngineManifest, EngineAdapterOptions, IAudioEngineAdapter } from './types'
import { v1Manifest } from './engines/v1'
import { v2Manifest } from './engines/v2'
import { v3Manifest } from './engines/v3'

export type {
  IAudioEngineAdapter,
  AudioGraphHandle,
  EngineCapabilities,
  StudioMode,
  IAudioEngineUiBridge,
  ParamSchema,
  MixingStudioCommonProps,
  RenderStudioProps,
  EngineManifest,
  EngineAdapterOptions,
} from './types'
export { V1Adapter } from './V1Adapter'
export { V2Adapter } from './V2Adapter'
export { V3Adapter } from './V3Adapter'
export { default as GenericMixingStudio } from './GenericMixingStudio'

/**
 * 引擎注册表：按顺序排列。第一项是默认引擎（getAudioEngineVersion 无保存值时回退）。
 * 新增引擎在此加一行 import + 一项即可。
 */
const REGISTRY: EngineManifest[] = [
  v1Manifest,
  v2Manifest,
  v3Manifest,
]

/** 按 id 查找清单 */
const REGISTRY_MAP: Map<string, EngineManifest> = new Map(REGISTRY.map((m) => [m.id, m]))

/**
 * 创建指定版本的引擎适配器。
 * @param version 引擎 id（由 getAvailableEngines() 提供）
 * @param opts 适配器构造选项（onLowVolumeHint 等）
 */
export function getEngineAdapter(
  version: string,
  opts?: EngineAdapterOptions,
): IAudioEngineAdapter {
  const manifest = REGISTRY_MAP.get(version)
  if (!manifest) {
    // 未注册的版本回退默认引擎（保证音频不中断）
    console.warn(`[audio-engine] 未注册的引擎版本 ${version}，回退 ${REGISTRY[0].id}`)
    return REGISTRY[0].createAdapter(opts)
  }
  return manifest.createAdapter(opts)
}

/** 已注册引擎的清单列表（供 UI 动态渲染版本切换按钮 + tooltip） */
export function getAvailableEngines(): EngineManifest[] {
  return REGISTRY
}

/** 已注册引擎的 id 列表（便捷方法） */
export function getAvailableEngineIds(): string[] {
  return REGISTRY.map((m) => m.id)
}

/** 默认引擎 id（注册表第一项） */
export function getDefaultEngineId(): string {
  return REGISTRY[0].id
}
