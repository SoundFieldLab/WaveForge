/**
 * 歌单详情 → 统一 Song[] 的归一化。
 *
 * `getPlaylistDetail` 的返回形状**因平台而异**，这是历史遗留：
 * - apple / kugou / soda / spotify：已经映射成 `tracks: Song[]`；
 * - netease：后端原样返回 `{ playlist: { tracks: [网易云原始字段 ar/al/dt] } }`；
 * - qq：后端原样返回 `{ songlist: [QQ 原始字段 singer/albummid/interval] }`。
 *
 * 只读 `data.songs` 会在 netease/QQ 上永远拿到空数组（共振加歌面板的「歌单没有读到曲目」就是这个问题）。
 * 这里统一收口，调用方不再各自猜键名。
 */
import type { MusicPlatform } from '../services/platforms'
import type { Song } from '../services/musicApi'

type RawRecord = Record<string, any>

function artistsOf(raw: any): Song['artists'] {
  return (Array.isArray(raw) ? raw : [])
    .map((artist: any) => ({
      id: Number(artist?.id || 0) || undefined,
      name: String(artist?.name || artist?.title || '').trim(),
      mid: artist?.mid || artist?.songmid || undefined,
    }))
    .filter((artist: Song['artists'][number]) => artist.name)
}

function neteaseSong(raw: RawRecord): Song {
  return {
    id: Number(raw.id || 0),
    mid: raw.mid || raw.songmid,
    name: raw.name || raw.songname || '未知歌曲',
    artists: artistsOf(raw.ar || raw.artists || raw.singer),
    album: {
      id: raw.al?.id || raw.album?.id,
      mid: raw.al?.mid || raw.album?.mid,
      name: raw.al?.name || raw.album?.name || '',
      picUrl: raw.al?.picUrl || raw.album?.picUrl || raw.cover || '',
    },
    // 网易云接口的 dt / duration 都是毫秒。
    duration: Number(raw.dt || raw.duration || 0),
    platform: 'netease',
  }
}

function qqSong(raw: RawRecord): Song {
  const seconds = Number(raw.interval || 0)
  const millis = Number(raw.duration || 0)
  const albumMid = raw.album?.mid || raw.albummid || ''
  return {
    id: Number(raw.id || raw.songid || 0),
    mid: raw.mid || raw.songmid,
    songType: raw.type ?? raw.songtype,
    name: raw.name || raw.songname || raw.title || '未知歌曲',
    artists: artistsOf(raw.artists || raw.singer),
    album: {
      id: raw.album?.id || raw.albumid,
      mid: albumMid || undefined,
      name: raw.album?.name || raw.albumname || raw.album?.title || '',
      picUrl: raw.album?.picUrl || (albumMid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${albumMid}.jpg` : ''),
    },
    // QQ：interval 是秒、duration 是毫秒，两者都可能出现。
    duration: millis > 0 ? millis : seconds * 1000,
    platform: 'qq',
  }
}

/** 把歌单详情的任意返回形状收敛成 Song[]（保持原有顺序，过滤掉没有 id/mid 的空壳）。 */
export function playlistDetailSongs(data: any, platform: MusicPlatform): Song[] {
  const raw: RawRecord[] = platform === 'qq'
    ? data?.songlist || data?.playlist?.tracks || data?.tracks || data?.songs || []
    : data?.playlist?.tracks || data?.songs || data?.tracks || data?.songlist || []
  if (!Array.isArray(raw)) return []

  if (platform === 'netease') return raw.map(neteaseSong).filter(song => song.id || song.mid)
  if (platform === 'qq') return raw.map(qqSong).filter(song => song.id || song.mid)
  // 其余平台的服务层已经返回 Song[]：补齐 platform 字段并过滤空壳。
  return raw
    .map(item => ({ ...item, platform: (item.platform || platform) as MusicPlatform }) as Song)
    .filter(song => song.appleId || song.appleLibraryId || song.id || song.mid)
}
