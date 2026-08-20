/**
 * worldControl 键盘映射纯函数单测（node 环境，无 DOM）
 *
 * 注意：文件用 .tsx 后缀是因为 vitest.config.ts 对 ui/ 目录只收集
 * `ui/**\/*.test.tsx`（纯逻辑测试无需 jsdom，环境沿用全局 node）。
 * 覆盖：4 个水平方向 + Q/E 升降 + yaw 旋转对方向的影响 + 斜向归一化 +
 * 无按键零向量 + 转头增量 + 声源名映射 + 自定义 keymap（§5.6：partial 覆盖/
 * 大写键命中/4 方向全重绑/斜向不回归/转头不受影响）+ DEFAULT_KEYMAP 缺省回归。
 */
import { describe, expect, it } from 'vitest'
import {
  computeMoveDelta,
  computeYawDelta,
  DEFAULT_KEYMAP,
  MAX_FRAME_DT,
  YAW_ROTATE_SPEED_DEG,
  nextSourceIndex,
  sourceName,
} from './worldControl'
import type { KeyMap } from './worldControl'

const keys = (...ks: string[]): Set<string> => new Set(ks)

describe('computeMoveDelta', () => {
  it('无按键 → 零向量', () => {
    expect(computeMoveDelta(new Set(), 0, 2, 0.016)).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('W：yaw=0 时沿世界 +Z 前进', () => {
    expect(computeMoveDelta(keys('w'), 0, 2, 0.5)).toEqual({ x: 0, y: 0, z: 1 })
  })

  it('S：沿世界 −Z 后退', () => {
    expect(computeMoveDelta(keys('s'), 0, 2, 0.5)).toEqual({ x: 0, y: 0, z: -1 })
  })

  it('D：yaw=0 时沿世界 +X 右移（方位角右正约定）', () => {
    expect(computeMoveDelta(keys('d'), 0, 2, 0.5)).toEqual({ x: 1, y: 0, z: 0 })
  })

  it('A：沿世界 −X 左移', () => {
    expect(computeMoveDelta(keys('a'), 0, 2, 0.5)).toEqual({ x: -1, y: 0, z: 0 })
  })

  it('Q 升 / E 降：世界 +Y/−Y，不受 yaw 影响', () => {
    expect(computeMoveDelta(keys('q'), 90, 2, 0.5)).toEqual({ x: 0, y: 1, z: 0 })
    expect(computeMoveDelta(keys('e'), 90, 2, 0.5)).toEqual({ x: 0, y: -1, z: 0 })
  })

  it('yaw 旋转：yaw=90° 时 W 沿 +X 前进（forward=(sin,cos)）', () => {
    const d = computeMoveDelta(keys('w'), 90, 2, 0.5)
    expect(d.x).toBeCloseTo(1, 9)
    expect(d.y).toBe(0)
    expect(d.z).toBeCloseTo(0, 9)
  })

  it('yaw 旋转：yaw=90° 时 D 沿 −Z 右移（right=(cos,−sin)）', () => {
    const d = computeMoveDelta(keys('d'), 90, 2, 0.5)
    expect(d.x).toBeCloseTo(0, 9)
    expect(d.y).toBe(0)
    expect(d.z).toBeCloseTo(-1, 9)
  })

  it('斜向（W+D）归一化：合成速度不叠加', () => {
    const d = computeMoveDelta(keys('w', 'd'), 0, 2, 0.5)
    expect(Math.hypot(d.x, d.z)).toBeCloseTo(1, 9)
    expect(d.x).toBeCloseTo(Math.SQRT1_2, 9)
    expect(d.z).toBeCloseTo(Math.SQRT1_2, 9)
  })

  it('speed 与 dt 线性缩放', () => {
    const a = computeMoveDelta(keys('w'), 0, 2, 0.5)
    const b = computeMoveDelta(keys('w'), 0, 4, 0.25)
    expect(b.z).toBeCloseTo(a.z, 9)
    expect(computeMoveDelta(keys('w'), 0, 1, 0.25).z).toBeCloseTo(0.25, 9)
  })

  it('MAX_FRAME_DT 常量存在（WorldPanel 帧步长上限）', () => {
    expect(MAX_FRAME_DT).toBe(0.05)
  })

  it('DEFAULT_KEYMAP 缺省：默认键位移动（缺省回归）', () => {
    expect(DEFAULT_KEYMAP.forward).toBe('w')
    expect(DEFAULT_KEYMAP.back).toBe('s')
    expect(DEFAULT_KEYMAP.left).toBe('a')
    expect(DEFAULT_KEYMAP.right).toBe('d')
    expect(DEFAULT_KEYMAP.up).toBe('q')
    expect(DEFAULT_KEYMAP.down).toBe('e')
    expect(DEFAULT_KEYMAP.tab).toBe('Tab')
    expect(DEFAULT_KEYMAP.space).toBe(' ')
  })

  it('自定义 keymap：forward 重绑为 i 后——i 前进、w 不动', () => {
    const km = { ...DEFAULT_KEYMAP, forward: 'i' }
    expect(computeMoveDelta(keys('i'), 0, 2, 0.5, km)).toEqual({ x: 0, y: 0, z: 1 })
    expect(computeMoveDelta(keys('w'), 0, 2, 0.5, km)).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('自定义 keymap：partial 覆盖——只改 up，其余动作仍走默认键', () => {
    // WorldPanel 调用约定：partial keymap 先与 DEFAULT_KEYMAP 合并再传入
    // （设置弹窗只存自定义部分，见 WorldPanel 的 km 合并），此处模拟同一合并点
    const partial: Partial<KeyMap> = { up: 't' }
    const km = { ...DEFAULT_KEYMAP, ...partial }
    expect(computeMoveDelta(keys('t'), 90, 2, 0.5, km)).toEqual({ x: 0, y: 1, z: 0 })
    expect(computeMoveDelta(keys('q'), 90, 2, 0.5, km)).toEqual({ x: 0, y: 0, z: 0 })
    // 未覆盖的动作回默认键（前进仍为 w）
    expect(computeMoveDelta(keys('w'), 0, 2, 0.5, km)).toEqual({ x: 0, y: 0, z: 1 })
  })

  it('自定义 keymap：值含大写照样命中（Shift 捕获的 W 与重绑键 i 比较小写化）', () => {
    const km = { ...DEFAULT_KEYMAP, forward: 'W' } // 模拟 Shift 按下捕获的大写键
    expect(computeMoveDelta(keys('w'), 0, 2, 0.5, km)).toEqual({ x: 0, y: 0, z: 1 })
  })

  it('自定义 keymap：4 方向全部重绑（I/J/K/L 经典射击键位）', () => {
    const km = { ...DEFAULT_KEYMAP, forward: 'i', back: 'k', left: 'j', right: 'l' }
    expect(computeMoveDelta(keys('i'), 0, 2, 0.5, km)).toEqual({ x: 0, y: 0, z: 1 })
    expect(computeMoveDelta(keys('k'), 0, 2, 0.5, km)).toEqual({ x: 0, y: 0, z: -1 })
    expect(computeMoveDelta(keys('j'), 0, 2, 0.5, km)).toEqual({ x: -1, y: 0, z: 0 })
    expect(computeMoveDelta(keys('l'), 0, 2, 0.5, km)).toEqual({ x: 1, y: 0, z: 0 })
    // 原默认键全部失效
    expect(computeMoveDelta(keys('w', 'a', 's', 'd'), 0, 2, 0.5, km)).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('自定义 keymap：斜向归一化不受重绑影响（I+L 合成速度不叠加）', () => {
    const km = { ...DEFAULT_KEYMAP, forward: 'i', right: 'l' }
    const d = computeMoveDelta(keys('i', 'l'), 0, 2, 0.5, km)
    expect(Math.hypot(d.x, d.z)).toBeCloseTo(1, 9)
    expect(d.x).toBeCloseTo(Math.SQRT1_2, 9)
    expect(d.z).toBeCloseTo(Math.SQRT1_2, 9)
  })

  it('computeYawDelta：keymap 参数不影响转头（←/→ 固定功能键）', () => {
    const km = { ...DEFAULT_KEYMAP, forward: 'i' }
    expect(computeYawDelta(keys('arrowright'), 1, km)).toBeCloseTo(YAW_ROTATE_SPEED_DEG, 9)
    expect(computeYawDelta(keys('arrowleft'), 1, km)).toBeCloseTo(-YAW_ROTATE_SPEED_DEG, 9)
  })
})

describe('computeYawDelta', () => {
  it('→ 右转（yaw 增）', () => {
    expect(computeYawDelta(keys('arrowright'), 1)).toBeCloseTo(YAW_ROTATE_SPEED_DEG, 9)
  })

  it('← 左转（yaw 减）', () => {
    expect(computeYawDelta(keys('arrowleft'), 1)).toBeCloseTo(-YAW_ROTATE_SPEED_DEG, 9)
  })

  it('同按抵消 / 无按键为零', () => {
    expect(computeYawDelta(keys('arrowleft', 'arrowright'), 1)).toBe(0)
    expect(computeYawDelta(new Set(), 1)).toBe(0)
  })
})

describe('sourceName', () => {
  it('已知 id 中文映射，未知 id 显示原文', () => {
    expect(sourceName('vocal')).toBe('人声')
    expect(sourceName('guitar')).toBe('吉他')
    expect(sourceName('drums')).toBe('鼓组')
    expect(sourceName('ambience')).toBe('环境声')
    expect(sourceName('bass')).toBe('bass')
  })
})

describe('nextSourceIndex（Tab 循环选源）', () => {
  const srcs = [{ id: 'vocal' }, { id: 'guitar' }, { id: 'drums' }]

  it('空列表 → -1（调用方不动作）', () => {
    expect(nextSourceIndex([], null)).toBe(-1)
    expect(nextSourceIndex([], 'vocal')).toBe(-1)
  })

  it('无选中 → 0（从第一个开始）', () => {
    expect(nextSourceIndex(srcs, null)).toBe(0)
  })

  it('按列表顺序循环：0 → 1 → 2 → 0（回绕）', () => {
    expect(nextSourceIndex(srcs, 'vocal')).toBe(1)
    expect(nextSourceIndex(srcs, 'guitar')).toBe(2)
    expect(nextSourceIndex(srcs, 'drums')).toBe(0)
  })

  it('selectedId 不在列表 → 0（视为无选中）', () => {
    expect(nextSourceIndex(srcs, 'bass')).toBe(0)
  })

  it('仅 1 个时不变：已选中 → 0（调用方按 id 相同跳过），未选中 → -1', () => {
    expect(nextSourceIndex([{ id: 'vocal' }], 'vocal')).toBe(0)
    expect(nextSourceIndex([{ id: 'vocal' }], null)).toBe(-1)
    expect(nextSourceIndex([{ id: 'vocal' }], 'drums')).toBe(-1)
  })
})
