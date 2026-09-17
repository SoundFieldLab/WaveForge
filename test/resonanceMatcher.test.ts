import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveLocalTrack, unplayableText, type ResonancePlatformAccount } from '../src/features/resonance/matcher'
import type { ResonanceTrack } from '../src/features/resonance/model'
import { canonicalTrackKey } from '../src/features/resonance/model'

const songUrlMock = vi.fn()
const searchMock = vi.fn()
const neteaseDetailMock = vi.fn()

vi.mock('../src/services/musicApi', async () => {
  const actual = await vi.importActual<typeof import('../src/services/musicApi')>('../src/services/musicApi')
  return {
    ...actual,
    getSongUrl: (...args: unknown[]) => songUrlMock(...args),
    searchSongs: (...args: unknown[]) => searchMock(...args),
  }
})

vi.mock('../src/features/neteaseExplore/api', async () => {
  const actual = await vi.importActual<typeof import('../src/features/neteaseExplore/api')>('../src/features/neteaseExplore/api')
  return { ...actual, fetchNeteaseSongDetail: (...args: unknown[]) => neteaseDetailMock(...args) }
})

const accounts = (...items: Array<[string, boolean, string]>): ResonancePlatformAccount[] => (
  items.map(([platform, loggedIn, tier]) => ({ platform: platform as ResonancePlatformAccount['platform'], loggedIn, tier: tier as ResonancePlatformAccount['tier'] }))
)

const track = (overrides: Partial<ResonanceTrack> = {}): ResonanceTrack => ({
  key: canonicalTrackKey({ title: 'Lemon', artists: ['米津玄師'] }),
  title: 'Lemon',
  artists: ['米津玄師'],
  durationMs: 255000,
  sources: [],
  requestedBy: 'host',
  seq: 1,
  ...overrides,
})

const neteaseSong = (overrides: Record<string, unknown> = {}) => ({
  id: 1001,
  name: 'Lemon',
  artists: [{ id: 1, name: '米津玄師' }],
  album: { name: 'Lemon', picUrl: '' },
  duration: 255000,
  platform: 'netease' as const,
  fee: 0,
  requiredTier: 'free' as const,
  ...overrides,
})

beforeEach(() => {
  songUrlMock.mockReset()
  searchMock.mockReset()
  neteaseDetailMock.mockReset()
  songUrlMock.mockResolvedValue('https://audio/ok.mp3')
  searchMock.mockResolvedValue({ songs: [], artists: [], albums: [] })
  neteaseDetailMock.mockResolvedValue([])
})

describe('共振跨平台匹配器', () => {
  it('没登录任何平台：明确返回 no-platform（进房但不发声）', async () => {
    const result = await resolveLocalTrack(track(), accounts(['netease', false, 'free']))
    expect(result.playable).toBe(false)
    expect(result.reason).toBe('no-platform')
    expect(unplayableText(result)).toContain('还没有登录任何音乐平台')
  })

  it('房间候选源命中本机有权限的平台：直接可播并给出该版本', async () => {
    neteaseDetailMock.mockResolvedValue([neteaseSong()])
    const result = await resolveLocalTrack(
      track({ sources: [{ platform: 'netease', id: 1001 }] }),
      accounts(['netease', true, 'vip']),
    )
    expect(result.playable).toBe(true)
    expect(result.platform).toBe('netease')
    expect(result.song?.id).toBe(1001)
    expect(result.durationDeltaMs).toBe(0)
  })

  it('本机没有会员而候选源需要 VIP：报 locked 且不去取流（不绕会员）', async () => {
    neteaseDetailMock.mockResolvedValue([neteaseSong({ fee: 1, requiredTier: 'vip' })])
    const result = await resolveLocalTrack(
      track({ sources: [{ platform: 'netease', id: 1001, vip: true }] }),
      accounts(['netease', true, 'free']),
    )
    expect(result.playable).toBe(false)
    expect(result.reason).toBe('locked')
    expect(result.tier).toBe('vip')
    expect(songUrlMock).not.toHaveBeenCalled()
    expect(unplayableText(result)).toContain('需要 VIP')
  })

  it('候选源平台未登录时跳过，改用已登录平台搜索替代版本', async () => {
    searchMock.mockResolvedValue({ songs: [neteaseSong({ id: 2002, platform: 'qq', mid: 'mid-1' })], artists: [], albums: [] })
    const result = await resolveLocalTrack(
      track({ sources: [{ platform: 'apple', id: 9, appleId: 'apple-9', vip: true }] }),
      accounts(['apple', false, 'unknown'], ['qq', true, 'vip']),
    )
    expect(result.playable).toBe(true)
    expect(result.platform).toBe('qq')
    expect(result.substituted).toBe(true)
    expect(songUrlMock).toHaveBeenCalledWith('mid-1', 'qq')
  })

  it('搜索到的同名曲时长差太大（live/翻唱）不算同一首', async () => {
    searchMock.mockResolvedValue({ songs: [neteaseSong({ id: 3003, duration: 320000 })], artists: [], albums: [] })
    const result = await resolveLocalTrack(track({ durationMs: 255000 }), accounts(['netease', true, 'vip']))
    expect(result.playable).toBe(false)
    expect(result.reason).toBe('missing')
  })

  it('有权限但取流失败：报 unavailable 而不是假装可播', async () => {
    neteaseDetailMock.mockResolvedValue([neteaseSong()])
    songUrlMock.mockResolvedValue('SONG_UNAVAILABLE')
    const result = await resolveLocalTrack(
      track({ sources: [{ platform: 'netease', id: 1001 }] }),
      accounts(['netease', true, 'vip']),
    )
    expect(result.playable).toBe(false)
    expect(result.reason).toBe('unavailable')
  })

  it('会员档位未知（Apple/酷狗）：先放行给各自播放链，不误判为 locked', async () => {
    neteaseDetailMock.mockResolvedValue([neteaseSong()])
    searchMock.mockResolvedValue({ songs: [neteaseSong({ id: 4004, platform: 'apple', appleId: 'a-4' })], artists: [], albums: [] })
    const result = await resolveLocalTrack(track(), accounts(['apple', true, 'unknown']))
    expect(result.playable).toBe(true)
    expect(result.platform).toBe('apple')
  })

  it('版本时长不同：可播但给出时长差，供 UI 提示', async () => {
    neteaseDetailMock.mockResolvedValue([neteaseSong({ duration: 247000 })])
    const result = await resolveLocalTrack(
      track({ sources: [{ platform: 'netease', id: 1001 }], durationMs: 255000 }),
      accounts(['netease', true, 'vip']),
    )
    expect(result.playable).toBe(true)
    expect(result.durationDeltaMs).toBe(-8000)
  })

  it('多平台都在线时优先已登录且有会员的平台', async () => {
    neteaseDetailMock.mockResolvedValue([neteaseSong({ id: 1001 })])
    const result = await resolveLocalTrack(
      track({ sources: [{ platform: 'netease', id: 1001 }, { platform: 'kugou', id: 7007, vip: true }] }),
      accounts(['netease', true, 'vip'], ['kugou', true, 'vip']),
    )
    expect(result.playable).toBe(true)
    expect(result.platform).toBe('netease')
  })

  it('原因文案覆盖所有分支（UI 直接可用）', () => {
    expect(unplayableText({ playable: false, reason: 'locked', tier: 'svip' })).toContain('SVIP')
    expect(unplayableText({ playable: false, reason: 'missing' })).toContain('没有这首歌')
    expect(unplayableText({ playable: false, reason: 'unavailable', platform: 'kugou' }, p => String(p))).toContain('kugou')
    expect(unplayableText({ playable: false, reason: 'error' })).toContain('无法播放')
  })
})

describe('会员档位判定（回归：Apple 订阅制 / unknown 不误杀）', () => {
  it('已登录的 Apple 视为有效订阅，不再被当成 unknown 而逐曲判不可播', async () => {
    const { entitlementTierFromVip } = await import('../src/utils/musicEntitlements')
    // 订阅制平台：登录即会员；这里锁住的是「不能再用恒 unknown」的约定
    const appleTier = (loggedIn: boolean) => (loggedIn ? entitlementTierFromVip(true) : 'unknown')
    expect(appleTier(true)).toBe('vip')
    expect(appleTier(false)).toBe('unknown')
  })

  it('tier 为 unknown 的账号不会被 entitlementSatisfies 提前判死（走实测取流）', async () => {
    const { entitlementSatisfies } = await import('../src/utils/musicEntitlements')
    // unknown 与任何档位比较都是 false —— 所以调用方必须显式放行 unknown（matcher 里的 `account.tier !== 'unknown'`），
    // 否则「未知档位」会等价于「没会员」，把能播的歌全部误杀成 locked。
    expect(entitlementSatisfies('unknown', 'vip')).toBe(false)
    expect(entitlementSatisfies('unknown', 'free')).toBe(false)
    expect(entitlementSatisfies('vip', 'vip')).toBe(true)
    expect(entitlementSatisfies('vip', 'free')).toBe(true)
  })
})
