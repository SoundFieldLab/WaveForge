/**
 * HSE 场景数据存储 —— 内置场景参数覆盖层 + 场景库导入导出
 *
 * 职责：
 *  - 内置 11 场景的「开发者微调」持久化：编辑后的完整参数快照存 localStorage
 *    （waveforge:v3-scene-overrides），读取时覆盖 SCENE_PRESETS 的代码默认值；
 *  - 入库前清洗：剥离实时音量通道（loudnessNormalization，快照不得固化用户音量）、
 *    清空卷积 IR 数据（irName 引用语义）；
 *  - 场景库整体导出/导入 JSON（内置覆盖 + 我的场景），便于备份迁移。
 */

import type { ScenePreset, V3EngineParams } from '../src/types'
import { createDefaultParams } from '../src/types'
import { SCENE_PRESETS } from '../src/engine/ScenePresets'
import { BUILTIN_SCENE_SEED, type BuiltinSceneSeed } from '../src/engine/builtinSceneSeed'

/** 内置场景覆盖存储键 */
const SCENE_OVERRIDES_KEY = 'waveforge:v3-scene-overrides'
/** 开发者模式开关存储键 */
export const HSE_DEV_MODE_KEY = 'waveforge:hse-dev-mode'
/** 开发者模式变化事件（跨页面同步 UI 状态用） */
export const HSE_DEV_MODE_EVENT = 'hse-dev-mode-changed'

/** 场景库导出格式版本 */
const LIBRARY_VERSION = 1

// ---------------------------------------------------------------------------
// 开发者模式开关
// ---------------------------------------------------------------------------

export function isDevMode(): boolean {
  try {
    return localStorage.getItem(HSE_DEV_MODE_KEY) === '1'
  } catch {
    return false
  }
}

export function setDevMode(on: boolean): void {
  try {
    if (on) localStorage.setItem(HSE_DEV_MODE_KEY, '1')
    else localStorage.removeItem(HSE_DEV_MODE_KEY)
  } catch {
    // 存储不可用时静默
  }
  window.dispatchEvent(new CustomEvent(HSE_DEV_MODE_EVENT, { detail: { enabled: on } }))
}

// ---------------------------------------------------------------------------
// 内置场景覆盖层
// ---------------------------------------------------------------------------

/** 入库清洗：去 IR、还原实时音量通道为出厂默认、固定场景归属标记 */
function sanitizeOverrideSnapshot(id: string, p: V3EngineParams): V3EngineParams {
  const clone = JSON.parse(JSON.stringify(p)) as V3EngineParams
  clone.reverb.convolution.ir = null
  // 音量控制是实时控制（externalGainDb 滑杆走此通道），不得写进预设；
  // 整段响度归一化恢复出厂默认，与 ScenePresets 里 base() 的语义一致
  const fs = typeof clone.sampleRate === 'number' && clone.sampleRate > 0 ? clone.sampleRate : 48000
  clone.loudnessNormalization = createDefaultParams(fs).loudnessNormalization
  clone.sceneId = id
  clone.customized = false
  return clone
}

function loadOverridesRaw(): Record<string, V3EngineParams> {
  return effectiveOverrideMap()
}

/** 本地存储束（含基线 revision；兼容首版无 rev 的扁平结构，视为 rev 0 永远让位官方） */
interface StoredBundle {
  rev: number
  overrides: Record<string, V3EngineParams>
}

function readStoredBundle(): StoredBundle | null {
  try {
    const raw = localStorage.getItem(SCENE_OVERRIDES_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as { overrides?: unknown; rev?: unknown } & Record<string, unknown>
    if (!parsed || typeof parsed !== 'object') return null
    if ('overrides' in parsed && parsed.overrides && typeof parsed.overrides === 'object') {
      const rev = typeof parsed.rev === 'number' && Number.isFinite(parsed.rev) ? parsed.rev : 0
      return { rev, overrides: parsed.overrides as Record<string, V3EngineParams> }
    }
    // 首版扁平结构（id → params）：当 rev 0 处理
    return { rev: 0, overrides: parsed as Record<string, V3EngineParams> }
  } catch {
    return null
  }
}

function writeStoredBundle(bundle: StoredBundle): void {
  try {
    localStorage.setItem(SCENE_OVERRIDES_KEY, JSON.stringify(bundle))
  } catch {
    // 存储不可用时静默（不影响播放）
  }
}

/**
 * 官方更新采纳规则（纯函数，供单测）：
 *  - 本地记录的 rev >= 种子 revision → 个人微调基于当前/更新基线，压在种子之上生效；
 *  - 本地 rev < 种子 revision → 种子是升级安装带来的官方更新，个人旧微调整体让位。
 */
export function resolveRevisionAdoption(stored: StoredBundle | null, seed: BuiltinSceneSeed): StoredBundle {
  if (stored && stored.rev >= seed.revision) return stored
  return { rev: seed.revision, overrides: {} }
}

/** 有效覆盖层 = 发布种子（committed 随包分发）⊕ 本地微调（revision 规则裁决） */
function effectiveOverrideMap(): Record<string, V3EngineParams> {
  const adopted = resolveRevisionAdoption(readStoredBundle(), sanitizeSeed(BUILTIN_SCENE_SEED))
  return filterPresetIds(adopted.overrides)
}

function sanitizeSeed(seed: BuiltinSceneSeed): BuiltinSceneSeed {
  if (!seed || typeof seed !== 'object') return { revision: 0, overrides: {} }
  return {
    revision: typeof seed.revision === 'number' && Number.isFinite(seed.revision) ? seed.revision : 0,
    overrides: seed.overrides && typeof seed.overrides === 'object' ? seed.overrides : {},
  }
}

function filterPresetIds(map: Record<string, unknown>): Record<string, V3EngineParams> {
  const out: Record<string, V3EngineParams> = {}
  for (const [id, v] of Object.entries(map)) {
    if (typeof id !== 'string' || !SCENE_PRESETS.some((s) => s.id === id)) continue
    if (!v || typeof v !== 'object') continue
    out[id] = sanitizeOverrideSnapshot(id, v as V3EngineParams)
  }
  return out
}

/** 写入本地微调束（rev 记录当前种子基线，供官方更新采纳规则裁决） */
function writeLocalOverrides(map: Record<string, V3EngineParams>): void {
  const seedRev = sanitizeSeed(BUILTIN_SCENE_SEED).revision
  const bundle: StoredBundle = { rev: seedRev, overrides: map }
  try {
    localStorage.setItem(SCENE_OVERRIDES_KEY, JSON.stringify(bundle))
  } catch {
    // 存储不可用时静默（不影响播放）
  }
}

/** 全部覆盖（id → 参数快照） */
export function loadSceneOverrides(): Record<string, V3EngineParams> {
  return loadOverridesRaw()
}

export function getSceneOverride(id: string): V3EngineParams | null {
  return loadOverridesRaw()[id] ?? null
}

/** 保存内置场景微调（存的是清洗后的完整快照；落盘即生效，重启/开关开发者模式后仍在） */
export function saveBuiltinSceneOverride(id: string, params: V3EngineParams): boolean {
  if (!SCENE_PRESETS.some((s) => s.id === id)) return false
  const map = loadOverridesRaw()
  map[id] = sanitizeOverrideSnapshot(id, params)
  writeLocalOverrides(map)
  return true
}

/** 还原某内置场景为「当前官方默认」：只删本地微调层；若发布种子带默认值则以种子为准 */
export function resetBuiltinSceneOverride(id: string): void {
  const stored = readStoredBundle()
  if (!stored || !(id in stored.overrides)) return
  delete stored.overrides[id]
  writeLocalOverrides(stored.overrides)
}

/** 是否有任何内置场景被改过 */
export function hasAnyOverride(): boolean {
  return Object.keys(loadOverridesRaw()).length > 0
}

/**
 * 合并覆盖到内置场景列表（返回新数组，不改动 SCENE_PRESETS 原对象）。
 * 被 微调 过的场景带 overridden 标记。
 */
export function mergeBuiltinScenes(): (ScenePreset & { overridden?: boolean })[] {
  const overrides = loadOverridesRaw()
  return SCENE_PRESETS.map((sc) => {
    const ov = overrides[sc.id]
    return ov ? { ...sc, params: ov, overridden: true } : sc
  })
}

// ---------------------------------------------------------------------------
// 场景库导出 / 导入
// ---------------------------------------------------------------------------

interface LibraryFile {
  version: number
  exportedAt: string
  builtinOverrides: Record<string, V3EngineParams>
  myScenes: ScenePreset[]
}

/** 导出整个场景库（内置覆盖 + 我的场景）为 JSON 字符串 */
export function exportSceneLibraryJson(myScenes: ScenePreset[]): string {
  // 我的场景保留自身 sceneId/customized 语义（sceneId=null、customized=true），只做通用清洗
  const cleanedMy = myScenes.map((s) => {
    const clone = JSON.parse(JSON.stringify(s)) as ScenePreset
    clone.params.reverb.convolution.ir = null
    const fs = typeof clone.params.sampleRate === 'number' && clone.params.sampleRate > 0 ? clone.params.sampleRate : 48000
    clone.params.loudnessNormalization = createDefaultParams(fs).loudnessNormalization
    return clone
  })
  const file: LibraryFile = {
    version: LIBRARY_VERSION,
    exportedAt: new Date().toISOString(),
    builtinOverrides: loadOverridesRaw(),
    myScenes: cleanedMy,
  }
  return JSON.stringify(file, null, 2)
}

/** 导入场景库；返回各部分写入数量。非法文件抛 Error。 */
export function importSceneLibraryJson(
  json: string,
  replaceMyScenes: (list: ScenePreset[]) => void,
): { overrides: number; myScenes: number } {
  let file: LibraryFile
  try {
    file = JSON.parse(json) as LibraryFile
  } catch {
    throw new Error('不是合法的 JSON 文件')
  }
  if (!file || typeof file !== 'object' || !file.builtinOverrides || !Array.isArray(file.myScenes)) {
    throw new Error('缺少场景库必需字段（builtinOverrides/myScenes）')
  }
  const validIds = new Set(SCENE_PRESETS.map((s) => s.id))
  const overrides: Record<string, V3EngineParams> = {}
  for (const [id, v] of Object.entries(file.builtinOverrides)) {
    if (validIds.has(id) && v && typeof v === 'object') {
      overrides[id] = sanitizeOverrideSnapshot(id, v as V3EngineParams)
    }
  }
  const myScenes = file.myScenes.filter((s) => s && typeof s.id === 'string' && typeof s.name === 'string' && s.params)
  writeLocalOverrides(overrides)
  replaceMyScenes(myScenes)
  return { overrides: Object.keys(overrides).length, myScenes: myScenes.length }
}

// ---------------------------------------------------------------------------
// 发布种子导出（开发者 → commit/push → 所有用户）
// ---------------------------------------------------------------------------

/** 组装发布种子内容：revision 必进位，保证已装机的旧个人微调会被新官方默认取代 */
export function buildPublishSeed(): BuiltinSceneSeed {
  const seed = sanitizeSeed(BUILTIN_SCENE_SEED)
  const stored = readStoredBundle()
  const base = Math.max(seed.revision, stored && Number.isFinite(stored.rev) ? stored.rev : 0)
  return { revision: base + 1, overrides: effectiveOverrideMap() }
}

/** 导出可直接替换 builtinSceneSeed.ts 的 TypeScript 源码文本 */
export function exportPublishSeedTs(): string {
  const payload = buildPublishSeed()
  return [
    '/**',
    ' * HSE 内置场景「发布默认」覆盖层 —— 种子文件（由 HSE 开发者模式自动导出）',
    ' * 用法：整文件替换 src/services/waveforge-engine-v3/src/engine/builtinSceneSeed.ts，',
    ' *       之后 commit/push 打包发布——所有用户（含作者本机）即以本文件的参数为准。',
    ` * 导出时间：${new Date().toISOString()}；revision=${payload.revision}（每次导出自动 +1，`,
    ' *           老用户升级后其旧的个人微调会按 revision 规则让位于本文件的官方调优）。',
    ' */',
    '',
    `export const BUILTIN_SCENE_SEED = ${JSON.stringify(payload, null, 2)}`,
    '',
  ].join('\n')
}
