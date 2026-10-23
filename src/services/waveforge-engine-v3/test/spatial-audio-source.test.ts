import { describe, expect, it, vi } from 'vitest'
import { decodeSpatialAudioFile, decodeSpatialWav } from '../src/integration/SpatialAudioSource'

function fixture(values: number[][], bits = 16, options: { encoding?: number; validBits?: number; mask?: number; extra?: boolean } = {}): ArrayBuffer {
  const channels = values.length, frames = values[0].length, sampleBytes = bits / 8
  const extensible = options.mask !== undefined || options.validBits !== undefined
  const fmtSize = extensible ? 40 : 16, dataSize = channels * frames * sampleBytes
  const extraSize = options.extra ? 10 : 0
  const dataAt = 12 + 8 + fmtSize + extraSize + 8
  const buffer = new ArrayBuffer(dataAt + dataSize + dataSize % 2), view = new DataView(buffer)
  const text = (at: number, value: string): void => { [...value].forEach((char, index) => view.setUint8(at + index, char.charCodeAt(0))) }
  text(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); text(8, 'WAVE')
  text(12, 'fmt '); view.setUint32(16, fmtSize, true)
  view.setUint16(20, extensible ? 0xfffe : options.encoding ?? 1, true)
  view.setUint16(22, channels, true); view.setUint32(24, 48000, true)
  view.setUint32(28, 48000 * channels * sampleBytes, true)
  view.setUint16(32, channels * sampleBytes, true); view.setUint16(34, bits, true)
  if (extensible) {
    view.setUint16(36, 22, true); view.setUint16(38, options.validBits ?? bits, true)
    view.setUint32(40, options.mask ?? 0, true); view.setUint32(44, options.encoding ?? 1, true)
    new Uint8Array(buffer).set([0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], 48)
  }
  if (options.extra) { text(dataAt - 18, 'JUNK'); view.setUint32(dataAt - 14, 1, true); view.setUint8(dataAt - 10, 99) }
  text(dataAt - 8, 'data'); view.setUint32(dataAt - 4, dataSize, true)
  for (let frame = 0; frame < frames; frame++) for (let channel = 0; channel < channels; channel++) {
    const at = dataAt + (frame * channels + channel) * sampleBytes, value = values[channel][frame]
    if (options.encoding === 3) {
      if (bits === 32) view.setFloat32(at, value, true)
      else view.setFloat64(at, value, true)
    } else if (bits === 8) view.setUint8(at, value)
    else if (bits === 16) view.setInt16(at, value, true)
    else if (bits === 24) {
      view.setUint8(at, value & 255); view.setUint8(at + 1, value >> 8 & 255); view.setUint8(at + 2, value >> 16 & 255)
    } else view.setInt32(at, value, true)
  }
  return buffer
}

describe('本地空间音频 PCM 输入适配', () => {
  it.each([
    [8, [0, 128, 255], [-1, 0, 127 / 128]],
    [16, [-32768, 0, 32767], [-1, 0, 32767 / 32768]],
    [24, [-8388608, -1, 8388607], [-1, -1 / 8388608, 8388607 / 8388608]],
    [32, [-2147483648, 0, 1073741824], [-1, 0, 0.5]],
  ] as const)('解码 %i 位真实 PCM 字节', (bits, raw, expected) => {
    const source = decodeSpatialWav(fixture([Array.from(raw)], bits, { extra: true }))
    expected.forEach((value, i) => expect(source.channels[0][i]).toBeCloseTo(value, 7))
    expect(source.sampleRate).toBe(48000)
    expect(source.frames).toBe(3)
    expect(source.channelLabels).toEqual(['FC'])
  })

  it.each([32, 64])('解码 IEEE float%i 并保留超出 0dBFS 的有限采样', bits => {
    const result = decodeSpatialWav(fixture([[1.25, -0.5, NaN, Infinity]], bits, { encoding: 3 }))
    expect(Array.from(result.channels[0])).toEqual([1.25, -0.5, 0, 0])
    expect(result.warnings).toHaveLength(1)
  })

  it('解码 extensible IEEE float GUID 并支持 Uint8Array 子视图', () => {
    const wav = fixture([[0.25, -0.5]], 32, { encoding: 3, mask: 4 })
    const wrapper = new Uint8Array(wav.byteLength + 10)
    wrapper.set(new Uint8Array(wav), 5)
    const result = decodeSpatialWav(wrapper.subarray(5, wrapper.length - 5))
    expect(result.encoding).toBe('float')
    expect(Array.from(result.channels[0])).toEqual([0.25, -0.5])
  })

  it('读取 extensible 左对齐 24 有效位 / 32 位容器', () => {
    const result = decodeSpatialWav(fixture([[-2147483648, -256, 1073741824]], 32, { validBits: 24, mask: 4 }))
    expect(result.validBitsPerSample).toBe(24)
    expect(Array.from(result.channels[0])).toEqual([-1, -1 / 8388608, 0.5])
  })

  it('按 WAVE mask 将 7.1 后/侧环绕重排为 HSE 输入顺序', () => {
    const result = decodeSpatialWav(fixture(Array.from({ length: 8 }, (_, i) => [(i + 1) * 1000]), 16, { mask: 0x63f }))
    expect(result.layout).toBe('71')
    expect(result.sourceChannelLabels).toEqual(['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'])
    expect(result.channelLabels).toEqual(['FL', 'FR', 'FC', 'LFE', 'SL', 'SR', 'BL', 'BR'])
    expect(result.channelMap).toEqual([0, 1, 2, 3, 6, 7, 4, 5])
    expect(result.channels.map(channel => channel[0])).toEqual(result.channelMap.map(index => (index + 1) * 1000 / 32768))
  })

  it('映射 Quad 和 7.1.4 的顶层平面而不猜测四声道 FOA', () => {
    const quad = decodeSpatialWav(fixture([[1], [2], [3], [4]], 16, { mask: 0x33 }))
    expect(quad.layout).toBe('quad')
    expect(quad.inputFormat).toBe('channels')
    expect(quad.sourceChannelLabels).toEqual(['FL', 'FR', 'BL', 'BR'])
    const result = decodeSpatialWav(fixture(Array.from({ length: 12 }, () => [0]), 16, { mask: 0x2d63f }))
    expect(result.layout).toBe('714')
    expect(result.channelLabels.slice(8)).toEqual(['topFL', 'topFR', 'topBL', 'topBR'])
    expect(result.channelMap).toEqual([0, 1, 2, 3, 6, 7, 4, 5, 8, 9, 10, 11])
  })

  it('无 mask 多声道必须显式提供标签，支持非标准顺序和目标重排', () => {
    const wav = fixture([[100], [200], [300], [400]])
    expect(() => decodeSpatialWav(wav)).toThrow(/不能根据声道数猜测/)
    const source = decodeSpatialWav(wav, { sourceChannelLabels: ['SR', 'FL', 'SL', 'FR'] })
    expect(source.channelMap).toEqual([1, 3, 2, 0])
    expect(source.layout).toBe('quad')
    const custom = decodeSpatialWav(wav, { sourceChannelLabels: ['a', 'b', 'c', 'd'], targetChannelLabels: ['d', 'c', 'b', 'a'] })
    expect(custom.layout).toBe('custom')
    expect(custom.channelMap).toEqual([3, 2, 1, 0])
    expect(() => decodeSpatialWav(wav, { sourceChannelLabels: ['a', 'a', 'c', 'd'] })).toThrow(/唯一/)
    const reordered = decodeSpatialWav(wav, { sourceChannelLabels: ['FL', 'FR', 'SL', 'SR'], targetChannelLabels: ['SR', 'SL', 'FR', 'FL'] })
    expect(reordered.layout).toBe('custom')
    expect(() => decodeSpatialWav(wav, { sourceChannelLabels: ['a', 'b', 'c', 'd'], targetChannelLabels: ['a', 'b', 'c', 'x'] })).toThrow(/一一对应/)
  })

  it('显式 AmbiX 保持原始 ACN 顺序并核对阶数', () => {
    const wav = fixture(Array.from({ length: 9 }, (_, i) => [i * 100]))
    const source = decodeSpatialWav(wav, { inputFormat: 'ambix2' })
    expect(source.layout).toBe('ambisonics')
    expect(source.channelMap).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(() => decodeSpatialWav(wav, { inputFormat: 'fuma' })).toThrow(/要求 4 声道/)
  })

  it('拒绝压缩 WAV、未知 mask、错误 GUID 及截断数据', () => {
    expect(() => decodeSpatialWav(fixture([[0]], 16, { encoding: 6 }))).toThrow(/压缩/)
    expect(() => decodeSpatialWav(fixture([[0]], 16, { mask: 0x80000000 }))).toThrow(/未知扬声器位/)
    expect(() => decodeSpatialWav(fixture([[0]], 16, { mask: 3 }))).toThrow(/置位数量/)
    const invalidGuid = fixture([[0]], 16, { mask: 4 })
    new DataView(invalidGuid).setUint8(48, 1)
    expect(() => decodeSpatialWav(invalidGuid)).toThrow(/GUID/)
    expect(() => decodeSpatialWav(fixture([[0]], 16).slice(0, -1))).toThrow(/RIFF 长度/)
    const malformed = fixture([[0]], 16)
    new DataView(malformed).setUint16(32, 3, true)
    expect(() => decodeSpatialWav(malformed)).toThrow(/blockAlign/)
  })

  it('拒绝非法有效位数、缺失 chunk、重复 chunk、RIFF 奇数填充及非完整帧', () => {
    expect(() => decodeSpatialWav(fixture([[0]], 16, { validBits: 17, mask: 4 }))).toThrow(/有效采样位数/)
    const shortExtension = fixture([[0]], 16, { mask: 4 })
    new DataView(shortExtension).setUint16(36, 100, true)
    expect(() => decodeSpatialWav(shortExtension)).toThrow(/扩展截断/)
    const missing = fixture([[0]])
    new Uint8Array(missing).set([74, 85, 78, 75], 36)
    expect(() => decodeSpatialWav(missing)).toThrow(/缺少完整/)
    const odd = fixture([[128]], 8)
    new DataView(odd).setUint32(4, odd.byteLength - 9, true)
    expect(() => decodeSpatialWav(odd)).toThrow(/填充字节/)
    const frame = fixture([[0]])
    new DataView(frame).setUint32(40, 1, true)
    expect(() => decodeSpatialWav(frame)).toThrow(/数据帧长度/)
  })

  it('WAV 异步读取优先走手工解码，错误不交给浏览器掩盖', async () => {
    const browser = { decodeAudioData: vi.fn() }
    const wav = fixture([[0, 16384]])
    const source = await decodeSpatialAudioFile({ name: 'local.wav', arrayBuffer: async () => wav }, browser)
    expect(source.channels[0][1]).toBe(0.5)
    expect(browser.decodeAudioData).not.toHaveBeenCalled()
    await expect(decodeSpatialAudioFile({ name: 'bad.wav', arrayBuffer: async () => new ArrayBuffer(0) }, browser)).rejects.toThrow(/RIFF/)
    expect(browser.decodeAudioData).not.toHaveBeenCalled()
  })

  it('浏览器后备保留各 PCM 平面并对无法验证的多声道顺序明确告警', async () => {
    const decoder = { decodeAudioData: vi.fn(async () => ({
      numberOfChannels: 4, sampleRate: 44100, length: 1,
      getChannelData: (index: number) => new Float32Array([index * 0.125]),
    })) }
    const file = { name: 'local.flac', arrayBuffer: async () => new ArrayBuffer(3) }
    const unknown = await decodeSpatialAudioFile(file, decoder)
    expect(unknown.channels.map(channel => channel[0])).toEqual([0, 0.125, 0.25, 0.375])
    expect(unknown.layout).toBe('unknown')
    expect(unknown.warnings).toHaveLength(1)
    const labeled = await decodeSpatialAudioFile(file, decoder, { sourceChannelLabels: ['FL', 'FR', 'SL', 'SR'] })
    expect(labeled.layout).toBe('quad')
    expect(labeled.warnings).toHaveLength(0)
  })
})
