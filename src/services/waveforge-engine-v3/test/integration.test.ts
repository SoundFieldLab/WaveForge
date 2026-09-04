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

// ---------------------------------------------------------------- stubs

class FakeNode {
  // WaveForge 侧 vitest 4：vi.fn() 需带实现签名才能赋给 V3AudioNodeLike 的鸭子类型接口
  connect = vi.fn((_dest: unknown) => undefined)
  disconnect = vi.fn(() => undefined)
  port: { postMessage: Mock<(msg: unknown) => void>; onmessage: ((e: { data: unknown }) => void) | null }
  onaudioprocess?: (e: unknown) => void
  constructor() {
    this.port = { postMessage: vi.fn((_msg: unknown) => undefined), onmessage: null }
  }
}

function makeHandle(opts?: { addModuleImpl?: () => Promise<void> }): {
  handle: V3HostHandle
  ctx: V3AudioContextLike
  masterGain: FakeNode
  analyser: FakeNode
  scriptNodes: FakeNode[]
} {
  const masterGain = new FakeNode()
  const analyser = new FakeNode()
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
  return { handle: { audioContext: ctx, masterGain, analyser }, ctx, masterGain, analyser, scriptNodes }
}

/** 注册 AudioWorkletNode 全局桩 */
function stubWorkletNode(): new (ctx: unknown, name: string, opts: unknown) => FakeNode {
  const cls = class AWNodeStub extends FakeNode {
    constructor(_ctx: unknown, _name: string, _opts: unknown) {
      super()
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
    // 接线被放弃，但 dispose 已恢复直连（masterGain 只连了 analyser）
    const connects = (masterGain.connect as ReturnType<typeof vi.fn>).mock.calls
    expect(connects.length).toBe(1)
    expect(connects[0][0]).toBe(analyser)
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
})

describe('EngineV3Host —— script 兜底模式（切换后音频真实经过 v3 处理）', () => {
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
