/**
 * 移动端导航：轻量页面栈（非路由库），由 MobileApp 持有，页面经 context 使用。
 */
import { createContext, useContext } from 'react'
import type { MusicPlatform } from '../services/platforms'
import type { ExplorePlaylist } from '../services/exploreApi'
import type { Song } from '../services/musicApi'

export type MobileTabKey = 'home' | 'search' | 'library' | 'settings'

/** 歌手页目标 */
export interface MobileArtistTarget {
  id: string
  name: string
  platform: MusicPlatform
}

/** 专辑目标（复用歌单详情页的 album 模式） */
export interface MobileAlbumTarget {
  id: string
  name: string
  coverUrl?: string
  platform: MusicPlatform
}

/** MV 播放目标 */
export interface MobileMvTarget {
  url: string
  title: string
  artist?: string
}

/** 长按动作面板目标（歌曲 + 来源列表上下文） */
export interface MobileSongActionsTarget {
  song: Song
  list?: Song[]
  listLabel?: string
}

export interface MobileNavApi {
  /** 当前 tab（栈底页面） */
  tab: MobileTabKey
  switchTab: (tab: MobileTabKey) => void
  /** 打开歌单详情（探索歌单或用户歌单） */
  openPlaylist: (playlist: ExplorePlaylist) => void
  /** 打开专辑详情 */
  openAlbum: (album: MobileAlbumTarget) => void
  /** 打开歌手页 */
  openArtist: (artist: MobileArtistTarget) => void
  /** 全屏播放 MV */
  openMv: (mv: MobileMvTarget) => void
  /** 长按歌曲 → 底部动作面板（触屏的右键菜单/轮盘） */
  openSongActions: (target: MobileSongActionsTarget) => void
  /** 打开全屏播放页 */
  openPlayer: () => void
  /** 当前音源平台 */
  platform: MusicPlatform
  setPlatform: (platform: MusicPlatform) => void
  /** 当前平台登录用户 id（动作面板收藏判定用；未登录为空） */
  userId: string
}

export const MobileNavContext = createContext<MobileNavApi | null>(null)

export function useMobileNav(): MobileNavApi {
  const ctx = useContext(MobileNavContext)
  if (!ctx) throw new Error('useMobileNav 必须在 MobileApp 内使用')
  return ctx
}
