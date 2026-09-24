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
import { isQueuePlaceholder } from '../src/features/resonance/model'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

/**
 * 轮询等待某个条件成立（带超时）。
 * 这些用例都是「真实 WebSocket 往返 + 定时器」的集成测试，固定 sleep 在并行跑（CI 上机器吃满）时会偶发失败；
 * 用轮询代替固定等待，既更快也更稳。
 */
async function waitFor(condition: () => boolean, timeoutMs = 4000, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await wait(stepMs)
  }
}

// 会话层用到 window 定时器与 localStorage；node 环境补最小替身
// （定时器不真正跑，心跳由测试手动驱动；joinBehavior 等设置走内存 map）
const g = globalThis as any
const localStore = new Map<string, string>()
if (!g.localStorage) {
  g.localStorage = {
    getItem: (key: string) => (localStore.has(key) ? localStore.get(key)! : null),
    setItem: (key: string, value: string) => { localStore.set(key, String(value)) },
    removeItem: (key: string) => { localStore.delete(key) },
    clear: () => localStore.clear(),
  }
}
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

  it('进度换算使用 ping/pong 估出的时钟偏移（不把本机墙钟差当成进度差）', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    const hostSide = adapterFor([])
    hostSession.setAdapter(hostSide.adapter)
    await hostSession.create({ roomId: 'room-clock', nickname: '房主', platforms: [], mode: 'shared-playlist', peerId: 'host-clock' })
    hostSession.hostAddTracks([track('C', ['x'])], true)
    await wait(200)

    const { adapter } = adapterFor([])
    const memberSession = new ResonanceSession()
    memberSession.setAdapter(adapter)
    await memberSession.join(hostSession.getSnapshot().invite, { nickname: '听众', platforms: [], peerId: 'member-clock' })
    await wait(600)

    // 模拟「本机墙钟比房主快 5 秒」：房主在 7 秒（房主时间轴）前上报了进度 30s。
    // 从本机看，那一刻是 7s 前，但真实经过时间只有 7s − 5s = 2s，所以此刻应播到 32s。
    const playback = {
      trackKey: 'C|x', positionMs: 30_000, playing: true,
      atHostClock: Date.now() - 7_000, term: 1, seq: 99,
    }
    const internals = memberSession as unknown as { snapshot: { clock: { offsetMs: number; rttMs: number } } }
    // offsetMs = 房主时钟 − 本机时钟 = −5000（本机快 5 秒）
    internals.snapshot.clock = { offsetMs: -5_000, rttMs: 0 }
    const corrected = memberSession.projectPosition(playback)
    // 不校准的话会把整段墙钟差当成播放进度（37s），成员端就会被反复纠偏 seek
    internals.snapshot.clock = { offsetMs: 0, rttMs: 0 }
    const uncorrected = memberSession.projectPosition(playback)

    expect(corrected).toBeGreaterThanOrEqual(31_500)
    expect(corrected).toBeLessThan(33_000)
    expect(uncorrected - corrected).toBeGreaterThan(4_500)

    memberSession.leave()
    hostSession.leave()
  })

  it('入房行为 = 等下一首：房主从中间接入时不打断本机，等换歌再跟随', async () => {
    localStorage.setItem('waveforge:resonance-join-behavior', 'next')
    try {
      const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
      let hostTrackKey = ''
      let hostPosition = 0
      hostSession.setAdapter({
        readLocal: () => ({ trackKey: hostTrackKey, positionMs: hostPosition, playing: true }),
        apply: () => {}, setQueue: () => {}, canPlay: async () => ({ playable: true }),
      })
      await hostSession.create({ roomId: 'room-joinb', nickname: '房主', platforms: [], mode: 'shared-playlist', peerId: 'host-joinb' })
      hostSession.hostAddTracks([track('J1', ['x']), track('J2', ['x'])], true)
      await wait(200)
      // 房主已播到 90s（属于「从中间接入」）
      hostTrackKey = hostSession.getSnapshot().queue.items[0].key
      hostPosition = 90_000
      hostSession.pushPlayback(true)
      await wait(200)

      const { adapter, applied } = adapterFor([])
      const memberSession = new ResonanceSession()
      memberSession.setAdapter(adapter)
      await memberSession.join(hostSession.getSnapshot().invite, { nickname: '听众', platforms: [], peerId: 'member-joinb' })
      await wait(900)
      // 房主还在放同一首且已放到中间：成员不应被 apply（不打断他正在听的东西）
      expect(applied.filter(call => call.trackKey === hostSession.getSnapshot().queue.items[0].key)).toHaveLength(0)

      // 房主换歌 → 成员开始跟随
      hostSession.hostNext()
      hostTrackKey = hostSession.getSnapshot().queue.items[1].key
      hostPosition = 0
      hostSession.pushPlayback(true)
      await wait(700)
      expect(applied.length).toBeGreaterThan(0)

      memberSession.leave()
      hostSession.leave()
    } finally {
      localStorage.removeItem('waveforge:resonance-join-behavior')
    }
  })

  it('入房行为 = 等下一首：房主还没起播时，不能错过他的首播', async () => {
    localStorage.setItem('waveforge:resonance-join-behavior', 'next')
    try {
      const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
      let hostTrackKey = ''
      let hostPlaying = false
      hostSession.setAdapter({
        readLocal: () => ({ trackKey: hostTrackKey, positionMs: 0, playing: hostPlaying }),
        apply: () => {}, setQueue: () => {}, canPlay: async () => ({ playable: true }),
      })
      await hostSession.create({ roomId: 'room-joinb2', nickname: '房主', platforms: [], mode: 'shared-playlist', peerId: 'host-joinb2' })
      hostSession.hostAddTracks([track('K1', ['x']), track('K2', ['x'])], true)
      await wait(200)
      // 房主此刻暂停（还没起播）
      hostTrackKey = hostSession.getSnapshot().queue.items[0].key
      hostPlaying = false
      hostSession.pushPlayback(true)
      await wait(200)

      const { adapter, applied } = adapterFor([])
      const memberSession = new ResonanceSession()
      memberSession.setAdapter(adapter)
      await memberSession.join(hostSession.getSnapshot().invite, { nickname: '听众', platforms: [], peerId: 'member-joinb2' })
      await wait(900)

      // 房主真正起播第一首（位置 0）→ 成员必须跟上，不能被「等下一首」吞掉
      hostPlaying = true
      hostSession.pushPlayback(true)
      await wait(700)
      expect(applied.filter(call => call.trackKey === hostSession.getSnapshot().queue.items[0].key).length).toBeGreaterThan(0)

      memberSession.leave()
      hostSession.leave()
    } finally {
      localStorage.removeItem('waveforge:resonance-join-behavior')
    }
  })

  it('房主点「下一首」真的推进房间，而不是被自己的播放状态拽回去', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    // 房主本机始终在放第一首（readLocal 固定返回它）——这正是把 cursor 拽回去的条件
    let hostTrackKey = ''
    hostSession.setAdapter({
      readLocal: () => ({ trackKey: hostTrackKey, positionMs: 1_000, playing: true }),
      apply: () => {}, setQueue: () => {}, canPlay: async () => ({ playable: true }),
    })
    await hostSession.create({ roomId: 'room-next', nickname: '房主', platforms: [], mode: 'shared-playlist', peerId: 'host-next' })
    hostSession.hostAddTracks([track('N1', ['x']), track('N2', ['x']), track('N3', ['x'])], true)
    await wait(200)

    const firstKey = hostSession.getSnapshot().queue.items[0].key
    hostTrackKey = firstKey
    hostSession.pushPlayback(true)
    await wait(200)
    expect(hostSession.getSnapshot().room?.cursor).toBe(0)

    // 房主点「下一首」：cursor 必须前进到 1，并且后续的 pushPlayback 不能把它拉回 0
    hostSession.hostNext()
    await wait(200)
    expect(hostSession.getSnapshot().room?.cursor).toBe(1)

    // 关键回归：房主播放器（readLocal）仍返回旧曲目时，也不该把 cursor 拽回上一首
    hostSession.pushPlayback(true)
    await wait(300)
    expect(hostSession.getSnapshot().room?.cursor).toBe(1)

    hostSession.leave()
  })

  it('房主本机自然切到队列里的下一首时，房间跟着走（不再拖回上一首）', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    let localKey = ''
    let localPosition = 0
    hostSession.setAdapter({
      readLocal: () => ({ trackKey: localKey, positionMs: localPosition, playing: true }),
      apply: () => {}, setQueue: () => {}, canPlay: async () => ({ playable: true }),
    })
    await hostSession.create({ roomId: 'room-natural', nickname: '房主', platforms: [], mode: 'shared-playlist', peerId: 'host-natural' })
    hostSession.hostAddTracks([track('NA', ['x']), track('NB', ['x'])], true)
    await wait(200)

    localKey = hostSession.getSnapshot().queue.items[0].key
    let dragged: any[] = []
    const memberSession = new ResonanceSession()
    memberSession.setAdapter({ readLocal: () => null, apply: (p: any, hard: boolean) => dragged.push({ ...p, hard }), setQueue: () => {}, canPlay: async () => ({ playable: true }) })
    await memberSession.join(hostSession.getSnapshot().invite, { nickname: '听众', platforms: [], peerId: 'member-natural' })
    await wait(700)
    hostSession.pushPlayback(true)
    await wait(300)
    expect(hostSession.getSnapshot().room?.cursor).toBe(0)

    // 房主本机自然放完，切到队列里的第二首（真实场景：App 的 ended → handleNext → 本机换歌）
    localKey = hostSession.getSnapshot().queue.items[1].key
    localPosition = 0
    hostSession.pushPlayback(true)
    await wait(400)
    expect(hostSession.getSnapshot().room?.cursor).toBe(1)

    // 成员应收到第二首的跟随，且**没有**被硬拉回第一首的 0:00
    dragged = []
    hostSession.pushPlayback(true)
    await wait(400)
    const toFirst = dragged.filter(call => call.trackKey === hostSession.getSnapshot().queue.items[0].key)
    expect(toFirst).toHaveLength(0)
    expect(hostSession.getSnapshot().room?.cursor).toBe(1)

    memberSession.leave()
    hostSession.leave()
  })

  it('房主增删队列后，成员的旧分页被作废（不出现幽灵行 / 不永久停摆）', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    hostSession.setAdapter({ readLocal: () => ({ trackKey: '', positionMs: 0, playing: false }), apply: () => {}, setQueue: () => {}, canPlay: async () => ({ playable: true }) })
    // 必须用 shared-playlist：party 模式有 partyQuota（默认 3），60 首只会入队 3 首，
    // 那样 slice(10,20) 是空的，整个用例会「假通过」
    await hostSession.create({ roomId: 'room-mutate', nickname: '房主', platforms: [], mode: 'shared-playlist', peerId: 'host-mutate' })
    const many = Array.from({ length: 60 }, (_, index) => track(`M${index}`, ['x']))
    hostSession.hostAddTracks(many, true)
    await wait(300)

    const memberSession = new ResonanceSession()
    memberSession.setAdapter({ readLocal: () => null, apply: () => {}, setQueue: () => {}, canPlay: async () => ({ playable: true }) })
    await memberSession.join(hostSession.getSnapshot().invite, { nickname: '听众', platforms: [], peerId: 'member-mutate' })
    await wait(700)
    // 成员先拉满一页
    memberSession.loadMoreQueue()
    await wait(600)
    expect(memberSession.getSnapshot().queue.items.some(item => isQueuePlaceholder(item))).toBe(false)

    // 房主移除中段若干首 → 总数变化 → 成员的旧分页必须作废重拉
    const removeKeys = hostSession.getSnapshot().queue.items.slice(10, 20).map(item => item.key)
    for (const key of removeKeys) {
      hostSession.removeFromQueue(key)
      await wait(120)
    }
    await wait(700)

    const view = memberSession.getSnapshot().queue
    const titles = view.items.map(item => item.title)
    // 不出现房里已不存在的曲目（幽灵行）
    const removedTitles = removeKeys.map(key => key.split('|')[0]).map(name => name.replace(/^m/, 'M'))
    for (const gone of removedTitles) expect(titles).not.toContain(gone)
    // 已载入数量不能超过真实总数
    expect(view.offset + view.items.length).toBeLessThanOrEqual(view.total)

    memberSession.leave()
    hostSession.leave()
  })

  it('房主切去听队列之外的歌时，房间状态不被污染（位置不冻结、成员不被反复硬 seek）', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    let localKey = ''
    let localPosition = 0
    hostSession.setAdapter({
      readLocal: () => ({ trackKey: localKey, positionMs: localPosition, playing: true }),
      apply: () => {}, setQueue: () => {}, canPlay: async () => ({ playable: true }),
    })
    await hostSession.create({ roomId: 'room-offqueue', nickname: '房主', platforms: [], mode: 'shared-playlist', peerId: 'host-offq' })
    hostSession.hostAddTracks([track('O1', ['x']), track('O2', ['x'])], true)
    await wait(200)
    localKey = hostSession.getSnapshot().queue.items[0].key
    localPosition = 30_000
    hostSession.pushPlayback(true)
    await wait(200)
    const before = hostSession.getSnapshot().room?.playback
    expect(before?.trackKey).toBe(hostSession.getSnapshot().queue.items[0].key)
    expect(before?.positionMs).toBe(30_000)

    // 房主切去放队列之外的私歌
    localKey = 'private-song|me'
    localPosition = 5_000
    for (let step = 0; step < 3; step += 1) {
      hostSession.pushPlayback(true)
      await wait(120)
    }
    const after = hostSession.getSnapshot().room?.playback
    // 曲目保持房间那一首不变；位置必须仍是 30s，而不是被本机私歌的位置覆盖
    expect(after?.trackKey).toBe(before?.trackKey)
    expect(after?.positionMs).toBe(30_000)

    hostSession.leave()
  })

  it('被授予控制权的成员点「下一首」，由房主推进房间（不是只改自己那份窗口）', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    hostSession.setAdapter({ readLocal: () => ({ trackKey: '', positionMs: 0, playing: true }), apply: () => {}, setQueue: () => {}, canPlay: async () => ({ playable: true }) })
    await hostSession.create({ roomId: 'room-ctl', nickname: '房主', platforms: [], mode: 'shared-playlist', peerId: 'host-ctl' })
    hostSession.hostAddTracks([track('C1', ['x']), track('C2', ['x'])], true)
    await wait(300)

    const memberSession = new ResonanceSession()
    memberSession.setAdapter({ readLocal: () => null, apply: () => {}, setQueue: () => {}, canPlay: async () => ({ playable: true }) })
    await memberSession.join(hostSession.getSnapshot().invite, { nickname: '听众', platforms: [], peerId: 'member-ctl' })
    await wait(700)
    const memberPeerId = hostSession.getSnapshot().room!.members.find(m => m.nickname === '听众')!.peerId

    // 房主授权该成员控制播放
    hostSession.grantControl(memberPeerId)
    await wait(500)
    expect(memberSession.getSnapshot().canControl).toBe(true)

    const cursorBefore = hostSession.getSnapshot().room!.cursor
    memberSession.hostNext()
    // 房间（房主侧权威）必须真的前进
    await waitFor(() => hostSession.getSnapshot().room!.cursor === cursorBefore + 1)
    expect(hostSession.getSnapshot().room!.cursor).toBe(cursorBefore + 1)
    // 成员侧看到的是房主广播回来的同一结果，而不是自己那份被拽回去
    await waitFor(() => memberSession.getSnapshot().room!.cursor === cursorBefore + 1)
    expect(memberSession.getSnapshot().room!.cursor).toBe(cursorBefore + 1)

    memberSession.leave()
    hostSession.leave()
  })

  it('获授权成员暂停/播放，房主接受并转发给其他成员（权威仍唯一）', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    const hostApplied: any[] = []
    hostSession.setAdapter({ readLocal: () => ({ trackKey: '', positionMs: 0, playing: true }), apply: (p, hard) => hostApplied.push({ ...p, hard }), setQueue: () => {}, canPlay: async () => ({ playable: true }) })
    await hostSession.create({ roomId: 'room-ctl2', nickname: '房主', platforms: [], mode: 'shared-playlist', peerId: 'host-ctl2' })
    hostSession.hostAddTracks([track('D1', ['x']), track('D2', ['x'])], true)
    await wait(300)

    const thirdApplied: any[] = []
    const thirdSession = new ResonanceSession()
    thirdSession.setAdapter({ readLocal: () => null, apply: (p, hard) => thirdApplied.push({ ...p, hard }), setQueue: () => {}, canPlay: async () => ({ playable: true }) })
    await thirdSession.join(hostSession.getSnapshot().invite, { nickname: '旁观', platforms: [], peerId: 'third-ctl2' })
    await wait(600)

    const controller = new ResonanceSession()
    // 控制者本机在放房间第一首（所以 pushPlayback 能读到有意义的位置）
    let controllerKey = ''
    controller.setAdapter({ readLocal: () => ({ trackKey: controllerKey, positionMs: 40_000, playing: true }), apply: () => {}, setQueue: () => {}, canPlay: async () => ({ playable: true }) })
    await controller.join(hostSession.getSnapshot().invite, { nickname: '控制者', platforms: [], peerId: 'ctrl-ctl2' })
    await wait(700)
    controllerKey = hostSession.getSnapshot().queue.items[0].key
    const controllerPeerId = hostSession.getSnapshot().room!.members.find(m => m.nickname === '控制者')!.peerId

    hostSession.grantControl(controllerPeerId)
    await wait(500)
    expect(controller.getSnapshot().canControl).toBe(true)

    thirdApplied.length = 0
    hostApplied.length = 0
    controller.pushPlayback(true)
    // 房主接受了控制者的状态并让自己本机跟上
    await waitFor(() => hostApplied.length > 0)
    expect(hostApplied.length).toBeGreaterThan(0)
    // 其他成员也收到了转发（时间戳由房主重新盖章，基准一致）
    await waitFor(() => thirdApplied.length > 0)
    expect(thirdApplied.length).toBeGreaterThan(0)
    // 房间状态里的位置来自控制者上报的 40s
    await waitFor(() => controller.getSnapshot().room!.playback?.positionMs === 40_000)
    expect(controller.getSnapshot().room!.playback!.positionMs).toBe(40_000)

    controller.leave()
    thirdSession.leave()
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

  it('成员伪造昵称发言会被名册纠正（不能冒用房主或他人名义）', async () => {
    // 实机（局域网 + 独立实现客户端）验证时发现的真问题：
    // 聊天昵称原先取自发送方自报的 payload.nickname，任何成员都能冒充房主发言，
    // 房主还会带 keepNickname 把伪造的名字转发给全房间。
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    await hostSession.create({ roomId: 'room-forge', nickname: '房主', platforms: [], mode: 'party', peerId: 'host-forge' })
    const memberSession = new ResonanceSession()
    await memberSession.join(hostSession.getSnapshot().invite, { nickname: '真名', platforms: [], peerId: 'member-forge' })
    await wait(600)
    expect(hostSession.getSnapshot().room!.members.map(m => m.nickname).sort()).toEqual(['房主', '真名'].sort())

    // 只改本地自报身份、不告诉房主（等价于在信封里塞一个假昵称）：sendChat 会带上「房主」
    const internals = memberSession as unknown as { identity: { nickname: string } | null }
    internals.identity = { ...(internals.identity as object), nickname: '房主' } as { nickname: string }
    memberSession.sendChat('我是房主')
    await wait(500)

    // 房主按中转分配的 peerId 查名册（权威昵称），伪造的「房主」必须被纠正成「真名」
    expect(hostSession.getSnapshot().chat.map(m => m.nickname + ':' + m.text)).toEqual(['真名:我是房主'])

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

  it('成员队列分页按全局偏移拼接：房主已播到中部时不会覆盖窗口、不重不漏', async () => {
    const hostSession = new ResonanceSession({ bridge: hubBridge.bridge })
    let hostTrackKey = ''
    hostSession.setAdapter({
      readLocal: () => ({ trackKey: hostTrackKey, positionMs: 0, playing: true }),
      apply: () => {}, setQueue: () => {}, canPlay: async () => ({ playable: true }),
    })
    await hostSession.create({ roomId: 'room-page', nickname: '房主', platforms: [], mode: 'shared-playlist', peerId: 'host-page' })
    const many = Array.from({ length: 60 }, (_, index) => track(`Song ${index}`, ['x']))
    hostSession.hostAddTracks(many, true)
    // 房主推进到第 5 首（下标 5）：窗口的全局起点因此不是 0
    hostTrackKey = hostSession.getSnapshot().queue.items[0].key
    for (let step = 0; step < 6; step += 1) {
      hostSession.hostNext()
      await wait(220)
    }
    await wait(300)
    expect(hostSession.getSnapshot().room?.cursor).toBe(5)

    const memberSession = new ResonanceSession()
    memberSession.setAdapter({ readLocal: () => null, apply: () => {}, setQueue: () => {}, canPlay: async () => ({ playable: true }) })
    await memberSession.join(hostSession.getSnapshot().invite, { nickname: '听众', platforms: [], peerId: 'member-page' })
    await wait(700)

    const first = memberSession.getSnapshot().queue
    // 窗口从房主当前曲目（全局下标 5）开始，偏移必须如实上报，而不是恒为 0
    expect(first.offset).toBe(5)
    expect(first.total).toBe(60)
    expect(first.items[0]?.title).toBe('Song 5')

    // 再往后拉一页：必须接在窗口之后（全局 55 起），不能把窗口整段覆盖掉
    memberSession.loadMoreQueue()
    await wait(600)
    const second = memberSession.getSnapshot().queue
    const titles = second.items.map(item => item.title)
    expect(titles).toContain('Song 5')
    expect(titles).toContain('Song 59')
    expect(new Set(titles).size).toBe(titles.length)

    memberSession.leave()
    hostSession.leave()
  })
})
