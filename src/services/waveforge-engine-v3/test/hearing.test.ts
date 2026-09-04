/**
 * HearingTest 单元测试：验证二分阈值状态机（API_SPEC 小节 F）
 *
 * 断言依据：频点 125..8000Hz（7 频点）、电平 -60..0dB、每频点 5 轮二分；
 * 5 轮分辨率 = 60/2^5 = 1.875 dB，故模拟听者阈值估计误差 ≤ 2 dB（物理意义：听阈估计精度）。
 */
import { describe, expect, it } from 'vitest'
import { HearingTest, HEARING_TEST_FREQUENCIES, HEARING_LO_DB, HEARING_HI_DB, HEARING_ROUNDS } from '../src/analysis/HearingTest'

describe('HearingTest 状态机', () => {
  it('begin 前 nextStep 返回 null；reset 后同样返回 null', () => {
    const ht = new HearingTest(48000)
    expect(ht.nextStep()).toBeNull()
    ht.begin()
    expect(ht.nextStep()).not.toBeNull()
    ht.reset()
    expect(ht.nextStep()).toBeNull()
    expect(ht.getAudiogram()).toHaveLength(0)
  })

  it('首轮电平为二分中点 -30dB；heard→-45，未heard→-37.5（区间逐轮减半）', () => {
    const ht = new HearingTest(48000)
    ht.begin()
    expect(ht.nextStep()).toEqual({ freqHz: 125, levelDb: -30 })
    // heard：阈值 ≤ -30 → hi=-30，下一电平 = (-60 + -30)/2 = -45
    ht.answer(true)
    expect(ht.nextStep()).toEqual({ freqHz: 125, levelDb: -45 })
    // 未 heard：阈值 > -45 → lo=-45，下一电平 = (-45 + -30)/2 = -37.5
    ht.answer(false)
    expect(ht.nextStep()).toEqual({ freqHz: 125, levelDb: -37.5 })
  })

  it('nextStep 幂等：未 answer 时重复调用返回同一待测步骤', () => {
    const ht = new HearingTest(48000)
    ht.begin()
    const s1 = ht.nextStep()
    const s2 = ht.nextStep()
    expect(s1).toEqual(s2)
  })

  it('7 频点 × 5 轮后全部完成，nextStep 返回 null；听阈按频点顺序记录', () => {
    const ht = new HearingTest(48000)
    ht.begin()
    const order: number[] = []
    for (let f = 0; f < HEARING_TEST_FREQUENCIES.length; f++) {
      for (let r = 0; r < HEARING_ROUNDS; r++) {
        const step = ht.nextStep()
        expect(step).not.toBeNull()
        order.push(step!.freqHz)
        ht.answer(false) // 统一"听不到"，阈值估计收敛到区间中点
      }
    }
    expect(ht.nextStep()).toBeNull()
    // 每频点恰好出现 5 次
    for (const freq of HEARING_TEST_FREQUENCIES) {
      expect(order.filter((f) => f === freq)).toHaveLength(HEARING_ROUNDS)
    }
    const audio = ht.getAudiogram()
    expect(audio).toHaveLength(HEARING_TEST_FREQUENCIES.length)
    expect(audio.map((p) => p.freqHz)).toEqual([...HEARING_TEST_FREQUENCIES])
  })

  it('模拟"阈值 -20dB"听者：估计误差 ≤ 2dB（二分 5 轮精度 ≈1.875dB）', () => {
    // 物理意义：听阈估计 = 5 轮二分后的区间中点，与真实阈值的偏差受 60/2^5 精度约束
    const heard = (levelDb: number): boolean => levelDb >= -20
    const ht = new HearingTest(48000)
    ht.begin()
    for (let f = 0; f < HEARING_TEST_FREQUENCIES.length; f++) {
      for (let r = 0; r < HEARING_ROUNDS; r++) {
        const step = ht.nextStep()!
        ht.answer(heard(step.levelDb))
      }
    }
    const audio = ht.getAudiogram()
    expect(audio).toHaveLength(HEARING_TEST_FREQUENCIES.length)
    for (const p of audio) {
      expect(Math.abs(p.thresholdDb - -20)).toBeLessThanOrEqual(2)
    }
  })

  it('阈值始终落在 -60..0 区间内（含边界听者）', () => {
    // 物理意义：无论回答模式如何，区间中点不会越出测试电平范围
    const ht = new HearingTest(48000)
    ht.begin()
    for (let f = 0; f < HEARING_TEST_FREQUENCIES.length; f++) {
      for (let r = 0; r < HEARING_ROUNDS; r++) {
        ht.nextStep()
        ht.answer(true) // 全程"听得到"
      }
    }
    for (const p of ht.getAudiogram()) {
      expect(p.thresholdDb).toBeGreaterThanOrEqual(HEARING_LO_DB)
      expect(p.thresholdDb).toBeLessThanOrEqual(HEARING_HI_DB)
    }
  })

  it('getAudiogram 返回副本；answer 无待测步骤时为空操作', () => {
    const ht = new HearingTest(44100)
    ht.begin()
    for (let r = 0; r < HEARING_ROUNDS; r++) {
      ht.nextStep()
      ht.answer(false)
    }
    const g = ht.getAudiogram()
    expect(g).toHaveLength(1)
    g[0].thresholdDb = 99 // 修改副本不影响内部状态
    expect(ht.getAudiogram()[0].thresholdDb).not.toBe(99)
    // 完成前多余的 answer 不产生额外频点
    ht.answer(false)
    ht.answer(false)
    expect(ht.getAudiogram()).toHaveLength(1)
  })

  it('非法采样率抛 Error', () => {
    expect(() => new HearingTest(0)).toThrow('invalid sample rate')
    expect(() => new HearingTest(-48000)).toThrow('invalid sample rate')
  })
});
