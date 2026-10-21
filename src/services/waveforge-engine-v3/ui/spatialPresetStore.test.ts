import { beforeEach, describe, expect, it } from 'vitest'
import { createDefaultSpatialSettings } from '../src/types'
import { deleteSpatialPreset, loadSpatialPresets, saveSpatialPreset } from './spatialPresetStore'

describe('空间方案本地存储', () => {
  beforeEach(() => localStorage.clear())

  it('保存、按最新排序读取并深拷贝设置', () => {
    const first = createDefaultSpatialSettings()
    first.mode = 'headLocked'
    first.headLocked.layout = '51'
    const second = createDefaultSpatialSettings()
    second.mode = 'headLocked'
    second.headLocked.layout = '714'

    saveSpatialPreset('5.1 方案', first)
    const saved = saveSpatialPreset('沉浸 7.1.4', second)
    expect(saved.map((preset) => preset.name)).toEqual(['沉浸 7.1.4', '5.1 方案'])
    expect(loadSpatialPresets()).toHaveLength(2)

    // 保存后修改原对象不应污染快照。
    second.headLocked.layout = 'stereo'
    expect(loadSpatialPresets()[0].settings.headLocked.layout).toBe('714')
  })

  it('删除指定方案；损坏 JSON 按空列表处理', () => {
    const preset = saveSpatialPreset('待删除', createDefaultSpatialSettings())[0]
    expect(deleteSpatialPreset(preset.id)).toHaveLength(0)
    localStorage.setItem('waveforge:hse-spatial-presets', '{broken')
    expect(loadSpatialPresets()).toEqual([])
  })
})
