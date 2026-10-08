// 传统模式 PC 复刻页面的公共契约。
//
// 所有平台页面（QQ 音乐/网易云）都只吃这一份 actions：页面自己负责取数 + 渲染，
// 播放/右键菜单/跳转/收藏这类跨页能力全部回传给 TraditionalView，
// 保证传统模式只有一套播放与菜单链路（不出现页面各自造播放）。
import type { Song } from '../../services/musicApi'
import type { MusicPlatform } from '../../services/platforms'
import type { PcSkin, PcTone } from './pcKit'

/** 右键菜单载荷（与 TraditionalView 的 songMenu 状态同构）。 */
export interface PcSongMenuPayload {
  show: boolean
  x: number
  y: number
  song: Song | null
  songs?: Song[]
  liked?: boolean
}

export interface PcPlaylistMenuPayload {
  show: boolean
  x: number
  y: number
  playlist: any | null
}

/** 播放上下文（可选第 4 参，与既有 index 参数兼容）：
 *  - continuous：播放中自动续推荐（猜你喜欢/刷歌的「先 5 首就播 + 持续推荐」语义，客户端同款）；
 *  - radar：刷歌模式的雷达续页参数（下一页页码/类型/入口种子）。 */
export interface PcPlayOptions {
  continuous?: boolean
  radar?: { page: number; reqType: number; entranceSongs: number[] }
}

/** 页面共用的跨页动作。 */
export interface PcActions {
  /** 播放歌曲：songs 是所在列表（播放队列），index 为点击位置，options 为续播上下文。 */
  onPlaySongs: (song: Song, songs: Song[], index?: number, options?: PcPlayOptions) => void
  onSongMenu: (payload: PcSongMenuPayload) => void
  onOpenPlaylist: (playlist: any) => void
  onPlaylistMenu?: (payload: PcPlaylistMenuPayload) => void
  onOpenArtist?: (artistId: string, platform: MusicPlatform) => void
  onOpenAlbum?: (albumId: string, platform: MusicPlatform) => void
  onOpenChart?: (chart: any, autoplay?: boolean) => void
  onOpenComments?: (song: Song) => void
  /** 打开 MV（弹窗内直接播放）；mvId 缺省 = 打开 MV 浏览弹窗（不直达播放）。 */
  onOpenMv?: (mvId?: string, platform?: 'qq' | 'netease') => void
  /** 打开某用户的个人主页（网易云用户卡片/粉丝行用）；不传时页面降级为自己的主页。 */
  onOpenUserProfile?: (userId: string, nickname?: string, avatarUrl?: string) => void
  /** 分享歌单（复制平台分享链接 + toast）；未接入时为 undefined，页面据此不渲染分享按钮 */
  onSharePlaylist?: (playlist: any) => void
  /** 页内跳转到传统模式的其它页面（值由 TraditionalView 解释，见 PcNavTarget）。 */
  onNavigate: (target: PcNavTarget) => void
  onLogin?: () => void
  /** 红心切换（喜欢/取消喜欢）；页面用 likedKeys / isLiked 判定当前态。 */
  onToggleLike?: (song: Song, next: boolean) => void
  /** 当前账号已喜欢的歌曲键（pcSongKey 口径）。 */
  likedKeys?: Set<string>
  /** 更省事的红心判定：直接问全局喜欢状态快照（favoriteStatusService） */
  isLiked?: (song: Song) => boolean
  /** 当前播放歌曲键与播放状态（用于行高亮）。 */
  currentSongKey?: string
  isPlaying?: boolean
}

/**
 * 页面内可发起的目标；TraditionalView 负责映射到自己的历史栈页面。
 * 只列真实存在的页面：本地音乐 / 下载管理 / 已购音乐 / 试听列表是产品决策上永久不支持的能力，入口已全部删除。
 */
export type PcNavTarget =
  | { kind: 'qq'; page: 'home' | 'hall' | 'liked' | 'recent' | 'search' | 'profile' | 'settings'; keyword?: string; detail?: string }
  | { kind: 'netease'; page: 'home' | 'featured' | 'podcast' | 'roam' | 'follow' | 'liked' | 'recent' | 'mypodcast' | 'collect' | 'cloud' | 'search' | 'profile' | 'settings'; keyword?: string; detail?: string }
  /** Apple Music 客户端复刻页（radio/added/artists/albums/songs/playlists/favorites + home/search/profile/settings）。 */
  | { kind: 'apple'; page: 'home' | 'search' | 'profile' | 'settings' | 'radio' | 'added' | 'artists' | 'albums' | 'songs' | 'playlists' | 'favorites'; keyword?: string; detail?: string }

/** 账号上下文。 */
export interface PcAccount {
  loggedIn: boolean
  username: string
  avatar?: string
  userId?: string
  vip?: boolean
}

/** 页面通用外观参数。 */
export interface PcChrome {
  tone: PcTone
  skin: PcSkin
  accent: string
}

export type { Song, MusicPlatform }
