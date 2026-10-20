// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { listConvolutionIr, loadConvolutionIr, removeConvolutionIr, saveConvolutionIr, updateConvolutionIrPurpose } from './irStore'

describe('卷积 IR 库接线', () => {
  it('导入、按 ID 选择、采样率转换和删除可用于实际参数恢复', async () => {
    vi.stubGlobal('indexedDB', undefined)
    try {
      const source = Float32Array.from([1, 0.5, 0.25, 0.1])
      const saved = await saveConvolutionIr('耳机校正', 'headphoneCorrection', 48000, source)
      source[0] = 0
      expect((await listConvolutionIr()).some((entry) => entry.id === saved.id)).toBe(true)
      const loaded = await loadConvolutionIr(saved.id, 48000)
      expect(loaded?.ir[0]).toBe(1)
      expect(loaded?.metadata.purpose).toBe('headphoneCorrection')
      expect(await updateConvolutionIrPurpose(saved.id, 'speakerCorrection')).toBe(true)
      expect((await loadConvolutionIr(saved.id, 48000))?.metadata.purpose).toBe('speakerCorrection')
      const converted = await loadConvolutionIr(saved.id, 96000)
      expect(converted?.ir.length).toBe(8)
      expect(await removeConvolutionIr(saved.id)).toBe(true)
      expect(await loadConvolutionIr(saved.id, 48000)).toBeNull()
    } finally { vi.unstubAllGlobals() }
  })
})
