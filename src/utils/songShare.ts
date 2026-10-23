import type { Song } from '../services/musicApi'
import { buildKugouSongLink } from '../services/kugouService'

/**
 * 歌曲分享链接：按平台生成官方网页直链（复制到剪贴板即分享）。
 * 只收录确认无误的官方 URL 格式；无把握的平台返回 null（调用方提示不支持）。
 */
export function buildSongShareUrl(song: Song): string | null {
  if (!song) return null
  const platform = song.platform
  if (platform === 'netease' && song.id) return `https://music.163.com/song?id=${song.id}`
  if (platform === 'qq' && song.mid) return `https://y.qq.com/n/ryqq/songDetail/${song.mid}`
  if (platform === 'apple' && song.appleId) return `https://music.apple.com/cn/song/${song.appleId}`
  // 酷狗：官方歌曲页（hash + album_id，与右键「复制链接」同一构造）
  if (platform === 'kugou') return buildKugouSongLink(song) || null
  return null
}
