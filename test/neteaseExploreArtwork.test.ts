import { describe, expect, it } from 'vitest'
import { normalizeNeteaseResource } from '../src/features/neteaseExplore/model'

describe('netease explore resource artwork identity', () => {
  it('uses nested album artwork and action id when top-level fields are absent', () => {
    const resource = normalizeNeteaseResource({
      resourceType: 'playlist',
      action: 'orpheus://playlist?id=8848',
      uiElement: { mainTitle: { title: '推荐歌单' }, image: { picurl: 'https://p1.music.126.net/cover.jpg' } },
    }, 0)

    expect(resource?.id).toBe('8848')
    expect(resource?.coverUrl).toBe('https://p1.music.126.net/cover.jpg')
  })

  it('keeps a stable resource id instead of using the array index when available', () => {
    const resource = normalizeNeteaseResource({
      resourceId: 'playlist-42',
      resourceType: 'playlist',
      coverUrl: 'https://p1.music.126.net/cover.jpg',
      mainTitle: '固定推荐',
    }, 17)

    expect(resource?.id).toBe('playlist-42')
  })
})
