'use strict'
// ===== AirPlay 投送端服务（main 进程）=====
// 纯 JS 实现：bonjour-service 做 mDNS 设备发现，
// @lox-audioserver/node-airplay-sender 负责 RAOP/AirPlay2 连接、ALAC 编码与流控。
// 音频输入为 s16le 立体声 44.1kHz PCM（渲染进程经 AudioWorklet 采集并转换后经 IPC 推送）。
const { EventEmitter } = require('node:events')
const os = require('os')
const { Bonjour } = require('bonjour-service')
const { start: startAirplaySender } = require('@lox-audioserver/node-airplay-sender')

const AIRPLAY_TYPE = 'airplay' // _airplay._tcp.local（AirPlay 2 设备：Apple TV / HomePod / 智能电视）
const RAOP_TYPE = 'raop' // _raop._tcp.local（AirPlay 1 设备：RAOP 音箱 / Apple TV 兼容模式）
const SENDER_NAME = 'WaveForge'
const DEVICE_TTL_MS = 60_000 // 设备超过该时长未刷新视为离线
const REBROWSE_INTERVAL_MS = 8_000
const NETWORK_CHECK_INTERVAL_MS = 10_000 // 网络接口变化轮询（WiFi/有线切换时重建 mDNS）

// 虚拟网卡名特征（Tailscale/Docker/Hyper-V/虚拟机/VPN 等）：组播查询走这些接口会丢
const VIRTUAL_IFACE_PATTERNS = [
  /tailscale/i, /wintun/i, /zerotier/i, /vtun/i, /utun/i, /tun\d/i, /tap\d/i,
  /vEthernet/i, /hyper-v/i, /docker/i, /virtual/i, /vmware/i, /vbox/i,
  /loopback/i, /bluetooth/i, /nordvpn/i, /wireguard/i, /awg/i, /amnezia/i,
  /torguard/i, /proton/i, /mullvad/i, /windscribe/i, /surfshark/i,
]

function isPrivateIPv4(addr) {
  const parts = String(addr).split('.').map(Number)
  if (parts.length !== 4) return false
  if (parts[0] === 10) return true
  if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
  if (parts[0] === 192 && parts[1] === 168) return true
  return false
}

/** 排除链路本地/运营商级 NAT（Tailscale 兜底地址等），这些网段 mDNS 不可达 */
function isUsableIPv4(addr) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(String(addr))) return false
  const first = Number(String(addr).split('.')[0])
  if (first === 127 || first === 0) return false
  if (first === 169 && Number(String(addr).split('.')[1]) === 254) return false // link-local
  if (first === 100 && Number(String(addr).split('.')[1]) >= 64 && Number(String(addr).split('.')[1]) <= 127) return false // CGNAT
  return true
}

/**
 * 选择 mDNS 组播绑定的局域网 IPv4 接口地址。
 * 原因：Windows 上存在虚拟网卡（Tailscale 等）时，multicast-dns 默认实例的组播
 * 查询可能走错接口，而 AirPlay 设备只在响应查询时返回 PTR（bonjour 只认 PTR），
 * 导致扫不到设备。强制绑定物理局域网接口即可修复。
 */
function resolveMdnsInterface() {
  const candidates = []
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || !isUsableIPv4(a.address)) continue
      const virtual = VIRTUAL_IFACE_PATTERNS.some((re) => re.test(name))
      candidates.push({ name, addr: a.address, virtual, private: isPrivateIPv4(a.address) })
    }
  }
  // 优先：私有网段 + 物理网卡（192.168/10/172.16-31）
  const best = candidates.find((c) => c.private && !c.virtual)
  if (best) return best.addr
  const fallback = candidates.find((c) => !c.virtual)
  return fallback ? fallback.addr : null
}

// 空方法引用，避免打包时因未使用而告警
const noop = () => {}

function normalizePort(value, fallback) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback
}

class AirplaySenderService extends EventEmitter {
  constructor(options = {}) {
    super()
    this.debug = options.debug === true
    this.onStatus = options.onStatus || noop
    /** @type {Map<string, object>} 设备去重表（key = host IP） */
    this.devices = new Map()
    this.bonjour = null
    this.browsers = []
    this.browseTimer = null
    this.rebrowseTimer = null
    this.networkCheckTimer = null
    this.mdnsInterface = null
    /** 当前连接 */
    this.sender = null
    this.connectedDeviceId = null
    this.connectedMode = null
    this.phase = 'idle' // idle | browsing | connecting | connected | streaming | error
    this.lastError = ''
    this.streaming = false
    this.volume = 50
    this.lastTrackKey = ''
    this.lastProgressSentAt = 0
    this._reconnectAttempted = false
    /** 连接提示音待重推标记（首个 setMetadata reset 后补推） */
    this._chimePending = false
    /** 断开后应恢复的设备音量（连接前记录；异常退出后下次连接也会用记忆值修正） */
    this.restoreVolume = null
  }

  // ---------- 设备发现 ----------

  // ---------- 生命周期 ----------

  /** 惰性启动浏览：默认不开启（用户设置开关控制），首次调用时才启动 mDNS 发现 */
  ensureBrowsing() {
    if (this.bonjour) return
    this.startBrowsing()
  }

  /** 设置开关：true = 启动设备发现；false = 停止发现并断开连接 */
  setEnabled(enabled) {
    if (enabled) {
      this.ensureBrowsing()
    } else {
      this.stopBrowsing()
      this.disconnect()
    }
    return this.getStatus()
  }

  startBrowsing() {
    if (this.bonjour) return
    // 绑定物理局域网接口（避开 Tailscale/虚拟网卡，见 resolveMdnsInterface 注释）
    const mdnsInterface = resolveMdnsInterface()
    const bonjour = mdnsInterface
      ? new Bonjour({ interface: mdnsInterface })
      : new Bonjour()
    this.mdnsInterface = mdnsInterface
    this.bonjour = bonjour
    const onUp = (service) => this._upsertDevice(service)
    const onDown = (service) => this._markDeviceDown(service)

    for (const type of [AIRPLAY_TYPE, RAOP_TYPE]) {
      const browser = bonjour.find({ type, protocol: 'tcp' })
      browser.on('up', onUp)
      browser.on('down', onDown)
      this.browsers.push(browser)
    }
    this._setPhase('browsing', mdnsInterface ? `mDNS 绑定 ${mdnsInterface}` : '')
    // 周期性重新浏览，兜底丢失的 up/down 事件与离线清理
    this.browseTimer = setInterval(() => {
      this._expireStaleDevices()
    }, DEVICE_TTL_MS)
    this.rebrowseTimer = setInterval(() => {
      for (const browser of this.browsers) {
        try { browser.update() } catch { /* 忽略 */ }
      }
    }, REBROWSE_INTERVAL_MS)
    // 网络接口变化（WiFi↔有线切换、VPN 启停）时重建 mDNS，保持设备发现可用
    this.networkCheckTimer = setInterval(() => {
      const current = resolveMdnsInterface()
      if (current === this.mdnsInterface) return
      const devices = this.listDevices()
      this.stopBrowsing()
      this.devices = new Map(devices.map((d) => [d.id, {
        id: d.id, host: d.host, name: d.name, addresses: d.addresses || [], raopPort: d.raopPort, airplayPort: d.airplayPort,
        hasRaop: d.hasRaop, hasAirplay2: d.hasAirplay2, txt: d.txt, lastSeenAt: Date.now(), online: true,
      }]))
      this.startBrowsing()
    }, NETWORK_CHECK_INTERVAL_MS)
  }

  stopBrowsing() {
    if (this.browseTimer) { clearInterval(this.browseTimer); this.browseTimer = null }
    if (this.rebrowseTimer) { clearInterval(this.rebrowseTimer); this.rebrowseTimer = null }
    if (this.networkCheckTimer) { clearInterval(this.networkCheckTimer); this.networkCheckTimer = null }
    for (const browser of this.browsers) {
      try { browser.stop() } catch { /* 忽略 */ }
    }
    this.browsers = []
    if (this.bonjour) {
      try { this.bonjour.destroy() } catch { /* 忽略 */ }
      this.bonjour = null
    }
  }

  _upsertDevice(service) {
    if (!service || !service.host) return
    const host = String(service.host).replace(/\.$/, '')
    // bonjour-service 的 service.type 是字符串（'airplay'/'raop'）；部分版本为 {name,...}，两者都兼容
    const type = typeof service.type === 'string'
      ? service.type
      : String(service.type?.name || service.name || '')
    const isRaop = type === RAOP_TYPE
    const isAirplay = type === AIRPLAY_TYPE
    if (!isRaop && !isAirplay) return

    // RAOP 实例名形如 "66644A7FF619@Xiaomi Sound-5089"（MAC@设备名），去掉 MAC 前缀
    const rawName = String(service.name || host)
    const atIndex = rawName.indexOf('@')
    const cleanInstanceName = (atIndex >= 0 ? rawName.slice(atIndex + 1) : rawName).trim() || rawName

    const key = host
    const existing = this.devices.get(key)
    const record = existing || {
      id: key,
      host,
      name: '',
      addresses: [],
      raopPort: null,
      airplayPort: null,
      hasRaop: false,
      hasAirplay2: false,
      txt: {},
      lastSeenAt: Date.now(),
      online: true,
    }
    record.lastSeenAt = Date.now()
    record.online = true
    // 记录真实 IPv4 地址：mDNS 主机名（如 L16A-5089.local）在部分环境下 Node 无法解析，
    // 连接时优先用 IP 直连
    if (Array.isArray(service.addresses)) {
      for (const addr of service.addresses) {
        if (typeof addr === 'string' && /^\d+\.\d+\.\d+\.\d+$/.test(addr) && !record.addresses.includes(addr)) {
          record.addresses.push(addr)
        }
      }
    }
    if (service.txt && typeof service.txt === 'object') Object.assign(record.txt, service.txt)
    if (isRaop) {
      record.hasRaop = true
      record.raopPort = normalizePort(service.port, 5000)
      if (!record.name) record.name = cleanInstanceName
    }
    if (isAirplay) {
      record.hasAirplay2 = true
      record.airplayPort = normalizePort(service.port, 7000)
      // 实例名即用户可见名（iOS AirPlay 列表显示的就是它，如「书房」「Xiaomi Sound-5089」），
      // model（L16A / AppleTV14,1）仅作实例名为空时的兜底
      if (cleanInstanceName && cleanInstanceName !== host) {
        record.name = cleanInstanceName
      } else {
        const model = service.txt?.model
        record.name = model && typeof model === 'string' && model.trim() ? model.trim() : (record.name || cleanInstanceName || host)
      }
    }
    this.devices.set(key, record)
    this._emitDevicesChanged()
  }

  _markDeviceDown(_service) {
    // bonjour 的 down 事件在设备短暂离开广播/连接过程中会误触发；
    // 设备不因 down 从列表消失（只按 TTL 超时清理），避免「连接后列表变空」。
    // 记录仅保留，供 TTL 清理。
  }

  _expireStaleDevices() {
    // bonjour-service 的 update() 不刷新 lastSeenAt（up 事件只在首次出现时触发），
    // 若按 TTL 删除会导致设备 60s 后全部消失（弹窗重开变「未发现设备」）。
    // 局域网设备有限：保留全部已发现设备，连接失败时再提示，不做超时删除。
  }

  _emitDevicesChanged() {
    this.onStatus({ phase: this.phase, devices: this.listDevices() })
  }

  listDevices() {
    return [...this.devices.values()]
      .map((d) => ({
        id: d.id,
        host: d.host,
        addresses: d.addresses || [],
        name: d.name || d.host,
        hasRaop: d.hasRaop,
        hasAirplay2: d.hasAirplay2,
        raopPort: d.raopPort,
        airplayPort: d.airplayPort,
        txt: d.txt,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  // ---------- 连接管理 ----------

  connect(deviceId, mode = 'auto') {
    this.disconnect()
    const device = this.devices.get(deviceId)
    if (!device || !device.online) {
      this._setPhase('error', `设备不可用: ${deviceId || 'unknown'}`)
      return { success: false, error: 'device_unavailable' }
    }

    let useMode = mode
    if (useMode === 'auto') useMode = device.hasAirplay2 ? 'airplay2' : 'raop'
    if (useMode === 'raop' && !device.hasRaop) {
      // 纯 AirPlay2 设备不支持 RAOP
      useMode = 'airplay2'
    }
    if (useMode === 'airplay2' && !device.hasAirplay2) useMode = 'raop'

    const port = useMode === 'airplay2'
      ? normalizePort(device.airplayPort, 7000)
      : normalizePort(device.raopPort, 5000)

    this._reconnectAttempted = false
    this._setPhase('connecting', `正在连接 ${device.name}`)
    console.log(`[AirPlay] connect ${device.name} mode=${useMode}（hasRaop:${device.hasRaop} hasAirplay2:${device.hasAirplay2}）port=${port} host=${device.addresses?.[0] || device.host}`)
    try {
      // 优先用真实 IPv4 直连（mDNS 主机名解析在部分环境不可靠，会导致永远连接中）
      const connectHost = Array.isArray(device.addresses) && device.addresses.length
        ? device.addresses[0]
        : device.host
      const sender = startAirplaySender({
        host: connectHost,
        port,
        name: SENDER_NAME,
        volume: Math.max(0, Math.min(100, Math.round(this.volume))),
        airplay2: useMode === 'airplay2',
        inputCodec: 'pcm',
        alacEncoding: true,
        debug: this.debug,
        // 降低发送端缓冲：默认 260 包（约 2.1s）；60 包约 0.5s，减少暂停后的残余播放。
        // stream_latency 200→50：UDP 音频包更平滑推送，减少突发积压被设备端缓冲放大。
        config: { packets_in_buffer: 60, stream_latency: 50 },
        // startTimeMs 必须显式传入：包内 setLatencyFrames 依赖它把 RTP 时间轴
        // 按设备响应的 Audio-Latency 前移，使播放对齐墙钟、抵消设备缓冲
        // （否则延迟 ≈ 设备缓冲，Xiaomi Sound 可达 3-4s）。
        startTimeMs: Date.now(),
        log: (level, message) => {
          if (this.debug) console.log(`[AirPlay:${level}] ${message}`)
        },
      }, (event) => this._onSenderEvent(event))
      this.sender = sender
      this.connectedDeviceId = deviceId
      this.connectedMode = useMode
      return { success: true, mode: useMode, port, host: connectHost }
    } catch (error) {
      this._setPhase('error', `启动 AirPlay 会话失败: ${error instanceof Error ? error.message : String(error)}`)
      this.sender = null
      return { success: false, error: String(error instanceof Error ? error.message : error) }
    }
  }

  _onSenderEvent(event) {
    if (!event) return
    const kind = String(event.event || '')
    const message = String(event.message || '')
    if (this.debug) console.log(`[AirPlay:event] ${kind}: ${message}`)
    switch (kind) {
      case 'device': {
        // message 形如 "ready" / "playing" / "stopped" / "error: ..."
        const status = message.toLowerCase()
        if (status.includes('ready') || status.includes('playing')) {
          this._setPhase('connected', message)
        } else if (status.includes('error') || status.includes('fail')) {
          this._setPhase('error', message)
        } else if (status.includes('stopped')) {
          this._setPhase('idle', message)
        }
        break
      }
      case 'buffer': {
        if (message === 'playing') {
          this._setPhase('streaming', '正在投送音频')
        } else if (message === 'end' || message === 'drain') {
          // 缓冲清空属于正常状态，仅提示
          this._setPhase('connected', '缓冲已清空')
        }
        break
      }
      case 'session-ended': {
        this._setPhase('idle', `会话结束: ${message || 'unknown'}`)
        if (this.sender && !this._reconnectAttempted) {
          this._reconnectAttempted = true
          const deviceId = this.connectedDeviceId
          const mode = this.connectedMode
          this.sender = null
          this.connectedDeviceId = null
          this.connectedMode = null
          // 播放中意外断开会话时自动重连一次
          if (this.streaming && deviceId) this.connect(deviceId, mode || 'auto')
        }
        break
      }
      case 'error': {
        this._setPhase('error', message || '未知错误')
        break
      }
      default:
        break
    }
  }

  disconnect() {
    // 断开前恢复设备音量（连接前记录的值），避免音箱停在投送音量
    if (this.sender && this.restoreVolume !== null) {
      try { this.sender.setVolume(Math.max(0, Math.min(100, Math.round(this.restoreVolume)))) } catch { /* 忽略 */ }
    }
    if (this.sender) {
      try { this.sender.stop() } catch { /* 忽略 */ }
      this.sender = null
    }
    this.connectedDeviceId = null
    this.connectedMode = null
    this.streaming = false
    this.lastTrackKey = ''
    this._chimePending = false
    if (this.phase !== 'browsing') this._setPhase('idle', '已断开')
  }

  /** 记录连接前/断开后应恢复的设备音量（0-100） */
  setRestoreVolume(volume) {
    const v = Number(volume)
    this.restoreVolume = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : null
  }

  // ---------- 音频与元数据 ----------

  sendPcm(chunk) {
    if (!this.sender) return
    if (!this.streaming) return
    let buffer = chunk
    if (!Buffer.isBuffer(buffer)) {
      if (ArrayBuffer.isView(buffer)) {
        buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      } else {
        return
      }
    }
    // 诊断统计：每 200 块（约 18s）打一次，确认 PCM 是否真正到达主进程
    this._pcmBytes = (this._pcmBytes || 0) + buffer.length
    this._pcmChunks = (this._pcmChunks || 0) + 1
    if (this._pcmChunks % 200 === 0) {
      console.log(`[AirPlay] sendPcm 累计 ${this._pcmChunks} 块 / ${(this._pcmBytes / 1024 / 1024).toFixed(1)} MB`)
    }
    try {
      this.sender.sendPcm(buffer)
    } catch (error) {
      if (this.debug) console.warn('[AirPlay] sendPcm 失败:', error)
    }
  }

  /** 暂停投送（本地播放暂停时调用；保留会话以便恢复） */
  pauseStreaming() {
    this.streaming = false
    this._setPhase('connected', '已暂停投送')
  }

  // ---------- 连接提示音（在 AirPlay 设备上播放） ----------

  /**
   * 合成连接提示音（44100Hz 立体声 16bit 小端 PCM，约 0.36s 两声「叮」），
   * 与旧版本地 Web Audio 合成一致。直接推入发送管道：设备连接后 RTP 时间线
   * 已按墙钟锚定，提示音插在当前时间点，由音箱播出（而非默认输出设备）。
   */
  _synthesizeConnectSound() {
    const SAMPLE_RATE = 44100
    const CHANNELS = 2
    const notes = [
      { freq: 880, start: 0, duration: 0.12 },
      { freq: 1318, start: 0.13, duration: 0.18 },
    ]
    const total = 0.36
    const frames = Math.ceil(total * SAMPLE_RATE)
    const pcm = Buffer.alloc(frames * CHANNELS * 2)
    for (let f = 0; f < frames; f += 1) {
      const t = f / SAMPLE_RATE
      let sample = 0
      for (const note of notes) {
        const local = t - note.start
        if (local >= 0 && local < note.duration) {
          // 15ms 淡入 + 指数淡出，避免爆音
          const attack = Math.min(1, local / 0.015)
          const decay = Math.exp((-3.5 * local) / note.duration)
          sample += Math.sin(2 * Math.PI * note.freq * local) * attack * decay * 0.22
        }
      }
      sample = Math.max(-1, Math.min(1, sample))
      const v = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff)
      for (let c = 0; c < CHANNELS; c += 1) {
        pcm.writeInt16LE(v, (f * CHANNELS + c) * 2)
      }
    }
    return pcm
  }

  /** 连接成功后由渲染进程触发：提示音在 AirPlay 音箱上播放（不依赖是否在播放音乐） */
  playConnectSound() {
    if (!this.sender) return
    try {
      const pcm = this._synthesizeConnectSound()
      this.sender.sendPcm(pcm)
      // 提示音仅 0.36s，不足发送端半缓冲门限（0.48s）——不推进状态的话
      // readPacket 会一直把它当作「前导静音」跳过，音箱永远听不到。
      // 直接置为 NORMAL（2）让真实数据立即出流，提示音排在当前时间点播放。
      const cb = this.sender.airtunes?.circularBuffer
      if (cb && typeof cb.status === 'number') cb.status = 2
      // 连接瞬间的首个 setMetadata 会 reset() 清空发送端缓冲（丢弃上一首残留），
      // 可能把刚推入的提示音一并清掉；标记待重推，由 setMetadata 复位后补推一次。
      this._chimePending = true
    } catch { /* 忽略 */ }
  }

  resumeStreaming() {
    if (!this.sender) return
    this.streaming = true
    this._setPhase('streaming', '继续投送')
  }

  /** 渲染进程按本地播放状态设置投送开/停（暂停时停发 PCM，避免音箱播放静音） */
  setStreaming(streaming) {
    if (streaming === this.streaming) return
    console.log(`[AirPlay] setStreaming -> ${streaming}（sender: ${this.sender ? '有' : '无'}，phase: ${this.phase}）`)
    if (streaming) this.resumeStreaming()
    else this.pauseStreaming()
  }

  setVolume(volume) {
    this.volume = Math.max(0, Math.min(100, Number(volume) || 0))
    if (this.sender) {
      try { this.sender.setVolume(Math.round(this.volume)) } catch { /* 忽略 */ }
    }
  }

  /**
   * 更新曲目元数据。trackKey 变化时先清空发送端缓冲（丢弃上一首的残留 PCM），
   * 避免切歌后音箱先放出一段旧歌。
   */
  setMetadata(metadata = {}) {
    if (!this.sender) return
    const trackKey = String(metadata.trackKey || metadata.title || '')
    if (trackKey && trackKey !== this.lastTrackKey) {
      try { this.sender.reset() } catch { /* 忽略 */ }
      // 连接提示音在首个元数据 reset 时可能被清掉：补推一次，保证音箱能听到
      if (this._chimePending) {
        this._chimePending = false
        this.playConnectSound()
      }
      this.lastTrackKey = trackKey
    }
    void this.sender.setMetadata({
      title: metadata.title || '',
      artist: metadata.artist || '',
      album: metadata.album || '',
      coverUrl: metadata.coverUrl || '',
      durationMs: Math.max(0, Number(metadata.durationMs) || 0),
      elapsedMs: Math.max(0, Number(metadata.elapsedMs) || 0),
    }).catch((error) => {
      if (this.debug) console.warn('[AirPlay] setMetadata 失败:', error)
    })
  }

  setProgress(elapsedSeconds, durationSeconds) {
    if (!this.sender) return
    const now = Date.now()
    if (now - this.lastProgressSentAt < 1000) return
    this.lastProgressSentAt = now
    try {
      this.sender.setProgress(Number(elapsedSeconds) || 0, Number(durationSeconds) || 0)
    } catch { /* 忽略 */ }
  }

  // ---------- 状态 ----------

  _setPhase(phase, message = '') {
    if (phase !== this.phase) this.phase = phase
    this.lastError = phase === 'error' ? message : ''
    this.onStatus(this.getStatus())
  }

  getStatus() {
    return {
      phase: this.phase,
      message: this.lastError,
      devices: this.listDevices(),
      connectedDeviceId: this.connectedDeviceId,
      connectedMode: this.connectedMode,
      streaming: this.streaming,
      volume: this.volume,
    }
  }

  dispose() {
    this.stopBrowsing()
    this.disconnect()
  }
}

module.exports = { AirplaySenderService }
