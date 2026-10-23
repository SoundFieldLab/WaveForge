import { describe, expect, it } from 'vitest'
import { ConvolutionIrLibrary } from '../src/dsp/ConvolutionIrLibrary'

describe('卷积 IR 库', () => {
  it('按用途注册并以副本读回校正 IR，避免外部修改内部数据', () => {
    const library = new ConvolutionIrLibrary(2)
    const ir = Float32Array.from([1, 0.5, 0.1])
    const metadata = library.register('headphones-a', ir, { name: '耳机 A', purpose: 'headphoneCorrection', sampleRate: 48000 })
    ir[0] = 0
    const loaded = library.get('headphones-a')!
    expect(metadata).toEqual({ id: 'headphones-a', name: '耳机 A', purpose: 'headphoneCorrection', sampleRate: 48000, sampleCount: 3 })
    expect(loaded[0]).toBe(1)
    loaded[1] = 0
    expect(library.get('headphones-a')![1]).toBe(0.5)
  })

  it('替换同 ID、容量上限和删除均保持可预测', () => {
    const library = new ConvolutionIrLibrary(1)
    library.register('room', new Float32Array([1]), { name: '房间', purpose: 'roomCorrection', sampleRate: 48000 })
    library.register('room', new Float32Array([1, 0.2]), { name: '房间新版', purpose: 'roomCorrection', sampleRate: 96000 })
    expect(library.list()).toHaveLength(1)
    expect(library.getMetadata('room')?.sampleRate).toBe(96000)
    expect(() => library.register('speaker', new Float32Array([1]), { name: '扬声器', purpose: 'speakerCorrection', sampleRate: 48000 })).toThrow('capacity')
    expect(library.remove('room')).toBe(true)
    expect(library.get('room')).toBeNull()
  })
})

