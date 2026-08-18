import { describe, it, expect, vi } from 'vitest'
import { AlbumGaplessService } from '../src/services/albumGapless.ts'

function createService() {
  const service = new AlbumGaplessService({
    getCurrentAudio: () => null,
    getCurrentTime: () => 0,
    getCurrentIndex: () => 0,
    getCurrentTrackKey: () => 'netease-0',
    getTargetVolume: () => 1,
    setOutputGain: vi.fn(),
    getOutputGain: () => 1,
    getPlayQueue: () => [],
    canAdvance: () => true,
    playAt: async () => true,
  })
  return service
}

describe('AlbumGaplessService 纯函数', () => {
  it('getSongAlbumKey 拼接 albumId 与 albumCover', () => {
    const service = createService()
    expect(service.getSongAlbumKey({ key: 'a', url: 'http://x', albumId: '123', albumCover: 'cover.jpg' }))
      .toBe('123:cover.jpg')
  })

  it('getSongAlbumKey 无 albumId 时返回空串', () => {
    const service = createService()
    expect(service.getSongAlbumKey({ key: 'a', url: 'http://x' })).toBe('')
    expect(service.getSongAlbumKey({ key: 'a', url: 'http://x', albumCover: 'c.jpg' })).toBe('')
  })

  it('未启用时 canAdvanceInAlbum 返回 false', () => {
    const service = createService()
    const queue = [
      { key: 'a', url: 'u1', albumId: '1', albumCover: 'c' },
      { key: 'b', url: 'u2', albumId: '1', albumCover: 'c' },
    ]
    expect(service.canAdvanceInAlbum(0, queue)).toBe(false)
  })

  it('启用专辑后，同专辑相邻曲目可推进', () => {
    const service = createService()
    const queue = [
      { key: 'a', url: 'u1', albumId: '1', albumCover: 'c' },
      { key: 'b', url: 'u2', albumId: '1', albumCover: 'c' },
      { key: 'c', url: 'u3', albumId: '2', albumCover: 'c' },
    ]
    expect(service.setEnabled(true, {}, '1:c')).toBe(true)
    expect(service.canAdvanceInAlbum(0, queue)).toBe(true)
    // 跨专辑边界不可推进
    expect(service.canAdvanceInAlbum(1, queue)).toBe(false)
    // 最后一首不可推进
    expect(service.canAdvanceInAlbum(2, queue)).toBe(false)
  })
})
