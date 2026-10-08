// 传统模式「酷狗 PC 客户端复刻」共用契约与小工具。
//
// 为什么单独一份：酷狗的五个内容页（推荐/乐库/歌单/频道/分类）与三个个人页共用同一套
// 「主题 + 账号 + 跨页动作」上下文，页面之间只差数据源；把上下文与卡片映射收敛在一处，
// 页面各自渲染，避免每页各写一遍 Song 映射导致口径漂移（与 QQPc 的分层一致）。
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { Song } from '../../services/musicApi'
import type { KugouTagPlaylist } from '../../services/kugouService'
import { resolveKugouCover } from '../../services/kugouService'
import type { PcTheme } from './pcKit'
import type { PcActions, PcAccount } from './types'

/** 「音乐」页内的官方页签（推荐 / 乐库 / 歌单 / 频道 / 分类；官方的视频/AI帮唱/赚钱不做）。 */
export type KugouPcMusicTab = 'discover' | 'library' | 'playlists' | 'channels' | 'categories'

export const KUGOU_PC_MUSIC_TABS: Array<{ key: KugouPcMusicTab; label: string }> = [
  { key: 'discover', label: '推荐' },
  { key: 'library', label: '乐库' },
  { key: 'playlists', label: '歌单' },
  { key: 'channels', label: '频道' },
  { key: 'categories', label: '分类' },
]

/** 内容页共享上下文（由 KugouPcShell 统一下发）。 */
export interface KugouPcPageContext {
  theme: PcTheme
  accent: string
  account: PcAccount
  actions: PcActions
  /** 页面是否可见（隐藏保活页为 false，用于跳过请求） */
  active: boolean
  /** 打开歌单详情：酷狗没有客户端复刻的歌单详情页，交回传统模式统一链路 */
  openPlaylist: (playlist: any) => void
  /** 打开歌手详情（platform 固定 kugou） */
  openArtist?: (artistId: string) => void
  /** 打开专辑详情（platform 固定 kugou） */
  openAlbum?: (albumId: string) => void
}

/** 大数取整：官方是**截断**而非四舍五入（实测情歌关注 87,650 → 官方 8.7万，不是 8.8万）。 */
function truncUnit(value: number, unit: number, decimals: number): string {
  const factor = 10 ** decimals
  return String(Math.floor((value / unit) * factor) / factor)
}

/** 播放量中文单位（与 pcKit 的 pcCount 同口径，这里只用于卡片角标字符串）。 */
export function kugouCount(value?: number | null): string {
  const count = Number(value || 0)
  if (!count) return ''
  if (count >= 100_000_000) return `${truncUnit(count, 100_000_000, count >= 1_000_000_000 ? 0 : 1)}亿`
  if (count >= 10_000) return `${truncUnit(count, 10_000, count >= 1_000_000 ? 0 : 1)}万`
  return String(count)
}

/** 秒 → mm:ss（酷狗接口的时长单位不统一，页面统一按秒传入）。 */
export function kugouDuration(seconds?: number | null): string {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  if (!total) return ''
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/** 标签歌单 → 卡片展示字段（封面已经是解析后的 https 直链）。 */
export interface KugouPlaylistCard {
  key: string
  id: string
  name: string
  coverUrl: string
  playCount?: number
  trackCount?: number
  creator?: string
  tag?: string
  raw: KugouTagPlaylist
}

export function tagPlaylistToCard(playlist: KugouTagPlaylist, index: number): KugouPlaylistCard {
  return {
    key: `${playlist.specialid}:${index}`,
    id: playlist.specialid,
    name: playlist.name,
    coverUrl: resolveKugouCover(playlist.coverUrl || ''),
    playCount: playlist.playCount,
    trackCount: playlist.trackCount,
    creator: playlist.creator,
    tag: playlist.tags[0],
    raw: playlist,
  }
}

/** 卡片点击：酷狗的公开歌单 id 是 specialid，传统模式 openPlaylist 按 platform 分流。 */
export function playlistOpenPayload(card: { id: string; name: string; coverUrl?: string; trackCount?: number }) {
  return {
    id: card.id,
    name: card.name,
    coverImgUrl: card.coverUrl || '',
    coverUrl: card.coverUrl || '',
    trackCount: card.trackCount || 0,
    platform: 'kugou' as const,
  }
}

/** 歌曲右键菜单载荷（统一在页面里组装，避免每页写一遍坐标取值）。 */
export function songMenuPayload(event: ReactMouseEvent, song: Song, songs?: Song[]) {
  return { show: true, x: event.clientX, y: event.clientY, song, songs }
}
