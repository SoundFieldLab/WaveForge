import { describe, expect, it } from 'vitest'
import { playlistDetailSongs } from '../src/utils/playlistSongs'

describe('playlistDetailSongs', () => {
  it('读取网易云的 playlist.tracks 原始字段', () => {
    const data = {
      playlist: {
        tracks: [
          {
            id: 111,
            mid: 'aaa',
            name: '夜航',
            ar: [{ id: 5, name: '某人' }, { name: '合声' }],
            al: { id: 9, mid: 'alb', name: '专辑', picUrl: 'https://p/cover.jpg' },
            dt: 214000,
          },
        ],
      },
    }
    const songs = playlistDetailSongs(data, 'netease')
    expect(songs).toHaveLength(1)
    expect(songs[0]).toMatchObject({
      id: 111,
      mid: 'aaa',
      name: '夜航',
      duration: 214000,
      platform: 'netease',
    })
    expect(songs[0].artists.map(a => a.name)).toEqual(['某人', '合声'])
    expect(songs[0].album.picUrl).toBe('https://p/cover.jpg')
  })

  it('网易云空结果不再被当成「有 songs 字段」', () => {
    expect(playlistDetailSongs({ playlist: { tracks: [] } }, 'netease')).toEqual([])
    expect(playlistDetailSongs({ songs: [] }, 'netease')).toEqual([])
    expect(playlistDetailSongs(null, 'netease')).toEqual([])
  })

  it('读取 QQ 的 songlist，interval 按秒换算成毫秒并补封面', () => {
    const songs = playlistDetailSongs({
      songlist: [{
        id: 7, mid: 'qqmid', name: '夏日', interval: 245,
        singer: [{ id: 3, mid: 'sm', name: '歌手' }],
        albummid: 'ALBMID', albumname: '专辑名',
      }],
    }, 'qq')
    expect(songs[0]).toMatchObject({ id: 7, mid: 'qqmid', duration: 245000, platform: 'qq' })
    expect(songs[0].album.picUrl).toContain('ALBMID')
    expect(songs[0].album.mid).toBe('ALBMID')
  })

  it('QQ 已给毫秒时不再乘 1000', () => {
    const songs = playlistDetailSongs({ songlist: [{ id: 1, name: 'x', duration: 200000 }] }, 'qq')
    expect(songs[0].duration).toBe(200000)
  })

  it('已归一化的平台（kugou/apple/soda）直接透传并补 platform', () => {
    const songs = playlistDetailSongs({
      tracks: [{ id: 1, name: 'a', artists: [{ name: 'b' }], album: { name: '', picUrl: '' }, duration: 1000 }],
    }, 'kugou')
    expect(songs).toHaveLength(1)
    expect(songs[0].platform).toBe('kugou')
  })

  it('过滤没有 id / mid 的空壳曲目', () => {
    expect(playlistDetailSongs({ playlist: { tracks: [{ name: '空' }] } }, 'netease')).toEqual([])
  })
})
