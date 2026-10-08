import { describe, expect, it, beforeEach } from 'vitest'
import { recordCrossFill, isCrossFilled, getCrossFillSource, clearCrossFills } from '../src/services/crossFillRegistry'

describe('补源登记（音质与供源平台绑定，身份与进入平台绑定）', () => {
  beforeEach(() => { localStorage.clear(); clearCrossFills() })

  it('登记载体平台与载体 id，查询返回供源平台', () => {
    recordCrossFill({ platform: 'soda', id: 12345 }, 'qq', '003Z6Ivx3s0D1z')
    const source = getCrossFillSource({ platform: 'soda', id: 12345 })
    expect(source?.platform).toBe('qq')
    expect(source?.carrierId).toBe('003Z6Ivx3s0D1z')
    expect(isCrossFilled({ platform: 'soda', id: 12345 })?.from).toBe('qq')
  })

  it('未补源的歌返回 null（音质按进入平台走）', () => {
    expect(getCrossFillSource({ platform: 'soda', id: 999 })).toBeNull()
  })

  it('重复登记同一首只更新来源与载体（保留旧载体 id 兜底）', () => {
    recordCrossFill({ platform: 'soda', id: 1 }, 'netease', '111111')
    recordCrossFill({ platform: 'soda', id: 1 }, 'qq')
    const source = getCrossFillSource({ platform: 'soda', id: 1 })
    expect(source?.platform).toBe('qq')
    expect(source?.carrierId).toBe('111111')
  })
})
