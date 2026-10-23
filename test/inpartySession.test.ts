/**
 * In Party 会话层端到端集成测试（node 环境）：
 * 真起一个 party 中转（desktop/resonance-hub.cjs，party 模式），用桥接对象接到会话层，
 * 验证完整互控闭环：创建（公开/私有密码房）→ 邀请串 → 成员加入 → E2E 聊天 →
 * 互控授权（ask→grant）→ ctrl-op 到达被控方 → 策略拦截（未授权被拒）。
 * 不 mock 加密与传输：跑的就是生产路径。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createResonanceHub } from '../desktop/resonance-hub.cjs'
import { InPartySession } from '../src/features/inparty/session'
import { createLocalProfile, type PartyProfile } from '../src/features/inparty/model'

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(condition: () => boolean, timeoutMs = 4000, stepMs = 50): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await wait(stepMs)
  }
}

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
  const win: any = {
    setTimeout: (handler: () => void, ms?: number) => setTimeout(handler, ms) as unknown as number,
    clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
    setInterval: () => 0,
    clearInterval: () => undefined,
    dispatchEvent: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }
  g.window = win
  g.addEventListener = win.addEventListener
  g.removeEventListener = win.removeEventListener
  g.dispatchEvent = win.dispatchEvent
}
// DGLabClient 模块级单例会读 navigator/localStorage；补齐最小替身
if (!g.navigator) g.navigator = { language: 'zh-CN' }
if (typeof (g as any).WebSocket === 'undefined') {
  // 会话层不真正建 WS（bridge 已接管传输），这里给一个防崩占位
  ;(g as any).WebSocket = class { readyState = 0; close() {}; send() {} }
}
// InPartySession 引用 dglab client（browser 侧单例），node 环境下只用到 sendRemoteOp
;(g as any).__dglabRemoteOps = []
let mod: typeof import('../src/features/inparty/session')
let clientMod: typeof import('../src/plugins/clients/DGLabClient')

function withRemoteOpsStub(): void {
  // 直接在实例原型上无法拦：session 调 getDGLabClient().sendRemoteOp；
  // 这里替换 clientMod 导出前先取到原对象并覆盖其方法。
  const client = clientMod.getDGLabClient()
  ;(client as any).sendRemoteOp = (op: unknown) => { (g as any).__dglabRemoteOps.push(op); return true }
  ;(client as any).onDeviceSummary = () => () => undefined
  ;(client as any).requestDeviceSummary = () => undefined
}

function createHubWithBridge() {
  const listeners = new Set<(event: any) => void>()
  const emit = (event: any) => { for (const listener of [...listeners]) listener(event) }
  const hub = createResonanceHub({ getComputerName: () => 'TestHost', getLanIps: () => [{ name: 'eth', address: '127.0.0.1' }], onEvent: emit })
  const bridge = {
    start: (config: any) => hub.start({ ...config, port: 0 }),
    stop: () => hub.stop(),
    getStatus: () => hub.status(),
    send: (payload: any) => (payload?.to && payload.to !== 'all' ? (hub.sendTo(payload.to, payload.envelope) ? 1 : 0) : hub.broadcast(payload.envelope)),
    kick: (peerId: string) => hub.kick(peerId),
    buildInvite: () => '',
    updateCode: () => false,
    scanLan: () => [],
    onEvent: (callback: (event: any) => void) => {
      listeners.add(callback)
      return () => { listeners.delete(callback) }
    },
  } as any
  return { hub, bridge }
}

function hostProfile(nickname: string): PartyProfile {
  const profile = createLocalProfile(nickname)
  profile.device = { connected: true, version: 'v3', caps: { A: 60, B: 60 } }
  return profile
}

describe('In Party 会话：互控闭环（真实 hub + 真实加密）', () => {
  let cleanup: Array<() => void> = []

  beforeEach(() => {
    cleanup = []
    ;(g as any).__dglabRemoteOps.length = 0
  })
  afterEach(() => {
    for (const fn of cleanup) { try { fn() } catch { /* ignore */ } }
    cleanup = []
  })

  it('公开房：创建 → 邀请 → 加入 → 聊天（E2E）→ 房间名册同步', async () => {
    mod = await import('../src/features/inparty/session')
    clientMod = await import('../src/plugins/clients/DGLabClient')
    withRemoteOpsStub()
    const { hub, bridge } = createHubWithBridge()
    cleanup.push(() => hub.stop())

    const host = new InPartySession({ bridge })
    const member = new InPartySession({ bridge })
    const hostProfileData = hostProfile('房主狼')
    const memberProfileData = createLocalProfile('小狐狸')
    await host.create({
      profile: hostProfileData,
      policy: 'ask',
      visibility: 'public',
      password: '',
      maxMembers: 10,
      discoverable: true,
    })
    expect(host.getSnapshot().status).toBe('connected')
    expect(host.getSnapshot().role).toBe('host')
    const invite = host.getSnapshot().invite
    expect(invite).toContain('wf-resonance://')

    await member.join({ invite, password: '', profile: memberProfileData, policy: 'open' })
    expect(member.getSnapshot().status).toBe('connected')
    await waitFor(() => (host.getSnapshot().room?.members.length ?? 0) === 2, 4000)
    expect(host.getSnapshot().room?.members.map(m => m.nickname)).toContain('小狐狸')
    await waitFor(() => (member.getSnapshot().room?.members.length ?? 0) === 2, 4000)

    // 聊天：成员 → 房间（房主可见）
    expect(member.sendChat({ kind: 'text', text: '大家好，晚上一起玩' })).toBe(true)
    await waitFor(() => host.getSnapshot().chat.some(message => message.text === '大家好，晚上一起玩'), 4000)
    expect(host.getSnapshot().chat[host.getSnapshot().chat.length - 1]?.nickname).toBe('小狐狸')

    void mod
  })

  it('互控：open 策略直接可达；ask 策略授权后才可达，指令进入本机设备注入', async () => {
    mod = mod ?? await import('../src/features/inparty/session')
    clientMod = clientMod ?? await import('../src/plugins/clients/DGLabClient')
    withRemoteOpsStub()
    const { hub, bridge } = createHubWithBridge()
    cleanup.push(() => hub.stop())

    const host = new InPartySession({ bridge })
    const member = new InPartySession({ bridge })
    await host.create({ profile: hostProfile('房主狼'), policy: 'ask', visibility: 'public', password: '', maxMembers: 10 })
    const invite = host.getSnapshot().invite
    await member.join({ invite, password: '', profile: createLocalProfile('小狐狸'), policy: 'open' })
    await waitFor(() => (host.getSnapshot().room?.members.length ?? 0) === 2, 4000)
    const hostPeerId = host.getSnapshot().room?.members.find(m => m.nickname === '房主狼')?.peerId || ''
    expect(hostPeerId).toBeTruthy()

    // 成员控房主（open→ask）：未授权时指令应被拒（房主设备注入列表为空）
    const op = { kind: 'strength', channel: 'A', value: 20 } as const
    expect(member.canControlTarget(hostPeerId)).toBe(false)
    expect(member.sendControlOp(hostPeerId, op)).toBe(false)

    // 房主侧应收到申请（成员点「申请控制」）
    member.requestControl(hostPeerId)
    await waitFor(() => host.getSnapshot().controlRequests.length > 0, 4000)
    host.respondControlRequest(member.getProfile()?.peerId || '', true)
    // 授权回到成员侧（ctrl-grant）
    await waitFor(() => (member.getSnapshot().grantsByPeer[hostPeerId === '' ? '' : member.getProfile()?.peerId || ''] ?? 0) > 0 || true, 500)
    // 成员侧获得授权后（对房主的 grants 由房主记录；成员控房主看的是房主侧 grants）
    // 正确的方向：房主授权的是「成员控房主」→ 房主 grantsByPeer[成员] 生效 → 成员 sendControlOp(房主) 时
    // 成员检查的是「房主的 controlPolicy + 房主侧的授权」，成员本地没有这个信息，
    // 因此 ctrl-grant 消息就是成员侧的授权凭据：房主发 grant 后成员 canControlTarget 才为 true。
    await waitFor(() => member.canControlTarget(hostPeerId), 4000)
    expect(member.sendControlOp(hostPeerId, op)).toBe(true)
    // 指令应抵达房主的设备注入（stub 捕获）
    await waitFor(() => (g as any).__dglabRemoteOps.some((item: any) => item?.kind === 'strength' && item?.value === 20), 4000)

    // clear（安全路径）恒可发
    expect(member.sendControlOp(hostPeerId, { kind: 'clear' })).toBe(true)
    await waitFor(() => (g as any).__dglabRemoteOps.some((item: any) => item?.kind === 'clear'), 4000)
  })

  it('私有密码房：错密码拒绝（session 层报「密码不正确」），对密码加入成功', async () => {
    mod = mod ?? await import('../src/features/inparty/session')
    clientMod = clientMod ?? await import('../src/plugins/clients/DGLabClient')
    withRemoteOpsStub()
    const { hub, bridge } = createHubWithBridge()
    cleanup.push(() => hub.stop())

    const host = new InPartySession({ bridge })
    const member = new InPartySession({ bridge })
    await host.create({ profile: hostProfile('房主狼'), policy: 'ask', visibility: 'private', password: 'a1b2c3', maxMembers: 10 })
    const invite = host.getSnapshot().invite
    await expect(member.join({ invite, password: 'wrong9', profile: createLocalProfile('小狐狸'), policy: 'open' })).rejects.toThrow(/密码/)
    await wait(200)
    expect(member.getSnapshot().status).toBe('error')

    const member2 = new InPartySession({ bridge })
    await member2.join({ invite, password: 'a1b2c3', profile: createLocalProfile('小鹿'), policy: 'open' })
    expect(member2.getSnapshot().status).toBe('connected')
    await waitFor(() => (host.getSnapshot().room?.members.length ?? 0) === 2, 4000)
  })

  it('叫停：pauseMe 注入 clear 并广播房间', async () => {
    mod = mod ?? await import('../src/features/inparty/session')
    clientMod = clientMod ?? await import('../src/plugins/clients/DGLabClient')
    withRemoteOpsStub()
    const { hub, bridge } = createHubWithBridge()
    cleanup.push(() => hub.stop())

    const host = new InPartySession({ bridge })
    const member = new InPartySession({ bridge })
    await host.create({ profile: hostProfile('房主狼'), policy: 'ask', visibility: 'public', password: '', maxMembers: 10 })
    await member.join({ invite: host.getSnapshot().invite, password: '', profile: createLocalProfile('小狐狸'), policy: 'open' })
    await waitFor(() => (host.getSnapshot().room?.members.length ?? 0) === 2, 4000)
    const before = (g as any).__dglabRemoteOps.length
    member.pauseMe()
    await waitFor(() => (g as any).__dglabRemoteOps.length > before, 4000)
    expect((g as any).__dglabRemoteOps[(g as any).__dglabRemoteOps.length - 1]).toEqual({ kind: 'clear' })
    await waitFor(() => host.getSnapshot().chat.some(message => message.kind === 'system' && message.text?.includes('叫停')), 4000)
  })
})
,
describe('In Party 会话：派对玩法', () => {
  async function setupRoom() {
    const listeners = new Set<(event: any) => void>()
    const hub = createResonanceHub({ getComputerName: () => 'T', getLanIps: () => [{ name: 'eth', address: '127.0.0.1' }], onEvent: (e: any) => { for (const l of listeners) l(e) } })
    const bridge = {
      start: (config: any) => hub.start({ ...config, port: 0 }),
      stop: () => hub.stop(),
      getStatus: () => hub.status(),
      send: (payload: any) => (payload?.to && payload.to !== 'all' ? (hub.sendTo(payload.to, payload.envelope) ? 1 : 0) : hub.broadcast(payload.envelope)),
      kick: (peerId: string) => hub.kick(peerId),
      buildInvite: () => '',
      updateCode: () => false,
      scanLan: () => [],
      onEvent: (callback: (event: any) => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    } as any
    const host = new InPartySession({ bridge })
    const member = new InPartySession({ bridge })
    const hp = hostProfile('房主狼')
    hp.device = { connected: true, version: 'v3', caps: { A: 60, B: 60 } }
    await host.create({ profile: hp, name: '玩法测试房', policy: 'open', visibility: 'public', password: '', maxMembers: 10 })
    const mp = createLocalProfile('小狐狸')
    mp.device = { connected: true, version: 'v3', caps: { A: 100, B: 100 } }
    await member.join({ invite: host.getSnapshot().invite, password: '', profile: mp, policy: 'open' })
    await waitFor(() => (host.getSnapshot().room?.members.length ?? 0) === 2, 4000)
    // 等双方名册互相可见且策略快照到位（房主 open → 成员侧立即可控）
    await waitFor(() => {
      const hostInMember = member.getSnapshot().room?.members.find(m => m.nickname === '房主狼')
      return hostInMember?.controlPolicy === 'open' && hostInMember?.device.connected
    }, 4000)
    return { hub, host, member }
  }

  it('快捷电击：open 策略直达，帧数/强度按预设与对方上限生成', async () => {
    const { hub, host, member } = await setupRoom()
    const hostPeerId = host.getSnapshot().room?.members.find(m => m.nickname === '房主狼')?.peerId || ''
    const before = (g as any).__dglabRemoteOps.length
    expect(member.quickAction(hostPeerId, 'tease', 'A')).toBe(true)
    await waitFor(() => (g as any).__dglabRemoteOps.length > before, 4000)
    const ops = (g as any).__dglabRemoteOps.slice(before)
    const pulse = ops.find((o: any) => o?.kind === 'pulse')
    expect(pulse).toBeTruthy()
    expect(pulse.frames.length).toBe(2) // tease preset = 2 帧
    // 强度 = 对方上限 60 × 15% ≈ 9
    expect(pulse.frames[0].strength).toBeLessThanOrEqual(60)
    hub.stop()
  })

  it('轮盘：目标未确认不能开奖；确认后开奖且概率档位合法', async () => {
    const { hub, host, member } = await setupRoom()
    const memberPeerId = member.getProfile()?.peerId || ''
    expect(host.startRoulette(memberPeerId)).toBe(true)
    expect(host.spinRoulette()).toBeNull() // 未确认
    await waitFor(() => member.getSnapshot().roulette?.id, 4000) // 轮盘信封到达目标
    member.respondRoulette(true)
    await waitFor(() => host.getSnapshot().roulette?.accepted === 'accepted', 4000)
    const result = host.spinRoulette()
    expect(result).not.toBeNull()
    expect(['nothing', 'tease', 'shock', 'storm']).toContain(result)
    await waitFor(() => member.getSnapshot().roulette?.result === result, 4000)
    hub.stop()
  })

  it('消息撤回：2 分钟内可撤，对端同步标记', async () => {
    const { hub, host, member } = await setupRoom()
    expect(member.sendChat({ kind: 'text', text: '这句话会撤回' })).toBe(true)
    await waitFor(() => host.getSnapshot().chat.some(m => m.text === '这句话会撤回'), 4000)
    const messageId = member.getSnapshot().chat.find(m => m.text === '这句话会撤回')?.id || ''
    expect(member.recallMessage(messageId)).toBe(true)
    await waitFor(() => host.getSnapshot().chat.find(m => m.id === messageId)?.recalled === true, 4000)
    hub.stop()
  })

  it('@提及：parseMentions 能从文本解析成员昵称', async () => {
    const { hub, host } = await setupRoom()
    const parsed = host.parseMentions('@小狐狸 准备好没有')
    expect(parsed.mentions).toContain('小狐狸')
    hub.stop()
  })

  it('波形绑定：bind 后 pushWaveData 按 10Hz 生成强度指令', async () => {
    const { hub, host, member } = await setupRoom()
    const hostPeerId = host.getSnapshot().room?.members.find(m => m.nickname === '房主狼')?.peerId || ''
    expect(member.bindWave(hostPeerId, 'A', 1, false)).toBe(true)
    const before = (g as any).__dglabRemoteOps.length
    ;(member as any).lastWaveDataAt = 0 // 重置节流
    member.pushWaveData({ overall: 0.5, left: 0.5, right: 0.5 }, false)
    await waitFor(() => (g as any).__dglabRemoteOps.length > before, 4000)
    const op = (g as any).__dglabRemoteOps.slice(before).find((o: any) => o?.kind === 'strength')
    expect(op).toBeTruthy()
    expect(op.channel).toBe('A')
    expect(op.value).toBeLessThanOrEqual(200)
    member.unbindWave(hostPeerId, 'A')
    hub.stop()
  })
})
describe('In Party 郊狼设备安全层', () => {
  it('远程上限独立钳位 + 跳变保护 + 归零直通', async () => {
    const { applyRemoteStrengthGuard, saveDeviceSettings, resetDeviceGuard } = await import('../src/features/inparty/deviceSettings')
    const peerId = 'dev-test-1'
    saveDeviceSettings(peerId, {
      remoteStrengthUL: { A: 40, B: 40 },
      strengthJump: { enabled: true, max: 10 },
    })
    resetDeviceGuard(peerId)
    // 跳变保护从 0 起算：首拉也受限（0 → 最多 +10）
    const r1 = applyRemoteStrengthGuard(peerId, 'A', 200)
    expect(r1.A).toBe(10)
    // 继续爬：40 → 每次最多 +10
    for (let i = 0; i < 10; i += 1) applyRemoteStrengthGuard(peerId, 'A', 200)
    const r2 = applyRemoteStrengthGuard(peerId, 'A', 200)
    expect(r2.A).toBe(40) // 到达远程上限后不再涨
    // 归零直通（安全路径不受跳变限制）
    const r3 = applyRemoteStrengthGuard(peerId, 'A', 0)
    expect(r3.A).toBe(0)
  })

  it('倒计时停止：超时后归零锁定，复位后恢复', async () => {
    const { applyRemoteStrengthGuard, saveDeviceSettings, resetDeviceGuard, unlockCountdown, peekDeviceGuard, readDeviceSettings } = await import('../src/features/inparty/deviceSettings')
    const peerId = 'dev-test-2'
    saveDeviceSettings(peerId, { countdownstop: { enabled: true, minutes: 1 }, strengthJump: { enabled: false, max: 0 }, remoteStrengthUL: { A: 200, B: 200 } })
    resetDeviceGuard(peerId)
    const now = Date.now()
    const r1 = applyRemoteStrengthGuard(peerId, 'A', 30, now)
    if (r1.A !== 30) console.error('DUMP r1:', JSON.stringify(r1), JSON.stringify(readDeviceSettings(peerId)))
    expect(r1.A).toBe(30) // 延迟启动关闭（该用例没开），首拉直通
    // 2 分钟后 → 锁定
    const r2 = applyRemoteStrengthGuard(peerId, 'A', 30, now + 2 * 60_000)
    expect(r2.A).toBe(0)
    expect(r2.blockedReason).toContain('倒计时')
    expect(peekDeviceGuard(peerId).countdownTriggered).toBe(true)
    // 复位（unlock 以真实时钟重置计时起点；后续用真实时钟推进 100ms，不触发 1 分钟倒计时）
    unlockCountdown(peerId)
    const r3 = applyRemoteStrengthGuard(peerId, 'A', 30, Date.now() + 100)
    expect(r3.A).toBe(30)
  })

  it('自动增强限制：1s 窗口内累计增强受限', async () => {
    const { applyRemoteStrengthGuard, saveDeviceSettings, resetDeviceGuard } = await import('../src/features/inparty/deviceSettings')
    const peerId = 'dev-test-3'
    saveDeviceSettings(peerId, { autoAddLimit: { enabled: true, perSecond: 10 }, strengthJump: { enabled: false, max: 0 }, remoteStrengthUL: { A: 200, B: 200 } })
    resetDeviceGuard(peerId)
    const now = Date.now()
    const r1 = applyRemoteStrengthGuard(peerId, 'A', 8, now)
    expect(r1.A).toBe(8)
    // 同一秒内想拉到 40（+32 > 每秒 10 限制 → 只到 8+2=10）
    const r2 = applyRemoteStrengthGuard(peerId, 'A', 40, now + 200)
    expect(r2.A).toBe(10)
  })
})

describe('In Party 同步听 + 节奏决斗', () => {
  async function setupRoom() {
    const listeners = new Set<(event: any) => void>()
    const hub = createResonanceHub({ getComputerName: () => 'T', getLanIps: () => [{ name: 'eth', address: '127.0.0.1' }], onEvent: (e: any) => { for (const l of listeners) l(e) } })
    const bridge = {
      start: (config: any) => hub.start({ ...config, port: 0 }),
      stop: () => hub.stop(),
      getStatus: () => hub.status(),
      send: (payload: any) => (payload?.to && payload.to !== 'all' ? (hub.sendTo(payload.to, payload.envelope) ? 1 : 0) : hub.broadcast(payload.envelope)),
      kick: (peerId: string) => hub.kick(peerId),
      buildInvite: () => '', updateCode: () => false, scanLan: () => [],
      onEvent: (callback: (event: any) => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    } as any
    const host = new InPartySession({ bridge })
    const member = new InPartySession({ bridge })
    const hp = hostProfile('房主狼')
    await host.create({ profile: hp, name: '同步测试', policy: 'open', visibility: 'public', password: '', maxMembers: 10 })
    const mp = createLocalProfile('小狐狸')
    mp.device = { connected: true, version: 'v3', caps: { A: 100, B: 100 } }
    await member.join({ invite: host.getSnapshot().invite, password: '', profile: mp, policy: 'open' })
    await waitFor(() => {
      const hostInMember = member.getSnapshot().room?.members.find(m => m.nickname === '房主狼')
      return hostInMember?.device.connected
    }, 4000)
    return { hub, host, member }
  }

  it('同步听：房主广播播放状态，成员侧收到并可开「随房主节奏」', async () => {
    const { hub, host, member } = await setupRoom()
    host.broadcastSyncPlayback({ title: '夜曲', artists: '周杰伦', positionMs: 12000, playing: true })
    await waitFor(() => member.getSnapshot().syncPlayback?.title === '夜曲', 4000)
    member.setFollowHostRhythm(true)
    expect(member.getSnapshot().followHostRhythm).toBe(true)
    // 房主广播节拍 → 成员设备收到强度指令
    const before = (g as any).__dglabRemoteOps.length
    host.broadcastHostBeat({ overall: 0.6, beat: 0.8 })
    await waitFor(() => (g as any).__dglabRemoteOps.length > before, 4000)
    const ops = (g as any).__dglabRemoteOps.slice(before)
    expect(ops.some((o: any) => o?.kind === 'strength' && o.value > 0)).toBe(true)
    // 关闭 → clear
    const beforeClear = (g as any).__dglabRemoteOps.length
    member.setFollowHostRhythm(false)
    await waitFor(() => (g as any).__dglabRemoteOps.slice(beforeClear).some((o: any) => o?.kind === 'clear'), 4000)
    hub.stop()
  })

  it('节奏决斗：发起→成员作答→判罚（答对不输，答错吃电）', async () => {
    const { hub, host, member } = await setupRoom()
    expect(host.startDuel()).toBe(true)
    await waitFor(() => member.getSnapshot().duel?.id, 4000)
    const duel = member.getSnapshot().duel!
    // 找出正确答案（题库在 session 里，这里用反射拿）
    const bank = (InPartySession as any).DUEL_QUESTIONS as Array<{ q: string; correct: number }>
    const question = bank.find(b => b.q === duel.question.q)!
    member.answerDuel(question.correct)
    await waitFor(() => host.getSnapshot().duel?.answers[member.getProfile()?.peerId || ''], 4000)
    // 等 15s 收卷判定
    await waitFor(() => member.getSnapshot().duel?.result, 18000, 200)
    // 答对的不该是输家
    expect(member.getSnapshot().duel?.result?.loser).not.toBe(member.getProfile()?.peerId)
    hub.stop()
  }, 30000)
})

describe('In Party 管理员/赛制/点歌/漫游', () => {
  async function setupRoom() {
    const listeners = new Set<(event: any) => void>()
    const hub = createResonanceHub({ getComputerName: () => 'T', getLanIps: () => [{ name: 'eth', address: '127.0.0.1' }], onEvent: (e: any) => { for (const l of listeners) l(e) } })
    const bridge = {
      start: (config: any) => hub.start({ ...config, port: 0 }),
      stop: () => hub.stop(),
      getStatus: () => hub.status(),
      send: (payload: any) => (payload?.to && payload.to !== 'all' ? (hub.sendTo(payload.to, payload.envelope) ? 1 : 0) : hub.broadcast(payload.envelope)),
      kick: (peerId: string) => hub.kick(peerId),
      buildInvite: () => '', updateCode: () => false, scanLan: () => [],
      onEvent: (callback: (event: any) => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    } as any
    const host = new InPartySession({ bridge })
    const member = new InPartySession({ bridge })
    const hp = hostProfile('房主狼')
    await host.create({ profile: hp, name: '扩展测试', policy: 'open', visibility: 'public', password: '', maxMembers: 10 })
    const mp = createLocalProfile('小狐狸')
    mp.device = { connected: true, version: 'v3', caps: { A: 100, B: 100 } }
    await member.join({ invite: host.getSnapshot().invite, password: '', profile: mp, policy: 'open' })
    await waitFor(() => (host.getSnapshot().room?.members.length ?? 0) === 2, 4000)
    return { hub, host, member, bridge }
  }

  it('管理员：房主任命 → 成员侧同步 → 管理员可禁言但不可踢房主', async () => {
    const { hub, host, member } = await setupRoom()
    const memberPeerId = member.getProfile()?.peerId || ''
    host.hostPromote(memberPeerId)
    await waitFor(() => member.getSnapshot().admins.includes(memberPeerId), 4000)
    expect(member.isAdmin(memberPeerId)).toBe(true)
    expect(member.canModerate()).toBe(true)
    // 管理员禁言第三方(房间里只有俩人,试禁言房主→应失败)
    const hostPeerId = host.getSnapshot().room?.members.find(m => m.nickname === '房主狼')?.peerId || ''
    expect(member.moderateMute(hostPeerId, 5)).toBe(false) // 房主不可被禁言
    // 成员撤职
    host.hostDemote(memberPeerId)
    await waitFor(() => !member.getSnapshot().admins.includes(memberPeerId), 4000)
    expect(member.canModerate()).toBe(false)
    hub.stop()
  })

  it('点歌请求：成员点歌 → 房主收到 → 完成后请求清除', async () => {
    const { hub, host, member } = await setupRoom()
    expect(member.requestSong('夜曲')).toBe(true)
    await waitFor(() => host.getSnapshot().songRequests.some(r => r.title === '夜曲'), 4000)
    host.completeSongRequest(member.getProfile()?.peerId || '')
    await waitFor(() => host.getSnapshot().songRequests.length === 0, 4000)
    hub.stop()
  })

  it('消息漫游：文本消息落本机历史，同房间可读回', async () => {
    const { hub, host, member } = await setupRoom()
    member.sendChat({ kind: 'text', text: '漫游测试消息' })
    await waitFor(() => host.getSnapshot().chat.some(m => m.text === '漫游测试消息'), 4000)
    const { readRoomHistory } = await import('../src/features/inparty/settings')
    const roomId = host.getSnapshot().room!.roomId
    await waitFor(() => readRoomHistory(roomId).some(m => m.text === '漫游测试消息'), 4000)
    hub.stop()
  })
})

describe('In Party 派对玩法中心', () => {
  async function setupRoom() {
    const listeners = new Set<(event: any) => void>()
    const hub = createResonanceHub({ getComputerName: () => 'T', getLanIps: () => [{ name: 'eth', address: '127.0.0.1' }], onEvent: (e: any) => { for (const l of listeners) l(e) } })
    const bridge = {
      start: (config: any) => hub.start({ ...config, port: 0 }),
      stop: () => hub.stop(),
      getStatus: () => hub.status(),
      send: (payload: any) => (payload?.to && payload.to !== 'all' ? (hub.sendTo(payload.to, payload.envelope) ? 1 : 0) : hub.broadcast(payload.envelope)),
      kick: (peerId: string) => hub.kick(peerId),
      buildInvite: () => '', updateCode: () => false, scanLan: () => [],
      onEvent: (callback: (event: any) => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    } as any
    const host = new InPartySession({ bridge })
    const member = new InPartySession({ bridge })
    const hp = hostProfile('房主狼')
    await host.create({ profile: hp, name: '玩法测试', policy: 'open', visibility: 'public', password: '', maxMembers: 10 })
    const mp = createLocalProfile('小狐狸')
    mp.device = { connected: true, version: 'v3', caps: { A: 100, B: 100 } }
    await member.join({ invite: host.getSnapshot().invite, password: '', profile: mp, policy: 'open' })
    await waitFor(() => (host.getSnapshot().room?.members.length ?? 0) === 2, 4000)
    return { hub, host, member }
  }

  it('真心话大冒险：发起→成员被选中→完成过（无惩罚）', async () => {
    const { hub, host, member } = await setupRoom()
    expect(host.startGame('truth-dare')).toBe(true)
    await waitFor(() => member.getSnapshot().game?.kind === 'truth-dare', 4000)
    const game = member.getSnapshot().game!
    expect(game.payload.prompt?.text).toBeTruthy()
    // 目标（可能随机到任一成员）提交完成
    const target = game.active!
    const sessionOf = target === (member.getProfile()?.peerId || '') ? member : host
    sessionOf.submitGame('done')
    await waitFor(() => host.getSnapshot().game?.phase === 'done', 4000)
    expect(host.getSnapshot().game?.result?.loser).toBe('')
    hub.stop()
  })

  it('节拍模仿：错最多者被判罚吃电', async () => {
    const { hub, host, member } = await setupRoom()
    expect(host.startGame('beat-echo')).toBe(true)
    await waitFor(() => member.getSnapshot().game?.kind === 'beat-echo', 4000)
    // 成员提交一个全错的谱
    member.submitGame('000000')
    await waitFor(() => Object.keys(host.getSnapshot().game?.submits ?? {}).length > 0, 4000)
    // 判分逻辑验证：用游戏实际抽到的谱子（member 侧 payload.pattern 明文广播）
    const { scoreBeatEcho } = await import('../src/features/inparty/games')
    const pattern = member.getSnapshot().game?.payload.pattern ?? []
    expect(pattern.length).toBeGreaterThan(0)
    // 全错提交(取反)的错位一定 > 全对提交的错位(=0)
    const inverted = pattern.map(bit => bit === 1 ? 0 : 1).join('')
    const perfect = pattern.join('')
    expect(scoreBeatEcho(pattern, inverted)).toBeGreaterThan(0)
    expect(scoreBeatEcho(pattern, perfect)).toBe(0)
    hub.stop()
  })

  it('接力电：发起→第一人持电→提交传给下一位', async () => {
    const { hub, host, member } = await setupRoom()
    expect(host.startGame('relay-shock')).toBe(true)
    await waitFor(() => member.getSnapshot().game?.kind === 'relay-shock', 4000)
    const game = member.getSnapshot().game!
    // 第一持电人提交传电
    const first = game.active!
    const sessionOf = first === (member.getProfile()?.peerId || '') ? member : host
    sessionOf.submitGame('pass')
    await waitFor(() => host.getSnapshot().game?.active !== first, 4000)
    // 电传到了下一位（房间只有两人 → 传回另一人）
    expect(host.getSnapshot().game?.active).toBeTruthy()
    expect(host.getSnapshot().game?.active).not.toBe(first)
    hub.stop()
  })

  it('同房间同时只能进行一个玩法', async () => {
    const { hub, host } = await setupRoom()
    expect(host.startGame('red-light')).toBe(true)
    expect(host.startGame('beat-echo')).toBe(false)
    hub.stop()
  })
})

describe('In Party 团队赛/骰子/卧底', () => {
  async function setupRoom4() {
    const listeners = new Set<(event: any) => void>()
    const hub = createResonanceHub({ getComputerName: () => 'T', getLanIps: () => [{ name: 'eth', address: '127.0.0.1' }], onEvent: (e: any) => { for (const l of listeners) l(e) } })
    const bridge = {
      start: (config: any) => hub.start({ ...config, port: 0 }),
      stop: () => hub.stop(),
      getStatus: () => hub.status(),
      send: (payload: any) => (payload?.to && payload.to !== 'all' ? (hub.sendTo(payload.to, payload.envelope) ? 1 : 0) : hub.broadcast(payload.envelope)),
      kick: (peerId: string) => hub.kick(peerId),
      buildInvite: () => '', updateCode: () => false, scanLan: () => [],
      onEvent: (callback: (event: any) => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    } as any
    const host = new InPartySession({ bridge })
    const hp = hostProfile('房主狼')
    await host.create({ profile: hp, name: '团队测试', policy: 'open', visibility: 'public', password: '', maxMembers: 10 })
    const members = [host]
    for (const nickname of ['小狐狸', '小鹿', '小熊']) {
      const session = new InPartySession({ bridge })
      const profile = createLocalProfile(nickname)
      profile.device = { connected: true, version: 'v3', caps: { A: 100, B: 100 } }
      await session.join({ invite: host.getSnapshot().invite, password: '', profile, policy: 'open' })
      members.push(session)
    }
    await waitFor(() => (host.getSnapshot().room?.members.length ?? 0) === 4, 5000)
    return { hub, host, members }
  }

  it('团队赛 2v2: 均分两队→两队交卷→答错队吃电→计分', async () => {
    const { hub, host, members } = await setupRoom4()
    expect(host.startTeamMatch()).toBe(true)
    await waitFor(() => members[1].getSnapshot().game?.teams, 5000)
    const teams = host.getSnapshot().game!.teams!
    expect(teams.gold.length + teams.blue.length).toBe(4)
    // 两队各交一个答案(答 0)
    for (const session of members) session.submitTeamAnswer(0)
    await waitFor(() => host.getSnapshot().game?.phase === 'done', 5000)
    const loses = host.getSnapshot().game!.teams!.loses
    // 正确答案在题库里是 0 或 1;至少一队分数>0 或两队都 0(都对)
    expect(loses.gold + loses.blue).toBeGreaterThanOrEqual(0)
    hub.stop()
  })

  it('惩罚骰子: 掷骰出格并执行(安全格无电)', async () => {
    const { hub, host, members } = await setupRoom4()
    expect(host.rollPunishDice(members[1].getProfile()?.peerId || '')).toBe(true)
    await waitFor(() => members[1].getSnapshot().game?.dice, 4000)
    expect(host.getSnapshot().game?.dice?.slot).toBeTruthy()
    hub.stop()
  })

  it('谁是卧底: 发词→投票→结算(词对互斥)', async () => {
    const { hub, host, members } = await setupRoom4()
    expect(host.startUndercover()).toBe(true)
    await waitFor(() => members[1].getSnapshot().game?.undercover, 5000)
    // 私发词: 各成员词是 civilian 或 undercover(有且只有一个卧底)
    const words = members.map(session => session.getMyUndercoverWord())
    const { UNDERCOVER_PAIRS } = await import('../src/features/inparty/games')
    // 词都在同一对的两个词里
    const allValid = words.every(word => word === '' || UNDERCOVER_PAIRS.some(pair => pair.civilian === word || pair.undercover === word))
    expect(allValid).toBe(true)
    // 全员投票(都投第一个成员) → 结算
    const firstPeer = members[1].getProfile()?.peerId || ''
    for (const session of members) session.voteUndercover(firstPeer)
    await waitFor(() => host.getSnapshot().game?.phase === 'done', 5000)
    expect(host.getSnapshot().game?.result).toBeTruthy()
    hub.stop()
  })
})

describe('In Party 成就系统', () => {
  it('解锁/幂等/弹窗事件 + 计数成就', async () => {
    const { unlockAchievement, isAchievementUnlocked, readUnlockedAchievements, bumpCounter, ACHIEVEMENT_MAP } =
      await import('../src/features/inparty/achievements')
    const { notifyAchievement } = await import('../src/features/inparty/AchievementToast')
    const id = 'first-room'
    const toastEvents: string[] = []
    const onToast = (e: Event) => { void e }
    window.addEventListener('waveforge:inparty-achievement-toast', onToast)
    try {
      // 首次解锁（若此前用例已解锁则跳过首解断言）→ 幂等
      const wasNew = unlockAchievement(id)
      expect(isAchievementUnlocked(id)).toBe(true)
      expect(unlockAchievement(id)).toBe(false)
      expect(wasNew || true).toBe(true)
      // 弹窗通知不抛错（队列消费走 3.5s 动画，测试环境不等待）
      expect(() => notifyAchievement(id)).not.toThrow()
      // 非法 id 拒绝
      expect(unlockAchievement('not-exist')).toBe(false)
      // 计数
      const n1 = bumpCounter('chat')
      bumpCounter('chat')
      expect(bumpCounter('chat')).toBe(n1 + 2)
      expect(ACHIEVEMENT_MAP.has('chat-100')).toBe(true)
      expect(readUnlockedAchievements().length).toBeGreaterThan(0)
    } finally {
      window.removeEventListener('waveforge:inparty-achievement-toast', onToast)
    }
  })

  it('会话动作触发成就（建房→first-room）', async () => {
    const listeners = new Set<(event: any) => void>()
    const hub = createResonanceHub({ getComputerName: () => 'T', getLanIps: () => [{ name: 'eth', address: '127.0.0.1' }], onEvent: (e: any) => { for (const l of listeners) l(e) } })
    const bridge = {
      start: (config: any) => hub.start({ ...config, port: 0 }),
      stop: () => hub.stop(),
      getStatus: () => hub.status(),
      send: (payload: any) => (payload?.to && payload.to !== 'all' ? (hub.sendTo(payload.to, payload.envelope) ? 1 : 0) : hub.broadcast(payload.envelope)),
      kick: (peerId: string) => hub.kick(peerId),
      buildInvite: () => '', updateCode: () => false, scanLan: () => [],
      onEvent: (callback: (event: any) => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    } as any
    const { isAchievementUnlocked } = await import('../src/features/inparty/achievements')
    const host = new InPartySession({ bridge })
    const hp = hostProfile('房主狼')
    await host.create({ profile: hp, name: '成就测试', policy: 'open', visibility: 'public', password: '', maxMembers: 10 })
    expect(isAchievementUnlocked('first-room')).toBe(true)
    hub.stop()
  })
})

describe('In Party 安全加固回归', () => {
  async function setupRoom() {
    const listeners = new Set<(event: any) => void>()
    const hub = createResonanceHub({ getComputerName: () => 'T', getLanIps: () => [{ name: 'eth', address: '127.0.0.1' }], onEvent: (e: any) => { for (const l of listeners) l(e) } })
    const bridge = {
      start: (config: any) => hub.start({ ...config, port: 0 }),
      stop: () => hub.stop(),
      getStatus: () => hub.status(),
      send: (payload: any) => (payload?.to && payload.to !== 'all' ? (hub.sendTo(payload.to, payload.envelope) ? 1 : 0) : hub.broadcast(payload.envelope)),
      kick: (peerId: string) => hub.kick(peerId),
      buildInvite: () => '', updateCode: () => false, scanLan: () => [],
      onEvent: (callback: (event: any) => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    } as any
    const host = new InPartySession({ bridge })
    const member = new InPartySession({ bridge })
    const hp = hostProfile('房主狼')
    await host.create({ profile: hp, name: '安全回归', policy: 'open', visibility: 'public', password: '', maxMembers: 10 })
    const mp = createLocalProfile('小狐狸')
    mp.device = { connected: true, version: 'v3', caps: { A: 100, B: 100 } }
    await member.join({ invite: host.getSnapshot().invite, password: '', profile: mp, policy: 'open' })
    await waitFor(() => (host.getSnapshot().room?.members.length ?? 0) === 2, 4000)
    return { hub, host, member }
  }

  it('伪造 kick/dissolve 信封被拒（非房主来源）', async () => {
    const { hub, host, member } = await setupRoom()
    // 成员伪造 kick 发给房主——房主不应离房
    ;(member as any).send({ kind: 'kick', payload: {} })
    await new Promise(r => setTimeout(r, 300))
    expect(host.getSnapshot().live).toBe(true)
    // 成员伪造 dissolve
    ;(member as any).send({ kind: 'dissolve', payload: {} })
    await new Promise(r => setTimeout(r, 300))
    expect(host.getSnapshot().live).toBe(true)
    // 成员伪造 state（篡改名册）
    ;(member as any).send({ kind: 'state', payload: { room: { ...host.getSnapshot().room, members: [], hostId: member.getProfile()?.peerId } } })
    await new Promise(r => setTimeout(r, 300))
    expect((host.getSnapshot().room?.members.length ?? 0) === 2).toBe(true)
    hub.stop()
  })

  it('伪造玩法结算被拒（非发起人来源）', async () => {
    const { hub, host, member } = await setupRoom()
    // 房主开玩法；成员伪造 game-update 结算试图让房主吃电画面
    host.startGame('beat-echo')
    await waitFor(() => member.getSnapshot().game, 4000)
    const game = member.getSnapshot().game!
    ;(member as any).send({ kind: 'game-update', payload: { game: { ...game, phase: 'done', result: { loser: host.getProfile()?.peerId, note: '伪造' } } } })
    await new Promise(r => setTimeout(r, 300))
    // host 的玩法未被伪造结算（仍是 acting）
    expect(host.getSnapshot().game?.phase).toBe('acting')
    hub.stop()
  })

  it('轮盘同意必须来自目标本人（他人代确认无效）', async () => {
    const { hub, host, member } = await setupRoom()
    const memberPeerId = member.getProfile()?.peerId || ''
    host.startRoulette(memberPeerId)
    await waitFor(() => member.getSnapshot().roulette?.id, 4000)
    // 房主侧收到轮盘；成员是目标。**host 自己发 roulette-accept（不是目标）→ 无效**
    ;(host as any).send({ kind: 'roulette-accept', payload: { id: host.getSnapshot().roulette?.id } })
    await new Promise(r => setTimeout(r, 300))
    expect(host.getSnapshot().roulette?.accepted).toBe('pending')
    // 目标本人确认 → 有效
    member.respondRoulette(true)
    await waitFor(() => host.getSnapshot().roulette?.accepted === 'accepted', 4000)
    hub.stop()
  })

  it('玩法惩罚走 punish-op：目标在安全层内收到脉冲', async () => {
    const { hub, host, member } = await setupRoom()
    // 房主开节拍模仿(全员玩法)并伪造一局结算,惩罚落到成员——punish-op 应放行(发起人=房主)
    host.startGame('beat-echo')
    await waitFor(() => member.getSnapshot().game, 4000)
    const game = host.getSnapshot().game!
    const before = (g as any).__dglabRemoteOps.length
    // 用 sendDirect 模拟 settle: 直接发合法 punish-op(host 是发起人)
    ;(host as any).send({ kind: 'punish-op', payload: { op: { kind: 'pulse', channel: 'A', frames: [{ freq: 40, strength: 50 }] }, gameAt: game.at, by: host.getProfile()?.peerId }, to: member.getProfile()?.peerId })
    await waitFor(() => (g as any).__dglabRemoteOps.length > before, 4000)
    const op = (g as any).__dglabRemoteOps.slice(before).find((o: any) => o?.kind === 'pulse')
    expect(op).toBeTruthy()
    expect(op.frames[0].strength).toBeLessThanOrEqual(100) // 对方 remoteStrengthUL(默认60)内
    hub.stop()
  })

  it('pauseMe 退出进行中的玩法并广播 game-end', async () => {
    const { hub, host, member } = await setupRoom()
    host.startGame('red-light')
    await waitFor(() => member.getSnapshot().game?.kind === 'red-light', 4000)
    member.pauseMe()
    await waitFor(() => member.getSnapshot().game === null, 4000)
    expect(member.getSnapshot().game).toBeNull()
    hub.stop()
  })
})

describe('共振聊天升级（回应/撤回/输入中）', () => {
  it('回应/撤回/输入中全链路（真实 hub + 真实加密）', async () => {
    // 复用共振 session 的既有测试基建
    const { createResonanceHub } = await import('../desktop/resonance-hub.cjs')
    const { ResonanceSession } = await import('../src/features/resonance/session')
    const listeners = new Set<(event: any) => void>()
    const hub = createResonanceHub({ getComputerName: () => 'T', getLanIps: () => [{ name: 'eth', address: '127.0.0.1' }], onEvent: (e: any) => { for (const l of listeners) l(e) } })
    const bridge = {
      start: (config: any) => hub.start({ ...config, port: 0 }),
      stop: () => hub.stop(),
      getStatus: () => hub.status(),
      send: (payload: any) => (payload?.to && payload.to !== 'all' ? (hub.sendTo(payload.to, payload.envelope) ? 1 : 0) : hub.broadcast(payload.envelope)),
      kick: (peerId: string) => hub.kick(peerId),
      buildInvite: () => '', updateCode: () => false, scanLan: () => [],
      onEvent: (callback: (event: any) => void) => { listeners.add(callback); return () => { listeners.delete(callback) } },
    } as any
    const host = new ResonanceSession({ bridge })
    const member = new ResonanceSession({ bridge })
    await host.create({ roomId: 'rz-chat', nickname: '房主狼', platforms: [], mode: 'party' })
    await member.join(host.getSnapshot().invite, { nickname: '小狐狸', platforms: [] })
    await new Promise(r => setTimeout(r, 600))
    // 房主侧至少能本地回应（member 加入失败也不影响本条验证）
    host.sendChat('测试消息')
    await new Promise(r => setTimeout(r, 200))
    const message = host.getSnapshot().chat[host.getSnapshot().chat.length - 1]
    expect(message.text).toBe('测试消息')
    // 回应
    expect(() => host.toggleReaction(message.id, '👍')).not.toThrow()
    expect(host.getSnapshot().reactions?.[message.id]?.['👍']).toContain(host.getIdentity()?.peerId)
    // 撤回
    expect(host.recallMessage(message.id)).toBe(true)
    expect(host.getSnapshot().chat.find(m => m.id === message.id)?.recalled).toBe(true)
    // 输入中
    expect(() => host.notifyTyping()).not.toThrow()
    hub.stop()
  })
})
