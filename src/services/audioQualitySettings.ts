import type { MusicPlatform } from './platforms'
import type { EntitlementTier } from '../utils/musicEntitlements'

export type AudioQualityPreference =
  | 'auto'
  | 'standard'
  | 'high'
  | 'very-high'
  | 'lossless'
  | 'hi-res'
  // QQ 专属 AAC 档（192k/96k/48k，官方客户端的逐曲可选档位；服务端已实现 C600/C400/C200 取流前缀）
  | '192aac'
  | '96aac'
  | '48aac'
  // 网易云专属档（9.5.x 官方面板口径，见「当前歌曲音质」面板）：
  //   超级会员：sky 沉浸环绕声（Surround Audio 5.1）/ jymaster 超清母带（Master 192kHz·24bit）
  //            / vivid 臻音全景声（Audio Vivid 7.1）；VIP：jyeffect 高清臻音（Spatial Audio 96kHz·24bit）
  | 'jyeffect'
  | 'sky'
  | 'jymaster'
  | 'vivid'
  // QQ 超级会员专享高端档（独立音轨，需超级会员）：
  //   dolby  杜比全景声   D004{档位mid}.mp4
  //   master 臻品母带4.0  AI00{档位mid}.flac
  //   atmos2 臻品音质2.0  Q000{档位mid}.flac
  | 'dolby'
  | 'master'
  | 'atmos2'

export type AppleAudioQualityPreference =
  | 'auto'
  | 'aac'
  | 'lossless'
  | 'hi-res-lossless'
  | 'atmos'

export interface AudioQualitySettings {
  netease: AudioQualityPreference
  qq: AudioQualityPreference
  spotify: AudioQualityPreference
  kugou: AudioQualityPreference
  soda: AudioQualityPreference
  apple: AppleAudioQualityPreference
}

export const AUDIO_QUALITY_SETTINGS_KEY = 'audioQualitySettings'
export const AUDIO_QUALITY_SETTINGS_EVENT = 'waveforge-audio-quality-changed'

export const DEFAULT_AUDIO_QUALITY_SETTINGS: AudioQualitySettings = {
  netease: 'auto',
  qq: 'auto',
  spotify: 'auto',
  kugou: 'auto',
  soda: 'auto',
  apple: 'auto',
}

const QUALITY_VALUES: AudioQualityPreference[] = [
  'auto',
  'standard',
  'high',
  'very-high',
  'lossless',
  'hi-res',
  '192aac',
  '96aac',
  '48aac',
  'dolby',
  'master',
  'atmos2',
  'jyeffect',
  'sky',
  'jymaster',
  'vivid',
]

/** QQ 专属档（AAC 三档 + 杜比全景声）：只有 qq 平台允许持久化，其余平台读到/写入时回落默认。 */
const QQ_ONLY_QUALITY_VALUES: AudioQualityPreference[] = ['192aac', '96aac', '48aac', 'dolby', 'master', 'atmos2']
/** 网易云专属档（沉浸环绕声/超清母带/臻音全景声/高清臻音）：只有 netease 平台允许持久化。 */
const NETEASE_ONLY_QUALITY_VALUES: AudioQualityPreference[] = ['jyeffect', 'sky', 'jymaster', 'vivid']

const APPLE_QUALITY_VALUES: AppleAudioQualityPreference[] = [
  'auto',
  'aac',
  'lossless',
  'hi-res-lossless',
  'atmos',
]

const isQualityPreference = (value: unknown): value is AudioQualityPreference => (
  typeof value === 'string' && QUALITY_VALUES.includes(value as AudioQualityPreference)
)

const isAppleQualityPreference = (value: unknown): value is AppleAudioQualityPreference => (
  typeof value === 'string' && APPLE_QUALITY_VALUES.includes(value as AppleAudioQualityPreference)
)

export function loadAudioQualitySettings(): AudioQualitySettings {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_AUDIO_QUALITY_SETTINGS }

  try {
    const parsed = JSON.parse(localStorage.getItem(AUDIO_QUALITY_SETTINGS_KEY) || '{}') as Partial<AudioQualitySettings>
    // 平台专属档读到其它平台（历史脏数据/人工改写）时回落默认，避免带着无效档位请求：
    //   QQ 专属（AAC 三档 + 杜比/臻品母带/臻品音质）不给别的平台；
    //   网易云专属（沉浸环绕声/超清母带/臻音全景声/高清臻音）只给网易云。
    const readForNetease = (value: unknown): AudioQualityPreference => (
      isQualityPreference(value) && !(QQ_ONLY_QUALITY_VALUES as string[]).includes(value) ? value : 'auto'
    )
    const readShared = (value: unknown): AudioQualityPreference => (
      isQualityPreference(value)
      && !(QQ_ONLY_QUALITY_VALUES as string[]).includes(value)
      && !(NETEASE_ONLY_QUALITY_VALUES as string[]).includes(value)
        ? value
        : 'auto'
    )
    return {
      netease: readForNetease(parsed.netease),
      qq: isQualityPreference(parsed.qq) && !(NETEASE_ONLY_QUALITY_VALUES as string[]).includes(parsed.qq)
        ? parsed.qq
        : DEFAULT_AUDIO_QUALITY_SETTINGS.qq,
      spotify: readShared(parsed.spotify),
      kugou: readShared(parsed.kugou),
      soda: readShared(parsed.soda),
      apple: isAppleQualityPreference(parsed.apple) ? parsed.apple : DEFAULT_AUDIO_QUALITY_SETTINGS.apple,
    }
  } catch {
    return { ...DEFAULT_AUDIO_QUALITY_SETTINGS }
  }
}

export function saveAudioQualitySettings(patch: Partial<AudioQualitySettings>): AudioQualitySettings {
  const next = {
    ...loadAudioQualitySettings(),
    ...patch,
  }
  const resetForNetease = (value: AudioQualityPreference): AudioQualityPreference => (
    (QQ_ONLY_QUALITY_VALUES as string[]).includes(value) ? 'auto' : value
  )
  const resetShared = (value: AudioQualityPreference): AudioQualityPreference => (
    (QQ_ONLY_QUALITY_VALUES as string[]).includes(value) || (NETEASE_ONLY_QUALITY_VALUES as string[]).includes(value)
      ? 'auto'
      : value
  )
  if (!isQualityPreference(next.netease)) next.netease = DEFAULT_AUDIO_QUALITY_SETTINGS.netease
  else next.netease = resetForNetease(next.netease)
  if (!isQualityPreference(next.qq)) next.qq = DEFAULT_AUDIO_QUALITY_SETTINGS.qq
  else if ((NETEASE_ONLY_QUALITY_VALUES as string[]).includes(next.qq)) next.qq = DEFAULT_AUDIO_QUALITY_SETTINGS.qq
  if (!isQualityPreference(next.spotify)) next.spotify = DEFAULT_AUDIO_QUALITY_SETTINGS.spotify
  else next.spotify = resetShared(next.spotify)
  if (!isQualityPreference(next.kugou)) next.kugou = DEFAULT_AUDIO_QUALITY_SETTINGS.kugou
  else next.kugou = resetShared(next.kugou)
  if (!isQualityPreference(next.soda)) next.soda = DEFAULT_AUDIO_QUALITY_SETTINGS.soda
  else next.soda = resetShared(next.soda)
  if (!isAppleQualityPreference(next.apple)) next.apple = DEFAULT_AUDIO_QUALITY_SETTINGS.apple

  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(AUDIO_QUALITY_SETTINGS_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(AUDIO_QUALITY_SETTINGS_EVENT, { detail: next }))
  }
  return next
}

export function getAudioQualityPreference(platform: MusicPlatform): AudioQualityPreference | AppleAudioQualityPreference {
  const settings = loadAudioQualitySettings()
  if (platform === 'apple') return settings.apple
  if (platform === 'spotify') return settings.spotify
  if (platform === 'kugou') return settings.kugou
  if (platform === 'soda') return settings.soda
  return settings[platform as 'netease' | 'qq']
}

export function getPlatformVipState(platform: MusicPlatform): boolean {
  if (typeof localStorage === 'undefined') return false
  if (platform === 'apple' || platform === 'spotify') return false
  if (platform === 'soda') {
    const tier = getSodaEntitlementTier()
    return tier === 'vip' || tier === 'svip'
  }
  if (platform === 'kugou') return localStorage.getItem('kugou_vip') === 'true'
  return localStorage.getItem(platform === 'netease' ? 'netease_vip' : 'qq_vip') === 'true'
}

export function getAudioQualityRequest(platform: MusicPlatform): {
  preference: AudioQualityPreference | AppleAudioQualityPreference
  isVip: boolean
} {
  return {
    preference: getAudioQualityPreference(platform),
    isVip: getPlatformVipState(platform),
  }
}

// ── 音质档位选项表（设置弹窗与播放条快捷切换共用同一份事实源）──
// shortLabel 供播放条小按钮/弹层使用（短名，如 杜比全景声 →「杜比」）；
// label/description 供设置弹窗使用。

export type QualityOptionValue = AudioQualityPreference | AppleAudioQualityPreference

export interface QualityOption {
  value: QualityOptionValue
  label: string
  shortLabel: string
  description: string
  /** 需要会员（金色显示 + 非会员加皇冠）。与 tier 同源，保留以兼容存量调用方。 */
  requiresVip?: boolean
  /**
   * 会员档位（与 QQ 官方客户端一致的两级标注）：
   *   'vip'  = 绿钻（豪华绿钻）：SQ 无损 / HQ 高品(192k AAC) / 网易云无损等
   *   'svip' = 超级会员：杜比全景声 / 臻品母带4.0 / 臻品音质2.0 / Hi-Res 等
   * 未设置 = 免费档（标准 / 流畅 / 省流 / 320k HQ）。
   */
  tier?: 'vip' | 'svip'
  disabled?: boolean
}

const NETEASE_OPTIONS: QualityOption[] = [
  // 档位名与官方 9.5.x「当前歌曲音质」面板逐条对齐（含超级会员三档与 VIP 三档的徽章区分）
  { value: 'auto', label: '自动最高音质', shortLabel: '自动', description: '按当前账号权限和歌曲可用性，自动选到账号可用的最高音质' },
  { value: 'sky', label: '沉浸环绕声（Surround Audio）', shortLabel: '环绕声', description: '环绕音感，最高 5.1 声道', requiresVip: true, tier: 'svip' },
  { value: 'jymaster', label: '超清母带（Master）', shortLabel: '母带', description: '极致细节，192kHz/24bit', requiresVip: true, tier: 'svip' },
  { value: 'vivid', label: '臻音全景声（Audio Vivid）', shortLabel: '全景声', description: '沉浸三维空间音频，最高 7.1 声道', requiresVip: true, tier: 'svip' },
  { value: 'jyeffect', label: '高清臻音（Spatial Audio）', shortLabel: '臻音', description: '高频细节还原与清新沉浸感，96kHz/24bit', requiresVip: true, tier: 'vip' },
  { value: 'standard', label: '标准（128k）', shortLabel: '标准', description: '兼容性最好，流量占用较低' },
  { value: 'high', label: '极高（320k）', shortLabel: '极高', description: '网易云 exhigh，320 kbps' },
  { value: 'lossless', label: '无损（FLAC）', shortLabel: '无损', description: 'FLAC 无损，码率随曲目浮动（约 1024k）', requiresVip: true, tier: 'vip' },
  { value: 'hi-res', label: 'Hi-Res 无损（192k）', shortLabel: 'Hi-Res', description: '高解析度无损（24bit/192k）', requiresVip: true, tier: 'vip' },
]

const QQ_OPTIONS: QualityOption[] = [
  { value: 'auto', label: '自动最高音质', shortLabel: '自动', description: '按当前账号权限和歌曲可用性，自动选到账号可用的最高音质' },
  // 档位名对齐 QQ 音乐官方（SQ 无损 / HQ 高品 / 标准 / 流畅 / 省流），括号标注标称码率；
  // 192k/96k/48k AAC 是逐曲文件级档位，官方不单列名称，按所属官方档归类
  { value: 'lossless', label: 'SQ 无损（1024k）', shortLabel: 'SQ', description: 'FLAC 无损（官方 SQ 档），码率随曲目浮动（约 1024k）', requiresVip: true, tier: 'vip' },
  { value: 'high', label: 'HQ 高品（320k）', shortLabel: 'HQ', description: '320 kbps MP3（官方 HQ 档）' },
  { value: '192aac', label: 'HQ 高品（192k）', shortLabel: 'HQ', description: '192 kbps AAC（同属官方 HQ 档）', requiresVip: true, tier: 'vip' },
  { value: 'standard', label: '标准（128k）', shortLabel: '标准', description: '128 kbps MP3（官方标准品质）' },
  { value: '96aac', label: '流畅（96k）', shortLabel: '流畅', description: '96 kbps AAC 省流档（官方流畅音质）' },
  { value: '48aac', label: '省流（48k）', shortLabel: '省流', description: '48 kbps AAC 省流档（官方低品质）' },
  // 杜比全景声：本曲元数据带 size_dolby 才在逐曲菜单出现（见 PlayerControls 的 qualityLevels 映射）
  { value: 'dolby', label: '杜比全景声（Atmos）', shortLabel: '杜比', description: '杜比全景声独立音轨（超级会员专享；取不到时自动回落可用档位）', requiresVip: true, tier: 'svip' },
  { value: 'master', label: '臻品母带4.0', shortLabel: '母带', description: '臻品母带音轨（超级会员专享；取不到时自动回落可用档位）', requiresVip: true, tier: 'svip' },
  { value: 'atmos2', label: '臻品音质2.0', shortLabel: '臻品', description: '臻品音质/全景声音轨（超级会员专享；取不到时自动回落可用档位）', requiresVip: true, tier: 'svip' },
]

/**
 * 档位的会员级别（与 QQ 官方客户端的两级标注一致）：
 *   'vip'  绿钻：「VIP」金字 + 皇冠
 *   'svip' 超级会员：「超级会员」金字 + 皇冠
 *   undefined 免费档，不标任何会员信息。
 * QQ 侧口径（2026-10-08 对齐官方客户端）：
 *   SQ 无损 / HQ 高品(192k AAC) → VIP；杜比全景声 / 臻品母带4.0 / 臻品音质2.0 / Hi-Res → 超级会员。
 */
export function getQualityTier(platform: MusicPlatform, value: QualityOptionValue): 'vip' | 'svip' | undefined {
  const options = platform === 'apple' ? APPLE_OPTIONS : platform === 'qq' ? QQ_OPTIONS : platform === 'netease' ? NETEASE_OPTIONS : GENERIC_OPTIONS
  const hit = options.find(option => option.value === value)
  if (hit?.tier) return hit.tier
  if (!hit?.requiresVip) return undefined
  // 兜底：只声明了 requiresVip 的老选项按绿钻渲染（不夸大成超级会员）
  return 'vip'
}

/** 新平台音质选项（自身直源受限时走网易云/QQ 载体音质） */
const GENERIC_OPTIONS: QualityOption[] = [
  { value: 'auto', label: '自动最高音质', shortLabel: '自动', description: '按当前账号权限和歌曲可用性，自动选到账号可用的最高音质' },
  { value: 'standard', label: '标准（128k）', shortLabel: '标准', description: '优先使用标准码率音源' },
  { value: 'high', label: '高品（320k）', shortLabel: '高品', description: '优先使用高码率音源（约 320 kbps 档）' },
  { value: 'lossless', label: '无损（FLAC）', shortLabel: '无损', description: '优先请求无损音质', requiresVip: true },
]

const APPLE_OPTIONS: QualityOption[] = [
  { value: 'auto', label: '自动', shortLabel: '自动', description: '优先使用当前设备和账号实际可播放的最佳 Apple Music 音频' },
  { value: 'aac', label: 'AAC（256k）', shortLabel: 'AAC', description: '使用 Apple 网页播放当前稳定支持的 256 kbps AAC HLS 音频' },
  { value: 'lossless', label: '无损（ALAC）', shortLabel: '无损', description: '当前网页 Widevine 播放链路尚未检测到可用的 Apple Lossless 资产', disabled: true },
  { value: 'hi-res-lossless', label: '高解析度无损（24bit 192k）', shortLabel: '高解析无损', description: '需要 Apple 提供兼容资产和当前设备具备对应解码能力', disabled: true },
  { value: 'atmos', label: '杜比全景声（Atmos）', shortLabel: '杜比', description: '曲目标签不等于可播放流；检测到兼容 Atmos 资产后才会开放', disabled: true },
]

/**
 * 汽水音质选项（按会员档位禁用不可用档）：
 * - 后端 /api/soda/song/url 的选档枚举为 standard|high|lossless|hires（free<vip<svip 闸门内就近落档）；
 * - 偏好值仍存 AudioQualityPreference（'hi-res'），下发时经 mapSodaQualityParam 映射为 'hires'；
 * - 会员状态读 localStorage['soda_entitlement']（App 登录流程落盘的 EntitlementTier）：
 *   free → 无损/Hi-Res 禁用（明确不可用）；vip/svip → 全开放；unknown（未登录/档位未知）→
 *   不禁用（未知 ≠ 不可用，后端会自动落低档），仅以皇冠标注会员档。
 */
const buildSodaOptions = (isVip: boolean, tierKnown: boolean): QualityOption[] => [
  { value: 'auto', label: '自动最高音质', shortLabel: '自动', description: '按账号会员档位和歌曲可用性就近选档，无需手动切换' },
  { value: 'standard', label: '标准（128k）', shortLabel: '标准', description: '优先使用标准码率音源，流量占用较低' },
  { value: 'high', label: '高品（320k）', shortLabel: '高品', description: '优先使用高码率音源（约 320 kbps 档）' },
  { value: 'lossless', label: '无损（FLAC）', shortLabel: '无损', description: '优先请求无损音质；非会员自动落低档', requiresVip: true, disabled: tierKnown && !isVip },
  { value: 'hi-res', label: 'Hi-Res（192k）', shortLabel: 'Hi-Res', description: '优先请求 Hi-Res 音质；非会员自动落低档', requiresVip: true, disabled: tierKnown && !isVip },
]

/** 读取汽水会员档位（App 登录流程落盘） */
export function getSodaEntitlementTier(): EntitlementTier {
  if (typeof localStorage === 'undefined') return 'unknown'
  return (localStorage.getItem('soda_entitlement') as EntitlementTier | null) || 'unknown'
}

/** 按平台取音质档位选项（设置弹窗 / 播放条快捷切换共用） */
export function getQualityOptions(platform: MusicPlatform): QualityOption[] {
  if (platform === 'apple') return APPLE_OPTIONS
  if (platform === 'qq') return QQ_OPTIONS
  if (platform === 'netease') return NETEASE_OPTIONS
  if (platform === 'soda') {
    const tier = getSodaEntitlementTier()
    return buildSodaOptions(tier === 'vip' || tier === 'svip', tier !== 'unknown')
  }
  return GENERIC_OPTIONS
}

/** 服务端「实际解析档」原始值 → 官方档位显示名（本曲列表补挂漏档时用）。
 *  QQ 的 actualQuality 是内部质量名；网易云是 eapi 的 level 枚举。未知值原样返回。 */
export function resolvedQualityDisplayName(platform: MusicPlatform, value: string): string {
  if (platform === 'qq') {
    switch (value) {
      case 'flac':
      case 'ape':
        return 'SQ 无损（1024k）'
      case '320':
        return 'HQ 高品（320k）'
      case '192aac':
        return 'HQ 高品（192k）'
      case '128':
        return '标准（128k）'
      case '96aac':
      case 'm4a':
        return '流畅（96k）'
      case '48aac':
        return '省流（48k）'
      case 'dolby':
        return '杜比全景声（Atmos）'
      case 'master':
        return '臻品母带4.0'
      case 'atmos2':
        return '臻品音质2.0'
      default:
        return value
    }
  }
  if (platform === 'netease') {
    switch (value) {
      case 'standard':
        return '标准（128k）'
      case 'higher':
        return '较高（192k）'
      case 'exhigh':
        return '极高（320k）'
      case 'lossless':
        return '无损（FLAC）'
      case 'hires':
        return 'Hi-Res 无损（192k）'
      case 'jyeffect':
        return '高清臻音（Spatial Audio）'
      case 'sky':
        return '沉浸环绕声（Surround Audio）'
      case 'jymaster':
        return '超清母带（Master）'
      case 'vivid':
        return '臻音全景声（Audio Vivid）'
      case 'dolby':
        return '杜比全景声'
      default:
        return value
    }
  }
  return value
}

/** 服务端「实际解析档」原始值 → 播放条徽标/「自动（…）」括号短名。
 *  短名词表：SQ / HQ / 标准 / 流畅 / 省流（QQ），无损 / Hi-Res / 臻音…（网易云）。
 *  未知原始值回落「自动」。 */
export function resolvedQualityShortLabel(platform: MusicPlatform, value: string): string {
  if (platform === 'qq') {
    switch (value) {
      case 'flac':
      case 'ape':
        return 'SQ'
      case '320':
      case '192aac':
        return 'HQ'
      case '128':
        return '标准'
      case '96aac':
      case 'm4a':
        return '流畅'
      case '48aac':
        return '省流'
      case 'dolby':
        return '杜比'
      case 'master':
        return '母带'
      case 'atmos2':
        return '臻品'
      default:
        return '自动'
    }
  }
  if (platform === 'netease') {
    switch (value) {
      case 'standard':
        return '标准'
      case 'higher':
        return '较高'
      case 'exhigh':
        return '极高'
      case 'lossless':
        return '无损'
      case 'hires':
        return 'Hi-Res'
      case 'jyeffect':
        return '臻音'
      case 'sky':
        return '沉浸'
      case 'jymaster':
        return '母带'
      case 'dolby':
        return '杜比'
      default:
        return '自动'
    }
  }
  return '自动'
}

/**
 * 当前账号是否 超级会员（目前只有 QQ 有这一级；登录链路把识别结果落到 `qq_svip`）。
 * 用于音质弹层区分「VIP（绿钻）」与「超级会员」两种标注。
 */
export function getPlatformSvipState(platform: MusicPlatform): boolean {
  try {
    return localStorage.getItem(`${platform}_svip`) === 'true'
  } catch {
    return false
  }
}

/** 实际在播档是否属于会员专享档（决定「自动（…）」行是否按会员档渲染：金字 / 非会员加皇冠）。 */
export function isVipOnlyResolvedQuality(platform: MusicPlatform, value: string): boolean {
  if (platform === 'qq') {
    return value === 'flac' || value === 'ape' || value === '192aac'
      || value === 'dolby' || value === 'master' || value === 'atmos2'
  }
  if (platform === 'netease') {
    return value === 'lossless' || value === 'hires' || value === 'jyeffect'
      || value === 'sky' || value === 'jymaster' || value === 'vivid' || value === 'dolby'
  }
  return false
}

/** 当前偏好在某平台下的短标签（播放条按钮显示用；未知档按自动处理） */
export function getQualityShortLabel(platform: MusicPlatform, preference: QualityOptionValue): string {
  const options = getQualityOptions(platform)
  return options.find(option => option.value === preference)?.shortLabel ?? options[0].shortLabel
}

/** 读取某平台当前偏好值（音质快捷按钮显示用；键映射与 getAudioQualityPreference 相同） */
export function getPlatformQualityPreference(platform: MusicPlatform): QualityOptionValue {
  const settings = loadAudioQualitySettings()
  if (platform === 'apple') return settings.apple
  if (platform === 'spotify') return settings.spotify
  if (platform === 'kugou') return settings.kugou
  if (platform === 'soda') return settings.soda
  return settings[platform as 'netease' | 'qq']
}
