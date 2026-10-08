// 播放页「查看歌手」的路由规则与歌手标识解析（纯函数，便于单测）。
//
// 规则（用户 2026-10-07 反馈）：单歌手 → 直接进歌手页；多歌手 → 先弹选择器让用户点。
// 旧实现恒取 artists[0]，多歌手曲目里其余歌手在播放页无从进入。
import type { MusicPlatform } from './platforms'

export interface PlaybackArtistRef {
  id?: number | string
  mid?: string
  appleId?: string
  name?: string
}

export type ViewArtistIntent = { kind: 'none' } | { kind: 'direct'; index: number } | { kind: 'picker' }

export function resolveViewArtistIntent(artists: PlaybackArtistRef[] | undefined | null): ViewArtistIntent {
  const list = artists || []
  if (!list.length) return { kind: 'none' }
  if (list.length === 1) return { kind: 'direct', index: 0 }
  return { kind: 'picker' }
}

/**
 * 各平台的歌手标识字段不同：QQ 用 mid、Apple 用 appleId，其余平台用数字 id。
 * 汽水（2026-10-08 更新）：真实艺人接口接通后，曲目 artists[].mid 已透传真实 artist_id
 * （纯数字）——优先用它打开「真艺人页」（有头像/简介/专辑）；缺失时才回退「歌手名」
 * 伪 id（按名检索的旧约定，两条路在 ArtistDetailModal/musicApi 里并存）。
 */
export function resolveArtistIdentifier(platform: MusicPlatform, artist?: PlaybackArtistRef): string {
  if (!artist) return ''
  if (platform === 'soda') return String(artist.mid || artist.id || artist.name || '')
  if (platform === 'apple') return String(artist.appleId || artist.id || '')
  if (platform === 'qq') return String(artist.mid || artist.id || '')
  return String(artist.id || '')
}
