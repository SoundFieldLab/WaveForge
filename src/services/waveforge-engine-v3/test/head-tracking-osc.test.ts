import { afterEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import { createSocket, type Socket } from 'node:dgram'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'

const require = createRequire(import.meta.url)
const { parseOscPacket, poseUpdate, createHeadTrackingBridge } =
  require('../../../../scripts/lib/head-tracking-osc.cjs')
const { parseArguments, HELP } = require('../../../../scripts/head-tracking-bridge.cjs')
const disposers: (() => void | Promise<void>)[] = []
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose() })

describe('本机 OSC 头追协议', () => {
  it('读取带零填充地址、大端浮点/整数、可选 double 时间戳', () => {
    const packet = message('/hse/pose', 'ffid', [25.5, -10.25, 3, 1000.25])
    expect(parseOscPacket(packet)).toEqual([{
      address: '/hse/pose', args: [25.5, -10.25, 3, 1000.25], timetag: null,
    }])
    expect(poseUpdate(parseOscPacket(packet)[0])).toEqual({ yaw: 25.5, pitch: -10.25, roll: 3, timestamp: 1000.25 })
    expect(poseUpdate({ address: '/head/pose', args: [270, 4, -270] }))
      .toEqual({ yaw: -90, pitch: 4, roll: 90, timestamp: undefined })
    expect(poseUpdate({ address: '/pitch', args: [91] })).toBeNull()
    expect(poseUpdate({ address: '/unknown', args: [1] })).toBeNull()
  })

  it('bundle 解析 NTP timetag、嵌套继承和原子拒绝畸形元素', () => {
    const time = Date.UTC(2026, 9, 19, 6)
    const packet = bundle([message('/yaw', 'f', [20]), bundle([message('/pitch', 'i', [3])])], time)
    expect(parseOscPacket(packet)).toEqual([
      { address: '/yaw', args: [20], timetag: time },
      { address: '/pitch', args: [3], timetag: time },
    ])
    expect(() => parseOscPacket(bundle([bundle([message('/yaw', 'i', [1])], time - 100)], time))).toThrow()
    const bad = bundle([message('/yaw', 'f', [20]), message('/pitch', 'i', [3])])
    bad.writeInt32BE(1234567, 16)
    expect(() => parseOscPacket(bad)).toThrow()
  })

  it('拒绝超长、截断、非法填充、非有限值、不支持类型及过深嵌套', () => {
    const good = message('/yaw', 'f', [1])
    const padding = Buffer.from(good); padding[7] = 1
    const trailing = Buffer.concat([good, Buffer.alloc(4)])
    const unknownType = message('/yaw', 's', [0])
    let deep = good
    for (let i = 0; i < 6; i++) deep = bundle([deep])
    for (const packet of [Buffer.alloc(8196), good.subarray(0, -1), padding, trailing,
      message('/yaw', 'f', [Infinity]), unknownType, deep]) {
      expect(() => parseOscPacket(packet)).toThrow()
    }
  })

  it('CLI 参数可覆盖端口、路径、频率，帮助完整声明本地协议', () => {
    expect(parseArguments(['--osc-port', '9010', '--ws-port', '8990', '--path', '/head', '--max-hz', '120']))
      .toEqual({ udpPort: 9010, wsPort: 8990, path: '/head', maxHz: 120 })
    expect(parseArguments(['--help'])).toEqual({ help: true })
    expect(HELP).toContain('timestamp')
    expect(HELP).toContain('127.0.0.1')
    expect(() => parseArguments(['--host', '0.0.0.0'])).toThrow()
  })
})

describe('真实本机 UDP → WebSocket 回环', () => {
  it('绑定回环、输出最新完整姿态、分轴合流，关闭后两种端口均可重新绑定', async () => {
    const bridge = await createHeadTrackingBridge({ udpPort: 0, wsPort: 0, maxHz: 60 })
    disposers.push(() => bridge.close())
    expect(bridge.udpAddress.address).toBe('127.0.0.1')
    expect(bridge.wsAddress.address).toBe('127.0.0.1')
    const client = new WebSocket(`ws://127.0.0.1:${bridge.wsAddress.port}/pose`)
    disposers.push(() => { client.terminate() })
    await once(client, 'open')
    const sender = createSocket('udp4')
    disposers.push(() => closeUdp(sender))
    const next = once(client, 'message')
    await send(sender, bundle([
      message('/hse/pose', 'fff', [10, 1, 2]),
      message('/head/pose', 'fffi', [40, 3, -2, 100]),
    ]), bridge.udpAddress.port)
    const output = JSON.parse(String((await next)[0]))
    expect(output).toMatchObject({ yaw: 40, pitch: 3, roll: -2 })
    expect(Number.isFinite(output.timestamp)).toBe(true)

    const component = once(client, 'message')
    await send(sender, bundle([
      message('/yaw', 'f', [-50]), message('/pitch', 'f', [-4]), message('/roll', 'i', [6]),
    ]), bridge.udpAddress.port)
    expect(JSON.parse(String((await component)[0]))).toMatchObject({ yaw: -50, pitch: -4, roll: 6 })
    const udpPort = bridge.udpAddress.port, wsPort = bridge.wsAddress.port
    await bridge.close()
    const udp = createSocket('udp4')
    await new Promise<void>((resolve, reject) => { udp.once('error', reject); udp.bind(udpPort, '127.0.0.1', resolve) })
    await closeUdp(udp)
    const tcp = createServer()
    await new Promise<void>((resolve, reject) => { tcp.once('error', reject); tcp.listen(wsPort, '127.0.0.1', resolve) })
    await new Promise<void>(resolve => tcp.close(() => resolve()))
  })

  it('真实 future timetag 延后交付；输入畸形包和客户端消息不能成为姿态源', async () => {
    const bridge = await createHeadTrackingBridge({ udpPort: 0, wsPort: 0, maxHz: 120 })
    disposers.push(() => bridge.close())
    const client = new WebSocket(`ws://127.0.0.1:${bridge.wsAddress.port}/pose`)
    disposers.push(() => { client.terminate() })
    await once(client, 'open')
    const sender = createSocket('udp4')
    disposers.push(() => closeUdp(sender))
    const received: Record<string, number>[] = []
    client.on('message', data => received.push(JSON.parse(String(data))))
    await send(sender, Buffer.alloc(12), bridge.udpAddress.port)
    await send(sender, bundle([message('/hse/pose', 'fff', [60, 2, 1])], Date.now() + 150), bridge.udpAddress.port)
    await delay(35)
    expect(received).toHaveLength(0)
    const next = once(client, 'message')
    await next
    expect(received[0]).toMatchObject({ yaw: 60, pitch: 2, roll: 1 })
    expect(bridge.statistics.malformed).toBe(1)
    const disconnected = once(client, 'close')
    client.send('{"yaw":99,"pitch":0,"roll":0}')
    expect((await disconnected)[0]).toBe(1008)
  })

  it('同帧高频 OSC 仅发送最新姿态，重复或倒序设备时间不会覆盖新值', async () => {
    const bridge = await createHeadTrackingBridge({ udpPort: 0, wsPort: 0, maxHz: 10 })
    disposers.push(() => bridge.close())
    const client = new WebSocket(`ws://127.0.0.1:${bridge.wsAddress.port}/pose`)
    disposers.push(() => { client.terminate() })
    await once(client, 'open')
    const sender = createSocket('udp4')
    disposers.push(() => closeUdp(sender))
    const received: Record<string, number>[] = []
    client.on('message', data => received.push(JSON.parse(String(data))))
    const next = once(client, 'message')
    await send(sender, bundle([
      message('/hse/pose', 'fffi', [10, 0, 0, 1]),
      message('/hse/pose', 'fffi', [20, 0, 0, 2]),
      message('/hse/pose', 'fffi', [30, 0, 0, 3]),
      message('/hse/pose', 'fffi', [90, 0, 0, 1]),
      message('/hse/pose', 'fffi', [80, 0, 0, 3]),
    ]), bridge.udpAddress.port)
    await next
    await delay(120)
    expect(received).toHaveLength(1)
    expect(received[0].yaw).toBe(30)
    expect(bridge.statistics.dropped).toBe(2)
  })

  it('端口已占用会拒绝启动，并回收已成功绑定的另一监听器', async () => {
    const owner = createSocket('udp4')
    disposers.push(() => closeUdp(owner))
    await new Promise<void>((resolve, reject) => { owner.once('error', reject); owner.bind(0, '127.0.0.1', resolve) })
    const udpPort = (owner.address() as { port: number }).port
    const placeholder = createServer()
    await new Promise<void>((resolve, reject) => { placeholder.once('error', reject); placeholder.listen(0, '127.0.0.1', resolve) })
    const wsPort = (placeholder.address() as { port: number }).port
    await new Promise<void>(resolve => placeholder.close(() => resolve()))
    await expect(createHeadTrackingBridge({ udpPort, wsPort })).rejects.toThrow()
    const rebound = createServer()
    await new Promise<void>((resolve, reject) => { rebound.once('error', reject); rebound.listen(wsPort, '127.0.0.1', resolve) })
    await new Promise<void>(resolve => rebound.close(() => resolve()))
  })

  it('真实 Node 子进程收到 SIGINT 关闭流程后自然退出，CLI 两种端口均已释放', async () => {
    // process.emit exercises the installed signal handler on Windows too, where
    // child.kill('SIGINT') does not deliver a portable POSIX console signal.
    const child = spawn(process.execPath, ['-e',
      "process.argv=['node','bridge','--osc-port','0','--ws-port','0'];require('./scripts/head-tracking-bridge.cjs').main().then(()=>process.emit('SIGINT'))",
    ], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] })
    disposers.push(() => { if (child.exitCode === null) child.kill() })
    let output = '', errors = ''
    child.stdout.on('data', data => { output += String(data) })
    child.stderr.on('data', data => { errors += String(data) })
    const exited = await once(child, 'exit')
    expect(exited[0], errors).toBe(0)
    const ports = /udp:\/\/127\.0\.0\.1:(\d+) -> ws:\/\/127\.0\.0\.1:(\d+)\/pose/.exec(output)
    expect(ports).not.toBeNull()
    const udp = createSocket('udp4')
    await new Promise<void>((resolve, reject) => { udp.once('error', reject); udp.bind(Number(ports![1]), '127.0.0.1', resolve) })
    await closeUdp(udp)
    const tcp = createServer()
    await new Promise<void>((resolve, reject) => { tcp.once('error', reject); tcp.listen(Number(ports![2]), '127.0.0.1', resolve) })
    await new Promise<void>(resolve => tcp.close(() => resolve()))
  })
})

function string(value: string): Buffer {
  const raw = Buffer.from(`${value}\0`, 'ascii')
  const output = Buffer.alloc(Math.ceil(raw.length / 4) * 4); raw.copy(output); return output
}
function message(address: string, types: string, args: number[]): Buffer {
  const parts = [string(address), string(`,${types}`)]
  for (let i = 0; i < types.length; i++) {
    const data = Buffer.alloc(types[i] === 'd' ? 8 : 4)
    if (types[i] === 'f') data.writeFloatBE(args[i])
    else if (types[i] === 'd') data.writeDoubleBE(args[i])
    else data.writeInt32BE(args[i])
    parts.push(data)
  }
  return Buffer.concat(parts)
}
function bundle(elements: Buffer[], unixMs?: number): Buffer {
  const tag = Buffer.alloc(8)
  if (unixMs === undefined) tag.writeUInt32BE(1, 4)
  else {
    const seconds = Math.floor(unixMs / 1000)
    tag.writeUInt32BE(seconds + 2208988800)
    tag.writeUInt32BE(Math.round((unixMs / 1000 - seconds) * 4294967296), 4)
  }
  return Buffer.concat([string('#bundle'), tag, ...elements.flatMap(element => {
    const length = Buffer.alloc(4); length.writeInt32BE(element.length); return [length, element]
  })])
}
async function send(socket: Socket, packet: Buffer, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => socket.send(packet, port, '127.0.0.1', error => error ? reject(error) : resolve()))
}
async function closeUdp(socket: Socket): Promise<void> {
  await new Promise<void>(resolve => { try { socket.close(resolve) } catch { resolve() } })
}
