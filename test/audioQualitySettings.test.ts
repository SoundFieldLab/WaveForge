/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AUDIO_QUALITY_SETTINGS_EVENT,
  DEFAULT_AUDIO_QUALITY_SETTINGS,
  getAudioQualityPreference,
  getPlatformSvipState,
  getPlatformVipState,
  getQualityOptions,
  getQualityTier,
  isVipOnlyResolvedQuality,
  loadAudioQualitySettings,
  resolvedQualityDisplayName,
  resolvedQualityShortLabel,
  saveAudioQualitySettings,
} from '../src/services/audioQualitySettings'
import { getLastResolvedQuality, getSongUrl } from '../src/services/musicApi'
import { detectQQMusicSvip } from '../src/utils/musicEntitlements'
import { accountTierBadgeClass, getAccountTierBadge } from '../src/services/accountTier'

describe('audioQualitySettings Apple preference', () => {
  beforeEach(() => localStorage.clear())

  it('gives Apple an independent auto preference', () => {
    expect(loadAudioQualitySettings()).toEqual(DEFAULT_AUDIO_QUALITY_SETTINGS)
    expect(getAudioQualityPreference('apple')).toBe('auto')
  })

  it('does not borrow the Netease preference for Apple', () => {
    saveAudioQualitySettings({ netease: 'hi-res', apple: 'aac' })
    expect(getAudioQualityPreference('netease')).toBe('hi-res')
    expect(getAudioQualityPreference('apple')).toBe('aac')
  })

  it('rejects unsupported persisted Apple values', () => {
    localStorage.setItem('audioQualitySettings', JSON.stringify({ apple: 'fake-atmos', qq: 'high' }))
    const settings = loadAudioQualitySettings()
    expect(settings.apple).toBe('auto')
    expect(settings.qq).toBe('high')
  })

  it('emits the complete updated settings snapshot', () => {
    const listener = vi.fn()
    window.addEventListener(AUDIO_QUALITY_SETTINGS_EVENT, listener)
    const settings = saveAudioQualitySettings({ apple: 'aac' })
    expect(settings.apple).toBe('aac')
    expect((listener.mock.calls[0][0] as CustomEvent).detail).toEqual(settings)
    window.removeEventListener(AUDIO_QUALITY_SETTINGS_EVENT, listener)
  })
})

describe('audioQualitySettings QQ AAC tiers', () => {
  beforeEach(() => localStorage.clear())

  it('persists QQ-only AAC tiers for qq', () => {
    const settings = saveAudioQualitySettings({ qq: '192aac' })
    expect(settings.qq).toBe('192aac')
    expect(loadAudioQualitySettings().qq).toBe('192aac')
    expect(getAudioQualityPreference('qq')).toBe('192aac')
  })

  it('resets AAC tiers written to non-QQ platforms', () => {
    const settings = saveAudioQualitySettings({ netease: '96aac', kugou: '48aac', soda: '192aac' } as never)
    expect(settings.netease).toBe('auto')
    expect(settings.kugou).toBe('auto')
    expect(settings.soda).toBe('auto')
  })

  it('sanitizes persisted AAC tiers on non-QQ platforms on load', () => {
    localStorage.setItem('audioQualitySettings', JSON.stringify({ qq: '48aac', netease: '192aac', spotify: '96aac' }))
    const settings = loadAudioQualitySettings()
    expect(settings.qq).toBe('48aac')
    expect(settings.netease).toBe('auto')
    expect(settings.spotify).toBe('auto')
  })

  it('exposes the AAC tiers in QQ options only', () => {
    const qqValues = getQualityOptions('qq').map(option => option.value)
    expect(qqValues).toContain('192aac')
    expect(qqValues).toContain('96aac')
    expect(qqValues).toContain('48aac')
    const neteaseValues = getQualityOptions('netease').map(option => option.value)
    expect(neteaseValues).not.toContain('192aac')
    expect(neteaseValues).not.toContain('96aac')
    expect(neteaseValues).not.toContain('48aac')
  })
})

describe('resolved quality display names', () => {
  it('maps QQ raw quality values to official tier names (本曲列表补挂漏档用)', () => {
    expect(resolvedQualityDisplayName('qq', 'flac')).toBe('SQ 无损（1024k）')
    expect(resolvedQualityDisplayName('qq', 'ape')).toBe('SQ 无损（1024k）')
    expect(resolvedQualityDisplayName('qq', '320')).toBe('HQ 高品（320k）')
    expect(resolvedQualityDisplayName('qq', '192aac')).toBe('HQ 高品（192k）')
    expect(resolvedQualityDisplayName('qq', '128')).toBe('标准（128k）')
    expect(resolvedQualityDisplayName('qq', '96aac')).toBe('流畅（96k）')
    expect(resolvedQualityDisplayName('qq', '48aac')).toBe('省流（48k）')
  })

  it('maps resolved tiers to player-bar short labels (自动括号/徽标短名)', () => {
    expect(resolvedQualityShortLabel('qq', 'flac')).toBe('SQ')
    expect(resolvedQualityShortLabel('qq', '320')).toBe('HQ')
    expect(resolvedQualityShortLabel('qq', '192aac')).toBe('HQ')
    expect(resolvedQualityShortLabel('qq', '128')).toBe('标准')
    expect(resolvedQualityShortLabel('qq', '96aac')).toBe('流畅')
    expect(resolvedQualityShortLabel('qq', 'm4a')).toBe('流畅')
    expect(resolvedQualityShortLabel('qq', '48aac')).toBe('省流')
    expect(resolvedQualityShortLabel('qq', 'whatever-unknown')).toBe('自动')
    expect(resolvedQualityShortLabel('netease', 'hires')).toBe('Hi-Res')
    expect(resolvedQualityShortLabel('netease', 'lossless')).toBe('无损')
    expect(resolvedQualityShortLabel('netease', 'jymaster')).toBe('母带')
  })

  it('flags vip-only resolved tiers (自动行金字判定)', () => {
    expect(isVipOnlyResolvedQuality('qq', 'flac')).toBe(true)
    expect(isVipOnlyResolvedQuality('qq', '192aac')).toBe(true)
    expect(isVipOnlyResolvedQuality('qq', '320')).toBe(false)
    expect(isVipOnlyResolvedQuality('qq', '128')).toBe(false)
    expect(isVipOnlyResolvedQuality('netease', 'lossless')).toBe(true)
    expect(isVipOnlyResolvedQuality('netease', 'jymaster')).toBe(true)
    expect(isVipOnlyResolvedQuality('netease', 'exhigh')).toBe(false)
  })
})

describe('per-song resolved quality record', () => {
  it('keys the resolved quality by song id (换歌后不残留上一首的档位)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ url: 'https://dl.stream.qqmusic.qq.com/M800per-song-test.mp3', actualQuality: '320' }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const url = await getSongUrl('per-song-a', 'qq')
      expect(url).toBe('https://dl.stream.qqmusic.qq.com/M800per-song-test.mp3')
      expect(getLastResolvedQuality('qq', 'per-song-a')).toBe('320')
      // 本曲没有的档位不再从其它歌曲泄漏（此前按平台记录：上一首的 SQ 会残留给只有 HQ 的新歌）
      expect(getLastResolvedQuality('qq', 'per-song-b')).toBeNull()
      expect(getLastResolvedQuality('netease', 'per-song-a')).toBeNull()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('platform vip state detection', () => {
  beforeEach(() => localStorage.clear())

  it('reads qq/netease vip flags maintained by the login flow', () => {
    localStorage.setItem('qq_vip', 'true')
    localStorage.setItem('netease_vip', 'false')
    expect(getPlatformVipState('qq')).toBe(true)
    expect(getPlatformVipState('netease')).toBe(false)
    expect(getPlatformVipState('apple')).toBe(false)
    expect(getPlatformVipState('spotify')).toBe(false)
  })

  it('derives soda vip from the entitlement tier', () => {
    localStorage.setItem('soda_entitlement', 'svip')
    expect(getPlatformVipState('soda')).toBe(true)
    localStorage.setItem('soda_entitlement', 'free')
    expect(getPlatformVipState('soda')).toBe(false)
    localStorage.setItem('soda_entitlement', 'unknown')
    expect(getPlatformVipState('soda')).toBe(false)
  })
})

describe('QQ 杜比全景声档位', () => {
  beforeEach(() => localStorage.clear())

  it('杜比出现在 QQ 音质选项里，并标注需会员', () => {
    const options = getQualityOptions('qq')
    const dolby = options.find(option => option.value === 'dolby')
    expect(dolby).toBeTruthy()
    expect(dolby?.label).toContain('杜比全景声')
    expect(dolby?.requiresVip).toBe(true)
  })

  it('杜比是 QQ 专属档：能写入 qq、不污染其它平台', () => {
    saveAudioQualitySettings({ qq: 'dolby' })
    expect(getAudioQualityPreference('qq')).toBe('dolby')
    // 其它平台读到该值一律回落（持久化层按平台白名单归一）
    saveAudioQualitySettings({ netease: 'dolby' as never })
    expect(getAudioQualityPreference('netease')).not.toBe('dolby')
  })

  it('档位显示名与会员档判定按官方口径', () => {
    expect(resolvedQualityDisplayName('qq', 'dolby')).toBe('杜比全景声（Atmos）')
    expect(resolvedQualityShortLabel('qq', 'dolby')).toBe('杜比')
    expect(isVipOnlyResolvedQuality('qq', 'dolby')).toBe(true)
  })
})

describe('QQ 超级会员专享高端档（杜比 / 臻品母带 / 臻品音质）', () => {
  beforeEach(() => localStorage.clear())

  it('三档都在 QQ 音质选项里并标注需会员', () => {
    const options = getQualityOptions('qq')
    for (const [value, keyword] of [['dolby', '杜比全景声'], ['master', '臻品母带'], ['atmos2', '臻品音质']] as const) {
      const option = options.find(item => item.value === value)
      expect(option, value).toBeTruthy()
      expect(option?.label).toContain(keyword)
      expect(option?.requiresVip).toBe(true)
    }
  })

  it('三档都是 QQ 专属：能写进 qq，写到其它平台会回落', () => {
    saveAudioQualitySettings({ qq: 'master' })
    expect(getAudioQualityPreference('qq')).toBe('master')
    saveAudioQualitySettings({ qq: 'atmos2' })
    expect(getAudioQualityPreference('qq')).toBe('atmos2')
    saveAudioQualitySettings({ netease: 'master' as never })
    expect(getAudioQualityPreference('netease')).not.toBe('master')
  })

  it('显示名 / 短标签 / 会员档判定齐全', () => {
    expect(resolvedQualityDisplayName('qq', 'master')).toBe('臻品母带4.0')
    expect(resolvedQualityDisplayName('qq', 'atmos2')).toBe('臻品音质2.0')
    expect(resolvedQualityShortLabel('qq', 'master')).toBe('母带')
    expect(resolvedQualityShortLabel('qq', 'atmos2')).toBe('臻品')
    expect(isVipOnlyResolvedQuality('qq', 'master')).toBe(true)
    expect(isVipOnlyResolvedQuality('qq', 'atmos2')).toBe(true)
  })
})

describe('档位会员级别标注（VIP=绿钻 / 超级会员）', () => {
  it('QQ：SQ 无损与 HQ 192k 标 VIP；杜比/母带/臻品标超级会员', () => {
    expect(getQualityTier('qq', 'lossless')).toBe('vip')
    expect(getQualityTier('qq', '192aac')).toBe('vip')
    expect(getQualityTier('qq', 'dolby')).toBe('svip')
    expect(getQualityTier('qq', 'master')).toBe('svip')
    expect(getQualityTier('qq', 'atmos2')).toBe('svip')
    // 注：QQ 的 Hi-Res 档没有独立选项（逐曲列表标"暂未支持"、无取流实现），不做断言
  })

  it('QQ：免费档不标会员', () => {
    expect(getQualityTier('qq', 'standard')).toBeUndefined()
    expect(getQualityTier('qq', 'high')).toBeUndefined()
    expect(getQualityTier('qq', '96aac')).toBeUndefined()
    expect(getQualityTier('qq', '48aac')).toBeUndefined()
  })

  it('超级会员状态按平台读取（qq_svip 落盘）', () => {
    localStorage.clear()
    expect(getPlatformSvipState('qq')).toBe(false)
    localStorage.setItem('qq_svip', 'true')
    expect(getPlatformSvipState('qq')).toBe(true)
  })
})

describe('QQ 超级会员识别（不把绿钻当超级会员）', () => {
  it('lvinfo 出现 svip 徽章才算超级会员', () => {
    expect(detectQQMusicSvip({ creator: { lvinfo: [{ iconurl: 'https://y.gtimg.cn/music/icon/v1/h5/svip7.png' }] } })).toBe(true)
    expect(detectQQMusicSvip({ creator: { lvinfo: [{ iconurl: 'https://y.gtimg.cn/music/icon/h5/sui7.png' }] } })).toBe(false)
    expect(detectQQMusicSvip({ creator: { nick: 'x' } })).toBe(false)
  })
})

describe('账号会员级别徽章（各模式账号区共用）', () => {
  beforeEach(() => localStorage.clear())

  it('超级会员优先于绿钻 VIP；都没有则无徽章', () => {
    expect(getAccountTierBadge('qq')).toBeNull()
    localStorage.setItem('qq_vip', 'true')
    expect(getAccountTierBadge('qq')).toEqual({ label: 'VIP', tone: 'vip' })
    localStorage.setItem('qq_svip', 'true')
    expect(getAccountTierBadge('qq')).toEqual({ label: '超级会员', tone: 'svip' })
  })

  it('调用方已有 vip 布尔值时以 svip 状态优先', () => {
    expect(getAccountTierBadge('qq', true)).toEqual({ label: 'VIP', tone: 'vip' })
    localStorage.setItem('qq_svip', 'true')
    expect(getAccountTierBadge('qq', true)).toEqual({ label: '超级会员', tone: 'svip' })
  })

  it('超级会员与 VIP 用不同底色（视觉可区分）', () => {
    expect(accountTierBadgeClass('svip')).not.toBe(accountTierBadgeClass('vip'))
  })
})

describe('网易云 9.5.x 音质面板口径（SVIP 三档 + VIP 三档）', () => {
  beforeEach(() => localStorage.clear())

  it('超级会员三档：沉浸环绕声 / 超清母带 / 臻音全景声', () => {
    const options = getQualityOptions('netease')
    for (const [value, keyword] of [['sky', '沉浸环绕声'], ['jymaster', '超清母带'], ['vivid', '臻音全景声']] as const) {
      const option = options.find(item => item.value === value)
      expect(option, value).toBeTruthy()
      expect(option?.label).toContain(keyword)
      expect(getQualityTier('netease', value)).toBe('svip')
    }
  })

  it('VIP 档：高清臻音 / 无损 / Hi-Res（极高与标准为免费档）', () => {
    for (const value of ['jyeffect', 'lossless', 'hi-res'] as const) {
      expect(getQualityTier('netease', value), value).toBe('vip')
    }
    expect(getQualityTier('netease', 'high')).toBeUndefined()
    expect(getQualityTier('netease', 'standard')).toBeUndefined()
  })

  it('网易云专属档不给其它平台（持久化层白名单）', () => {
    saveAudioQualitySettings({ netease: 'jymaster' })
    expect(getAudioQualityPreference('netease')).toBe('jymaster')
    saveAudioQualitySettings({ spotify: 'jymaster' as never })
    expect(getAudioQualityPreference('spotify')).not.toBe('jymaster')
    saveAudioQualitySettings({ qq: 'sky' as never })
    expect(getAudioQualityPreference('qq')).not.toBe('sky')
  })

  it('显示名按官方面板用词', () => {
    expect(resolvedQualityDisplayName('netease', 'sky')).toBe('沉浸环绕声（Surround Audio）')
    expect(resolvedQualityDisplayName('netease', 'jymaster')).toBe('超清母带（Master）')
    expect(resolvedQualityDisplayName('netease', 'vivid')).toBe('臻音全景声（Audio Vivid）')
    expect(resolvedQualityDisplayName('netease', 'jyeffect')).toBe('高清臻音（Spatial Audio）')
  })
})

describe('自动档与超级会员档的边界（用户口径：自动=普通VIP最高）', () => {
  beforeEach(() => localStorage.clear())

  it('网易云手动选 SVIP 档仍然成立（super vip 三档还在选项表里）', () => {
    const values = getQualityOptions('netease').map(option => option.value)
    expect(values).toContain('sky')
    expect(values).toContain('jymaster')
    expect(values).toContain('vivid')
  })

  it('auto 档在选项表里各平台都有（自动=账号可用最高由服务端定档）', () => {
    for (const platform of ['netease', 'qq', 'soda'] as const) {
      expect(getQualityOptions(platform)[0]?.value).toBe('auto')
    }
  })
})
