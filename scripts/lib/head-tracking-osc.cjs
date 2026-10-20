'use strict'

const dgram = require('node:dgram')
const { performance } = require('node:perf_hooks')
const { WebSocketServer, WebSocket } = require('ws')

const NTP_UNIX_SECONDS = 2208988800
const LOOPBACK = '127.0.0.1'
const DEFAULT_LIMITS = Object.freeze({ maxPacketBytes: 8192, maxDepth: 4, maxMessages: 64 })

/**
 * Decode the strict numeric OSC subset used by the pose bridge. Throws on any
 * malformed packet, including one malformed element inside an otherwise valid
 * bundle. Timetags become Unix milliseconds; OSC immediate (0,1) inherits the
 * enclosing bundle's time, or null at the root. No packet is partially accepted.
 */
function parseOscPacket(packet, limits = {}) {
  const settings = { ...DEFAULT_LIMITS, ...limits }
  if (!Buffer.isBuffer(packet) || packet.length < 4 || packet.length % 4 !== 0
    || packet.length > settings.maxPacketBytes) throw new Error('Invalid OSC packet size')
  const messages = []

  function text(offset, end) {
    const start = offset
    let terminator = -1
    for (; offset < end; offset++) {
      const byte = packet[offset]
      if (byte === 0) { terminator = offset; break }
      if (byte < 0x20 || byte > 0x7e || offset - start > 256) throw new Error('Invalid OSC string')
    }
    if (terminator < 0) throw new Error('Unterminated OSC string')
    const next = (terminator + 4) & ~3
    if (next > end) throw new Error('Truncated OSC string padding')
    for (let i = terminator; i < next; i++) if (packet[i] !== 0) throw new Error('Nonzero OSC padding')
    return { value: packet.toString('ascii', start, terminator), next }
  }

  function decode(start, end, depth, parentTime) {
    if (depth > settings.maxDepth || end - start < 4 || (end - start) % 4 !== 0) throw new Error('Invalid OSC nesting')
    const address = text(start, end)
    let offset = address.next
    if (address.value === '#bundle') {
      if (offset + 8 > end) throw new Error('Truncated OSC bundle timetag')
      const seconds = packet.readUInt32BE(offset), fraction = packet.readUInt32BE(offset + 4)
      const time = seconds === 0 && fraction === 1
        ? parentTime : (seconds - NTP_UNIX_SECONDS) * 1000 + fraction / 4294967296 * 1000
      if (parentTime !== null && time !== null && time < parentTime) throw new Error('OSC child bundle precedes parent')
      offset += 8
      while (offset < end) {
        if (offset + 4 > end) throw new Error('Truncated OSC element size')
        const size = packet.readInt32BE(offset); offset += 4
        if (size <= 0 || size % 4 !== 0 || size > end - offset) throw new Error('Invalid OSC element size')
        decode(offset, offset + size, depth + 1, time); offset += size
      }
      return
    }
    if (!address.value.startsWith('/')) throw new Error('Invalid OSC address')
    const tags = text(offset, end); offset = tags.next
    if (!/^,[fid]*$/.test(tags.value) || tags.value.length > 5) throw new Error('Unsupported OSC argument types')
    const args = []
    for (let i = 1; i < tags.value.length; i++) {
      const tag = tags.value[i], width = tag === 'd' ? 8 : 4
      if (offset + width > end) throw new Error('Truncated OSC numeric argument')
      const value = tag === 'i' ? packet.readInt32BE(offset)
        : tag === 'd' ? packet.readDoubleBE(offset) : packet.readFloatBE(offset)
      if (!Number.isFinite(value)) throw new Error('Non-finite OSC argument')
      args.push(value); offset += width
    }
    if (offset !== end) throw new Error('Trailing OSC data')
    if (messages.length >= settings.maxMessages) throw new Error('Too many OSC messages')
    messages.push({ address: address.value, args, timetag: parentTime })
  }

  decode(0, packet.length, 0, null)
  return messages
}

/** Recognized pose addresses. Device timestamps are optional monotonic ms. */
function poseUpdate(message) {
  const args = message.args
  if (message.address === '/hse/pose' || message.address === '/head/pose') {
    if (args.length !== 3 && args.length !== 4) return null
    if (Math.abs(args[0]) > 360 || Math.abs(args[1]) > 90 || Math.abs(args[2]) > 360
      || (args.length === 4 && args[3] < 0)) return null
    return { yaw: wrap(args[0]), pitch: args[1], roll: wrap(args[2]), timestamp: args[3] }
  }
  const axis = message.address.slice(1)
  if (!['yaw', 'pitch', 'roll'].includes(axis) || (args.length !== 1 && args.length !== 2)
    || Math.abs(args[0]) > (axis === 'pitch' ? 90 : 360) || (args.length === 2 && args[1] < 0)) return null
  return { [axis]: axis === 'pitch' ? args[0] : wrap(args[0]), timestamp: args[1] }
}

/**
 * Local OSC UDP -> WebSocket JSON bridge. It never sends UDP or initiates an
 * outbound connection. Both listeners bind to 127.0.0.1, without a host override.
 * Scheduled messages have bounded lookahead/queue depth, and clients get only
 * the newest complete pose per output tick.
 */
async function createHeadTrackingBridge(options = {}) {
  const udpPort = validPort(options.udpPort ?? 9000)
  const wsPort = validPort(options.wsPort ?? 8989)
  const path = options.path ?? '/pose'
  if (typeof path !== 'string' || !/^\/[A-Za-z0-9/_-]*$/.test(path)) throw new Error('Invalid WebSocket path')
  const maxHz = finiteRange(options.maxHz ?? 60, 1, 240, 'maxHz')
  const packetRate = finiteRange(options.maxPacketsPerSecond ?? 1000, 1, 10000, 'maxPacketsPerSecond')
  const maxLookaheadMs = finiteRange(options.maxLookaheadMs ?? 5000, 0, 10000, 'maxLookaheadMs')
  const udp = dgram.createSocket('udp4')
  const wss = new WebSocketServer({
    host: LOOPBACK, port: wsPort, path, maxPayload: 1024, perMessageDeflate: false,
    verifyClient: info => info.req.socket.remoteAddress === LOOPBACK,
  })
  const statistics = { received: 0, malformed: 0, dropped: 0, sent: 0 }
  let closed = false, closing
  let ready = false
  let interval
  let pending = null
  let scheduled = []
  let source = ''
  let latestPose = { yaw: 0, pitch: 0, roll: 0 }
  let seen = 0
  let outputTime = -Infinity
  let lastDeviceTime = new Map()
  let tokens = packetRate
  let tokenAt = performance.now()

  const reportError = error => { if (!closed) options.onError?.(error) }
  udp.on('error', reportError); wss.on('error', reportError)
  wss.on('connection', client => {
    if (closed || wss.clients.size > 8) { client.terminate(); return }
    client.on('error', () => {})
    // This endpoint is a subscription stream. Incoming data never controls or
    // rebroadcasts a pose, and cannot turn it into a relay.
    client.on('message', () => client.close(1008, 'Subscribe only'))
  })

  function apply(update, message, sender) {
    if (source !== sender) {
      source = sender; seen = 0; latestPose = { yaw: 0, pitch: 0, roll: 0 }; lastDeviceTime = new Map()
    }
    if (update.timestamp !== undefined) {
      const last = lastDeviceTime.get(message.address) ?? -Infinity
      if (update.timestamp <= last) { statistics.dropped++; return }
      lastDeviceTime.set(message.address, update.timestamp)
    }
    if (update.yaw !== undefined) { latestPose.yaw = update.yaw; seen |= 1 }
    if (update.pitch !== undefined) { latestPose.pitch = update.pitch; seen |= 2 }
    if (update.roll !== undefined) { latestPose.roll = update.roll; seen |= 4 }
    if (seen === 7) pending = { ...latestPose }
  }

  udp.on('message', (packet, remote) => {
    if (closed || !ready || remote.address !== LOOPBACK) return
    statistics.received++
    const now = performance.now()
    tokens = Math.min(packetRate, tokens + (now - tokenAt) * packetRate / 1000); tokenAt = now
    if (tokens < 1 || packet.length > DEFAULT_LIMITS.maxPacketBytes) { statistics.dropped++; return }
    tokens--
    let messages
    try { messages = parseOscPacket(packet) } catch { statistics.malformed++; return }
    const wallTime = Date.now()
    const sender = `${remote.address}:${remote.port}`
    for (const message of messages) {
      const update = poseUpdate(message)
      if (!update) continue
      if (message.timetag !== null && message.timetag > wallTime) {
        if (message.timetag - wallTime > maxLookaheadMs || scheduled.length >= 64) { statistics.dropped++; continue }
        scheduled.push({ due: now + message.timetag - wallTime, update, message, sender })
      } else apply(update, message, sender)
    }
    scheduled.sort((a, b) => a.due - b.due)
  })

  function tick() {
    if (closed) return
    const now = performance.now()
    let consumed = 0
    while (consumed < scheduled.length && scheduled[consumed].due <= now) {
      const item = scheduled[consumed++]; apply(item.update, item.message, item.sender)
    }
    if (consumed) scheduled = scheduled.slice(consumed)
    if (!pending) return
    outputTime = Math.max(now, outputTime + 0.001)
    const json = JSON.stringify({ ...pending, timestamp: outputTime }); pending = null
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue
      if (client.bufferedAmount > 64 * 1024) { client.terminate(); continue }
      client.send(json, { binary: false }, () => {})
      statistics.sent++
    }
  }

  async function close() {
    if (closing) return closing
    closed = true; ready = false
    if (interval) clearInterval(interval)
    scheduled = []; pending = null; lastDeviceTime.clear()
    closing = Promise.all([
      new Promise(resolve => {
        try { udp.close(resolve) } catch { resolve() }
      }),
      new Promise(resolve => {
        for (const client of wss.clients) client.terminate()
        try { wss.close(() => resolve()) } catch { resolve() }
      }),
    ]).then(() => {})
    return closing
  }

  try {
    // Both listeners must succeed before any data is forwarded. Closing on a
    // partial bind failure also releases the other successfully bound listener.
    await Promise.all([
      new Promise((resolve, reject) => {
        const error = value => { udp.off('listening', listening); reject(value) }
        const listening = () => { udp.off('error', error); resolve() }
        udp.once('error', error); udp.once('listening', listening)
        udp.bind(udpPort, LOOPBACK)
      }),
      new Promise((resolve, reject) => {
        const error = value => { wss.off('listening', listening); reject(value) }
        const listening = () => { wss.off('error', error); resolve() }
        wss.once('error', error); wss.once('listening', listening)
      }),
    ])
    ready = true
    interval = setInterval(tick, Math.ceil(1000 / maxHz))
    return {
      udpAddress: udp.address(), wsAddress: wss.address(), path,
      statistics, close,
    }
  } catch (error) {
    await close()
    throw error
  }
}

function validPort(value) {
  if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error('Port must be an integer from 0 to 65535')
  return value
}

function finiteRange(value, min, max, name) {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}`)
  return value
}

function wrap(value) { return ((value + 180) % 360 + 360) % 360 - 180 }

module.exports = { parseOscPacket, poseUpdate, createHeadTrackingBridge }
