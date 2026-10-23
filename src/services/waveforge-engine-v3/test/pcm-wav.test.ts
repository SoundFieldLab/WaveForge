import { describe, expect, it } from 'vitest'
import { encodePcm16Wav } from '../src/dsp/PcmWav'

describe('16-bit PCM WAV 导出', () => {
  it('写入合法 RIFF 头和交错双声道样本', () => {
    const left = Float32Array.from([0, 1, -1])
    const right = Float32Array.from([0.5, -0.5, 0])
    const wav = encodePcm16Wav([left, right], 48000, 'plain')
    const view = new DataView(wav.buffer)
    const text = (start: number, end: number) => new TextDecoder().decode(wav.subarray(start, end))
    expect(text(0, 4)).toBe('RIFF')
    expect(text(8, 12)).toBe('WAVE')
    expect(text(36, 40)).toBe('data')
    expect(view.getUint32(4, true)).toBe(wav.length - 8)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(48000)
    expect(view.getUint32(40, true)).toBe(12)
    expect(Array.from({ length: 6 }, (_, i) => view.getInt16(44 + i * 2, true)))
      .toEqual([0, 16384, 32767, -16384, -32768, 0])
  })

  it('抖动模式可复现，非法声道长度会拒绝写入', () => {
    const silence = new Float32Array(256)
    const first = encodePcm16Wav([silence], 44100, 'tpdf')
    const second = encodePcm16Wav([silence], 44100, 'tpdf')
    expect(first).toEqual(second)
    expect(first).not.toEqual(encodePcm16Wav([silence], 44100, 'plain'))
    expect(() => encodePcm16Wav([silence, new Float32Array(1)], 44100)).toThrow('长度不一致')
  })
})
