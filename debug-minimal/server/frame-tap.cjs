/**
 * 真机帧观测（frame tap）：直接监听中继发给**真实手机 App**的每一帧。
 *
 * 为什么这么做，而不是搞个假设备：
 * 调试平台要回答的问题是「真机上到底收到什么波形」。假设备只能验证「我自己造的那条
 * 回路通不通」，真机才有意义（而且要配真实强度上限、真实握手时序）。
 * 所以这里不模拟设备，只做旁观：给中继与手机之间那个已存在的 socket 套一层
 * send 记录，把真正下发的帧抄一份出来。中继代码一行不改，真机行为完全不受影响。
 *
 * 观测方式：轮询 relay._internal.app.v3（单连接）与 app.v4（Map），
 * 发现新 socket 就包装它的 send。socket 断开后自动丢弃，重连后重新包装。
 */

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

const V4_CHANNEL = { 0: 'A', 1: 'B' }

function createFrameTap({ getRelay, pollMs = 250 }) {
  const events = []
  const pulses = []
  const counters = { strength: 0, pulse: 0, clear: 0, pulseFrames: 0, heartbeat: 0, other: 0 }
  /** 已包装过的 socket（断开即不再引用，由 GC 回收）。 */
  const tapped = new WeakSet()
  let seq = 0
  let timer = null
  /** 当前连接的真机标识，仅用于展示。 */
  let deviceInfo = { version: null, appId: null, remoteBound: false }

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

  /** 记录一条从「中继 → 真机」的原始帧。 */
  const recordOutgoing = (raw) => {
    let msg
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : String(raw))
    } catch {
      return
    }
    if (!msg) return

    // 心跳量大且无信息量，只计数不逐条记录（否则会把事件流刷爆）。
    if (msg.type === 'heartbeat') {
      counters.heartbeat += 1
      return
    }

    // V3：文本指令
    if (typeof msg.message === 'string') {
      const parsed = parseV3Message(msg.message)
      if (!parsed) {
        counters.other += 1
        return
      }
      if (parsed.kind === 'strength') {
        counters.strength += 1
        push({ kind: 'strength', channel: parsed.channel, value: parsed.value, op: parsed.op })
      } else if (parsed.kind === 'clear') {
        counters.clear += 1
        push({ kind: 'clear', channel: parsed.channel, value: 0 })
      } else if (parsed.kind === 'pulse') {
        counters.pulse += 1
        counters.pulseFrames += parsed.frames.length
        push({ kind: 'pulse', channel: parsed.channel, frames: parsed.frames })
      }
      return
    }

    // V4：device.op RPC（动作码 0 AppendPulseData / 3 AddIntensity / 4 SetTempIntensity / 7 SetIntensity）
    if (msg.t === 'req' && msg.m === 'device.op') {
      const data = msg.data || {}
      const channel = V4_CHANNEL[data.c] ?? 'A'
      if (data.t === 0) {
        counters.pulse += 1
        const frames = (Array.isArray(data.v) ? data.v : []).map(decodeHexFrame).filter(Boolean)
        counters.pulseFrames += frames.length
        push({ kind: 'pulse', channel, frames })
      } else if (data.t === 7 || data.t === 4 || data.t === 3) {
        counters.strength += 1
        push({ kind: 'strength', channel, value: Number(data.v) || 0, op: data.t })
      } else {
        counters.other += 1
      }
      return
    }

    counters.other += 1
  }

  /** 给一个 socket 套上 send 记录（幂等）。 */
  const tapSocket = (ws) => {
    if (!ws || typeof ws.send !== 'function' || tapped.has(ws)) return
    tapped.add(ws)
    const original = ws.send.bind(ws)
    ws.send = (data, ...rest) => {
      try {
        recordOutgoing(data)
      } catch {
        /* 记录失败绝不影响真机下发 */
      }
      return original(data, ...rest)
    }
  }

  /** 扫描中继当前的真实设备连接并包装。 */
  const sync = () => {
    const relay = getRelay()
    const state = relay?._internal
    if (!state) return
    const v3 = state.app?.v3
    if (v3 && !v3.isClosed) tapSocket(v3)
    for (const ws of state.app?.v4?.values?.() ?? []) {
      if (!ws.isClosed) tapSocket(ws)
    }
    deviceInfo = {
      version: state.settings?.version ?? null,
      appId: state.v3AppId ?? (state.app?.v4?.size ? 'v4-app' : null),
      remoteBound: Boolean(state.bound),
    }
  }

  return {
    start: () => {
      if (timer) return
      timer = setInterval(sync, pollMs)
      if (typeof timer.unref === 'function') timer.unref()
      sync()
    },
    stop: () => {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    },
    getState: () => ({ ...deviceInfo, counters: { ...counters }, seq, eventCount: events.length }),
    getEvents: (since = 0) => events.filter(e => e.seq > since),
    getPulses: (since = 0) => pulses.filter(p => p.seq > since),
    clear: () => {
      events.length = 0
      pulses.length = 0
      counters.strength = 0
      counters.pulse = 0
      counters.clear = 0
      counters.pulseFrames = 0
      counters.heartbeat = 0
      counters.other = 0
      return { ok: true }
    },
  }
}

module.exports = { createFrameTap, parseV3Message, decodeHexFrame }
