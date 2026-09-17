// ── WaveForge 共振：局域网房间中转的安全与协议回归（node:test）──
// 与 test/remote-server-security.test.cjs 同款：直接起真实服务，用真实 WebSocket 断言。
// 关注点：房间码/房间号校验、匿名发现不泄露房间信息、人数上限、星型拓扑（成员不能互发）、
//         房主断开即房间结束、踢人。
const test = require('node:test')
const assert = require('node:assert/strict')
const { WebSocket } = require('ws')
const { createResonanceHub, DEFAULT_MAX_MEMBERS } = require('../desktop/resonance-hub.cjs')

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

/** 起一个房间 + 自动清理所有连接与服务，避免测试进程挂住 */
async function setup(t, startOptions = {}, hubOptions = {}) {
  const hub = createResonanceHub(hubOptions)
  const status = await hub.start({ port: 0, ...startOptions })
  const sockets = []
  t.after(() => {
    for (const socket of sockets) {
      try { socket.terminate() } catch { /* ignore */ }
    }
    hub.stop()
  })
  const connect = (params) => {
    const ws = new WebSocket(`ws://127.0.0.1:${status.port}/ws?${new URLSearchParams(params).toString()}`)
    sockets.push(ws)
    const messages = []
    ws.on('message', (raw) => {
      try { messages.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
    })
    // 服务端拒绝时是「先完成握手，再 close(4001/4002/4003)」：open 后留一个宽限期再判定成功
    const outcome = new Promise((resolve) => {
      let settled = false
      const settle = (value) => { if (!settled) { settled = true; resolve(value) } }
      ws.on('open', () => { setTimeout(() => settle({ ok: true, code: 0 }), 150) })
      ws.on('error', () => settle({ ok: false, code: -1 }))
      ws.on('close', (code) => settle({ ok: false, code }))
    })
    const joined = async () => {
      const result = await outcome
      assert.equal(result.ok, true, `期望成功加入，实际 ${JSON.stringify(result)}`)
      await wait(50)
      return messages.find(message => message.t === 'joined' || message.t === 'host-ready')
    }
    return { ws, messages, outcome, joined }
  }
  return { hub, status, connect }
}

test('共振中转：房间码错误或房间号错误一律拒绝', async (t) => {
  const { hub, connect } = await setup(t, { roomId: 'room-a', code: '111111', maxMembers: 3 }, { getComputerName: () => 'TestHost' })

  assert.deepEqual(await connect({ room: 'room-a', code: '999999', role: 'host' }).outcome, { ok: false, code: 4001 })
  assert.deepEqual(await connect({ room: 'room-b', code: '111111', role: 'host' }).outcome, { ok: false, code: 4001 })

  const host = connect({ room: 'room-a', code: '111111', role: 'host' })
  const ready = await host.joined()
  assert.equal(ready.t, 'host-ready')
  assert.ok(ready.peerId)
  assert.equal(hub.status().memberCount, 0)
})

test('共振中转：匿名发现只返回服务信息，不泄露房间号与房间码', async (t) => {
  const { status } = await setup(t, { roomId: 'room-secret', code: '222222' }, { getComputerName: () => 'TestHost' })

  const response = await fetch(`http://127.0.0.1:${status.port}/discover`)
  const body = await response.json()
  assert.equal(body.service, 'waveforge-resonance')
  assert.equal(body.name, 'TestHost')
  assert.equal(typeof body.memberCount, 'number')
  const text = JSON.stringify(body)
  assert.ok(!text.includes('room-secret'))
  assert.ok(!text.includes('222222'))
})

test('共振中转：人数上限与星型拓扑（成员只能发给房主）', async (t) => {
  const { connect } = await setup(t, { roomId: 'room-cap', code: '333333', maxMembers: 3 })

  const host = connect({ room: 'room-cap', code: '333333', role: 'host' })
  await host.joined()
  const memberA = connect({ room: 'room-cap', code: '333333' })
  const joinedA = await memberA.joined()
  const peerA = joinedA.peerId

  // 成员 → 房主：只有房主收到转发
  memberA.ws.send(JSON.stringify({ t: 'env', env: { roomId: 'room-cap', from: peerA, kind: 'chat', seq: 1, nonce: 'n', cipher: 'c' } }))
  await wait(80)
  const relayed = host.messages.filter(message => message.t === 'env')
  assert.equal(relayed.length, 1)
  assert.equal(relayed[0].from, peerA)

  // 房主 → 全员：成员收到
  host.ws.send(JSON.stringify({ t: 'env', to: 'all', env: { roomId: 'room-cap', from: 'host', kind: 'playback', seq: 2, nonce: 'n', cipher: 'c' } }))
  await wait(80)
  assert.equal(memberA.messages.filter(message => message.t === 'env').length, 1)

  // 房间号不符的信封不转发
  memberA.ws.send(JSON.stringify({ t: 'env', env: { roomId: 'room-other', from: peerA, kind: 'chat', seq: 3, nonce: 'n', cipher: 'c' } }))
  await wait(80)
  assert.equal(host.messages.filter(message => message.t === 'env').length, 1)

  // 人数上限：host + 2 成员 = 3 → 第 4 个被拒
  const memberB = connect({ room: 'room-cap', code: '333333' })
  await memberB.joined()
  assert.deepEqual(await connect({ room: 'room-cap', code: '333333' }).outcome, { ok: false, code: 4003 })
})

test('共振中转：房主断开即房间结束，成员被通知并断开', async (t) => {
  const { hub, connect } = await setup(t, { roomId: 'room-end', code: '444444' })

  const host = connect({ room: 'room-end', code: '444444', role: 'host' })
  await host.joined()
  const member = connect({ room: 'room-end', code: '444444' })
  await member.joined()

  const closed = new Promise(resolve => member.ws.on('close', resolve))
  host.ws.close()
  await closed
  assert.ok(member.messages.some(message => message.t === 'host-left'))
  assert.equal(hub.status().memberCount, 0)
})

test('共振中转：房主可踢人，成员会被断开', async (t) => {
  const { hub, connect } = await setup(t, { roomId: 'room-kick', code: '555555' })

  const host = connect({ room: 'room-kick', code: '555555', role: 'host' })
  await host.joined()
  const member = connect({ room: 'room-kick', code: '555555' })
  const joined = await member.joined()

  const closed = new Promise(resolve => member.ws.on('close', resolve))
  assert.equal(hub.kick(joined.peerId), true)
  await closed
  assert.equal(hub.status().memberCount, 0)
})

test('共振中转：邀请串与房间码生成', async (t) => {
  const { hub, status } = await setup(t, { roomId: 'room-invite', code: '666666' }, { getLanIps: () => [{ name: 'eth', address: '192.168.1.9' }] })

  assert.equal(hub.buildInvite(), `wf-resonance://192.168.1.9:${status.port}/room-invite#666666`)
  assert.equal(hub.updateCode('777777'), true)
  assert.equal(hub.updateCode('abc'), false)
  assert.match(hub.generateRoomCode(), /^\d{6}$/)
})

test('共振中转：默认人数上限为 15', () => {
  assert.equal(DEFAULT_MAX_MEMBERS, 15)
})

test('共振中转：空房间（没人连着）允许被新房顶掉，不需要重启进程', async (t) => {
  const { hub, status, connect } = await setup(t, { roomId: 'room-stale', code: '888888' })

  // 模拟「渲染进程重载」：旧房间还在跑，但已经没有任何连接
  const replacing = await hub.start({ roomId: 'room-fresh', code: '999999', port: status.port })
  assert.equal(replacing.roomId, 'room-fresh')
  assert.equal(hub.status().running, true)

  // 新房可用
  const host = connect({ room: 'room-fresh', code: '999999', role: 'host' })
  await host.joined()
})

test('共振中转：房间里有成员在线时，仍然拒绝被别的房间顶掉', async (t) => {
  const { hub, status, connect } = await setup(t, { roomId: 'room-busy', code: '121212' })

  const host = connect({ room: 'room-busy', code: '121212', role: 'host' })
  await host.joined()
  const member = connect({ room: 'room-busy', code: '121212' })
  await member.joined()

  await assert.rejects(
    () => hub.start({ roomId: 'room-other', code: '343434', port: status.port }),
    /房间已在进行中/,
  )
  assert.equal(hub.status().roomId, 'room-busy')
})

// ── 回归：中继 API 契约与协议错误韧性 ──────────────────────────────────────
// 这两条都是真实修过的 bug，且原有测试都覆盖不到：
//  ① main.cjs 曾调用不存在的 hub.broadcastExcept → 成员间聊天全部抛 TypeError；
//  ② 连接未挂 'error' 监听 → 房间内任一成员发一个超过 maxPayload 的帧就能让
//     Node 把 'error' 抛成 uncaughtException，直接崩掉房主的 Electron 主进程。
// 这里只做「契约 + 韧性」断言，不重复测业务逻辑。

test('共振中转：broadcast 支持排除指定成员，且不再暴露不存在的 broadcastExcept', async (t) => {
  const { hub, status, connect } = await setup(t, { roomId: 'room-bc', code: '111222' })

  // 契约：main.cjs 的 resonance:send 依赖广播的第二个参数做「排除发送者」
  assert.equal(typeof hub.broadcastExcept, 'undefined', '不应存在 broadcastExcept（调用它必然 TypeError）')
  assert.equal(typeof hub.broadcast, 'function')
  assert.equal(typeof hub.sendTo, 'function')

  const host = connect({ room: 'room-bc', code: '111222', role: 'host' })
  await host.joined()
  const a = connect({ room: 'room-bc', code: '111222' })
  const aJoined = await a.joined()
  const b = connect({ room: 'room-bc', code: '111222' })
  await b.joined()
  const c = connect({ room: 'room-bc', code: '111222' })
  await c.joined()

  assert.ok(aJoined.peerId, '成员应拿到分配到的 peerId')
  await wait(150)
  a.messages.length = 0; b.messages.length = 0; c.messages.length = 0

  const envelope = { v: 1, roomId: 'room-bc', from: 'someone', kind: 'chat', seq: 1, nonce: 'n0', data: {} }
  const sent = hub.broadcast(envelope, aJoined.peerId)
  await wait(300)

  const envCount = (messages) => messages.filter(message => message.t === 'env').length
  assert.equal(sent, 2, '三名成员中排除一名，应发出两份')
  assert.equal(envCount(a.messages), 0, '被排除的成员不应收到')
  assert.ok(envCount(b.messages) >= 1, '其他成员应收到')
  assert.ok(envCount(c.messages) >= 1, '其他成员应收到')
  assert.equal(status.port > 0, true)
})

test('共振中转：成员发送超大帧不会崩掉宿主进程（协议错误需被吞掉）', async (t) => {
  const { status, connect } = await setup(t, { roomId: 'room-oversize', code: '444555' })

  // 记录本进程内的 uncaughtException：修复前这里会收到 'Max payload size exceeded'
  const uncaught = []
  const onUncaught = (error) => { uncaught.push(String(error && error.message)) }
  process.on('uncaughtException', onUncaught)
  t.after(() => process.removeListener('uncaughtException', onUncaught))

  const member = connect({ room: 'room-oversize', code: '444555' })
  await member.joined()

  // 超过 MAX_MESSAGE_BYTES(64KB) 的单帧
  member.ws.send('x'.repeat(70 * 1024))
  await wait(700)

  assert.deepEqual(uncaught, [], '协议错误必须被连接级 error 监听吞掉，不能冒泡成 uncaughtException')

  // 服务仍然可用：新成员还能正常进房
  const later = connect({ room: 'room-oversize', code: '444555' })
  await later.joined()
  assert.equal(status.port > 0, true)
})
