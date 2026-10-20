/**
 * WaveForge v3 调音室 UI —— 参数快照 hooks
 *
 * 参数语义（v3 引擎约定）：完整快照（V3EngineParams），setParams 每次替换整包。
 * 本 hook 提供：
 *  - params：当前快照（深拷贝展示值）
 *  - patch(partial)：深合并后提交（UI 局部修改的惯用入口）
 *  - replace(next)：整包替换（场景应用 / 分享串导入 / 恢复默认）
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { V3EngineParams } from '../src/types'
import { createDefaultParams } from '../src/types'
import type { V3UiBridge } from './bridge'

/** 递归可选（数组与 Float32Array 整体替换，不做成员递归） */
export type DeepPartial<T> = {
  [K in keyof T]?: NonNullable<T[K]> extends Float32Array | Array<unknown> ? T[K]
    : NonNullable<T[K]> extends object ? DeepPartial<NonNullable<T[K]>> : T[K]
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
  patch: (partial: DeepPartial<V3EngineParams>, options?: { markCustomized?: boolean }) => void
  /** rAF 合流版 patch：滑杆拖动（60Hz input 事件）用这个，降低整页 setState 与 JSON 序列化频率 */
  patchThrottled: (partial: DeepPartial<V3EngineParams>) => void
  /** 整包替换（场景/分享串/恢复默认） */
  replace: (next: V3EngineParams) => void
  masterEnabled: boolean
  setMasterEnabled: (enabled: boolean) => void
}

/** 旁路只暂停染色处理；输出音量与限幅保护独立保留。 */
function bypassEffects(p: V3EngineParams): V3EngineParams {
  const next = deepMerge(p, {
    eq: { enabled: false }, dynamicEq: { ...(p.dynamicEq ?? createDefaultParams(p.sampleRate).dynamicEq!), enabled: false },
    crossfeed: { ...(p.crossfeed ?? createDefaultParams(p.sampleRate).crossfeed!), enabled: false },
    deesser: { enabled: false }, compressor: { enabled: false },
    nightMode: { enabled: false }, bassEnhancer: { enabled: false }, reverb: { enabled: false },
    surround3d: { enabled: false }, loudnessCompensation: { enabled: false }, ieq: { enabled: false },
    pitch: { enabled: false, voiceBalance: 0 }, stereoWidth: 1,
    loudnessNormalization: p.loudnessNormalization.useRealtimeMeter ? { enabled: false } : {},
  })
  if (next.spatial) next.spatial = { ...next.spatial, mode: 'off' }
  return next
}

export function useV3Params(bridge: V3UiBridge): V3ParamsController {
  const [params, setParams] = useState<V3EngineParams>(() => bridge.getParams())
  const [masterEnabled, setMasterState] = useState(() => bridge.getMasterSnapshot() === null)

  useEffect(() => {
    const refresh = () => {
      setParams(bridge.getParams())
      setMasterState(bridge.getMasterSnapshot() === null)
    }
    const unsubscribe = bridge.subscribeParams?.(refresh)
    // 补读订阅建立前的最新快照；外部文件加载和另一界面编辑都只刷新展示状态。
    refresh()
    return unsubscribe
  }, [bridge])

  const commit = useCallback((next: V3EngineParams) => {
    bridge.setParams(next)
    setParams(bridge.getParams())
  }, [bridge])

  const patch = useCallback((partial: DeepPartial<V3EngineParams>, options?: { markCustomized?: boolean }) => {
    const snapshot = bridge.getMasterSnapshot()
    const volumeOnly = options?.markCustomized === false
    const current = bridge.getParams()
    // 调音时从暂停前的配置继续；音量调整不打开已关闭的音效。
    const base = snapshot && !volumeOnly
      ? { ...snapshot, loudnessNormalization: snapshot.loudnessNormalization.useRealtimeMeter
        ? snapshot.loudnessNormalization : current.loudnessNormalization }
      : current
    const merged = deepMerge(base, partial)
    // 手动调整参数后视为脱离场景快照（场景名显示「自定义」，模式卡不再高亮）
    if (!volumeOnly) {
      merged.customized = true
      bridge.setMasterSnapshot(null)
      setMasterState(true)
    } else if (snapshot) {
      bridge.setMasterSnapshot(deepMerge(snapshot, partial))
    }
    commit(merged)
  }, [bridge, commit])

  // 滑杆拖动路径：input 事件 ~60Hz 直发 commit 会让整页 setState + 5+ 次全量 JSON
  // 序列化（bridge 对比/克隆/各模块签名）——rAF 合流到每帧一次，观感无差。
  const pendingPatchRef = useRef<DeepPartial<V3EngineParams> | null>(null)
  const patchFrameRef = useRef<number | null>(null)
  const patchThrottled = useCallback((partial: DeepPartial<V3EngineParams>) => {
    pendingPatchRef.current = pendingPatchRef.current
      ? deepMerge(pendingPatchRef.current, partial)
      : partial
    if (patchFrameRef.current !== null) return
    patchFrameRef.current = requestAnimationFrame(() => {
      patchFrameRef.current = null
      const pending = pendingPatchRef.current
      if (pending) {
        pendingPatchRef.current = null
        patch(pending)
      }
    })
  }, [patch])
  useEffect(() => () => {
    if (patchFrameRef.current !== null) cancelAnimationFrame(patchFrameRef.current)
  }, [])

  const replace = useCallback((next: V3EngineParams) => {
    bridge.setMasterSnapshot(null)
    setMasterState(true)
    commit(next)
  }, [bridge, commit])

  const setMasterEnabled = useCallback((enabled: boolean) => {
    const snapshot = bridge.getMasterSnapshot()
    if (enabled && snapshot) {
      bridge.setMasterSnapshot(null)
      commit(snapshot)
    } else if (!enabled && !snapshot) {
      const current = bridge.getParams()
      bridge.setMasterSnapshot(current)
      commit(bypassEffects(current))
    }
    setMasterState(enabled)
  }, [bridge, commit])

  return { params, patch, patchThrottled, replace, masterEnabled, setMasterEnabled }
}
