'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const net = require('node:net')
const WebSocket = require('ws')
const { createDGLabRelay, rankInterfaces } = require('../server/dglab-relay.cjs')

const waitFor = async (predicate, timeoutMs = 1500) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('condition timed out')
}

const reservePort = () => new Promise((resolve, reject) => {
  const server = net.createServer()
  server.once('error', reject)
  server.listen(0, '127.0.0.1', () => {
    const port = server.address().port
    server.close(error => error ? reject(error) : resolve(port))
  })
})

test('DG-LAB relay stays stopped until enabled and rejects unauthenticated control clients', async t => {
  const relay = createDGLabRelay()
  const port = await reservePort()
  relay._internal.settings.port = port
  t.after(() => relay.stop())

  assert.equal(relay.getStatus().running, false)
  assert.equal(relay._internal.server, null)

  relay.start()
  await waitFor(() => relay.getStatus().running)

  const unauthenticated = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/dglab/ctrl`)
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    socket.once('error', reject)
  })
  assert.deepEqual(unauthenticated, { code: 4003, reason: 'invalid control token' })

  const authenticated = new WebSocket(`ws://127.0.0.1:${port}/dglab/ctrl?token=${encodeURIComponent(relay._internal.controlToken)}`)
  await new Promise((resolve, reject) => {
    authenticated.once('open', resolve)
    authenticated.once('error', reject)
  })
  authenticated.close()

  relay.stop()
  await waitFor(() => !relay.getStatus().running)
  assert.equal(relay._internal.server, null)
})

test('DG-LAB relay rejects a mismatched V3 target', async t => {
  const relay = createDGLabRelay()
  const port = await reservePort()
  relay._internal.settings.port = port
  t.after(() => relay.stop())
  relay.start()
  await waitFor(() => relay.getStatus().running)

  const close = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/wrong-target`)
    socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    socket.once('error', reject)
  })
  assert.deepEqual(close, { code: 4003, reason: 'targetId mismatch' })
  assert.equal(relay._internal.app.v3, null)
})

test('DG-LAB V4 wraps app-bound RPCs in the official message envelope', async t => {
  const relay = createDGLabRelay()
  const port = await reservePort()
  relay._internal.settings.port = port
  relay._internal.settings.version = 'v4'
  t.after(() => relay.stop())
  relay.start()
  await waitFor(() => relay.getStatus().running)

  const tid = new URL(`http://x${relay.getStatus().urlV4}`).searchParams.get('tid')
  const app = new WebSocket(`ws://127.0.0.1:${port}/dglab/v4?tid=${tid}`)
  // 先挂收帧监听再等 open：hello/devices.get 在握手完成的同一数据块里到达，晚挂会丢
  const frames = []
  app.on('message', raw => frames.push(JSON.parse(raw.toString())))
  await new Promise((resolve, reject) => { app.once('open', resolve); app.once('error', reject) })
  // 模拟 App 上报设备（带官方 message 信封，与真实 App 一致）
  app.send(JSON.stringify({ type: 'message', data: { t: 'ev', ev: 'devices.snapshot', devices: [{ id: 0, slotId: 'SLOT01', name: 'T', type: 'COYOTE_030' }] } }))

  // 触发一次 clear + 强度下发（经渲染端控制通道）
  const ctrl = new WebSocket(`ws://127.0.0.1:${port}/dglab/ctrl?token=${encodeURIComponent(relay._internal.controlToken)}`)
  await new Promise((resolve, reject) => { ctrl.once('open', resolve); ctrl.once('error', reject) })
  ctrl.send(JSON.stringify({ t: 'start' }))
  ctrl.send(JSON.stringify({ t: 'audio', data: { kick: 0.5, bass: 0.5, mid: 0.5, lead: 0.5, hats: 0.5, high: 0.5, overall: 0.5, beat: 0.6, accent: 0.2, flux: 0, left: { bass: 0.5, mid: 0.5, high: 0.5, overall: 0.5 }, right: { bass: 0.5, mid: 0.5, high: 0.5, overall: 0.5 } } }))

  // 连接帧（hello/devices.get 信封）此刻已在；音频驱动的 device.op 等 30fps 引擎节流后到达
  await waitFor(() => frames.some(f => f.type === 'message' && f.data?.t === 'req' && f.data?.m === 'device.op'), 5000).catch(() => {})
  ctrl.close()
  app.close()

  // 信封断言：所有 t:req 业务帧必须包 type=message + clientId；不允许再出现裸 t:req
  const reqFrames = frames.filter(f => f.t === 'req')
  assert.deepEqual(reqFrames, [], 'no bare t:req frames may be sent to the app')
  // devices.get（连接即发）与 device.op（音频驱动）都必须在信封里
  assert.ok(frames.some(f => f.type === 'message' && f.data?.t === 'req' && f.data?.m === 'devices.get'), 'devices.get must be enveloped')
  assert.ok(frames.some(f => f.type === 'message' && f.data?.t === 'req' && f.data?.m === 'device.op'), 'device.op must be enveloped')
  assert.ok(frames.every(f => f.type === 'message' || f.data === undefined || f.data.t !== 'req'), 'no business frame escapes the envelope')
  // hello/client_attached/heartbeat 仍是服务器级帧（无信封）
  assert.ok(frames.some(f => f.type === 'hello'))
  assert.ok(frames.some(f => f.type === 'heartbeat'))
})

test('DG-LAB relay ranks real NICs above virtual ones (case-insensitive)', () => {
  const nets = {
    'VMware Network Adapter VMnet1': [{ address: '192.168.174.1', family: 'IPv4', internal: false }],
    'Tailscale': [{ address: '100.121.183.34', family: 'IPv4', internal: false }],
    'vEthernet (Default Switch)': [{ address: '172.24.96.1', family: 'IPv4', internal: false }],
    'ZeroTier One [8056c2e21c000001]': [{ address: '172.25.10.5', family: 'IPv4', internal: false }],
    'Ethernet': [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
    'WLAN': [{ address: '192.168.88.44', family: 'IPv4', internal: false }],
  }
  const ranked = rankInterfaces(nets)
  // 默认扫码地址 = 无线网卡（用户选之前中继取列表第一个）
  assert.equal(ranked[0].address, '192.168.88.44')
  assert.equal(ranked[0].kind, 'wireless')
  // 实体网卡全部排在虚拟网卡之前
  const firstVirtual = ranked.findIndex(i => i.virtual)
  assert.ok(firstVirtual > 0)
  assert.ok(ranked.slice(0, firstVirtual).every(i => !i.virtual))
  assert.deepEqual(
    ranked.filter(i => i.virtual).map(i => i.address).sort(),
    ['100.121.183.34', '172.24.96.1', '172.25.10.5', '192.168.174.1'],
  )
  // 关键词大小写不敏感
  assert.equal(rankInterfaces({ TAILSCALE: [{ address: '100.64.0.9', family: 'IPv4', internal: false }] })[0].virtual, true)
  assert.equal(rankInterfaces({ vmware: [{ address: '192.168.174.1', family: 'IPv4', internal: false }] })[0].virtual, true)
  assert.equal(rankInterfaces({ ZEROTIER: [{ address: '10.147.17.5', family: 'IPv4', internal: false }] })[0].virtual, true)
  // 链路本地地址不参与，全被过滤时回退 localhost
  assert.equal(rankInterfaces({ Ethernet: [{ address: '169.254.1.1', family: 'IPv4', internal: false }] })[0].address, '127.0.0.1')
})
