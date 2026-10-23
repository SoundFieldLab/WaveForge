/**
 * layouts —— 模式 B 布局预设单元测试
 *
 * 覆盖：三预设结构与数值（stereo/51/714 方向与数量）、714 顶置层过滤与旧 bottomLayer 兼容
 * （heightLayer/bottomLayer）、headLockedSpeakers custom 原样返回/空列表回退、
 * createLayoutSpeakers 副本语义（714 的 11 只标准方向）。
 */
import { describe, it, expect } from 'vitest'
import { LAYOUT_PRESETS, createLayoutSpeakers, createMultichannelSpeakers, headLockedSpeakers } from '../layouts'
import { createDefaultSpatialParams } from '../types'
import type { HeadLockedSettings, VirtualSpeakerCfg } from '../types'

describe('layouts：布局预设表', () => {
  it('多声道输入布局保留标准输入索引，LFE 交给独立低频管理', () => {
    expect(createMultichannelSpeakers('quad').map((speaker) => speaker.channel)).toEqual([0, 1, 2, 3])
    expect(createMultichannelSpeakers('51').map((speaker) => speaker.channel)).toEqual([0, 1, 2, 3, 4, 5])
    expect(createMultichannelSpeakers('71').map((speaker) => speaker.channel)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(createMultichannelSpeakers('714').map((speaker) => speaker.channel)).toEqual(Array.from({ length: 12 }, (_, i) => i))
    for (const layout of ['51', '71', '714'] as const) expect(createMultichannelSpeakers(layout)[3].gain).toBe(0)
  })

  it('预设表含 stereo/51/514/71/714 五项，名称与 id 对应', () => {
    expect(LAYOUT_PRESETS).toHaveLength(5)
    expect(LAYOUT_PRESETS.map((p) => p.id)).toEqual(['stereo', '51', '514', '71', '714'])
    expect(LAYOUT_PRESETS.map((p) => p.name)).toEqual(['立体声', '5.1', '5.1.4', '7.1', '7.1.4'])
    for (const p of LAYOUT_PRESETS) {
      expect(p.speakers.length).toBeGreaterThan(0)
    }
    // 5.1.4 = 5 地面 + 4 顶置（9 只）；7.1 = 7 地面（无顶/底）；7.1.4 = 11 只
    expect(LAYOUT_PRESETS.find((p) => p.id === '514')!.speakers).toHaveLength(9)
    expect(LAYOUT_PRESETS.find((p) => p.id === '71')!.speakers).toHaveLength(7)
    expect(LAYOUT_PRESETS.find((p) => p.id === '714')!.speakers).toHaveLength(11)
  })

  it('stereo：L(-30)/R(+30) 两只', () => {
    const s = createLayoutSpeakers('stereo')
    expect(s).toHaveLength(2)
    expect(s[0]).toMatchObject({ azimuthDeg: -30, elevationDeg: 0 })
    expect(s[1]).toMatchObject({ azimuthDeg: 30, elevationDeg: 0 })
    for (const sp of s) {
      expect(sp.distance).toBe(1.5)
      expect(sp.gain).toBe(1)
    }
  })

  it('51：C/FL/FR/SL/SR 五方向（LFE 无方向不参与），全地面层', () => {
    const s = createLayoutSpeakers('51')
    expect(s).toHaveLength(5)
    const azs = s.map((x) => x.azimuthDeg).sort((a, b) => a - b)
    expect(azs).toEqual([-110, -30, 0, 30, 110]) // SL FL C FR SR
    for (const sp of s) {
      expect(sp.elevationDeg).toBe(0)
      expect(sp.distance).toBe(1.5)
      expect(sp.gain).toBe(1)
      expect(sp.size).toBe(0)
    }
  })

  it('714：地面 7（C/FL/FR/SL/SR/RL/RR）+ 顶置 4（仰角 45）+ 底部 2（仰角 -20）', () => {
    const s = createLayoutSpeakers('714')
    expect(s).toHaveLength(11)
    const ground = s.filter((x) => x.elevationDeg === 0)
    const tops = s.filter((x) => x.elevationDeg === 45)
    const bottoms = s.filter((x) => x.elevationDeg === -20)
    expect(ground).toHaveLength(7)
    expect(tops).toHaveLength(4)
    expect(bottoms).toHaveLength(0)
    const groundAz = ground.map((x) => x.azimuthDeg).sort((a, b) => a - b)
    expect(groundAz).toEqual([-140, -110, -30, 0, 30, 110, 140]) // RL SL FL C FR SR RR
    const topAz = tops.map((x) => x.azimuthDeg).sort((a, b) => a - b)
    expect(topAz).toEqual([-135, -45, 45, 135]) // TRL TFL TFR TRR
    const bottomAz = bottoms.map((x) => x.azimuthDeg).sort((a, b) => a - b)
    expect(bottomAz).toEqual([]) // BL BR
    for (const sp of [...tops, ...bottoms]) {
      expect(sp.distance).toBe(1.5)
      expect(sp.gain).toBe(1)
      expect(sp.size).toBe(0)
    }
  })

  it('createLayoutSpeakers 返回副本：修改结果不影响预设表', () => {
    const a = createLayoutSpeakers('51')
    const b = createLayoutSpeakers('51')
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    a[0].azimuthDeg = 999
    a[0].gain = 9
    expect(createLayoutSpeakers('51')[0].azimuthDeg).toBe(0)
    expect(createLayoutSpeakers('51')[0].gain).toBe(1)
  })
})

describe('layouts：headLockedSpeakers 解析', () => {
  const hl = (partial: Partial<HeadLockedSettings>): HeadLockedSettings => ({
    layout: '51',
    speakers: [],
    heightLayer: true,
    bottomLayer: true,
    routes: [],
    ...partial,
  })

  it('预设布局 → 预设表；714 默认 11 只，heightLayer=false 过滤顶置剩 7 只（7 地面）', () => {
    expect(headLockedSpeakers(hl({ layout: 'stereo' }))).toHaveLength(2)
    expect(headLockedSpeakers(hl({ layout: '51' }))).toHaveLength(5)
    expect(headLockedSpeakers(hl({ layout: '714' }))).toHaveLength(11)
    const noTop = headLockedSpeakers(hl({ layout: '714', heightLayer: false }))
    expect(noTop).toHaveLength(7)
    expect(noTop.some((s) => s.elevationDeg === 45)).toBe(false) // 无顶置
    expect(noTop.filter((s) => s.elevationDeg === -20)).toHaveLength(0) // 标准布局不含底部
  })

  it('预设结果与存储的 speakers 无关（预设渲染走预设表）', () => {
    // 即使旧持久化残留了自定义列表，预设布局仍取预设表
    const s = headLockedSpeakers(
      hl({ layout: '51', speakers: [{ azimuthDeg: -10, elevationDeg: 5, distance: 3, gain: 2, size: 0 }] }),
    )
    expect(s).toHaveLength(5)
    expect(s.every((x) => x.azimuthDeg !== -10)).toBe(true)
  })

  it('custom → 原样返回 p.speakers（含自定义值）', () => {
    const custom: VirtualSpeakerCfg[] = [
      { azimuthDeg: -45, elevationDeg: 10, distance: 3, gain: 0.8, size: 0 },
      { azimuthDeg: 45, elevationDeg: -10, distance: 2, gain: 1.2, size: 0.5 },
    ]
    const r = headLockedSpeakers(hl({ layout: 'custom', speakers: custom }))
    expect(r).toEqual(custom)
  })

  it('custom 空列表 → 回退 51 预设（5 只）', () => {
    const fb = headLockedSpeakers(hl({ layout: 'custom', speakers: [] }))
    expect(fb).toHaveLength(5)
    expect(fb.map((x) => x.azimuthDeg).sort((a, b) => a - b)).toEqual([-110, -30, 0, 30, 110])
  })

  it('默认 headLocked 的 routes 为空数组（缺省 = 全按方位角就近路由）', () => {
    const d = createDefaultSpatialParams()
    expect(d.headLocked.routes).toEqual([])
  })

  it('防御：routes 长度不足/超长不抛（解析不依赖 routes 长度）', () => {
    // 模拟旧持久化数据（routes 缺失由 hl 默认补 [] 或长度不足）：解析不抛
    const short = hl({ layout: '51', routes: ['l'] })
    expect(() => headLockedSpeakers(short)).not.toThrow()
    expect(headLockedSpeakers(short)).toHaveLength(5)
    // 超长：11 只布局塞 12 条路由 → 截断语义由融合层负责，此处不抛
    const long = hl({
      layout: '714',
      routes: ['l', 'r', 'both', 'l', 'r', 'both', 'l', 'r', 'both', 'l', 'r', 'both'],
    })
    expect(() => headLockedSpeakers(long)).not.toThrow()
    expect(headLockedSpeakers(long)).toHaveLength(11)
  })

  it('旧 bottomLayer=false 不改变标准 714 的 11 只扬声器', () => {
    const noBottom = headLockedSpeakers(hl({ layout: '714', bottomLayer: false }))
    expect(noBottom).toHaveLength(11)
    expect(noBottom.filter((s) => s.elevationDeg === -20)).toHaveLength(0)
    expect(noBottom.filter((s) => s.elevationDeg === 45)).toHaveLength(4)
    expect(noBottom.filter((s) => s.elevationDeg === 0)).toHaveLength(7)
  })

  it('714 全关（heightLayer=false + bottomLayer=false）剩 7 地面', () => {
    const noLayers = headLockedSpeakers(hl({ layout: '714', heightLayer: false, bottomLayer: false }))
    expect(noLayers).toHaveLength(7)
    expect(noLayers.every((s) => s.elevationDeg === 0)).toBe(true)
  })

  it('stereo/51 无仰角层：bottomLayer 不影响（无底部扬声器可过滤）', () => {
    expect(headLockedSpeakers(hl({ layout: 'stereo', bottomLayer: false }))).toHaveLength(2)
    expect(headLockedSpeakers(hl({ layout: '51', bottomLayer: false }))).toHaveLength(5)
    // bottomLayer=true 同样无底部（预设本就不含）
    expect(headLockedSpeakers(hl({ layout: 'stereo' })).filter((s) => s.elevationDeg < 0)).toHaveLength(0)
    expect(headLockedSpeakers(hl({ layout: '51' })).filter((s) => s.elevationDeg < 0)).toHaveLength(0)
  })

  it('标准 714 仅有 7 地面和 4 顶置，保留独立副本', () => {
    const s = createLayoutSpeakers('714')
    expect(s).toHaveLength(11)
    const bottoms = s.filter((x) => x.elevationDeg === -20)
    expect(bottoms).toHaveLength(0)
    expect(bottoms.map((x) => x.azimuthDeg)).toEqual([])
    // 副本语义：修改顶置层结果不影响预设表（回归既有断言）
    const a = createLayoutSpeakers('714')
    const b = createLayoutSpeakers('714')
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    a[10].azimuthDeg = 999
    expect(createLayoutSpeakers('714')[10].azimuthDeg).toBe(135)
  })

  it('默认 headLocked 快照含 bottomLayer:true（与 heightLayer 并列，714 默认全开）', () => {
    const d = createDefaultSpatialParams()
    expect(d.headLocked.bottomLayer).toBe(true)
    expect(d.headLocked.heightLayer).toBe(true)
  })
})
