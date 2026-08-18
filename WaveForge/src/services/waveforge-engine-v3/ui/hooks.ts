/**
 * WaveForge v3 调音室 UI —— 参数快照 hooks
 *
 * 参数语义（v3 引擎约定）：完整快照（V3EngineParams），setParams 每次替换整包。
 * 本 hook 提供：
 *  - params：当前快照（深拷贝展示值）
 *  - patch(partial)：深合并后提交（UI 局部修改的惯用入口）
 *  - replace(next)：整包替换（场景应用 / 分享串导入 / 恢复默认）
 */

import { useCallback, useState } from 'react'
import type { V3EngineParams } from '../src/types'
import type { V3UiBridge } from './bridge'

/** 递归可选（数组与 Float32Array 整体替换，不做成员递归） */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends Float32Array | Array<unknown> ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K]
}

/** 深合并：普通对象递归；数组/原始值/Float32Array 直接替换 */
export function deepMerge<T>(base: T, patch: DeepPartial<T>): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch) || patch instanceof Float32Array) {
    return patch as T
  }
  if (base === null || typeof base !== 'object' || Array.isArray(base) || base instanceof Float32Array) {
    return patch as T
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const key of Object.keys(patch as Record<string, unknown>)) {
    const pv = (patch as Record<string, unknown>)[key]
    const bv = (base as Record<string, unknown>)[key]
    out[key] = deepMerge(bv as never, pv as never)
  }
  return out as T
}

export interface V3ParamsController {
  params: V3EngineParams
  /** 深合并局部修改并提交引擎（完整快照语义） */
  patch: (partial: DeepPartial<V3EngineParams>) => void
  /** 整包替换（场景/分享串/恢复默认） */
  replace: (next: V3EngineParams) => void
}

export function useV3Params(bridge: V3UiBridge): V3ParamsController {
  const [params, setParams] = useState<V3EngineParams>(() => bridge.getParams())

  const commit = useCallback((next: V3EngineParams) => {
    bridge.setParams(next)
    setParams(bridge.getParams())
  }, [bridge])

  const patch = useCallback((partial: DeepPartial<V3EngineParams>) => {
    const merged = deepMerge(bridge.getParams(), partial)
    // 手动调整参数后视为脱离场景快照（场景名显示「自定义」，模式卡不再高亮）
    merged.customized = true
    commit(merged)
  }, [bridge, commit])

  const replace = useCallback((next: V3EngineParams) => {
    commit(next)
  }, [commit])

  return { params, patch, replace }
}
