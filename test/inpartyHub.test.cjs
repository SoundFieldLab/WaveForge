// ── WaveForge In Party：party 模式房间中转回归（node:test）──
// 基于 resonanceHub.test.cjs 的基建：验证 party 专属行为——
// 50 人上限、6 位密码房（公开/私有）、/discover 服务名与 open 标记、星型转发。
const test = require('node:test')
const assert = require('node:assert/strict')
const { WebSocket } = require('ws')
const { createResonanceHub } = require('../desktop/resonance-hub.cjs')

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function setup(t, startOptions = {}) {
  const hub = createResonanceHub({})
  const status = await hub.start({ port: 0, ...startOptions })
  const sockets = []
  t.after(() => {
    for (const socket of sockets) {
      try { socket.terminate() } catch { /* ignore */ }
    }
    hub.stop()
  })
  const connect = (params) => {
    const effective = (params.role === 'host' && !params.hostKey)
      ? { ...params, hostKey: hub.status().hostKey }
      : params
    const ws = new WebSocket(`ws://127.0.0.1:${status.port}/ws?${new URLSearchParams(effective).toString()}`)
    sockets.push(ws)
    const messages = []
    ws.on('message', (raw) => {
      try { messages.push(JSON.parse(raw.toString())) } catch { /* ignore */ }
    })
    const outcome = new Promise((resolve) => {
      let settled = false
      const settle = (value) => { if (!settled) { settled = true; resolve(value) } }
      ws.on('open', () => { setTimeout(() => settle({ ok: true, code: 0 }), 400) })
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

test('In Party：公开房 /discover 返回 inparty 服务名与 open=true', async (t) => {
  const { status } = await setup(t, { roomId: 'party-pub', code: '333333', party: { visibility: 'public' } })
  const res = await fetch(`http://127.0.0.1:${status.port}/discover`)
  assert.equal(res.ok, true)
  const body = await res.json()
  assert.equal(body.service, 'waveforge-inparty')
  assert.equal(body.open, true)
  assert.equal(body.visibility, 'public')
  assert.equal(body.maxMembers, 50)
  // 不泄露房间号与房间码
  const text = JSON.stringify(body)
  assert.ok(!text.includes('party-pub'))
  assert.ok(!text.includes('333333'))
})

test('In Party：私有房无需密码被拒(4005)，密码对则通过，discover 标记 private', async (t) => {
  const { status, connect } = await setup(t, {
    roomId: 'party-priv', code: '444444',
    party: { visibility: 'private', password: 'Abc!23' },
  })
  const res = await fetch(`http://127.0.0.1:${status.port}/discover`)
  const body = await res.json()
  assert.equal(body.visibility, 'private')
  assert.equal(body.open, false)
  // 无密码
  assert.deepEqual(await connect({ room: 'party-priv', code: '444444' }).outcome, { ok: false, code: 4005 })
  // 错密码
  assert.deepEqual(await connect({ room: 'party-priv', code: '444444', password: 'wrong1' }).outcome, { ok: false, code: 4005 })
  // 对密码
  const member = await connect({ room: 'party-priv', code: '444444', password: 'Abc!23' }).joined()
  assert.equal(member.t, 'joined')
})

test('In Party：密码含特殊符号与英文字母（需求样例）', async (t) => {
  const { status, connect } = await setup(t, {
    roomId: 'party-sym', code: '555555',
    party: { visibility: 'private', password: 'p@ss~Word#9' },
  })
  const member = await connect({ room: 'party-sym', code: '555555', password: 'p@ss~Word#9' }).joined()
  assert.equal(member.t, 'joined')
  assert.equal(status.port > 0, true)
})

test('In Party：非法密码在 start 时被拒（长度/字符集校验）', async (t) => {
  const hub = createResonanceHub({})
  t.after(() => hub.stop())
  await assert.rejects(
    () => hub.start({ port: 0, roomId: 'party-bad', code: '666666', party: { visibility: 'private', password: '123' } }),
    /密码|password/i,
  )
  await assert.rejects(
    () => hub.start({ port: 0, roomId: 'party-bad', code: '666666', party: { visibility: 'private', password: 'has space1' } }),
    /密码|password/i,
  )
})

test('In Party：成员发消息 → 房主收到；房主定向回发 → 成员收到（互控链路）', async (t) => {
  const { connect } = await setup(t, { roomId: 'party-relay', code: '777777', party: { visibility: 'public' } })
  const host = connect({ room: 'party-relay', code: '777777', role: 'host' })
  const member = connect({ room: 'party-relay', code: '777777' })
  const [hostReady, memberJoined] = await Promise.all([host.joined(), member.joined()])
  assert.equal(hostReady.t, 'host-ready')
  assert.equal(memberJoined.t, 'joined')
  await wait(80)
  // 成员 → 房主（加密信封：hub 只透传；from 由 hub 按连接的席位重写，客户端伪造无效）
  member.ws.send(JSON.stringify({ t: 'env', env: { v: 1, roomId: 'party-relay', from: 'spoofed-id', kind: 'ctrl', seq: 1, nonce: 'n', cipher: 'c' } }))
  await wait(150)
  const got = host.messages.find(m => m.t === 'env' && m.env && m.env.kind === 'ctrl')
  assert.ok(got, '房主应收到成员的加密信封')
  // from 必须被 hub 重写为席位真实 id（防伪造发送者）
  assert.equal(got.from, memberJoined.peerId)
  assert.notEqual(got.from, 'spoofed-id')
  // 房主 → 定向成员（互控指令下发路径）
  host.ws.send(JSON.stringify({ t: 'env', env: { v: 1, roomId: 'party-relay', from: 'host-1', kind: 'ctrl', seq: 2, nonce: 'n2', cipher: 'c2' }, to: memberJoined.peerId }))
  await wait(150)
  const back = member.messages.find(m => m.t === 'env' && m.env && m.env.kind === 'ctrl')
  assert.ok(back, '成员应收到房主的定向信封')
})

test('In Party：成员数可超过共振的 15 人上限（50 人规模）', async (t) => {
  const { hub, connect } = await setup(t, { roomId: 'party-big', code: '888888', party: { visibility: 'public' } })
  await connect({ room: 'party-big', code: '888888', role: 'host' }).joined()
  // 20 个成员（测试规模控制；50 人上限由 maxMembers 配置保证）。
  // 分批加入：中转对单 IP 有 12 次/10s 的连接限速（防爆破），测试也要尊重它。
  // 串行节奏加入（中转对单 IP 有 12 次/10s 的连接限速，防爆破；测试尊重它：
  // 每个连接 ~450ms，每 6 个歇 3.5s 把窗口内的连接数压在 12 以下）
  let joinedCount = 0
  for (let i = 0; i < 18; i += 1) {
    if (i > 0 && i % 6 === 0) await wait(3500)
    await connect({ room: 'party-big', code: '888888' }).joined().then(() => { joinedCount += 1 }, () => undefined)
  }
  assert.ok(joinedCount >= 16, `成员应可超过共振的 15 人上限，实际成功 ${joinedCount} 个`)
  assert.ok(hub.status().memberCount >= 16)
})

test('In Party：自定义 maxMembers 生效（房主 1 席 + 成员 N-1 席）', async (t) => {
  const { hub, connect } = await setup(t, { roomId: 'party-cap', code: '999999', party: { visibility: 'public' }, maxMembers: 4 })
  await connect({ room: 'party-cap', code: '999999', role: 'host' }).joined()
  await connect({ room: 'party-cap', code: '999999' }).joined()
  await connect({ room: 'party-cap', code: '999999' }).joined()
  // 房主 1 席 + 成员 3 席都占满后，第 4 个成员应被 4003 拒
  await wait(150)
  await connect({ room: 'party-cap', code: '999999' }).joined()
  await wait(150)
  assert.deepEqual(await connect({ room: 'party-cap', code: '999999' }).outcome, { ok: false, code: 4003 })
  assert.equal(hub.status().memberCount, 3)
})
