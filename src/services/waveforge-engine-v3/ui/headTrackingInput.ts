import type { HeadPose } from '../src/spatial/HeadPose'

export interface HeadPoseSample {
  pose: HeadPose
  /** 交付时间，单调毫秒；直接传给现有 HeadPoseFilter.update。 */
  timestamp: number
  /** 可选设备单调毫秒，用于丢弃设备重复或倒序数据。 */
  deviceTimestamp?: number
}

export type HeadTrackingStatus = 'connecting' | 'connected' | 'reconnecting' | 'stalled' | 'disconnected' | 'error'

export interface HeadTrackingInputOptions {
  /** null 表示断流或主动断开；调用方应清除引擎当前姿态。滤波/校准仍由页面负责。 */
  onPose: (pose: HeadPose | null, timestamp: number) => void
  onStatus?: (status: HeadTrackingStatus, message?: string) => void
  now?: () => number
  staleAfterMs?: number
  maxLineLength?: number
}

/** Web Serial 的窄接口；避免要求主程序额外安装浏览器扩展类型。 */
export interface SerialHeadTrackingPort {
  readonly readable: ReadableStream<Uint8Array> | null
  open: (options: { baudRate: number }) => Promise<void>
  close: () => Promise<void>
}

export interface SerialHeadTrackingOptions {
  port?: SerialHeadTrackingPort
  baudRate?: number
  /** 注入已获授权的选择器也便于非浏览器测试；缺省使用 navigator.serial.requestPort。 */
  requestPort?: () => Promise<SerialHeadTrackingPort>
}

export interface WebSocketHeadTrackingConnection {
  addEventListener: (type: string, listener: EventListener) => void
  removeEventListener: (type: string, listener: EventListener) => void
  close: () => void
}

export interface WebSocketHeadTrackingOptions {
  /** 0 关闭自动重连；缺省 1000 ms。只连接本机 OSC/蓝牙桥，不直接解析 OSC 二进制。 */
  reconnectDelayMs?: number
  createSocket?: (url: string) => WebSocketHeadTrackingConnection
}

export interface DeviceOrientationHeadTrackingOptions {
  target?: EventTarget
  requestPermission?: () => Promise<'granted' | 'denied'>
}

/** 用户配置的 BLE UART 通知特征；本模块不假设任何厂商 UUID 是通用标准。 */
export interface BluetoothHeadTrackingCharacteristic {
  readonly value?: DataView
  addEventListener: (type: string, listener: EventListener) => void
  removeEventListener: (type: string, listener: EventListener) => void
  startNotifications: () => Promise<unknown>
  stopNotifications: () => Promise<unknown>
}

export interface BluetoothHeadTrackingServer {
  getPrimaryService: (uuid: string) => Promise<{
    getCharacteristic: (uuid: string) => Promise<BluetoothHeadTrackingCharacteristic>
  }>
  disconnect: () => void
}

export interface BluetoothHeadTrackingDevice {
  readonly gatt?: BluetoothHeadTrackingServer & { connect: () => Promise<BluetoothHeadTrackingServer> }
  addEventListener: (type: string, listener: EventListener) => void
  removeEventListener: (type: string, listener: EventListener) => void
}

export interface BluetoothHeadTrackingOptions {
  /** 16/32 位十六进制或完整 128 位服务 UUID，由设备协议明确提供。 */
  serviceUuid: string
  /** 通知特征 UUID；传输逐行 UTF8 JSON/CSV，末尾必须 CR 或 LF。 */
  characteristicUuid: string
  device?: BluetoothHeadTrackingDevice
  requestDevice?: (options: {
    filters: { services: string[] }[]; optionalServices: string[];
  }) => Promise<BluetoothHeadTrackingDevice>
}

const DEFAULT_MAX_LINE = 2048
const defaultNow = () => performance.now()
const wrap = (value: number) => ((value + 180) % 360 + 360) % 360 - 180
const positive = (value: number | undefined, fallback: number) =>
  value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback

/**
 * 协议：JSON { yaw,pitch,roll,timestamp? }；CSV yaw,pitch,roll 或
 * timestamp,yaw,pitch,roll。角度为度，HSE 右转/抬头/右倾正；timestamp 为设备
 * 单调毫秒，不是 Unix 日期。缺省 timestamp 时用本地到达时间。
 *
 * yaw/roll 接受 -360..360 后归一化，pitch 必须在 -90..90；不隐式转换字符串。
 */
export function parseHeadPosePacket(data: unknown, receivedAt: number, maxLength = DEFAULT_MAX_LINE): HeadPoseSample | null {
  if (!Number.isFinite(receivedAt)) return null
  let value: unknown = data
  if (typeof data === 'string') {
    if (data.length > maxLength) return null
    const text = data.trim()
    if (!text) return null
    if (text.startsWith('{')) {
      try { value = JSON.parse(text) } catch { return null }
    } else {
      const fields = text.split(',').map(field => field.trim())
      if ((fields.length !== 3 && fields.length !== 4) || fields.some(field => !field)) return null
      // Number() 本身接受十六进制/Infinity；线协议只允许十进制实数或科学计数法。
      if (fields.some(field => !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(field))) return null
      const numbers = fields.map(Number)
      value = fields.length === 4
        ? { timestamp: numbers[0], yaw: numbers[1], pitch: numbers[2], roll: numbers[3] }
        : { yaw: numbers[0], pitch: numbers[1], roll: numbers[2] }
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const packet = value as Record<string, unknown>
  const { yaw, pitch, roll, timestamp } = packet
  if (typeof yaw !== 'number' || typeof pitch !== 'number' || typeof roll !== 'number'
    || ![yaw, pitch, roll].every(Number.isFinite)
    || Math.abs(yaw) > 360 || Math.abs(pitch) > 90 || Math.abs(roll) > 360) return null
  if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp < 0)) return null
  return {
    pose: { yaw: wrap(yaw), pitch, roll: wrap(roll) }, timestamp: receivedAt,
    ...(typeof timestamp === 'number' ? { deviceTimestamp: timestamp } : {}),
  }
}

/** 有界行缓冲；超长行丢到下一换行符，重连 reset 后不会拼接上一连接残包。 */
export class HeadPoseLineDecoder {
  private pending = ''
  private discarding = false
  private lastDeviceTimestamp = -Infinity
  private lastTimestamp = -Infinity
  private readonly maxLength: number
  private readonly now: () => number

  constructor(private readonly options: {
    onSample: (sample: HeadPoseSample) => void; now?: () => number; maxLineLength?: number;
  }) {
    this.now = options.now ?? defaultNow
    this.maxLength = Math.max(16, Math.floor(positive(options.maxLineLength, DEFAULT_MAX_LINE)))
  }

  push(chunk: string): void {
    for (let i = 0; i < chunk.length; i++) {
      const character = chunk[i]
      if (character === '\n' || character === '\r') {
        if (!this.discarding && this.pending) this.readPacket(this.pending)
        this.pending = ''; this.discarding = false
      } else if (!this.discarding) {
        if (this.pending.length < this.maxLength) this.pending += character
        else { this.pending = ''; this.discarding = true }
      }
    }
  }

  /** WebSocket 以完整 JSON 消息传递时使用同一时序验证。 */
  readPacket(data: unknown): boolean {
    const sample = parseHeadPosePacket(data, this.now(), this.maxLength)
    if (!sample || (sample.deviceTimestamp !== undefined && sample.deviceTimestamp <= this.lastDeviceTimestamp)) return false
    if (sample.deviceTimestamp !== undefined) this.lastDeviceTimestamp = sample.deviceTimestamp
    sample.timestamp = Math.max(sample.timestamp, this.lastTimestamp + 0.001)
    this.lastTimestamp = sample.timestamp
    this.options.onSample(sample)
    return true
  }

  reset(): void {
    this.pending = ''; this.discarding = false
    this.lastDeviceTimestamp = -Infinity; this.lastTimestamp = -Infinity
  }
}

/**
 * 固定安装：设备屏幕朝上、设备顶边朝向听者正前方，alpha/beta/gamma 为浏览器
 * 内禀 Z-X'-Y'' 欧拉角。按 HSE 右转/抬头/右倾协议转换；倒置姿态不接受。
 * 用手机竖直手持需要由桥接端先转换坐标，不能直接套此安装约定。
 */
export function deviceOrientationToHeadPose(event: {
  alpha: number | null; beta: number | null; gamma: number | null;
}): HeadPose | null {
  if (event.alpha === null || event.beta === null || event.gamma === null) return null
  return parseHeadPosePacket({ yaw: -event.alpha, pitch: event.beta, roll: event.gamma }, 0)?.pose ?? null
}

/**
 * 单一活跃输入，重复连接会先释放旧输入。输出本地单调时间跨源/重连连续，
 * 设备时间仅作当前连接内的顺序校验，设备重启不阻止新连接。
 */
export class HeadTrackingInput {
  private generation = 0
  private cleanup: (() => Promise<void>) | undefined
  private staleTimer: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private lastArrival = -Infinity
  private lastTimestamp = -Infinity
  private hasPose = false
  private stalled = false
  private readonly bluetoothOwners = new WeakMap<object, number>()
  private readonly now: () => number
  private readonly staleAfter: number

  constructor(private readonly options: HeadTrackingInputOptions) {
    this.now = options.now ?? defaultNow
    this.staleAfter = positive(options.staleAfterMs, 1500)
  }

  async connectSerial(options: SerialHeadTrackingOptions = {}): Promise<void> {
    const token = await this.begin()
    if (token === null) return
    let port: SerialHeadTrackingPort | undefined
    let opened = false
    try {
      const serial = typeof navigator === 'undefined' ? undefined
        : (navigator as Navigator & { serial?: { requestPort: () => Promise<SerialHeadTrackingPort> } }).serial
      const requestPort = options.requestPort ?? (serial ? () => serial.requestPort() : undefined)
      if (!options.port && !requestPort) throw new Error('当前环境不支持 Web Serial')
      port = options.port ?? await requestPort!()
      if (token !== this.generation) return
      const baudRate = options.baudRate ?? 115200
      if (!Number.isInteger(baudRate) || baudRate <= 0 || baudRate > 4000000) throw new Error('串口波特率无效')
      await port.open({ baudRate }); opened = true
      if (token !== this.generation) { await port.close(); return }
      if (!port.readable) throw new Error('串口没有可读取的数据流')
      const reader = port.readable.getReader()
      const decoder = this.decoder(token)
      const textDecoder = new TextDecoder()
      const activePort = port
      this.connected(token)
      const reading = (async () => {
        try {
          while (token === this.generation) {
            const result = await reader.read()
            if (result.done || token !== this.generation) break
            decoder.push(textDecoder.decode(result.value, { stream: true }))
          }
        } catch (error) {
          if (token === this.generation) this.options.onStatus?.('error', errorMessage(error))
        } finally {
          decoder.reset()
          reader.releaseLock()
          try { await activePort.close() } catch { /* 拔掉设备时 close 可能拒绝，读锁仍已释放。 */ }
          if (token === this.generation) {
            this.stopStaleTimer(); this.clearPose()
            this.options.onStatus?.('disconnected')
          }
        }
      })()
      this.cleanup = async () => {
        try { await reader.cancel() } catch { /* 自然结束或断开后 reader 可能已解锁。 */ }
        await reading
      }
    } catch (error) {
      if (opened && port) { try { await port.close() } catch { /* 保留原始连接错误。 */ } }
      if (token === this.generation) { this.clearPose(); this.options.onStatus?.('error', errorMessage(error)) }
      throw error
    }
  }

  async connectWebSocket(url: string, options: WebSocketHeadTrackingOptions = {}): Promise<void> {
    const parsed = new URL(url)
    if (!['ws:', 'wss:'].includes(parsed.protocol)
      || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)
      || parsed.username || parsed.password) throw new Error('头追桥必须使用本机 ws:// 或 wss:// 地址')
    const token = await this.begin()
    if (token === null) return
    const reconnectDelay = options.reconnectDelayMs === 0 ? 0 : positive(options.reconnectDelayMs, 1000)
    const createSocket = options.createSocket ?? ((address: string) => new WebSocket(address))
    let detach: (() => void) | undefined
    this.cleanup = async () => { detach?.() }
    const connect = () => {
      if (token !== this.generation) return
      let socket: WebSocketHeadTrackingConnection
      try { socket = createSocket(url) } catch (error) {
        this.options.onStatus?.('error', errorMessage(error)); scheduleReconnect(); return
      }
      const decoder = this.decoder(token)
      let closed = false
      const opened: EventListener = () => { if (!closed) this.connected(token) }
      const message: EventListener = event => {
        if (closed || token !== this.generation) return
        const data = (event as MessageEvent<unknown>).data
        // 本地桥协议只接收 JSON 文本，二进制/Blob 不会触发异步乱序转换。
        if (typeof data === 'string' && data.trimStart().startsWith('{')) decoder.readPacket(data)
      }
      const close: EventListener = () => {
        if (closed) return
        release()
        if (token === this.generation) {
          this.stopStaleTimer(); this.clearPose(); scheduleReconnect()
        }
      }
      const error: EventListener = () => {
        if (closed) return
        if (token === this.generation) this.options.onStatus?.('error', '头追桥连接失败')
        close(new Event('close'))
      }
      const release = () => {
        if (closed) return
        closed = true; decoder.reset()
        socket.removeEventListener('open', opened); socket.removeEventListener('message', message)
        socket.removeEventListener('close', close); socket.removeEventListener('error', error)
        try { socket.close() } catch { /* 已关闭 socket 无需再次操作。 */ }
      }
      detach = release
      socket.addEventListener('open', opened); socket.addEventListener('message', message)
      socket.addEventListener('close', close); socket.addEventListener('error', error)
    }
    const scheduleReconnect = () => {
      if (token !== this.generation) return
      if (!reconnectDelay) { this.options.onStatus?.('disconnected'); return }
      this.options.onStatus?.('reconnecting')
      this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; connect() }, reconnectDelay)
    }
    connect()
  }

  /**
   * 必须由用户点击直接调用，选择器在第一次 await 之前触发，保留浏览器用户激活。
   * 两个 UUID 都必须由设备文档或用户提供；不扫描、不后台重试 BLE 选择器。
   * 有效完整姿态超时会释放通知并断开 GATT，重新连接须再次明确调用。
   */
  async connectBluetooth(options: BluetoothHeadTrackingOptions): Promise<void> {
    const serviceUuid = bluetoothUuid(options.serviceUuid)
    const characteristicUuid = bluetoothUuid(options.characteristicUuid)
    const bluetooth = typeof navigator === 'undefined' ? undefined
      : (navigator as Navigator & { bluetooth?: { requestDevice: NonNullable<BluetoothHeadTrackingOptions['requestDevice']> } }).bluetooth
    const requestDevice = options.requestDevice ?? (bluetooth ? (settings => bluetooth.requestDevice(settings)) : undefined)
    if (!options.device && !requestDevice) throw new Error('当前环境不支持 Web Bluetooth')
    const ready = this.begin()
    // 将选取失败转为已处理结果，旧连接的异步清理不会造成早到的未处理拒绝。
    let selected: Promise<{ device: BluetoothHeadTrackingDevice } | { error: unknown }>
    try {
      selected = (options.device ? Promise.resolve(options.device) : requestDevice!({
        filters: [{ services: [serviceUuid] }], optionalServices: [serviceUuid],
      })).then(device => ({ device }), error => ({ error }))
    } catch (error) { selected = Promise.resolve({ error }) }
    const token = await ready
    if (token === null) return
    const selection = await selected
    if (token !== this.generation) return
    if ('error' in selection) {
      this.options.onStatus?.('error', errorMessage(selection.error))
      throw selection.error
    }
    const device = selection.device
    const gatt = device.gatt
    if (!gatt) {
      this.options.onStatus?.('error', '所选蓝牙设备没有 GATT 服务')
      throw new Error('所选蓝牙设备没有 GATT 服务')
    }
    const decoder = this.decoder(token)
    this.bluetoothOwners.set(gatt, token)
    let textDecoder = new TextDecoder('utf-8', { fatal: true })
    let server: BluetoothHeadTrackingServer | undefined
    let characteristic: BluetoothHeadTrackingCharacteristic | undefined
    let active = true
    let notificationAttempted = false
    let droppedNotification = false
    let disconnectTarget: BluetoothHeadTrackingServer | undefined
    const isCurrent = () => active && token === this.generation
    const receive: EventListener = () => {
      if (!isCurrent()) return
      const value = characteristic?.value
      if (!value || !value.byteLength) return
      // 真实 BLE 通知通常远小于此值；限制每次解码的内存和 CPU 占用。
      if (value.byteLength > 8192) {
        decoder.reset(); textDecoder = new TextDecoder('utf-8', { fatal: true }); droppedNotification = true
        return
      }
      try {
        let text = textDecoder.decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength), { stream: true })
        if (droppedNotification) {
          const newline = text.search(/[\r\n]/)
          if (newline < 0) return
          text = text.slice(newline + 1); droppedNotification = false
        }
        decoder.push(text)
      } catch {
        decoder.reset(); textDecoder = new TextDecoder('utf-8', { fatal: true }); droppedNotification = true
      }
    }
    const release = async () => {
      active = false; decoder.reset()
      device.removeEventListener('gattserverdisconnected', disconnected)
      characteristic?.removeEventListener('characteristicvaluechanged', receive)
      if (notificationAttempted && characteristic && this.bluetoothOwners.get(characteristic) === token) {
        notificationAttempted = false
        // 请求停止在 GATT disconnect 前发出，但不让失去响应的设备阻塞 UI 断开。
        try { void characteristic.stopNotifications().catch(() => {}) } catch { /* 设备可能已经拔除。 */ }
      }
      const target = server ?? gatt
      if (disconnectTarget !== target && this.bluetoothOwners.get(gatt) === token) {
        disconnectTarget = target
        try { target.disconnect() } catch { /* 设备可能已经断开。 */ }
      }
    }
    const disconnected: EventListener = () => {
      if (!isCurrent()) return
      this.stopStaleTimer(); this.clearPose()
      void release()
      this.options.onStatus?.('disconnected')
    }
    this.cleanup = release
    device.addEventListener('gattserverdisconnected', disconnected)
    try {
      server = await gatt.connect()
      if (!isCurrent()) { await release(); return }
      const service = await server.getPrimaryService(serviceUuid)
      if (!isCurrent()) { await release(); return }
      characteristic = await service.getCharacteristic(characteristicUuid)
      if (!isCurrent()) { await release(); return }
      this.bluetoothOwners.set(characteristic, token)
      characteristic.addEventListener('characteristicvaluechanged', receive)
      notificationAttempted = true
      await characteristic.startNotifications()
      if (!isCurrent()) {
        // startNotifications 可能在取消之后才成功；再明确停止一次。
        notificationAttempted = true; await release(); return
      }
      this.connected(token, () => { void release() })
    } catch (error) {
      const report = isCurrent()
      await release()
      if (report) {
        this.stopStaleTimer(); this.clearPose()
        this.options.onStatus?.('error', errorMessage(error))
        throw error
      }
    }
  }

  async connectDeviceOrientation(options: DeviceOrientationHeadTrackingOptions = {}): Promise<void> {
    const token = await this.begin()
    if (token === null) return
    try {
      const Constructor = typeof DeviceOrientationEvent === 'undefined' ? undefined
        : DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> }
      const target = options.target ?? (typeof window === 'undefined' ? undefined : window)
      if (!target || (!Constructor && !options.target)) throw new Error('当前环境不支持设备方向传感器')
      const requestPermission = options.requestPermission ?? (Constructor?.requestPermission
        ? () => Constructor.requestPermission!() : undefined)
      if (requestPermission && await requestPermission() !== 'granted') throw new Error('设备方向传感器权限未授予')
      if (token !== this.generation) return
      const receive: EventListener = event => {
        const pose = deviceOrientationToHeadPose(event as DeviceOrientationEvent)
        if (pose) this.receive({ pose, timestamp: this.now() }, token)
      }
      target.addEventListener('deviceorientation', receive)
      this.cleanup = async () => { target.removeEventListener('deviceorientation', receive) }
      this.connected(token)
    } catch (error) {
      if (token === this.generation) { this.clearPose(); this.options.onStatus?.('error', errorMessage(error)) }
      throw error
    }
  }

  async disconnect(): Promise<void> {
    ++this.generation
    const cleanup = this.cleanup; this.cleanup = undefined
    this.stopTimers(); this.clearPose()
    await cleanup?.()
    this.options.onStatus?.('disconnected')
  }

  private async begin(): Promise<number | null> {
    const token = ++this.generation
    const cleanup = this.cleanup; this.cleanup = undefined
    this.stopTimers(); this.clearPose()
    await cleanup?.()
    if (token !== this.generation) return null
    this.options.onStatus?.('connecting')
    return token
  }

  private decoder(token: number): HeadPoseLineDecoder {
    return new HeadPoseLineDecoder({
      now: this.now, maxLineLength: this.options.maxLineLength,
      onSample: sample => this.receive(sample, token),
    })
  }

  private receive(sample: HeadPoseSample, token: number): void {
    if (token !== this.generation || !Number.isFinite(sample.timestamp)) return
    this.lastArrival = this.now()
    this.lastTimestamp = Math.max(sample.timestamp, this.lastTimestamp + 0.001)
    this.hasPose = true; this.stalled = false
    this.options.onPose(sample.pose, this.lastTimestamp)
    this.options.onStatus?.('connected')
  }

  private connected(token: number, onStale?: () => void): void {
    if (token !== this.generation) return
    this.stopStaleTimer()
    this.lastArrival = this.now(); this.stalled = false
    this.options.onStatus?.('connected')
    this.staleTimer = setInterval(() => {
      if (token !== this.generation || this.stalled || this.now() - this.lastArrival <= this.staleAfter) return
      this.clearPose(); this.stalled = true; this.options.onStatus?.('stalled', '姿态输入已中断')
      if (onStale) { this.stopStaleTimer(); onStale() }
    }, Math.min(250, Math.max(25, this.staleAfter / 2)))
  }

  private clearPose(): void {
    if (!this.hasPose) return
    this.hasPose = false
    const now = this.now()
    this.lastTimestamp = Math.max(Number.isFinite(now) ? now : 0, this.lastTimestamp + 0.001)
    this.options.onPose(null, this.lastTimestamp)
  }

  private stopStaleTimer(): void {
    if (this.staleTimer !== undefined) clearInterval(this.staleTimer)
    this.staleTimer = undefined
  }

  private stopTimers(): void {
    this.stopStaleTimer()
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function bluetoothUuid(value: string): string {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{4}|[0-9a-f]{8}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(value)) {
    throw new Error('请填写设备提供的蓝牙服务 UUID 和通知特征 UUID')
  }
  const lower = value.toLowerCase()
  return lower.length === 4 || lower.length === 8
    ? `${lower.padStart(8, '0')}-0000-1000-8000-00805f9b34fb` : lower
}
