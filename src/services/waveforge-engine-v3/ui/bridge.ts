/**
 * WaveForge v3 调音室 UI —— 引擎桥（V3UiBridge）
 *
 * UI 只依赖本文件的桥接口（不直接 import EngineV3），融合时把桥接实现换到
 * WaveForge 侧（引擎实例来自 EngineV3Host.engine 或直接 new EngineV3）即可。
 *
 * 桥职责：
 *  - 参数快照读写（setParams 每次收完整快照）；
 *  - 引擎统计/分析读取（LUFS、频谱、特征）；
 *  - 场景：内置 11 场景 + 我的场景（localStorage 持久化，快照去 IR 数据）；
 *  - 分享串：encode/decode（版本+校验+白名单，非法输入抛错）；
 *  - 听力测试状态机（HearingTest 封装）。
 */

import type { EngineAnalysis, EngineStats, ScenePreset, V3EngineParams } from '../src/types'
import { createDefaultParams } from '../src/types'
import { EngineV3 } from '../src/engine/EngineV3'
import {
  mergeBuiltinScenes,
  saveBuiltinSceneOverride,
  resetBuiltinSceneOverride,
  exportSceneLibraryJson,
  importSceneLibraryJson,
  exportPublishSeedTs,
} from './sceneStore'
import { encodeShareCode, decodeShareCode } from '../src/engine/ShareCodec'
import { HearingTest, type AudiogramPoint } from '../src/analysis/HearingTest'
import type { HrtfGrid } from '../src/spatial/types'
import type { HeadPose } from '../src/spatial/HeadPose'

/** 我的场景存储键（v3 独立命名空间，与 v2 区分） */
const MY_SCENES_KEY = 'waveforge:v3-my-scenes'
/** 我的场景上限（v3 独立命名空间，较 v2 的 8 提升至 20） */
export const MAX_MY_SCENES = 20

export interface V3HearingSession {
  /** 当前待测步骤；null=未开始或已完成 */
  step: { freqHz: number; levelDb: number } | null
  /** 进度：当前频点序号（0-6）/ 频点内轮数（0-4），共 7 频点 × 5 轮 */
  freqIndex: number
  round: number
  done: boolean
  audiogram: AudiogramPoint[]
}

export interface V3UiBridge {
  setSpatialHrtf?(grid: HrtfGrid | null): void
  getSpatialHrtfSource?(): string
  setSpatialHeadPose?(pose: HeadPose | null): void
  /** 当前参数快照（深拷贝，防止外部突变） */
  getParams(): V3EngineParams
  /** 设置完整快照（引擎 setParams；UI 侧始终传 getParams 深拷贝修改后的版本） */
  setParams(p: V3EngineParams): void
  /** 宿主或其他界面修改参数后通知 UI；订阅者只读取状态，不重新提交参数。 */
  subscribeParams?(listener: () => void): () => void
  /** 总开关关闭前的配置；与正在输出的旁路参数分别保存。 */
  getMasterSnapshot(): V3EngineParams | null
  setMasterSnapshot(p: V3EngineParams | null): void
  /** 融合宿主提供持久化反馈；独立桥仅将参数应用于当前会话。 */
  getSaveState?(): 'saved' | 'pending' | 'error'
  subscribeSaveState?(listener: () => void): () => void
  saveNow?(): boolean
  getStats(): EngineStats
  getAnalysis(): EngineAnalysis
  /** Recent left/right time-domain samples; null when the engine graph is not attached. */
  getWaveform?(): { left: Float32Array; right: Float32Array | null } | null
  getLatencySamples(): number
  getSampleRate(): number
  /** 内置 11 场景（含开发者微调覆盖，被改过的带 overridden 标记）+ 我的场景 */
  getScenes(): (ScenePreset & { overridden?: boolean })[]
  applyScene(id: string): void
  saveMyScene(name: string): boolean
  deleteMyScene(id: string): void
  /** 开发者模式：把完整参数快照存为某内置场景的微调覆盖（localStorage 持久化） */
  updateBuiltinScene(id: string, p: V3EngineParams): boolean
  /** 开发者模式：还原内置场景为代码默认值（删除覆盖层） */
  resetBuiltinScene(id: string): void
  /** 导出场景库 JSON（内置覆盖 + 我的场景），备份/迁移用 */
  exportSceneLibrary(): string
  /** 导入场景库 JSON；非法输入抛 Error，返回写入数量 */
  importSceneLibrary(json: string): { overrides: number; myScenes: number }
  /** 导出「发布种子」TS 源码文本：替换 builtinSceneSeed.ts 后 commit/push 即全员生效 */
  exportPublishSeed(): string
  /** 导出分享串（完整参数快照，含版本+校验） */
  encodeShare(p: V3EngineParams): string
  /** 解析分享串；非法输入抛 Error */
  decodeShare(code: string): V3EngineParams
  /** 听力测试 */
  beginHearing(): void
  hearingStep(): V3HearingSession
  answerHearing(heard: boolean): V3HearingSession
  resetHearing(): void
}

/** 快照入库前去除不可序列化数据（卷积 IR 数组 → irName 引用语义） */
function sanitizeForStorage(p: V3EngineParams): V3EngineParams {
  return JSON.parse(JSON.stringify({
    ...p,
    reverb: { ...p.reverb, convolution: { ...p.reverb.convolution, ir: null } },
  })) as V3EngineParams
}

/** 运行时参数保留 IR 类型与引用；常规字段仍隔离 UI 的可变对象。 */
function cloneRuntimeParams(p: V3EngineParams): V3EngineParams {
  const clone = sanitizeForStorage(p)
  clone.reverb.convolution.ir = p.reverb.convolution.ir
  return clone
}

function loadMyScenes(): ScenePreset[] {
  try {
    const raw = localStorage.getItem(MY_SCENES_KEY)
    if (!raw) return []
    const list = JSON.parse(raw) as ScenePreset[]
    return Array.isArray(list) ? list.filter((s) => s && typeof s.id === 'string') : []
  } catch {
    return []
  }
}

function saveMyScenes(list: ScenePreset[]): void {
  try {
    localStorage.setItem(MY_SCENES_KEY, JSON.stringify(list))
  } catch {
    throw new Error('无法写入本地存储')
  }
}

/** 桥的可选融合钩子（不传时行为与独立桥完全一致）。 */
export interface V3UiBridgeOptions {
  /**
   * 参数提交钩子：桥完成内部快照更新（cloneRuntimeParams）与 engine.setParams 之后调用。
   *
   * 融合层在这里承载所有「提交后」副作用：worklet/宿主参数下发、持久化、
   * 变速变调前置链同步等；钩子可以对传入快照做就地修订（例如注入当前曲目的
   * ReplayGain 增益）——修订后的对象就是桥之后 getParams() 读到的当前快照。
   * applyScene 内部同样走 setParams，因此场景切换自动经过同一路径，
   * 不会绕过宿主下发与持久化。
   */
  submit?: (p: V3EngineParams) => void
}

/** 把 EngineV3 包装成 UI 桥（融合时在 WaveForge 侧调用） */
export function createV3UiBridge(engine: EngineV3, sampleRate: number, options?: V3UiBridgeOptions): V3UiBridge {
  const hearing = new HearingTest(sampleRate)
  let current: V3EngineParams = createDefaultParams(sampleRate)
  let masterSnapshot: V3EngineParams | null = null
  engine.setParams(current)

  /**
   * 唯一的参数提交路径（setParams / applyScene / 外部 replace 都走这里）：
   * 先克隆成桥内快照 → 交给引擎 → 再通知融合层钩子。
   * 不再有第二条「直接调 engine.setParams」的旁路。
   */
  const commitParams = (p: V3EngineParams): void => {
    current = cloneRuntimeParams(p)
    engine.setParams(current)
    options?.submit?.(current)
  }

  const readHearing = (): V3HearingSession => {
    const step = hearing.nextStep()
    return {
      step,
      freqIndex: hearing.getFreqIndex(),
      round: hearing.getRound(),
      done: hearing.isDone(),
      audiogram: hearing.getAudiogram(),
    }
  }

  const impl: V3UiBridge = {
    getParams: () => cloneRuntimeParams(current),
    getMasterSnapshot: () => masterSnapshot ? structuredClone(masterSnapshot) : null,
    setMasterSnapshot: (p) => { masterSnapshot = p ? structuredClone(p) : null },
    setParams: (p: V3EngineParams) => commitParams(p),
    getStats: () => engine.getStats(),
    setSpatialHrtf: grid => engine.setSpatialHrtf(grid),
    getSpatialHrtfSource: () => engine.getSpatialHrtfSource(),
    setSpatialHeadPose: pose => engine.setSpatialHeadPose(pose),
    getAnalysis: () => engine.getAnalysis(),
    getLatencySamples: () => engine.getLatencySamples(),
    getSampleRate: () => sampleRate,
    getScenes: () => [...mergeBuiltinScenes(), ...loadMyScenes()],
    applyScene: (id: string) => {
      const scene = mergeBuiltinScenes().find((s) => s.id === id) ?? loadMyScenes().find((s) => s.id === id)
      if (!scene) return
      // 音量控制是实时控制，独立于场景预设/组合：应用场景时保留当前响度归一化
      // 状态（外部增益/归一化模式），场景快照不得重置用户音量
      const ln = current.loudnessNormalization
      impl.setParams(scene.params)
      impl.setParams({ ...current, sceneId: scene.id, customized: false, loudnessNormalization: ln })
    },
    saveMyScene: (name: string): boolean => {
      const mine = loadMyScenes()
      if (mine.length >= MAX_MY_SCENES) return false
      const snapshot = sanitizeForStorage(current)
      snapshot.sceneId = null
      snapshot.customized = true
      const scene: ScenePreset = {
        id: `my-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        name,
        builtin: false,
        params: snapshot,
      }
      mine.push(scene)
      saveMyScenes(mine)
      return true
    },
    deleteMyScene: (id: string) => {
      saveMyScenes(loadMyScenes().filter((s) => s.id !== id))
    },
    updateBuiltinScene: (id: string, p: V3EngineParams): boolean => saveBuiltinSceneOverride(id, p),
    resetBuiltinScene: (id: string) => {
      resetBuiltinSceneOverride(id)
    },
    exportSceneLibrary: () => exportSceneLibraryJson(loadMyScenes()),
    importSceneLibrary: (json: string) => importSceneLibraryJson(json, (list) => {
      saveMyScenes(list)
    }),
    exportPublishSeed: () => exportPublishSeedTs(),
    encodeShare: (p: V3EngineParams) => encodeShareCode(p),
    decodeShare: (code: string) => decodeShareCode(code),
    beginHearing: () => hearing.begin(),
    hearingStep: () => readHearing(),
    answerHearing: (heard: boolean) => {
      hearing.answer(heard)
      return readHearing()
    },
    resetHearing: () => hearing.reset(),
  }
  return impl
}
