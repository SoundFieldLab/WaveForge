/**
 * 「共振」会话层：把「模型 + 端到端加密 + 传输」串成一个可供 UI 订阅的单例。
 *
 * 权威模型（与网易云多人一起听一致）：房主是唯一权威。
 * - 房主：任何模型变更 → 全量状态广播（状态很小，15 人规模下最简单可靠）；播放进度按 ~2s 推送。
 * - 成员：只发请求（点歌/投票/聊天/无法播放上报）；收到状态后写入本地模型并驱动播放对齐。
 * - 时钟：成员用 ping/pong 估计与房主的时钟偏移，用于把「房主此刻的进度」换算成本机应播到的位置。
 * - 隐私：所有消息用房间密钥加密；传输层（局域网中转/WebRTC）只能看到密文。
 */
import {
  RESONANCE_MAX_MEMBERS,
  addTracks,
  advanceQueue,
  applyPlayback,
  canonicalTrackKey,
  isQueuePlaceholder,
  queuePlaceholderAt,
  remainingAddQuota,
  castSkipVote,
  clampQuota,
  clearVote,
  createRoomState,
  currentTurnPeerId,
  dissolveRoom,
  heartbeat,
  hostForceSkip,
  joinRoom,
  leaveRoom,
  updateMemberProfile,
  addPendingTracks,
  promotePending,
  dismissPending,
  markOffline,
  reportCannotPlay,
  roomSummary,
  queueSummaryOf,
  queuePageOf,
  canControlPlayback,
  setMemberControl,
  grantControl,
  revokeControl,
  removeTrack,
  moveTrackNext,
  serializeRoomState,
  deserializeRoomState,
  RESONANCE_QUEUE_WINDOW,
  type ResonanceStateWire,
  type ResonanceIdentity,
  type ResonanceMode,
  type ResonancePlayback,
  type ResonancePlatformBadge,
  type ResonanceRoomState,
  type ResonanceTrack,
} from './model'
import {
  ReplayGuard,
  deriveRoomKey,
  generateRoomSecret,
  openMessage,
  roomFingerprint,
  sealMessage,
  type ResonanceEnvelope,
} from './crypto'
import {
  buildInvite,
  createLanHostTransport,
  createLanMemberTransport,
  parseInvite,
  pickInviteHost,
  type ResonanceTransport,
} from './transport'
import { readResonanceJoinBehavior, readResonancePushLimit, readResonanceSettings } from './settings'

export type ResonanceStatus = 'idle' | 'hosting' | 'joining' | 'connected' | 'closed' | 'error'

export interface ResonanceChatMessage {
  id: string
  peerId: string
  nickname: string
  text: string
  at: number
  self: boolean
}

export interface ResonanceClockSample { offsetMs: number; rttMs: number }

export interface ResonanceSessionSnapshot {
  status: ResonanceStatus
  role: 'host' | 'member' | null
  error: string
  room: ResonanceRoomState | null
  invite: string
  fingerprint: string
  chat: ResonanceChatMessage[]
  summary: { memberCount: number; online: number; queueLength: number; pendingCount?: number; listeningMinutes: number } | null
  clock: ResonanceClockSample
  /** 成员：本机解析不了的曲目（key → 原因） */
  unplayable: Record<string, string>
  /** 房间是否被挂起（房主切去别的模式听自己的歌，房间留着） */
  suspended: boolean
  /** 我推荐模式下是否轮到我 */
  myTurn: boolean
  /** 是否已加入且连接正常 */
  live: boolean
  /** 队列窗口（入房首包只带这么多；滚动时按需拉取） */
  queue: { items: ResonanceTrack[]; offset: number; total: number }
  /** 我此刻能否控制播放（房主 / 获授权 / 房主放开了成员控制） */
  canControl: boolean
  /** 房主视角：正在申请控制播放的成员 */
  controlRequests: string[]
  /**
   * 各成员「还能加几首」（房主下发；-1 = 不限）。成员本地只有队列窗口，算不准自己/别人的额度。
   * 房主自己按本机完整队列算，这里是同步镜像，UI 优先用它。
   */
  remainingQuotaByPeer: Record<string, number>
  /** 「我推荐」模式当前轮到谁（房主下发；成员按窗口算会算错） */
  turnPeerId: string | null
}

/** 播放适配器：由 App 注入，会话不直接依赖播放器实现 */
export interface ResonancePlaybackAdapter {
  /** 房主：读取本机播放状态（用于广播） */
  readLocal: () => { trackKey: string; positionMs: number; playing: boolean } | null
  /** 成员：把房主的权威播放状态应用到本机；hard=立即对齐（换歌/暂停切换/房主拖进度） */
  apply: (playback: { trackKey: string; positionMs: number; playing: boolean }, hard: boolean) => void
  /** 队列变化：把整房共享队列写入本机播放器（startIndex 为当前曲目下标） */
  setQueue: (tracks: ResonanceTrack[], startIndex: number) => void
  /** 解析曲目在本机能否播放（跨平台匹配 + 会员校验），成员在收到队列变化时调用 */
  canPlay: (track: ResonanceTrack) => Promise<{ playable: boolean; tier?: string; reason?: string }>
}

interface SessionOptions {
  bridge?: NonNullable<Window['electron']>['resonance']
}

const HEARTBEAT_MS = 2000
// 后台窗口的定时器会被 Electron 节流，在线判定放宽到 30s；真正断线由中转的 peer-left 兜底
const OFFLINE_AFTER_MS = 30_000
const PLAYBACK_PUSH_MS = 2000
/** 队列分页请求的在途超时：超过就允许重发（限流丢包/房主卡顿时不至于永久卡页） */
const QUEUE_PAGE_TIMEOUT_MS = 5000
/** 「入房行为 = 等下一首」的判定门槛：房主已播过这么久才算「从中间接入」，值得跳过 */
const JOIN_SKIP_MIN_POSITION_MS = 3000
/** 控制申请的最短重发间隔：避免连点把房主待办刷满 */
const CONTROL_REQUEST_COOLDOWN_MS = 30_000
const CLOCK_PING_MS = 5000
const CHAT_LIMIT = 200

type EnvelopeKind =
  | 'hello' | 'welcome' | 'state' | 'queue-request' | 'queue-page' | 'queue-remove' | 'queue-move'
  | 'chat' | 'playback' | 'vote' | 'force-skip' | 'cannot-play' | 'leave' | 'dissolve'
  | 'control-request' | 'control-grant' | 'control-revoke' | 'next-request' | 'ping' | 'pong'

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now())

export class ResonanceSession {
  private readonly options: SessionOptions

  constructor(options: SessionOptions = {}) {
    this.options = options
  }

  private transport: ResonanceTransport | null = null
  private adapter: ResonancePlaybackAdapter | null = null
  private listeners = new Set<() => void>()
  private snapshot: ResonanceSessionSnapshot = {
    status: 'idle', role: null, error: '', room: null, invite: '', fingerprint: '', chat: [],
    summary: null, clock: { offsetMs: 0, rttMs: 0 }, unplayable: {}, myTurn: false, live: false,
    queue: { items: [], offset: 0, total: 0 }, canControl: false, controlRequests: [],
    remainingQuotaByPeer: {}, turnPeerId: null, suspended: false,
  }
  private roomKey = ''
  /** 房间号：加密信封的 AAD 与中转校验都依赖它，成员在收到房主状态前就必须已知 */
  private roomId = ''
  private identity: ResonanceIdentity | null = null
  private readonly replay = new ReplayGuard()
  private sendSeq = 0
  /** 本机是否把共振挂起来了（切去别的模式，房间保留、仍可右键推歌） */
  private suspended = false
  /** 「下一曲」插入锚点：上一首 next 推送的歌（保证连推时顺序不倒） */
  private nextAnchorKey: string | null = null
  /** 成员侧：房主队列的总数与窗口偏移（用于 UI 显示与分页） */
  private queueMeta = { total: 0, offset: 0 }
  /** 成员侧：已按需拉取的队列分页缓存（全局偏移 -> items） */
  private queuePages = new Map<number, ResonanceTrack[]>()
  /** 成员侧：已发出、还没收到回包的 queue-page 偏移 → 发出时间（防止滚动时对同一页重复请求） */
  private pendingQueueRequests = new Map<number, number>()
  /** 成员侧：上一次收到的窗口（绝对偏移 + 曲目 key 列表），用于判断房主是否增删了队列 */
  private queueWindowOffset = 0
  private queueWindowTotal = 0
  private queueWindowKeys: string[] = []
  /** 已经上报过「无法播放」的曲目：同一首只报一次，避免状态→检查→上报→状态的风暴 */
  private reportedUnplayable = new Set<string>()
  /** 已经检查过可播性的曲目（含能播的）：同一首不重复解析/取流 */
  private checkedPlayable = new Set<string>()
  /**
   * 成员「入房行为 = 等下一首」：
   * pendingJoinSkip = 入房后还在等第一条权威播放状态（此时还不知道该跳过哪首）；
   * skipFirstApplyTrackKey = 已经认定「这首不跟」，等房主换歌后这一段等待自动结束。
   */
  private pendingJoinSkip = false
  private skipFirstApplyTrackKey: string | null = null
  /** 出站限流窗口（毫秒级防风暴兜底） */
  private outboundWindow: number[] = []
  private timers: number[] = []
  private lastPlaybackPushAt = 0
  /**
   * 房主刚主动切歌时期望本机跟上的曲目 key。
   * 房主点「下一首」后本机要现加载新歌，这段窗口内 readLocal 还返回上一首；
   * 用它压过本机读数，避免 cursor 被反推回去。
   * 生命周期：本机真的放到它、或 cursor 已经不是它了 → 清空（刻意不用超时，见 pushPlayback）。
   */
  private hostExpectedTrackKey: string | null = null
  /** 本机上次发出「申请控制播放」的时间（防连点刷屏） */
  private controlRequestedAt = 0

  setAdapter(adapter: ResonancePlaybackAdapter | null): void {
    this.adapter = adapter
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): ResonanceSessionSnapshot => this.snapshot

  /** 本机身份：昵称 + 已登录平台的会员徽章（不含任何账号信息） */
  setIdentity(identity: ResonanceIdentity): void {
    const previous = this.identity
    this.identity = identity
    // 首次挂载不算「改名」（入房时已经发过身份），避免无意义广播
    const changed = previous !== null && (
      previous.nickname !== identity.nickname
      || previous.avatarUrl !== identity.avatarUrl
      || previous.nicknameFrom !== identity.nicknameFrom
      || (previous.platforms?.length ?? 0) !== (identity.platforms?.length ?? 0)
    )
    if (!this.snapshot.room) return
    this.patchRoom(state => updateMemberProfile(state, identity) || state)
    if (!changed) return
    // 房间里改名要让别人也看到：房主广播状态，成员重发 hello（房主据此更新名册）
    if (this.snapshot.role === 'host') this.broadcastState()
    else if (this.snapshot.role === 'member') this.sendIdentity()
  }

  getIdentity(): ResonanceIdentity | null {
    return this.identity
  }

  /** 调试用：手动尝试解密一个信封，返回 ok/reason（排查「成员加不进来」这类问题） */
  debugOpen(envelope: ResonanceEnvelope): { ok: boolean; reason?: string; kind?: string; roomId?: string } {
    if (!this.roomKey) return { ok: false, reason: 'no-room-key' }
    const result = openMessage(this.roomKey, envelope, this.roomId)
    if (!result.ok) return { ok: false, reason: result.reason, roomId: String((envelope as ResonanceEnvelope)?.roomId || '') }
    return { ok: true, kind: result.envelope.kind, roomId: result.envelope.roomId }
  }

  /** 创建房间（房主）：起局域网中转 → 生成房间密钥 → 建立本地房间状态 */
  /** 逐出仍在主进程里运行的旧房间中转（渲染进程重载/上一次没退干净时会留下僵尸房间）。 */
  private async releaseRelay(force = false): Promise<void> {
    const host = this.transport
    this.transport = null
    if (host) { try { await host.close() } catch { /* 已经停了 */ } }
    // 即便本会话没有 transport（例如渲染进程刚重载），主进程里的中转也可能还在占着房间号
    const bridge = this.options.bridge
    if (!bridge) return
    try {
      const status = await bridge.getStatus()
      if (status?.running && status.roomId && (force || status.roomId !== this.roomId)) await bridge.stop()
    } catch { /* 主进程不可用：交给 start 的真实错误上报 */ }
  }

  async create(options: {
    roomId: string
    nickname: string
    platforms: ResonancePlatformBadge[]
    mode: ResonanceMode
    quota?: number
    partyQuota?: number
    code?: string
    maxMembers?: number
    port?: number
    peerId?: string
    avatarUrl?: string
    nicknameFrom?: string
  }): Promise<void> {
    // 先确保主进程里的旧中转停下来：它可能还在跑上一次的房间（重载渲染进程、
    // 或上一次解散没走完），不释放就会在 start 时被拒成「房间已在进行中」。
    await this.releaseRelay()
    this.reset()
    const peerId = options.peerId || globalThis.crypto.randomUUID()
    const at = Date.now()
    this.identity = { peerId, nickname: options.nickname, platforms: options.platforms, joinedAt: at, avatarUrl: options.avatarUrl || '', nicknameFrom: options.nicknameFrom || '' }
    // 房间密钥由邀请串里的种子派生：中转/监听者拿不到种子，也就解不开内容
    this.roomId = options.roomId
    const secret = generateRoomSecret()
    this.roomKey = await deriveRoomKey(secret, options.roomId)
    this.update({ status: 'hosting', role: 'host', error: '' })

    // 端口可能被别的程序（或上一次没退干净的进程）占用：从设定端口起顺延尝试，最多 10 个
    const basePort = Number(options.port) || 25570
    const candidates = Array.from({ length: 10 }, (_, index) => basePort + index)
    let transport: ResonanceTransport | null = null
    let lastError: unknown = null
    for (const candidate of candidates) {
      const attempt = createLanHostTransport({
        roomId: options.roomId,
        code: options.code,
        maxMembers: Math.min(RESONANCE_MAX_MEMBERS, options.maxMembers || RESONANCE_MAX_MEMBERS),
        port: candidate,
        selfPeerId: peerId,
        bridge: this.options.bridge,
        // 设置项「允许局域网发现」：关掉后中转的 /discover 返回 404，别人扫不到这个房间
        discoverable: readResonanceSettings().lanDiscovery,
      })
      try {
        await attempt.connect()
        transport = attempt
        if (candidate !== basePort) {
          this.update({ error: '' })
          window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `端口 ${basePort} 被占用，已改用 ${candidate} 建房间`, type: 'info' } }))
        }
        break
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        // 只有「端口被占用」才顺延；其它错误（缺桌面能力等）直接抛出，避免掩盖问题
        if (!/EADDRINUSE|address already in use/i.test(message)) break
      }
    }
    if (!transport) {
      const message = lastError instanceof Error ? lastError.message : '创建房间失败'
      const friendly = /EADDRINUSE|address already in use/i.test(message)
        ? `端口 ${basePort}–${basePort + 9} 都被占用了，请在共振设置里换一个端口`
        : /需要桌面端|not support/i.test(message) ? '当前环境无法承载房间中转（需要在桌面端使用）' : message
      this.update({ status: 'error', error: friendly })
      throw new Error(friendly)
    }
    this.transport = transport
    transport.onEnvelope((envelope, from) => this.handleEnvelope(envelope, from))
    transport.onPeerEvent(event => {
      if (event.type === 'peer-left') this.patchRoom(state => leaveRoom(state, event.peerId).state)
      else if (event.type === 'closed') this.update({ status: 'closed', live: false, error: '房间中转已关闭' })
    })

    const room = createRoomState({ roomId: options.roomId, host: this.identity, mode: options.mode, quota: options.quota, partyQuota: options.partyQuota, maxMembers: options.maxMembers, now: at })
    // 房主侧传输负责回读真实端口与房间码（端口顺延时端口与设定值不同）
    const info = (transport as ReturnType<typeof createLanHostTransport>).startResult()
    const invite = info ? buildInvite({ roomId: options.roomId, code: info.code, secret, host: pickInviteHost((await this.options.bridge?.getStatus())?.ips), port: info.port }) : ''
    this.update({ status: 'connected', role: 'host', room, invite, live: true, summary: roomSummary(room, at) })
    void this.refreshFingerprint()
    this.startTimers()
    this.broadcastState()
  }

  /** 加入房间（成员）：解析邀请串 → 连房主中转 → 用房间密钥解密房间状态 */
  async join(inviteText: string, profile: { nickname: string; platforms: ResonancePlatformBadge[]; peerId?: string; avatarUrl?: string; nicknameFrom?: string }): Promise<void> {
    // 成员不该继续挂着本机的中转：先停掉（强制的，自己当房主的那个房间已经放弃了）
    await this.releaseRelay(true)
    this.reset()
    const invite = parseInvite(inviteText)
    if (!invite) {
      this.update({ status: 'error', error: '邀请串无法识别' })
      throw new Error('邀请串无法识别')
    }
    if (!invite.host) {
      this.update({ status: 'error', error: '邀请串缺少房主地址（请用完整邀请串或局域网扫码）' })
      throw new Error('邀请串缺少房主地址')
    }
    // 邀请串里带着密钥种子：成员本地派生，密钥不经中转
    this.roomId = invite.roomId
    this.roomKey = await deriveRoomKey(invite.secret, invite.roomId)
    const peerId = profile.peerId || globalThis.crypto.randomUUID()
    this.identity = { peerId, nickname: profile.nickname, platforms: profile.platforms, joinedAt: Date.now(), avatarUrl: profile.avatarUrl || '', nicknameFrom: profile.nicknameFrom || '' }
    this.update({ status: 'joining', role: 'member', invite: inviteText, error: '' })

    const transport = createLanMemberTransport({ host: invite.host, port: invite.port, roomId: invite.roomId, code: invite.code })
    transport.onEnvelope((envelope, from) => this.handleEnvelope(envelope, from))
    transport.onPeerEvent(event => {
      if (event.type === 'closed') {
        // 与房主的连接断了（房主关窗/掉线/被踢）：房间不再可用。
        // 必须把 room 清掉——上层据此判断「房间结束了」，用来还原本机播放列表等；
        // 已经给出更具体的原因（如房主解散）时不要用泛化文案覆盖。
        this.snapshot = {
          ...this.snapshot,
          status: 'closed',
          live: false,
          room: null,
          summary: null,
          myTurn: false,
          error: this.snapshot.error || '与房主的连接已断开',
        }
        this.notify()
      }
    })
    try {
      await transport.connect()
    } catch (error) {
      this.update({ status: 'error', error: error instanceof Error ? error.message : '加入房间失败' })
      throw error
    }
    this.transport = transport
    // 关键：采纳中转分配的 peerId 作为自己的身份 id。
    // 否则成员会有两套 id（会话生成的 + 中转分配的），房主按中转 id 记录成员，
    // 后续的投票/加歌/移除请求会被判成「非成员」而丢弃。
    const assignedPeerId = transport.selfPeerId
    if (assignedPeerId && this.identity) {
      this.identity = { ...this.identity, peerId: assignedPeerId }
    }
    await this.refreshFingerprint()
    this.update({ status: 'connected', live: true })
    this.sendIdentity()
    // 入房行为（设置项）：'next' = 不打断本机正在听的东西，等房主换下一首再开始跟随。
    // 此刻还没收到房主状态，不知道「正在放哪首」，所以只挂一个待决标记；
    // 第一条权威播放状态到达时再把它的 trackKey 记为「要跳过的这首」（见 playback 分支）。
    this.pendingJoinSkip = this.readJoinBehavior() === 'next'
    this.startTimers()
  }

  /** 入房行为设置（'resume' = 续接当前进度，'next' = 等下一首）。读不到就当续接 */
  private readJoinBehavior(): 'resume' | 'next' {
    return readResonanceJoinBehavior()
  }

  /** 房主：解散房间 */
  dissolve(): void {
    if (this.snapshot.role === 'host' && this.snapshot.room) {
      this.patchRoom(state => dissolveRoom(state))
      this.broadcast({ kind: 'dissolve', payload: {} })
    }
    this.leave()
  }

  /** 成员：退出；房主：等价于解散（上层会提示交接语义由模式决定） */
  leave(): void {
    if (this.transport && this.roomKey) this.broadcast({ kind: 'leave', payload: { peerId: this.identity?.peerId || '' } })
    this.stopTimers()
    this.transport?.close()
    this.transport = null
    this.replay.reset()
    this.roomKey = ''
    this.update({ status: 'closed', live: false, room: null, summary: null, myTurn: false })
  }

  /** 主动断开并回到初始状态（下次创建/加入前调用） */
  reset(): void {
    this.stopTimers()
    void this.transport?.close()
    this.transport = null
    this.suspended = false
    this.nextAnchorKey = null
    this.replay.reset()
    this.roomKey = ''
    this.roomId = ''
    this.sendSeq = 0
    this.queueMeta = { total: 0, offset: 0 }
    this.queuePages.clear()
    this.pendingQueueRequests.clear()
    this.queueWindowOffset = 0
    this.queueWindowTotal = 0
    this.queueWindowKeys = []
    this.reportedUnplayable.clear()
    this.checkedPlayable.clear()
    this.pendingJoinSkip = false
    this.skipFirstApplyTrackKey = null
    this.hostExpectedTrackKey = null
    this.controlRequestedAt = 0
    this.outboundWindow = []
    // 注意：不要清空订阅者——创建/加入时都会 reset，而界面组件在房间生命周期内一直挂着，
    // 清掉会让「加入成功后界面不刷新」（数据已到位但 React 不再收到通知）。
    this.snapshot = {
      status: 'idle', role: null, error: '', room: null, invite: '', fingerprint: '', chat: [],
      summary: null, clock: { offsetMs: 0, rttMs: 0 }, unplayable: {}, myTurn: false, live: false,
      queue: { items: [], offset: 0, total: 0 }, canControl: false, controlRequests: [],
      remainingQuotaByPeer: {}, turnPeerId: null, suspended: false,
    }
    this.notify()
  }

  // ── 房主权威操作 ────────────────────────────────────────────────────────────
  /** 单次推送上限（设置项，默认 200） */
  pushLimit(): number {
    return readResonancePushLimit()
  }

  /**
   * 房主：推歌（共享歌单整单推送用 playlistPush）。
   * `added` 是**真正入队**的条数：`addTracks` 还会因为队列上限（300）、配额、以及「队列里已有同一首」而少加，
   * 所以不能拿「传入条数 − truncated」当结果去告诉用户（那会把 10 首说成 200 首）。
   */
  hostAddTracks(tracks: Array<Omit<ResonanceTrack, 'key' | 'seq' | 'requestedBy'>>, playlistPush = false): { ok: boolean; reason?: string; truncated?: number; added?: number } {
    const state = this.snapshot.room
    const peerId = this.identity?.peerId
    if (!state || !peerId) return { ok: false, reason: 'no-room' }
    if (state.hostId !== peerId) return { ok: false, reason: 'not-host' }
    const limit = this.pushLimit()
    const list = tracks.length > limit ? tracks.slice(0, limit) : tracks
    const truncated = tracks.length - list.length
    const result = addTracks(state, peerId, list, Date.now(), { playlistPush })
    if (!result.ok) return { ok: false, reason: result.reason }
    this.commit(result.state)
    this.flushPending()
    return { ok: true, truncated, added: result.added.length }
  }

  /**
   * 房主：把歌「推」进房间（右键「推送至共振」走这里，也用于挂起态下的推送）。
   *
   * 规则（对应「根据逻辑直接加入下一曲（如果允许）或者引入队列（预排队）」）：
   * 1. 现在就能加 → 插到当前曲目之后（等于设成下一曲）；
   * 2. 现在不能加（不在自己轮次 / 配额用完 / 共享歌单模式的成员）→ 挂进预排队，等资格放开。
   */
  private pushIntoRoom(peerId: string, tracks: Array<Omit<ResonanceTrack, 'key' | 'seq' | 'requestedBy'>>, now: number): {
    ok: boolean
    mode: 'next' | 'pending'
    reason?: string
  } {
    const state = this.snapshot.room
    if (!state || state.closed) return { ok: false, mode: 'next', reason: 'room-closed' }
    const direct = addTracks(state, peerId, tracks, now, {
      position: 'next',
      // 共享歌单的 host 可以单曲推送；`playlistPush` 只是绕过「整单入口」的权限守卫，
      // 不会把这首歌当成整张歌单，也不影响成员的权限校验。
      playlistPush: state.mode === 'shared-playlist' && peerId === state.hostId,
      anchorKey: this.nextAnchorKey,
    })
    if (direct.ok) {
      // 记住插到哪了：连推 A、B、C 时保持 A→B→C，而不是倒序
      this.nextAnchorKey = direct.added[direct.added.length - 1]?.key || null
      this.commit(direct.state)
      return { ok: true, mode: 'next' }
    }
    // 「这首歌已经在队列里」不算失败：预排也放不进去，直接当成已存在
    if (direct.reason === 'empty') return { ok: true, mode: 'pending' }
    if (direct.reason !== 'quota-exceeded' && direct.reason !== 'not-your-turn' && direct.reason !== 'not-host') {
      return { ok: false, mode: 'next', reason: direct.reason }
    }
    const pending = addPendingTracks(this.snapshot.room || state, peerId, tracks, now)
    if (!pending.ok) {
      return { ok: false, mode: 'pending', reason: pending.reason === 'already-in-queue' ? 'empty' : pending.reason }
    }
    this.commit(pending.state)
    return { ok: true, mode: 'pending' }
  }

  /** 本机（房主或成员）推送一首歌进房间：返回给用户看的结果 */
  pushTrack(track: Omit<ResonanceTrack, 'key' | 'seq' | 'requestedBy'>): { ok: boolean; mode?: 'next' | 'pending'; reason?: string } {
    const peerId = this.identity?.peerId
    if (!peerId || !this.snapshot.room || !this.snapshot.live) return { ok: false, reason: 'no-room' }
    if (this.snapshot.role === 'host') {
      const result = this.pushIntoRoom(peerId, [track], Date.now())
      if (result.ok && result.mode === 'next') this.pushPlayback(true)
      return result
    }
    this.requestAddTracks([track], { position: 'next' })
    return { ok: true, mode: 'next' }
  }

  /** 房主：手动放行一条预排（无视资格） */
  hostPromotePending(trackKey: string): void {
    const state = this.snapshot.room
    if (!state || this.snapshot.role !== 'host') return
    const next = promotePending(state, Date.now(), trackKey)
    if (next === state) return
    this.commit(next)
  }

  /** 房主：丢掉一条预排 */
  hostDismissPending(trackKey: string): void {
    const state = this.snapshot.room
    if (!state || this.snapshot.role !== 'host') return
    const next = dismissPending(state, trackKey)
    if (next === state) return
    this.commit(next)
  }

  /** 房主：把够格的预排搬进队列（轮次/额度发生变化时自动调用） */
  private flushPending(): void {
    const state = this.snapshot.room
    if (!state || this.snapshot.role !== 'host' || state.pending.length === 0) return
    const next = promotePending(state, Date.now())
    if (next !== state) this.commit(next)
  }

  /** 挂起：房间留着、停止同步本机播放，成员会看到「房主已挂起」 */
  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return
    this.suspended = suspended
    if (this.snapshot.room) {
      const state = this.snapshot.room
      const next: ResonanceRoomState = { ...state, suspended, seq: state.seq + 1 }
      this.commit(next)
    } else {
      this.snapshot = { ...this.snapshot, suspended }
      this.notify()
    }
  }

  isSuspended(): boolean {
    return this.suspended
  }

  /**
   * 房主 / 获授权控制者：下一首。
   * 房间的权威只有房主一个：获授权（或房主放开了成员控制）的成员点「下一首」时，
   * 只向房主**发请求**，由房主推进队列并广播——否则该成员只会推进自己那份「窗口」副本，
   * 界面上闪一下就被下一次状态广播拽回去，而且谁也不会真的换歌。
   */
  hostNext(): void {
    const state = this.snapshot.room
    const peerId = this.identity?.peerId
    if (!state || !peerId) return
    if (!canControlPlayback(state, peerId, Date.now())) return
    if (state.hostId !== peerId) {
      this.broadcast({ kind: 'next-request', payload: {} })
      return
    }
    const advanced = advanceQueue(state)
    this.nextAnchorKey = advanced.cursor >= 0 ? advanced.queue[advanced.cursor]?.key || null : null
    this.commit(advanced)
    // 房主本机也必须真的切到这首歌（否则 pushPlayback 会按本机读数把 cursor 反推回去）
    const target = advanced.cursor >= 0 ? advanced.queue[advanced.cursor] : null
    // 记住「期望本机跟上的曲目」：本机加载新歌期间 pushPlayback 用它压过 readLocal 的旧读数
    this.hostExpectedTrackKey = target?.key || null
    if (target) this.adapter?.apply({ trackKey: target.key, positionMs: 0, playing: true }, true)
    // 立刻把新曲目播报给房间：pushPlayback 现在以房间 cursor 为曲目权威（不再读本机可能还没切换的播放器），
    // 所以这里不会再把自己刚推进的 cursor 拽回去，而且成员能马上看到换歌。
    this.pushPlayback(true)
    // 换歌往往意味着轮次/额度松动了，顺手放行够格的预排
    this.flushPending()
  }

  /** 房主：强制跳过（清空投票并切歌） */
  hostForceSkip(): void {
    const state = this.snapshot.room
    const peerId = this.identity?.peerId
    if (!state || !peerId) return
    const result = hostForceSkip(state, peerId)
    if (!result.ok) return
    this.commit(result.state)
    this.hostNext()
  }

  /** 房主：踢人 */
  hostKick(peerId: string): void {
    if (this.snapshot.room?.hostId !== this.identity?.peerId) return
    void this.options.bridge?.kick(peerId)
    this.patchRoom(state => leaveRoom(state, peerId).state)
  }

  /** 房主：把播放状态广播出去（App 在播放状态变化与定时器里调用） */
  pushPlayback(force = false): void {
    const state = this.snapshot.room
    const peerId = this.identity?.peerId
    if (!state || !peerId) return
    // 挂起期间绝不下发播放状态：本机在放自己的歌，房间保持原状（成员界面有「已挂起」提示）
    if (this.suspended) return
    // 房主，或获得控制权的成员（含房主放开的成员控制）才允许下发播放状态
    if (!canControlPlayback(state, peerId, Date.now())) return
    const at = nowMs()
    if (!force && at - this.lastPlaybackPushAt < PLAYBACK_PUSH_MS) return
    // 没有适配器 = 共振界面已卸载（本机没在读播放状态）。此时不能下发：
    // 下面会把 local 兜底成 positionMs:0 / playing:false，等于向全员广播「从头暂停」，
    // 所有成员会被拉到 0:00 停住。心跳定时器仍在跑，所以这一定会发生。
    // 界面卸载（而非挂起）时房间本就该保持最后一次已知状态，等界面回来再继续驱动。
    const adapter = this.adapter
    if (!adapter) return
    const local = adapter.readLocal()
    if (!local) return
    this.lastPlaybackPushAt = at
    const cursorTrackKey = state.cursor >= 0 ? state.queue[state.cursor]?.key || null : null
    // 期望曲目的生命周期（刻意**不用超时**）：
    // - 本机真的放到它 → 达成，清掉（之后按本机读数走）；
    // - cursor 已经不是它了（又切了一首）→ 过期，清掉。
    // 不用超时的原因：房主点「下一首」后本机若加载慢/加载失败，正确行为是「房间就该放这首」，
    // 一旦超时回落本机旧读数，反而会把 cursor 拽回上一首、把成员拉回去。
    if (this.hostExpectedTrackKey
      && (local.trackKey === this.hostExpectedTrackKey || this.hostExpectedTrackKey !== cursorTrackKey)) {
      this.hostExpectedTrackKey = null
    }
    // 曲目选择（按优先级）：
    // 1. hostExpectedTrackKey：房主刚主动切歌，本机还在加载新歌（readLocal 仍返回上一首）。
    //    这段时间必须以它为准，否则 applyPlayback 会按本机读数把刚推进的 cursor 反推回去；
    // 2. 本机在放房间队列里的歌 → 用它：房主选/换队列里的歌，房间跟着走；
    // 3. 房间已有当前曲目（cursor>=0）→ 保持它：房主在放队列之外的私歌，房间原地保持；
    // 4. 房间还没开始 → 用本机正在放的歌，房间据此起播。
    const localInQueue = Boolean(local.trackKey) && state.queue.some(track => track.key === local.trackKey)
    const trackKey = this.hostExpectedTrackKey
      || (localInQueue ? local.trackKey : cursorTrackKey)
      || local.trackKey
      || null
    // 位置只在「本机正是在放要上报的这一首」时才有意义。
    // trackKey 为空（房间还没起播、本机也拿不到 key）时无从比对，直接沿用本机读数。
    const localMatchesRoom = !trackKey || local.trackKey === trackKey
    const previous = state.playback
    // 房间曲目没变、但本机已经不在放它了（房主切去听队列之外的私歌）：**什么都不推**，
    // 让房间保持上一次已知状态，成员各自按它外推。
    // 若硬推上一次的位置又带 playing=true，那条状态自相矛盾（位置冻结却在播），
    // 成员每次心跳都会算出漂移并硬 seek 回去；推 0 更会把人拉回开头。
    if (!localMatchesRoom && previous?.trackKey === trackKey) return
    const playback: ResonancePlayback = {
      trackKey,
      // 换歌时本机还没加载出新曲目，位置按 0 上报（新曲目从头开始）；
      // 只有「本机正是在放这一首」时位置才有意义。
      positionMs: localMatchesRoom ? Math.max(0, Math.round(local.positionMs || 0)) : 0,
      playing: Boolean(local.playing),
      atHostClock: Date.now(),
      term: state.term,
      seq: (previous?.seq || 0) + 1,
    }
    this.patchRoom(current => applyPlayback(current, playback, peerId).state)
    this.broadcast({ kind: 'playback', payload: playback })
  }

  // ── 成员操作 ───────────────────────────────────────────────────────────────
  /** 成员：请求加歌（Party / 我推荐由房主校验轮次与配额） */
  requestAddTracks(tracks: Array<Omit<ResonanceTrack, 'key' | 'seq' | 'requestedBy'>>, options: { position?: 'append' | 'next' } = {}): void {
    this.broadcast({ kind: 'queue-request', payload: { tracks, position: options.position || 'append' } })
  }

  /** 成员：拉取队列分页（房主本地切片；成员向房主请求） */
  loadQueuePage(offset: number, limit = RESONANCE_QUEUE_WINDOW): void {
    // 成员侧队列是「从房主当前曲目起的窗口 + 依次向后拉的分页」，
    // 窗口的全局起点是房主 cursor（可能不是 50 的整数倍），所以这里**不能**把偏移对齐到 50 的倍数，
    // 否则首屏偏移 40 的房间会被拉成偏移 0，把窗口内容整段覆盖掉。
    const start = Math.max(0, Math.floor(Number(offset) || 0))
    if (this.snapshot.role === 'host') {
      const room = this.snapshot.room
      if (!room) return
      this.queuePages.set(start, queuePageOf(room, start, limit))
      this.snapshot = { ...this.snapshot, ...this.viewOf(room) }
      this.notify()
      return
    }
    // 同一页在途时不重复请求；但超过 5s 没回包（出站限流丢包、房主卡顿）就允许重试，
    // 否则那一页会被永久卡住，队列停在「加载中…」占位行上再也拉不下来。
    const requestedAt = this.pendingQueueRequests.get(start)
    if (requestedAt !== undefined && Date.now() - requestedAt < QUEUE_PAGE_TIMEOUT_MS) return
    this.pendingQueueRequests.set(start, Date.now())
    this.broadcast({ kind: 'queue-page', payload: { offset: start, limit } })
  }

  /**
   * 成员：加载「已载入内容之后」的下一页。
   * UI 只关心「还有没有更多」，不该自己算全局偏移——窗口起点是房主 cursor，
   * 由会话层给出正确偏移（旧实现让 UI 传 `items.length`，窗口偏移非 0 时会错位）。
   * 若视图中间存在缺口（上一次请求丢包留下的占位行），优先补缺口，避免它永远空着。
   */
  loadMoreQueue(limit = RESONANCE_QUEUE_WINDOW): void {
    if (this.snapshot.role === 'host') return
    const view = this.memberQueueView(this.snapshot.room)
    if (view.items.length === 0) return
    const gapIndex = view.items.findIndex(isQueuePlaceholder)
    if (gapIndex >= 0) {
      this.loadQueuePage(view.offset + gapIndex, limit)
      return
    }
    if (view.offset + view.items.length >= this.queueMeta.total) return
    this.loadQueuePage(view.offset + view.items.length, limit)
  }

  /** 移除队列曲目（房主任意；成员仅自己点的） */
  removeFromQueue(trackKey: string): { ok: boolean; reason?: string } {
    const room = this.snapshot.room
    const peerId = this.identity?.peerId
    if (!room || !peerId) return { ok: false, reason: 'no-room' }
    if (this.snapshot.role === 'host') {
      const result = removeTrack(room, peerId, trackKey)
      if (!result.ok) return { ok: false, reason: result.reason }
      this.commit(result.state)
      if (result.wasCurrent) this.hostNext()
      return { ok: true }
    }
    this.broadcast({ kind: 'queue-remove', payload: { trackKey } })
    return { ok: true }
  }

  /** 置顶（下一首播放） */
  moveToNext(trackKey: string): { ok: boolean } {
    const room = this.snapshot.room
    const peerId = this.identity?.peerId
    if (!room || !peerId) return { ok: false }
    if (this.snapshot.role === 'host') {
      const result = moveTrackNext(room, peerId, trackKey)
      if (result.ok) this.commit(result.state)
      return { ok: result.ok }
    }
    this.broadcast({ kind: 'queue-move', payload: { trackKey } })
    return { ok: true }
  }

  // ── 控制权 ────────────────────────────────────────────────────────────────
  /** 房主：开关「允许所有成员控制播放」 */
  setMemberControlEnabled(enabled: boolean): void {
    const room = this.snapshot.room
    const peerId = this.identity?.peerId
    if (!room || !peerId || room.hostId !== peerId) return
    const next = setMemberControl(room, peerId, enabled)
    if (next) this.commit(next)
  }

  /** 房主：临时授权某成员控制播放（默认 5 分钟） */
  grantControl(targetPeerId: string, durationMs?: number): void {
    const room = this.snapshot.room
    const peerId = this.identity?.peerId
    if (!room || !peerId) return
    const next = grantControl(room, peerId, targetPeerId, Date.now(), durationMs)
    if (next) {
      this.commit(next)
      // 授权即视为处理了这条申请，从待办里划掉
      this.dismissControlRequest(targetPeerId)
    }
  }

  /** 房主：收回控制权 */
  revokeControl(): void {
    const room = this.snapshot.room
    const peerId = this.identity?.peerId
    if (!room || !peerId) return
    const next = revokeControl(room, peerId)
    if (next) this.commit(next)
  }

  /** 房主：忽略某人的控制申请（不清除房间控制权，只从待办列表里划掉） */
  dismissControlRequest(peerId: string): void {
    if (this.snapshot.role !== 'host') return
    if (!this.snapshot.controlRequests.includes(peerId)) return
    this.update({ controlRequests: this.snapshot.controlRequests.filter(id => id !== peerId) })
  }

  /** 成员：申请控制播放（房主会收到一条申请） */
  requestControl(): void {
    if (this.snapshot.role !== 'member') return
    // 防重复申请：已经申请过、或已经有控制权就不再发
    if (this.snapshot.canControl) return
    if (this.controlRequestedAt && Date.now() - this.controlRequestedAt < CONTROL_REQUEST_COOLDOWN_MS) return
    this.controlRequestedAt = Date.now()
    this.broadcast({ kind: 'control-request', payload: {} })
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: '已向房主申请控制播放', type: 'info' } }))
    }
  }

  /** 本机解析不了某首歌：记录并在房间里声明（房主界面据此提示，成员据此显示静音跟随） */
  notifyUnplayable(trackKey: string, reason: string, text: string): void {
    this.update({ unplayable: { ...this.snapshot.unplayable, [trackKey]: text } })
    if (this.snapshot.role === 'member') {
      this.broadcast({ kind: 'cannot-play', payload: { trackKey, tier: 'unknown', reason } })
    }
  }

  /**
   * 任一成员：投票跳过当前曲目。
   * 房主自己投票必须**在本地状态上生效**再广播状态：中转只把消息发给成员，
   * 房主不会收到自己的回环，否则房主的票会被丢弃（实测投票计数少自己一票）。
   */
  voteSkip(target: string | null = null): void {
    const state = this.snapshot.room
    const peerId = this.identity?.peerId
    if (state && peerId && state.hostId === peerId) {
      const result = castSkipVote(state, peerId, target)
      if (!result.ok) return
      this.commit(result.state)
      if (result.passed) this.hostNext()
      return
    }
    this.broadcast({ kind: 'vote', payload: { target } })
  }

  /** 聊天：房间内可见，端到端加密 */
  sendChat(text: string): void {
    const content = String(text || '').trim().slice(0, 500)
    if (!content || !this.identity) return
    this.pushChat({ peerId: this.identity.peerId, nickname: this.identity.nickname, text: content, at: Date.now(), self: true })
    this.broadcast({ kind: 'chat', payload: { text: content } })
  }

  // ── 内部 ──────────────────────────────────────────────────────────────────
  private update(partial: Partial<ResonanceSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...partial }
    this.notify()
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* 忽略单个订阅者异常 */ }
    }
  }

  private patchRoom(reducer: (state: ResonanceRoomState) => ResonanceRoomState): void {
    const room = this.snapshot.room
    if (!room) return
    const next = reducer(room)
    this.snapshot = { ...this.snapshot, ...this.viewOf(next) }
    this.notify()
  }

  /** 由房间状态派生出 UI 需要的轻量视图（摘要 / 队列窗口 / 我能否控制） */
  private viewOf(room: ResonanceRoomState) {
    const peerId = this.identity?.peerId || ''
    const isHost = this.snapshot.role === 'host'
    // 房主：本地有完整队列，直接算；成员：只有窗口，用房主下发的权威额度/轮次
    const remainingQuotaByPeer = isHost
      ? Object.fromEntries(room.members.map(member => {
        const value = remainingAddQuota(room, member.peerId)
        return [member.peerId, Number.isFinite(value) ? value : -1]
      }))
      : this.snapshot.remainingQuotaByPeer
    const turnPeerId = isHost ? currentTurnPeerId(room) : this.snapshot.turnPeerId
    return {
      room,
      summary: roomSummary(room, Date.now()),
      myTurn: room.mode === 'round-robin' && Boolean(peerId) && turnPeerId === peerId,
      queue: isHost
        ? { items: room.queue, offset: 0, total: room.queue.length }
        : this.memberQueueView(room),
      canControl: canControlPlayback(room, peerId, Date.now()),
      remainingQuotaByPeer,
      turnPeerId,
      suspended: Boolean(room.suspended),
    }
  }

  /**
   * 成员侧队列视图：窗口 + 已拉取分页，按**全局偏移**拼起来。
   * 传入 room 而不是读 this.snapshot.room：调用点（state 分支）已经拿到新状态，
   * 读快照会慢一帧，导致窗口起点/行号/「已载入」在每次切歌时闪一下错位。
   */
  private memberQueueView(room: ResonanceRoomState | null): { items: ResonanceTrack[]; offset: number; total: number } {
    const windowOffset = this.queueMeta.offset
    const windowItems = room?.queue || []
    const items: ResonanceTrack[] = []
    // 窗口不一定从 0 开始（房主可能已经播到第 N 首），窗口内容按下标对应全局位置写入
    const writeAt = (globalOffset: number, page: ResonanceTrack[]) => {
      // 低于当前窗口的分页已经被窗口取代（或队列被增删过），直接丢弃，不写负下标
      if (globalOffset < windowOffset) return
      for (let index = 0; index < page.length; index += 1) {
        items[globalOffset - windowOffset + index] = page[index]
      }
    }
    writeAt(windowOffset, windowItems)
    for (const offset of [...this.queuePages.keys()].sort((a, b) => a - b)) {
      writeAt(offset, this.queuePages.get(offset) || [])
    }
    // 缺口（undefined）用占位行占住下标，避免后面的曲目整体前移、与真实位置错位
    for (let index = 0; index < items.length; index += 1) {
      if (!items[index]) items[index] = queuePlaceholderAt(windowOffset + index)
    }
    return { items, offset: windowOffset, total: this.queueMeta.total }
  }

  /**
   * 房主队列被增删后，成员按绝对偏移缓存的分页会整体错位（甚至出现房里已不存在的幽灵行），
   * 必须作废重拉。判据：总数变了，或窗口在绝对坐标上的重叠部分对不上。
   * 只移动 cursor（切歌）不改变绝对位置，因此不会误清缓存。
   */
  private revalidateQueuePages(offset: number, items: ResonanceTrack[], total: number): void {
    const sameTotal = total === this.queueWindowTotal
    let shifted = false
    if (sameTotal && this.queueWindowKeys.length > 0 && items.length > 0) {
      const start = Math.max(offset, this.queueWindowOffset)
      const end = Math.min(offset + items.length, this.queueWindowOffset + this.queueWindowKeys.length)
      for (let absolute = start; absolute < end; absolute += 1) {
        if (this.queueWindowKeys[absolute - this.queueWindowOffset] !== items[absolute - offset]?.key) {
          shifted = true
          break
        }
      }
    }
    if (!sameTotal || shifted) {
      this.queuePages.clear()
      this.pendingQueueRequests.clear()
    }
    this.queueWindowTotal = total
    this.queueWindowOffset = offset
    this.queueWindowKeys = items.map(item => item.key)
  }

  /** 房主：提交新状态并广播 */
  private commit(state: ResonanceRoomState): void {
    this.snapshot = { ...this.snapshot, ...this.viewOf(state) }
    this.notify()
    this.broadcastState()
    this.adapter?.setQueue(state.queue, Math.max(0, state.cursor))
  }

  /**
   * 按 peerId 查房间名册里的昵称（权威值）。
   * 用于任何「显示某成员说了什么/做了什么」的地方——发送方自报的昵称可以被伪造成别人。
   */
  private memberNicknameOf(peerId: string): string {
    const member = this.snapshot.room?.members.find(item => item.peerId === peerId)
    return member?.nickname || ''
  }

  private broadcastState(): void {
    const room = this.snapshot.room
    if (!room || this.snapshot.role !== 'host') return
    // 只发窗口：入房首包大小与歌单长度无关，完整队列走 queue-page 分页
    this.broadcast({ kind: 'state', payload: serializeRoomState(room) })
  }

  private broadcast(
    message: { kind: EnvelopeKind; payload: unknown },
    options: { to?: string; keepNickname?: boolean } = {},
  ): void {
    const transport = this.transport
    if (!transport || !this.roomKey || !this.identity) return
    // 出站限流兜底：任何逻辑环都不该把房间打成洪水
    const now = Date.now()
    this.outboundWindow = this.outboundWindow.filter(at => now - at < 1000)
    if (this.outboundWindow.length >= 30) return
    this.outboundWindow.push(now)
    const payload = { ...(message.payload as object) }
    // 转发别人的消息时要保留原作者昵称，不能覆盖成自己的（否则成员会看到自己的话变成房主说的）
    if (!options.keepNickname) (payload as Record<string, unknown>).nickname = this.identity.nickname
    const envelope = sealMessage(this.roomKey, {
      roomId: this.roomId,
      from: this.identity.peerId,
      kind: message.kind,
      seq: ++this.sendSeq,
      payload,
    })
    transport.send(envelope, options.to)
  }

  private handleEnvelope(envelope: ResonanceEnvelope, fromPeerId: string): void {
    if (!this.roomKey) return
    const opened = openMessage(this.roomKey, envelope, this.roomId)
    if (!opened.ok) return
    if (!this.replay.accept(envelope.from, envelope.seq)) return
    this.route(opened.envelope.kind, opened.payload, fromPeerId)
  }

  private sendIdentity(): void {
    if (!this.identity) return
    this.broadcast({ kind: 'hello', payload: { identity: this.identity } })
  }

  private route(kind: string, payload: any, fromPeerId: string): void {
    const room = this.snapshot.room
    const isHost = this.snapshot.role === 'host'
    switch (kind) {
      case 'hello': {
        const identity = payload?.identity as ResonanceIdentity | undefined
        if (!identity || !isHost) return
        // 身份 id 一律以中转分配的 fromPeerId 为准，不采信 payload 里自报的 peerId。
        // 否则任何成员都能：① 冒用他人 id 覆盖别人的昵称/头像（显示层冒充）；
        // ② 用大量随机 id 连发 hello，一帧占满全部席位且永不释放（markOffline 只置
        //    online=false，leaveRoom 只在 socket 关闭时跑），把所有人挡在门外；
        // ③ 顺带把未截断的昵称灌进名册并被反复广播（joinRoom 不做长度限制）。
        const peerId = fromPeerId || identity.peerId
        if (!peerId) return
        const safeIdentity: ResonanceIdentity = {
          ...identity,
          peerId,
          nickname: String(identity.nickname || '').slice(0, 16),
          avatarUrl: typeof identity.avatarUrl === 'string' ? identity.avatarUrl.slice(0, 2048) : '',
          nicknameFrom: typeof identity.nicknameFrom === 'string' ? identity.nicknameFrom.slice(0, 32) : '',
          platforms: Array.isArray(identity.platforms) ? identity.platforms.slice(0, 12) : [],
        }
        // 房主：把成员加入房间并回发完整状态与房间密钥（welcome）
        this.patchRoom(state => {
          const joined = joinRoom(state, { ...safeIdentity, joinedAt: Date.now() }, Date.now())
          if (!joined.ok) return state
          if (joined.state !== state) return joined.state
          // 已在房间里：同 peerId 再次 hello = 改昵称/头像，更新名册（席位不变）
          return updateMemberProfile(state, safeIdentity) || state
        })
        if (this.snapshot.room) {
          this.broadcastState()
          this.pushPlayback(true)
        }
        return
      }
      case 'state':
      case 'playback': {
        // 房主也会收到「获授权控制者」下发的播放状态：那就是新的权威，
        // 房主必须①更新房间状态 ②让自己本机跟上 ③转发给其他成员。
        // 其余来自成员的状态消息一律丢弃（房间权威只有房主一个）。
        if (isHost && kind === 'playback') {
          const room = this.snapshot.room
          if (!room || !canControlPlayback(room, fromPeerId, Date.now())) return
          const incoming = payload as ResonancePlayback
          // 时间戳用**房主自己的时钟**重新盖章：控制者的 atHostClock 是他本机的时间，
          // 直接转发会让成员按错误的基准外推进度（房主时钟才是全房间的基准）。
          const restamped: ResonancePlayback = { ...incoming, atHostClock: Date.now() }
          const appliedByHost = applyPlayback(room, restamped, fromPeerId)
          if (!appliedByHost.ok) return
          this.patchRoom(() => appliedByHost.state)
          // 房主本机跟着控制者：否则房主自己会停在旧曲目，下一次 pushPlayback 又把 cursor 拽回去
          const position = this.projectPosition(restamped)
          this.adapter?.apply(
            { trackKey: restamped.trackKey || '', positionMs: position, playing: restamped.playing },
            appliedByHost.hard,
          )
          // 转发给全体成员（含发送者自己，让他的界面与权威状态对齐）
          this.broadcast({ kind: 'playback', payload: restamped })
          return
        }
        if (isHost) return
        if (kind === 'state') {
          const wire = payload as ResonanceStateWire
          if (!wire || wire.roomId !== this.roomId) return
          const next = deserializeRoomState(wire)
          // 先按新窗口校正分页缓存（房主增删过队列就作废重拉），再更新 queueMeta 供视图拼装
          this.revalidateQueuePages(wire.queueOffset, next.queue, wire.queueTotal)
          this.queueMeta = { total: wire.queueTotal, offset: wire.queueOffset }
          // 成员侧只有窗口，额度/轮次必须用房主下发的权威值（见 ResonanceStateWire 注释）
          this.snapshot = {
            ...this.snapshot,
            remainingQuotaByPeer: wire.remainingQuotaByPeer || {},
            turnPeerId: wire.turnPeerId ?? null,
          }
          const previous = this.snapshot.room
          const previousTrack = previous?.playback?.trackKey ?? null
          const nextTrack = next.playback?.trackKey ?? null
          this.snapshot = { ...this.snapshot, ...this.viewOf(next) }
          this.notify()
          if (!previous || previous.queue.length !== next.queue.length) {
            this.adapter?.setQueue(next.queue, Math.max(0, next.cursor))
          }
          if (previousTrack !== nextTrack) this.maybeCheckCurrentTrack(nextTrack)
          return
        }
        const playback = payload as ResonancePlayback
        const local = this.snapshot.room
        if (!local) return
        // 权威是房主；被授权/放开成员控制时，控制者也可以下发
        const applied = applyPlayback(local, playback, fromPeerId)
        if (!applied.ok) return
        this.patchRoom(() => applied.state)
        // 「入房行为 = 等下一首」：只有「房主已经放到这首的中间」才跳过——
        // 那才是会打断成员正在听的东西的情形。位置门槛与播放态无关：
        // 房主暂停在中间同样是「同一首的中间」，成员跟过去也只会听到一段静音。
        // 房主还没起播（位置≈0）则照常跟随，不算打断。
        if (this.pendingJoinSkip) {
          this.pendingJoinSkip = false
          const midSong = Boolean(playback.trackKey) && playback.positionMs > JOIN_SKIP_MIN_POSITION_MS
          if (midSong) {
            this.skipFirstApplyTrackKey = playback.trackKey
            return
          }
        }
        if (this.skipFirstApplyTrackKey && playback.trackKey === this.skipFirstApplyTrackKey) return
        this.skipFirstApplyTrackKey = null
        const position = this.projectPosition(playback)
        this.adapter?.apply({ trackKey: playback.trackKey || '', positionMs: position, playing: playback.playing }, applied.hard)
        // 房主换了曲目 → 本机判断能否播放（能播就正常跟，不能播就静音跟随并上报一次）
        this.maybeCheckCurrentTrack(playback.trackKey)
        return
      }
      case 'queue-request': {
        if (!isHost) return
        const tracks = Array.isArray(payload?.tracks) ? payload.tracks : []
        const peerId = this.identity?.peerId
        if (!peerId) return
        // position: 'next' = 右键「推送至共振」：能加就设成下一曲，不能加就进预排队
        if (payload?.position === 'next') {
          const result = this.pushIntoRoom(fromPeerId, tracks, Date.now())
          if (result.ok && result.mode === 'next') this.pushPlayback(true)
          this.flushPending()
          return
        }
        const result = addTracks(this.snapshot.room!, fromPeerId, tracks, Date.now())
        if (result.ok) this.commit(result.state)
        return
      }
      case 'chat': {
        const text = String(payload?.text || '').slice(0, 500)
        if (!text) return
        // 昵称一律取房间名册里的**权威值**（按中转分配的 fromPeerId 查，那个 id 无法伪造）。
        // 不能采信 payload.nickname：它是发送方自报的，任何人都能冒用他人（含房主）的名义发言，
        // 而房主转发时又保留这个昵称，伪造内容会扩散给全房间。
        const nickname = this.memberNicknameOf(fromPeerId) || String(payload?.nickname || '听众')
        this.pushChat({ peerId: fromPeerId, nickname, text, at: Date.now(), self: false })
        // 房主把消息转给「除发送者外」的成员，并保留原作者昵称（成员不会看到自己的话被回声，
        // 也不会看到自己的话变成房主说的）
        if (isHost) {
          this.broadcast({ kind: 'chat', payload: { text, nickname } }, { keepNickname: true, to: 'others:' + fromPeerId })
        }
        return
      }
      case 'vote': {
        const target = payload?.target ?? null
        if (isHost) {
          const state = this.snapshot.room
          if (!state) return
          const result = castSkipVote(state, fromPeerId, target)
          if (!result.ok) return
          this.commit(result.state)
          if (result.passed) this.hostNext()
        }
        return
      }
      case 'queue-page': {
        const offset = Math.max(0, Number(payload?.offset) || 0)
        const limit = Math.max(1, Math.min(50, Number(payload?.limit) || 50))
        if (isHost) {
          const room = this.snapshot.room
          if (!room) return
          // 只回给请求者，避免把大队列广播给所有人
          this.broadcast({ kind: 'queue-page', payload: { offset, items: queuePageOf(room, offset, limit) } }, { to: fromPeerId })
          return
        }
        const items = Array.isArray(payload?.items) ? payload.items : []
        this.pendingQueueRequests.delete(offset)
        this.queuePages.set(offset, items)
        if (this.snapshot.room) {
          this.snapshot = { ...this.snapshot, ...this.viewOf(this.snapshot.room) }
          this.notify()
        }
        return
      }
      case 'queue-remove': {
        if (!isHost) return
        const room = this.snapshot.room
        if (!room) return
        const result = removeTrack(room, fromPeerId, String(payload?.trackKey || ''))
        if (!result.ok) return
        this.commit(result.state)
        if (result.wasCurrent) this.hostNext()
        return
      }
      case 'queue-move': {
        if (!isHost) return
        const room = this.snapshot.room
        if (!room) return
        const result = moveTrackNext(room, fromPeerId, String(payload?.trackKey || ''))
        if (result.ok) this.commit(result.state)
        return
      }
      case 'next-request': {
        if (!isHost) return
        const room = this.snapshot.room
        // 只接受有控制权的成员（获授权 / 房主放开了成员控制）——canControlPlayback 就是这条判据
        if (!room || !canControlPlayback(room, fromPeerId, Date.now())) return
        const advanced = advanceQueue(room)
        this.commit(advanced)
        this.pushPlayback(true)
        this.flushPending()
        return
      }
      case 'control-request': {
        if (!isHost) return
        const member = this.snapshot.room?.members.find(item => item.peerId === fromPeerId)
        // 房主收到申请：交给 UI 提示，一键允许
        this.update({ controlRequests: [...this.snapshot.controlRequests.filter(id => id !== fromPeerId), fromPeerId] })
        void member
        return
      }
      case 'control-grant': {
        if (isHost) return
        const room = this.snapshot.room
        if (room) { this.snapshot = { ...this.snapshot, ...this.viewOf(room) }; this.notify() }
        return
      }
      case 'control-revoke': {
        if (isHost) return
        const room = this.snapshot.room
        if (room) { this.snapshot = { ...this.snapshot, ...this.viewOf(room) }; this.notify() }
        return
      }
      case 'cannot-play': {
        if (!isHost) return
        const trackKey = String(payload?.trackKey || '')
        if (!trackKey) return
        const member = this.snapshot.room?.members.find(item => item.peerId === fromPeerId)
        // 同一成员对同一首只记一次；且这里**不**立刻再广播状态（否则会与成员的检查形成回声风暴）
        if (member?.unableToPlay === trackKey) return
        this.patchRoom(state => reportCannotPlay(state, fromPeerId, trackKey, payload?.tier || 'unknown'))
        this.update({ unplayable: { ...this.snapshot.unplayable, [trackKey]: String(payload?.reason || '无法播放') } })
        return
      }
      case 'leave': {
        if (!isHost) return
        const outcome = leaveRoom(this.snapshot.room!, fromPeerId)
        if (outcome.kind === 'closed') {
          this.commit(outcome.state)
          this.broadcast({ kind: 'dissolve', payload: { reason: outcome.reason } })
          return
        }
        this.commit(outcome.state)
        if (outcome.kind === 'host-changed') {
          // 房主交接：新任期号已递增，随状态广播下发
          this.broadcastState()
          this.pushPlayback(true)
        }
        return
      }
      case 'dissolve': {
        if (!isHost) {
          // 房主解散：清空房间状态并回到大厅
          this.snapshot = { ...this.snapshot, status: 'closed', live: false, room: null, summary: null, myTurn: false, error: '房主已解散房间' }
          this.notify()
        }
        return
      }
      case 'ping': {
        if (!isHost) return
        // 收到心跳即刷新该成员在线状态，否则房主界面会把还在听的成员显示成离线
        this.patchRoom(current => heartbeat(current, fromPeerId, Date.now()).state)
        this.broadcast({ kind: 'pong', payload: { clientAt: payload?.clientAt, hostAt: Date.now() } }, { to: fromPeerId })
        return
      }
      case 'pong': {
        const clientAt = Number(payload?.clientAt || 0)
        if (!clientAt) return
        const at = nowMs()
        const rttMs = at - clientAt
        const hostAt = Number(payload?.hostAt || Date.now())
        const offsetMs = hostAt - Date.now() + rttMs / 2
        this.update({ clock: { offsetMs, rttMs } })
        return
      }
      default:
    }
  }

  /**
   * 把房主上报的进度换算成本机此刻应播到的位置。
   *
   * `atHostClock` 是房主的 `Date.now()`，本机时钟未必与房主一致（两台机器的墙钟差可能达数百毫秒到数秒），
   * 因此要用 ping/pong 估出的 `offsetMs`（= 房主时钟 − 本机时钟）把它先换算到本机时间轴：
   *   elapsed = 本机现在 − (房主上报时刻 + (本机时钟 − 房主时钟)) = Date.now() − atHostClock + offsetMs
   * 早期这里写成了 `offsetMs * 0`（等于没有校准），墙钟差超过 0.6s 时会持续触发纠偏 seek。
   */
  projectPosition(playback: ResonancePlayback): number {
    if (!playback.playing) return playback.positionMs
    const elapsed = Date.now() - playback.atHostClock + this.snapshot.clock.offsetMs
    return Math.max(0, playback.positionMs + Math.max(0, elapsed))
  }

  private pushChat(message: Omit<ResonanceChatMessage, 'id'>): void {
    const chat = [...this.snapshot.chat, { ...message, id: `${message.peerId}-${message.at}-${this.snapshot.chat.length}` }]
    this.update({ chat: chat.slice(-CHAT_LIMIT) })
  }

  private async refreshFingerprint(): Promise<void> {
    if (!this.roomKey) return
    this.update({ fingerprint: await roomFingerprint(this.roomKey) })
  }

  /**
   * 成员：检查若干曲目在本机能否播放，播不了就上报（不绕过会员限制）。
   * 关键约束：同一首只上报一次；只在上层指定的少量曲目（当前 + 下一首）上调用。
   * 早期实现每收到一次房间状态就检查整队列并上报，配合房主的「收到上报就再广播状态」，
   * 会形成消息风暴（实测几秒内上万条），这里用 reportedUnplayable 与调用点收窄双重兜底。
   */
  /**
   * 当前曲目变化时的可播性检查（成员侧唯一入口）：
   * 只检查当前曲目与下一首、同一首只查一次、播不了只上报一次。
   * 这样既不会漏报，也不会因为「状态→检查→上报→状态」形成风暴。
   */
  private maybeCheckCurrentTrack(trackKey: string | null | undefined): void {
    if (!trackKey || this.snapshot.role !== 'member') return
    if (this.checkedPlayable.has(trackKey)) return
    this.checkedPlayable.add(trackKey)
    const queue = this.snapshot.room?.queue || []
    const index = queue.findIndex(item => item.key === trackKey)
    const tracks = index >= 0 ? queue.slice(index, index + 2) : []
    if (tracks.length > 0) void this.checkPlayable(tracks)
  }

  private async checkPlayable(tracks: ResonanceTrack[]): Promise<void> {
    const adapter = this.adapter
    if (!adapter || this.snapshot.role !== 'member') return
    for (const track of tracks) {
      if (!track?.key || this.reportedUnplayable.has(track.key)) continue
      this.reportedUnplayable.add(track.key)
      let result: { playable: boolean; tier?: string; reason?: string }
      try {
        result = await adapter.canPlay(track)
      } catch {
        result = { playable: false, reason: '解析失败' }
      }
      if (!result.playable) {
        this.update({ unplayable: { ...this.snapshot.unplayable, [track.key]: result.reason || '无法播放' } })
        this.broadcast({ kind: 'cannot-play', payload: { trackKey: track.key, tier: result.tier || 'unknown', reason: result.reason || '无法播放' } })
      }
    }
  }
  private startTimers(): void {
    this.stopTimers()
    if (typeof window === 'undefined') return
    this.timers.push(window.setInterval(() => {
      const state = this.snapshot.room
      if (!state) return
      if (this.snapshot.role === 'host') {
        const peerId = this.identity?.peerId
        if (peerId) this.patchRoom(current => heartbeat(current, peerId, Date.now()).state)
        this.patchRoom(current => markOffline(current, Date.now(), OFFLINE_AFTER_MS))
        // 有人掉线/轮次推进后，原本够格的预排可能已经能进队列了
        this.flushPending()
        // 挂起时不再广播播放进度：房间还在，但不由本机驱动播放
        if (!this.suspended) this.pushPlayback()
        this.broadcastState()
        return
      }
      const peerId = this.identity?.peerId
      if (peerId) this.broadcast({ kind: 'ping', payload: { clientAt: nowMs() } })
    }, HEARTBEAT_MS))
    this.timers.push(window.setInterval(() => {
      if (this.snapshot.role === 'member') this.broadcast({ kind: 'ping', payload: { clientAt: nowMs() } })
    }, CLOCK_PING_MS))
  }

  private stopTimers(): void {
    for (const timer of this.timers) window.clearInterval(timer)
    this.timers = []
  }
}

let singleton: ResonanceSession | null = null
/** 单例被创建/销毁时的通知（供 App 重新订阅：插件禁用会销毁单例，旧订阅会永久失效） */
const sessionLifecycleListeners = new Set<() => void>()

function notifySessionLifecycle(): void {
  for (const listener of [...sessionLifecycleListeners]) {
    try { listener() } catch { /* 单个订阅者异常不影响其它 */ }
  }
}

/** 订阅「会话单例被替换/销毁」：App 的播放列表还原订阅要跟着重新挂到新实例上 */
export function subscribeResonanceSessionLifecycle(listener: () => void): () => void {
  sessionLifecycleListeners.add(listener)
  return () => { sessionLifecycleListeners.delete(listener) }
}

/** 调试用：在控制台/自动化里查看房间状态与握手细节（只读） */
function exposeDebugHandle(session: ResonanceSession): void {
  if (typeof window === 'undefined') return
  ;(window as unknown as Record<string, unknown>).__waveforgeResonance = session
}

/** 全局单例：房间状态在模式切换/重渲染之间保持 */
export function getResonanceSession(options: SessionOptions = {}): ResonanceSession {
  if (!singleton) {
    const bridge = options.bridge || (typeof window !== 'undefined' ? window.electron?.resonance : undefined)
    singleton = new ResonanceSession({ bridge })
    exposeDebugHandle(singleton)
    notifySessionLifecycle()
  }
  exposeDebugHandle(singleton)
  return singleton
}

export function clearResonanceSession(): void {
  singleton?.reset()
  singleton = null
  notifySessionLifecycle()
}

export { canonicalTrackKey, clampQuota, clearVote, RESONANCE_MAX_MEMBERS }
