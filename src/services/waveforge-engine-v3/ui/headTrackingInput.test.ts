import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  HeadPoseLineDecoder, HeadTrackingInput, deviceOrientationToHeadPose, parseHeadPosePacket,
  type HeadPoseSample, type SerialHeadTrackingPort, type WebSocketHeadTrackingConnection,
  type BluetoothHeadTrackingCharacteristic, type BluetoothHeadTrackingDevice,
  type BluetoothHeadTrackingServer,
} from './headTrackingInput'

afterEach(() => vi.useRealTimers())

describe('头追输入：格式、拆包和时序', () => {
  it('JSON 和 CSV 明确轴顺序，三列 CSV 使用本地时间', () => {
    expect(parseHeadPosePacket('12,-8,3', 42)).toEqual({ pose: { yaw: 12, pitch: -8, roll: 3 }, timestamp: 42 })
    expect(parseHeadPosePacket('100,12,-8,3', 42)).toEqual({
      pose: { yaw: 12, pitch: -8, roll: 3 }, timestamp: 42, deviceTimestamp: 100,
    })
    expect(parseHeadPosePacket('{"timestamp":100,"yaw":270,"pitch":2,"roll":-10}', 42)?.pose)
      .toEqual({ yaw: -90, pitch: 2, roll: -10 })
    for (const value of ['', '1,2', '1,2,', '{"yaw":1,"pitch":2}', '{"yaw":"1","pitch":2,"roll":3}',
      '{"yaw":1,"pitch":91,"roll":0}', '{"yaw":1e99,"pitch":0,"roll":0}', '[1,2,3]', 'NaN,2,3',
      '-1,2,3,4', '1,2,3,4,5']) {
      expect(parseHeadPosePacket(value, 42)).toBeNull()
    }
  })

  it('连续跨包 JSON/CRLF、CSV 能拼接；超长行后恢复且丢弃倒序设备时间', () => {
    const samples: HeadPoseSample[] = []
    const decoder = new HeadPoseLineDecoder({ onSample: sample => samples.push(sample), now: () => 500, maxLineLength: 128 })
    decoder.push('{"timestamp":1,"yaw":2,"pitch":');
    decoder.push('3,"roll":4}\r\n2,5,6,7\n')
    decoder.push('x'.repeat(1024))
    decoder.push(',8,9\n1,80,0,0\n2,90,0,0\n3,8,9,10\n')
    expect(samples.map(sample => sample.pose)).toEqual([
      { yaw: 2, pitch: 3, roll: 4 }, { yaw: 5, pitch: 6, roll: 7 }, { yaw: 8, pitch: 9, roll: 10 },
    ])
    expect(samples[1].timestamp).toBeGreaterThan(samples[0].timestamp)
    expect(samples[2].timestamp).toBeGreaterThan(samples[1].timestamp)
    decoder.push('{"yaw":30,')
    decoder.reset()
    decoder.push('1,4,5,6\n')
    expect(samples.at(-1)?.pose).toEqual({ yaw: 4, pitch: 5, roll: 6 })
  })
})

describe('头追输入：Web Serial', () => {
  it('流拆包后交付姿态；关闭会取消读流、释放锁并关闭串口，重连重置设备时间', async () => {
    const poses: ({ yaw: number; pitch: number; roll: number } | null)[] = []
    const first = serialPort()
    const input = new HeadTrackingInput({ onPose: pose => poses.push(pose), now: () => 100 })
    await input.connectSerial({ port: first.port })
    first.enqueue('10,5,')
    first.enqueue('6,7\n')
    await flush()
    expect(poses.at(-1)).toEqual({ yaw: 5, pitch: 6, roll: 7 })

    await input.disconnect()
    expect(first.cancel).toHaveBeenCalledOnce()
    expect(first.close).toHaveBeenCalledOnce()
    expect(first.port.readable?.locked).toBe(false)
    expect(poses.at(-1)).toBeNull()

    const second = serialPort()
    await input.connectSerial({ port: second.port })
    second.enqueue('1,8,9,10\n')
    await flush()
    expect(poses.at(-1)).toEqual({ yaw: 8, pitch: 9, roll: 10 })
    await input.disconnect()
  })

  it('串口自然断流会清除残缺行、清理资源和当前姿态', async () => {
    const poses: unknown[] = []
    const serial = serialPort()
    const input = new HeadTrackingInput({ onPose: pose => poses.push(pose), now: () => 100 })
    await input.connectSerial({ port: serial.port })
    serial.enqueue('1,2,3\n8,9,')
    await flush()
    serial.end()
    await flush()
    expect(poses).toContainEqual({ yaw: 1, pitch: 2, roll: 3 })
    expect(poses.at(-1)).toBeNull()
    expect(serial.close).toHaveBeenCalledOnce()
    await input.disconnect()
  })

  it('串口打开尚未完成时切断，完成后只关闭串口，不安装已失效读流', async () => {
    const serial = serialPort()
    let opened!: () => void
    serial.port.open = () => new Promise<void>(resolve => { opened = resolve })
    const poses: unknown[] = []
    const input = new HeadTrackingInput({ onPose: pose => poses.push(pose) })
    const pending = input.connectSerial({ port: serial.port })
    await flush()
    await input.disconnect()
    opened()
    await pending
    expect(serial.close).toHaveBeenCalledOnce()
    expect(serial.port.readable?.locked).toBe(false)
    expect(poses).toEqual([])
  })
})

describe('头追输入：本地 WebSocket 和设备方向', () => {
  it('WebSocket 校验消息，断流清姿态且自动重连，主动关闭会撤销重连', async () => {
    vi.useFakeTimers()
    const sockets: FakeSocket[] = []
    const poses: unknown[] = []
    const timestamps: number[] = []
    const input = new HeadTrackingInput({
      onPose: (pose, timestamp) => { poses.push(pose); if (pose) timestamps.push(timestamp) },
      now: () => 100,
    })
    await input.connectWebSocket('ws://127.0.0.1:8989/pose', {
      reconnectDelayMs: 50,
      createSocket: () => { const socket = new FakeSocket(); sockets.push(socket); return socket },
    })
    sockets[0].emit('open')
    sockets[0].message('{"timestamp":100,"yaw":20,"pitch":1,"roll":2}')
    sockets[0].message('{"timestamp":99,"yaw":90,"pitch":1,"roll":2}')
    sockets[0].message('{"yaw":"oops","pitch":1,"roll":2}')
    expect(poses.filter(Boolean)).toEqual([{ yaw: 20, pitch: 1, roll: 2 }])
    sockets[0].emit('close')
    expect(poses.at(-1)).toBeNull()
    await vi.advanceTimersByTimeAsync(50)
    expect(sockets).toHaveLength(2)
    sockets[1].emit('open')
    sockets[1].message('{"timestamp":1,"yaw":30,"pitch":1,"roll":2}')
    expect(poses.at(-1)).toEqual({ yaw: 30, pitch: 1, roll: 2 })
    expect(timestamps[1]).toBeGreaterThan(timestamps[0])
    await input.disconnect()
    expect(sockets[1].close).toHaveBeenCalledOnce()
    sockets[1].message('{"yaw":99,"pitch":0,"roll":0}')
    await vi.advanceTimersByTimeAsync(5000)
    expect(sockets).toHaveLength(2)
    expect(poses.at(-1)).toBeNull()
  })

  it('已连接但超过时限无姿态也会中断，后续有效姿态能恢复', async () => {
    vi.useFakeTimers()
    let clock = 0
    const socket = new FakeSocket()
    const poses: unknown[] = []
    const status: string[] = []
    const input = new HeadTrackingInput({
      onPose: pose => poses.push(pose), onStatus: state => status.push(state), now: () => clock, staleAfterMs: 100,
    })
    await input.connectWebSocket('ws://localhost:8989', { createSocket: () => socket })
    socket.emit('open')
    socket.message('{"yaw":10,"pitch":0,"roll":0}')
    clock = 500
    await vi.advanceTimersByTimeAsync(500)
    expect(poses.at(-1)).toBeNull()
    expect(status.at(-1)).toBe('stalled')
    socket.message('{"yaw":20,"pitch":0,"roll":0}')
    expect(poses.at(-1)).toEqual({ yaw: 20, pitch: 0, roll: 0 })
    expect(status.at(-1)).toBe('connected')
    await input.disconnect()
  })

  it('设备方向按屏幕朝上、顶边朝前的固定安装映射；空轴、权限失败不会接入', async () => {
    expect(deviceOrientationToHeadPose({ alpha: 30, beta: 10, gamma: 5 })).toEqual({ yaw: -30, pitch: 10, roll: 5 })
    expect(deviceOrientationToHeadPose({ alpha: null, beta: 0, gamma: 0 })).toBeNull()
    const target = new EventTarget()
    const poses: unknown[] = []
    const input = new HeadTrackingInput({ onPose: pose => poses.push(pose), now: () => 100 })
    await expect(input.connectDeviceOrientation({ target, requestPermission: async () => 'denied' })).rejects.toThrow()
    await input.connectDeviceOrientation({ target, requestPermission: async () => 'granted' })
    const event = new Event('deviceorientation')
    Object.assign(event, { alpha: 30, beta: 10, gamma: 5 })
    target.dispatchEvent(event)
    expect(poses.at(-1)).toEqual({ yaw: -30, pitch: 10, roll: 5 })
    await input.disconnect()
    target.dispatchEvent(event)
    expect(poses.at(-1)).toBeNull()
  })

  it('拒绝非本地 WebSocket 桥地址', async () => {
    const input = new HeadTrackingInput({ onPose: () => {} })
    await expect(input.connectWebSocket('wss://example.com/pose')).rejects.toThrow()
    await input.disconnect()
  })
})

describe('头追输入：用户配置 UUID 的 BLE GATT UART 通知', () => {
  const config = { serviceUuid: '12345678-1234-5678-1234-56789abcdef0', characteristicUuid: '12345678-1234-5678-1234-56789abcdef1' }

  it('选择器在点击调用栈内同步触发，并用配置 UUID 查找服务和通知特征', async () => {
    const ble = bluetoothDevice()
    const requestDevice = vi.fn(async () => ble.device)
    const input = new HeadTrackingInput({ onPose: () => {} })
    const pending = input.connectBluetooth({ ...config, requestDevice })
    expect(requestDevice).toHaveBeenCalledOnce()
    expect(requestDevice).toHaveBeenCalledWith({
      filters: [{ services: [config.serviceUuid] }], optionalServices: [config.serviceUuid],
    })
    await pending
    expect(ble.getPrimaryService).toHaveBeenCalledWith(config.serviceUuid)
    expect(ble.getCharacteristic).toHaveBeenCalledWith(config.characteristicUuid)
    expect(ble.characteristic.startNotifications).toHaveBeenCalledOnce()
    await input.disconnect()
  })

  it('通过真实 EventTarget 通知拆包读取 UTF8 JSON/CSV，长通知丢弃并在换行恢复', async () => {
    const ble = bluetoothDevice()
    const poses: unknown[] = []
    const input = new HeadTrackingInput({ onPose: pose => poses.push(pose), now: () => 100, maxLineLength: 128 })
    await input.connectBluetooth({ ...config, device: ble.device })
    ble.characteristic.notify('{"timestamp":1,"yaw":20,')
    expect(poses).toEqual([])
    ble.characteristic.notify('"pitch":2,"roll":3}\n2,30,4,5\n')
    expect(poses).toEqual([{ yaw: 20, pitch: 2, roll: 3 }, { yaw: 30, pitch: 4, roll: 5 }])
    ble.characteristic.notify('x'.repeat(4096) + '\n3,40,5,6\n')
    expect(poses.at(-1)).toEqual({ yaw: 40, pitch: 5, roll: 6 })
    ble.characteristic.notify('3,90,0,0\nNaN,2,3\n')
    expect(poses).toHaveLength(3)
    await input.disconnect()
    expect(ble.characteristic.stopNotifications).toHaveBeenCalledOnce()
    expect(ble.disconnect).toHaveBeenCalledOnce()
    const count = poses.length
    ble.characteristic.notify('4,99,0,0\n')
    ble.device.dispatchEvent(new Event('gattserverdisconnected'))
    expect(poses).toHaveLength(count)
    expect(poses.at(-1)).toBeNull()
  })

  it('设备断开会释放通知、丢弃残包并清空姿态；新连接不接续旧数据', async () => {
    const first = bluetoothDevice()
    const poses: unknown[] = []
    const input = new HeadTrackingInput({ onPose: pose => poses.push(pose), now: () => 100 })
    await input.connectBluetooth({ ...config, device: first.device })
    first.characteristic.notify('1,2,3\n{"yaw":99,')
    first.device.dispatchEvent(new Event('gattserverdisconnected'))
    await flush()
    expect(poses.at(-1)).toBeNull()
    const second = bluetoothDevice()
    await input.connectBluetooth({ ...config, device: second.device })
    second.characteristic.notify('1,4,5,6\n')
    expect(poses.at(-1)).toEqual({ yaw: 4, pitch: 5, roll: 6 })
    first.characteristic.notify('"pitch":0,"roll":0}\n')
    expect(poses.at(-1)).toEqual({ yaw: 4, pitch: 5, roll: 6 })
    await input.disconnect()
  })

  it('姿态超时会停止 BLE 通知、断开 GATT、清姿态，失效通知不回调', async () => {
    vi.useFakeTimers()
    const ble = bluetoothDevice()
    let clock = 0
    const poses: unknown[] = []
    const input = new HeadTrackingInput({ onPose: pose => poses.push(pose), now: () => clock, staleAfterMs: 100 })
    await input.connectBluetooth({ ...config, device: ble.device })
    ble.characteristic.notify('1,2,3\n')
    clock = 500
    await vi.advanceTimersByTimeAsync(500)
    expect(poses.at(-1)).toBeNull()
    expect(ble.characteristic.stopNotifications).toHaveBeenCalledOnce()
    expect(ble.disconnect).toHaveBeenCalledOnce()
    const count = poses.length
    ble.characteristic.notify('20,0,0\n')
    expect(poses).toHaveLength(count)
    await input.disconnect()
  })

  it('连接 GATT 进行中取消，稍后完成仍释放设备且不会启动通知', async () => {
    const ble = bluetoothDevice()
    let resolveConnect!: (server: BluetoothHeadTrackingServer) => void
    ble.device.gatt!.connect = () => new Promise(resolve => { resolveConnect = resolve })
    const poses: unknown[] = []
    const input = new HeadTrackingInput({ onPose: pose => poses.push(pose) })
    const pending = input.connectBluetooth({ ...config, device: ble.device })
    await flush()
    await input.disconnect()
    resolveConnect(ble.server)
    await pending
    expect(ble.disconnect).toHaveBeenCalled()
    expect(ble.characteristic.startNotifications).not.toHaveBeenCalled()
    expect(poses).toEqual([])
  })

  it('通知开启期间取消会移除监听，晚返回的通知开启也会再次停止', async () => {
    const ble = bluetoothDevice()
    let resolveNotifications!: () => void
    ble.characteristic.startNotifications = vi.fn(() => new Promise<void>(resolve => { resolveNotifications = resolve }))
    const poses: unknown[] = []
    const input = new HeadTrackingInput({ onPose: pose => poses.push(pose) })
    const pending = input.connectBluetooth({ ...config, device: ble.device })
    await flush()
    await input.disconnect()
    ble.characteristic.notify('1,2,3\n')
    resolveNotifications()
    await pending
    expect(ble.characteristic.stopNotifications).toHaveBeenCalled()
    expect(poses).toEqual([])
  })

  it('同设备快速重连后，旧 GATT 迟到成功不会误断开新连接', async () => {
    const ble = bluetoothDevice()
    let resolveFirst!: (server: BluetoothHeadTrackingServer) => void
    ble.device.gatt!.connect = vi.fn()
      .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValue(ble.server)
    const poses: unknown[] = []
    const input = new HeadTrackingInput({ onPose: pose => poses.push(pose), now: () => 100 })
    const first = input.connectBluetooth({ ...config, device: ble.device })
    await flush()
    await input.connectBluetooth({ ...config, device: ble.device })
    const disconnects = ble.disconnect.mock.calls.length
    resolveFirst(ble.server)
    await first
    expect(ble.disconnect).toHaveBeenCalledTimes(disconnects)
    ble.characteristic.notify('1,2,3\n')
    expect(poses.at(-1)).toEqual({ yaw: 1, pitch: 2, roll: 3 })
    await input.disconnect()
  })

  it('非法 UUID、未支持环境或 GATT 错误明确拒绝并释放已连接设备', async () => {
    const input = new HeadTrackingInput({ onPose: () => {} })
    await expect(input.connectBluetooth({ serviceUuid: 'not-a-uuid', characteristicUuid: 'bad' })).rejects.toThrow()
    await expect(input.connectBluetooth(config)).rejects.toThrow()
    const ble = bluetoothDevice()
    ble.getCharacteristic.mockRejectedValue(new Error('特征不存在'))
    await expect(input.connectBluetooth({ ...config, device: ble.device })).rejects.toThrow('特征不存在')
    expect(ble.disconnect).toHaveBeenCalledOnce()
    await input.disconnect()
  })
})

class FakeSocket extends EventTarget implements WebSocketHeadTrackingConnection {
  close = vi.fn(() => this.emit('close'))
  emit(type: string): void { this.dispatchEvent(new Event(type)) }
  message(data: unknown): void { this.dispatchEvent(new MessageEvent('message', { data })) }
}

function serialPort(): {
  port: SerialHeadTrackingPort; enqueue: (text: string) => void; end: () => void;
  cancel: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn>;
} {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const cancel = vi.fn()
  const close = vi.fn(async () => {})
  return {
    port: {
      open: async () => {},
      readable: new ReadableStream<Uint8Array>({ start: current => { controller = current }, cancel }),
      close,
    },
    enqueue: text => controller.enqueue(new TextEncoder().encode(text)), end: () => controller.close(), cancel, close,
  }
}

class FakeCharacteristic extends EventTarget implements BluetoothHeadTrackingCharacteristic {
  value: DataView | undefined
  startNotifications = vi.fn(async (): Promise<void> => {})
  stopNotifications = vi.fn(async (): Promise<void> => {})
  notify(text: string): void {
    const bytes = new TextEncoder().encode(text)
    // 模拟底层 characteristic.value 为带偏移 DataView，不能解码整个 backing buffer。
    const backing = new Uint8Array(bytes.length + 4); backing.set(bytes, 2)
    this.value = new DataView(backing.buffer, 2, bytes.length)
    this.dispatchEvent(new Event('characteristicvaluechanged'))
  }
}

function bluetoothDevice() {
  const characteristic = new FakeCharacteristic()
  const getCharacteristic = vi.fn(async (_uuid: string) => characteristic)
  const getPrimaryService = vi.fn(async (_uuid: string) => ({ getCharacteristic }))
  const disconnect = vi.fn()
  const server: BluetoothHeadTrackingServer = { getPrimaryService, disconnect }
  const device = Object.assign(new EventTarget(), { gatt: { ...server, connect: async () => server } }) satisfies BluetoothHeadTrackingDevice
  return { device, server, characteristic, getPrimaryService, getCharacteristic, disconnect }
}

async function flush(): Promise<void> { for (let i = 0; i < 20; i++) await Promise.resolve() }
