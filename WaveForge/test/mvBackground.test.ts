import { describe, it, expect } from 'vitest'
import { computeMvSyncTarget, shouldSeekMvVideo } from '../src/services/mvBackground'

describe('computeMvSyncTarget（视频目标时间换算）', () => {
  it('loop：音频位置在视频时长内 → 原值', () => {
    expect(computeMvSyncTarget(30, 240)).toBe(30)
    expect(computeMvSyncTarget(0, 240)).toBe(0)
  })

  it('loop：音频位置超出视频时长 → 取模', () => {
    expect(computeMvSyncTarget(250, 240)).toBe(10)
    expect(computeMvSyncTarget(480, 240)).toBe(0)
  })

  it('loop：音频位置恰好是视频时长整数倍 → 0', () => {
    expect(computeMvSyncTarget(240, 240)).toBe(0)
    expect(computeMvSyncTarget(720, 240)).toBe(0)
  })

  it('非 loop：超出视频时长 → 钳制到末尾', () => {
    expect(computeMvSyncTarget(300, 240, false)).toBe(240)
    expect(computeMvSyncTarget(120, 240, false)).toBe(120)
  })

  it('音频位置非法（NaN/Infinity）→ 按 0 处理', () => {
    expect(computeMvSyncTarget(Number.NaN, 240)).toBe(0)
    expect(computeMvSyncTarget(Number.POSITIVE_INFINITY, 240)).toBe(0)
  })

  it('负音频位置 → 钳制到 0', () => {
    expect(computeMvSyncTarget(-5, 240)).toBe(0)
  })

  it('视频时长非法（0/NaN/Infinity）→ null', () => {
    expect(computeMvSyncTarget(30, 0)).toBeNull()
    expect(computeMvSyncTarget(30, Number.NaN)).toBeNull()
    expect(computeMvSyncTarget(30, Number.POSITIVE_INFINITY)).toBeNull()
  })
})

describe('shouldSeekMvVideo（是否需 seek 校正）', () => {
  it('偏差超过阈值 → true', () => {
    expect(shouldSeekMvVideo(10, 20)).toBe(true)
    expect(shouldSeekMvVideo(0, 20)).toBe(true)
  })

  it('偏差在阈值内 → false', () => {
    expect(shouldSeekMvVideo(10, 10.3)).toBe(false)
    expect(shouldSeekMvVideo(10, 10)).toBe(false)
  })

  it('目标为 null / 当前时间非法 → false', () => {
    expect(shouldSeekMvVideo(10, null)).toBe(false)
    expect(shouldSeekMvVideo(Number.NaN, 10)).toBe(false)
  })

  it('自定义阈值', () => {
    expect(shouldSeekMvVideo(10, 10.4, 0.3)).toBe(true)
    expect(shouldSeekMvVideo(10, 10.4, 0.5)).toBe(false)
  })
})
