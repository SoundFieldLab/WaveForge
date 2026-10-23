/**
 * In Party 房间模型（纯逻辑，无网络无 DOM）。
 *
 * 定位：DG-LAB 插件的多人互控模式——房间里每个人都能用「波形 / 强度指令」控制
 * 别人的设备，也随时能叫停自己。与「共振 · 一起听」共享传输/加密基建（星型中转 +
 * XChaCha20-Poly1305 端到端加密），但数据模型完全独立：
 *  - 共振同步的是「歌单与进度」；In Party 同步的是「成员档案 + 互控指令 + 聊天」。
 *  - 共振房主是唯一权威；In Party 没有权威——互控指令是点到点的（A 控 B），中转只转发密文。
 *
 * 互控的安全规则（本模型层强制，session 再按房间配置复核）：
 *  - 被控方永远保有「一停就归零」：pauseMe 立即 clear 本机设备并拒绝后续指令直到手动恢复；
 *  - 所有远端强度指令经被控方本机中继钳位（min(用户上限, App 硬上限, 0-200)），
 *    远端**无法抬高**本机上限，只能在本机上限内打；
 *  - 控制需要对方「开放控制」或临时授权，默认互控关闭。
 */

/** 房间人数上限（需求：最多 50 人） */
export const INPARTY_MAX_MEMBERS = 50

/** 单条文本消息上限（聊天） */
export const INPARTY_CHAT_LIMIT = 500
/** 单张图片消息上限（base64 后的字节数） */
export const INPARTY_IMAGE_LIMIT = 8 * 1024 * 1024
/** 发图自动压缩目标（canvas 重编码后的最长边），原图更大时自动缩 */
export const INPARTY_IMAGE_MAX_EDGE = 2048
/** 语音消息上限（秒） */
export const INPARTY_AUDIO_MAX_SEC = 120
/** 聊天记录保留条数（本机视图） */
export const INPARTY_CHAT_KEEP = 300

/** 自定义头像图上限（压缩后的 dataURL 字节数） */
export const AVATAR_IMAGE_LIMIT = 512 * 1024
/** 摄像头广播的安全档位（发布时可设，观众可见倒计时） */
export const CAMERA_AUTO_STOP_CHOICES = [0, 60, 180, 600] as const // 0=不自动停
export type CameraAutoStop = (typeof CAMERA_AUTO_STOP_CHOICES)[number]

/* ───────────────────────── 快捷电击（一键玩法） ───────────────────────── */

/** 预设强度档（按对方上限的百分比换算，远超上限自动钳） */
export const QUICK_STRENGTH_PRESETS = [
  { id: 'tease', label: '撩一下', percent: 0.15, frames: 2, freq: 80 },
  { id: 'pat', label: '拍一拍', percent: 0.3, frames: 3, freq: 60 },
  { id: 'shock', label: '电一下', percent: 0.55, frames: 4, freq: 40 },
  { id: 'punish', label: '惩罚', percent: 1.0, frames: 8, freq: 25 },
] as const
export type QuickActionId = (typeof QUICK_STRENGTH_PRESETS)[number]['id']

/** 通道选择：A / B / 双通道 */
export type QuickChannel = 'A' | 'B' | 'both'

/* ───────────────────────── 惩罚轮盘 ───────────────────────── */

/** 轮盘档位（按目标上限的百分比抽取） */
export const ROULETTE_SLOTS = [
  { id: 'nothing', label: '无事发生', percent: 0, frames: 0, freq: 0, weight: 3 },
  { id: 'tease', label: '轻撩 5s', percent: 0.2, frames: 50, freq: 60, weight: 4 },
  { id: 'shock', label: '电击一击', percent: 0.6, frames: 4, freq: 40, weight: 3 },
  { id: 'storm', label: '风暴 10s', percent: 0.85, frames: 100, freq: 30, weight: 1 },
] as const
export type RouletteSlotId = (typeof ROULETTE_SLOTS)[number]['id']

/** 一局轮盘（我发起 → 指定目标转 → 目标确认 → 开奖） */
export interface RouletteGame {
  id: string
  /** 发起人 */
  by: string
  /** 目标（被转的人） */
  target: string
  /** 目标是否已确认（consent：-party 的硬要求） */
  accepted: 'pending' | 'accepted' | 'declined'
  /** 开奖结果（target 确认后由发起人掷出并广播） */
  result: RouletteSlotId | null
  at: number
}

/* ───────────────────────── 好友（本机存储，房间内添加） ───────────────────────── */

/** 好友条目（本机；peerId 是对方档案 id，跨房间稳定） */
export interface FriendEntry {
  peerId: string
  nickname: string
  avatarEmoji: string
  avatarGradient: [string, string]
  avatarImage?: string
  bio?: string
  addedAt: number
  /** 最近一起玩过的房间名 */
  lastRoom?: string
}

/* ───────────────────────── 互控日志/统计 ───────────────────────── */

/** 互控事件（本机记录：谁在何时对我做了什么） */
export interface ControlLogEntry {
  id: string
  at: number
  from: string
  fromNickname: string
  action: 'strength' | 'pulse' | 'clear' | 'quick' | 'roulette'
  /** 详情（如「撩一下 A=9」） */
  detail: string
}

/** 成员「正在听」状态 */
export interface NowPlayingStatus {
  title: string
  artists: string
  playing: boolean
  at: number
}

export type PartyVisibility = 'public' | 'private'

/** 互控授权模型：off=拒绝一切远端指令；ask=每次询问；open=房间内直接可控 */
export type ControlPolicy = 'off' | 'ask' | 'open'

/** 成员档案（交友式用户卡）：本地创建、本地存储，只把「公开字段」上报房间 */
export interface PartyProfile {
  peerId: string
  nickname: string
  /** 本地生成的头像（emoji + 渐变底色，无网络依赖） */
  avatarEmoji: string
  avatarGradient: [string, string]
  /** 自定义头像图（dataURL，≤512KB 压缩后；有值时优先于 emoji 渲染） */
  avatarImage?: string
  /** 一句话签名（可选） */
  bio?: string
  /** 我的 DG-LAB 设备概况（连接状态/协议版本/上限）——入房与变化时更新 */
  device: {
    connected: boolean
    version: 'v3' | 'v4' | ''
    caps: { A: number; B: number } | null
  }
  joinedAt: number
}

export interface PartyMember extends PartyProfile {
  online: boolean
  lastSeenAt: number
  /** 对我的控制策略快照（对方 hello 里声明的） */
  controlPolicy: ControlPolicy
  /** 是否正在视频通话（对房间广播的媒体状态） */
  inCall: boolean
  /** 正在听什么（对方广播；空 = 没在听/未开启分享） */
  nowPlaying?: NowPlayingStatus | null
}

/** 互控指令（A 控 B 的载荷；信封加密后中转只看到密文） */
export type PartyRemoteOp =
  | { kind: 'strength'; channel: 'A' | 'B'; value: number }
  | { kind: 'pulse'; channel: 'A' | 'B'; frames: { freq: number; strength: number }[] }
  | { kind: 'clear' }

/** 我发给某成员的波形绑定：把我的实时波形（特征流输出）持续灌给对方 */
export interface WaveBind {
  /** 目标成员 peerId */
  to: string
  /** 绑定的通道 */
  channel: 'A' | 'B'
  /** 增益 0.1-2（我方输出 0-200 → 对方上限内缩放） */
  gain: number
  /** 是否把我的节拍脉冲也发过去 */
  includePulse: boolean
}

export interface PartyChatMessage {
  id: string
  from: string
  nickname: string
  avatarEmoji: string
  at: number
  kind: 'text' | 'image' | 'audio' | 'system'
  text?: string
  /** 图片/语音：base64 dataURL（E2E 加密传输，本机内存态） */
  dataUrl?: string
  /** 语音时长（秒） */
  durationSec?: number
  /** 私聊目标（peerId）；无 = 房间公屏 */
  to?: string
  self?: boolean
  /** @提及的成员昵称列表（发送时解析；渲染时高亮） */
  mentions?: string[]
  /** 已被发送者撤回（渲染为「撤回了一条消息」） */
  recalled?: boolean
}

/** 摄像头广播：房间的「谁在开播」名册（会话层维护；流本身走 WebRTC 点对点） */
export interface CameraBroadcaster {
  peerId: string
  nickname: string
  avatarEmoji: string
  /** 自动停止倒计时（秒；0=不自动停）。观众按此渲染剩余时间 */
  autoStopSec: number
  startedAt: number
  /** 一键全黑后置 true：流还在但画面强制黑帧（发布端本地把 video 轨 contentHint 置黑/替换） */
  blanked: boolean
}

/** 通话信令载荷（WebRTC offer/answer/ICE 经房间 E2E 转发） */
export type PartyCallSignal =
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; candidate: string; sdpMid?: string; sdpMLineIndex?: number }
  | { t: 'hangup' }

export interface PartyRoomState {
  roomId: string
  createdAt: number
  /** 房主（创建者）：负责成员管理（踢人）与房间公告；不控制播放/互控 */
  hostId: string
  maxMembers: number
  visibility: PartyVisibility
  members: PartyMember[]
  /** 房间公告（房主可改） */
  announcement: string
  /** 房主允许成员互相加控（总闸；默认开） */
  interControlAllowed: boolean
  seq: number
  closed: { reason: 'host-left' | 'dissolved' | 'empty' } | null
}

/** 预设头像 emoji 表（本地头像生成用） */
export const PARTY_AVATAR_EMOJIS = [
  '🐺', '🦊', '🐼', '🦁', '🐯', '🐨', '🐸', '🐙', '🦋', '🐳',
  '🦉', '🦄', '🔥', '⚡', '🌙', '⭐', '🎧', '🎸', '🌶️', '🍑',
] as const

/** 预设头像渐变底色 */
export const PARTY_AVATAR_GRADIENTS: Array<[string, string]> = [
  ['#FFE89C', '#d9a13c'], // 金（DG-LAB 主色）
  ['#ff8fa3', '#c9184a'],
  ['#8ecae6', '#126782'],
  ['#b8f2c9', '#2d6a4f'],
  ['#cdb4db', '#6d23b6'],
  ['#ffd6a5', '#bc6c25'],
]

/** 校验 6 位房间密码：数字/英文/特殊符号，4-16 位（与中转同一规则） */
export function isValidPartyPassword(pw: string): boolean {
  const value = String(pw || '')
  if (value.length < 4 || value.length > 16) return false
  // eslint-disable-next-line no-control-regex
  return /^[\x21-\x7e]+$/.test(value)
}

/** 生成一份本地档案（首次进入 In Party 时创建） */
export function createLocalProfile(nickname = ''): PartyProfile {
  const emoji = PARTY_AVATAR_EMOJIS[Math.floor(Math.random() * PARTY_AVATAR_EMOJIS.length)]
  const gradient = PARTY_AVATAR_GRADIENTS[Math.floor(Math.random() * PARTY_AVATAR_GRADIENTS.length)]
  return {
    peerId: globalThis.crypto.randomUUID(),
    nickname: (nickname || `玩家${Math.floor(Math.random() * 9000 + 1000)}`).slice(0, 16),
    avatarEmoji: emoji,
    avatarGradient: gradient,
    bio: '',
    device: { connected: false, version: '', caps: null },
    joinedAt: Date.now(),
  }
}

export function createRoomState(options: {
  roomId: string
  host: PartyProfile
  /** 房主自己的控制策略（默认 ask；此前硬编码 ask，房主选 open 会静默失效） */
  hostPolicy?: ControlPolicy
  maxMembers: number
  visibility: PartyVisibility
  now: number
}): PartyRoomState {
  return {
    roomId: options.roomId,
    createdAt: options.now,
    hostId: options.host.peerId,
    maxMembers: Math.min(INPARTY_MAX_MEMBERS, Math.max(2, options.maxMembers)),
    visibility: options.visibility,
    members: [{ ...options.host, online: true, lastSeenAt: options.now, controlPolicy: options.hostPolicy ?? 'ask', inCall: false }],
    announcement: '',
    interControlAllowed: true,
    seq: 1,
    closed: null,
  }
}

/** 成员查找 */
export function findMember(state: PartyRoomState, peerId: string): PartyMember | undefined {
  return state.members.find(member => member.peerId === peerId)
}

/** 加入房间（房主侧登记新成员；重复 peerId 幂等） */
export function joinMember(state: PartyRoomState, profile: PartyProfile, policy: ControlPolicy, now: number): { state: PartyRoomState; joined: boolean } {
  if (state.closed) return { state, joined: false }
  const existing = findMember(state, profile.peerId)
  if (existing) {
    // 重连：恢复在线并刷新档案
    const members = state.members.map(member => member.peerId === profile.peerId
      ? { ...member, ...profile, online: true, lastSeenAt: now, controlPolicy: policy }
      : member)
    return { state: { ...state, members }, joined: false }
  }
  if (state.members.length >= state.maxMembers) return { state, joined: false }
  return {
    state: {
      ...state,
      members: [...state.members, { ...profile, online: true, lastSeenAt: now, controlPolicy: policy, inCall: false }],
      seq: state.seq + 1,
    },
    joined: true,
  }
}

/** 离线标记（心跳超时）；房主侧负责移除离线超限成员 */
export function markOffline(state: PartyRoomState, peerId: string, now: number): PartyRoomState {
  const members = state.members.map(member => member.peerId === peerId
    ? { ...member, online: false, lastSeenAt: member.lastSeenAt }
    : member)
  return { ...state, members, seq: state.seq + 1 }
}

/** 完全移除成员（退出/被踢/心跳超限） */
export function removeMember(state: PartyRoomState, peerId: string): PartyRoomState {
  return { ...state, members: state.members.filter(member => member.peerId !== peerId), seq: state.seq + 1 }
}

/** 更新成员档案（改名/换头像/设备状态变化） */
export function updateMember(state: PartyRoomState, profile: PartyProfile, policy: ControlPolicy): { state: PartyRoomState; changed: boolean } {
  const existing = findMember(state, profile.peerId)
  if (!existing) return { state, changed: false }
  const changed = existing.nickname !== profile.nickname
    || existing.avatarEmoji !== profile.avatarEmoji
    || existing.avatarGradient[0] !== profile.avatarGradient[0]
    || existing.avatarGradient[1] !== profile.avatarGradient[1]
    || existing.bio !== profile.bio
    || existing.device.connected !== profile.device.connected
    || existing.device.version !== profile.device.version
    || existing.controlPolicy !== policy
  if (!changed) return { state, changed: false }
  const members = state.members.map(member => member.peerId === profile.peerId
    ? { ...member, ...profile, controlPolicy: policy, online: true, lastSeenAt: Date.now() }
    : member)
  return { state: { ...state, members }, changed: true }
}

/** 房间摘要（大厅/顶栏显示） */
export function roomSummary(state: PartyRoomState): { memberCount: number; online: number } {
  return {
    memberCount: state.members.length,
    online: state.members.filter(member => member.online).length,
  }
}

/**
 * 我能否控制某成员（模型层规则；session 收到远端指令时同样复核）：
 * 房间总闸开 + 对方策略 open（ask 需要走临时授权，本模型不含授权表，由 session 维护）。
 */
export function canControl(state: PartyRoomState, targetPolicy: ControlPolicy): boolean {
  if (!state.interControlAllowed) return false
  return targetPolicy === 'open'
}
