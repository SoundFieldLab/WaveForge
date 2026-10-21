// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import { attachV3Engine, detachV3Engine, exportV3Wav, getV3Bridge } from '../attachV3Engine'

/**
 * SOFA/HRTF 数据源替身：真实实现走 IndexedDB（ui/hrtfStore），jsdom 下不可用。
 * 默认返回 null（= 使用内置 KEMAR，与无自定义数据集时一致），需要时按用例注入网格。
 */
const hrtfMock = vi.hoisted(() => ({
  readActiveHrtf: vi.fn(async (): Promise<unknown> => null),
  saveActiveHrtf: vi.fn(async () => undefined),
}))
vi.mock('../ui/hrtfStore', () => hrtfMock)

/** SoundTouch 实时前置链替身：jsdom 没有 audioWorklet，注册失败被融合层静默处理。 */
const soundTouchMock = vi.hoisted(() => ({
  register: vi.fn(async () => {
    throw new Error('jsdom 无 audioWorklet')
  }),
}))

vi.mock('@soundtouchjs/audio-worklet', () => ({
  SoundTouchNode: class extends EventTarget {
    static register = soundTouchMock.register
    readonly pitchSemitones = { setTargetAtTime: vi.fn() }
    readonly playbackRate = { setTargetAtTime: vi.fn() }
    readonly connect = vi.fn()
    readonly disconnect = vi.fn()
  },
}))

const SAMPLE_RATE = 48_000
const FRAMES = 128

type SaveStub = (bytes: Uint8Array, name: string) => Promise<{ ok: boolean; path?: string }>

/** 构造离散声道：values 只给需要非零的声道，其余为静音。 */
function makeChannels(count: number, values: Record<number, number> = {}): Float32Array[] {
  return Array.from({ length: count }, (_, index) => new Float32Array(FRAMES).fill(values[index] ?? 0))
}

async function attachForExport(channels: Float32Array[]) {
  vi.stubGlobal('AudioWorkletNode', undefined)
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(16) })))
  const node = { connect: vi.fn(), disconnect: vi.fn() }
  const context = {
    sampleRate: SAMPLE_RATE,
    createScriptProcessor: vi.fn(() => ({ ...node })),
    decodeAudioData: vi.fn(async () => ({
      length: channels[0].length,
      numberOfChannels: channels.length,
      getChannelData: (index: number) => channels[index],
    })),
  }
  const saved = vi.fn<SaveStub>(async () => ({ ok: true }))
  ;(window as unknown as { electron: { saveHseRenderedAudio: SaveStub } }).electron = { saveHseRenderedAudio: saved }
  await attachV3Engine({ audioContext: context, masterGain: node, analyser: node } as never)
  return { bridge: getV3Bridge(), saved }
}

function readWav(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

async function exportPlain(saved: ReturnType<typeof vi.fn<SaveStub>>, url: string): Promise<DataView> {
  await exportV3Wav(url, FRAMES / SAMPLE_RATE, { quantization: 'plain' })
  const [call] = saved.mock.calls as unknown as [Uint8Array, string][]
  return readWav(call[0])
}

afterEach(() => {
  detachV3Engine()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  hrtfMock.readActiveHrtf.mockReset()
  hrtfMock.readActiveHrtf.mockImplementation(async () => null)
  hrtfMock.saveActiveHrtf.mockReset()
  soundTouchMock.register.mockReset()
  delete (window as unknown as { electron?: unknown }).electron
})

describe('HSE 多声道离线 WAV 导出', () => {
  it.each([
    { name: '5.1 中心声道', values: [0, 0, 0.2, 0, 0, 0], expectedLeft: 0.2 * Math.SQRT1_2, expectedRight: 0.2 * Math.SQRT1_2 },
    { name: '四声道左环绕', values: [0, 0, 0.2, 0], expectedLeft: 0.1, expectedRight: 0 },
  ])('$name 按正确布局进入双声道 WAV', async ({ values, expectedLeft, expectedRight }) => {
    const channels = makeChannels(values.length, Object.fromEntries(
      values.map((value, index) => [index, value] as [number, number]).filter(([, value]) => value !== 0),
    ))
    const { bridge, saved } = await attachForExport(channels)
    bridge.setParams({ ...bridge.getParams(), bitPerfectBypass: true })
    const wav = await exportPlain(saved, 'test://layout')
    expect(wav.getInt16(44, true)).toBe(Math.round(expectedLeft * 32768))
    expect(wav.getInt16(46, true)).toBe(Math.round(expectedRight * 32768))
  })

  it('12 声道（7.1.4）输入不被截断到 8 声道：第 11 声道仍进入输出', async () => {
    // downmix 矩阵：声道 10 是高度左（heightL 系数 0.5），声道 11 是高度右。
    const channels = makeChannels(12, { 10: 0.2 })
    const { bridge, saved } = await attachForExport(channels)
    bridge.setParams({ ...bridge.getParams(), bitPerfectBypass: true })
    const wav = await exportPlain(saved, 'test://714')
    // 若仍按旧上限 8 截断，这一路的信号会整段消失（0）。
    expect(wav.getInt16(44, true)).toBe(Math.round(0.1 * 32768))
    expect(wav.getInt16(46, true)).toBe(0)
  })

  it('16 声道（三阶 Ambisonics 容器）全部离散声道送入引擎', async () => {
    const processSpy = vi.spyOn(EngineV3.prototype, 'process')
    const channels = makeChannels(16, { 11: 0.2 })
    const { bridge, saved } = await attachForExport(channels)
    bridge.setParams({ ...bridge.getParams(), bitPerfectBypass: true })
    const wav = await exportPlain(saved, 'test://ambix3')
    const inputCounts = processSpy.mock.calls.map((call) => (call[0] as Float32Array[]).length)
    expect(Math.max(...inputCounts)).toBe(16)
    expect(new Set(inputCounts)).toEqual(new Set([16]))
    // 高度右声道（11）保留：heightR = (9 + 11) * 0.5
    expect(wav.getInt16(46, true)).toBe(Math.round(0.1 * 32768))
  })

  it('导出前同步当前自定义 SOFA HRTF 数据集（与实时链一致）', async () => {
    // 替身网格：本用例把 EngineV3.setSpatialHrtf 整体短路，不进入真实 HRTF 准备。
    const grid = { azimuths: [0], elevations: [0], hrirLength: 1,
      left: Float32Array.from([1]), right: Float32Array.from([1]), sampleRate: SAMPLE_RATE, source: 'sofa-test' }
    hrtfMock.readActiveHrtf.mockResolvedValue(grid)
    const setHrtf = vi.spyOn(EngineV3.prototype, 'setSpatialHrtf').mockImplementation(() => undefined)
    const channels = makeChannels(2, { 0: 0.2 })
    const { bridge, saved } = await attachForExport(channels)
    // attach 阶段已经下发过一次（实时链），清空后单独观察离线导出。
    setHrtf.mockClear()
    await exportPlain(saved, 'test://sofa')
    // attach 一次 + 离线导出一次（都是 readActiveHrtf 的真实调用点）。
    expect(hrtfMock.readActiveHrtf.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(setHrtf).toHaveBeenCalledTimes(1)
    expect(setHrtf.mock.calls[0][0]).toBe(grid)
    expect(saved).toHaveBeenCalledTimes(1)
    // 宿主是模块级单例，spatialHrtf 会跨用例保留：显式清掉，避免污染后续用例
    // （否则后续 attach 会用替身网格调用真实 HRTF 准备而抛错）。
    bridge.setSpatialHrtf?.(null)
  })

  it('HRTF 数据库不可用（readActiveHrtf 抛错）时导出仍按内置 KEMAR 完成', async () => {
    hrtfMock.readActiveHrtf.mockRejectedValue(new Error('IndexedDB 不可用'))
    const channels = makeChannels(2, { 0: 0.2 })
    const { bridge, saved } = await attachForExport(channels)
    bridge.setParams({ ...bridge.getParams(), bitPerfectBypass: true })
    const wav = await exportPlain(saved, 'test://no-hrtf-db')
    expect(wav.getInt16(44, true)).toBe(Math.round(0.2 * 32768))
    expect(saved).toHaveBeenCalledTimes(1)
  })

  it('pitch 激活 + 多声道：前 L/R 走 Stretch，其余声道原样保留并一起送入引擎', async () => {
    const processSpy = vi.spyOn(EngineV3.prototype, 'process')
    const channels = makeChannels(12, { 11: 0.2 })
    const { bridge, saved } = await attachForExport(channels)
    const params = bridge.getParams()
    bridge.setParams({
      ...params,
      bitPerfectBypass: true,
      pitch: { ...params.pitch, enabled: true, semitones: 0, rate: 1.5 },
    })
    const wav = await exportPlain(saved, 'test://pitch-714')
    const inputCounts = processSpy.mock.calls.map((call) => (call[0] as Float32Array[]).length)
    // 旧实现会把整段下混成 2 声道（inputs.length === 2）从而丢掉 7.1.4 布局。
    expect(Math.max(...inputCounts)).toBe(12)
    expect(new Set(inputCounts)).toEqual(new Set([12]))
    // 高度右声道在拉伸后仍保留（输出首样本来自第 11 声道 × 0.5）。
    expect(wav.getInt16(46, true)).toBe(Math.round(0.1 * 32768))
  })
})
