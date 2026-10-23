/**
 * In Party 设置：集中读写（localStorage + 统一事件），与共振 settings 同款约定。
 * 档案（头像/昵称/签名）也在本地持久化——「交友式用户卡」存在本地，不上传任何服务器。
 */
import type { ControlPolicy, PartyProfile, PartyVisibility } from './model'
import { INPARTY_MAX_MEMBERS, createLocalProfile, isValidPartyPassword } from './model'

export const INPARTY_SETTINGS_EVENT = 'waveforge:inparty-settings-changed'

export const INPARTY_SETTING_KEYS = {
  profile: 'waveforge:inparty-profile',
  maxMembers: 'waveforge:inparty-max-members',
  visibility: 'waveforge:inparty-visibility',
  /** 密码只存本机（房主下次建房预填）；不随房间传输 */
  lastPassword: 'waveforge:inparty-last-password',
  controlPolicy: 'waveforge:inparty-control-policy',
  lanDiscovery: 'waveforge:inparty-lan-discovery',
  port: 'waveforge:inparty-port',
  /** 进入 In Party 前的模式（返回用） */
  entryMode: 'waveforge:inparty-entry-mode',
  /** 允许视频通话（设备侧总开关） */
  videoAllowed: 'waveforge:inparty-video-allowed',
  cameraAutoStop: 'waveforge:inparty-camera-auto-stop',
  cameraPanicKeys: 'waveforge:inparty-camera-panic-keys',
  cameraPanicHotkey: 'waveforge:inparty-camera-panic-hotkey',
  /** 最近加入/创建的房间（大厅「最近」列表；只存邀请串与名字，不存密码） */
  recentRooms: 'waveforge:inparty-recent-rooms',
} as const

/** 「最近」列表条目（本机存储；不含密码） */
export interface RecentRoomEntry {
  invite: string
  name: string
  /** public/private：private 加入时要弹密码框 */
  visibility: PartyVisibility
  at: number
}

const RECENT_ROOMS_MAX = 12

export function readRecentRooms(): RecentRoomEntry[] {
  try {
    const raw = localStorage.getItem(INPARTY_SETTING_KEYS.recentRooms)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((item): item is RecentRoomEntry => Boolean(item && typeof item.invite === 'string' && item.invite.startsWith('wf-')))
      .slice(0, RECENT_ROOMS_MAX)
  } catch {
    return []
  }
}

export function rememberRecentRoom(entry: Omit<RecentRoomEntry, 'at'>): void {
  try {
    const list = readRecentRooms().filter(item => item.invite !== entry.invite)
    const next = [{ ...entry, at: Date.now() }, ...list].slice(0, RECENT_ROOMS_MAX)
    localStorage.setItem(INPARTY_SETTING_KEYS.recentRooms, JSON.stringify(next))
  } catch { /* ignore */ }
}

export function removeRecentRoom(invite: string): RecentRoomEntry[] {
  try {
    const next = readRecentRooms().filter(item => item.invite !== invite)
    localStorage.setItem(INPARTY_SETTING_KEYS.recentRooms, JSON.stringify(next))
    return next
  } catch {
    return readRecentRooms()
  }
}

/* ── 好友（本机存储；房间内互加，peerId 跨房间稳定） ── */

const FRIENDS_KEY = 'waveforge:inparty-friends'
const FRIENDS_MAX = 200

export interface FriendEntryStored {
  peerId: string
  nickname: string
  avatarEmoji: string
  avatarGradient: [string, string]
  avatarImage?: string
  bio?: string
  addedAt: number
  lastRoom?: string
  /** 最后一次同房/心跳在线时间戳（在线状态展示用） */
  lastSeenAt?: number
  /** 与该好友的私聊历史（双向；离线时发送的消息入队，重连后经房间转发） */
  messages: Array<{ id: string; from: string; text: string; at: number; self: boolean; pending?: boolean }>
}

export function readFriends(): FriendEntryStored[] {
  try {
    const raw = localStorage.getItem(FRIENDS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(item => item && typeof item.peerId === 'string').slice(0, FRIENDS_MAX)
  } catch {
    return []
  }
}

export function upsertFriend(profile: { peerId: string; nickname: string; avatarEmoji: string; avatarGradient: [string, string]; bio?: string }, lastRoom?: string): FriendEntryStored[] {
  try {
    const list = readFriends()
    const existing = list.find(f => f.peerId === profile.peerId)
    const entry: FriendEntryStored = {
      ...profile,
      addedAt: existing?.addedAt ?? Date.now(),
      lastRoom: lastRoom ?? existing?.lastRoom,
      lastSeenAt: existing?.lastSeenAt,
      messages: existing?.messages ?? [],
    }
    const next = [entry, ...list.filter(f => f.peerId !== profile.peerId)].slice(0, FRIENDS_MAX)
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(INPARTY_SETTINGS_EVENT))
    return next
  } catch {
    return readFriends()
  }
}

/** 追加一条好友私聊消息（本机历史；pending=离线待转发） */
export function appendFriendMessage(peerId: string, message: { id: string; from: string; text: string; at: number; self: boolean; pending?: boolean }): void {
  try {
    const friends = readFriends()
    const friend = friends.find(f => f.peerId === peerId)
    if (!friend) return
    friend.messages = [...(friend.messages ?? []), message].slice(-200)
    friend.lastSeenAt = message.self ? friend.lastSeenAt : Date.now()
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(friends))
    window.dispatchEvent(new CustomEvent(INPARTY_SETTINGS_EVENT))
  } catch { /* ignore */ }
}

/** 标记某好友的所有 pending 消息为已送达（重连房间后由转发逻辑调用） */
export function markFriendMessagesDelivered(peerId: string): void {
  try {
    const friends = readFriends()
    const friend = friends.find(f => f.peerId === peerId)
    if (!friend) return
    let changed = false
    for (const message of friend.messages ?? []) {
      if (message.pending) { message.pending = false; changed = true }
    }
    if (changed) {
      localStorage.setItem(FRIENDS_KEY, JSON.stringify(friends))
      window.dispatchEvent(new CustomEvent(INPARTY_SETTINGS_EVENT))
    }
  } catch { /* ignore */ }
}

/** 更新好友在线时间戳（同房心跳） */
export function touchFriendPresence(peerId: string): void {
  try {
    const friends = readFriends()
    const friend = friends.find(f => f.peerId === peerId)
    if (!friend) return
    friend.lastSeenAt = Date.now()
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(friends))
  } catch { /* ignore */ }
}

export function removeFriend(peerId: string): FriendEntryStored[] {
  try {
    const next = readFriends().filter(f => f.peerId !== peerId)
    localStorage.setItem(FRIENDS_KEY, JSON.stringify(next))
    window.dispatchEvent(new CustomEvent(INPARTY_SETTINGS_EVENT))
    return next
  } catch {
    return readFriends()
  }
}

export interface InPartySettings {
  maxMembers: number
  visibility: PartyVisibility
  controlPolicy: ControlPolicy
  lanDiscovery: boolean
  port: number
  videoAllowed: boolean
  /** 摄像头广播默认自动停止（秒；0=不自动停） */
  cameraAutoStop: number
  /** 摄像头一键全黑的快捷键（本机生效） */
  cameraPanicHotkey: boolean
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    return { ...fallback, ...(JSON.parse(raw) as T) }
  } catch {
    return fallback
  }
}

function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* 忽略存储失败 */ }
}

/** 本地档案：首次调用自动生成并持久化 */
export function loadLocalProfile(): PartyProfile {
  return readJson<PartyProfile>(INPARTY_SETTING_KEYS.profile, createLocalProfile() as unknown as PartyProfile)
}

export function saveLocalProfile(patch: Partial<PartyProfile>): PartyProfile {
  const next = { ...loadLocalProfile(), ...patch }
  writeJson(INPARTY_SETTING_KEYS.profile, next)
  window.dispatchEvent(new CustomEvent(INPARTY_SETTINGS_EVENT))
  return next
}

/** 档案不存在时重建（比如手动清了 localStorage） */
export function ensureLocalProfile(): PartyProfile {
  const profile = loadLocalProfile()
  if (profile && profile.peerId && profile.nickname) return profile
  return saveLocalProfile(createLocalProfile() as Partial<PartyProfile>)
}

export function readInPartySettings(): InPartySettings {
  const base: InPartySettings = {
    maxMembers: 20,
    visibility: 'public',
    controlPolicy: 'ask',
    lanDiscovery: true,
    port: 25570,
    videoAllowed: true,
    cameraAutoStop: 180,
    cameraPanicHotkey: true,
  }
  const maxMembersRaw = Number(localStorage.getItem(INPARTY_SETTING_KEYS.maxMembers) || 0)
  const visibilityRaw = String(localStorage.getItem(INPARTY_SETTING_KEYS.visibility) || '')
  const policyRaw = String(localStorage.getItem(INPARTY_SETTING_KEYS.controlPolicy) || '')
  const discoveryRaw = localStorage.getItem(INPARTY_SETTING_KEYS.lanDiscovery)
  const portRaw = Number(localStorage.getItem(INPARTY_SETTING_KEYS.port) || 0)
  const videoRaw = localStorage.getItem(INPARTY_SETTING_KEYS.videoAllowed)
  const camStopRaw = Number(localStorage.getItem(INPARTY_SETTING_KEYS.cameraAutoStop) ?? 180)
  const panicRaw = localStorage.getItem(INPARTY_SETTING_KEYS.cameraPanicHotkey)
  return {
    maxMembers: Number.isFinite(maxMembersRaw) && maxMembersRaw >= 2 ? Math.min(INPARTY_MAX_MEMBERS, maxMembersRaw) : base.maxMembers,
    visibility: visibilityRaw === 'private' ? 'private' : 'public',
    controlPolicy: policyRaw === 'open' || policyRaw === 'off' || policyRaw === 'ask' ? policyRaw as ControlPolicy : base.controlPolicy,
    lanDiscovery: discoveryRaw === null ? true : discoveryRaw === 'true',
    port: Number.isFinite(portRaw) && portRaw >= 1024 && portRaw <= 65535 ? portRaw : base.port,
    videoAllowed: videoRaw === null ? true : videoRaw === 'true',
    cameraAutoStop: [0, 60, 180, 600].includes(camStopRaw) ? camStopRaw : base.cameraAutoStop,
    cameraPanicHotkey: panicRaw === null ? true : panicRaw === 'true',
  }
}

export function setInPartySetting<K extends keyof InPartySettings>(key: K, value: InPartySettings[K]): void {
  try { localStorage.setItem(INPARTY_SETTING_KEYS[key], String(value)) } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(INPARTY_SETTINGS_EVENT))
}

export function readLastPassword(): string {
  try { return String(localStorage.getItem(INPARTY_SETTING_KEYS.lastPassword) || '') } catch { return '' }
}

/** 建房时提交的密码（房主本地预填用）；非法值一律存空 */
export function rememberPassword(pw: string): void {
  try {
    if (isValidPartyPassword(pw)) localStorage.setItem(INPARTY_SETTING_KEYS.lastPassword, pw)
    else localStorage.removeItem(INPARTY_SETTING_KEYS.lastPassword)
  } catch { /* ignore */ }
}

export function readEntryMode(): string {
  try { return String(localStorage.getItem(INPARTY_SETTING_KEYS.entryMode) || 'explore') } catch { return 'explore' }
}

/** 一键全黑快捷键（本机存储；最多 3 个键位的数组，如 ['Ctrl','Shift','Z']） */
export function readPanicKeys(): string[] {
  try {
    const raw = localStorage.getItem(INPARTY_SETTING_KEYS.cameraPanicKeys)
    if (!raw) return ['Ctrl', 'Shift', 'Z']
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) && parsed.length && parsed.every(k => typeof k === 'string') ? parsed.slice(0, 3) : ['Ctrl', 'Shift', 'Z']
  } catch {
    return ['Ctrl', 'Shift', 'Z']
  }
}

export function savePanicKeys(keys: string[]): void {
  try { localStorage.setItem(INPARTY_SETTING_KEYS.cameraPanicKeys, JSON.stringify(keys.slice(0, 3))) } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(INPARTY_SETTINGS_EVENT))
}

export function rememberEntryMode(mode: string): void {
  // 只记常规模式：从共振/学歌/In Party 本身切入时记下来的目标没有意义（会被门控拦或套娃）
  const normal = ['explore', 'minimal', 'traditional', 'desktop']
  if (!normal.includes(String(mode))) return
  try { localStorage.setItem(INPARTY_SETTING_KEYS.entryMode, mode) } catch { /* ignore */ }
}

/* ── 消息漫游：按房间号存最近 200 条文本/系统消息（本机明文存；重进同一房间恢复聊天视图） ── */

const HISTORY_KEY = 'waveforge:inparty-history'

export interface StoredChatMessage {
  roomId: string
  id: string
  from: string
  nickname: string
  avatarEmoji: string
  at: number
  kind: 'text' | 'system'
  text?: string
}

export function appendRoomHistory(roomId: string, messages: Array<StoredChatMessage>): void {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    const all = raw ? (JSON.parse(raw) as Record<string, StoredChatMessage[]>) : {}
    const merged = [...(all[roomId] ?? []), ...messages]
      .filter(m => m.kind === 'text' || m.kind === 'system') // 图/语音不落盘
      .slice(-200)
    all[roomId] = merged
    // 只保留最近 10 个房间
    const keys = Object.keys(all)
    if (keys.length > 10) for (const k of keys.slice(0, keys.length - 10)) delete all[k]
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all))
  } catch { /* ignore */ }
}

export function readRoomHistory(roomId: string): StoredChatMessage[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return []
    const all = JSON.parse(raw) as Record<string, StoredChatMessage[]>
    return all[roomId] ?? []
  } catch {
    return []
  }
}

export function clearRoomHistory(roomId: string): void {
  try {
    const raw = localStorage.getItem(HISTORY_KEY)
    if (!raw) return
    const all = JSON.parse(raw) as Record<string, StoredChatMessage[]>
    delete all[roomId]
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all))
  } catch { /* ignore */ }
}
