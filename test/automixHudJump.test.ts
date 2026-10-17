import { describe, expect, it } from 'vitest'
import { AUTOMIX_HUD_JUMP_LEAD_SECONDS, automixHudJumpTarget } from '../src/components/AutomixHudBadge'

// 时间节点药丸点击后要跳到「过渡切点前 11 秒」。
// 这段公式必须单处定义：药丸和调用方各自再减一次会把落点推成切点前 22 秒（写错过一次）。
describe('automixHudJumpTarget（药丸点击落点）', () => {
  it('前移常量固定为 11 秒', () => {
    expect(AUTOMIX_HUD_JUMP_LEAD_SECONDS).toBe(11)
  })

  it('正常切点：落点是切点前 11 秒', () => {
    expect(automixHudJumpTarget(200)).toBe(189)
  })

  it('切点不足 11 秒时夹到 0，不返回负数 seek', () => {
    expect(automixHudJumpTarget(8)).toBe(0)
    expect(automixHudJumpTarget(11)).toBe(0)
    expect(automixHudJumpTarget(0)).toBe(0)
  })

  it('脏数据一律回落到 0，不把 NaN/Infinity 传给 seek', () => {
    expect(automixHudJumpTarget(Number.NaN)).toBe(0)
    expect(automixHudJumpTarget(Number.POSITIVE_INFINITY)).toBe(0)
    expect(automixHudJumpTarget(undefined as unknown as number)).toBe(0)
    expect(automixHudJumpTarget(null as unknown as number)).toBe(0)
  })
})
