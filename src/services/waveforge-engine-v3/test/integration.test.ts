/**
 * EngineV3Host 单元测试 —— 引擎切换接线模块
 * 物理意义（切换正确性）：
 *  - attach：masterGain 全断 → 接入 v3 节点 → 连 analyser（防新旧双链并联打架）；
 *  - dispose：恢复 masterGain→analyser 直连（v2 dispose 同款语义）；
 *  - 幂等 / 竞态（异步注册期间被 dispose → 放弃接线且直连已恢复）；
 *  - script 兜底通路：onaudioprocess 里音频真实经过 EngineV3 处理（限幅生效）。
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { EngineV3Host, type V3AudioContextLike, type V3HostHandle } from '../src/integration/EngineV3Host'
import { createDefaultParams } from '../src/types'

let lastWorkletOptions: unknown = null

// ---------------------------------------------------------------- stubs

class FakeNode {
  // WaveForge 侧 vitest 4：vi.fn() 需带实现签名才能赋给 V3AudioNodeLike 的鸭子类型接口
  connect = vi.fn((dest: unknown) => {
    if (!dest) throw new TypeError('AudioNode.connect 需要有效目标节点')
    return undefined
  })
  disconnect = vi.fn(() => undefined)
  port: { postMessage: Mock<(msg: unknown, transfer?: Transferable[]) => void>; onmessage: ((e: { data: unknown }) => void) | null }
  onaudioprocess?: (e: unknown) => void
  constructor() {
    this.port = { postMessage: vi.fn((_msg: unknown, _transfer?: Transferable[]) => undefined), onmessage: null }
  }
}

function makeHandle(opts?: { addModuleImpl?: () => Promise<void>; withSplitter?: boolean }): {
  handle: V3HostHandle
  ctx: V3AudioContextLike
  masterGain: FakeNode
  analyser: FakeNode
  splitter: FakeNode | null
  scriptNodes: FakeNode[]
} {
  const masterGain = new FakeNode()
  const analyser = new FakeNode()
  const splitter = opts?.withSplitter ? new FakeNode() : null
  const scriptNodes: FakeNode[] = []
  const ctx: V3AudioContextLike = {
    sampleRate: 48000,
    audioWorklet: {
      addModule: vi.fn(opts?.addModuleImpl ?? (async () => {})),
    },
    createScriptProcessor: vi.fn((_bs: number, _i: number, _o: number) => {
      const n = new FakeNode()
      scriptNodes.push(n)
      return n
    }),
  }
  return {
    handle: { audioContext: ctx, masterGain, analyser, channelSplitterNode: splitter ?? undefined },
    ctx,
    masterGain,
    analyser,
    splitter,
    scriptNodes,
  }
}

/** 注册 AudioWorkletNode 全局桩 */
function stubWorkletNode(): new (ctx: unknown, name: string, opts: unknown) => FakeNode {
  const cls = class AWNodeStub extends FakeNode {
    constructor(_ctx: unknown, _name: string, _opts: unknown) {
      super()
      lastWorkletOptions = _opts
    }
  }
  vi.stubGlobal('AudioWorkletNode', cls)
  return cls
}

function fullScaleSine(n: number, fs: number, freq = 440): Float32Array {
  const x = new Float32Array(n)
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * freq * i) / fs)
  return x
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('EngineV3Host —— worklet 模式', () => {
  it('创建音频节点之前依次装载第三方模块，重连时重新注册到新上下文', async () => {
    stubWorkletNode()
    const urls = ['/custom-dsp.js']
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js', processingModuleUrls: urls })
    urls[0] = '/mutated.js'
    for (let attempt = 0; attempt < 2; attempt++) {
      const { handle, ctx } = makeHandle()
      await host.attach(handle)
      expect(ctx.audioWorklet!.addModule).toHaveBeenNthCalledWith(1, '/v3-worklet.js')
      expect(ctx.audioWorklet!.addModule).toHaveBeenNthCalledWith(2, '/custom-dsp.js')
      expect(host.getMode()).toBe('worklet')
      host.dispose()
    }
  })

  it('第三方模块失败时 worklet 模式恢复直连并拒绝接入', async () => {
    stubWorkletNode()
    const { handle, ctx, masterGain, analyser } = makeHandle()
    ctx.audioWorklet!.addModule = vi.fn(async (url: string) => {
      if (url === '/broken-dsp.js') throw new Error('module failed')
    })
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js', processingModuleUrls: ['/broken-dsp.js'] })
    await expect(host.attach(handle)).rejects.toThrow('no audio path')
    expect(masterGain.connect).toHaveBeenLastCalledWith(analyser)
  })

  it('Worklet 输入保留离散多声道，输出固定为双耳立体声', async () => {
    stubWorkletNode()
    const { handle } = makeHandle()
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    await host.attach(handle)
    expect(lastWorkletOptions).toMatchObject({
      numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2],
      channelCount: 32, channelCountMode: 'max', channelInterpretation: 'discrete',
    })
    host.dispose()
  })

  it('初次和重新挂接发送完整房间线索，普通参数更新只发送新增方向', async () => {
    stubWorkletNode()
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    const params = createDefaultParams(48000)
    params.spatial!.mode = 'instant'
    params.spatial!.hrtfInterp = 'spherical'
    params.spatial!.instant.room = 'hall'
    params.spatial!.instant.roomAmount = 0.5
    for (let attachIndex = 0; attachIndex < 2; attachIndex++) {
      const { handle, masterGain } = makeHandle()
      await host.attach(handle, params)
      const node = masterGain.connect.mock.calls[0][0] as FakeNode
      const [rawMessage, transfer] = node.port.postMessage.mock.calls.at(-1)!
      const message = rawMessage as { roomHrir: { direct: { entries: Array<[unknown, { irRealL: Float32Array }]> } } }
      expect(message).toMatchObject({ type: 'params', roomHrir: { entries: expect.any(Array) } })
      expect(message.roomHrir.direct.entries.length).toBeGreaterThan(0)
      expect(transfer).toContain(message.roomHrir.direct.entries[0][1].irRealL.buffer)
      host.setParams({ ...params, stereoWidth: 1.1 })
      expect(node.port.postMessage).toHaveBeenLastCalledWith({ type: 'params', params: { ...params, stereoWidth: 1.1 } })
      host.dispose()
    }
  })

  it('可序列化节点通过 port 注册和注销，函数节点在 Worklet 模式被明确拒绝', async () => {
    stubWorkletNode()
    const { handle, masterGain } = makeHandle()
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    await host.attach(handle)
    const node = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as FakeNode
    host.registerSerializableProcessingNode({ id: 'gain', kind: 'gain', leftGain: 0.5, rightGain: 0.5 })
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ type: 'register-node', config: { id: 'gain', kind: 'gain', leftGain: 0.5, rightGain: 0.5 } })
    expect(() => host.registerProcessingNode({ id: 'callback', processStereo: () => undefined })).toThrow('script 模式')
    expect(host.unregisterProcessingNode('gain')).toBe(true)
    expect(node.port.postMessage).toHaveBeenLastCalledWith({ type: 'unregister-node', id: 'gain' })
    host.dispose()
  })
  it('处理后输出同时接入左右声道分析分路，卸载后恢复原始分路', async () => {
    stubWorkletNode()
    const { handle, masterGain, splitter } = makeHandle({ withSplitter: true })
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    await host.attach(handle)

    const node = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as FakeNode
    expect(node.connect).toHaveBeenCalledWith(handle.analyser)
    expect(node.connect).toHaveBeenCalledWith(splitter)

    host.dispose()
    const restoredConnections = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls.slice(1).map(([dest]) => dest)
    expect(restoredConnections).toEqual([handle.analyser, splitter])
  })

  it('attach：masterGain 先全断 → 接 worklet 节点 → 连 analyser；参数已下发', async () => {
    stubWorkletNode()
    const { handle, masterGain, analyser } = makeHandle()
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    const params = createDefaultParams(48000)
    await host.attach(handle, params)

    expect(masterGain.disconnect).toHaveBeenCalledTimes(1)
    expect(masterGain.connect).toHaveBeenCalledTimes(1)
    expect(analyser.connect).not.toHaveBeenCalled() // analyser 是目标，不向外连
    const node = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as FakeNode
    expect(node).toBeTruthy()
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'params', params })
    expect(host.getMode()).toBe('worklet')
    host.dispose()
  })

  it('幂等：同一 handle 重复 attach 不重复接线', async () => {
    stubWorkletNode()
    const { handle, masterGain } = makeHandle()
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    await host.attach(handle)
    await host.attach(handle)
    expect(masterGain.connect).toHaveBeenCalledTimes(1)
    host.dispose()
  })

  it('dispose：断开节点 + masterGain 全断 + 恢复 masterGain→analyser 直连', async () => {
    stubWorkletNode()
    const { handle, masterGain, analyser } = makeHandle()
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    await host.attach(handle)
    const node = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as FakeNode

    host.dispose()
    expect(node.disconnect).toHaveBeenCalledTimes(1)
    expect(masterGain.disconnect).toHaveBeenCalled()
    // 恢复直连：masterGain.connect(analyser)
    const connects = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls
    expect(connects[connects.length - 1][0]).toBe(analyser)
    expect(host.getMode()).toBe(null)
  })

  it('竞态：addModule 挂起期间被 dispose → 放弃接线且 masterGain 直连已恢复', async () => {
    stubWorkletNode()
    let resolveAdd!: () => void
    const gate = new Promise<void>((res) => {
      resolveAdd = res
    })
    const { handle, masterGain, analyser } = makeHandle({ addModuleImpl: () => gate })
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    const attaching = host.attach(handle) // 挂起在 addModule
    host.dispose()
    resolveAdd()
    await attaching
    // 接线被放弃：dispose 与过期分支**各自**恢复一次直连（审计加固——过期分支此前
    // 直接 return，重 attach 到另一 handle 时本 handle 的 masterGain 会永久悬空）。
    // 两次 connect 目标相同（analyser），幂等无副作用，仅调用计数 +1。
    const connects = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls
    expect(connects.length).toBe(2)
    expect(connects[0][0]).toBe(analyser)
    expect(connects[1][0]).toBe(analyser)
    expect(host.getMode()).toBe(null)
  })

  it('setParams：主线程引擎 + worklet port 同步更新', async () => {
    stubWorkletNode()
    const { handle, masterGain } = makeHandle()
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    await host.attach(handle)
    const node = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as FakeNode
    node.port.postMessage.mockClear()
    const p = createDefaultParams(48000)
    host.setParams(p)
    expect(node.port.postMessage).toHaveBeenCalledWith({ type: 'params', params: p })
    host.dispose()
  })

  it('Worklet 已收到 IR 后，普通参数更新复用已装载数组', async () => {
    stubWorkletNode()
    const { handle, masterGain } = makeHandle()
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    const params = createDefaultParams(48000)
    const ir = Float32Array.from([1, 0.5, 0.25])
    params.reverb = { ...params.reverb, enabled: true, mode: 'convolution',
      convolution: { ...params.reverb.convolution, ir, irName: 'test.wav' } }
    await host.attach(handle, params)
    const node = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as FakeNode
    expect(node.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'params', reuseIr: false, irChanged: true, params,
    }))
    host.setParams({ ...params, stereoWidth: 1.1 })
    expect(node.port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'params', reuseIr: true,
      params: expect.objectContaining({ reverb: expect.objectContaining({ convolution: expect.objectContaining({ ir: null }) }) }),
    }))
    host.dispose()
  })

  it('大型 IR 的 FFT 分区与 Worklet scratch 在主线程预计算并一次性转移', async () => {
    stubWorkletNode()
    const { handle, masterGain } = makeHandle()
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    const params = createDefaultParams(48000)
    const ir = new Float32Array(8192)
    for (let i = 0; i < ir.length; i++) ir[i] = (i === 0 ? 1 : 0) + 0.1 * Math.exp(-i / 1000)
    params.reverb = { ...params.reverb, enabled: true, mode: 'convolution',
      convolution: { ...params.reverb.convolution, ir, irName: 'long-ir.wav' } }
    await host.attach(handle, params)
    const node = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as FakeNode
    const [firstMessage, firstTransfer] = node.port.postMessage.mock.calls.at(-1)!
    expect(firstMessage).toMatchObject({ type: 'params', irChanged: true,
      params: { reverb: { convolution: { ir: null } } },
      preparedConvolverIR: { irLength: ir.length, partitionSize: 512, numPartitions: 16, fftSize: 1024 } })
    expect(firstTransfer).toHaveLength(20)
    expect(firstTransfer!.every((item) => item instanceof ArrayBuffer)).toBe(true)

    const repartitioned = { ...params, reverb: { ...params.reverb,
      convolution: { ...params.reverb.convolution, partitionSize: 256 as const } } }
    host.setParams(repartitioned)
    const [repartitionMessage, repartitionTransfer] = node.port.postMessage.mock.calls.at(-1)!
    expect(repartitionMessage).toMatchObject({ irChanged: true,
      preparedConvolverIR: { irLength: ir.length, partitionSize: 256, numPartitions: 32, fftSize: 512 } })
    expect(repartitionTransfer).toHaveLength(20)

    host.setParams({ ...repartitioned, stereoWidth: 1.1 })
    const [reuseMessage, reuseTransfer] = node.port.postMessage.mock.calls.at(-1)!
    expect(reuseMessage).toMatchObject({ reuseIr: true, params: { reverb: { convolution: { ir: null } } } })
    expect(reuseMessage).not.toHaveProperty('preparedConvolverIR')
    expect(reuseTransfer).toBeUndefined()

    const invalidPartition = { ...repartitioned, reverb: { ...repartitioned.reverb,
      convolution: { ...repartitioned.reverb.convolution, partitionSize: 8192 as 512 } } }
    host.setParams(invalidPartition)
    const [fallbackMessage, fallbackTransfer] = node.port.postMessage.mock.calls.at(-1)!
    expect(fallbackMessage).toMatchObject({ irChanged: true,
      params: { reverb: { convolution: { ir: null } } },
      preparedConvolverIR: { partitionSize: 512, numPartitions: 16, fftSize: 1024 } })
    expect(fallbackTransfer).toHaveLength(20)
    host.dispose()
  })

  it('卷积关闭时将大型 IR 延迟到启用后再传输', async () => {
    stubWorkletNode()
    const { handle, masterGain } = makeHandle()
    const host = new EngineV3Host({ mode: 'worklet', workletUrl: '/v3-worklet.js' })
    const params = createDefaultParams(48000)
    const ir = new Float32Array(8192).fill(0.001)
    ir[0] = 1
    params.reverb.convolution.ir = ir
    params.reverb.convolution.irName = 'deferred.wav'
    params.reverb.enabled = false
    params.reverb.mode = 'convolution'
    await host.attach(handle, params)
    const node = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls[0][0] as FakeNode
    const [disabledMessage, disabledTransfer] = node.port.postMessage.mock.calls.at(-1)!
    expect(disabledMessage).toMatchObject({ type: 'params', irChanged: true,
      params: { reverb: { convolution: { ir: null } } } })
    expect(disabledMessage).not.toHaveProperty('preparedConvolverIR')
    expect(disabledTransfer).toBeUndefined()

    host.setParams({ ...params, reverb: { ...params.reverb, enabled: true } })
    const [enabledMessage, enabledTransfer] = node.port.postMessage.mock.calls.at(-1)!
    expect(enabledMessage).toMatchObject({ irChanged: true,
      preparedConvolverIR: { irLength: ir.length, partitionSize: 512, numPartitions: 16 },
      params: { reverb: { convolution: { ir: null } } } })
    expect(enabledTransfer).toHaveLength(20)
    host.dispose()
  })
})

describe('EngineV3Host —— script 兜底模式（切换后音频真实经过 v3 处理）', () => {
  it('组合节点保留深快照，调用者修改配置后重连与采样率重建不改变输出', async () => {
    const host = new EngineV3Host({ mode: 'script' })
    const coefficients = [0.5, 0.25]
    host.registerSerializableProcessingNode({ id: 'custom', kind: 'chain', nodes: [
      { id: 'fir', kind: 'fir', coefficients },
      { id: 'delay', kind: 'delay', samples: 2 },
    ] })
    coefficients.fill(0)
    const params = createDefaultParams(48000)
    params.eq.enabled = false; params.limiter.enabled = false
    host.setParams(params)
    for (const sampleRate of [48000, 96000]) {
      const { handle, ctx } = makeHandle()
      ctx.sampleRate = sampleRate
      await host.attach(handle)
      const input = new Float32Array(16); input[0] = 0.4
      const left = new Float32Array(16), right = new Float32Array(16)
      host.engine.process([input, input], [left, right])
      expect(left[2]).toBeCloseTo(0.2, 6)
      expect(left[3]).toBeCloseTo(0.1, 6)
      expect(right).toEqual(left)
      expect(host.engine.getLatencySamples()).toBe(2)
      host.dispose()
    }
  })

  it('预注册的函数节点在首次挂接和采样率重建后仍按原顺序处理 PCM', async () => {
    const host = new EngineV3Host({ mode: 'script' })
    const reset = vi.fn()
    host.registerProcessingNode({ id: 'offset', reset, processStereo: (left, right) => {
      for (let i = 0; i < left.length; i++) { left[i] += 0.2; right[i] += 0.2 }
    } })
    host.registerSerializableProcessingNode({ id: 'half', kind: 'gain', leftGain: 0.5, rightGain: 0.5 })
    const params = createDefaultParams(48000)
    params.eq.enabled = false
    params.limiter.enabled = false
    host.setParams(params)
    for (const sampleRate of [48000, 96000]) {
      const { handle, ctx, scriptNodes } = makeHandle()
      ctx.sampleRate = sampleRate
      await host.attach(handle)
      expect(host.engine.getProcessingNodes().map((node) => node.id)).toEqual(['offset', 'half'])
      const left = new Float32Array(128)
      const right = new Float32Array(128)
      scriptNodes[0].onaudioprocess!({
        inputBuffer: { getChannelData: () => new Float32Array(128).fill(0.4) },
        outputBuffer: { getChannelData: (channel: number) => channel === 0 ? left : right },
      })
      expect(left[127]).toBeCloseTo(0.3, 6)
      expect(right[127]).toBeCloseTo(0.3, 6)
      host.dispose()
    }
    expect(reset).toHaveBeenCalledTimes(2)
  })

  it('无 AudioWorkletNode 时自动回退 script；onaudioprocess 通路限幅生效', async () => {
    // WaveForge 的 test/setup.ts 为 v1 引擎测试全局 stub 了 AudioWorkletNode；
    // 此处以 undefined 覆盖（afterEach unstub 恢复），模拟"宿主无 worklet"环境
    vi.stubGlobal('AudioWorkletNode', undefined)
    const { handle, masterGain, scriptNodes } = makeHandle()
    const host = new EngineV3Host({ mode: 'auto', workletUrl: '/v3-worklet.js' })
    await host.attach(handle)
    expect(host.getMode()).toBe('script')
    expect(scriptNodes.length).toBe(1)
    expect(masterGain.connect).toHaveBeenCalledTimes(1)

    // 构造处理事件：满幅 440Hz 正弦 → v3 限幅（默认 -1dBFS）应压到 ≤0.9
    const sp = scriptNodes[0]
    const handler = sp.onaudioprocess!
    const fs = 48000
    const B = 4096
    const outMax = (_blockIdx: number) => {
      const inL = fullScaleSine(B, fs)
      const inR = new Float32Array(B)
      const outL = new Float32Array(B)
      const outR = new Float32Array(B)
      handler({
        inputBuffer: { getChannelData: (ch: number) => (ch === 0 ? inL : inR) },
        outputBuffer: { getChannelData: (ch: number) => (ch === 0 ? outL : outR) },
      })
      let m = 0
      for (let i = 0; i < B; i++) m = Math.max(m, Math.abs(outL[i]))
      return m
    }
    for (let b = 0; b < 4; b++) outMax(b) // 预热（限幅 lookahead + attack）
    const peak = outMax(4)
    expect(peak).toBeLessThanOrEqual(0.9) // -1dBFS ≈ 0.891，含平滑余量
    expect(peak).toBeGreaterThan(0.5) // 确实有信号通过（非静音）
    host.dispose()
  })

  it('worklet 注册失败也回退 script（auto）', async () => {
    stubWorkletNode()
    const { handle } = makeHandle({
      addModuleImpl: async () => {
        throw new Error('worklet module failed')
      },
    })
    const host = new EngineV3Host({ mode: 'auto', workletUrl: '/v3-worklet.js' })
    await host.attach(handle)
    expect(host.getMode()).toBe('script')
    host.dispose()
  })

  it('worklet 可用时 auto 优先 worklet', async () => {
    stubWorkletNode()
    const { handle } = makeHandle()
    const host = new EngineV3Host({ mode: 'auto', workletUrl: '/v3-worklet.js' })
    await host.attach(handle)
    expect(host.getMode()).toBe('worklet')
    host.dispose()
  })

  it('两种模式都不可用 → attach 抛错且 masterGain 直连已恢复', async () => {
    const { handle, masterGain, analyser } = makeHandle()
    // 去掉 audioWorklet 与 script
    ;(handle.audioContext as { audioWorklet?: unknown }).audioWorklet = undefined
    ;(handle.audioContext as { createScriptProcessor?: unknown }).createScriptProcessor = undefined
    const host = new EngineV3Host({ mode: 'auto', workletUrl: '/v3-worklet.js' })
    await expect(host.attach(handle)).rejects.toThrow('no audio path')
    const connects = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls
    expect(connects.length).toBe(1)
    expect(connects[0][0]).toBe(analyser)
  })
})
