import { describe, expect, it } from 'vitest'
import { prioritizeExplicitCandidates } from '../src/services/bilibiliApi'
import {
  BILIBILI_MV_DECLARATIONS,
  BILIBILI_MV_DECLARATION_MAP,
  getDeveloperBilibiliMvDeclaration,
} from '../src/data/bilibiliMvDeclarations'

describe('developer Bilibili MV declarations', () => {
  it('prioritizes user override before developer declaration and algorithm results', () => {
    const candidate = (bvid: string) => ({ video: { bvid }, score: 0 }) as any
    const algorithm = [candidate('BValgorithm1'), candidate('BV18A4m1N7Hc')]
    const developer = candidate('BV18A4m1N7Hc')
    const user = candidate('BVuser000001')

    expect(prioritizeExplicitCandidates(algorithm, user, developer).map(item => item.video.bvid)).toEqual([
      'BVuser000001',
      'BV18A4m1N7Hc',
      'BValgorithm1',
    ])
  })

  it('deduplicates when user and developer choose the same video', () => {
    const explicit = { video: { bvid: 'BV18A4m1N7Hc' }, score: 0 } as any
    const result = prioritizeExplicitCandidates([explicit], explicit, explicit)
    expect(result.map(item => item.video.bvid)).toEqual(['BV18A4m1N7Hc'])
  })

})
