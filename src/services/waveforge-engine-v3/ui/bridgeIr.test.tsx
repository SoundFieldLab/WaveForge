// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { EngineV3 } from '../src/engine/EngineV3'
import type { V3EngineParams } from '../src/types'
import { createV3UiBridge } from './bridge'

describe('调音室 IR 参数桥', () => {
  it('导入 IR 后修改其他参数仍保留类型数组和完整样本', () => {
    const bridge = createV3UiBridge(new EngineV3(48000), 48000)
    const params = bridge.getParams()
    const ir = Float32Array.from([1, 0.5, 0.25])
    bridge.setParams({ ...params, reverb: { ...params.reverb, enabled: true, mode: 'convolution',
      convolution: { ...params.reverb.convolution, ir, irName: 'test.wav' } } })
    const next = bridge.getParams()
    expect(next.reverb.convolution.ir).toBeInstanceOf(Float32Array)
    expect(next.reverb.convolution.ir).toBe(ir)
    bridge.setParams({ ...next, reverb: { ...next.reverb, convolution: { ...next.reverb.convolution, mix: 0.7 } } })
    expect(bridge.getParams().reverb.convolution.ir).toBe(ir)
    expect(bridge.getParams().reverb.convolution.ir?.length).toBe(3)
  })
})

describe('调音室桥提交钩子（融合层统一提交路径）', () => {
  it('setParams 与 applyScene 都会通知 submit，提交的是桥内快照并保留 IR 引用', () => {
    const engine = new EngineV3(48000, 2)
    const submit = vi.fn()
    const bridge = createV3UiBridge(engine, 48000, { submit })
    expect(submit).not.toHaveBeenCalled() // 构造只初始化引擎，不算一次提交

    const params = bridge.getParams()
    const ir = Float32Array.from([1, 0.5])
    bridge.setParams({ ...params, reverb: { ...params.reverb, enabled: true, mode: 'convolution',
      convolution: { ...params.reverb.convolution, ir, irName: 'x.wav' } } })
    expect(submit).toHaveBeenCalledTimes(1)
    const submitted = submit.mock.calls[0][0] as V3EngineParams
    expect(submitted.reverb.convolution.ir).toBe(ir) // 克隆保留引用（不做 IR 内容 hash）
    expect(submitted).not.toBe(params) // 桥内克隆，不是调用方的可变对象
    expect(bridge.getParams().reverb.convolution.ir).toBe(ir)

    // applyScene 内部走 setParams，因此同样经过 submit（宿主下发/持久化不再被绕过）。
    bridge.applyScene('pop')
    expect(submit.mock.calls.length).toBeGreaterThan(1)
    const sceneSnapshot = submit.mock.calls.at(-1)![0] as V3EngineParams
    expect(sceneSnapshot.sceneId).toBe('pop')
    expect(bridge.getParams().sceneId).toBe('pop')
  })

  it('submit 可就地修订桥快照（融合层注入 ReplayGain 用），后续 getParams 读到修订值', () => {
    const bridge = createV3UiBridge(new EngineV3(48000, 2), 48000, {
      submit: (p) => {
        p.loudnessNormalization = { ...p.loudnessNormalization, replayGainDb: -3.5 }
      },
    })
    bridge.setParams(bridge.getParams())
    expect(bridge.getParams().loudnessNormalization.replayGainDb).toBe(-3.5)
  })

  it('不传 options 时行为不变：参数仍写入引擎和桥快照', () => {
    const bridge = createV3UiBridge(new EngineV3(48000, 2), 48000)
    const next = bridge.getParams()
    next.bassEnhancer.enabled = true
    bridge.setParams(next)
    expect(bridge.getParams().bassEnhancer.enabled).toBe(true)
    bridge.applyScene('pop')
    expect(bridge.getParams().sceneId).toBe('pop')
  })
})
