/**
 * 音频线程帧边界与宿主消息零分配回归。
 *
 * 测量边界：只统计测试期间经过 globalThis 构造器（Array / Float32Array / Float64Array / Set）
 * 的显式构造。数组字面量与对象展开不会调用 globalThis.Array，因此“内部缓冲身份不变”断言
 * 用于补足字面量分配：帧边界若仍在新建合并数组，其 identity 必然变化。
 *
 * 真实音频图每个回调复用同一批 input/output Float32Array；测试同样复用，避免把测试自身的
 * 分配算进处理器。引擎内部（EngineV3 / 空间后端）的分配不属于本任务范围，测试中单独打印，
 * 不把跨代理的引擎进度写死成断言。
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDefaultParams } from '../src/types'

let Processor: new () => any
beforeAll(async () => {
  vi.stubGlobal('AudioWorkletProcessor', class { port = { onmessage: null, postMessage() {} } })
  vi.stubGlobal('sampleRate', 48000)
  Processor = (await import('../src/worklet/AudioEffectsProcessor')).AudioEffectsProcessor
})
afterAll(() => vi.unstubAllGlobals())

interface Counters { array: number; f32: number; f64: number; set: number }

/** 临时包装全局构造器计数；finally 一定恢复，避免污染同进程其他测试文件。 */
function measure(run: () => void): Counters {
  const counters: Counters = { array: 0, f32: 0, f64: 0, set: 0 }
  const targets: Array<[keyof Counters, string]> = [['array', 'Array'], ['f32', 'Float32Array'],
    ['f64', 'Float64Array'], ['set', 'Set']]
  const saved: Array<[string, unknown]> = []
  const g = globalThis as unknown as Record<string, unknown>
  for (const [key, name] of targets) {
    const original = g[name] as Function
    saved.push([name, original])
    g[name] = new Proxy(original, {
      construct(target, args, newTarget) { counters[key]++; return Reflect.construct(target, args, newTarget) },
      apply(target, thisArg, args) { counters[key]++; return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args) },
    })
  }
  try {
    run()
  } finally {
    for (const [name, original] of saved) g[name] = original
  }
  return counters
}

/** 预分配一帧的输入/输出（真实 AudioWorklet 每回调复用同一批缓冲）。 */
function makeFrame(channels: number, frames = 128, monoOutput = false): [Float32Array[][], Float32Array[][]] {
  const input = [Array.from({ length: channels }, () => new Float32Array(frames).fill(0.05))]
  const output = [Array.from({ length: monoOutput ? 1 : 2 }, () => new Float32Array(frames))]
  return [input, output]
}

const STEADY_MEASURED_FRAMES = 100

describe('音频线程帧边界零分配', () => {
  it('预热后连续 100 帧稳定渲染不新建 Array/Float32Array/Float64Array', () => {
    const processor = new Processor()
    const [input, output] = makeFrame(2, 128)
    // 预热覆盖 stats 回传周期（30 次回调）、分析存储与卷积/空间历史初始化
    for (let i = 0; i < 90; i++) processor.process(input, output, {})
    const counters = measure(() => {
      for (let i = 0; i < STEADY_MEASURED_FRAMES; i++) processor.process(input, output, {})
    })
    console.log('[alloc] 稳态 128 帧/双声道：', JSON.stringify(counters))
    expect(counters.array).toBe(0)
    expect(counters.f32).toBe(0)
    expect(counters.f64).toBe(0)
  })

  it('64 帧单声道输出与 64/128 块长切换不重新分配工作缓冲', () => {
    const processor = new Processor()
    const [in128, out128] = makeFrame(2, 128)
    const [in64, out64] = makeFrame(2, 64)
    const [in64m, out64m] = makeFrame(2, 64, true)
    const [in128m, out128m] = makeFrame(2, 128, true)
    // 预热同时覆盖 64/128 帧与单声道/双声道输出，工作缓冲在此完成一次性扩容
    for (let i = 0; i < 90; i++) {
      processor.process(i % 2 ? in64 : in128, i % 2 ? out64 : out128, {})
      processor.process(i % 2 ? in64m : in128m, i % 2 ? out64m : out128m, {})
    }
    const scratch = (processor as any).scratch as Float32Array
    const silence = (processor as any).silence as Float32Array
    const counters = measure(() => {
      for (let i = 0; i < STEADY_MEASURED_FRAMES; i++) {
        processor.process(i % 2 ? in64 : in128, i % 2 ? out64 : out128, {})
        processor.process(i % 2 ? in64m : in128m, i % 2 ? out64m : out128m, {})
      }
    })
    console.log('[alloc] 64/128 帧与单声道输出切换：', JSON.stringify(counters))
    expect(counters.array).toBe(0)
    expect(counters.f32).toBe(0)
    expect(counters.f64).toBe(0)
    // 块长切换只按需扩容一次：预热后工作缓冲必须是同一对象
    expect((processor as any).scratch).toBe(scratch)
    expect((processor as any).silence).toBe(silence)
  })

  it('连续下发相同内容参数消息后，帧边界不产生新的 Float32Array/Float64Array', () => {
    const processor = new Processor()
    const [input, output] = makeFrame(2, 128)
    const params = createDefaultParams(48000)
    for (let i = 0; i < 40; i++) processor.process(input, output, {})
    const roomBuffer = (processor as any).pendingRoomHrir
    const spatialBuffer = (processor as any).pendingSpatialHrtfRoom
    const seen: Counters[] = []
    for (let round = 0; round < 5; round++) {
      // 消息本身在帧回调之外投递；同步测试里直接调用 onmessage 等价于消息已到达
      processor.port.onmessage({ data: { type: 'params', params } })
      const counters = measure(() => processor.process(input, output, {}))
      seen.push(counters)
      for (let i = 0; i < 4; i++) processor.process(input, output, {})
    }
    console.log('[alloc] 相同参数消息帧（array/f32/f64）：', JSON.stringify(seen.map(c => [c.array, c.f32, c.f64])))
    for (const counters of seen) {
      // 配置帧只断言音频线程边界自身的 typed array；引擎内部对象分配由 engine-core 负责，
      // 不作为本测试的全局断言（array 计数仅打印，避免跨代理误报）。
      expect(counters.f32).toBe(0)
      expect(counters.f64).toBe(0)
    }
    // 帧边界复用预分配待处理缓冲：消息与帧回调都不替换内部列表对象
    expect((processor as any).pendingRoomHrir).toBe(roomBuffer)
    expect((processor as any).pendingSpatialHrtfRoom).toBe(spatialBuffer)
  })

  it('head-pose / spatial-hrtf 配置帧复用预分配缓冲且内部对象身份不变', () => {
    const processor = new Processor()
    const [input, output] = makeFrame(2, 128)
    const params = createDefaultParams(48000)
    params.spatial!.mode = 'instant'
    processor.port.onmessage({ data: { type: 'params', params } })
    for (let i = 0; i < 20; i++) processor.process(input, output, {})
    const roomBuffer = (processor as any).pendingRoomHrir
    const spatialBuffer = (processor as any).pendingSpatialHrtfRoom
    const mergedBuffer = (processor as any).roomHrirFrame

    // head-pose：先提交一次姿态，再重复提交同一姿态（配置无变化）
    processor.port.onmessage({ data: { type: 'head-pose', pose: { yaw: 20, pitch: 0, roll: 0 } } })
    processor.process(input, output, {})
    processor.port.onmessage({ data: { type: 'head-pose', pose: { yaw: 20, pitch: 0, roll: 0 } } })
    const poseCounters = measure(() => processor.process(input, output, {}))
    console.log('[alloc] head-pose 配置帧（同姿态）：', JSON.stringify(poseCounters))
    expect(poseCounters.f32).toBe(0)
    expect(poseCounters.f64).toBe(0)
    expect((processor as any).pendingRoomHrir).toBe(roomBuffer)

    // spatial-hrtf（恢复默认实测网格）
    processor.port.onmessage({ data: { type: 'spatial-hrtf', grid: null } })
    const hrtfCounters = measure(() => processor.process(input, output, {}))
    console.log('[alloc] spatial-hrtf 配置帧：', JSON.stringify(hrtfCounters))
    expect(hrtfCounters.f32).toBe(0)
    expect(hrtfCounters.f64).toBe(0)
    expect((processor as any).pendingSpatialHrtfRoom).toBe(spatialBuffer)

    // 三类消息在同一帧合流：合并缓冲必须是复用对象，不新建数组，顺序保持 spatial → 到达顺序
    const applyParams = vi.spyOn(processor.engine, 'setParams')
    processor.port.onmessage({ data: { type: 'spatial-hrtf', grid: null, roomHrir: { tag: 'grid' } } })
    processor.port.onmessage({ data: { type: 'head-pose', pose: { yaw: 21, pitch: 0, roll: 0 }, roomHrir: { tag: 'pose' } } })
    processor.port.onmessage({ data: { type: 'params', params, roomHrir: { tag: 'params' } } })
    const mergedCounters = measure(() => processor.process(input, output, {}))
    console.log('[alloc] 参数+姿态+空间数据集同帧合流：', JSON.stringify(mergedCounters))
    // 配置帧只断言工作线程边界的 typed array 与合并缓冲 identity；不全局断言引擎分配
    expect(mergedCounters.f32).toBe(0)
    expect(mergedCounters.f64).toBe(0)
    expect(applyParams).toHaveBeenCalledOnce()
    expect(applyParams.mock.calls[0][1]).toBe(mergedBuffer)
    expect(applyParams.mock.calls[0][1]).toEqual([{ tag: 'grid' }, { tag: 'pose' }, { tag: 'params' }])
    applyParams.mockRestore()
  })

  it('连续配置帧的合并缓冲 identity 始终不变（改动前每帧重建）', () => {
    const processor = new Processor()
    const [input, output] = makeFrame(2, 128)
    const params = createDefaultParams(48000)
    params.spatial!.mode = 'instant'
    processor.port.onmessage({ data: { type: 'params', params } })
    for (let i = 0; i < 10; i++) processor.process(input, output, {})
    const mergedBuffer = (processor as any).roomHrirFrame
    let identityChanges = 0
    const configFrames = 20
    for (let i = 0; i < configFrames; i++) {
      processor.port.onmessage({ data: { type: 'head-pose', pose: { yaw: i, pitch: 0, roll: 0 } } })
      processor.process(input, output, {})
      if ((processor as any).roomHrirFrame !== mergedBuffer) identityChanges++
    }
    console.log(`[alloc] ${configFrames} 个配置帧的合并缓冲 identity 变更次数：`, identityChanges)
    // 改动前每次配置帧都 \[...pendingSpatialHrtfRoom, ...pendingRoomHrir] 新建数组（20/20）；
    // 改动后固定复用 roomHrirFrame（0/20）。
    expect(identityChanges).toBe(0)
  })

  it('移动姿态的配置帧只在引擎侧重算 HRIR（本任务范围外，单独记录）', () => {
    const processor = new Processor()
    const [input, output] = makeFrame(2, 128)
    const params = createDefaultParams(48000)
    params.spatial!.mode = 'instant'
    processor.port.onmessage({ data: { type: 'params', params } })
    for (let i = 0; i < 20; i++) processor.process(input, output, {})
    processor.port.onmessage({ data: { type: 'head-pose', pose: { yaw: 25, pitch: 0, roll: 0 } } })
    const counters = measure(() => processor.process(input, output, {}))
    console.log('[alloc] head-pose 移动姿态配置帧（其中引擎侧 HRIR 重插值）：', JSON.stringify(counters))
    // 只记录：Float32Array 由空间后端 HRIR 重插值产生（EngineV3/空间代理负责），
    // 本任务只保证 Worklet 帧边界不新建数组/对象；array 计数为字面量观测值，不断言引擎分配。
  })
})
describe('预分配缓冲上限语义', () => {
  it('超限丢弃最旧并累计计数；同帧的数据集线索保持最前、不被丢弃', () => {
    const processor = new Processor()
    const params = createDefaultParams(48000)
    const applyParams = vi.spyOn(processor.engine, 'setParams').mockImplementation(() => {})
    processor.port.onmessage({ data: { type: 'spatial-hrtf', grid: null, roomHrir: { tag: 0, kind: 'grid' } } })
    // 256 条为容量上限，第 257 条触发“丢弃最旧”（第 1 条）
    for (let i = 1; i <= 257; i++) {
      processor.port.onmessage({ data: { type: 'head-pose', pose: { yaw: i % 90, pitch: 0, roll: 0 }, roomHrir: { tag: i } } })
    }
    expect((processor as any).droppedRoomHrir).toBe(1)
    // 再下发一条不携带房间线索的参数，让帧边界走 setParams 合流分支
    processor.port.onmessage({ data: { type: 'params', params } })
    processor.process([[new Float32Array(128), new Float32Array(128)]],
      [[new Float32Array(128), new Float32Array(128)]], {})
    const merged = applyParams.mock.calls[0][1] as Array<{ tag: number; kind?: string }>
    // 数据集线索固定在最前；增量按到达顺序，最旧的 tag=1 被丢弃，最新 tag=257 保留
    expect(merged).toHaveLength(257)
    expect(merged[0]).toEqual({ tag: 0, kind: 'grid' })
    expect(merged[1].tag).toBe(2)
    expect(merged[merged.length - 1].tag).toBe(257)
    // 计数随 stats 周期回传（复用 report 对象，不额外分配）
    for (let i = 0; i < 30; i++) processor.process([[new Float32Array(128)], [new Float32Array(128)]], [[new Float32Array(128), new Float32Array(128)]], {})
    expect((processor as any).report.timing.droppedRoomHrir).toBe(1)
    applyParams.mockRestore()
  })
})

describe('EngineV3Host 参数消息复用', () => {
  it('相同参数快照复用消息对象与骨架，无 transfer 时不构造 Set/数组', async () => {
    const posts: unknown[][] = []
    class NodeStub {
      port = { onmessage: null as ((e: { data: unknown }) => void) | null,
        postMessage: (...args: unknown[]) => { posts.push(args) } }
      connect(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('AudioWorkletNode', NodeStub)
    const { EngineV3Host } = await import('../src/integration/EngineV3Host')
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    const gain = { connect(): void {}, disconnect(): void {} }
    await host.attach({ audioContext: { sampleRate: 48000, audioWorklet: { addModule: async () => {} } },
      masterGain: gain, analyser: { connect(): void {}, disconnect(): void {} } })
    const params = createDefaultParams(48000)
    const paramsPosts = (): unknown[][] => posts.filter((args) => (args[0] as { type?: string })?.type === 'params')
    host.setParams(params)
    const first = paramsPosts().at(-1)!
    const before = paramsPosts().length
    const counters = measure(() => { host.setParams(params); host.setParams(params) })
    const after = paramsPosts()
    console.log('[alloc] host 复用相同参数快照：', JSON.stringify(counters))
    // 缓存命中：同一消息对象再次投递、单参数调用（不创建 transfer 数组/Set）
    expect(after.length).toBe(before + 2)
    expect(after.at(-1)![0]).toBe(first[0])
    expect(after.at(-1)!).toHaveLength(1)
    expect(counters.set).toBe(0)
    // 内容变化但骨架复用：消息对象 identity 不变，仅 params 字段更新
    const changed = { ...params, stereoWidth: 1.25 }
    host.setParams(changed)
    const last = paramsPosts().at(-1)!
    expect(last[0]).toBe(first[0])
    expect((last[0] as { params: { stereoWidth: number } }).params.stereoWidth).toBe(1.25)
    expect(last).toHaveLength(1)
    host.dispose()
  })
})
