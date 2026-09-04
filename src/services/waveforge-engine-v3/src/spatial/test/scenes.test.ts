/**
 * scenes —— 模式 D 舞台/影院场景预设单元测试
 *
 * 覆盖：4 预设结构与数值（数量/方向合法/房间映射）、stageSpeakers 座位缩放
 * （front<middle<back）与房间缩放、距离钳位、返回副本不污染常量表、stageRoom。
 */
import { describe, it, expect } from 'vitest'
import { STAGE_SCENES, stageSpeakers, stageRoom } from '../scenes'
import type { StagePreset, StageSettings } from '../types'

/** 构造 StageSettings（默认舞台预设） */
function settings(partial: Partial<StageSettings> = {}): StageSettings {
  return { preset: 'stage', seat: 'middle', roomSize: 1, reverbAmount: 0.35, customSources: [], ...partial }
}

describe('scenes：舞台预设表', () => {
  it('预设表含 4 场景，id/名称与顺序对应', () => {
    expect(STAGE_SCENES).toHaveLength(4)
    expect(STAGE_SCENES.map((s) => s.id)).toEqual(['stage', 'cinema', 'piano', 'nature'])
    expect(STAGE_SCENES.map((s) => s.name)).toEqual(['音乐舞台', '电影院', '钢琴独奏', '自然场景'])
    for (const s of STAGE_SCENES) {
      expect(s.description.length).toBeGreaterThan(0)
    }
  })

  it('全部预设结构完整：扬声器非空、方向合法（az∈[-180,180] / el∈[-90,90] / dist∈[0.5,15]）', () => {
    for (const scene of STAGE_SCENES) {
      expect(scene.speakers.length).toBeGreaterThan(0)
      for (const sp of scene.speakers) {
        expect(sp.azimuthDeg).toBeGreaterThanOrEqual(-180)
        expect(sp.azimuthDeg).toBeLessThanOrEqual(180)
        expect(sp.elevationDeg).toBeGreaterThanOrEqual(-90)
        expect(sp.elevationDeg).toBeLessThanOrEqual(90)
        expect(sp.distance).toBeGreaterThanOrEqual(0.5)
        expect(sp.distance).toBeLessThanOrEqual(15)
      }
    }
  })

  it('stage 音乐舞台：7 只（主唱居中 + 乐器 + 环境环绕），room=stage', () => {
    const s = STAGE_SCENES.find((x) => x.id === 'stage')!
    expect(s.speakers).toHaveLength(7)
    const byAz = (az: number) => s.speakers.find((x) => x.azimuthDeg === az)!
    expect(byAz(0)).toMatchObject({ elevationDeg: 0, distance: 2.5, gain: 1, size: 0 }) // 主唱
    expect(byAz(-30).distance).toBe(4) // 吉他
    expect(byAz(30).distance).toBe(4) // 贝斯
    expect(byAz(10).distance).toBe(6) // 鼓
    expect(byAz(-20).distance).toBe(5) // 键盘
    expect(byAz(-110).distance).toBe(8) // 环境左
    expect(byAz(110).distance).toBe(8) // 环境右
    expect(s.room).toBe('stage')
  })

  it('cinema 电影院：7.1.4 共 11 只（屏幕 3 + 环绕 4 + 顶置 4），room=hall', () => {
    const s = STAGE_SCENES.find((x) => x.id === 'cinema')!
    expect(s.speakers).toHaveLength(11)
    const ground = s.speakers.filter((x) => x.elevationDeg === 0)
    const tops = s.speakers.filter((x) => x.elevationDeg === 45)
    expect(ground).toHaveLength(7)
    expect(tops).toHaveLength(4)
    const groundAz = ground.map((x) => x.azimuthDeg).sort((a, b) => a - b)
    expect(groundAz).toEqual([-135, -100, -30, 0, 30, 100, 135]) // RL SL FL C FR SR RR
    expect(tops.map((x) => x.azimuthDeg).sort((a, b) => a - b)).toEqual([-135, -45, 45, 135]) // TRL TFL TFR TRR
    // 影院距离独立定义：屏幕 4m / 环绕 7m / 顶置 5m（不复用 714 的 1.5m）
    expect(ground.find((x) => x.azimuthDeg === 0)!.distance).toBe(4)
    expect(ground.find((x) => x.azimuthDeg === -100)!.distance).toBe(7)
    expect(tops.every((x) => x.distance === 5)).toBe(true)
    expect(s.room).toBe('hall')
  })

  it('piano 钢琴独奏：4 只（钢琴居中 + 音乐厅环境），room=hall', () => {
    const s = STAGE_SCENES.find((x) => x.id === 'piano')!
    expect(s.speakers).toHaveLength(4)
    expect(s.speakers[0]).toMatchObject({ azimuthDeg: 0, elevationDeg: 0, distance: 2 }) // 钢琴
    const azs = s.speakers.map((x) => x.azimuthDeg).sort((a, b) => a - b)
    expect(azs).toEqual([-90, 0, 90, 180])
    expect(s.speakers.find((x) => x.azimuthDeg === 180)!.distance).toBe(10)
    expect(s.room).toBe('hall')
  })

  it('nature 自然场景：4 只（雨头顶/雷身后/鸟/溪流），仰角字段生效，room=outdoor', () => {
    const s = STAGE_SCENES.find((x) => x.id === 'nature')!
    expect(s.speakers).toHaveLength(4)
    expect(s.speakers[0]).toMatchObject({ azimuthDeg: 0, elevationDeg: 50, distance: 7 }) // 雨：仰角 50°
    expect(s.speakers[1]).toMatchObject({ azimuthDeg: 180, elevationDeg: 0, distance: 15 }) // 雷
    expect(s.speakers[2]).toMatchObject({ azimuthDeg: -140, elevationDeg: 20, distance: 8 }) // 鸟：仰角 20°
    expect(s.speakers[3]).toMatchObject({ azimuthDeg: 110, elevationDeg: 0, distance: 6 }) // 溪流
    expect(s.room).toBe('outdoor')
  })
})

describe('scenes：stageSpeakers 座位/房间缩放', () => {
  it('座位缩放：front<middle<back（系数 0.8/1.0/1.35，逐只严格递增）', () => {
    const front = stageSpeakers(settings({ seat: 'front' }))
    const middle = stageSpeakers(settings({ seat: 'middle' }))
    const back = stageSpeakers(settings({ seat: 'back' }))
    expect(front).toHaveLength(7)
    for (let i = 0; i < front.length; i++) {
      expect(front[i].distance).toBeLessThan(middle[i].distance)
      expect(middle[i].distance).toBeLessThan(back[i].distance)
    }
    // 系数数值：主唱 2.5m → 2.0 / 2.5 / 3.375
    expect(front[0].distance).toBeCloseTo(2.5 * 0.8)
    expect(middle[0].distance).toBeCloseTo(2.5)
    expect(back[0].distance).toBeCloseTo(2.5 * 1.35)
  })

  it('座位/房间缩放不影响方位角与仰角（仅距离变化）', () => {
    // back×1.35 不夹 roomSize，雨 7m→9.45、溪流 6m→8.1；雷 15m→20.25 钳位 10
    const s = stageSpeakers(settings({ preset: 'nature', seat: 'back', roomSize: 1 }))
    expect(s[0]).toMatchObject({ azimuthDeg: 0, elevationDeg: 50 }) // 雨
    expect(s[1]).toMatchObject({ azimuthDeg: 180, elevationDeg: 0 }) // 雷
    expect(s[0].distance).toBeCloseTo(7 * 1.35)
    expect(s[3].distance).toBeCloseTo(6 * 1.35)
    expect(s[1].distance).toBe(10) // 15×1.35=20.25 → 钳位 10
  })

  it('房间大小缩放：×2 翻倍、×0.5 减半（钳位内）', () => {
    const s2 = stageSpeakers(settings({ roomSize: 2 }))
    const s05 = stageSpeakers(settings({ roomSize: 0.5 }))
    expect(s2[0].distance).toBeCloseTo(2.5 * 2) // 主唱 5m
    expect(s05[0].distance).toBeCloseTo(2.5 * 0.5) // 主唱 1.25m
    // 环境环绕 8m ×2 = 16 → 钳位 10m（上界）
    expect(s2[5].distance).toBe(10)
    expect(s2[6].distance).toBe(10)
    // 全部距离落在钳位区间 [0.5, 10]
    for (const x of [...s2, ...s05]) {
      expect(x.distance).toBeGreaterThanOrEqual(0.5)
      expect(x.distance).toBeLessThanOrEqual(10)
    }
  })

  it('返回副本：修改结果不影响常量表', () => {
    const a = stageSpeakers(settings())
    const b = stageSpeakers(settings())
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a[0]).not.toBe(b[0])
    a[0].azimuthDeg = 999
    a[0].gain = 9
    expect(STAGE_SCENES[0].speakers[0].azimuthDeg).toBe(0) // 常量表未污染
    expect(STAGE_SCENES[0].speakers[0].gain).toBe(1)
  })
})

describe('scenes：stageRoom', () => {
  it('预设 → 房间映射：stage→stage / cinema→hall / piano→hall / nature→outdoor', () => {
    expect(stageRoom(settings({ preset: 'stage' }))).toBe('stage')
    expect(stageRoom(settings({ preset: 'cinema' }))).toBe('hall')
    expect(stageRoom(settings({ preset: 'piano' }))).toBe('hall')
    expect(stageRoom(settings({ preset: 'nature' }))).toBe('outdoor')
  })

  it('未知 id 防御：回退音乐舞台预设', () => {
    const p = settings({ preset: 'unknown' as StagePreset })
    expect(stageRoom(p)).toBe('stage')
    expect(stageSpeakers(p)).toHaveLength(7) // 舞台预设扬声器
  })
})
