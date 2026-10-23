import { describe, expect, it } from 'vitest'
import {
  selectCarrier,
  effectiveQualityScore,
  candidateTierOf,
  type CarrierPlatformProfile,
  type CarrierCandidate,
} from '../src/services/carrierSelection'
import type { Song } from '../src/services/musicApi'

const song = (patch: Partial<Song> = {}): Song => ({
  id: 1,
  name: '晴天',
  artists: [{ name: '周杰伦' }],
  album: { name: '叶惠美' },
  duration: 269000,
  platform: 'netease',
  ...patch,
}) as Song

const profile = (patch: Partial<CarrierPlatformProfile> & { platform: CarrierPlatformProfile['platform'] }): CarrierPlatformProfile => ({
  loggedIn: true,
  tier: 'vip',
  qualityScore: 0,
  ...patch,
})

const input = (candidates: Record<string, CarrierCandidate[]>, profiles: CarrierPlatformProfile[], originPlatform = 'soda') => ({
  originPlatform,
  profiles,
  candidatesByPlatform: candidates,
  matchScoreOf: (s: Song) => (s as Song & { __score?: number }).__score ?? 80,
})

describe('多平台载体选择算法', () => {
  it('未登录的平台不参与借源', () => {
    const decision = selectCarrier(input(
      { netease: [{ song: song({ __score: 90 } as never), tier: 'free' }] },
      [profile({ platform: 'netease', loggedIn: false })],
    ))
    expect(decision.best).toBeNull()
  })

  it('候选要求 VIP 而载体是免费档 → 淘汰（宁可放弃也不给试听）', () => {
    const decision = selectCarrier(input(
      { qq: [{ song: song({ __score: 95 } as never), tier: 'vip' }] },
      [profile({ platform: 'qq', tier: 'free' })],
    ))
    expect(decision.best).toBeNull()
    expect(decision.ranking[0]?.score).toBe(-1)
  })

  it('档位 unknown 不淘汰（酷狗无档位来源，实测取流）', () => {
    const decision = selectCarrier(input(
      { kugou: [{ song: song({ __score: 80 } as never), tier: 'vip' }] },
      [profile({ platform: 'kugou', tier: 'unknown' })],
    ))
    expect(decision.best?.platform).toBe('kugou')
  })

  it('要求 SVIP 的候选：VIP 载体也淘汰', () => {
    const decision = selectCarrier(input(
      { netease: [{ song: song({ __score: 99 } as never), tier: 'svip' }] },
      [profile({ platform: 'netease', tier: 'vip' })],
    ))
    expect(decision.best).toBeNull()
  })

  it('音质档差可逆转小幅匹配差：无损(90)胜过标准(60)，即使后者匹配分更高', () => {
    // netease 无损 vip（quality 90×0.3=27）匹配 75；qq 标准 free（55×0.3=16.5）匹配 90
    // netease: 75 + 27 + 3.75 = 105.75；qq: 90 + 16.5 + 7.5 = 114 → qq 反而胜？
    // 匹配差 15 分 × 1.0 > 音质差 10.5：说明匹配为主导项，符合"选最像的原曲"优先。
    // 真正的音质决定场景：匹配分接近时（差 ≤5）。
    const decision = selectCarrier(input(
      {
        netease: [{ song: song({ __score: 75 } as never), tier: 'free' }],
        qq: [{ song: song({ __score: 78 } as never), tier: 'vip' }],
      },
      [
        profile({ platform: 'netease', tier: 'vip', qualityScore: 100 }), // 90×0.3=27
        profile({ platform: 'qq', tier: 'free' }), // 55×0.3=16.5
      ],
    ))
    // netease: 75 + 27 + 3.75 = 105.75 > qq: 78 + 16.5 + 4.5 = 99 → 无损胜出
    expect(decision.best?.platform).toBe('netease')
  })

  it('音质/匹配都接近时原平台偏好决定（+6）', () => {
    const decision = selectCarrier(input(
      {
        netease: [{ song: song({ __score: 80 } as never), tier: 'free' }],
        qq: [{ song: song({ __score: 80 } as never), tier: 'free' }],
      },
      [
        profile({ platform: 'netease', tier: 'free' }),
        profile({ platform: 'qq', tier: 'free' }),
      ],
      'qq',
    ))
    expect(decision.best?.platform).toBe('qq')
  })

  it('会员档位封顶音质偏好：免费账号勾无损也按免费档算', () => {
    expect(effectiveQualityScore(profile({ platform: 'netease', tier: 'free', qualityScore: 100 })))
      .toBeLessThan(effectiveQualityScore(profile({ platform: 'netease', tier: 'vip', qualityScore: 100 })))
  })

  it('svip 载体拿平台上限分', () => {
    expect(effectiveQualityScore(profile({ platform: 'qq', tier: 'svip', qualityScore: 100 }))).toBe(100)
  })

  it('requiredTier 优先于 vip 布尔', () => {
    expect(candidateTierOf(song({ requiredTier: 'svip', vip: true }))).toBe('svip')
    expect(candidateTierOf(song({ vip: true }))).toBe('vip')
    expect(candidateTierOf(song({ vip: false }))).toBe('free')
  })

  it('没有候选的平台不参与 ranking 正分排序', () => {
    const decision = selectCarrier(input(
      { netease: [{ song: song(), tier: 'free' }] },
      [profile({ platform: 'netease' }), profile({ platform: 'qq' })],
    ))
    expect(decision.best?.platform).toBe('netease')
    expect(decision.ranking.some(item => item.platform === 'qq' && item.score > 0)).toBe(false)
  })
})
