import { describe, expect, it } from 'vitest'
import { detectKugouActualLevel } from '../server/kugou-gateway.mjs'

describe('kugou-gateway 实际档位探测（detectKugouActualLevel）', () => {
  it('ext=flac 且高码率 → hires（酷狗 high 档 flac）', () => {
    expect(detectKugouActualLevel({ data: [{ bitrate: 1964, ext: 'flac' }] })).toBe('hires')
  })

  it('ext=flac 中等码率 → lossless', () => {
    expect(detectKugouActualLevel({ data: [{ bitrate: 950, ext: 'flac' }] })).toBe('lossless')
  })

  it('ext=mp3 + bitrate 320 → exhigh', () => {
    expect(detectKugouActualLevel({ data: [{ bitrate: 320, ext: 'mp3' }] })).toBe('exhigh')
  })

  it('ext=mp3 + bitrate 128 → standard', () => {
    expect(detectKugouActualLevel({ data: [{ bitrate: 128, ext: 'mp3' }] })).toBe('standard')
  })

  it('无 ext 时按 bitrate 推断（900+ → lossless）', () => {
    expect(detectKugouActualLevel({ data: [{ bitrate: 1024 }] })).toBe('lossless')
    expect(detectKugouActualLevel({ data: [{ bitrate: 320 }] })).toBe('exhigh')
    expect(detectKugouActualLevel({ data: [{ bitrate: 128 }] })).toBe('standard')
  })

  it('data 为数组时取第一项', () => {
    expect(detectKugouActualLevel({ data: [{ bitrate: 128, ext: 'mp3' }, { bitrate: 950, ext: 'flac' }] })).toBe('standard')
  })

  it('读不到任何信号 → null（调用方按请求档兜底并标 levelUnverified）', () => {
    expect(detectKugouActualLevel({ data: [{}] })).toBeNull()
    expect(detectKugouActualLevel({ status: 1 })).toBeNull()
    expect(detectKugouActualLevel(null)).toBeNull()
  })
})
