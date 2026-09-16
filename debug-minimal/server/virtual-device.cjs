/**
 * 虚拟郊狼设备（调试用）：以「手机 DG-Lab App」的身份连入中继。
 *
 * 目的：没有实体设备也能完整观测「音乐 → 特征 → 映射引擎 → 下发帧」的全链路。
 * 它不清算、不模拟体感，只做两件事：
 *   1) 完成官方握手（V3 bind / V4 hello），让中继进入 bound 态、引擎开始输出；
 *   2) 把中继真正下发的每一帧（强度 / 脉冲波形 / clear）解码后记进环形缓冲，
 *      供调试平台拉取——这就是「设备实际收到什么」的真相来源。
 *
 * 注意：这里刻意不改动 server/dglab-relay.cjs。虚拟设备只走公开协议，
 * 因此它验证的正是真实设备会走的同一条路径；中继代码一旦改动，
 * 这里观察到的帧也会立刻反映出来（不会出现「调试桩与真机不一致」）。
 */

const { WebSocket } = require('ws')

const MAX_EVENTS = 4000
const MAX_PULSES = 2000

/** 官方 V3 波形帧：8 字节 = 4×频率 + 4×强度（HEX）。 */
function decodeHexFrame(hex) {
  if (typeof hex !== 'string' || hex.length < 16) return null
  const bytes = []
  for (let i = 0; i < 16; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16))
  if (bytes.some(Number.isNaN)) return null
  return { freq: bytes[0], strength: bytes[4] }
}

/**
 * 解析中继下发的 V3 文本指令。
 * 对齐 server/dglab-relay.cjs 的 sendV3* 实现：
 *   strength-<ch>+<op>+<value> / clear-<ch> / pulse-<ch>:["HEX",...]
 */
function parseV3Message(message) {
  const text = String(message || '')
  if (text.startsWith('strength-')) {
    const parts = text.split('-')[1]?.split('+') ?? []
    const ch = Number(parts[0])
    const op = Number(parts[1])
    const value = Number(parts[2])
    if (![ch, op, value].every(Number.isFinite)) return null
    return { kind: 'strength', channel: ch === 2 ? 'B' : 'A', op, value }
  }
  if (text.startsWith('clear-')) {
    const ch = Number(text.split('-')[1])
    if (!Number.isFinite(ch)) return null
    return { kind: 'clear', channel: ch === 2 ? 'B' : 'A' }
  }
  if (text.startsWith('pulse-')) {
    const body = text.slice('pulse-'.length)
    const sep = body.indexOf(':')
    if (sep < 0) return null
    const channel = body.slice(0, sep).trim().toUpperCase() === 'B' ? 'B' : 'A'
    let frames = []
    try {
      const parsed = JSON.parse(body.slice(sep + 1))
      if (Array.isArray(parsed)) frames = parsed.map(decodeHexFrame).filter(Boolean)
    } catch {
      return null
    }
    return { kind: 'pulse', channel, frames }
  }
  return null
}

function createVirtualDevice({ port, version = 'v3', getClientId, softLimit = { A: 200, B: 200 }, strength = { A: 0, B: 0 }, log = () => {} }) {
  const events = []
  const pulses = []
  let ws = null
  let seq = 0
  let connecting = false
  let connected = false
  let lastError = null
  let heartbeatTimer = null
  let appId = null
  let controllerId = null
  /** 设备当前「实际输出」（脉冲帧会临时拉高，被后续 strength 覆盖）——用于复现真实体感包络。 */
  const effective = { A: 0, B: 0 }
  const counters = { strength: 0, pulse: 0, clear: 0, pulseFrames: 0 }

  const push = (event) => {
    seq += 1
    const record = { seq, at: Date.now(), ...event }
    events.push(record)
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
    if (event.kind === 'pulse' && event.frames?.length) {
      for (const frame of event.frames) {
        pulses.push({ seq, at: record.at, channel: event.channel, ...frame })
      }
      if (pulses.length > MAX_PULSES) pulses.splice(0, pulses.length - MAX_PULSES)
    }
    return record
  }

  const send = (payload) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false
    try {
      ws.send(JSON.stringify(payload))
      return true
    } catch {
      return false
    }
  }

  /** 模拟 App 反馈：强度 + 软上限（中继据此设置 softLimit / deviceStrength）。 */
  const reportStatus = () => {
    // V3 专用：V4 没有这种文本反馈，软上限走 slots.patch、强度由中继自行下发；
    // 在 V4 下发送会被中继记为「未识别帧」，是无意义的噪声。
    if (version !== 'v3') return
    send({
      type: 'msg',
      clientId: appId || '',
      targetId: controllerId || '',
      message: `strength-${strength.A}+${strength.B}+${softLimit.A}+${softLimit.B}`,
    })
    push({ kind: 'device-report', channel: '-', value: strength.A, note: `A=${strength.A} B=${strength.B} limit=${softLimit.A}/${softLimit.B}` })
  }

  const stopHeartbeat = () => {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }
  }

  const startHeartbeat = () => {
    stopHeartbeat()
    // 中继 15s 一次心跳；设备侧按时回包，保证 bound 态不因超时被清。
    heartbeatTimer = setInterval(() => {
      if (version === 'v3') send({ type: 'heartbeat', clientId: appId || '', targetId: controllerId || '' })
      else send({ type: 'heartbeat' })
    }, 5000)
  }

  const connect = () => {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return { ok: true, already: true }
    connecting = true
    lastError = null
    // V3：裸连（中继容忍任意路径，非 ctrl/v4 一律按 V3 App 处理）。
    // V4：必须带 tid=控制端 clientId（否则中继 4000 tid mismatch 拒连）。
    const url = version === 'v4'
      ? `ws://127.0.0.1:${port}/dglab/v4?tid=${encodeURIComponent(getClientId() || '')}`
      : `ws://127.0.0.1:${port}/dglab/v3`
    push({ kind: 'sim', channel: '-', note: `虚拟设备连接中（${version}）→ ${url}` })
    try {
      ws = new WebSocket(url)
    } catch (error) {
      connecting = false
      lastError = String(error?.message || error)
      push({ kind: 'sim', channel: '-', note: `连接失败：${lastError}` })
      return { ok: false, error: lastError }
    }
    ws.on('open', () => {
      connecting = false
      connected = true
      push({ kind: 'sim', channel: '-', note: `虚拟设备已连接（${version}）` })
      // V4 需要先落设备列表，中继才有 slotId 可下发。
      if (version === 'v4') {
        const slotId = 'debug-slot-1'
        send({
          t: 'ev',
          ev: 'devices.snapshot',
          devices: [{ slotId, name: '虚拟郊狼（调试）', type: 'coyote' }],
        })
        send({ t: 'ev', ev: 'slots.patch', slots: [{ slotId, props: { softLimit } }] })
      }
      startHeartbeat()
      // V3：等中继 bind 200 之后再回报强度（否则 targetId 还没配对）。
      // V4：无文本反馈，设备列表 + slots.patch 已在上面发过。
      if (version === 'v4') { /* softLimit 已通过 slots.patch 上报 */ }
    })
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (!msg) return

      // V3 握手：第二个 bind 携带中继自己的 clientId（V4 的 tid 需要它）。
      if (msg.type === 'bind') {
        if (msg.message === '200' && msg.clientId) {
          controllerId = msg.clientId
          push({ kind: 'sim', channel: '-', note: `V3 绑定完成（controller=${String(controllerId).slice(0, 8)}…）` })
          reportStatus()
        } else if (msg.clientId) {
          appId = msg.clientId
        }
        return
      }
      if (msg.type === 'hello' && msg.clientId) {
        appId = msg.clientId
        return
      }
      if (msg.type === 'heartbeat') {
        send(version === 'v3' ? { type: 'heartbeat', clientId: appId || '', targetId: controllerId || '' } : { type: 'heartbeat' })
        return
      }

      // V4：中继的 RPC 请求（device.get / device.op ...）
      if (msg.t === 'req' && msg.m) {
        if (msg.m === 'devices.get') {
          send({ t: 'resp', reqId: msg.reqId, code: 200, m: msg.m })
          return
        }
        if (msg.m === 'device.op') {
          handleV4Op(msg)
          send({ t: 'resp', reqId: msg.reqId, code: 200, m: msg.m })
          return
        }
        send({ t: 'resp', reqId: msg.reqId, code: 200, m: msg.m })
        return
      }

      // V3：文本指令
      if (typeof msg.message === 'string') {
        const parsed = parseV3Message(msg.message)
        if (!parsed) return
        if (parsed.kind === 'strength') {
          counters.strength += 1
          if (parsed.channel === 'A' || parsed.channel === 'B') effective[parsed.channel] = parsed.value
          push({ kind: 'strength', channel: parsed.channel, value: parsed.value, op: parsed.op })
        } else if (parsed.kind === 'clear') {
          counters.clear += 1
          if (parsed.channel === 'A' || parsed.channel === 'B') effective[parsed.channel] = 0
          push({ kind: 'clear', channel: parsed.channel, value: 0 })
        } else if (parsed.kind === 'pulse') {
          counters.pulse += 1
          counters.pulseFrames += parsed.frames.length
          push({ kind: 'pulse', channel: parsed.channel, frames: parsed.frames })
        }
      }
    })
    ws.on('close', (code, reason) => {
      connected = false
      connecting = false
      stopHeartbeat()
      if (ws) ws = null
      push({ kind: 'sim', channel: '-', note: `虚拟设备断开（code=${code} ${reason?.toString?.() || ''}）` })
    })
    ws.on('error', (error) => {
      connected = false
      connecting = false
      lastError = String(error?.message || error)
      push({ kind: 'sim', channel: '-', note: `连接错误：${lastError}` })
    })
    return { ok: true }
  }

  /** V4 device.op：动作码 0 AppendPulseData / 7 SetIntensity（对齐 V4_ACTION）。 */
  const handleV4Op = (msg) => {
    const data = msg.data || {}
    const channel = data.c === 1 ? 'B' : 'A'
    if (data.t === 0) {
      counters.pulse += 1
      const frames = (Array.isArray(data.v) ? data.v : []).map(decodeHexFrame).filter(Boolean)
      counters.pulseFrames += frames.length
      push({ kind: 'pulse', channel, frames })
    } else if (data.t === 7 || data.t === 4 || data.t === 3) {
      counters.strength += 1
      const value = Number(data.v) || 0
      effective[channel] = value
      push({ kind: 'strength', channel, value, op: data.t })
    }
  }

  const disconnect = () => {
    stopHeartbeat()
    if (ws) {
      try { ws.close(1000, 'debug disconnect') } catch { /* ignore */ }
      ws = null
    }
    connected = false
    return { ok: true }
  }

  return {
    connect,
    disconnect,
    getState: () => ({
      version,
      connected,
      connecting,
      appId,
      controllerId,
      lastError,
      counters,
      effective: { ...effective },
      softLimit,
      strength,
      seq,
      eventCount: events.length,
    }),
    /** 增量拉取：since = 上次拿到的 seq。 */
    getEvents: (since = 0) => events.filter(e => e.seq > since),
    getPulses: (since = 0) => pulses.filter(p => p.seq > since),
    clear: () => {
      events.length = 0
      pulses.length = 0
      counters.strength = 0
      counters.pulse = 0
      counters.clear = 0
      counters.pulseFrames = 0
      return { ok: true }
    },
    /** 让虚拟设备回报新的软上限/当前强度（用于验证自动钳位逻辑）。 */
    setReportedLimit: (next) => {
      if (Number.isFinite(next?.A)) softLimit.A = next.A
      if (Number.isFinite(next?.B)) softLimit.B = next.B
      if (Number.isFinite(next?.currentA)) strength.A = next.currentA
      if (Number.isFinite(next?.currentB)) strength.B = next.currentB
      reportStatus()
      return { ok: true, softLimit: { ...softLimit }, strength: { ...strength } }
    },
  }
}

module.exports = { createVirtualDevice, parseV3Message, decodeHexFrame }
