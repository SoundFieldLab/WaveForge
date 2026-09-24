/**
 * 「共振」房间模型（纯逻辑，无网络无 DOM）。
 *
 * 设计要点（对照网易云「一起听」实机与 APK 逆向，见 docs/resonance-netease-listentogether-reference.md）：
 * - 房主是唯一权威：多人房间里只有房主的切歌/暂停/进度会同步（网易云文案原话）。
 * - 权威可交接：房主退出时按入房顺序交接，用 term 递增杜绝双权威。
 * - 三种房间模式：共享歌单（房主推整单，房主退出即结束）/ Party（人人可加）/ 我推荐（按入房顺序轮流，每人 1-3 首）。
 * - 跳过投票阈值 = 当前在线人数 × 80%（向上取整）；房主可强制跳过，不发起投票。
 * - 只交换歌曲元数据与进度：绝不传音频、绝不借用他人账号音源。
 */
import type { MusicPlatform } from '../../services/platforms'
import { normalizeSearchText } from '../../services/fusedSearch'
import type { EntitlementTier } from '../../utils/musicEntitlements'

/** 房间人数上限（需求：最多 15 人） */
export const RESONANCE_MAX_MEMBERS = 15
/** 跳过投票阈值比例（需求：当前人数的 8 成） */
export const RESONANCE_SKIP_RATIO = 0.8
/**
 * 除「共享歌单」外，每个人在这间房里能加的歌数上限（需求：可挑挑拣拣，不能一下子塞一堆）。
 * 我推荐模式按「每轮」计算（可多轮），Party 模式按「整场累计」计算。
 */
export const RESONANCE_PARTY_QUOTA_DEFAULT = 3
export const RESONANCE_PARTY_QUOTA_RANGE = [1, 10] as const
/**
 * Party 模式下可选的「每人整场可加歌数」档位。
 * 必须只有一份：大厅、共振设置面板、设置中心镜像共用一个常量，
 * 否则出现「在设置面板选了 8、镜像里显示 3、大厅分段控件没有任何一档高亮」这种自相矛盾。
 */
export const RESONANCE_PARTY_QUOTA_CHOICES = [1, 2, 3, 5, 8, 10] as const

/** 队列长度上限，防止无界增长 */
export const RESONANCE_MAX_QUEUE = 300
/** 单次整单推送的截断上限（设置项可选 100/200/500），防大歌单把房间卡住 */
export const RESONANCE_PUSH_LIMIT_CHOICES = [100, 200, 500] as const
export const RESONANCE_PUSH_LIMIT_DEFAULT = 200
/** 状态广播里携带的队列窗口大小（入房首包与队列长度无关） */
export const RESONANCE_QUEUE_WINDOW = 50
/** 我推荐模式单人单轮可加歌数范围 */
export const RESONANCE_QUOTA_RANGE = [1, 3] as const

export type ResonanceMode = 'shared-playlist' | 'party' | 'round-robin'

export const RESONANCE_MODE_LABEL: Record<ResonanceMode, string> = {
  'shared-playlist': '共享歌单',
  party: 'Party',
  'round-robin': '我推荐',
}

export const RESONANCE_MODE_HINT: Record<ResonanceMode, string> = {
  'shared-playlist': '房主把自己的歌单推入房间，大家跟着听；房主退出即结束',
  party: '任何人都能从自己的歌单或搜索里加歌',
  'round-robin': '房主先推第一首，之后按入房顺序轮流推荐，每人 1–3 首',
}

/** 本机对外身份：不含任何平台账号信息，昵称由用户自填 */
export interface ResonanceIdentity {
  peerId: string
  nickname: string
  /** 平台公开头像（设置里可关；房间里用来显示成员头像） */
  avatarUrl?: string
  /** 昵称来自哪个平台（用于成员卡片标注） */
  nicknameFrom?: string
  /** 我登录了哪些平台、会员档位如何（只展示徽章，不透露账号） */
  platforms: ResonancePlatformBadge[]
  joinedAt: number
}

export interface ResonancePlatformBadge {
  platform: MusicPlatform
  loggedIn: boolean
  tier: EntitlementTier
}

/** 房间内的一首歌：跨平台规范表示 + 已知的平台版本 */
export interface ResonanceTrack {
  /** 规范键：标题+歌手（归一化）+ 时长桶；跨平台同名曲视为同一首 */
  key: string
  title: string
  artists: string[]
  album?: string
  durationMs: number
  coverUrl?: string
  /** 已知的平台版本（优先来自 fusedSources），供各成员解析成自己能播的版本 */
  sources: ResonanceTrackSource[]
  /** 谁点的（peerId）；房主推送歌单时为房主 */
  requestedBy: string
  /** 顺序号：队列合并时保持稳定顺序 */
  seq: number
}

export interface ResonanceTrackSource {
  platform: MusicPlatform
  id: number
  mid?: string
  appleId?: string
  vip?: boolean
  noCopyright?: boolean
}

export interface ResonanceMember extends ResonanceIdentity {
  /** 入房编号 1..15，用于「我推荐」轮转顺序与交接顺序 */
  seat: number
  online: boolean
  lastSeenAt: number
  /** 本机解析失败时上报的曲目（key），房主界面据此提示 */
  unableToPlay: string | null
  unableToPlayTier: EntitlementTier | null
  /**
   * 名字与房间里已有的成员撞了（不区分大小写）。房主负责判定，只影响展示与提示：
   * 后进来的人会看到「你和房间里已有的人重名」，其他人也能一眼看出是谁重名。
   */
  nicknameConflict?: boolean
}

export interface ResonancePlayback {
  trackKey: string | null
  positionMs: number
  playing: boolean
  /** 房主时钟（房主 performance/Date 时间戳），成员据偏移换算 */
  atHostClock: number
  term: number
  seq: number
}

export interface ResonanceSkipVote {
  /** 投票针对的曲目 key；null 表示「跳过当前」 */
  target: string | null
  by: string[]
}

export interface ResonanceRoomState {
  roomId: string
  createdAt: number
  mode: ResonanceMode
  hostId: string
  /** 权威任期：房主交接时 +1；低任期的权威消息一律丢弃 */
  term: number
  /** 我推荐模式：每人每轮可加歌数 */
  quota: number
  /** Party 模式：每人整场累计可加歌数 */
  partyQuota: number
  /** 人数上限（含房主），创建房间时确定 */
  maxMembers: number
  members: ResonanceMember[]
  queue: ResonanceTrack[]
  /**
   * 预排队（右键「推送至共振」在不能直接加的时候用）：
   * 曲目已经进房间、所有人都看得到，但**不在播放顺序里**，也不算配额。
   * 等推歌人的额度/轮次放开（或房主手动放行）才搬进 queue。
   */
  pending: ResonancePendingTrack[]
  /** 当前播放位置（queue 下标），-1 表示未开始 */
  cursor: number
  playback: ResonancePlayback | null
  vote: ResonanceSkipVote | null
  closed: { reason: 'host-left' | 'dissolved' | 'empty' } | null
  /** 权威事件序号，用于去重与乱序丢弃 */
  seq: number
  /** 允许所有成员控制播放（房主开关，默认关） */
  memberControl: boolean
  /**
   * 房主把共振挂起来了（切去别的模式听自己的歌）：房间还在、还能收推送，但不驱动播放。
   * 成员看到这个标记就知道「房主已挂起」，不用干等。
   */
  suspended: boolean
  /** 临时授权控制播放的成员与到期时间（同一时刻只有一个 controller） */
  controllerId: string | null
  controllerUntil: number
}

/** 预排队里的曲目：多一个「为什么还没进队列」的原因，界面据此提示 */
export interface ResonancePendingTrack extends ResonanceTrack {
  pendingReason: PendingReason
}

export type PendingReason = 'quota' | 'turn' | 'mode'

/** 时长桶（秒→3 秒一个桶），仅用于匹配阶段排除明显不同的录音版本 */
export function durationBucket(durationMs?: number): number {
  const duration = Number(durationMs || 0)
  return duration > 0 ? Math.floor(duration / 3000) : 0
}

/** 两首曲目的时长是否可视为同一录音（未知时长不拦，差距 >15s 视为不同版本，沿用 fusedSearch 的护栏） */
export function trackDurationCompatible(leftMs?: number, rightMs?: number): boolean {
  const left = Number(leftMs || 0)
  const right = Number(rightMs || 0)
  if (left <= 0 || right <= 0) return true
  return Math.abs(left - right) <= 15000
}

/**
 * 跨平台规范键：标题 + 排序后的歌手（都做 NFKC/大小写/标点归一化）。
 * 不含时长：时长只作为匹配阶段的护栏（见 trackDurationCompatible），
 * 否则同一首歌在不同平台的时长差一点点就会算出不同的键。
 */
export function canonicalTrackKey(track: { title: string; artists?: string[]; durationMs?: number }): string {
  const title = normalizeSearchText(track.title || '')
  const artists = [...(track.artists || [])]
    .map(artist => normalizeSearchText(artist))
    .filter(Boolean)
    .sort()
  return `${title}|${artists.join('&')}`
}

export function createRoomState(options: {
  roomId: string
  host: ResonanceIdentity
  mode: ResonanceMode
  quota?: number
  partyQuota?: number
  maxMembers?: number
  now: number
}): ResonanceRoomState {
  const quota = clampQuota(options.quota)
  return {
    roomId: options.roomId,
    createdAt: options.now,
    mode: options.mode,
    hostId: options.host.peerId,
    term: 1,
    quota,
    partyQuota: clampPartyQuota(options.partyQuota),
    maxMembers: Math.min(RESONANCE_MAX_MEMBERS, Math.max(2, Number(options.maxMembers) || RESONANCE_MAX_MEMBERS)),
    members: [toMember(options.host, 1, options.now)],
    queue: [],
    pending: [],
    cursor: -1,
    playback: null,
    vote: null,
    closed: null,
    seq: 0,
    memberControl: false,
    controllerId: null,
    controllerUntil: 0,
    suspended: false,
  }
}

/** Party 模式每人整场加歌上限（1–10，默认 3） */
export function clampPartyQuota(value?: number): number {
  const raw = Number(value)
  if (!Number.isFinite(raw) || raw <= 0) return RESONANCE_PARTY_QUOTA_DEFAULT
  return Math.min(RESONANCE_PARTY_QUOTA_RANGE[1], Math.max(RESONANCE_PARTY_QUOTA_RANGE[0], Math.round(raw)))
}

/** 某成员在整场房间里已加过的歌数（共享歌单房主推送不计入） */
export function tracksAddedByPeer(state: ResonanceRoomState, peerId: string): number {
  return state.queue.filter(track => track.requestedBy === peerId).length
}

/** 某成员此刻还能加几首（Infinity = 共享歌单房主整单推送；0 = 已用尽） */
export function remainingAddQuota(state: ResonanceRoomState, peerId: string): number {
  if (state.mode === 'shared-playlist') return peerId === state.hostId ? Number.POSITIVE_INFINITY : 0
  if (state.mode === 'round-robin') {
    if (currentTurnPeerId(state) !== peerId) return 0
    return Math.max(0, state.quota - tracksAddedThisTurn(state, peerId))
  }
  return Math.max(0, state.partyQuota - tracksAddedByPeer(state, peerId))
}

export function clampQuota(value?: number): number {
  const raw = Number(value)
  if (!Number.isFinite(raw)) return RESONANCE_QUOTA_RANGE[0]
  return Math.min(RESONANCE_QUOTA_RANGE[1], Math.max(RESONANCE_QUOTA_RANGE[0], Math.round(raw)))
}

/** 名字比对：忽略大小写与首尾空白（「Alice」和「 alice 」算重名） */
function sameName(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase()
}

/** 房间里是否已经有别人用了这个名字（只对自定义用户名提示冲突） */
export function hasNameConflict(state: ResonanceRoomState, identity: ResonanceIdentity): boolean {
  if (!identity.nickname?.trim() || identity.nicknameFrom) return false
  return state.members.some(member => !member.nicknameFrom && member.peerId !== identity.peerId && sameName(member.nickname, identity.nickname))
}

function toMember(identity: ResonanceIdentity, seat: number, now: number, online = true): ResonanceMember {
  return { ...identity, seat, online, lastSeenAt: now, unableToPlay: null, unableToPlayTier: null }
}

export type JoinResult =
  | { ok: true; state: ResonanceRoomState; member: ResonanceMember }
  | { ok: false; reason: 'room-closed' | 'room-full' | 'already-joined' | 'nickname-required' }

/** 入房：分配座位号（按入房顺序），15 人上限 */
export function joinRoom(state: ResonanceRoomState, identity: ResonanceIdentity, now: number): JoinResult {
  if (state.closed) return { ok: false, reason: 'room-closed' }
  if (!identity.nickname || !identity.nickname.trim()) return { ok: false, reason: 'nickname-required' }
  const existing = state.members.find(member => member.peerId === identity.peerId)
  if (existing) return { ok: true, state, member: existing }
  if (state.members.length >= state.maxMembers) return { ok: false, reason: 'room-full' }
  const seat = state.members.reduce((max, member) => Math.max(max, member.seat), 0) + 1
  const member = { ...toMember(identity, seat, now), nicknameConflict: hasNameConflict(state, identity) }
  return {
    ok: true,
    member,
    state: { ...state, seq: state.seq + 1, members: [...state.members, member] },
  }
}

/**
 * 房间里改昵称/头像：成员在设置里换了「昵称来源」或自定义名后，名册要跟着变。
 * 席位与入房时间保持不变（不是重新入房），返回 null 表示没有任何变化、不必广播。
 */
export function updateMemberProfile(state: ResonanceRoomState, identity: ResonanceIdentity): ResonanceRoomState | null {
  const index = state.members.findIndex(member => member.peerId === identity.peerId)
  if (index < 0) return null
  const current = state.members[index]
  const nickname = (identity.nickname || '').trim().slice(0, 16)
  if (!nickname) return null
  const avatarUrl = identity.avatarUrl || ''
  const nicknameFrom = identity.nicknameFrom || ''
  const platforms = identity.platforms || current.platforms || []
  const samePlatforms = JSON.stringify(platforms) === JSON.stringify(current.platforms || [])
  if (current.nickname === nickname && current.avatarUrl === avatarUrl && current.nicknameFrom === nicknameFrom && samePlatforms) return null
  const members = [...state.members]
  members[index] = { ...current, nickname, avatarUrl, nicknameFrom, platforms, nicknameConflict: hasNameConflict({ ...state, members }, { ...identity, nickname, nicknameFrom }) }
  return { ...state, seq: state.seq + 1, members: refreshNameConflicts(members) }
}

/**
 * 重算所有人的重名标记：改名、有人退出都会改变结论（唯一一个用了这个名字的人不该再被标红）。
 * 先到的人保留原名且不被标记，后到/后改的人被标记为「重名」。
 */
function refreshNameConflicts(members: ResonanceMember[]): ResonanceMember[] {
  const seen = new Map<string, string>() // 名字 → 第一个占用者的 peerId
  return members.map(member => {
    const key = member.nickname.trim().toLocaleLowerCase()
    const owner = seen.get(key)
    if (owner === undefined) { seen.set(key, member.peerId); return member.nicknameConflict ? { ...member, nicknameConflict: false } : member }
    return member.nicknameConflict ? member : { ...member, nicknameConflict: true }
  })
}

export type LeaveOutcome =
  | { kind: 'left'; state: ResonanceRoomState }
  | { kind: 'host-changed'; state: ResonanceRoomState; newHostId: string }
  | { kind: 'closed'; state: ResonanceRoomState; reason: 'host-left' | 'empty' }


/**
 * 退出/掉线：
 * - 共享歌单模式下房主退出 → 房间结束（App 语义：「房主退出自动结束房间」）
 * - 其他模式房主退出 → 交接给入房最早的在线成员，term+1；直到最后一人
 * - 最后一人退出 → 房间结束
 */
export function leaveRoom(state: ResonanceRoomState, peerId: string): LeaveOutcome {
  const leaving = state.members.find(member => member.peerId === peerId)
  if (!leaving) return { kind: 'left', state }
  const remaining = state.members.filter(member => member.peerId !== peerId)
  if (remaining.length === 0) {
    return { kind: 'closed', state: { ...state, members: refreshNameConflicts(remaining), closed: { reason: 'empty' }, seq: state.seq + 1 }, reason: 'empty' }
  }
  // 离开的人要从投票名单里划掉：
  // 阈值按「当前在线人数」算，把走掉的人的票留在 by 里，会让剩下的人被一个已经不在房间的人代表通过。
  const stillHere = state.vote ? state.vote.by.filter(voter => voter !== peerId) : null
  const vote = stillHere && state.vote && stillHere.length > 0 ? { ...state.vote, by: stillHere } : null
  const stateWithout = { ...state, members: refreshNameConflicts(remaining), seq: state.seq + 1, vote }
  if (peerId !== state.hostId) return { kind: 'left', state: stateWithout }
  if (state.mode === 'shared-playlist') {
    return { kind: 'closed', state: { ...stateWithout, closed: { reason: 'host-left' } }, reason: 'host-left' }
  }
  const successor = [...remaining].sort((left, right) => left.seat - right.seat)[0]
  return {
    kind: 'host-changed',
    newHostId: successor.peerId,
    state: {
      ...stateWithout,
      hostId: successor.peerId,
      term: state.term + 1,
      vote: null,
    },
  }
}

export type AddTracksResult =
  | { ok: true; state: ResonanceRoomState; added: ResonanceTrack[] }
  | { ok: false; reason: 'room-closed' | 'not-host' | 'not-your-turn' | 'quota-exceeded' | 'queue-full' | 'empty' }

export interface AddTracksOptions {
  /** 是否整单推送（共享歌单模式房主推歌单） */
  playlistPush?: boolean
  /**
   * 插入位置：
   * - append（默认）加歌面板用：接到队尾
   * - next：右键「推送至共振」用：插到当前曲目之后，等于「下一曲」
   */
  position?: 'append' | 'next'
  /**
   * 「下一曲」插入锚点：上一首 next 推送的歌。连着推 A、B、C 时要得到 A→B→C，
   * 而不是每次都插在当前曲目后面把顺序倒过来。锚点失效（已被播掉/不在队列）时回落到当前曲目之后。
   */
  anchorKey?: string | null
}

/**
 * 加歌：
 * - 共享歌单：只有房主能推（整单）
 * - Party：人人可加
 * - 我推荐：只有轮到的那位可加，且每人每轮不超过 quota 首；加满即轮到下一位
 */
export function addTracks(
  state: ResonanceRoomState,
  peerId: string,
  tracks: Array<Omit<ResonanceTrack, 'key' | 'seq' | 'requestedBy'>>,
  now: number,
  options: AddTracksOptions = {},
): AddTracksResult {
  if (state.closed) return { ok: false, reason: 'room-closed' }
  const member = state.members.find(item => item.peerId === peerId)
  if (!member) return { ok: false, reason: 'not-host' }
  if (state.mode === 'shared-playlist' && !options.playlistPush) return { ok: false, reason: 'not-host' }
  if (state.mode === 'shared-playlist' && peerId !== state.hostId) return { ok: false, reason: 'not-host' }
  if (state.mode === 'round-robin') {
    const turn = currentTurnPeerId(state)
    if (turn && turn !== peerId) return { ok: false, reason: 'not-your-turn' }
    const used = tracksAddedThisTurn(state, peerId)
    if (used >= state.quota) return { ok: false, reason: 'quota-exceeded' }
  }
  if (state.mode === 'party' && tracksAddedByPeer(state, peerId) >= state.partyQuota) {
    return { ok: false, reason: 'quota-exceeded' }
  }
  if (tracks.length === 0) return { ok: false, reason: 'empty' }
  const room = Math.max(0, RESONANCE_MAX_QUEUE - state.queue.length)
  if (room === 0) return { ok: false, reason: 'queue-full' }

  const quotaLeft = state.mode === 'round-robin'
    ? Math.max(0, state.quota - tracksAddedThisTurn(state, peerId))
    : state.mode === 'party'
      ? Math.max(0, state.partyQuota - tracksAddedByPeer(state, peerId))
      : Number.POSITIVE_INFINITY
  const known = new Set(state.queue.map(track => track.key))
  const added: ResonanceTrack[] = []
  let seq = state.queue.reduce((max, track) => Math.max(max, track.seq), 0)
  for (const track of tracks) {
    if (added.length >= room || added.length >= quotaLeft) break
    const key = canonicalTrackKey(track)
    // 同一首歌在队列里只保留一次；重复点歌视为「已存在」，不报错
    if (known.has(key)) continue
    known.add(key)
    seq += 1
    added.push({ ...track, key, requestedBy: peerId, seq })
  }
  if (added.length === 0) return { ok: false, reason: 'empty' }
  const queue = options.position === 'next' ? insertAfterCurrent(state, added, options.anchorKey) : [...state.queue, ...added]
  const nextState: ResonanceRoomState = {
    ...state,
    queue,
    seq: state.seq + 1,
    members: touchMember(state.members, peerId, now),
  }
  return { ok: true, state: nextState, added }
}

/**
 * 插到「当前曲目之后」；连推多首时接在上一首 next 推送的后面，保持推送顺序。
 * 没有在播的曲目就从队首开始；锚点已被播掉（在当前曲目之前）则视为失效。
 */
function insertAfterCurrent(state: ResonanceRoomState, tracks: ResonanceTrack[], anchorKey?: string | null): ResonanceTrack[] {
  const currentKey = state.playback?.trackKey
  const currentIndex = currentKey ? state.queue.findIndex(track => track.key === currentKey) : -1
  const anchorIndex = anchorKey ? state.queue.findIndex(track => track.key === anchorKey) : -1
  let at: number
  if (anchorIndex >= 0 && anchorIndex >= currentIndex) at = anchorIndex + 1
  else if (currentIndex >= 0) at = currentIndex + 1
  else at = 0
  return [...state.queue.slice(0, at), ...tracks, ...state.queue.slice(at)]
}

// ── 预排队（右键推送兜底）────────────────────────────────────────────────────

/** 单人最多能预排几首、整个房间最多能挂几首（防止拿预排当无限队列用） */
export const RESONANCE_PENDING_PER_PEER = 5
export const RESONANCE_PENDING_MAX = 30

/**
 * 这个人现在能不能直接加歌？不能的话是卡在哪一条。
 * 返回 null = 可以直接加；房主在共享歌单模式永远可以直接加。
 */
export function pendingReasonFor(state: ResonanceRoomState, peerId: string): PendingReason | null {
  if (state.closed) return 'mode'
  const member = state.members.find(item => item.peerId === peerId)
  if (!member) return 'mode'
  if (state.mode === 'shared-playlist') return peerId === state.hostId ? null : 'mode'
  if (state.mode === 'round-robin') {
    const turn = currentTurnPeerId(state)
    if (turn && turn !== peerId) return 'turn'
    if (tracksAddedThisTurn(state, peerId) >= state.quota) return 'quota'
    return null
  }
  if (state.mode === 'party' && tracksAddedByPeer(state, peerId) >= state.partyQuota) return 'quota'
  return null
}

export type PendingResult =
  | { ok: true; state: ResonanceRoomState; added: ResonancePendingTrack[] }
  | { ok: false; reason: 'room-closed' | 'not-member' | 'empty' | 'pending-full' | 'already-in-queue' }

/**
 * 预排队：曲目进房间但不进播放顺序、不占配额。
 * 用于「用户此刻没资格推歌，但想先把这首排上」——例如不在自己的轮次、共享歌单模式的成员。
 */
export function addPendingTracks(
  state: ResonanceRoomState,
  peerId: string,
  tracks: Array<Omit<ResonanceTrack, 'key' | 'seq' | 'requestedBy'>>,
  now: number,
): PendingResult {
  if (state.closed) return { ok: false, reason: 'room-closed' }
  if (!state.members.some(item => item.peerId === peerId)) return { ok: false, reason: 'not-member' }
  if (tracks.length === 0) return { ok: false, reason: 'empty' }
  const reason = pendingReasonFor(state, peerId) || 'quota'
  const mine = state.pending.filter(track => track.requestedBy === peerId).length
  const room = Math.min(RESONANCE_PENDING_MAX - state.pending.length, RESONANCE_PENDING_PER_PEER - mine)
  if (room <= 0) return { ok: false, reason: 'pending-full' }

  const known = new Set([...state.queue, ...state.pending].map(track => track.key))
  const added: ResonancePendingTrack[] = []
  let seq = [...state.queue, ...state.pending].reduce((max, track) => Math.max(max, track.seq), 0)
  for (const track of tracks) {
    if (added.length >= room) break
    const key = canonicalTrackKey(track)
    if (known.has(key)) continue
    known.add(key)
    seq += 1
    added.push({ ...track, key, requestedBy: peerId, seq, pendingReason: reason })
  }
  if (added.length === 0) return { ok: false, reason: 'already-in-queue' }
  return {
    ok: true,
    added,
    state: {
      ...state,
      pending: [...state.pending, ...added],
      seq: state.seq + 1,
      members: touchMember(state.members, peerId, now),
    },
  }
}

/**
 * 把够格的预排曲目搬进队列（房主侧调用）。
 * - keepKey：指定曲目时无视资格强制放行（房主手动「加入队列」）
 * 搬运位置：接在队尾（预排本来就不是「下一曲」，避免抢别人的歌）。
 */
export function promotePending(state: ResonanceRoomState, now: number, keepKey?: string): ResonanceRoomState {
  if (state.pending.length === 0) return state
  const forced = keepKey ? state.pending.find(track => track.key === keepKey) : undefined
  const promotable: ResonancePendingTrack[] = []
  const remaining: ResonancePendingTrack[] = []
  // 逐条判断，且用「已放行条数」累计，避免一次搬运把配额算漏
  const simState = { ...state }
  let queueLength = state.queue.length
  for (const track of state.pending) {
    if (queueLength >= RESONANCE_MAX_QUEUE) { remaining.push(track); continue }
    const eligible = forced ? track.key === keepKey : pendingReasonFor(simState, track.requestedBy) === null
    if (!eligible) { remaining.push(track); continue }
    promotable.push(track)
    queueLength += 1
    // 模拟这一步之后的配额状态，保证同一批里不会超发（轮次/配额都是按 queue 里的已有曲目算的）
    if (!forced) simState.queue = [...simState.queue, track]
  }
  if (promotable.length === 0) return state
  const moved = promotable.map(({ pendingReason: _reason, ...track }) => track as ResonanceTrack)
  return {
    ...state,
    queue: [...state.queue, ...moved],
    pending: remaining,
    seq: state.seq + 1,
    members: touchMember(state.members, promotable[0].requestedBy, now),
  }
}

/** 房主丢掉一条预排 */
export function dismissPending(state: ResonanceRoomState, trackKey: string): ResonanceRoomState {
  if (!state.pending.some(track => track.key === trackKey)) return state
  return { ...state, pending: state.pending.filter(track => track.key !== trackKey), seq: state.seq + 1 }
}

function touchMember(members: ResonanceMember[], peerId: string, now: number): ResonanceMember[] {
  return members.map(member => (member.peerId === peerId ? { ...member, lastSeenAt: now, online: true } : member))
}

/**
 * 我推荐模式：当前轮到的成员。
 * 规则（对应需求「房主先推第一首，之后按入房顺序轮流，每人 1-3 首」）：
 * 1. 队尾贡献者若还有配额，就由他继续加（一次可加 1~quota 首）；
 * 2. 否则按 seat 升序（环形）找下一个还有配额的成员；
 * 3. 全员配额用尽 → 回到 seat 最小者，开启新一轮。
 */
export function currentTurnPeerId(state: ResonanceRoomState): string | null {
  if (state.mode !== 'round-robin') return null
  const ordered = [...state.members].sort((left, right) => left.seat - right.seat)
  if (ordered.length === 0) return null
  const lastContributor = state.queue.length > 0 ? state.queue[state.queue.length - 1].requestedBy : null
  if (!lastContributor) return state.hostId
  const lastIndex = ordered.findIndex(member => member.peerId === lastContributor)
  if (lastIndex >= 0 && tracksAddedThisTurn(state, lastContributor) < state.quota) return lastContributor
  for (let step = 1; step <= ordered.length; step += 1) {
    const member = ordered[(lastIndex + step) % ordered.length]
    if (tracksAddedThisTurn(state, member.peerId) < state.quota) return member.peerId
  }
  return ordered[0].peerId
}

/** 统计某成员在当前轮次里已加的歌数（从队尾往前数到上一位成员为止） */
export function tracksAddedThisTurn(state: ResonanceRoomState, peerId: string): number {
  let count = 0
  for (let index = state.queue.length - 1; index >= 0; index -= 1) {
    const track = state.queue[index]
    if (track.requestedBy === peerId) { count += 1; continue }
    if (count > 0) break
  }
  return count
}

/** 投票阈值：当前在线人数 × 80%，向上取整（1 人房间恒为 1 票） */
export function skipVoteThreshold(onlineCount: number): number {
  if (onlineCount <= 1) return 1
  return Math.ceil(onlineCount * RESONANCE_SKIP_RATIO)
}

export function onlineCount(state: ResonanceRoomState): number {
  return state.members.filter(member => member.online).length
}

export type VoteResult = { ok: true; state: ResonanceRoomState; passed: boolean } | { ok: false; reason: 'room-closed' | 'not-member' | 'no-vote' }

/** 成员发起/追加「跳过此曲」投票；达到阈值即通过（是否真的切歌由上层执行） */
export function castSkipVote(state: ResonanceRoomState, peerId: string, target: string | null): VoteResult {
  if (state.closed) return { ok: false, reason: 'room-closed' }
  if (!state.members.some(member => member.peerId === peerId)) return { ok: false, reason: 'not-member' }
  const vote: ResonanceSkipVote = state.vote && state.vote.target === target
    ? { target, by: state.vote.by.includes(peerId) ? state.vote.by : [...state.vote.by, peerId] }
    : { target, by: [peerId] }
  const nextState: ResonanceRoomState = { ...state, vote, seq: state.seq + 1 }
  return { ok: true, state: nextState, passed: vote.by.length >= skipVoteThreshold(onlineCount(nextState)) }
}

/** 撤销/清理投票（切歌后调用） */
export function clearVote(state: ResonanceRoomState): ResonanceRoomState {
  return state.vote ? { ...state, vote: null, seq: state.seq + 1 } : state
}

/** 房主强制跳过：不发起投票，直接清空投票并交回上层切歌 */
export function hostForceSkip(state: ResonanceRoomState, peerId: string): { ok: boolean; state: ResonanceRoomState } {
  if (state.closed || peerId !== state.hostId) return { ok: false, state }
  return { ok: true, state: clearVote(state) }
}

/**
 * 应用房主下发的播放状态：低任期（交接前的旧权威）消息一律丢弃。
 * hard=true 表示需要立即对齐（首帧 / 换歌 / 播放暂停切换 / 拖动进度），否则成员只做缓慢漂移修正。
 */
export function applyPlayback(
  state: ResonanceRoomState,
  playback: ResonancePlayback,
  fromPeer: string,
  now = Date.now(),
): { ok: boolean; state: ResonanceRoomState; hard: boolean } {
  if (state.closed) return { ok: false, state, hard: false }
  // 权威仍是房主；被临时授权的成员（或房主放开了成员控制）也可以下发播放状态
  if (!canControlPlayback(state, fromPeer, now)) return { ok: false, state, hard: false }
  if (playback.term < state.term) return { ok: false, state, hard: false }
  if (state.playback && playback.seq <= state.playback.seq) return { ok: false, state, hard: false }
  const previous = state.playback
  // 用上一条状态外推「此刻应有的位置」，与本次上报位置差距过大说明房主 seek 了
  const expectedMs = previous
    ? (previous.playing ? previous.positionMs + Math.max(0, playback.atHostClock - previous.atHostClock) : previous.positionMs)
    : playback.positionMs
  const drift = Math.abs(playback.positionMs - expectedMs)
  const hard = !previous
    || previous.trackKey !== playback.trackKey
    || previous.playing !== playback.playing
    || drift > 1500
  const cursor = playback.trackKey
    ? state.queue.findIndex(track => track.key === playback.trackKey)
    : state.cursor
  return {
    ok: true,
    hard,
    state: {
      ...state,
      cursor: cursor >= 0 ? cursor : state.cursor,
      playback,
      vote: hard ? null : state.vote,
      seq: state.seq + 1,
    },
  }
}

/** 推进到队列下一首（房主权威调用） */
export function advanceQueue(state: ResonanceRoomState): ResonanceRoomState {
  const next = state.cursor + 1
  // 队列放到底也清投票：否则最后一首上发起的票会永远留在房间里（下次播放时莫名「已过半」）
  if (next >= state.queue.length) return { ...state, cursor: state.queue.length > 0 ? -1 : state.cursor, seq: state.seq + 1, vote: null }
  return { ...state, cursor: next, seq: state.seq + 1, vote: null }
}

/** 成员上报「这首歌我播不了」（会员/版权限制），房主界面据此提示 */
export function reportCannotPlay(
  state: ResonanceRoomState,
  peerId: string,
  trackKey: string,
  tier: EntitlementTier,
): ResonanceRoomState {
  return {
    ...state,
    seq: state.seq + 1,
    members: state.members.map(member => (
      member.peerId === peerId ? { ...member, unableToPlay: trackKey, unableToPlayTier: tier } : member
    )),
  }
}

/** 心跳：更新在线状态；返回是否有成员由在线转为离线 */
export function heartbeat(state: ResonanceRoomState, peerId: string, now: number): { state: ResonanceRoomState; changed: boolean } {
  let changed = false
  const members = state.members.map(member => {
    if (member.peerId !== peerId) return member
    if (!member.online || member.lastSeenAt !== now) changed = true
    return { ...member, online: true, lastSeenAt: now }
  })
  return { state: changed ? { ...state, members } : state, changed }
}

/** 标记超时离线的成员（连续 3 次心跳丢失 ≈ 6s 未上报） */
export function markOffline(state: ResonanceRoomState, now: number, timeoutMs = 6000): ResonanceRoomState {
  let changed = false
  const members = state.members.map(member => {
    if (!member.online || now - member.lastSeenAt <= timeoutMs) return member
    changed = true
    return { ...member, online: false }
  })
  return changed ? { ...state, members, seq: state.seq + 1 } : state
}

/**
 * 移除队列里的曲目：房主可移除任意，成员只能移除自己点的。
 * 返回 removedIndex 供上层判断是否要切歌。
 */
export function removeTrack(
  state: ResonanceRoomState,
  peerId: string,
  trackKey: string,
): { ok: false; reason: 'room-closed' | 'not-found' | 'not-allowed' } | { ok: true; state: ResonanceRoomState; removedIndex: number; wasCurrent: boolean } {
  if (state.closed) return { ok: false, reason: 'room-closed' }
  const index = state.queue.findIndex(track => track.key === trackKey)
  if (index < 0) return { ok: false, reason: 'not-found' }
  const isHost = peerId === state.hostId
  if (!isHost && state.queue[index].requestedBy !== peerId) return { ok: false, reason: 'not-allowed' }
  const queue = state.queue.filter((_, itemIndex) => itemIndex !== index)
  const wasCurrent = index === state.cursor
  const cursor = index < state.cursor ? state.cursor - 1 : (wasCurrent ? Math.min(index, queue.length - 1) : state.cursor)
  return {
    ok: true,
    removedIndex: index,
    wasCurrent,
    state: { ...state, queue, cursor: queue.length === 0 ? -1 : cursor, seq: state.seq + 1, vote: wasCurrent ? null : state.vote },
  }
}

/** 置顶（下一首播放）：房主可对任意曲目，成员只能对自己点的 */
export function moveTrackNext(
  state: ResonanceRoomState,
  peerId: string,
  trackKey: string,
): { ok: boolean; state: ResonanceRoomState } {
  if (state.closed) return { ok: false, state }
  const index = state.queue.findIndex(track => track.key === trackKey)
  if (index < 0) return { ok: false, state }
  const isHost = peerId === state.hostId
  if (!isHost && state.queue[index].requestedBy !== peerId) return { ok: false, state }
  const current = state.cursor >= 0 ? state.cursor : 0
  if (index === current + 1) return { ok: true, state }
  const queue = [...state.queue]
  const [track] = queue.splice(index, 1)
  const insertAt = Math.max(0, Math.min(queue.length, index > current ? current + 1 : current + 1))
  queue.splice(insertAt, 0, track)
  let cursor = state.cursor
  if (index < cursor) cursor -= 1
  if (insertAt <= cursor) cursor += 1
  return { ok: true, state: { ...state, queue, cursor: queue.length ? cursor : -1, seq: state.seq + 1 } }
}

export function dissolveRoom(state: ResonanceRoomState): ResonanceRoomState {
  return { ...state, closed: { reason: 'dissolved' }, seq: state.seq + 1 }
}

/** 队列摘要：状态广播只带窗口与总数，入房首包大小与歌单长度无关 */
export interface ResonanceQueueSummary {
  total: number
  cursor: number
  mode: ResonanceMode
  quota: number
  /** 当前曲目起的窗口（含当前曲目），供成员显示与本地对齐 */
  window: ResonanceTrack[]
  /** 窗口在完整队列里的起始下标 */
  windowOffset: number
  /** 房主当前是否允许成员控制 */
  memberControl: boolean
  controllerId: string | null
  controllerUntil: number
}

export function queueSummaryOf(state: ResonanceRoomState): ResonanceQueueSummary {
  const start = state.cursor >= 0 ? state.cursor : 0
  return {
    total: state.queue.length,
    cursor: state.cursor,
    mode: state.mode,
    quota: state.quota,
    window: state.queue.slice(start, start + RESONANCE_QUEUE_WINDOW),
    windowOffset: start,
    memberControl: state.memberControl,
    controllerId: state.controllerId,
    controllerUntil: state.controllerUntil,
  }
}

/** 队列分页（成员滚动队列时按需拉取） */
export function queuePageOf(state: ResonanceRoomState, offset: number, limit = RESONANCE_QUEUE_WINDOW): ResonanceTrack[] {
  const start = Math.max(0, Math.min(state.queue.length, Number(offset) || 0))
  return state.queue.slice(start, start + Math.max(1, Math.min(RESONANCE_QUEUE_WINDOW, limit)))
}

/**
 * 成员侧队列视图里的「还没拉到」占位行。
 * 成员的队列是「窗口 + 分页」拼起来的，缺口处用占位行占住下标，
 * 免得后面的曲目整体前移、行号与真实位置错位。
 * 占位行不是真歌（不能解析、不能预热、不能播放），消费方要用 isQueuePlaceholder 过滤掉。
 */
export const RESONANCE_QUEUE_PLACEHOLDER_PREFIX = '__queue-gap-'

export function queuePlaceholderAt(globalIndex: number): ResonanceTrack {
  return {
    key: `${RESONANCE_QUEUE_PLACEHOLDER_PREFIX}${globalIndex}`,
    title: '加载中…',
    artists: [],
    durationMs: 0,
    sources: [],
    requestedBy: '',
    seq: -1,
  }
}

export function isQueuePlaceholder(track?: ResonanceTrack | null): boolean {
  return Boolean(track?.key && track.key.startsWith(RESONANCE_QUEUE_PLACEHOLDER_PREFIX))
}

/** 控制权：房主或获得临时授权的成员可以控制播放 */
export function canControlPlayback(state: ResonanceRoomState, peerId: string, now: number): boolean {
  if (state.closed) return false
  if (peerId === state.hostId) return true
  // 先确认对方仍在名册里：被移出/已退房的 peer 若因中继竞态（kick 未送达、hub 重启）仍连着
  // socket，原本会因 memberControl 继续享有控制权，能改全房播放进度。
  if (!state.members.some(member => member.peerId === peerId)) return false
  if (state.controllerId === peerId && now < state.controllerUntil) return true
  return state.memberControl
}

/** 房主：开关「允许所有成员控制播放」 */
export function setMemberControl(state: ResonanceRoomState, peerId: string, enabled: boolean): ResonanceRoomState | null {
  if (peerId !== state.hostId) return null
  return { ...state, memberControl: enabled, seq: state.seq + 1 }
}

/** 房主：临时授权某成员控制播放（默认 5 分钟） */
export function grantControl(state: ResonanceRoomState, peerId: string, targetPeerId: string, now: number, durationMs = 5 * 60_000): ResonanceRoomState | null {
  if (peerId !== state.hostId) return null
  if (!state.members.some(member => member.peerId === targetPeerId)) return null
  return { ...state, controllerId: targetPeerId, controllerUntil: now + durationMs, seq: state.seq + 1 }
}

export function revokeControl(state: ResonanceRoomState, peerId: string): ResonanceRoomState | null {
  if (peerId !== state.hostId) return null
  if (!state.controllerId) return null
  return { ...state, controllerId: null, controllerUntil: 0, seq: state.seq + 1 }
}

/**
 * 线上状态：队列只带「从当前曲目起的窗口」，入房首包大小与歌单长度无关。
 * 完整队列由 queue-page 按需分页获取。
 */
export interface ResonanceStateWire {
  roomId: string
  createdAt: number
  mode: ResonanceMode
  hostId: string
  term: number
  quota: number
  partyQuota: number
  maxMembers: number
  members: ResonanceMember[]
  cursor: number
  playback: ResonancePlayback | null
  vote: ResonanceSkipVote | null
  closed: ResonanceRoomState['closed']
  seq: number
  memberControl: boolean
  controllerId: string | null
  controllerUntil: number
  suspended: boolean
  pending: ResonancePendingTrack[]
  queue: ResonanceTrack[]
  queueTotal: number
  queueOffset: number
  /**
   * 各成员「还能加几首」与「当前轮次轮到谁」。
   *
   * 必须由房主算好下发：成员本地只有队列窗口（从房主 cursor 起的 50 首），
   * 拿窗口算 `tracksAddedByPeer` / `currentTurnPeerId` 会少算已播过的部分，
   * 界面就会显示错误的额度、以及在「我推荐」模式下把人家的轮次判错。
   */
  remainingQuotaByPeer: Record<string, number>
  turnPeerId: string | null
}

export function serializeRoomState(state: ResonanceRoomState): ResonanceStateWire {
  const summary = queueSummaryOf(state)
  // 无穷大（共享歌单房主的整单推送）不能进制 JSON，用 -1 表示「不限」
  const remainingQuotaByPeer: Record<string, number> = {}
  for (const member of state.members) {
    const value = remainingAddQuota(state, member.peerId)
    remainingQuotaByPeer[member.peerId] = Number.isFinite(value) ? value : -1
  }
  return {
    roomId: state.roomId,
    createdAt: state.createdAt,
    mode: state.mode,
    hostId: state.hostId,
    term: state.term,
    quota: state.quota,
    partyQuota: state.partyQuota,
    maxMembers: state.maxMembers,
    members: state.members,
    cursor: state.cursor,
    playback: state.playback,
    vote: state.vote,
    closed: state.closed,
    seq: state.seq,
    memberControl: state.memberControl,
    controllerId: state.controllerId,
    controllerUntil: state.controllerUntil,
    suspended: state.suspended,
    pending: state.pending,
    queue: summary.window,
    queueTotal: summary.total,
    queueOffset: summary.windowOffset,
    remainingQuotaByPeer,
    turnPeerId: currentTurnPeerId(state),
  }
}

/** 反序列化：成员侧本地队列就是窗口（下标 0 = 房主当前曲目），完整总数另存 */
export function deserializeRoomState(wire: ResonanceStateWire): ResonanceRoomState {
  return {
    roomId: wire.roomId,
    createdAt: wire.createdAt,
    mode: wire.mode,
    hostId: wire.hostId,
    term: wire.term,
    quota: wire.quota,
    partyQuota: wire.partyQuota ?? RESONANCE_PARTY_QUOTA_DEFAULT,
    maxMembers: wire.maxMembers,
    members: wire.members,
    pending: wire.pending || [],
    queue: wire.queue,
    cursor: wire.queue.length > 0 ? 0 : -1,
    playback: wire.playback,
    vote: wire.vote,
    closed: wire.closed,
    seq: wire.seq,
    memberControl: wire.memberControl,
    controllerId: wire.controllerId,
    controllerUntil: wire.controllerUntil,
    suspended: Boolean(wire.suspended),
  }
}

/** 房间摘要（大厅/房主界面用）：人数、在线数、时长、本房听过的歌数 */
export function roomSummary(state: ResonanceRoomState, now: number) {
  return {
    memberCount: state.members.length,
    online: onlineCount(state),
    queueLength: state.queue.length,
    pendingCount: state.pending.length,
    listeningMinutes: Math.max(0, Math.floor((now - state.createdAt) / 60000)),
    mode: state.mode,
  }
}
