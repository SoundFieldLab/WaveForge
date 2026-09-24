/**
 * 共振设置：集中读写（localStorage + 统一事件），供共振模式内设置面板与「设置中心 → 网络」镜像共用。
 * 约定（AGENTS.md）：镜像设置必须「同键同事件」，因此所有写入都走这里的 setResonanceSetting。
 */
import type { ResonanceMode } from './model'
import {
  RESONANCE_MAX_MEMBERS,
  RESONANCE_PARTY_QUOTA_DEFAULT,
  RESONANCE_PARTY_QUOTA_RANGE,
  RESONANCE_PUSH_LIMIT_CHOICES,
  RESONANCE_PUSH_LIMIT_DEFAULT,
  clampPartyQuota,
  clampQuota,
} from './model'

export const RESONANCE_SETTINGS_EVENT = 'waveforge:resonance-settings-changed'

/** 能当房间身份的平台（与 identityCandidates 的顺序一致，'platform' 是历史默认值） */
const IDENTITY_PLATFORMS = ['netease', 'qq', 'apple', 'spotify', 'kugou', 'soda'] as const

export const RESONANCE_SETTING_KEYS = {
  nickname: 'waveforge:resonance-nickname',
  defaultMode: 'waveforge:resonance-default-mode',
  quota: 'waveforge:resonance-quota',
  partyQuota: 'waveforge:resonance-party-quota',
  nicknameSource: 'waveforge:resonance-nickname-source',
  showAvatars: 'waveforge:resonance-show-avatars',
  background: 'waveforge:resonance-background',
  backgroundImage: 'waveforge:resonance-background-image',
  backgroundBlur: 'waveforge:resonance-background-blur',
  backgroundDim: 'waveforge:resonance-background-dim',
  accent: 'waveforge:resonance-accent',
  pushLimit: 'waveforge:resonance-push-limit',
  onlyPlayable: 'waveforge:resonance-only-playable',
  joinBehavior: 'waveforge:resonance-join-behavior',
  allowMemberControl: 'waveforge:resonance-allow-member-control',
  lanDiscovery: 'waveforge:resonance-lan-discovery',
  port: 'waveforge:resonance-port',
  showBadges: 'waveforge:resonance-show-badges',
  maxMembers: 'waveforge:resonance-max-members',
  /** 进入共振前的模式：崩溃/关闭时停在共振也能回到原来的模式 */
  entryMode: 'waveforge:resonance-entry-mode',
} as const

export interface ResonanceSettings {
  nickname: string
  defaultMode: ResonanceMode
  quota: number
  /** Party 模式每人整场可加歌数 */
  partyQuota: number
  /** 昵称来源：platform = 用某个平台的昵称；custom = 自定义 */
  nicknameSource: string
  /** 房间内显示成员头像（平台公开头像） */
  showAvatars: boolean
  /** 背景：cover = 跟随封面；aurora = 极光渐变；light = 浅色；image = 自定义图片 */
  background: 'cover' | 'aurora' | 'light' | 'image'
  backgroundImage: string
  backgroundBlur: number
  backgroundDim: number
  accent: string
  pushLimit: number
  onlyPlayable: boolean
  joinBehavior: 'resume' | 'next'
  allowMemberControl: boolean
  lanDiscovery: boolean
  port: number
  showBadges: boolean
  maxMembers: number
  /** 进入共振之前所处的模式（用于下次启动时恢复，而不是永远停在共振） */
  entryMode: string
}

export const RESONANCE_SETTINGS_DEFAULTS: ResonanceSettings = {
  nickname: '',
  defaultMode: 'party',
  quota: 2,
  partyQuota: RESONANCE_PARTY_QUOTA_DEFAULT,
  nicknameSource: 'platform',
  showAvatars: true,
  background: 'cover',
  backgroundImage: '',
  backgroundBlur: 42,
  backgroundDim: 46,
  accent: '#ff5a70',
  pushLimit: RESONANCE_PUSH_LIMIT_DEFAULT,
  onlyPlayable: true,
  joinBehavior: 'resume',
  allowMemberControl: false,
  lanDiscovery: true,
  port: 25570,
  showBadges: true,
  maxMembers: RESONANCE_MAX_MEMBERS,
  entryMode: '',
}

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    return raw === null ? fallback : raw === 'true'
  } catch {
    return fallback
  }
}

export function readResonanceSettings(): ResonanceSettings {
  try {
    const mode = localStorage.getItem(RESONANCE_SETTING_KEYS.defaultMode)
    const join = localStorage.getItem(RESONANCE_SETTING_KEYS.joinBehavior)
    // 数值项必须区分「没设置」与「0」：Number(null) === 0 会把没设置误判成 0
    const numberOrNull = (key: string): number | null => {
      const raw = localStorage.getItem(key)
      if (raw === null || raw === '') return null
      const value = Number(raw)
      return Number.isFinite(value) ? value : null
    }
    const port = numberOrNull(RESONANCE_SETTING_KEYS.port)
    const pushLimit = numberOrNull(RESONANCE_SETTING_KEYS.pushLimit)
    const maxMembers = numberOrNull(RESONANCE_SETTING_KEYS.maxMembers)
    const quotaValue = numberOrNull(RESONANCE_SETTING_KEYS.quota)
    return {
      nickname: localStorage.getItem(RESONANCE_SETTING_KEYS.nickname) || RESONANCE_SETTINGS_DEFAULTS.nickname,
      defaultMode: mode === 'shared-playlist' || mode === 'party' || mode === 'round-robin' ? mode : RESONANCE_SETTINGS_DEFAULTS.defaultMode,
      quota: clampQuota(quotaValue ?? RESONANCE_SETTINGS_DEFAULTS.quota),
      partyQuota: clampPartyQuota(numberOrNull(RESONANCE_SETTING_KEYS.partyQuota) ?? undefined),
      // 昵称来源是「平台 id」或 'custom'（历史值 'platform' 当默认处理）。
      // 之前只放行 'custom' | 'platform'，而界面点芯片写入的是 'qq'/'kugou' 这类真实平台 id，
      // 读回来时被当成非法值回落到默认 → 界面又跳回列表里第一个平台（网易云），
      // 表现就是「点 QQ/Apple 自己跳回网易云」。
      nicknameSource: (() => {
        const value = localStorage.getItem(RESONANCE_SETTING_KEYS.nicknameSource) || ''
        if (value === 'custom') return 'custom'
        if ((IDENTITY_PLATFORMS as readonly string[]).includes(value)) return value
        return RESONANCE_SETTINGS_DEFAULTS.nicknameSource
      })(),
      showAvatars: readBoolean(RESONANCE_SETTING_KEYS.showAvatars, RESONANCE_SETTINGS_DEFAULTS.showAvatars),
      background: (() => {
        const value = localStorage.getItem(RESONANCE_SETTING_KEYS.background)
        return value === 'aurora' || value === 'light' || value === 'image' || value === 'cover' ? value : RESONANCE_SETTINGS_DEFAULTS.background
      })(),
      backgroundImage: localStorage.getItem(RESONANCE_SETTING_KEYS.backgroundImage) || '',
      backgroundBlur: Math.min(80, Math.max(0, numberOrNull(RESONANCE_SETTING_KEYS.backgroundBlur) ?? RESONANCE_SETTINGS_DEFAULTS.backgroundBlur)),
      backgroundDim: Math.min(90, Math.max(0, numberOrNull(RESONANCE_SETTING_KEYS.backgroundDim) ?? RESONANCE_SETTINGS_DEFAULTS.backgroundDim)),
      // 强调色会直接进 CSS（按钮/高亮），必须卡成合法的 6 位十六进制，避免写入任意字符串
      accent: (() => {
        const value = localStorage.getItem(RESONANCE_SETTING_KEYS.accent)
        return value && /^#[0-9a-f]{6}$/i.test(value) ? value : RESONANCE_SETTINGS_DEFAULTS.accent
      })(),
      pushLimit: pushLimit !== null && RESONANCE_PUSH_LIMIT_CHOICES.includes(pushLimit as 100 | 200 | 500) ? pushLimit : RESONANCE_SETTINGS_DEFAULTS.pushLimit,
      onlyPlayable: readBoolean(RESONANCE_SETTING_KEYS.onlyPlayable, RESONANCE_SETTINGS_DEFAULTS.onlyPlayable),
      joinBehavior: join === 'next' ? 'next' : 'resume',
      allowMemberControl: readBoolean(RESONANCE_SETTING_KEYS.allowMemberControl, RESONANCE_SETTINGS_DEFAULTS.allowMemberControl),
      lanDiscovery: readBoolean(RESONANCE_SETTING_KEYS.lanDiscovery, RESONANCE_SETTINGS_DEFAULTS.lanDiscovery),
      port: port !== null && port >= 1024 && port <= 65535 ? port : RESONANCE_SETTINGS_DEFAULTS.port,
      showBadges: readBoolean(RESONANCE_SETTING_KEYS.showBadges, RESONANCE_SETTINGS_DEFAULTS.showBadges),
      maxMembers: maxMembers !== null ? Math.min(RESONANCE_MAX_MEMBERS, Math.max(2, Math.round(maxMembers))) : RESONANCE_SETTINGS_DEFAULTS.maxMembers,
      entryMode: localStorage.getItem(RESONANCE_SETTING_KEYS.entryMode) || '',
    }
  } catch {
    return { ...RESONANCE_SETTINGS_DEFAULTS }
  }
}

/** 写入单个设置：同键同事件（设置中心镜像与模式内面板共用） */
export function setResonanceSetting<K extends keyof ResonanceSettings>(key: K, value: ResonanceSettings[K]): void {
  const storageKey = RESONANCE_SETTING_KEYS[key]
  try {
    localStorage.setItem(storageKey, typeof value === 'boolean' ? String(value) : String(value))
  } catch {
    /* localStorage 不可用时仅本次生效 */
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(RESONANCE_SETTINGS_EVENT, { detail: { key, value } }))
    window.dispatchEvent(new CustomEvent('waveforge:global-setting-changed', { detail: { id: storageKey, value } }))
  }
}

/**
 * 房间内才会用到的两个设置读取（会话层用）。
 * 放在这里而不是在 session.ts 里直接写字符串键：键名一旦调整，
 * 散落各处的硬编码会静默失配（读不到就回落默认值，不会报错）。
 */
export function readResonanceJoinBehavior(): 'resume' | 'next' {
  try {
    return localStorage.getItem(RESONANCE_SETTING_KEYS.joinBehavior) === 'next' ? 'next' : 'resume'
  } catch {
    return RESONANCE_SETTINGS_DEFAULTS.joinBehavior
  }
}

export function readResonancePushLimit(): number {
  try {
    const raw = Number(localStorage.getItem(RESONANCE_SETTING_KEYS.pushLimit))
    return RESONANCE_PUSH_LIMIT_CHOICES.includes(raw as 100 | 200 | 500) ? raw : RESONANCE_PUSH_LIMIT_DEFAULT
  } catch {
    return RESONANCE_PUSH_LIMIT_DEFAULT
  }
}

/**
 * 记下「进共振之前是什么模式」。
 *
 * 这样即使用户在共振模式里关掉客户端（或崩了），下次启动也不会一头扎进共振——
 * 启动时的 `viewMode` 若还是 'resonance'，就用这里记的值还原。
 */
export function rememberResonanceEntryMode(mode: string): void {
  if (!mode || mode === 'resonance') return
  try {
    localStorage.setItem(RESONANCE_SETTING_KEYS.entryMode, mode)
  } catch { /* localStorage 不可用时只是没有记忆 */ }
}

/** 读「进共振之前的模式」，没记过或记的是共振就返回空串（调用方自己回落到默认模式）。 */
export function readResonanceEntryMode(): string {
  try {
    const value = localStorage.getItem(RESONANCE_SETTING_KEYS.entryMode) || ''
    return value === 'resonance' ? '' : value
  } catch {
    return ''
  }
}
