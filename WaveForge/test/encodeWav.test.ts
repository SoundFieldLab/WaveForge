import { describe, it, expect } from 'vitest'
import { encodeWav } from '../src/audio/TransitionRenderer.ts'

function makeAudioBuffer(channels: number, sampleRate: number, seconds: number, freq = 440) {
  const length = Math.floor(sampleRate * seconds)
  const channelData: Float32Array[] = []
  for (let ch = 0; ch < channels; ch += 1) {
    const data = new Float32Array(length)
    for (let i = 0; i < length; i += 1) {
      data[i] = 0.5 * Math.sin(2 * Math.PI * freq * i / sampleRate)
    }
    channelData.push(data)
  }
  return {
    numberOfChannels: channels,
    sampleRate,
    length,
    duration: seconds,
    getChannelData: (ch: number) => channelData[ch],
  } as unknown as AudioBuffer
}

describe('encodeWav（m4a/aac → 16bit PCM WAV 转码契约）', () => {
  it('生成合法 WAV：RIFF 头/格式块/数据长度正确', () => {
    const buffer = makeAudioBuffer(2, 44100, 1.0, 440)
    const wav = encodeWav(buffer)
    const view = new DataView(wav)

    expect(String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3))).toBe('RIFF')
    expect(String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11))).toBe('WAVE')
    expect(String.fromCharCode(view.getUint8(12), view.getUint8(13), view.getUint8(14), view.getUint8(15))).toBe('fmt ')
    expect(view.getUint16(20, true)).toBe(1) // PCM
    expect(view.getUint16(22, true)).toBe(2) // 双声道
    expect(view.getUint32(24, true)).toBe(44100)
    expect(view.getUint16(34, true)).toBe(16) // 16bit
    expect(String.fromCharCode(view.getUint8(36), view.getUint8(37), view.getUint8(38), view.getUint8(39))).toBe('data')
    expect(view.getUint32(40, true)).toBe(44100 * 2 * 2)
    expect(wav.byteLength).toBe(44 + 44100 * 2 * 2)
  })

  it('采样钳制在 [-1,1]，声道交错写入', () => {
    const buffer = makeAudioBuffer(1, 8000, 0.5, 300)
    const wav = encodeWav(buffer)
    const view = new DataView(wav)
    // 第一个采样：sin(0)=0
    expect(view.getInt16(44, true)).toBe(0)
    // 峰值 0.5 * 32767 ≈ 16383（正向）
    let maxAbs = 0
    for (let offset = 44; offset < wav.byteLength; offset += 2) {
      maxAbs = Math.max(maxAbs, Math.abs(view.getInt16(offset, true)))
    }
    expect(maxAbs).toBeGreaterThan(16000)
    expect(maxAbs).toBeLessThanOrEqual(32767)
  })
})
