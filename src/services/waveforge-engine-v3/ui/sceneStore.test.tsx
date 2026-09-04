/**
 * HSE 场景数据存储测试（jsdom，localStorage 可用）
 *
 * 覆盖开发者模式三条硬性保证：
 *  1. 微调保存后即持久化——「重启」（重新从 localStorage 读）后仍然生效；
 *  2. 发布种子语义：revision 更高时官方默认压过用户机器上的旧微调（升级覆盖路径）；
 *  3. 入库清洗：预设快照不固化音量通道、不含 IR 数据、sceneId 锁定。
 */

// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadSceneOverrides,
  saveBuiltinSceneOverride,
  resetBuiltinSceneOverride,
  mergeBuiltinScenes,
  resolveRevisionAdoption,
  buildPublishSeed,
  exportPublishSeedTs,
  importSceneLibraryJson,
} from './sceneStore'
import { BUILTIN_SCENE_SEED } from '../src/engine/builtinSceneSeed'
import { SCENE_PRESETS } from '../src/engine/ScenePresets'
import { createDefaultParams } from '../src/types'

const OVERRIDES_KEY = 'waveforge:v3-scene-overrides'
const MY_SCENES_KEY = 'waveforge:v3-my-scenes'

function tweak(id: string): ReturnType<typeof createDefaultParams> {
  const p = createDefaultParams(48000)
  p.compressor.thresholdDb = -42
  void id
  return p
}

beforeEach(() => {
  localStorage.clear()
})

describe('sceneStore · 本地微调持久化（需求①：保存后重启仍是上次保存的）', () => {
  it('保存后立即生效：merge 标记 overridden 且参数即为所存', () => {
    expect(saveBuiltinSceneOverride('pop', tweak('pop'))).toBe(true)
    const merged = mergeBuiltinScenes()
    const pop = merged.find((s) => s.id === 'pop')!
    expect(pop.overridden).toBe(true)
    expect(pop.params.compressor.thresholdDb).toBe(-42)
    expect(pop.params.sceneId).toBe('pop')
    expect(pop.params.customized).toBe(false)
  })

  it('"重启"（清空运行态重读存储）后仍为上一次保存的值', () => {
    saveBuiltinSceneOverride('warm', tweak('warm'))
    // 模拟重启：不经过任何内存缓存，直接再读 localStorage 驱动的合并结果
    const again = mergeBuiltinScenes().find((s) => s.id === 'warm')!
    expect(again.overridden).toBe(true)
    expect(again.params.compressor.thresholdDb).toBe(-42)
  })

  it('还原出厂后不再标记 overridden，回落到代码默认', () => {
    saveBuiltinSceneOverride('jazz', tweak('jazz'))
    resetBuiltinSceneOverride('jazz')
    const jazz = mergeBuiltinScenes().find((s) => s.id === 'jazz')!
    expect(jazz.overridden).toBeUndefined()
    expect(jazz.params).toBe(SCENE_PRESETS.find((s) => s.id === 'jazz')!.params)
  })

  it('仅内置场景可保存；未知 id 拒绝', () => {
    expect(saveBuiltinSceneOverride('my-ghost', tweak('pop'))).toBe(false)
  })
})

describe('sceneStore · 发布种子与升级覆盖（需求②④：commit 分发全员生效；新官方压旧微调）', () => {
  it('revision 规则：本地基线>=种子 → 个人微调生效；<种子 → 让位官方更新', () => {
    const personal = { rev: 2, overrides: { pop: {} as never } }
    expect(resolveRevisionAdoption(personal, { revision: 2, overrides: {} }).overrides.pop).toBeDefined()
    const yielded = resolveRevisionAdoption({ rev: 1, overrides: { pop: {} as never } }, { revision: 5, overrides: {} })
    expect(yielded.rev).toBe(5)
    expect(yielded.overrides.pop).toBeUndefined()
    expect(resolveRevisionAdoption(null, { revision: 0, overrides: {} }).rev).toBe(0)
  })

  it('导出发布种子 revision 自动 +1，且包含当前生效的全部覆盖', () => {
    saveBuiltinSceneOverride('pop', tweak('pop'))
    saveBuiltinSceneOverride('dance', tweak('dance'))
    const seed = buildPublishSeed()
    expect(seed.revision).toBe(BUILTIN_SCENE_SEED.revision + 1)
    expect(Object.keys(seed.overrides).sort()).toEqual(['dance', 'pop'])
  })

  it('发布种子文本可整文件替换 builtinSceneSeed.ts（含头注释与赋值语句）', () => {
    saveBuiltinSceneOverride('studio', tweak('studio'))
    const ts = exportPublishSeedTs()
    expect(ts).toContain('export const BUILTIN_SCENE_SEED')
    expect(ts).toContain('"studio"')
    expect(ts.trimEnd().endsWith('}')).toBe(true)
  })

  it('场景库导入按本地层落盘并可再次读出（备份/迁移往返）', () => {
    saveBuiltinSceneOverride('pop', tweak('pop'))
    const json = JSON.stringify({
      version: 1,
      exportedAt: new Date().toISOString(),
      builtinOverrides: { warm: createDefaultParams(48000) },
      myScenes: [{ id: 'my-1', name: '我的', builtin: false, params: createDefaultParams(48000) }],
    })
    localStorage.removeItem(OVERRIDES_KEY)
    const counts = importSceneLibraryJson(json, (list) => {
      // 与 bridge.saveMyScenes 相同的落盘行为
      localStorage.setItem(MY_SCENES_KEY, JSON.stringify(list))
    })
    expect(counts.overrides).toBe(1)
    expect(counts.myScenes).toBe(1)
    expect(localStorage.getItem(MY_SCENES_KEY)).toContain('my-1')
    expect('warm' in loadSceneOverrides()).toBe(true)
  })
})

describe('sceneStore · 入库清洗（预设不得固化用户音量）', () => {
  it('保存时剥离 externalGainDb 等实时音量状态、清空卷积 IR', () => {
    const dirty = createDefaultParams(48000)
    dirty.loudnessNormalization.externalGainDb = -7.25
    dirty.loudnessNormalization.enabled = true
    dirty.reverb.convolution.ir = new Float32Array(64)
    dirty.reverb.convolution.irName = 'hall-x'
    dirty.customized = true

    saveBuiltinSceneOverride('classical', dirty)
    const stored = JSON.parse(localStorage.getItem(OVERRIDES_KEY)!) as {
      rev: number
      overrides: Record<string, { loudnessNormalization: { externalGainDb: number; enabled: boolean }; reverb: { convolution: { ir: unknown; irName: string | null }; enabled?: boolean }; customized: boolean }>
    }
    const saved = stored.overrides.classical
    expect(saved.loudnessNormalization.externalGainDb).toBe(0)
    expect(saved.loudnessNormalization.enabled).toBe(false)
    expect(saved.reverb.convolution.ir).toBeNull() // irName 引用语义保留亦可，IR 数据必须为空
    expect(saved.customized).toBe(false)
    expect(stored.rev).toBe(BUILTIN_SCENE_SEED.revision)
  })

  it('首版扁平结构（无 rev 字段）按 rev=0 兼容读取，不抛错', () => {
    const legacy: Record<string, unknown> = {}
    legacy.dance = createDefaultParams(48000)
    legacy['__bad_id__'] = { junk: true }
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(legacy))
    const map = loadSceneOverrides()
    expect('dance' in map).toBe(true)
    expect('__bad_id__' in map).toBe(false)
  })
})
