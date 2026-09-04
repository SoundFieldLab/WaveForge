import { describe, expect, it } from 'vitest'
import { scaleAnalyzerSnapshotForFolia } from '../src/components/FoliaLyricsPage'

describe('Folia audio analyzer adapter', () => {
  it('converts normalized WaveForge bands to Folia 0..255 units', () => {
    const result = scaleAnalyzerSnapshotForFolia({ overall: 0.5, bass: 0.2, mid: 0.4, high: 0.8 })
    expect(result.overall).toBeCloseTo(127.5, 10)
    expect(result.bass).toBeCloseTo(51, 10)
    expect(result.lowMid).toBeCloseTo(76.5, 10)
    expect(result.mid).toBeCloseTo(102, 10)
    expect(result.vocal).toBeCloseTo(163.2, 10)
    expect(result.treble).toBeCloseTo(204, 10)
  })
})
