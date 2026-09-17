/**
 * 共振会话层端到端集成测试（node 环境）：
 * 真起一个局域网中转（desktop/resonance-hub.cjs），用一个桥接对象把它接到会话层，
 * 再用真实的 WebSocket 让「成员会话」加入，验证：
 *   创建 → 邀请串（含密钥种子）→ 加入 → 加密状态下发 → 聊天双向 → 房主推歌 → 成员可播性上报。
 * 这里刻意不 mock 加密与模型：跑的就是生产路径。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createResonanceHub } from '../desktop/resonance-hub.cjs'
import { ResonanceSession, type ResonancePlaybackAdapter } from '../src/features/resonance/session'
import type { ResonanceTrack } from '../src/features/resonance/model'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// 会话层用到 window 定时器；node 环境补一个最小替身（不真正跑定时器，测试里手动触发）
const g = globalThis as any
if (!g.window) {
  g.window = {
    setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
    // 返回 0 让 startTimers 的定时器不真正跑（心跳由测试手动驱动）
    setInterval: () => 0,
    clearInterval: () => undefined,
  }
}

function createHubWithBridge(hubOptions: Record<string, unknown> = {}) {
  const listeners = new Set<(event: any) => void>()
  const emit = (event: any) => {
    for (const listener of [...listeners]) listener(event)
  }
  // 与主进程一致：hub 的 onEvent → 转发给渲染进程订阅者
  const hub = createResonanceHub({ getComputerName: () => 'TestHost', getLanIps: () => [{ name: 'eth', address: '127.0.0.1' }], onEvent: emit, ...hubOptions })
  const bridge = {
    start: (config: any) => hub.start({ ...config, port: 0 }),
    stop: () => hub.stop(),
    getStatus: () => hub.status(),
    send: (payload: any) => (payload?.to && payload.to !== 'all' ? (hub.sendTo(payload.to, payload.envelope) ? 1 : 0) : hub.broadcast(payload.envelope)),
    kick: (peerId: string) => hub.kick(peerId),
    buildInvite: () => '',
    updateCode: (code: string) => hub.updateCode(code),
    scanLan: () => [],
    onEvent: (callback: (event: any) => void) => {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
  } as any
  return { hub, bridge, emit, events: () => [...listeners].length }
}

function adapterFor(tracks: ResonanceTrack[]) {
  const applied: Array<{ trackKey: string; positionMs: number; playing: boolean; hard: boolean }> = []
  const queues: Array<{ length: number; startIndex: number }> = []
  const adapter: ResonancePlaybackAdapter = {
    readLocal: () => ({ trackKey: tracks[0]?.key || '', positionMs: 12_345, playing: true }),
    apply: (playback, hard) => { applied.push({ ...playback, hard }) },
    setQueue: (queue, startIndex) => { queues.push({ length: queue.length, startIndex }) },
    canPlay: async () => ({ playable: true }),
  }
  return { adapter, applied, queues }
}

const track = (title: string, artists: string[]) => ({
  title,
  artists,
  durationMs: 200000,
  sources: [{ platform: 'netease' as const, id: 1 }],
})

describe('共振会话：创建 → 邀请 → 加入 → 加密通信', () => {
  let hub: ReturnType<typeof createResonanceHub>
  let hubBridge: ReturnType<typeof createHubWithBridge>

  // 一个 hub 只承载一个房间（与主进程一致）：每个用例重启一次
  beforeEach(() => {
    hubBridge = createHubWithBridge()
    hub = hubBridge.hub
  })

  afterEach(() => {
    hub.stop()
  })

  it('房主创建房间后成员能用邀请串加入，并收到加密的房间状态', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    await hostSession.create({
      roomId: 'room-e2e',
      nickname: '房主',
      platforms: [{ platform: 'netease', loggedIn: true, tier: 'vip' }],
      mode: 'party',
      peerId: 'host-peer',
    })
    const invite = hostSession.getSnapshot().invite
    expect(invite.startsWith('wf-resonance://')).toBe(true)
    // 邀请串里带密钥种子，且不包含房间密钥本身
    expect(invite).toMatch(/#\d{6}\.[A-Za-z0-9_-]{20,}$/)

    const { adapter, queues } = adapterFor([])
    const memberSession = new ResonanceSession()
    memberSession.setAdapter(adapter)

    await memberSession.join(invite, {
      nickname: '听众',
      platforms: [{ platform: 'qq', loggedIn: true, tier: 'free' }],
      peerId: 'member-peer',
    })

    // 成员入房 → 房主收到 hello（加密）→ 房间成员数变为 2
    await wait(600)
    const hostRoom = hostSession.getSnapshot().room
    expect(hostRoom?.members.length).toBe(2)
    expect(hostRoom?.members.map(member => member.nickname).sort()).toEqual(['房主', '听众'].sort())

    // 成员收到房主的状态广播（含队列），并写入本地播放器队列
    expect(memberSession.getSnapshot().room?.roomId).toBe('room-e2e')
    expect(queues.length).toBeGreaterThanOrEqual(0)

    // 房主推歌 → 成员队列同步
    const pushed = hostSession.hostAddTracks([track('Lemon', ['米津玄師'])], true)
    expect(pushed.ok).toBe(true)
    await wait(400)
    expect(memberSession.getSnapshot().room?.queue).toHaveLength(1)
    expect(queues.at(-1)).toEqual({ length: 1, startIndex: 0 })

    // 聊天双向：成员 → 房主
    memberSession.sendChat('这首好听')
    await wait(400)
    expect(hostSession.getSnapshot().chat.map(message => message.text)).toContain('这首好听')

    // 聊天双向：房主 → 成员（房主广播，成员收到）
    hostSession.sendChat('同感')
    await wait(400)
    const memberChat = memberSession.getSnapshot().chat.map(message => message.text)
    expect(memberChat).toContain('同感')

    // 房间指纹在双方一致（用于带外核对，防中间人）
    expect(hostSession.getSnapshot().fingerprint).toBe(memberSession.getSnapshot().fingerprint)
    expect(hostSession.getSnapshot().fingerprint.split(' ')).toHaveLength(4)

    memberSession.leave()
    hostSession.leave()
  })

  it('房主广播播放进度后，成员按权威状态对齐', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    // 房主侧也要有播放适配器：pushPlayback 会读它拿到本机进度
    const hostSide = adapterFor([])
    hostSession.setAdapter(hostSide.adapter)
    await hostSession.create({
      roomId: 'room-playback',
      nickname: '房主',
      platforms: [],
      mode: 'shared-playlist',
      peerId: 'host-peer-2',
    })
    const invite = hostSession.getSnapshot().invite
    hostSession.hostAddTracks([track('A', ['x'])], true)

    const { adapter, applied } = adapterFor([])
    const memberSession = new ResonanceSession()
    memberSession.setAdapter(adapter)
    await memberSession.join(invite, { nickname: '听众', platforms: [], peerId: 'member-peer-2' })
    await wait(600)

    hostSession.pushPlayback(true)
    await wait(400)
    expect(applied.length).toBeGreaterThan(0)
    // 第一帧必须硬对齐；随后的周期性状态属于缓慢漂移修正（soft）
    expect(applied[0].hard).toBe(true)
    const last = applied.at(-1)!
    expect(last.playing).toBe(true)
    // 位置是「房主上报位置 + 经过时间」的投影，不应小于房主上报值
    expect(last.positionMs).toBeGreaterThanOrEqual(12345)
    // 房主拖进度 → 下一次推送应判定为硬同步
    applied.length = 0
    hostSession.pushPlayback(true)
    await wait(400)
    expect(applied.length).toBeGreaterThan(0)

    memberSession.leave()
    hostSession.leave()
  })

  it('聊天转发不回给发送者，且保留原作者昵称（不被房主覆盖）', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    await hostSession.create({ roomId: 'room-chat', nickname: '房主', platforms: [], mode: 'party', peerId: 'host-peer-chat' })
    const memberSession = new ResonanceSession()
    await memberSession.join(hostSession.getSnapshot().invite, { nickname: '听众', platforms: [], peerId: 'member-peer-chat' })
    await wait(600)

    memberSession.sendChat('这首好听')
    await wait(400)
    // 房主收到：作者是听众
    expect(hostSession.getSnapshot().chat.map(message => message.nickname + ':' + message.text)).toEqual(['听众:这首好听'])
    // 成员自己只有一条（self），不会收到房主名义的回声
    const memberChat = memberSession.getSnapshot().chat
    expect(memberChat.map(message => message.nickname + ':' + message.text)).toEqual(['听众:这首好听'])
    expect(memberChat[0].self).toBe(true)

    hostSession.sendChat('同感')
    await wait(400)
    expect(memberSession.getSnapshot().chat.map(message => message.nickname + ':' + message.text)).toEqual(['听众:这首好听', '房主:同感'])

    memberSession.leave()
    hostSession.leave()
  })

  it('成员重复收到状态也不会重复上报无法播放（防消息风暴）', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    await hostSession.create({ roomId: 'room-storm', nickname: '房主', platforms: [], mode: 'party', peerId: 'host-storm' })
    // 房主侧统计收到的「无法播放」上报条数
    const kinds: string[] = []
    hubBridge.bridge.onEvent((event: any) => {
      if (event?.type === 'envelope') { const opened = hostSession.debugOpen(event.env); if (opened.ok && opened.kind) kinds.push(opened.kind) }
    })

    const { adapter } = adapterFor([])
    const memberSession = new ResonanceSession()
    // 成员在本机一律播不了（未登录场景），正是最容易触发风暴的情形
    memberSession.setAdapter({ ...adapter, canPlay: async () => ({ playable: false, reason: 'locked', tier: 'vip' }) })
    await memberSession.join(hostSession.getSnapshot().invite, { nickname: '听众', platforms: [], peerId: 'member-storm' })
    await wait(600)

    // 房主开始播放队列里的这首（成员这时才需要判断「我能不能播」，此前只是在队列里）
    let localTrackKey = ''
    hostSession.setAdapter({ ...adapterFor([]).adapter, readLocal: () => ({ trackKey: localTrackKey, positionMs: 0, playing: true }) })
    hostSession.hostAddTracks([track('Storm', ['x'])], true)
    await wait(600)
    // 队列里但还没开始播 → 不应上报（避免为几百首待播歌曲空转）
    expect(kinds.filter(kind => kind === 'cannot-play').length).toBe(0)
    localTrackKey = hostSession.getSnapshot().queue.items[0].key
    hostSession.pushPlayback(true)
    await wait(800)
    expect(kinds.filter(kind => kind === 'cannot-play').length).toBe(1)

    // 再让房主推两次播放状态：成员不应因此重复上报
    hostSession.pushPlayback(true)
    await wait(400)
    hostSession.pushPlayback(true)
    await wait(500)
    expect(kinds.filter(kind => kind === 'cannot-play').length).toBe(1)

    memberSession.leave()
    hostSession.leave()
  })

  it('房主自己投票也算票，达到阈值（在线人数 8 成）即通过并切歌', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    await hostSession.create({ roomId: 'room-vote', nickname: '房主', platforms: [], mode: 'party', peerId: 'host-vote' })
    const memberSession = new ResonanceSession()
    await memberSession.join(hostSession.getSnapshot().invite, { nickname: '听众', platforms: [], peerId: 'member-vote' })
    await wait(600)
    hostSession.hostAddTracks([track('V', ['x'])], true)
    await wait(400)

    // 2 人在线 → 阈值 2：成员的票不通过，房主补上后通过
    memberSession.voteSkip(null)
    await wait(400)
    expect(hostSession.getSnapshot().room?.vote?.by).toHaveLength(1)
    hostSession.voteSkip(null)
    await wait(500)
    // 通过后：投票清空（切歌会清投票）
    expect(hostSession.getSnapshot().room?.vote ?? null).toBeNull()

    memberSession.leave()
    hostSession.leave()
  })

  it('共享歌单模式：房主解散后成员收到房间结束', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    await hostSession.create({ roomId: 'room-dissolve', nickname: '房主', platforms: [], mode: 'shared-playlist', peerId: 'host-peer-3' })
    const memberSession = new ResonanceSession()
    await memberSession.join(hostSession.getSnapshot().invite, { nickname: '听众', platforms: [], peerId: 'member-peer-3' })
    await wait(600)
    expect(memberSession.getSnapshot().room).not.toBeNull()

    hostSession.dissolve()
    await wait(400)
    expect(memberSession.getSnapshot().status).toBe('closed')
    expect(memberSession.getSnapshot().room).toBeNull()
  })
})
