/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest'
import { RESONANCE_SETTINGS_DEFAULTS, RESONANCE_SETTING_KEYS, readResonanceSettings, setResonanceSetting } from '../src/features/resonance/settings'

describe('共振设置读写', () => {
  beforeEach(() => localStorage.clear())

  it('没有任何存储时返回默认值（尤其是人数上限不能变成 0/2）', () => {
    const settings = readResonanceSettings()
    expect(settings.maxMembers).toBe(RESONANCE_SETTINGS_DEFAULTS.maxMembers)
    expect(settings.maxMembers).toBe(15)
    expect(settings.port).toBe(RESONANCE_SETTINGS_DEFAULTS.port)
    expect(settings.pushLimit).toBe(RESONANCE_SETTINGS_DEFAULTS.pushLimit)
    expect(settings.quota).toBe(RESONANCE_SETTINGS_DEFAULTS.quota)
    expect(settings.defaultMode).toBe('party')
    expect(settings.joinBehavior).toBe('resume')
    expect(settings.onlyPlayable).toBe(true)
    expect(settings.allowMemberControl).toBe(false)
    expect(settings.lanDiscovery).toBe(true)
    expect(settings.showBadges).toBe(true)
  })

  it('空字符串按「没设置」处理，不会被 Number("") 当成 0', () => {
    localStorage.setItem(RESONANCE_SETTING_KEYS.maxMembers, '')
    localStorage.setItem(RESONANCE_SETTING_KEYS.port, '')
    expect(readResonanceSettings().maxMembers).toBe(15)
    expect(readResonanceSettings().port).toBe(RESONANCE_SETTINGS_DEFAULTS.port)
  })

  it('人数上限被夹在 2–15，非法输入回落到默认', () => {
    localStorage.setItem(RESONANCE_SETTING_KEYS.maxMembers, '99')
    expect(readResonanceSettings().maxMembers).toBe(15)
    localStorage.setItem(RESONANCE_SETTING_KEYS.maxMembers, '1')
    expect(readResonanceSettings().maxMembers).toBe(2)
    localStorage.setItem(RESONANCE_SETTING_KEYS.maxMembers, 'abc')
    expect(readResonanceSettings().maxMembers).toBe(15)
  })

  it('端口非法时回落默认，合法时保留', () => {
    localStorage.setItem(RESONANCE_SETTING_KEYS.port, '80')
    expect(readResonanceSettings().port).toBe(RESONANCE_SETTINGS_DEFAULTS.port)
    localStorage.setItem(RESONANCE_SETTING_KEYS.port, '26000')
    expect(readResonanceSettings().port).toBe(26000)
  })

  it('推送上限只接受 100/200/500', () => {
    localStorage.setItem(RESONANCE_SETTING_KEYS.pushLimit, '300')
    expect(readResonanceSettings().pushLimit).toBe(200)
    localStorage.setItem(RESONANCE_SETTING_KEYS.pushLimit, '500')
    expect(readResonanceSettings().pushLimit).toBe(500)
  })

  it('模式与入房行为只接受白名单值', () => {
    localStorage.setItem(RESONANCE_SETTING_KEYS.defaultMode, 'hack')
    localStorage.setItem(RESONANCE_SETTING_KEYS.joinBehavior, 'hack')
    expect(readResonanceSettings().defaultMode).toBe('party')
    expect(readResonanceSettings().joinBehavior).toBe('resume')
    localStorage.setItem(RESONANCE_SETTING_KEYS.defaultMode, 'round-robin')
    localStorage.setItem(RESONANCE_SETTING_KEYS.joinBehavior, 'next')
    expect(readResonanceSettings().defaultMode).toBe('round-robin')
    expect(readResonanceSettings().joinBehavior).toBe('next')
  })

  it('写入走同一个键与事件（设置镜像同源）', () => {
    const events: string[] = []
    const listener = (event: Event) => events.push(event.type)
    window.addEventListener('waveforge:resonance-settings-changed', listener)
    window.addEventListener('waveforge:global-setting-changed', listener)
    setResonanceSetting('maxMembers', 8)
    window.removeEventListener('waveforge:resonance-settings-changed', listener)
    window.removeEventListener('waveforge:global-setting-changed', listener)
    expect(localStorage.getItem(RESONANCE_SETTING_KEYS.maxMembers)).toBe('8')
    expect(events).toContain('waveforge:resonance-settings-changed')
    // 镜像事件名与设置中心一致，保证别处的设置页能同步刷新
    expect(events).toContain('waveforge:global-setting-changed')
  })

  it('新增的外观/身份设置都有默认值，且非法输入不会污染房间', () => {
    const settings = readResonanceSettings()
    expect(settings.nicknameSource).toBe('platform')
    expect(settings.showAvatars).toBe(true)
    expect(settings.partyQuota).toBe(3)
    expect(settings.background).toBe('cover')
    expect(settings.backgroundBlur).toBe(RESONANCE_SETTINGS_DEFAULTS.backgroundBlur)
    expect(settings.backgroundDim).toBe(RESONANCE_SETTINGS_DEFAULTS.backgroundDim)
    expect(settings.accent).toMatch(/^#[0-9a-f]{6}$/i)

    localStorage.setItem(RESONANCE_SETTING_KEYS.background, 'hack')
    localStorage.setItem(RESONANCE_SETTING_KEYS.nicknameSource, 'hack')
    localStorage.setItem(RESONANCE_SETTING_KEYS.backgroundBlur, '999')
    localStorage.setItem(RESONANCE_SETTING_KEYS.backgroundDim, '-5')
    const guarded = readResonanceSettings()
    expect(guarded.background).toBe('cover')
    expect(guarded.nicknameSource).toBe('platform')
    expect(guarded.backgroundBlur).toBe(80)
    expect(guarded.backgroundDim).toBe(0)
  })

  it('设置中心镜像包含共振的全部新设置（同键同事件）', async () => {
    const { GLOBAL_SETTINGS_GROUPS } = await import('../src/services/globalSettingsRegistry')
    const ids = GLOBAL_SETTINGS_GROUPS.flatMap(group => group.entries.map(entry => entry.id))
    for (const id of [
      'resonanceNicknameSource', 'resonanceShowAvatars', 'resonancePartyQuota',
      'resonanceBackground', 'resonanceBackgroundBlur', 'resonanceBackgroundDim', 'resonanceAccent',
      // 这几项此前只在模式内可改，与设置面板「同样出现在设置→网络」的说法不符
      'resonanceDefaultMode', 'resonanceQuota', 'resonancePort',
    ]) {
      expect(ids, `设置中心缺少 ${id}`).toContain(id)
    }
  })

  it('镜像读侧把平台 id 归一成 platform（否则镜像里两档都不高亮）', async () => {
    const { GLOBAL_SETTINGS_GROUPS } = await import('../src/services/globalSettingsRegistry')
    const entry = GLOBAL_SETTINGS_GROUPS.flatMap(group => group.entries).find(item => item.id === 'resonanceNicknameSource')!
    // 在房间里选了 QQ（存的是平台 id），镜像只提供 platform/custom 两档 → 必须读成 platform
    localStorage.setItem(RESONANCE_SETTING_KEYS.nicknameSource, 'qq')
    expect(entry.read()).toBe('platform')
    localStorage.setItem(RESONANCE_SETTING_KEYS.nicknameSource, 'custom')
    expect(entry.read()).toBe('custom')
  })

  it('镜像写侧对 partyQuota / pushLimit 做白名单校验（不产生界面显示不出的值）', async () => {
    const { GLOBAL_SETTINGS_GROUPS } = await import('../src/services/globalSettingsRegistry')
    const entries = GLOBAL_SETTINGS_GROUPS.flatMap(group => group.entries)
    const partyQuota = entries.find(item => item.id === 'resonancePartyQuota')!
    // 合法档位照写（8 是模式内设置面板提供的档位，镜像必须也认）
    partyQuota.write!('8')
    expect(readResonanceSettings().partyQuota).toBe(8)
    // 非法值不写入，避免出现「设了 7、读回 3」的错位
    partyQuota.write!('7')
    expect(readResonanceSettings().partyQuota).toBe(8)

    const pushLimit = entries.find(item => item.id === 'resonancePushLimit')!
    pushLimit.write!('500')
    expect(readResonanceSettings().pushLimit).toBe(500)
    pushLimit.write!('300')
    expect(readResonanceSettings().pushLimit).toBe(500)
  })
})

describe('回归：昵称来源必须是平台 id（不是只认 platform 字样）', () => {
  beforeEach(() => localStorage.clear())

  it('存平台 id 时原样读回，不会被回落成默认而让界面跳回第一个平台', () => {
    // 界面点芯片写入的是真实平台 id；旧实现只放行 'custom' | 'platform'，
    // 于是 'qq' 被当成非法值回落到默认 → 界面又显示成列表里第一个平台（网易云）
    for (const platform of ['netease', 'qq', 'apple', 'kugou', 'soda', 'spotify']) {
      localStorage.setItem(RESONANCE_SETTING_KEYS.nicknameSource, platform)
      expect(readResonanceSettings().nicknameSource).toBe(platform)
    }
  })

  it('自定义与非法值：custom 保留，乱码回落默认', () => {
    localStorage.setItem(RESONANCE_SETTING_KEYS.nicknameSource, 'custom')
    expect(readResonanceSettings().nicknameSource).toBe('custom')
    localStorage.setItem(RESONANCE_SETTING_KEYS.nicknameSource, 'not-a-platform')
    expect(readResonanceSettings().nicknameSource).toBe(RESONANCE_SETTINGS_DEFAULTS.nicknameSource)
  })
})
