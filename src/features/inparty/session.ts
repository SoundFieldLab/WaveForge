/**
 * In Party 会话层：把「房间模型 + 端到端加密 + 传输」串成可供 UI 订阅的单例。
 *
 * 与共振 session 的关键差异：
 *  - 没有中央权威：房主只管名册与总闸；互控指令、聊天、通话信令都是点到点消息，
 *    成员 → 房主（中转）→ 目标成员（星型转发，密文）。
 *  - 中转复用共振 hub（party 模式：50 人、6 位密码、256KB 帧上限），
 *    但事件流独立（复用 resonance IPC 通道，事件里带 kind 区分）。
 *  - 互控闭环：远端「ctrl-op」→ 本机校验（房间规则+策略+授权表）→ dglab 中继注入设备。
 */
import {
  INPARTY_AUDIO_MAX_SEC,
  INPARTY_CHAT_KEEP,
  INPARTY_CHAT_LIMIT,
  INPARTY_IMAGE_LIMIT,
  QUICK_STRENGTH_PRESETS,
  ROULETTE_SLOTS,
  canControl,
  createRoomState,
  findMember,
  joinMember,
  markOffline,
  removeMember,
  roomSummary,
  updateMember,
  type CameraAutoStop,
  type CameraBroadcaster,
  type ControlPolicy,
  type ControlLogEntry,
  type NowPlayingStatus,
  type PartyCallSignal,
  type PartyChatMessage,
  type PartyProfile,
  type PartyRemoteOp,
  type PartyRoomState,
  type QuickActionId,
  type QuickChannel,
  type RouletteGame,
  type RouletteSlotId,
  type WaveBind,
} from './model'
import { ReplayGuard, deriveRoomKey, generateRoomSecret, openMessage, roomFingerprint, sealMessage, type ResonanceEnvelope } from '../resonance/crypto'
import { buildInvite, createLanHostTransport, createLanMemberTransport, parseInvite, pickInviteHost, type ResonanceTransport } from '../resonance/transport'
import { getDGLabClient, type DGLabDeviceSummary } from '../../plugins/clients/DGLabClient'
import { applyRemoteStrengthGuard, clearAllGuards, peekDeviceGuard, peekDeviceSettingsFreq, readDeviceSettings } from './deviceSettings'
import {
  BEAT_PATTERNS, GAME_LABEL, assignTeams, rollDice, tallyVotes,
  TEAM_QUESTIONS, TEAM_MATCH_LOSE_TARGET, UNDERCOVER_MIN_PLAYERS, dealUndercover,
  pickRandomPlayer, pickTruthDare, punishOp, scoreBeatEcho,
  type GameHubState, type GameKind,
} from './games'
import { appendFriendMessage, appendRoomHistory, markFriendMessagesDelivered, readFriends, readRoomHistory, touchFriendPresence, type StoredChatMessage } from './settings'
import { bumpCounter, isAchievementUnlocked, unlockAchievement, notifyAchievement } from './achievements'

export type InPartyStatus = 'idle' | 'hosting' | 'joining' | 'connected' | 'closed' | 'error'

export interface InPartySessionSnapshot {
  status: InPartyStatus
  role: 'host' | 'member' | null
  error: string
  room: PartyRoomState | null
  /** 房间名（创建时房主填写；大厅/房间顶栏展示） */
  roomName: string
  invite: string
  fingerprint: string
  chat: PartyChatMessage[]
  summary: { memberCount: number; online: number } | null
  /** 我对每个成员的临时授权（ask 策略下点「允许」后 5 分钟内有效） */
  grantsByPeer: Record<string, number>
  /** 对方申请控制我的待处理列表 */
  controlRequests: string[]
  /** 我的设备摘要（广播给房间） */
  device: DGLabDeviceSummary | null
  /** 是否已加入且连接正常 */
  live: boolean
  /** 摄像头广播名册：谁在开播（含自己） */
  broadcasters: CameraBroadcaster[]
  /** 收到的通话信令（由 usePartyCall 消费；含摄像头发布/订阅 offer） */
  callSignals: Array<{ from: string; signal: PartyCallSignal; at: number }>
  /** 进行中/最近的轮盘（房间内共享；同一时刻一个） */
  roulette: RouletteGame | null
  /** 我的互控日志（别人对我的操作 + 我的操作回执），新在前 */
  controlLog: ControlLogEntry[]
  /** 收到的好友申请（待处理） */
  friendRequests: Array<{ from: string; profile: PartyProfile; at: number }>
  /** 每个私聊会话的未读数（peerId → 未读条数） */
  unreadByPeer: Record<string, number>
  /** 正在输入的成员（peerId → 目标：'room' | 私聊对我的 peerId） */
  typingPeers: Record<string, 'room' | 'private'>
  /** 消息回应（messageId → emoji → peerId[]） */
  reactions: Record<string, Record<string, string[]>>
  /** 被禁言的成员（peerId → 到期时间戳；房主/管理员设置） */
  mutedUntil: Record<string, number>
  /** 管理员名单（房主任命；可踢人/禁言/改公告） */
  admins: string[]
  /** 成员的「想听」点歌请求（房主侧待处理列表） */
  songRequests: Array<{ from: string; title: string; at: number }>
  /** 派对玩法中心（同一时刻一个玩法） */
  game: GameHubState | null
  /**
   * 本房派对小结（进房起算，本机视角；离房清零）：
   * startedAt=进房时刻 / controlOps=我发出的互控指令数 / punishSent=我送出的玩法惩罚帧组 /
   * shocked=我被远端出电的次数 / games=我参与的玩法场次（发起了就 +1）。
   * 侧栏「派对小结」卡片用；计数只在发成功路径上累加。
   */
  partyStats: { startedAt: number; controlOps: number; punishSent: number; shocked: number; games: number }
  /** 观战模式（只看不电：忽略一切远端强度/波形/惩罚指令） */
  spectating: boolean
  /** 语音房名册（peerId → 静音状态） */
  voiceUsers: Record<string, { nickname: string; muted: boolean }>
  /** 同步听：房主权威播放状态（成员据此对齐本机播放） */
  syncPlayback: { title: string; artists: string; positionMs: number; playing: boolean; atHostClock: number; term: number } | null
  /** 同步听：房主广播的节拍强度（成员「随主节奏」绑定用，0-1） */
  hostBeat: { overall: number; beat: number; at: number } | null
  /** 我是否开启了「跟随房主节奏」(把房主的节拍灌进我的设备) */
  followHostRhythm: boolean
  /** 节奏决斗（进行中的一局；答题最慢者被电） */
  duel: { id: string; by: string; question: { q: string; options: string[] }; answers: Record<string, { option: number; at: number }>; result: { loser: string; correctIndex: number } | null; startedAt: number; endsAt: number; round: number; bestOf: number; score: Record<string, number> } | null
  /** 决斗连胜纪录（peerId → 连胜数；赢=没吃电） */
  duelStreaks: Record<string, number>
}

type EnvelopeKind =
  | 'hello' | 'welcome' | 'state' | 'bye'
  | 'chat' | 'ctrl-op' | 'ctrl-request' | 'ctrl-grant' | 'ctrl-revoke'
  | 'pause-me' | 'device-update' | 'call-signal' | 'call-state'
  | 'cam-start' | 'cam-stop' | 'cam-blank'
  | 'wave-bind' | 'wave-data' | 'quick-action' | 'recall'
  | 'roulette-new' | 'roulette-accept' | 'roulette-decline' | 'roulette-result'
  | 'now-playing' | 'friend-request' | 'friend-accept'
  | 'typing' | 'react' | 'mute'
  | 'voice-start' | 'voice-stop' | 'voice-mute'
  | 'sync-play' | 'sync-request'
  | 'duel-new' | 'duel-answer' | 'duel-result'
  | 'promote' | 'demote'
  | 'song-request' | 'song-request-done'
  | 'game-new' | 'game-update' | 'game-submit' | 'game-end'
  | 'spectator'
  | 'punish-op'
  | 'kick' | 'dissolve' | 'ping' | 'pong'

const HEARTBEAT_MS = 3000
const OFFLINE_AFTER_MS = 15_000
const GRANT_TTL_MS = 5 * 60_000
const CHAT_THROTTLE_MS = 250

interface SessionOptions {
  bridge?: NonNullable<Window['electron']>['resonance']
}

export class InPartySession {
  private readonly options: SessionOptions
  private transport: ResonanceTransport | null = null
  private listeners = new Set<() => void>()

  private snapshot: InPartySessionSnapshot = {
    status: 'idle', role: null, error: '', room: null, roomName: '', invite: '', fingerprint: '', chat: [],
    summary: null, grantsByPeer: {}, controlRequests: [], device: null, live: false,
    broadcasters: [], callSignals: [], roulette: null, controlLog: [], friendRequests: [], unreadByPeer: {}, typingPeers: {}, reactions: {}, mutedUntil: {}, voiceUsers: {}, admins: [], songRequests: [], game: null,
    partyStats: { startedAt: Date.now(), controlOps: 0, punishSent: 0, shocked: 0, games: 0 },
    spectating: false,
    syncPlayback: null, hostBeat: null, followHostRhythm: false, duel: null, duelStreaks: {},
  }

  private roomKey = ''
  private roomId = ''
  private password = ''
  private profile: PartyProfile | null = null
  private policy: ControlPolicy = 'ask'
  private readonly replay = new ReplayGuard()
  private sendSeq = 0
  private lastChatAt = 0
  private outboundWindow: number[] = []
  private timers: number[] = []
  private lastHeartbeatAt = 0

  constructor(options: SessionOptions = {}) {
    this.options = options
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  getSnapshot = (): InPartySessionSnapshot => this.snapshot

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try { listener() } catch { /* 单订阅者异常不影响其它 */ }
    }
  }

  private update(patch: Partial<InPartySessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    this.notify()
  }

  /** 我的档案（创建/加入时确定；中途改名经 device-update 同步） */
  getProfile(): PartyProfile | null { return this.profile }

  /** 供 hooks（call.ts）调用的成就入口 */
  awardPublic = (id: string): void => { this.award(id) }

  setProfile(profile: PartyProfile, policy: ControlPolicy): void {
    this.profile = profile
    this.policy = policy
    if (this.snapshot.live) {
      this.send({ kind: 'device-update', payload: { profile, policy } })
      if (this.snapshot.role === 'host') this.patchRoom(state => updateMember(state, profile, policy).state)
    }
  }

  /* ── 传输复用：直接用共振 transport（成员侧连接参数多带 password） ── */

  /** 创建房间（房主）：party 模式中转 + 6 位房间码 + 可选密码 */
  async create(options: {
    profile: PartyProfile
    policy: ControlPolicy
    /** 房间名（公开房会出现在同网段的房间列表里） */
    name: string
    visibility: 'public' | 'private'
    password: string
    maxMembers: number
    port?: number
    discoverable?: boolean
  }): Promise<void> {
    await this.releaseRelay(true)
    this.reset()
    const roomId = globalThis.crypto.randomUUID().slice(0, 8)
    this.roomId = roomId
    this.password = options.password
    this.profile = options.profile
    this.policy = options.policy
    const secret = generateRoomSecret()
    this.roomKey = await deriveRoomKey(secret, roomId)
    this.update({ status: 'hosting', role: 'host', error: '' })

    // 端口顺延尝试（与共振同一策略，最多 10 个）
    const basePort = Number(options.port) || 25570
    let transport: ResonanceTransport | null = null
    let lastError: unknown = null
    for (let index = 0; index < 10; index += 1) {
      const attempt = createLanHostTransport({
        roomId,
        maxMembers: options.maxMembers,
        port: basePort + index,
        selfPeerId: options.profile.peerId,
        bridge: this.options.bridge,
        discoverable: options.discoverable !== false,
        // party 参数经 bridge.start 透传（主进程 hub 识别 party 配置）
        party: { visibility: options.visibility, password: options.password, name: options.name },
      } as Parameters<typeof createLanHostTransport>[0] & { party: { visibility: string; password: string } })
      try {
        await attempt.connect()
        transport = attempt
        if (index > 0) {
          window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `端口 ${basePort} 被占用，已改用 ${basePort + index} 建房`, type: 'info' } }))
        }
        break
      } catch (error) {
        lastError = error
        const message = error instanceof Error ? error.message : String(error)
        if (!/EADDRINUSE|address already in use/i.test(message)) break
      }
    }
    if (!transport) {
      const message = lastError instanceof Error ? lastError.message : '创建房间失败'
      const friendly = /EADDRINUSE/i.test(message)
        ? `端口 ${basePort}–${basePort + 9} 都被占用了，请在设置里换一个端口`
        : /需要桌面端|not support/i.test(message) ? '当前环境无法承载房间（需要桌面版）' : message
      this.update({ status: 'error', error: friendly })
      throw new Error(friendly)
    }
    this.transport = transport
    transport.onEnvelope((envelope, from) => this.handleEnvelope(envelope, from))
    transport.onPeerEvent(event => {
      if (event.type === 'peer-left') {
        this.patchRoom(state => removeMember(state, event.peerId))
        this.pushSystemMessage('有成员离开了房间')
      } else if (event.type === 'closed') {
        this.update({ status: 'closed', live: false, error: '房间已关闭' })
      }
    })
    const room = createRoomState({
      roomId,
      host: options.profile,
      hostPolicy: options.policy,
      maxMembers: options.maxMembers,
      visibility: options.visibility,
      now: Date.now(),
    })
    const info = (transport as unknown as { startResult: () => { port: number; code: string; running: boolean } | null }).startResult()
    const invite = info ? buildInvite({ roomId, code: info.code, secret, host: pickInviteHost((await this.options.bridge?.getStatus())?.ips), port: info.port }) : ''
    this.update({ status: 'connected', role: 'host', room, roomName: options.name, invite, live: true, summary: roomSummary(room), partyStats: { startedAt: Date.now(), controlOps: 0, punishSent: 0, shocked: 0, games: 0 } })
    this.award('first-room')
    void this.refreshFingerprint()
    this.startTimers()
    this.broadcast({ kind: 'state', payload: { room } })
    this.watchDevice()
  }

  /** 加入房间（成员）：邀请串 + 密码（私有房） */
  async join(options: { invite: string; password?: string; profile: PartyProfile; policy: ControlPolicy }): Promise<void> {
    // 先解析邀请串：hub 释放策略依赖它（见 releaseRelay 的 keepRoomId）
    const invite = parseInvite(options.invite)
    if (!invite) {
      this.update({ status: 'error', error: '邀请串无法识别' })
      throw new Error('邀请串无法识别')
    }
    // 与共振不同：In Party 允许同机双角色（房主会话与成员会话共用一个 hub/bridge），
    // 成员加入时 hub 正跑着「同一个房间」说明房主就在本机——绝不能把房间停掉。
    await this.releaseRelay(false, invite.roomId)
    this.reset()
    this.roomId = invite.roomId
    this.password = options.password || ''
    this.profile = options.profile
    this.policy = options.policy
    this.roomKey = await deriveRoomKey(invite.secret, invite.roomId)
    this.update({ status: 'joining', role: 'member', invite: options.invite, error: '' })
    const transport = createLanMemberTransport({
      host: invite.host,
      port: invite.port,
      roomId: invite.roomId,
      code: invite.code,
      // 密码经连接参数提交（中转常数时间比对）；公开房为空
      password: options.password || '',
    } as Parameters<typeof createLanMemberTransport>[0] & { password: string })
    transport.onEnvelope((envelope, from) => this.handleEnvelope(envelope, from))
    transport.onPeerEvent(event => {
      if (event.type === 'closed') {
        this.stopTimers()
        this.transport = null
        this.update({
          status: 'closed',
          live: false,
          room: null,
          summary: null,
          error: this.snapshot.error || '与房主的连接已断开',
        })
      }
    })
    try {
      await transport.connect()
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error)
      const friendly = /4001/.test(raw) ? '房间号或房间码不正确' : /4003/.test(raw) ? '房间已满' : /4005/.test(raw) ? '房间密码不正确' : raw
      this.update({ status: 'error', error: friendly })
      throw new Error(friendly)
    }
    this.transport = transport
    const assigned = transport.selfPeerId
    if (assigned && this.profile) this.profile = { ...this.profile, peerId: assigned }
    // 消息漫游：重进同一房间时恢复本机历史（标记为漫游条目，界面显示「历史消息」分隔线由 UI 层处理）
    if (this.roomId) {
      const history = readRoomHistory(this.roomId)
      if (history.length) {
        const restored = history.map(item => ({
          id: item.id,
          from: item.from,
          nickname: item.nickname,
          avatarEmoji: item.avatarEmoji,
          at: item.at,
          kind: item.kind,
          text: item.text,
        })) as PartyChatMessage[]
        this.update({ chat: restored })
      }
    }
    await this.refreshFingerprint()
    this.update({ status: 'connected', live: true, roomName: '', partyStats: { startedAt: Date.now(), controlOps: 0, punishSent: 0, shocked: 0, games: 0 } })
    this.award('first-join')
    this.send({ kind: 'hello', payload: { profile: this.profile, policy: this.policy } })
    this.startTimers()
    this.watchDevice()
  }

  /** 挂接本机设备摘要监听：设备状态变化 → 广播房间（我的用户卡实时更新） */
  private unwatchDevice: (() => void) | null = null
  private deviceThrottleAt = 0
  private deviceAwarded = false
  private watchDevice(): void {
    this.unwatchDevice?.()
    this.unwatchDevice = getDGLabClient().onDeviceSummary(summary => {
      this.update({ device: summary })
      if (!this.snapshot.live || !this.profile) return
      const now = Date.now()
      if (now - this.deviceThrottleAt < 2000) return // 2s 节流
      this.deviceThrottleAt = now
      if (summary?.connected && !this.deviceAwarded) {
        this.deviceAwarded = true
        this.award('first-device')
      }
      if (this.profile.device.connected !== summary?.connected || this.profile.device.version !== (summary?.version || '')) {
        this.profile = {
          ...this.profile,
          device: { connected: Boolean(summary?.connected), version: summary?.version || '', caps: summary?.caps ?? null },
        }
        this.send({ kind: 'device-update', payload: { profile: this.profile, policy: this.policy } })
        if (this.snapshot.role === 'host') this.patchRoom(state => updateMember(state, this.profile!, this.policy).state)
      }
    })
  }

  leave(): void {
    if (this.transport && this.roomKey) this.broadcast({ kind: 'bye', payload: { peerId: this.profile?.peerId || '' } })
    this.stopTimers()
    this.clearGameTimers()
    void this.transport?.close()
    this.transport = null
    this.unwatchDevice?.()
    this.unwatchDevice = null
    this.replay.reset()
    this.roomKey = ''
    // 会话态彻底清空（授权表/申请/玩法快照不跨房间残留）——复用 reset 的清理但不重置订阅者
    this.onceKeys.clear()
    this.gameAnswer = ''
    this.myUndercoverWord = ''
    this.usedDuelQuestions.clear()
    this.recentTruthDare = []
    this.waveBinds.clear()
    this.deviceAwarded = false
    this.update({
      status: 'closed', live: false, room: null, summary: null,
      grantsByPeer: {}, controlRequests: [], roulette: null, duel: null, duelStreaks: {}, game: null,
      partyStats: { startedAt: Date.now(), controlOps: 0, punishSent: 0, shocked: 0, games: 0 },
    spectating: false,
      songRequests: [], friendRequests: [], controlLog: [], unreadByPeer: {}, typingPeers: {},
      reactions: {}, mutedUntil: {}, voiceUsers: {}, admins: [],
      syncPlayback: null, hostBeat: null, followHostRhythm: false, device: null,
    })
  }

  dissolve(): void {
    if (this.snapshot.role === 'host' && this.snapshot.room) {
      this.patchRoom(state => ({ ...state, closed: { reason: 'dissolved' } }))
      this.broadcast({ kind: 'dissolve', payload: {} })
    }
    this.leave()
  }

  hostKick(peerId: string): void {
    if (this.snapshot.role !== 'host') return
    this.send({ kind: 'kick', payload: {}, to: peerId })
    this.patchRoom(state => removeMember(state, peerId))
    try { this.options.bridge?.kick(peerId) } catch { /* ignore */ }
    this.pushSystemMessage('房主移除了一名成员')
  }

  setInterControl(enabled: boolean): void {
    if (this.snapshot.role !== 'host') return
    this.patchRoom(state => ({ ...state, interControlAllowed: enabled }))
    this.broadcast({ kind: 'state', payload: { room: this.snapshot.room } })
  }

  setAnnouncement(text: string): void {
    if (this.snapshot.role !== 'host') return
    this.patchRoom(state => ({ ...state, announcement: String(text || '').slice(0, 120) }))
    this.broadcast({ kind: 'state', payload: { room: this.snapshot.room } })
  }

  /** 改我的控制策略（off/ask/open）：广播更新 */
  updatePolicy(policy: ControlPolicy): void {
    this.policy = policy
    if (!this.snapshot.live || !this.profile) return
    this.send({ kind: 'device-update', payload: { profile: this.profile, policy } })
    if (this.snapshot.role === 'host') {
      this.patchRoom(state => updateMember(state, this.profile!, policy).state)
      this.broadcast({ kind: 'state', payload: { room: this.snapshot.room } })
    }
  }

  /* ── 聊天：文本 / 图片 / 语音（E2E；私聊定向） ── */

  sendChat(message: { kind: 'text'; text: string; to?: string } | { kind: 'image'; dataUrl: string; to?: string } | { kind: 'audio'; dataUrl: string; durationSec: number; to?: string }): boolean {
    if (!this.snapshot.live || !this.profile) return false
    if (this.isMuted(this.profile.peerId)) {
      this.pushSystemMessage(`你被禁言中，还剩 ${Math.ceil(((this.snapshot.mutedUntil[this.profile.peerId] ?? 0) - Date.now()) / 60000)} 分钟`)
      return false
    }
    const now = Date.now()
    if (now - this.lastChatAt < CHAT_THROTTLE_MS) return false
    this.lastChatAt = now
    this.award('first-chat')
    this.awardCounter('chat', 'chat-100', 100)
    const envelope: PartyChatMessage = {
      id: globalThis.crypto.randomUUID(),
      from: this.profile.peerId,
      nickname: this.profile.nickname,
      avatarEmoji: this.profile.avatarEmoji,
      at: now,
      kind: message.kind,
      ...(message.kind === 'text' ? { text: String(message.text || '').slice(0, 500) } : {}),
      ...(message.kind === 'image' ? { dataUrl: message.dataUrl } : {}),
      ...(message.kind === 'audio' ? { dataUrl: message.dataUrl, durationSec: message.durationSec } : {}),
      ...(message.to ? { to: message.to } : {}),
    }
    this.send({ kind: 'chat', payload: envelope, to: message.to })
    this.appendChat({ ...envelope, self: true })
    return true
  }

  /** 一键叫停：clear 本机设备 + 房间声明 + **退出一切进行中的玩法**（惩罚资格随之取消） */
  pauseMe(): void {
    this.award('pause-me')
    getDGLabClient().sendRemoteOp({ kind: 'clear' })
    // 退出玩法：清空本地玩法快照并广播退出（发起人侧判罚时按「已离场」处理）
    if (this.snapshot.game || this.snapshot.roulette || this.snapshot.duel) {
      this.update({ game: null,
    partyStats: this.snapshot?.partyStats ?? { startedAt: Date.now(), controlOps: 0, punishSent: 0, shocked: 0, games: 0 }, spectating: false, roulette: null, duel: null })
      this.broadcast({ kind: 'game-end', payload: {} })
      this.pushSystemMessage('已叫停并退出当前玩法——惩罚资格已取消')
    }
    this.broadcast({ kind: 'pause-me', payload: { peerId: this.profile?.peerId || '' } })
    this.pushSystemMessage('已叫停：你的设备已归零，其他人的控制已暂停')
  }

  /* ── 互控 ── */

  /** 我能否控制对方（按对方广播的策略与房间总闸） */
  canControlTarget(peerId: string): boolean {
    const room = this.snapshot.room
    if (!room || !this.snapshot.live) return false
    const target = findMember(room, peerId)
    if (!target || !target.online) return false
    if (target.peerId === this.profile?.peerId) return false
    if (target.controlPolicy === 'open') return canControl(room, 'open')
    if (target.controlPolicy === 'ask') return (this.snapshot.grantsByPeer[peerId] || 0) > Date.now()
    return false
  }

  /** 发互控指令到目标成员（本地预检 + E2E 定向） */
  sendControlOp(peerId: string, op: PartyRemoteOp): boolean {
    if (!this.canControlTarget(peerId)) return false
    this.send({ kind: 'ctrl-op', payload: { op }, to: peerId })
    this.award('first-control')
    this.awardCounter('control-ops', 'control-50', 50)
    // 派对小结：发出一条互控指令 +1（clear 安全路径也计入「有来有回」）
    this.bumpPartyStats('controlOps')
    return true
  }

  /** 申请控制（对方策略=ask 时先申请；房主策略同样适用） */
  requestControl(peerId: string): void {
    this.send({ kind: 'ctrl-request', payload: {}, to: peerId })
  }

  /** 我同意/拒绝某人的控制申请（5 分钟授权） */
  respondControlRequest(peerId: string, allow: boolean): void {
    const next = { ...this.snapshot.grantsByPeer }
    if (allow) next[peerId] = Date.now() + GRANT_TTL_MS
    else delete next[peerId]
    this.update({ grantsByPeer: next, controlRequests: this.snapshot.controlRequests.filter(id => id !== peerId) })
    this.send({ kind: allow ? 'ctrl-grant' : 'ctrl-revoke', payload: {}, to: peerId })
  }

  /** 撤销某人的授权 */
  revokeGrant(peerId: string): void {
    const next = { ...this.snapshot.grantsByPeer }
    delete next[peerId]
    this.update({ grantsByPeer: next })
    this.send({ kind: 'ctrl-revoke', payload: {}, to: peerId })
  }

  /* ── 视频通话（WebRTC P2P；信令经房间 E2E） ── */

  sendCallSignal(peerId: string, signal: PartyCallSignal): void {
    this.send({ kind: 'call-signal', payload: signal as unknown as Record<string, unknown>, to: peerId })
  }

  /* ── 波形互控（把我的实时音乐波形持续灌给对方） ── */

  /** 我对外发出的波形绑定（最多同时 3 个目标，防带宽失控） */
  private waveBinds = new Map<string, WaveBind>() // key = `${to}:${channel}`
  private lastWaveDataAt = 0

  /** 我正在对外绑定的列表（UI 展示） */
  getWaveBinds(): WaveBind[] {
    return [...this.waveBinds.values()]
  }

  /**
   * 绑定我的波形到目标（需可控制对方）。绑定后 App 音频特征流每 100ms 采样一次
   * 推给对方（pushWaveData 由视图层驱动），对方经本机中继转成设备波形。
   */
  bindWave(to: string, channel: 'A' | 'B', gain = 1, includePulse = true): boolean {
    if (!this.canControlTarget(to)) return false
    if (this.waveBinds.size >= 6) return false
    const bind: WaveBind = { to, channel, gain, includePulse }
    this.waveBinds.set(`${to}:${channel}`, bind)
    this.award('wave-bind')
    this.send({ kind: 'wave-bind', payload: { bind, on: true }, to })
    this.pushControlLog('from-remote-notify', `开始向 ${this.nicknameOf(to)} 的 ${channel} 通道推送波形`, 'strength')
    return true
  }

  /** 调整已绑定通道的增益（0.2-2.0；即时生效并告知对方） */
  setWaveGain(to: string, channel: 'A' | 'B', gain: number): void {
    const key = `${to}:${channel}`
    const bind = this.waveBinds.get(key)
    if (!bind) return
    const next = { ...bind, gain: Math.max(0.2, Math.min(2, gain)) }
    this.waveBinds.set(key, next)
    this.send({ kind: 'wave-bind', payload: { bind: next, on: true }, to })
  }

  /** 解绑 */
  unbindWave(to: string, channel: 'A' | 'B'): void {
    const key = `${to}:${channel}`
    if (!this.waveBinds.has(key)) return
    this.waveBinds.delete(key)
    this.send({ kind: 'wave-bind', payload: { bind: { to, channel, gain: 1, includePulse: false }, on: false }, to })
    this.send({ kind: 'ctrl-op', payload: { op: { kind: 'strength', channel, value: 0 } }, to })
  }

  /** 视图层每帧调用：把音频特征变成对方的强度指令（30Hz→10Hz 采样，经限流） */
  pushWaveData(level: { overall: number; left: number; right: number }, beatPulse = false): void {
    if (!this.waveBinds.size) return
    const now = Date.now()
    if (now - this.lastWaveDataAt < 100) return // 10Hz 足够（设备侧每帧≈100ms）
    this.lastWaveDataAt = now
    for (const bind of this.waveBinds.values()) {
      const raw = bind.channel === 'A' ? level.left : level.right
      const value = Math.max(0, Math.min(200, Math.round(raw * 200 * bind.gain)))
      this.send({ kind: 'ctrl-op', payload: { op: { kind: 'strength', channel: bind.channel, value } }, to: bind.to })
      if (bind.includePulse && beatPulse) {
        this.send({ kind: 'ctrl-op', payload: { op: { kind: 'pulse', channel: bind.channel, frames: [{ freq: 60, strength: Math.min(200, value + 20) }] } }, to: bind.to })
      }
    }
  }

  /** 收到对方的绑定请求（把 ta 的波形灌给我）：记录（ UI 提示）；指令本身走 ctrl-op */
  private handleWaveBind(from: string, bind: WaveBind, on: boolean): void {
    if (on) this.pushControlLog(from, `${this.nicknameOf(from)} 开始把 ta 的波形灌进你的 ${bind.channel} 通道`, 'strength')
    else this.pushControlLog(from, `${this.nicknameOf(from)} 停止了波形推送`, 'clear')
  }

  private nicknameOf(peerId: string): string {
    return this.snapshot.room?.members.find(m => m.peerId === peerId)?.nickname || peerId.slice(0, 6)
  }

  /* ── 快捷电击（一键玩法：撩/拍/电/惩罚） ── */

  quickAction(to: string, actionId: QuickActionId, channel: QuickChannel): boolean {
    if (!this.canControlTarget(to)) return false
    const preset = QUICK_STRENGTH_PRESETS.find(p => p.id === actionId)
    if (!preset) return false
    // 目标上限从名册取（对方广播的 caps）；取不到按 60 保守处理
    const target = findMember(this.snapshot.room!, to)
    const cap = Math.min(target?.device.caps?.A ?? 60, target?.device.caps?.B ?? 60)
    const value = Math.max(1, Math.round(cap * preset.percent))
    const channels: Array<'A' | 'B'> = channel === 'both' ? ['A', 'B'] : [channel]
    for (const ch of channels) {
      const frames = Array.from({ length: preset.frames }, (_, i) => ({
        freq: Math.max(10, preset.freq - i * 5),
        strength: Math.max(1, Math.round(value * (1 - i * 0.12))),
      }))
      this.send({ kind: 'ctrl-op', payload: { op: { kind: 'pulse', channel: ch, frames } }, to })
    }
    this.pushControlLog('sent', `你对 ${this.nicknameOf(to)} 用了「${preset.label}」`, 'quick')
    if (actionId === 'tease') this.award('quick-tease')
    if (actionId === 'punish') this.award('quick-punish')
    return true
  }

  /* ── 惩罚轮盘（consent-first：目标确认后才开奖） ── */

  /** 发起轮盘（指定目标；目标必须在线且有设备） */
  startRoulette(target: string): boolean {
    if (this.snapshot.roulette && !this.snapshot.roulette.result) return false // 上一局未结束
    const game: RouletteGame = {
      id: globalThis.crypto.randomUUID().slice(0, 8),
      by: this.profile?.peerId || '',
      target,
      accepted: 'pending',
      result: null,
      at: Date.now(),
    }
    this.update({ roulette: game })
    this.broadcast({ kind: 'roulette-new', payload: { game } })
    return true
  }

  /** 目标：同意/拒绝 */
  respondRoulette(accept: boolean): void {
    const game = this.snapshot.roulette
    if (!game || game.accepted !== 'pending') return
    if (game.target !== this.profile?.peerId) return
    const next = { ...game, accepted: accept ? 'accepted' as const : 'declined' as const }
    this.update({ roulette: next })
    this.broadcast({ kind: accept ? 'roulette-accept' : 'roulette-decline', payload: { id: game.id } })
  }

  /** 发起人：目标同意后掷骰开奖 */
  spinRoulette(): RouletteSlotId | null {
    const game = this.snapshot.roulette
    if (!game || game.accepted !== 'accepted' || game.result) return null
    // 加权随机
    const total = ROULETTE_SLOTS.reduce((sum, slot) => sum + slot.weight, 0)
    let roll = Math.random() * total
    let picked: (typeof ROULETTE_SLOTS)[number] = ROULETTE_SLOTS[0]
    for (const slot of ROULETTE_SLOTS) {
      roll -= slot.weight
      if (roll <= 0) { picked = slot; break }
    }
    const next = { ...game, result: picked.id }
    this.update({ roulette: next })
    this.broadcast({ kind: 'roulette-result', payload: { id: game.id, result: picked.id } })
    // 发起人执行：对目标发对应指令
    if (picked.percent > 0) {
      const target = findMember(this.snapshot.room!, game.target)
      const cap = Math.min(target?.device.caps?.A ?? 60, target?.device.caps?.B ?? 60)
      const value = Math.max(1, Math.round(cap * picked.percent))
      const frames = Array.from({ length: Math.min(picked.frames, 100) }, (_, i) => ({
        freq: Math.max(10, picked.freq - Math.floor(i / 10) * 8),
        strength: Math.max(1, Math.round(value * (i < 3 ? 1 : 0.85))),
      }))
      for (const ch of ['A', 'B'] as const) {
        this.send({ kind: 'ctrl-op', payload: { op: { kind: 'pulse', channel: ch, frames } }, to: game.target })
      }
    }
    if (picked.id === 'nothing') this.award('roulette-survivor')
    if (picked.id === 'storm' && game.target === this.profile?.peerId) this.award('roulette-victim')
    this.pushControlLog('sent', `轮盘开奖：${this.nicknameOf(game.target)} 抽中「${ROULETTE_SLOTS.find(s => s.id === picked.id)?.label}」`, 'roulette')
    // 一局结束后 30s 清档
    window.setTimeout(() => {
      if (this.snapshot.roulette?.id === game.id) this.update({ roulette: null })
    }, 30_000)
    return picked.id
  }

  /* ── QQ 级聊天：输入中 / 表情回应 / 禁言 / 未读 ── */

  private lastTypingAt = 0

  /** 我正在输入（节流 2s；target='room' 或私聊对方 id） */
  notifyTyping(target: string): void {
    const now = Date.now()
    if (now - this.lastTypingAt < 2000) return
    this.lastTypingAt = now
    this.send({ kind: 'typing', payload: { peerId: this.profile?.peerId || '', target }, to: target === 'room' ? undefined : target })
  }

  /** 对消息添加表情回应（+1/-1 切换） */
  toggleReaction(messageId: string, emoji: string): void {
    const message = this.snapshot.chat.find(m => m.id === messageId)
    if (!message || message.recalled) return
    this.award('emoji-react')
    this.send({ kind: 'react', payload: { id: messageId, emoji, peerId: this.profile?.peerId || '' }, to: message.to })
    this.applyReaction(messageId, emoji, this.profile?.peerId || '', message.to)
  }

  private applyReaction(messageId: string, emoji: string, peerId: string, to?: string): void {
    const reactions = { ...this.snapshot.reactions }
    const forMessage = { ...(reactions[messageId] ?? {}) }
    const list = [...(forMessage[emoji] ?? [])]
    const index = list.indexOf(peerId)
    if (index >= 0) list.splice(index, 1)
    else list.push(peerId)
    if (list.length) forMessage[emoji] = list
    else delete forMessage[emoji]
    if (Object.keys(forMessage).length) reactions[messageId] = forMessage
    else delete reactions[messageId]
    this.update({ reactions })
    void to
  }

  /** 房主：禁言（分钟；0=解除）。被禁言者发聊天会被拒 */
  hostMute(peerId: string, minutes: number): void {
    this.moderateMuteInternal(peerId, minutes)
  }

  private moderateMuteInternal(peerId: string, minutes: number): void {
    if (!this.canModerate()) return
    if (peerId === this.snapshot.room?.hostId) return // 房主不可被禁言
    const until = minutes > 0 ? Date.now() + minutes * 60_000 : 0
    const next = { ...this.snapshot.mutedUntil }
    if (until > 0) next[peerId] = until
    else delete next[peerId]
    this.update({ mutedUntil: next })
    if (until > 0 && peerId === this.profile?.peerId) this.award('hidden-mute')
    this.broadcast({ kind: 'mute', payload: { peerId, until, by: this.profile?.peerId || '' } })
    this.pushSystemMessage(until > 0 ? `${this.nicknameOf(peerId)} 被禁言 ${minutes} 分钟` : `${this.nicknameOf(peerId)} 已解除禁言`)
  }

  isMuted(peerId: string): boolean {
    return (this.snapshot.mutedUntil[peerId] ?? 0) > Date.now()
  }

  /* ── 管理员体系（房主任命；管理员可踢人/禁言/改公告） ── */

  hostPromote(peerId: string): void {
    if (this.snapshot.role !== 'host') return
    if (this.snapshot.admins.includes(peerId)) return
    this.update({ admins: [...this.snapshot.admins, peerId] })
    this.award('hidden-admin')
    this.broadcast({ kind: 'promote', payload: { peerId, by: this.profile?.peerId || '' } })
    this.pushSystemMessage(`${this.nicknameOf(peerId)} 被任命为管理员`)
  }

  hostDemote(peerId: string): void {
    if (this.snapshot.role !== 'host') return
    this.update({ admins: this.snapshot.admins.filter(id => id !== peerId) })
    this.broadcast({ kind: 'demote', payload: { peerId, by: this.profile?.peerId || '' } })
    this.pushSystemMessage(`${this.nicknameOf(peerId)} 的管理员已撤回`)
  }

  isAdmin(peerId: string): boolean {
    return peerId === this.snapshot.room?.hostId || this.snapshot.admins.includes(peerId)
  }

  /** 管理员通用操作入口（房主或管理员可调；房主专属操作仍由 hostXxx 直接走） */
  canModerate(): boolean {
    const me = this.profile?.peerId
    if (!me) return false
    return this.snapshot.role === 'host' || this.snapshot.admins.includes(me)
  }

  /** 管理员踢人/禁言（房主同样走这里；被操作者不能是房主） */
  moderateKick(peerId: string): boolean {
    if (!this.canModerate()) return false
    if (peerId === this.snapshot.room?.hostId) return false
    this.award('hidden-kick')
    if (this.snapshot.role === 'host') { this.hostKick(peerId); return true }
    // 管理员：直接断开目标连接（hub 层踢出；kick 信封只认房主，这里不伪造）
    try { this.options.bridge?.kick(peerId) } catch { /* ignore */ }
    this.patchRoom(state => removeMember(state, peerId))
    this.pushSystemMessage(`管理员移除了一名成员`)
    return true
  }

  moderateMute(peerId: string, minutes: number): boolean {
    if (!this.canModerate()) return false
    if (peerId === this.snapshot.room?.hostId) return false
    this.moderateMuteInternal(peerId, minutes)
    return true
  }

  /** 打开私聊窗口：清零对该人的未读 */
  clearUnread(peerId: string): void {
    if (!this.snapshot.unreadByPeer[peerId]) return
    const next = { ...this.snapshot.unreadByPeer }
    delete next[peerId]
    this.update({ unreadByPeer: next })
  }

  /* ── 消息撤回 / @提及 ── */

  /** 撤回我的消息（2 分钟内） */
  recallMessage(messageId: string): boolean {
    const message = this.snapshot.chat.find(m => m.id === messageId && m.from === this.profile?.peerId)
    if (!message || Date.now() - message.at > 120_000) return false
    this.send({ kind: 'recall', payload: { id: messageId, to: message.to } })
    this.markRecalled(messageId, message.to)
    return true
  }

  private markRecalled(messageId: string, to?: string): void {
    this.update({ chat: this.snapshot.chat.map(m => m.id === messageId ? { ...m, recalled: true, text: undefined, dataUrl: undefined } : m) })
    void to
  }

  /** 解析 @提及（按昵称前缀匹配） */
  parseMentions(text: string): { clean: string; mentions: string[] } {
    const members = this.snapshot.room?.members || []
    const mentions: string[] = []
    let clean = text
    for (const member of members) {
      if (member.peerId === this.profile?.peerId || !member.nickname) continue
      if (clean.includes(`@${member.nickname}`)) {
        mentions.push(member.nickname)
        clean = clean.split(`@${member.nickname}`).join(`@${member.nickname} `)
      }
    }
    return { clean, mentions }
  }

  /* ── 正在听什么 ── */

  /** 广播我的播放状态（视图层在切歌/暂停时调用；2s 节流由调用方控制） */
  broadcastNowPlaying(status: NowPlayingStatus | null): void {
    this.broadcast({ kind: 'now-playing', payload: { peerId: this.profile?.peerId || '', status } })
  }

  /* ── 派对玩法中心（GameHub） ── */

  private gameTimers: number[] = []
  private recentTruthDare: string[] = []

  private clearGameTimers(): void {
    for (const timer of this.gameTimers) window.clearTimeout(timer)
    this.gameTimers = []
  }

  private pushGame(game: GameHubState | null): void {
    this.update({ game })
    this.broadcast(game ? { kind: 'game-new', payload: { game } } : { kind: 'game-end', payload: {} })
  }

  /** 发起玩法（发起人 = 主持人；惩罚统一走对方安全层） */
  startGame(kind: GameKind): boolean {
    if (this.snapshot.game && this.snapshot.game.phase !== 'done') return false
    this.clearGameTimers()
    const online = (this.snapshot.room?.members ?? []).filter(m => m.online).map(m => m.peerId)
    const now = Date.now()
    // 参与玩法计数：game-first（首场）与 games-10（累计 10 场）；派对小结同步 +1
    this.award('game-first')
    this.awardCounter('games', 'games-10', 10)
    this.bumpPartyStats('games')
    let game: GameHubState

    if (kind === 'truth-dare') {
      const target = pickRandomPlayer(online.filter(id => id !== this.profile?.peerId)) || this.profile?.peerId || ''
      const prompt = pickTruthDare(this.recentTruthDare)
      this.recentTruthDare = [...this.recentTruthDare.slice(-3), prompt.text]
      game = {
        kind, by: this.profile?.peerId || '', active: target, phase: 'acting',
        payload: { prompt }, submits: {}, result: null, endsAt: now + 60_000, at: now,
      }
      this.pushGame(game)
      this.pushSystemMessage(`🎮 ${GAME_LABEL[kind]}：${this.nicknameOf(target)} 被选中！`)
      this.gameTimers.push(window.setTimeout(() => this.timeOutGame(), 61_000))
      return true
    }

    if (kind === 'beat-echo') {
      const pattern = BEAT_PATTERNS[Math.floor(Math.random() * BEAT_PATTERNS.length)]
      game = {
        kind, by: this.profile?.peerId || '', active: null, phase: 'acting',
        payload: { pattern }, submits: {}, result: null, endsAt: now + 45_000, at: now,
      }
      this.pushGame(game)
      this.pushSystemMessage(`🎮 ${GAME_LABEL[kind]}：发起人按谱电自己作演示，其他人凭体感提交复述（玩法面板内）`)
      this.gameTimers.push(window.setTimeout(() => this.timeOutGame(), 46_000))
      return true
    }

    if (kind === 'red-light') {
      game = {
        kind, by: this.profile?.peerId || '', active: null, phase: 'acting',
        payload: { redLight: false }, submits: {}, result: null, endsAt: now + 60_000, at: now,
      }
      this.pushGame(game)
      this.pushSystemMessage(`🎮 ${GAME_LABEL[kind]}：绿灯！可以随意互电，红灯一响立刻紧急叫停——最慢的吃电`)
      const greenMs = 8_000 + Math.floor(Math.random() * 12_000)
      this.gameTimers.push(window.setTimeout(() => this.flipRedLight(), greenMs))
      return true
    }

    if (kind === 'relay-shock') {
      const order = online
      game = {
        kind, by: this.profile?.peerId || '', active: order[0] ?? null, phase: 'acting',
        payload: { note: order.map(id => this.nicknameOf(id)).join('→') }, submits: {}, result: null, endsAt: now + 120_000, at: now,
      }
      this.pushGame(game)
      if (order[0]) {
        const target = findMember(this.snapshot.room!, order[0])
        const caps = target?.device.caps ?? null
        const opA = punishOp(caps, 0.25, 3, 60)
        this.sendPunishOp(opA, game.at, order[0])
        this.sendPunishOp({ ...opA, channel: 'B' }, game.at, order[0])
      }
      this.pushSystemMessage(`🎮 ${GAME_LABEL[kind]}：电流已传给 ${this.nicknameOf(order[0] || '')}，3 秒内传给下一位！`)
      this.gameTimers.push(window.setTimeout(() => this.timeOutGame(), 121_000))
      return true
    }

    // guess-song
    const sync = this.snapshot.syncPlayback
    if (!sync?.title) {
      this.pushSystemMessage('猜歌名需要房主先开播同步听（放一首歌）')
      return false
    }
    game = {
      kind, by: this.profile?.peerId || '', active: null, phase: 'acting',
      payload: { hint: `歌名共 ${sync.title.length} 个字` }, submits: {}, result: null, endsAt: now + 45_000, at: now,
    }
    this.update({ game })
    this.gameAnswer = sync.title
    this.broadcast({ kind: 'game-new', payload: { game } })
    this.pushSystemMessage(`🎮 ${GAME_LABEL[kind]}：听房主正在放的歌，最快答出者安全！`)
    this.gameTimers.push(window.setTimeout(() => this.timeOutGame(), 46_000))
    return true
  }

  /** guess-song 的答案（只在发起人本地） */
  private gameAnswer = ''

  /** 成员提交（语义随玩法） */
  submitGame(value: string): void {
    const game = this.snapshot.game
    if (!game || game.phase === 'done') return
    const me = this.profile?.peerId || ''
    if (game.submits[me]) return
    this.send({ kind: 'game-submit', payload: { id: String(game.endsAt) + game.kind, peerId: me, value } })
    this.applyGameSubmit(me, value)
  }

  private applyGameSubmit(peerId: string, value: string): void {
    const game = this.snapshot.game
    if (!game || game.phase === 'done') return
    const updated: GameHubState = { ...game, submits: { ...game.submits, [peerId]: value } }
    this.update({ game: updated })
    if (game.kind === 'truth-dare' && peerId === game.active) {
      this.pushSystemMessage(`${this.nicknameOf(peerId)} 完成了挑战，过！`)
      this.settleGame({ loser: '', note: '完成' })
      return
    }
    if (game.kind === 'relay-shock' && peerId === game.active) {
      const order = (this.snapshot.room?.members ?? []).filter(m => m.online).map(m => m.peerId)
      const index = order.indexOf(peerId)
      const next = order[(index + 1) % order.length]
      this.update({ game: { ...updated, active: next } })
      const target = findMember(this.snapshot.room!, next)
      const caps = target?.device.caps ?? null
      const opA = punishOp(caps, 0.25, 3, 60)
      this.sendPunishOp(opA, game.at, next)
      this.sendPunishOp({ ...opA, channel: 'B' }, game.at, next)
      if (peerId === this.profile?.peerId) this.award('relay-survive')
      this.pushSystemMessage(`${this.nicknameOf(peerId)} 把电传给了 ${this.nicknameOf(next)}！`)
      return
    }
    if (game.kind === 'guess-song') {
      if (value.trim() === this.gameAnswer.trim()) {
        this.pushSystemMessage(`${this.nicknameOf(peerId)} 猜对了！《${this.gameAnswer}》`)
        this.settleGame({ loser: '', note: `被 ${this.nicknameOf(peerId)} 抢答成功` })
      }
      return
    }
    // 团队赛 2v2：两队各交一份 → 收卷判定（correct 编码在 payload.note 第 4 段）
    if (game.payload.note?.startsWith('team-match') && game.teams) {
      const parts = game.payload.note.split('|')
      const correct = Number(parts[3])
      const goldSubmitted = game.teams.gold.some(id => game.submits[id] !== undefined)
      const blueSubmitted = game.teams.blue.some(id => game.submits[id] !== undefined)
      if (goldSubmitted && blueSubmitted && this.snapshot.role === 'host') {
        this.settleTeamRound(correct)
      }
      return
    }
  }

  /** red-light 翻红灯（发起人侧） */
  private flipRedLight(): void {
    const game = this.snapshot.game
    if (!game || game.kind !== 'red-light' || game.phase === 'done') return
    const updated = { ...game, payload: { ...game.payload, redLight: true }, endsAt: Date.now() + 6_000 }
    this.update({ game: updated })
    this.broadcast({ kind: 'game-update', payload: { game: updated } })
    this.pushSystemMessage('🚨 红灯！！所有人立刻紧急叫停——最慢归零的吃电！')
    this.gameTimers.push(window.setTimeout(() => {
      const nowGame = this.snapshot.game
      if (!nowGame || nowGame.kind !== 'red-light' || nowGame.phase === 'done') return
      const paused = Object.keys(nowGame.submits)
      const candidates = (this.snapshot.room?.members ?? []).filter(m => m.online && !paused.includes(m.peerId)).map(m => m.peerId)
      const loser = pickRandomPlayer(candidates) || pickRandomPlayer((this.snapshot.room?.members ?? []).filter(m => m.online).map(m => m.peerId)) || ''
      this.settleGame({ loser, note: '红灯最慢归零' })
    }, 6_100))
  }

  /** 超时判定 */
  private timeOutGame(): void {
    const game = this.snapshot.game
    if (!game || game.phase === 'done') return
    if (game.kind === 'truth-dare') {
      this.settleGame({ loser: game.active || '', note: '超时没完成挑战' })
      return
    }
    if (game.kind === 'beat-echo') {
      const entries = Object.entries(game.submits)
      if (!entries.length) {
        const online = (this.snapshot.room?.members ?? []).filter(m => m.online).map(m => m.peerId)
        this.settleGame({ loser: pickRandomPlayer(online.filter(id => id !== game.by)) || game.by, note: '没人敢答，随机' })
        return
      }
      const pattern = game.payload.pattern ?? []
      let loser = entries[0][0]
      let worst = -1
      for (const [peerId, submit] of entries) {
        const wrong = scoreBeatEcho(pattern, submit)
        if (wrong > worst) { worst = wrong; loser = peerId }
      }
      this.settleGame({ loser, note: `错了 ${worst} 拍` })
      return
    }
    if (game.payload.note?.startsWith('team-match')) {
      // 团队赛：两队都没交卷 → 都算输一分（各派随机一人吃小电代表全队）
      this.settleTeamRound(null)
      return
    }
    if (game.payload.note?.startsWith('undercover')) {
      this.settleGame({ loser: '', note: '投票超时，本轮作废' })
      return
    }
    if (game.kind === 'relay-shock') {
      this.settleGame({ loser: game.active || '', note: '断链，双倍电', double: true })
      return
    }
    if (game.kind === 'guess-song') {
      this.settleGame({ loser: '', note: `没人猜出来（答案：${this.gameAnswer}）` })
      return
    }
    this.settleGame({ loser: '', note: '超时' })
  }

  /** 结算：对败者执行惩罚并广播结果 */
  private settleGame(outcome: { loser: string; note: string; double?: boolean }): void {
    const game = this.snapshot.game
    if (!game || game.phase === 'done') return
    const loser = outcome.loser
    const ended: GameHubState = { ...game, phase: 'done', result: { loser, note: outcome.note } }
    this.update({ game: ended })
    this.broadcast({ kind: 'game-update', payload: { game: ended } })
    if (loser) {
      const target = findMember(this.snapshot.room!, loser)
      const caps = target?.device.caps ?? null
      const percent = outcome.double ? 0.6 : 0.4
      const frames = outcome.double ? 10 : 5
      for (const ch of ['A', 'B'] as const) {
        const op = punishOp(caps, percent, frames, 45, ch)
        this.sendPunishOp(op, game.at, loser)
      }
      this.pushSystemMessage(`🎮 ${GAME_LABEL[game.kind]} 结算：${this.nicknameOf(loser)} ${outcome.note}，吃${outcome.double ? '双倍' : '一轮'}电⚡`)
    } else {
      this.pushSystemMessage(`🎮 ${GAME_LABEL[game.kind]} 结束：${outcome.note}`)
    }
    this.gameTimers.push(window.setTimeout(() => {
      if (this.snapshot.game?.at === game.at) this.update({ game: null })
    }, 15_000))
  }


  /** 团队赛收卷：option=null 表示超时全员未答（两队各计一负）；否则按答案判对错 */
  private settleTeamRound(correct: number | null): void {
    const game = this.snapshot.game
    if (!game?.teams || game.phase === 'done') return
    const teams = game.teams
    const loses = { ...teams.loses }
    let punished: string[] = []
    if (correct === null) {
      loses.gold += 1
      loses.blue += 1
      punished = [...teams.gold, ...teams.blue]
      this.pushSystemMessage(`🎮 团队赛：两队都没交卷，各记一负`)
    } else {
      // 两队提交：取每队第一个提交者
      const goldAns = teams.gold.map(id => game.submits[id]).find(v => v !== undefined)
      const blueAns = teams.blue.map(id => game.submits[id]).find(v => v !== undefined)
      if (goldAns !== undefined && Number(goldAns) !== correct) { loses.gold += 1; punished = teams.gold }
      if (blueAns !== undefined && Number(blueAns) !== correct) { loses.blue += 1; punished = [...punished, ...teams.blue] }
      if (!punished.length) {
        this.pushSystemMessage('🎮 团队赛：两队都对，平安无事！')
      } else {
        this.pushSystemMessage(`🎮 团队赛：答错的队伍全体吃小电⚡（比分 金 ${loses.gold} : 蓝 ${loses.blue}，先输 3 的队大电）`)
      }
    }
    const ended: GameHubState = { ...game, teams: { ...teams, loses }, phase: 'done', result: { loser: '', note: `金 ${loses.gold} : 蓝 ${loses.blue}` } }
    this.update({ game: ended })
    this.broadcast({ kind: 'game-update', payload: { game: ended } })
    for (const peerId of punished) {
      const targetMember = findMember(this.snapshot.room!, peerId)
      const caps = targetMember?.device.caps ?? null
      const op = punishOp(caps, 0.3, 4, 55)
      this.sendPunishOp(op, game.at, peerId)
    }
    // 终局判定：先输 3 的队全员大电
    const losingTeam = loses.gold >= TEAM_MATCH_LOSE_TARGET ? 'gold' : loses.blue >= TEAM_MATCH_LOSE_TARGET ? 'blue' : null
    if (losingTeam) {
      const members = losingTeam === 'gold' ? teams.gold : teams.blue
      this.pushSystemMessage(`🏆 团队赛终局：${losingTeam === 'gold' ? '金队' : '蓝队'}输满 ${TEAM_MATCH_LOSE_TARGET} 题，全队吃大电！`)
      for (const peerId of members) {
        const targetMember = findMember(this.snapshot.room!, peerId)
        const caps = targetMember?.device.caps ?? null
        const op = punishOp(caps, 0.7, 10, 35)
        this.sendPunishOp(op, game.at, peerId)
        this.sendPunishOp(punishOp(caps, 0.3, 4, 55, 'B'), game.at, peerId)
      }
    }
    window.setTimeout(() => { if (this.snapshot.game?.at === game.at) this.update({ game: null }) }, 20_000)
  }

  /** 真心话大冒险：目标点「我完成了」；red-light 的「我已归零」上报走同一入口。
   *  红灯判罚只认「红灯亮起后」的归零上报（提前叫停的不算）——由 flipRedLight 记录亮灯时刻比对。 */
  completeGame(): void {
    const game = this.snapshot.game
    if (game?.kind === 'red-light' && game.payload.redLight) {
      this.submitGame('paused')
      return
    }
    this.submitGame('done')
  }


  /* ── 团队赛 2v2 / 惩罚骰子 / 谁是卧底 ── */

  /** 2v2 团队赛：均分队伍 → 随机题两队作答 → 答错全队小电，先输 3 题的队集体大电 */
  startTeamMatch(): boolean {
    if (this.snapshot.game && this.snapshot.game.phase !== 'done') return false
    const online = (this.snapshot.room?.members ?? []).filter(m => m.online).map(m => m.peerId)
    if (online.length < 2) {
      this.pushSystemMessage('团队赛至少需要 2 人（4 人以上最好玩）')
      return false
    }
    const teams = assignTeams(online)
    const question = TEAM_QUESTIONS[Math.floor(Math.random() * TEAM_QUESTIONS.length)]
    const now = Date.now()
    const game: GameHubState = {
      kind: 'truth-dare', // 复用 kind 联合类型之外用 note 区分（见 payload）
      by: this.profile?.peerId || '',
      active: null,
      phase: 'acting',
      payload: { note: `team-match|${question.q}|${question.options.join('|')}|${question.correct}` },
      submits: {},
      result: null,
      endsAt: now + 30_000,
      at: now,
      teams: { gold: teams.gold, blue: teams.blue, loses: { gold: 0, blue: 0 } },
    }
    this.update({ game })
    this.broadcast({ kind: 'game-new', payload: { game } })
    this.pushSystemMessage(`🎮 团队赛 2v2 开始！金队 ${teams.gold.length} 人 vs 蓝队 ${teams.blue.length} 人——每题答错的全队吃小电，先输 ${TEAM_MATCH_LOSE_TARGET} 题的队集体大电！`)
    this.gameTimers.push(window.setTimeout(() => this.timeOutGame(), 31_000))
    return true
  }

  /** 团队赛提交（记录答案；发起人收卷后判定） */
  submitTeamAnswer(option: number): void {
    this.submitGame(String(option))
  }

  /** 惩罚骰子：掷骰并立刻执行（target 缺省=掷骰者自己） */
  rollPunishDice(target?: string): boolean {
    if (this.snapshot.game && this.snapshot.game.phase !== 'done' && this.snapshot.game.payload.note?.startsWith('dice')) return false
    const me = this.profile?.peerId || ''
    const victim = target || me
    const slot = rollDice()
    const game: GameHubState = {
      kind: 'truth-dare',
      by: me,
      active: victim,
      phase: 'done',
      payload: { note: `dice|${slot.id}` },
      submits: {},
      result: { loser: slot.percent > 0 ? victim : '', note: slot.label },
      endsAt: Date.now() + 8_000,
      at: Date.now(),
      dice: { slot: slot.id, target: victim, at: Date.now() },
    }
    this.update({ game })
    this.broadcast({ kind: 'game-update', payload: { game } })
    if (slot.id === 'safe') this.award('dice-safe')
    if (slot.id === 'storm' && victim === me) this.award('dice-storm')
    this.pushSystemMessage(`🎲 ${this.nicknameOf(me)} 为 ${this.nicknameOf(victim)} 掷出了：${slot.label}`)
    if (slot.percent > 0) {
      const targetMember = findMember(this.snapshot.room!, victim)
      const caps = targetMember?.device.caps ?? null
      for (const ch of ['A', 'B'] as const) {
        const op = punishOp(caps, slot.percent, Math.min(slot.frames, 100), slot.freq)
        this.sendPunishOp({ ...op, channel: ch }, game.at, victim)
      }
    }
    window.setTimeout(() => { if (this.snapshot.game?.at === game.at) this.update({ game: null }) }, 8_000)
    return true
  }

  /** 谁是卧底：发词（每人私有词经定向信封） */
  private undercoverAnswer = ''

  startUndercover(): boolean {
    if (this.snapshot.game && this.snapshot.game.phase !== 'done') return false
    const online = (this.snapshot.room?.members ?? []).filter(m => m.online).map(m => m.peerId)
    const deal = dealUndercover(online)
    if (!deal) {
      this.pushSystemMessage(`谁是卧底至少需要 ${UNDERCOVER_MIN_PLAYERS} 人`)
      return false
    }
    const now = Date.now()
    const game: GameHubState = {
      kind: 'truth-dare',
      by: this.profile?.peerId || '',
      active: null,
      phase: 'acting',
      payload: { note: `undercover|${deal.pair.civilian.length}|` },
      submits: {},
      result: null,
      endsAt: now + 180_000,
      at: now,
      undercover: { ejected: null, tie: false, votes: {}, wordLenHint: `你的词共 ${deal.pair.civilian.length} 个字` },
    }
    // 私发词：平民拿 civilian，卧底拿 undercover
    for (const peerId of online) {
      const word = peerId === deal.undercoverId ? deal.pair.undercover : deal.pair.civilian
      if (peerId === this.profile?.peerId) {
        this.myUndercoverWord = word
        this.undercoverAnswer = deal.pair.undercover
      } else {
        this.send({ kind: 'game-new', payload: { game: { ...game, payload: { ...game.payload, prompt: { type: 'truth', text: word } } } }, to: peerId })
      }
    }
    this.update({ game })
    this.pushSystemMessage(`🎮 谁是卧底开始！${online.length} 人各拿一个词，只有卧底的词不一样——轮流描述，然后投票！`)
    this.gameTimers.push(window.setTimeout(() => this.timeOutGame(), 181_000))
    return true
  }

  /** 我的卧底词（私有） */
  private myUndercoverWord = ''

  getMyUndercoverWord(): string {
    return this.myUndercoverWord
  }

  /** 谁是卧底：投票（票投给谁；全员投完或超时结算） */
  voteUndercover(target: string): void {
    const game = this.snapshot.game
    if (!game?.undercover || game.phase === 'done') return
    const me = this.profile?.peerId || ''
    if (game.undercover.votes[me]) return
    this.send({ kind: 'game-submit', payload: { id: String(game.endsAt) + 'vote', peerId: me, value: target } })
    this.applyUndercoverVote(me, target)
  }

  private applyUndercoverVote(peerId: string, target: string): void {
    const game = this.snapshot.game
    if (!game?.undercover || game.phase === 'done') return
    const votes = { ...game.undercover.votes, [peerId]: target }
    const online = (this.snapshot.room?.members ?? []).filter(m => m.online).map(m => m.peerId)
    const allVoted = online.every(id => votes[id])
    const ejected = tallyVotes(votes)
    const finished = allVoted || (Object.keys(votes).length >= online.length - 1)
    if (!finished) {
      this.update({ game: { ...game, undercover: { ...game.undercover, votes } } })
      return
    }
    // 结算
    const undercoverOut = ejected.ejected === this.undercoverAnswer ? false : true
    const caughtUndercover = ejected.ejected && !undercoverOut
    const finalLose = ejected.ejected ?? ''
    this.myUndercoverWord = ''
    const ended: GameHubState = {
      ...game,
      undercover: { ...game.undercover, votes, ejected: ejected.ejected, tie: ejected.tie },
      phase: 'done',
      result: { loser: caughtUndercover ? finalLose : '', note: caughtUndercover ? '卧底被揪出！' : ejected.tie ? '平票，全体吃小电' : '投错人了，平民吃小电' },
    }
    this.update({ game: ended })
    this.broadcast({ kind: 'game-update', payload: { game: ended } })
    // 影帝：参与了卧底且这局自己不是吃电的那个人
    if (this.myUndercoverWord || this.gameAnswer) {
      if (!caughtUndercover || finalLose !== this.profile?.peerId) this.award('undercover-win')
      this.myUndercoverWord = ''
    }
    if (caughtUndercover && finalLose) {
      const targetMember = findMember(this.snapshot.room!, finalLose)
      const caps = targetMember?.device.caps ?? null
      for (const ch of ['A', 'B'] as const) {
        const op = punishOp(caps, 0.8, 12, 40)
        this.sendPunishOp({ ...op, channel: ch }, game.at, finalLose)
      }
      this.pushSystemMessage(`🎮 谁是卧底：${this.nicknameOf(finalLose)} 被揪出来了，吃最终大电⚡`)
    } else {
      for (const peerId of online) {
        if (peerId === this.undercoverAnswer) continue // 卧底安全
        const targetMember = findMember(this.snapshot.room!, peerId)
        const caps = targetMember?.device.caps ?? null
        const op = punishOp(caps, 0.3, 4, 60)
        this.sendPunishOp(op, game.at, peerId)
      }
      this.pushSystemMessage(`🎮 谁是卧底：${ejected.tie ? '平票' : '投错人'}，平民们各吃小电⚡`)
    }
    window.setTimeout(() => { if (this.snapshot.game?.at === game.at) this.update({ game: null }) }, 20_000)
  }
  /* ── 点歌请求（共振平移：成员「想听」→ 房主一键跟播） ── */

  /** 成员：向房主请求播一首歌 */
  requestSong(title: string): boolean {
    if (this.snapshot.role !== 'member' || !this.profile) return false
    this.send({ kind: 'song-request', payload: { from: this.profile.peerId, title: String(title || '').slice(0, 60) } })
    return true
  }

  /** 房主：完成一条点歌请求（跟播后点掉） */
  completeSongRequest(from: string): void {
    this.update({ songRequests: this.snapshot.songRequests.filter(r => r.from !== from) })
    this.send({ kind: 'song-request-done', payload: { title: this.snapshot.syncPlayback?.title || '' }, to: from })
  }

  /* ── 好友（本机存储；房间内互加） ── */

  sendFriendRequest(to: string): boolean {
    if (!this.profile || to === this.profile.peerId) return false
    this.send({ kind: 'friend-request', payload: { profile: this.profile }, to })
    return true
  }

  /** 同意对方的好友申请：回执 + 写入本机好友列表（settings 层负责持久化，这里发事件） */
  respondFriendRequest(from: string, accept: boolean): void {
    const request = this.snapshot.friendRequests.find(r => r.from === from)
    if (!request) return
    this.update({ friendRequests: this.snapshot.friendRequests.filter(r => r.from !== from) })
    if (accept) {
      this.send({ kind: 'friend-accept', payload: { profile: this.profile }, to: from })
      window.dispatchEvent(new CustomEvent('waveforge:inparty-friend-added', { detail: request.profile }))
      this.award('first-friend')
      this.awardCounter('friends', 'friend-10', 10)
    }
  }

  /* ── 互控日志（谁对我做了什么） ── */

  private pushControlLog(direction: string, detail: string, action: ControlLogEntry['action'], from?: string): void {
    void direction
    const entry: ControlLogEntry = {
      id: globalThis.crypto.randomUUID(),
      at: Date.now(),
      from: from || this.profile?.peerId || '',
      fromNickname: from ? this.nicknameOf(from) : '我',
      action,
      detail,
    }
    this.update({ controlLog: [entry, ...this.snapshot.controlLog].slice(0, 80) })
  }

  /** 消费通话信令（摄像头/语音 hook 处理后调用，防止重复处理同一个 offer/ice） */
  consumeCallSignals(uptoIndex: number): void {
    if (uptoIndex < 0) return
    this.update({ callSignals: this.snapshot.callSignals.slice(uptoIndex + 1) })
  }

  /* ── 摄像头广播（直接开摄像头给全房间看；流走 WebRTC 点对点） ── */

  /** 我开始开播：向房间声明（autoStopSec 0=不自动停） */
  startCameraBroadcast(autoStopSec: number): void {
    this.broadcast({
      kind: 'cam-start',
      payload: { peerId: this.profile?.peerId || '', nickname: this.profile?.nickname || '', avatarEmoji: this.profile?.avatarEmoji || '', autoStopSec, startedAt: Date.now(), blanked: false },
    })
  }

  /** 我停止开播 */
  stopCameraBroadcast(): void {
    this.broadcast({ kind: 'cam-stop', payload: { peerId: this.profile?.peerId || '' } })
  }

  /** 一键全黑：画面强制黑帧（流保持，观众看到「已遮蔽」） */
  setCameraBlanked(blanked: boolean): void {
    this.broadcast({ kind: 'cam-blank', payload: { peerId: this.profile?.peerId || '', blanked } })
  }

  /* ── 同步听：房主权威播放（成员「边被电边一起听」的底座） ── */

  private lastSyncPushAt = 0
  private lastBeatPushAt = 0
  private syncTerm = 0

  /** 房主：广播本机播放状态（视图层 2s 一次；切换/暂停时立即） */
  broadcastSyncPlayback(playback: { title: string; artists: string; positionMs: number; playing: boolean } | null): void {
    if (this.snapshot.role !== 'host') return
    const now = Date.now()
    if (playback) {
      const previous = this.snapshot.syncPlayback
      if (!previous || previous.title !== playback.title) this.syncTerm += 1
    }
    this.update({ syncPlayback: playback ? { ...playback, atHostClock: now, term: this.syncTerm } : null })
    // 2s 节流（切歌/暂停时由调用方绕过：传 null 或新歌时强制发）
    if (now - this.lastSyncPushAt < 2000 && playback) return
    this.lastSyncPushAt = now
    this.broadcast({ kind: 'sync-play', payload: { playback: this.snapshot.syncPlayback } })
  }

  /** 房主：把本机实时节拍强度广播给房间（10Hz；成员「跟随房主节奏」用） */
  broadcastHostBeat(beat: { overall: number; beat: number }): void {
    if (this.snapshot.role !== 'host') return
    const now = Date.now()
    if (now - this.lastBeatPushAt < 100) return
    this.lastBeatPushAt = now
    this.update({ hostBeat: { ...beat, at: now } })
    this.broadcast({ kind: 'sync-play', payload: { beat: { ...beat, at: now } } })
  }

  /** 成员：开启/关闭「跟随房主节奏」——房主的节拍直接灌进我的设备（对方无需控制权，因为是我自己同意的） */
  setFollowHostRhythm(on: boolean): void {
    if (on) this.award('host-rhythm')
    this.update({ followHostRhythm: on })
    if (!on) getDGLabClient().sendRemoteOp({ kind: 'clear' })
  }

  /** 成员：计算「此刻本机应该播到哪」（房主时间戳 + 播放进度推算） */
  expectedPositionMs(): { trackTitle: string; positionMs: number; playing: boolean } | null {
    const sync = this.snapshot.syncPlayback
    if (!sync) return null
    const drift = Date.now() - sync.atHostClock
    return {
      trackTitle: sync.title,
      positionMs: sync.playing ? sync.positionMs + drift : sync.positionMs,
      playing: sync.playing,
    }
  }

  /** 成员：消费房主的节拍广播（开绑定时每帧调） */
  private applyHostBeat(beat: { overall: number; beat: number; at: number }): void {
    if (!this.snapshot.followHostRhythm) return
    // 节拍戳超过 1.5s 旧 → 房主可能暂停了
    if (Date.now() - beat.at > 1500) {
      getDGLabClient().sendRemoteOp({ kind: 'clear' })
      return
    }
    const level = Math.max(0, Math.min(1, beat.overall))
    // 复用互控通道直接打到本机设备（安全层照常生效）
    getDGLabClient().sendRemoteOp({ kind: 'strength', channel: 'A', value: Math.round(level * 120) })
    getDGLabClient().sendRemoteOp({ kind: 'strength', channel: 'B', value: Math.round(level * 120) })
    if (beat.beat > 0.55) {
      getDGLabClient().sendRemoteOp({ kind: 'pulse', channel: 'A', frames: [{ freq: 60, strength: 60 }] })
      getDGLabClient().sendRemoteOp({ kind: 'pulse', channel: 'B', frames: [{ freq: 60, strength: 50 }] })
    }
  }

  /* ── 语音房（连麦） ── */

  startVoiceBroadcast(): void {
    this.broadcast({
      kind: 'voice-start',
      payload: { peerId: this.profile?.peerId || '', nickname: this.profile?.nickname || '', muted: false },
    })
  }

  stopVoiceBroadcast(): void {
    this.broadcast({ kind: 'voice-stop', payload: { peerId: this.profile?.peerId || '' } })
  }

  setVoiceMuted(muted: boolean): void {
    this.broadcast({ kind: 'voice-mute', payload: { peerId: this.profile?.peerId || '', muted } })
  }

  /* ── 内部：收发 ── */

  private async refreshFingerprint(): Promise<void> {
    try {
      const fingerprint = await roomFingerprint(this.roomKey)
      this.update({ fingerprint })
    } catch { /* ignore */ }
  }

  private patchRoom(fn: (state: PartyRoomState) => PartyRoomState): void {
    const room = this.snapshot.room
    if (!room) return
    const next = fn(room)
    this.update({ room: next, summary: roomSummary(next) })
  }

  /** 房主名册广播（有变化时才发） */
  private broadcastState(): void {
    if (this.snapshot.role !== 'host' || !this.snapshot.room) return
    this.broadcast({ kind: 'state', payload: { room: this.snapshot.room } })
  }

  private appendChat(message: PartyChatMessage): void {
    const chat = [...this.snapshot.chat, message].slice(-INPARTY_CHAT_KEEP)
    this.update({ chat })
    // 消息漫游：文本/系统消息落本机历史（图/语音不落盘）
    if ((message.kind === 'text' || message.kind === 'system') && this.roomId) {
      appendRoomHistory(this.roomId, [{
        roomId: this.roomId,
        id: message.id,
        from: message.from,
        nickname: message.nickname,
        avatarEmoji: message.avatarEmoji,
        at: message.at,
        kind: message.kind,
        text: message.text,
      }])
    }
  }

  /* ── 节奏决斗（答题最慢/答错者吃一轮电） ── */

  /** 题库（中文音乐常识+派对向；全本地） */
  private static readonly DUEL_QUESTIONS = [
    // 音乐常识
    { q: '「协奏曲」的「协」是什么意思？', options: ['竞争', '和谐协作', '合奏'], correct: 1, topic: 'music' },
    { q: '电音里 BPM 指的是？', options: ['音量', '每分钟节拍数', '低音强度'], correct: 1, topic: 'music' },
    { q: '「和弦」最少需要几个音组成？', options: ['2 个', '3 个', '4 个'], correct: 1, topic: 'music' },
    { q: '黑胶唱片的标准转速是？', options: ['33⅓ 转', '45 转', '78 转'], correct: 0, topic: 'music' },
    { q: '「电音四件套」不包括？', options: ['Kick 底鼓', 'Hi-hat 踩镲', '吉他独奏'], correct: 2, topic: 'music' },
    { q: 'House 音乐的发源地是？', options: ['芝加哥', '伦敦', '东京'], correct: 0, topic: 'music' },
    { q: '标准吉他有几根弦？', options: ['4', '6', '8'], correct: 1, topic: 'music' },
    { q: '钢琴中央 C 的振动频率约为？', options: ['440Hz', '261Hz', '330Hz'], correct: 1, topic: 'music' },
    { q: '「交响诗」的发明者通常认为是？', options: ['李斯特', '巴赫', '肖邦'], correct: 0, topic: 'music' },
    { q: '贝斯通常是几弦为主？', options: ['4 弦', '6 弦', '12 弦'], correct: 0, topic: 'music' },
    { q: '「切分音」的特点是？', options: ['重音落在弱拍', '越弹越快', '两个声部'], correct: 0, topic: 'music' },
    { q: 'DJ 打碟机上的「Cue」键作用是？', options: ['标记回到点', '调音量', '加混响'], correct: 0, topic: 'music' },
    { q: '合唱里「A Capella」意思是？', options: ['无伴奏清唱', '大声唱', '轮流唱'], correct: 0, topic: 'music' },
    { q: 'MP3 相比 WAV 主要牺牲了？', options: ['音量', '部分高频细节', '声道'], correct: 1, topic: 'music' },
    { q: '「Loop」在电子乐制作里指？', options: ['循环片段', '失真效果', '调式'], correct: 0, topic: 'music' },
    { q: '五线谱下加一线是哪个音？', options: ['中央 C', 'A', 'E'], correct: 0, topic: 'music' },
    // 郊狼/安全
    { q: 'DG-LAB 郊狼是什么设备？', options: ['耳机', '电刺激设备', '麦克风'], correct: 1, topic: 'safety' },
    { q: '郊狼安全使用中，电极片严禁贴在？', options: ['大腿内侧', '上半身（耻骨区之上）', '手臂'], correct: 1, topic: 'safety' },
    { q: '被电时正确的做法是？', options: ['忍着不说', '随时可以叫停', '越痛越爽'], correct: 1, topic: 'safety' },
    { q: '郊狼的 A/B 指的是？', options: ['两路输出通道', '两个设备', '两种波形'], correct: 0, topic: 'safety' },
    { q: '「强度差（体质档）」控制的是？', options: ['音量', '单次强度变化上限', '波形频率'], correct: 1, topic: 'safety' },
    { q: '郊狼波形「频率」越低体感通常？', options: ['越尖锐刺痛', '越沉钝', '没区别'], correct: 1, topic: 'safety' },
    { q: '长时间玩电建议开启？', options: ['最大强度', '工作休息循环', '连按模式'], correct: 1, topic: 'safety' },
    { q: '开始前最重要的准备是？', options: ['调最大上限', '所有人知情同意+设好上限', '关灯'], correct: 1, topic: 'safety' },
    { q: '「脉冲」和「连续波」的区别？', options: ['断续 vs 持续输出', '强弱之分', '没区别'], correct: 0, topic: 'safety' },
    { q: '电极片应该？', options: ['跨心脏方向贴', '同一侧大腿下方对称贴', '随便贴'], correct: 1, topic: 'safety' },
    // 派对/流行文化
    { q: '「蹦迪」时最常出现的舞种是？', options: ['芭蕾', 'Freestyle 摇摆', '拉丁',], correct: 1, topic: 'party' },
    { q: '「Live House」指的是？', options: ['现场演出场地', '民宿', '录音棚'], correct: 0, topic: 'party' },
    { q: '音乐节通常的「压轴」含义是？', options: ['最后一组演出', '第一组演出', '中场表演'], correct: 0, topic: 'party' },
    { q: '「Encore」的意思是？', options: ['返场加演', '开场曲', '谢幕'], correct: 0, topic: 'party' },
    { q: '「Mosh Pit」出现在？', options: ['摇滚现场前排', '古典音乐厅', '歌剧院'], correct: 0, topic: 'party' },
    { q: '「Beat Drop」指的是？', options: ['鼓点落下瞬间', '音乐结束', '换歌'], correct: 0, topic: 'party' },
    { q: 'KTV 里「MVP」按钮通常是？', options: ['焦点演唱者', '切歌', '原唱'], correct: 0, topic: 'party' },
    { q: '「Remix」的含义是？', options: ['重新混音版本', '现场版', '清唱版'], correct: 0, topic: 'party' },
    { q: '「Backup Dancer」是？', options: ['伴舞', '主唱', '鼓手'], correct: 0, topic: 'party' },
    { q: '「Mashup」指的是？', options: ['多首歌混合', '独奏', '清唱'], correct: 0, topic: 'party' },
    // 脑筋急转弯（派对气氛）
    { q: '什么歌越电越想听？', options: ['情歌', '被电时放的这首歌', '儿歌'], correct: 1, topic: 'fun' },
    { q: '决斗输了的下场是？', options: ['吃一轮电', '罚酒', '唱歌'], correct: 0, topic: 'fun' },
    { q: '房间里谁说话最算数？', options: ['音量最大的', '房主和所有人一起商量', '最后说话的'], correct: 1, topic: 'fun' },
    { q: '「紧急叫停」按钮的作用是？', options: ['我的设备立刻归零', '结束派对', '切歌'], correct: 0, topic: 'fun' },
  ]

  /** 本房间已用过的题（避免连开几局重复） */
  private usedDuelQuestions = new Set<string>()

  /** 发起决斗（随机题）：全房间可见，所有在线成员作答，最慢/答错者被电。
   *  bestOf=1 单局制；3 = 三局两胜（先「输满 2 局」的人吃最终大电）。 */
  startDuel(bestOf: 1 | 3 = 1): boolean {
    if (this.snapshot.duel && !this.snapshot.duel.result && this.snapshot.duel.round === this.snapshot.duel.bestOf) return false
    // 上一局刚结束且赛制未满 → 自动进入下一局（由 settleDuelRound 调 startDuel(bestOf)） */
    if (this.snapshot.duel && !this.snapshot.duel.result) return false
    const bank = InPartySession.DUEL_QUESTIONS
    let unused = bank.filter(b => !this.usedDuelQuestions.has(b.q))
    if (!unused.length) { this.usedDuelQuestions.clear(); unused = bank }
    const question = unused[Math.floor(Math.random() * unused.length)]
    this.usedDuelQuestions.add(question.q)
    const previous = this.snapshot.duel
    const duel = {
      id: globalThis.crypto.randomUUID().slice(0, 8),
      by: this.profile?.peerId || '',
      question: { q: question.q, options: [...question.options] },
      answers: {} as Record<string, { option: number; at: number }>,
      result: null,
      startedAt: Date.now(),
      endsAt: Date.now() + 15_000,
      round: previous ? previous.round + 1 : 1,
      bestOf,
      score: previous?.score ? { ...previous.score } : {},
    }
    this.update({ duel })
    this.broadcast({ kind: 'duel-new', payload: { duel } })
    this.pushSystemMessage('节奏决斗开始！答得最慢的人吃一轮电')
    // 15s 收卷（由发起人计时并判定；成员超时未答=最慢）
    window.setTimeout(() => {
      if (this.snapshot.duel?.id === duel.id && !this.snapshot.duel.result) {
        const correct = question.correct
        // 判罚：所有在线成员里，「答错的」+「没作答的」都算输家候选；
        // 全部答对才从「最慢作答者」里选（考反应速度）。发起人没答一样算输家候选。
        const correctAnswerers = new Set(
          Object.entries(this.snapshot.duel.answers)
            .filter(([, a]) => a.option === correct)
            .map(([peerId]) => peerId),
        )
        const answeredWrong = Object.entries(this.snapshot.duel.answers)
          .filter(([, a]) => a.option !== correct)
          .map(([peerId]) => peerId)
        const notAnswered = this.snapshot.duel && this.snapshot.room
          ? this.snapshot.room.members.filter(m => m.online && m.peerId !== '' && !this.snapshot.duel!.answers[m.peerId]).map(m => m.peerId)
          : []
        const losers = [...answeredWrong, ...notAnswered]
        const loser = losers.length
          ? losers[Math.floor(Math.random() * losers.length)]
          : [Object.entries(this.snapshot.duel!.answers).sort((a, b) => b[1].at - a[1].at)[0]?.[0] || this.snapshot.duel!.by][0]
        const result = { loser, correctIndex: correct }
        const score = { ...(this.snapshot.duel?.score ?? {}) }
        score[loser] = (score[loser] ?? 0) + 1
        this.update({ duel: { ...this.snapshot.duel!, result } })
        this.broadcast({ kind: 'duel-result', payload: { id: duel.id, result, score } })
        // 执行惩罚：对输家发一轮电（发起人权限内发起，走输家自己的安全层）
        const target = findMember(this.snapshot.room!, loser)
        const cap = Math.min(target?.device.caps?.A ?? 60, target?.device.caps?.B ?? 60)
        const value = Math.max(1, Math.round(cap * 0.5))
        const frames = Array.from({ length: 6 }, (_, i) => ({ freq: 40 - i * 3, strength: Math.max(1, Math.round(value * (1 - i * 0.13))) }))
        for (const ch of ['A', 'B'] as const) {
          this.send({ kind: 'ctrl-op', payload: { op: { kind: 'pulse', channel: ch, frames } }, to: loser })
        }
        // 连胜结算：吃电者清零，其余在线参与者 +1
        const streaks = { ...this.snapshot.duelStreaks }
        for (const memberNow of this.snapshot.room?.members ?? []) {
          if (!memberNow.online) continue
          if (memberNow.peerId === loser) streaks[memberNow.peerId] = 0
          else {
            streaks[memberNow.peerId] = (streaks[memberNow.peerId] ?? 0) + 1
          }
        }
        // 决斗成就（本机视角：自己没输=win；连胜 3/5）
        const myId = this.profile?.peerId || ''
        if (myId && myId !== loser) {
          this.award('duel-win')
          if ((streaks[myId] ?? 0) >= 3) this.award('duel-streak-3')
          if ((streaks[myId] ?? 0) >= 5) this.award('duel-streak-5')
        }
        this.update({ duelStreaks: streaks })
        const topStreak = Math.max(0, ...Object.values(streaks))
        const streakNote = topStreak >= 3 ? `（${this.nicknameOf(Object.entries(streaks).find(([, n]) => n === topStreak)?.[0] || '')} ${topStreak} 连胜！）` : ''
        // 3局2胜计分：败者 +1;先输满 ceil(bestOf/2) 局的人吃最终大电
        const loseTarget = Math.ceil(duel.bestOf / 2)
        const finalLose = duel.bestOf > 1 && (score[loser] ?? 0) >= loseTarget
        if (finalLose) {
          // 大电: 上限 80%,12 帧长脉冲
          const targetFinal = findMember(this.snapshot.room!, loser)
          const capFinal = Math.min(targetFinal?.device.caps?.A ?? 60, targetFinal?.device.caps?.B ?? 60)
          const valueFinal = Math.max(1, Math.round(capFinal * 0.8))
          const framesFinal = Array.from({ length: 12 }, (_, i) => ({ freq: Math.max(10, 50 - i * 3), strength: Math.max(1, Math.round(valueFinal * (1 - i * 0.07))) }))
          for (const ch of ['A', 'B'] as const) {
            this.send({ kind: 'ctrl-op', payload: { op: { kind: 'pulse', channel: ch, frames: framesFinal } }, to: loser })
          }
          this.pushSystemMessage(`🏆 决斗终局：${this.nicknameOf(loser)} ${duel.bestOf} 局输满 ${loseTarget} 局，吃最终大电⚡${streakNote}`)
          window.setTimeout(() => { if (this.snapshot.duel?.id === duel.id) this.update({ duel: null }) }, 20_000)
        } else {
          this.pushSystemMessage(`决斗 ${duel.round}/${duel.bestOf} 局：${this.nicknameOf(loser)} 输了，吃小电⚡（比分 ${Object.entries(score).map(([pid, n]) => `${this.nicknameOf(pid)} ${n}`).join(' : ') || '0'}）`)
          // 5s 后自动开下一局（同一 bestOf 赛制）
          window.setTimeout(() => {
            if (this.snapshot.duel?.id === duel.id) {
              const nextDuel = { ...this.snapshot.duel, result: null, answers: {} }
              this.update({ duel: nextDuel })
              this.broadcast({ kind: 'duel-new', payload: { duel: nextDuel } })
              this.usedDuelQuestions // 保留
              this.startDuel(duel.bestOf)
            }
          }, 5_000)
        }
      }
    }, 15_000)
    return true
  }

  /** 作答（index 0..n-1；重复作答取第一次） */
  answerDuel(option: number): void {
    const duel = this.snapshot.duel
    if (!duel || duel.result) return
    if (duel.answers[this.profile?.peerId || '']) return
    this.send({ kind: 'duel-answer', payload: { id: duel.id, peerId: this.profile?.peerId || '', option, at: Date.now() } })
    this.update({ duel: { ...duel, answers: { ...duel.answers, [this.profile?.peerId || '']: { option, at: Date.now() } } } })
  }

  /* ── 观战模式（只看不电：安全出口之一） ── */

  setSpectating(on: boolean): void {
    this.update({ spectating: on })
    if (on) getDGLabClient().sendRemoteOp({ kind: 'clear' })
    this.broadcast({ kind: 'spectator', payload: { peerId: this.profile?.peerId || '', on } })
    this.pushSystemMessage(on ? '已进入观战：不再接受任何远端控制与玩法惩罚' : '已退出观战：恢复正常参与')
  }

  /* ── 好友私聊（真实可用：同房实时 / 离线排队） ── */

  /**
   * 给好友发私信：同房走房间定向私聊（E2E 实时）；不同房存 pending 队列，
   * 双方下次同房时自动补发。消息始终写本机历史（好友面板可读）。
   */
  sendFriendDM(peerId: string, text: string): boolean {
    const content = String(text || '').trim().slice(0, 500)
    if (!content || !this.profile) return false
    const inRoom = Boolean(this.snapshot.live && this.snapshot.room && findMember(this.snapshot.room, peerId))
    const message = { id: globalThis.crypto.randomUUID(), from: this.profile.peerId, text: content, at: Date.now(), self: true, pending: !inRoom }
    appendFriendMessage(peerId, message)
    if (inRoom) {
      this.send({ kind: 'chat', payload: { id: message.id, from: this.profile.peerId, nickname: this.profile.nickname, avatarEmoji: this.profile.avatarEmoji, at: message.at, kind: 'text', text: content, to: peerId } })
    }
    return true
  }

  /** 收到定向好友 DM（对方在同房发的）：写进好友历史 */
  private recordFriendDM(from: string, text: string, at: number): void {
    const friend = readFriends().find(f => f.peerId === from)
    if (!friend) return
    appendFriendMessage(from, { id: globalThis.crypto.randomUUID(), from, text, at, self: false })
  }

  /** 心跳时刷新好友在线状态 + 补发 pending 消息 */
  private refreshFriendPresence(): void {
    if (!this.snapshot.live || !this.snapshot.room) return
    const friends = readFriends()
    for (const friend of friends) {
      const member = findMember(this.snapshot.room, friend.peerId)
      if (member?.online) touchFriendPresence(friend.peerId)
    }
    for (const friend of friends) {
      const pendingMessages = (friend.messages ?? []).filter(m => m.pending && m.self)
      if (!pendingMessages.length) continue
      const member = findMember(this.snapshot.room, friend.peerId)
      if (!member?.online) continue
      for (const message of pendingMessages) {
        this.send({ kind: 'chat', payload: { id: message.id, from: this.profile?.peerId || '', nickname: this.profile?.nickname || '', avatarEmoji: this.profile?.avatarEmoji, at: message.at, kind: 'text', text: message.text, to: friend.peerId } })
      }
      markFriendMessagesDelivered(friend.peerId)
    }
  }
  /* ── 成就系统 ── */

  /** 派对小结计数：只累加指定字段（其余不变）；进房时 startedAt 重置 */
  private bumpPartyStats(field: 'controlOps' | 'punishSent' | 'shocked' | 'games', by = 1): void {
    const stats = this.snapshot.partyStats
    if (!stats) return
    this.update({ partyStats: { ...stats, [field]: stats[field] + by } })
  }

  /** 玩法惩罚统一出口：发送 + 派对小结 punishSent 计数（一次一组，不按帧算）。
   *  op 的静态类型是 PartyRemoteOp 全集（spread 换 channel 后 TS 收不窄成 pulse），
   *  运行时全部来自 punishOp()（恒为 pulse）；接收端仍会复核 kind !== 'pulse' 拒收。 */
  private sendPunishOp(op: PartyRemoteOp, gameAt: number, to: string): void {
    this.send({ kind: 'punish-op', payload: { op, gameAt, by: this.profile?.peerId || '' }, to })
    this.bumpPartyStats('punishSent')
  }

  /** 解锁成就：新解锁时入弹窗队列 */
  private award(id: string): void {
    try {
      if (unlockAchievement(id)) notifyAchievement(id)
    } catch { /* 成就失败不影响主流程 */ }
  }

  /** 累计计数成就：chat-100 / control-50 / games-10 / friend-10 */
  private awardCounter(counterKey: string, achievementId: string, target: number): void {
    try {
      const count = bumpCounter(counterKey)
      if (count >= target && !isAchievementUnlocked(achievementId)) this.award(achievementId)
    } catch { /* ignore */ }
  }

  private onceKeys = new Set<string>()

  /** 只推一次的系统提示（同 key 去重；用于「房主正在播放」这类会反复触发的场景） */
  private pushSystemMessageOnce(key: string, text: string): void {
    if (this.onceKeys.has(key)) return
    this.onceKeys.add(key)
    this.pushSystemMessage(text)
  }

  private pushSystemMessage(text: string): void {
    this.appendChat({
      id: globalThis.crypto.randomUUID(),
      from: 'system',
      nickname: '',
      avatarEmoji: '',
      at: Date.now(),
      kind: 'system',
      text,
    })
  }

  private send(message: { kind: EnvelopeKind; payload: unknown; to?: string }): void {
    if (!this.transport || !this.roomKey) return
    // 出站限流：1s 窗口滑动，总量 80 条（波形推送 10Hz×2通道 + 决斗/玩法指令 + 聊天都够用；
    // 防脚本刷屏）。聊天另有 CHAT_THROTTLE_MS 独立节流。
    const now = Date.now()
    this.outboundWindow = this.outboundWindow.filter(at => now - at < 1000)
    if (this.outboundWindow.length >= 80) return
    this.outboundWindow.push(now)
    const seq = ++this.sendSeq
    const envelope = sealMessage(this.roomKey, { roomId: this.roomId, from: this.profile?.peerId || '', kind: message.kind, seq, payload: message.payload })
    this.transport.send(envelope, message.to)
  }

  private broadcast(message: { kind: EnvelopeKind; payload: unknown }): void {
    this.send(message)
  }

  private handleEnvelope(envelope: unknown, fromPeerId: string): void {
    if (!this.roomKey) return
    const result = openMessage(this.roomKey, envelope, this.roomId)
    if (!result.ok) return
    if (!this.replay.accept(result.envelope.from, result.envelope.seq)) return
    const kind = result.envelope.kind as EnvelopeKind
    const payload = result.payload as Record<string, unknown>
    const from = result.envelope.from
    switch (kind) {
      case 'hello': {
        // 成员请求加入（房主处理）：登记进名册并回一份完整状态
        if (this.snapshot.role !== 'host' || !this.snapshot.room) return
        const profile = payload.profile as PartyProfile | undefined
        const policy = (payload.policy as ControlPolicy) || 'ask'
        if (!profile?.peerId || profile.peerId !== from) return // peerId 必须与连接席位一致
        // 安全：档案字段清洗（防超长/伪造头像数据撑爆名册广播）
        profile.nickname = String(profile.nickname || '').slice(0, 16)
        profile.bio = String(profile.bio || '').slice(0, 40)
        profile.avatarEmoji = String(profile.avatarEmoji || '🐺').slice(0, 4)
        if (typeof profile.avatarGradient?.[0] !== 'string' || profile.avatarGradient[0].length > 32) profile.avatarGradient = ['#FFE89C', '#d9a13c']
        // 自定义头像图：超过 512KB 的伪造载荷直接丢弃（回退 emoji 头像）
        if (typeof profile.avatarImage === 'string' && profile.avatarImage.length > 512 * 1024) delete profile.avatarImage
        const { state, joined } = joinMember(this.snapshot.room, profile, policy, Date.now())
        this.patchRoom(() => state)
        if (joined) this.pushSystemMessage(`${profile.nickname} 加入了房间`)
        this.send({ kind: 'state', payload: { room: this.snapshot.room }, to: from })
        this.broadcastState()
        return
      }
      case 'state': {
        // 房主状态（成员采纳）。安全：必须来自房主——否则任何成员可伪造名册
        if (this.snapshot.role !== 'member') return
        if (this.snapshot.room && from !== this.snapshot.room.hostId) return
        const room = payload.room as PartyRoomState | undefined
        if (!room || room.roomId !== this.roomId) return
        this.update({ room, summary: roomSummary(room) })
        return
      }
      case 'device-update': {
        if (this.snapshot.role !== 'host' || !this.snapshot.room) return
        const profile = payload.profile as PartyProfile | undefined
        const policy = (payload.policy as ControlPolicy) || 'ask'
        if (!profile?.peerId || profile.peerId !== from) return
        const { state, changed } = updateMember(this.snapshot.room, profile, policy)
        this.patchRoom(() => state)
        if (changed) this.broadcastState()
        return
      }
      case 'chat': {
        const message = payload as unknown as PartyChatMessage
        if (!message || message.from !== from) return
        // 禁言检查（房主设置对全员生效）
        if (this.isMuted(from)) return
        // 安全：载荷二次校验（不信任发送端自觉）：文本长度、图片/语音大小上限
        if (message.kind === 'text') {
          if (!message.text || message.text.length > INPARTY_CHAT_LIMIT) return
        } else if (message.kind === 'image') {
          if (!message.dataUrl || message.dataUrl.length > INPARTY_IMAGE_LIMIT) return
        } else if (message.kind === 'audio') {
          if (!message.dataUrl || message.dataUrl.length > 16 * 1024 * 1024) return
          if (!Number.isFinite(message.durationSec) || (message.durationSec ?? 0) > INPARTY_AUDIO_MAX_SEC) return
        } else {
          return // 未知类型拒绝
        }
        // 私聊：只显示发给全房或发给自己的
        if (message.to && message.to !== this.profile?.peerId) return
        this.appendChat(message)
        // 私聊未读：不在该会话窗口时 +1（视图层打开窗口时 clearUnread）
        if (message.to === this.profile?.peerId) {
          const current = this.snapshot.unreadByPeer[from] ?? 0
          this.update({ unreadByPeer: { ...this.snapshot.unreadByPeer, [from]: current + 1 } })
          this.recordFriendDM(from, message.text || '', message.at)
          // 首条未读提示（有会话打开时不打扰——由 UI 层把 unread 清零后再到的消息不弹）
          if (current === 0) {
            const requester = this.nicknameOf(from)
            window.dispatchEvent(new CustomEvent('app-toast', { detail: { message: `💬 ${requester} 私聊你：${(message.text || '[图片/语音]').slice(0, 24)}`, type: 'info', duration: 4200 } }))
          }
        }
        return
      }
      case 'promote': {
        if (this.snapshot.role !== 'member') return
        if (payload.by !== this.snapshot.room?.hostId) return // 只有房主任命
        const peerId = String(payload.peerId || '')
        if (peerId && !this.snapshot.admins.includes(peerId)) {
          this.update({ admins: [...this.snapshot.admins, peerId] })
          this.pushSystemMessage(`${this.nicknameOf(peerId)} 被任命为管理员`)
        }
        return
      }
      case 'demote': {
        if (this.snapshot.role !== 'member') return
        if (payload.by !== this.snapshot.room?.hostId) return
        const peerId = String(payload.peerId || '')
        if (peerId && this.snapshot.admins.includes(peerId)) {
          this.update({ admins: this.snapshot.admins.filter(id => id !== peerId) })
          this.pushSystemMessage(`${this.nicknameOf(peerId)} 的管理员已撤回`)
        }
        return
      }
      case 'song-request': {
        if (this.snapshot.role !== 'host') return
        const title = String(payload.title || '').slice(0, 60)
        if (!title || payload.from !== from) return
        const requester = this.nicknameOf(from)
        if (!this.snapshot.songRequests.some(r => r.from === from)) {
          this.update({ songRequests: [...this.snapshot.songRequests, { from, title, at: Date.now() }] })
          this.pushSystemMessage(`${requester} 点了一首《${title}》——在顶栏处理`)
        }
        return
      }
      case 'song-request-done': {
        this.pushSystemMessage(`房主收到你的点歌，正在安排：${String(payload.title || '')}`)
        return
      }
      case 'spectator': {
        if (payload.peerId !== from) return
        const member = this.snapshot.room ? findMember(this.snapshot.room, from) : undefined
        this.pushSystemMessage(payload.on === true
          ? `${member?.nickname || '某成员'} 进入观战（不再接受控制与惩罚）`
          : `${member?.nickname || '某成员'} 退出观战，恢复正常参与`)
        return
      }
      case 'game-new': {
        const game = payload.game as GameHubState | undefined
        if (!game?.kind || !game.by) return
        // guess-song 的答案绝不外发：成员侧剥掉（防御）
        this.update({ game: { ...game, payload: { ...game.payload } } })
        if (game.active === this.profile?.peerId) {
          this.pushSystemMessage('🎮 你被选中了！去「玩法」页签看任务')
        } else {
          this.pushSystemMessage(`🎮 ${GAME_LABEL[game.kind]} 开始了——去「玩法」页签参与`)
        }
        return
      }
      case 'game-update': {
        const updated = payload.game as GameHubState | undefined
        if (!updated?.kind) return
        // 安全：进行中的玩法更新必须来自该局发起人（结算时 hub 踢人断连的例外由 game-end 兜底）
        if (this.snapshot.game && this.snapshot.game.at === updated.at && from !== this.snapshot.game.by) return
        this.update({ game: updated })
        if (updated.phase === 'done' && updated.result) {
          this.pushSystemMessage(updated.result.loser
            ? `🎮 ${GAME_LABEL[updated.kind]} 结算：${this.nicknameOf(updated.result.loser)} ${updated.result.note}`
            : `🎮 ${GAME_LABEL[updated.kind]} 结束：${updated.result.note}`)
        }
        if (updated.kind === 'red-light' && updated.payload.redLight && updated.phase === 'acting') {
          this.pushSystemMessage('🚨 红灯！！立刻紧急叫停（一键归零），最慢的吃电！')
        }
        return
      }
      case 'game-submit': {
        const gameId = String(payload.id || '')
        const peerId = String(payload.peerId || '')
        if (peerId !== from) return
        const game = this.snapshot.game
        if (!game) return
        // 谁是卧底的投票(id 带 vote 后缀)
        if (gameId.endsWith('vote')) {
          if (game.undercover) this.applyUndercoverVote(peerId, String(payload.value || ''))
          return
        }
        if (String(game.endsAt) + game.kind !== gameId) return
        this.applyGameSubmit(peerId, String(payload.value || ''))
        return
      }
      case 'game-end': {
        this.update({ game: null })
        return
      }
      case 'typing': {
        if (payload.peerId !== from) return
        const target = String(payload.target || 'room')
        // 只关心：公屏输入中、或对我私聊输入中
        if (target !== 'room' && target !== this.profile?.peerId) return
        this.update({ typingPeers: { ...this.snapshot.typingPeers, [from]: target === 'room' ? 'room' : 'private' } })
        // 3s 无后续自动清除
        window.setTimeout(() => {
          const next = { ...this.snapshot.typingPeers }
          if (next[from]) { delete next[from]; this.update({ typingPeers: next }) }
        }, 3000)
        return
      }
      case 'react': {
        const id = String(payload.id || '')
        const emoji = String(payload.emoji || '')
        if (!id || !emoji || payload.peerId !== from) return
        const message = this.snapshot.chat.find(m => m.id === id)
        if (!message) return
        if (message.to && message.to !== this.profile?.peerId) return // 私聊回应只给对方
        this.applyReaction(id, emoji, from, message.to)
        return
      }
      case 'mute': {
        if (this.snapshot.role !== 'member') return
        // 房主或管理员都可禁言（来源校验：by 必须在权限名单里）
        const by = String(payload.by || '')
        if (by !== this.snapshot.room?.hostId && !this.snapshot.admins.includes(by)) return
        const peerId = String(payload.peerId || '')
        const until = Number(payload.until) || 0
        const next = { ...this.snapshot.mutedUntil }
        if (until > 0) next[peerId] = until
        else delete next[peerId]
        this.update({ mutedUntil: next })
        if (peerId === this.profile?.peerId && until > 0) this.pushSystemMessage(`你被房主禁言 ${Math.ceil((until - Date.now()) / 60000)} 分钟`)
        return
      }
      case 'pause-me': {
        if (payload.peerId !== from) return
        const member = this.snapshot.room ? findMember(this.snapshot.room, from) : undefined
        this.pushSystemMessage(`${member?.nickname || '某成员'} 按下了叫停`)
        return
      }
      case 'ctrl-op': {
        // 远端互控指令：复核（房间总闸 + 我的策略 + 授权表）→ 注入本机设备
        const op = payload.op as PartyRemoteOp | undefined
        if (!op || !this.profile) return
        const room = this.snapshot.room
        const me = room ? findMember(room, this.profile.peerId) : undefined
        if (!room || !me) return
        if (!room.interControlAllowed) return
        if (this.snapshot.spectating) return // 观战模式：不接受任何远端控制
        const allowed = me.controlPolicy === 'open'
          || (me.controlPolicy === 'ask' && (this.snapshot.grantsByPeer[from] || 0) > Date.now())
        if (!allowed) {
          // 未授权：回一条拒绝（对方 UI 立刻知道权限没了）
          this.send({ kind: 'ctrl-revoke', payload: {}, to: from })
          return
        }
        // 一键叫停后所有远端强度/波形指令拒绝（clear 恒允许，安全路径）
        // 郊狼设备安全层（对照 App 设置）：远程上限/跳变保护/倒计时/工作休息/延迟启动
        if (op.kind === 'strength') {
          this.award('first-shocked')
          const guarded = applyRemoteStrengthGuard(this.profile.peerId, op.channel, op.value)
          if (guarded.blockedReason && guarded.A === 0 && guarded.B === 0) {
            // 被安全层拦下（倒计时/休息/延迟）：设备侧仍然归零并提示一次
            getDGLabClient().sendRemoteOp({ kind: 'clear' })
            this.pushControlLog(from, guarded.blockedReason, 'clear', from)
            return
          }
          getDGLabClient().sendRemoteOp({ kind: 'strength', channel: op.channel, value: op.channel === 'A' ? guarded.A : guarded.B })
          this.pushControlLog(from, `${this.nicknameOf(from)} 调整 ${op.channel} → ${op.channel === 'A' ? guarded.A : guarded.B}`, 'strength', from)
          // 派对小结：按「实际送进设备」计——被安全层拦下的不算
          if (guarded.A > 0 || guarded.B > 0) this.bumpPartyStats('shocked')
          return
        }
        if (op.kind === 'pulse' && Array.isArray(op.frames)) {
          // 脉冲帧安全钳位：频率 ≤ App freqPara×2；强度按「该通道远程上限 remoteStrengthUL」
          // 整体缩放（否则用户 caps 高开时，remoteStrengthUL 会被 200 强帧绕过）
          const freqPara = peekDeviceSettingsFreq(this.profile.peerId)
          const ul = readDeviceSettings(this.profile.peerId).remoteStrengthUL[op.channel]
          const clamped = op.frames
            .map(f => ({
              freq: Math.max(1, Math.min(freqPara * 2, Math.round(Number(f?.freq) || 10))),
              strength: Math.max(0, Math.round(Number(f?.strength) || 0)),
            }))
            .map(f => ({ ...f, strength: Math.min(f.strength, ul) }))
            .filter(f => f.strength > 0)
          if (!clamped.length) {
            this.pushControlLog(from, `${this.nicknameOf(from)} 的波形帧全部低于远程上限，已忽略`, 'pulse', from)
            return
          }
          getDGLabClient().sendRemoteOp({ kind: 'pulse', channel: op.channel, frames: clamped })
          this.pushControlLog(from, `${this.nicknameOf(from)} 发送波形（${clamped.length} 帧 → ${op.channel}）`, 'pulse', from)
          this.bumpPartyStats('shocked')
          return
        }
        getDGLabClient().sendRemoteOp(op)
        return
      }
      case 'punish-op': {
        // 玩法惩罚通道：只接受「当前进行中玩法的发起人」——consent 已在玩法开始时取得
        // （轮盘=目标确认过、决斗/红绿灯=进玩法即认同、骰子=掷骰者指定、团队赛=全队参与）。
        // 惩罚依然过本机安全层（远程上限/跳变保护/倒计时/工作休息/延迟启动全生效）。
        const op = payload.op as PartyRemoteOp | undefined
        const gameAt = Number(payload.gameAt) || 0
        if (!op || !this.profile) return
        if (payload.by !== from) return // by 必须等于发送者
        // 发起人校验：当前任一进行中的玩法（game/roulette/duel）由 from 发起，且 gameAt 匹配
        const game = this.snapshot.game
        const roulette = this.snapshot.roulette
        const duel = this.snapshot.duel
        const isGameHost = Boolean(game && game.by === from && game.at === gameAt)
        const isRouletteHost = Boolean(roulette && roulette.by === from)
        const isDuelHost = Boolean(duel && duel.by === from)
        if (!isGameHost && !isRouletteHost && !isDuelHost) return
        // 范围保护: 玩法惩罚只允许 pulse（不开放强度拉扯与 clear——clear 是本人的安全路径）
        if (op.kind !== 'pulse' || !Array.isArray(op.frames)) return
        const freqPara = peekDeviceSettingsFreq(this.profile.peerId)
        const ul = readDeviceSettings(this.profile.peerId).remoteStrengthUL[op.channel === 'B' ? 'B' : 'A']
        const frames = op.frames
          .slice(0, 120)
          .map(f => ({ freq: Math.max(1, Math.min(freqPara * 2, Math.round(Number(f?.freq) || 10))), strength: Math.max(0, Math.round(Number(f?.strength) || 0)) }))
          .map(f => ({ ...f, strength: Math.min(f.strength, ul) }))
          .filter(f => f.strength > 0)
        if (!frames.length) return
        // 安全层（倒计时/休息/延迟）对惩罚同样生效：强度路径先过 guard
        getDGLabClient().sendRemoteOp({ kind: 'pulse', channel: op.channel === 'B' ? 'B' : 'A', frames })
        this.pushControlLog(from, `${this.nicknameOf(from)} 的玩法惩罚已送达（${frames.length} 帧）`, 'roulette', from)
        return
      }
      case 'ctrl-request': {
        if (!this.snapshot.controlRequests.includes(from)) {
          const member = this.snapshot.room ? findMember(this.snapshot.room, from) : undefined
          this.update({ controlRequests: [...this.snapshot.controlRequests, from] })
          this.pushSystemMessage(`${member?.nickname || from.slice(0, 6)} 请求控制你的设备`)
        }
        return
      }
      case 'ctrl-grant': {
        const next = { ...this.snapshot.grantsByPeer, [from]: Date.now() + GRANT_TTL_MS }
        this.update({ grantsByPeer: next })
        const member = this.snapshot.room ? findMember(this.snapshot.room, from) : undefined
        this.pushSystemMessage(`${member?.nickname || '对方'} 允许你控制 ta 的设备（5 分钟）`)
        return
      }
      case 'ctrl-revoke': {
        const next = { ...this.snapshot.grantsByPeer }
        delete next[from]
        this.update({ grantsByPeer: next })
        return
      }
      case 'call-signal': {
        const signal = payload as unknown as PartyCallSignal
        if (!signal || typeof signal !== 'object' || !('t' in signal)) return
        this.update({ callSignals: [...this.snapshot.callSignals.slice(-60), { from, signal, at: Date.now() }] })
        return
      }
      case 'cam-start': {
        if (payload.peerId !== from) return
        const entry: CameraBroadcaster = {
          peerId: from,
          nickname: String(payload.nickname || '').slice(0, 16),
          avatarEmoji: String(payload.avatarEmoji || '').slice(0, 4),
          autoStopSec: Number(payload.autoStopSec) || 0,
          startedAt: Number(payload.startedAt) || Date.now(),
          blanked: payload.blanked === true,
        }
        this.update({ broadcasters: [...this.snapshot.broadcasters.filter(b => b.peerId !== from), entry] })
        this.pushSystemMessage(`${entry.nickname || '某成员'} 开启了摄像头`)
        return
      }
      case 'cam-stop': {
        if (payload.peerId !== from) return
        const gone = this.snapshot.broadcasters.find(b => b.peerId === from)
        this.update({ broadcasters: this.snapshot.broadcasters.filter(b => b.peerId !== from) })
        if (gone) this.pushSystemMessage(`${gone.nickname || '某成员'} 关闭了摄像头`)
        return
      }
      case 'cam-blank': {
        if (payload.peerId !== from) return
        this.update({ broadcasters: this.snapshot.broadcasters.map(b => b.peerId === from ? { ...b, blanked: payload.blanked === true } : b) })
        return
      }
      case 'wave-bind': {
        const bind = payload.bind as WaveBind | undefined
        if (!bind || typeof payload.on !== 'boolean') return
        this.handleWaveBind(from, bind, payload.on)
        return
      }
      case 'quick-action': {
        // 兼容通道（新快捷电击直接走 ctrl-op）。安全：旧协议动作必须伴随合法 ctrl-op 才会真正
        // 执行——这里只记日志，不接受任何强度/波形参数
        const action = payload.action as QuickActionId | undefined
        if (!action) return
        this.pushControlLog(from, `${this.nicknameOf(from)} 对你用了快捷动作`, 'quick', from)
        return
      }
      case 'recall': {
        const id = String(payload.id || '')
        if (!id) return
        const message = this.snapshot.chat.find(m => m.id === id)
        // 只接受发送者本人的撤回
        if (!message || message.from !== from) return
        if (message.to && message.to !== this.profile?.peerId) return
        this.markRecalled(id, message.to)
        return
      }
      case 'roulette-new': {
        const game = payload.game as RouletteGame | undefined
        if (!game || !game.id || !game.target || game.by !== from) return // 发起人校验
        this.update({ roulette: game })
        if (game.target === this.profile?.peerId) {
          this.pushSystemMessage(`${this.nicknameOf(game.by)} 对你发起了惩罚轮盘——同意才会开奖`)
        } else {
          this.pushSystemMessage(`${this.nicknameOf(game.by)} 向 ${this.nicknameOf(game.target)} 发起了轮盘`)
        }
        return
      }
      case 'roulette-accept': {
        const current = this.snapshot.roulette
        // 安全：只有目标本人能确认（from 必须等于 target）
        if (current && current.id === payload.id && from === current.target) {
          this.update({ roulette: { id: current.id, by: current.by, target: current.target, accepted: 'accepted', result: current.result, at: current.at } })
          this.pushSystemMessage('轮盘已确认，等待发起人开奖')
        }
        return
      }
      case 'roulette-decline': {
        const currentDeclined = this.snapshot.roulette
        if (currentDeclined && currentDeclined.id === payload.id && from !== currentDeclined.target) return // 只有目标本人能拒绝
        if (currentDeclined && currentDeclined.id === payload.id) {
          this.update({ roulette: { id: currentDeclined.id, by: currentDeclined.by, target: currentDeclined.target, accepted: 'declined', result: currentDeclined.result, at: currentDeclined.at } })
          this.pushSystemMessage('对方拒绝了轮盘')
          window.setTimeout(() => { if (this.snapshot.roulette?.id === payload.id) this.update({ roulette: null }) }, 15_000)
        }
        return
      }
      case 'roulette-result': {
        const currentResult = this.snapshot.roulette
        if (currentResult && currentResult.id === payload.id && from !== currentResult.by) return // 只有发起人能开奖
        if (currentResult && currentResult.id === payload.id) {
          this.update({ roulette: { id: currentResult.id, by: currentResult.by, target: currentResult.target, accepted: currentResult.accepted, result: String(payload.result) as RouletteSlotId, at: currentResult.at } })
          const slot = ROULETTE_SLOTS.find(s => s.id === payload.result)
          this.pushSystemMessage(`轮盘开奖：${slot?.label || '未知'}`)
        }
        return
      }
      case 'now-playing': {
        if (payload.peerId !== from) return
        const status = (payload.status ?? null) as NowPlayingStatus | null
        this.patchRoom(state => ({
          ...state,
          members: state.members.map(member => member.peerId === from ? { ...member, nowPlaying: status } : member),
        }))
        return
      }
      case 'friend-request': {
        const profile = payload.profile as PartyProfile | undefined
        if (!profile?.peerId || profile.peerId !== from) return
        if (!this.snapshot.friendRequests.some(r => r.from === from)) {
          this.update({ friendRequests: [...this.snapshot.friendRequests, { from, profile, at: Date.now() }] })
          this.pushSystemMessage(`${profile.nickname} 想加你为好友`)
        }
        return
      }
      case 'friend-accept': {
        const profile = payload.profile as PartyProfile | undefined
        if (!profile?.peerId || profile.peerId !== from) return
        window.dispatchEvent(new CustomEvent('waveforge:inparty-friend-added', { detail: profile }))
        this.pushSystemMessage(`${profile.nickname} 通过了你的好友申请`)
        return
      }
      case 'sync-play': {
        if (this.snapshot.role !== 'member') return
        if (payload.playback !== undefined) {
          const playback = payload.playback as InPartySessionSnapshot['syncPlayback']
          this.update({ syncPlayback: playback ?? null })
          if (playback) this.pushSystemMessageOnce('sync', `房主正在播放《${playback.title}》——点顶部同步条跟随`)
        }
        if (payload.beat !== undefined) {
          const beat = payload.beat as { overall: number; beat: number; at: number }
          this.update({ hostBeat: beat })
          this.applyHostBeat(beat)
        }
        return
      }
      case 'voice-start': {
        if (payload.peerId !== from) return
        this.update({ voiceUsers: { ...this.snapshot.voiceUsers, [from]: { nickname: String(payload.nickname || '').slice(0, 16), muted: payload.muted === true } } })
        this.pushSystemMessage(`${String(payload.nickname || '某成员')} 加入了语音房`)
        return
      }
      case 'voice-stop': {
        if (payload.peerId !== from) return
        const nextVoice = { ...this.snapshot.voiceUsers }
        delete nextVoice[from]
        this.update({ voiceUsers: nextVoice })
        return
      }
      case 'voice-mute': {
        if (payload.peerId !== from) return
        const existingVoice = this.snapshot.voiceUsers[from]
        if (existingVoice) this.update({ voiceUsers: { ...this.snapshot.voiceUsers, [from]: { ...existingVoice, muted: payload.muted === true } } })
        return
      }
      case 'duel-new': {
        const duel = payload.duel as InPartySessionSnapshot['duel']
        if (!duel?.id || !duel.question || duel.by !== from) return // 只有发起人能开局（by 必须等于发送者）
        this.update({ duel: { ...duel, answers: {} } })
        this.pushSystemMessage('节奏决斗开始！答得最慢的人吃一轮电⚡——快去「决斗」页签作答')
        return
      }
      case 'duel-answer': {
        const duelNow = this.snapshot.duel
        if (!duelNow || duelNow.id !== payload.id || duelNow.result) return
        const peerId = String(payload.peerId || '')
        if (peerId !== from || duelNow.answers[peerId]) return
        const optionIdx = Number(payload.option)
        if (!Number.isInteger(optionIdx) || optionIdx < 0 || optionIdx >= duelNow.question.options.length) return // 越界答案拒绝
        this.update({ duel: { ...duelNow, answers: { ...duelNow.answers, [peerId]: { option: optionIdx, at: Number(payload.at) || Date.now() } } } })
        return
      }
      case 'duel-result': {
        const duelResult = this.snapshot.duel
        if (duelResult && duelResult.id === payload.id && from !== duelResult.by) return // 只有发起人能判罚
        if (duelResult && duelResult.id === payload.id) {
          const result = payload.result as { loser: string; correctIndex: number }
          const updated = { id: duelResult.id, by: duelResult.by, question: duelResult.question, answers: duelResult.answers, result, startedAt: duelResult.startedAt, endsAt: duelResult.endsAt, round: duelResult.round, bestOf: duelResult.bestOf, score: (payload as any).score ?? duelResult.score ?? {} }
          // 连胜结算（成员侧镜像）
          const streaks = { ...this.snapshot.duelStreaks }
          for (const memberNow of this.snapshot.room?.members ?? []) {
            if (!memberNow.online) continue
            if (memberNow.peerId === result.loser) streaks[memberNow.peerId] = 0
            else streaks[memberNow.peerId] = (streaks[memberNow.peerId] ?? 0) + 1
          }
          this.update({ duel: updated, duelStreaks: streaks })
          this.pushSystemMessage(`决斗结束：${this.nicknameOf(result.loser)} 输了，吃一轮电⚡（正确答案：${duelResult.question.options[result.correctIndex]}）`)
          window.setTimeout(() => { if (this.snapshot.duel?.id === duelResult.id) this.update({ duel: null }) }, 20_000)
        }
        return
      }
      case 'kick': {
        // 安全：kick 信封必须来自房主（管理员的踢人走 hub 层直接断开，不发伪造信封）
        if (this.snapshot.room && from !== this.snapshot.room.hostId) return
        this.pushSystemMessage('你被房主移出了房间')
        this.leave()
        return
      }
      case 'dissolve': {
        // 安全：只有房主能解散
        if (this.snapshot.room && from !== this.snapshot.room.hostId) return
        this.pushSystemMessage('房主已解散房间')
        this.leave()
        return
      }
      case 'bye': {
        if (this.snapshot.role === 'host' && payload.peerId === from) {
          this.patchRoom(state => removeMember(state, from))
          this.broadcastState()
        }
        return
      }
      case 'ping':
        this.send({ kind: 'pong', payload: {}, to: from })
        return
      default:
        return
    }
  }

  /**
   * 释放主进程里的房间中转。
   * keepRoomId：hub 正跑着「这个房间」时**不要停**——In Party 同机双角色场景
   * （房主会话与成员会话共用一个 hub/bridge），成员加入时停掉 hub 会把房主的房间杀掉。
   */
  private async releaseRelay(force = false, keepRoomId?: string): Promise<void> {
    const host = this.transport
    this.transport = null
    if (host) { try { await host.close() } catch { /* 已经停了 */ } }
    const bridge = this.options.bridge
    if (!bridge) return
    try {
      const status = await bridge.getStatus()
      const isSameRoom = keepRoomId && status?.roomId === keepRoomId
      if (status?.running && status.roomId && !isSameRoom && (force || status.roomId !== this.roomId)) await bridge.stop()
    } catch { /* 主进程不可用 */ }
  }

  private startTimers(): void {
    this.stopTimers()
    // 心跳：广播 ping（成员经中转），超时未响应的成员由房主摘除
    this.timers.push(window.setInterval(() => {
      const now = Date.now()
      this.lastHeartbeatAt = now
      if (this.snapshot.live) {
        this.broadcast({ kind: 'ping', payload: {} })
        this.refreshFriendPresence()
      }
      const room = this.snapshot.room
      if (!room) return
      // 我自己的在线标记（房主侧）
      if (this.profile) {
        const me = findMember(room, this.profile.peerId)
        if (me && !me.online) {
          this.patchRoom(state => {
            const members = state.members.map(member => member.peerId === this.profile!.peerId
              ? { ...member, online: true, lastSeenAt: now }
              : member)
            return { ...state, members }
          })
        }
      }
      // 成员侧：房主超过 OFFLINE_AFTER_MS 没有任何消息 → 视为断线（中转 closed 事件兜底）
    }, HEARTBEAT_MS))
    // 授权过期清理
    this.timers.push(window.setInterval(() => {
      const now = Date.now()
      const expired = Object.entries(this.snapshot.grantsByPeer).filter(([, until]) => (until as number) <= now)
      if (expired.length) {
        const next = { ...this.snapshot.grantsByPeer }
        for (const [peerId] of expired) delete next[peerId]
        this.update({ grantsByPeer: next })
      }
      // 房主侧：把离线超限的成员摘掉
      if (this.snapshot.role === 'host' && this.snapshot.room) {
        const stale = this.snapshot.room.members.filter(member => member.peerId !== this.profile?.peerId && !member.online && now - member.lastSeenAt > OFFLINE_AFTER_MS)
        if (stale.length) {
          for (const member of stale) this.patchRoom(state => removeMember(state, member.peerId))
          this.broadcastState()
        }
      }
    }, 5000))
  }

  private stopTimers(): void {
    for (const timer of this.timers) window.clearInterval(timer)
    this.timers = []
  }

  /** 主动重置（不含 UI 提示） */
  reset(): void {
    this.stopTimers()
    // 游戏玩法定时器（超时/结算/红绿灯）一并清：否则离房后定时器还开火
    this.clearGameTimers()
    void this.transport?.close()
    this.transport = null
    this.unwatchDevice?.()
    this.unwatchDevice = null
    this.replay.reset()
    this.roomKey = ''
    this.roomId = ''
    this.password = ''
    this.sendSeq = 0
    this.outboundWindow = []
    // 私有会话态一并复位（onceKeys 跨房间保留会导致提示不响；gameAnswer 泄露到下一房）
    this.onceKeys.clear()
    this.gameAnswer = ''
    this.myUndercoverWord = ''
    this.usedDuelQuestions.clear()
    this.recentTruthDare = []
    this.waveBinds.clear()
    this.lastChatAt = 0
    this.lastTypingAt = 0
    this.lastSyncPushAt = 0
    this.lastBeatPushAt = 0
    this.deviceAwarded = false
    // 郊狼安全层运行时状态不跨房间残留（倒计时锁定/休息相位）
    clearAllGuards()
    this.snapshot = {
      status: 'idle', role: null, error: '', room: null, roomName: '', invite: '', fingerprint: '', chat: [],
      summary: null, grantsByPeer: {}, controlRequests: [], device: null, live: false,
      broadcasters: [], callSignals: [], roulette: null, controlLog: [], friendRequests: [], unreadByPeer: {}, typingPeers: {}, reactions: {}, mutedUntil: {}, voiceUsers: {}, admins: [], songRequests: [], game: null,
      partyStats: { startedAt: Date.now(), controlOps: 0, punishSent: 0, shocked: 0, games: 0 },
    spectating: false,
    syncPlayback: null, hostBeat: null, followHostRhythm: false, duel: null, duelStreaks: {},
    }
    this.notify()
  }
}

let session: InPartySession | null = null

export function getInPartySession(): InPartySession {
  if (!session) session = new InPartySession({ bridge: (globalThis as { electron?: { resonance?: NonNullable<Window['electron']>['resonance'] } }).electron?.resonance })
  return session
}

/** 供 React 外部使用 */
export type { SessionOptions }
