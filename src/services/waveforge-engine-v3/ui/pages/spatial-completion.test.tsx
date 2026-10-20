// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { EngineV3 } from '../../src/engine/EngineV3'
import { CrosstalkCancellation } from '../../src/spatial/CrosstalkCancellation'
import { createV3UiBridge } from '../bridge'
import { useV3Params } from '../hooks'
import { useHSETheme } from '../hse-theme'
import type { HeadTrackingInputOptions } from '../headTrackingInput'
import SpatialAudioPage from './SpatialAudioPage'

// Only device access is replaced. Page events, HeadPoseFilter, EngineV3,
// parameter controller, bridge and all DSP setters remain real.
const devices = vi.hoisted(() => ({
  instances: [] as {
    options: HeadTrackingInputOptions
    connectSerial: ReturnType<typeof vi.fn>
    connectBluetooth: ReturnType<typeof vi.fn>
    connectWebSocket: ReturnType<typeof vi.fn>
    connectDeviceOrientation: ReturnType<typeof vi.fn>
    disconnect: ReturnType<typeof vi.fn>
  }[],
}))
vi.mock('../headTrackingInput', () => ({
  HeadTrackingInput: class {
    connectSerial = vi.fn(async () => {})
    connectBluetooth = vi.fn(async () => {})
    connectWebSocket = vi.fn(async () => {})
    connectDeviceOrientation = vi.fn(async () => {})
    disconnect = vi.fn(async () => {})
    constructor(readonly options: HeadTrackingInputOptions) { devices.instances.push(this) }
  },
}))

function setup() {
  const engine = new EngineV3(48000)
  const bridge = createV3UiBridge(engine, 48000)
  const params = bridge.getParams()
  params.spatial!.mode = 'instant'
  params.spatial!.instant.room = 'off'
  params.spatial!.instant.roomAmount = 0
  bridge.setParams(params)
  function Harness() {
    return <SpatialAudioPage bridge={bridge} controller={useV3Params(bridge)} theme={useHSETheme()} initialView="top" />
  }
  const view = render(<Harness />)
  return { engine, bridge, ...view }
}

function advanced(): void { fireEvent.click(screen.getByRole('button', { name: '设备与高级设置' })) }
function selectInputFormat(format: string): void {
  const summary = screen.getByText('音源与声道格式').closest('summary')!
  if (!summary.parentElement!.hasAttribute('open')) fireEvent.click(summary)
  fireEvent.change(screen.getByRole('combobox', { name: '音源格式' }), { target: { value: format } })
}
function calibration(): void {
  advanced()
  fireEvent.click(screen.getByText('摆位估算与测量文件'))
}
function changeNumber(label: string, value: number): void {
  fireEvent.change(screen.getByRole('spinbutton', { name: label }), { target: { value: String(value) } })
}

beforeEach(() => {
  devices.instances.length = 0
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

describe('空间页面完成度：真实参数与节点接线', () => {
  it.each([
    ['一阶 AmbiX', 'ambix', 4, 2],
    ['二阶 AmbiX', 'ambix2', 9, 3],
    ['三阶 AmbiX', 'ambix3', 16, 4],
  ] as const)('%s 选择进入引擎，显示相应阶数增益并接受匹配 PCM', (name, format, channels, gainCount) => {
    const { bridge, engine } = setup()
    selectInputFormat(format)
    expect(bridge.getParams().spatial!.inputFormat).toBe(format)
    expect((screen.getByRole('combobox', { name: '音源格式' }) as HTMLSelectElement).value).toBe(format)
    expect((screen.getByRole('option', { name: new RegExp(`^${name}`) }) as HTMLOptionElement).selected).toBe(true)
    advanced()
    expect(screen.getAllByRole('slider', { name: /^\d 阶增益$/ })).toHaveLength(gainCount)
    const input = Array.from({ length: channels }, () => new Float32Array(128))
    const output = [new Float32Array(128), new Float32Array(128)]
    engine.process(input, output)
    expect(bridge.getStats().spatialInputFormatValid).toBe(true)
    expect(output.every(channel => channel.every(Number.isFinite))).toBe(true)
  })

  it('三轴旋转和各阶增益分别更新同一真实参数快照，连续编辑保留先前值', () => {
    const { bridge } = setup()
    selectInputFormat('ambix3')
    advanced()
    changeNumber('声场右转 °', 35)
    changeNumber('声场抬头 °', -15)
    changeNumber('声场右倾 °', 20)
    fireEvent.change(screen.getByRole('slider', { name: '0 阶增益' }), { target: { value: '0.5' } })
    fireEvent.change(screen.getByRole('slider', { name: '2 阶增益' }), { target: { value: '1.25' } })
    fireEvent.change(screen.getByRole('slider', { name: '3 阶增益' }), { target: { value: '0.75' } })
    expect(bridge.getParams().spatial!.ambisonicTransform).toEqual({
      yawDeg: 35, pitchDeg: -15, rollDeg: 20, orderGains: [0.5, 1, 1.25, 0.75],
    })
  })

  it('5.1/7.1 上混选择更新真实音源格式，普通声道可恢复', () => {
    const { bridge, engine } = setup()
    for (const format of ['stereo51', 'stereo71'] as const) {
      selectInputFormat(format)
      expect(bridge.getParams().spatial!.inputFormat).toBe(format)
      const input = [new Float32Array(128), new Float32Array(128)]
      const output = [new Float32Array(128), new Float32Array(128)]
      engine.process(input, output)
      expect(bridge.getStats().spatialInputFormatValid).toBe(true)
      expect(screen.getByText(/从立体声派生环绕信号后，在耳机中试听。原文件仍为立体声/)).toBeTruthy()
    }
    selectInputFormat('channels')
    expect(bridge.getParams().spatial!.inputFormat).toBe('channels')
  })

  it('几何估算须显式应用，结果写入真实串扰节点并启用处理', () => {
    const { bridge } = setup()
    const nodeSettings = vi.spyOn(CrosstalkCancellation.prototype, 'setParams')
    calibration()
    const apply = screen.getByRole('button', { name: '应用校准参数' }) as HTMLButtonElement
    expect(apply.disabled).toBe(true)
    changeNumber('音箱间距 m', 2)
    changeNumber('听者距音箱前沿 m', 2)
    fireEvent.click(screen.getByRole('button', { name: '估算摆位参数' }))
    expect(screen.getByText(/已估算，请检查结果后应用/)).toBeTruthy()
    expect(bridge.getParams().spatial!.speakerCancellation?.enabled).toBe(false)
    expect(apply.disabled).toBe(false)
    fireEvent.click(apply)
    const settings = bridge.getParams().spatial!.speakerCancellation!
    expect(settings.enabled).toBe(true)
    expect(settings.delayMs).toBeGreaterThan(0.02)
    expect(settings.delayMs).toBeLessThan(1.5)
    expect(settings.cutoffHz).toBeGreaterThanOrEqual(200)
    expect(nodeSettings).toHaveBeenLastCalledWith(settings)
    expect(screen.getByRole('switch', { name: '启用双音箱串扰消除' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText('已将校准参数应用到串扰消除。')).toBeTruthy()
  })

  it('不对称摆位明确呈现单组参数的近似限制', () => {
    setup()
    calibration()
    changeNumber('听者向右偏移 m', 0.6)
    fireEvent.click(screen.getByRole('button', { name: '估算摆位参数' }))
    expect(screen.getByText(/左右声路不对称超出单组参数的近似范围/)).toBeTruthy()
  })
})

describe('空间页面完成度：头追入口和生命周期', () => {
  it('事件输入经过真实姿态滤波和桥接后启用重置朝向，关闭移除事件与设备回调', async () => {
    const { bridge } = setup()
    const headPose = vi.spyOn(bridge, 'setSpatialHeadPose')
    advanced()
    const recenter = screen.getByRole('button', { name: '以当前方向校准朝前' }) as HTMLButtonElement
    expect(recenter.disabled).toBe(true)
    fireEvent.click(screen.getByRole('switch', { name: '启用头部追踪输入' }))
    expect(devices.instances).toHaveLength(1)
    const device = devices.instances[0]
    act(() => window.dispatchEvent(new CustomEvent('hse:head-pose', {
      detail: { yaw: 40, pitch: 5, roll: -3, timestamp: 1000 },
    })))
    expect(headPose).toHaveBeenLastCalledWith({ yaw: 40, pitch: 5, roll: -3 })
    expect(recenter.disabled).toBe(false)
    fireEvent.click(recenter)
    expect(headPose).toHaveBeenLastCalledWith({ yaw: 0, pitch: 0, roll: 0 })
    fireEvent.click(screen.getByRole('switch', { name: '启用头部追踪输入' }))
    await waitFor(() => expect(device.disconnect).toHaveBeenCalledOnce())
    expect(headPose).toHaveBeenLastCalledWith(null)
    const calls = headPose.mock.calls.length
    act(() => {
      window.dispatchEvent(new CustomEvent('hse:head-pose', { detail: { yaw: 80, pitch: 0, roll: 0, timestamp: 2000 } }))
      device.options.onPose({ yaw: 90, pitch: 0, roll: 0 }, 3000)
    })
    expect(headPose).toHaveBeenCalledTimes(calls)
    expect(recenter.disabled).toBe(true)
  })

  it('串口/OSC/方向传感器/BLE 按页面配置调用；BLE 收到姿态后可校准，卸载释放设备', async () => {
    const { bridge, unmount } = setup()
    const headPose = vi.spyOn(bridge, 'setSpatialHeadPose')
    advanced()
    fireEvent.click(screen.getByRole('switch', { name: '启用头部追踪输入' }))
    const device = devices.instances[0]
    fireEvent.click(screen.getByRole('button', { name: '连接串口头追' }))
    expect(device.connectSerial).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '连接设备方向传感器' }))
    expect(device.connectDeviceOrientation).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByRole('textbox', { name: '本机姿态桥地址' }), {
      target: { value: 'ws://127.0.0.1:8990/pose' },
    })
    fireEvent.click(screen.getByRole('button', { name: '连接 OSC / 蓝牙姿态桥' }))
    expect(device.connectWebSocket).toHaveBeenCalledWith('ws://127.0.0.1:8990/pose')
    const connectBle = screen.getByRole('button', { name: '连接蓝牙头追' }) as HTMLButtonElement
    expect(connectBle.disabled).toBe(true)
    const serviceUuid = '12345678-1234-5678-1234-56789abcdef0'
    const characteristicUuid = '12345678-1234-5678-1234-56789abcdef1'
    fireEvent.change(screen.getByRole('textbox', { name: '蓝牙服务 UUID' }), { target: { value: serviceUuid } })
    fireEvent.change(screen.getByRole('textbox', { name: '蓝牙通知特征 UUID' }), { target: { value: characteristicUuid } })
    expect(connectBle.disabled).toBe(false)
    fireEvent.click(connectBle)
    expect(device.connectBluetooth).toHaveBeenCalledWith({ serviceUuid, characteristicUuid })
    act(() => device.options.onPose({ yaw: -20, pitch: 2, roll: 3 }, 1000))
    expect(headPose).toHaveBeenLastCalledWith({ yaw: -20, pitch: 2, roll: 3 })
    expect((screen.getByRole('button', { name: '以当前方向校准朝前' }) as HTMLButtonElement).disabled).toBe(false)
    unmount()
    await waitFor(() => expect(device.disconnect).toHaveBeenCalledOnce())
    expect(headPose).toHaveBeenLastCalledWith(null)
    const calls = headPose.mock.calls.length
    act(() => device.options.onPose({ yaw: 60, pitch: 0, roll: 0 }, 2000))
    expect(headPose).toHaveBeenCalledTimes(calls)
  })
})
