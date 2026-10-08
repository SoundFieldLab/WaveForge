import { motion, AnimatePresence } from 'framer-motion'
import { Play, ListPlus, Heart, HeartOff, MessageSquare, Disc, User, Copy, ChevronRight, Info, ListMusic, ThumbsDown, SlidersHorizontal, Radio, X , Lightbulb, Share2, Link2} from 'lucide-react'
import { Song, getProxiedImageUrl } from '../services/musicApi'
import { getAddablePlaylists, getPlaylistMutationId } from '../services/addablePlaylists'
import { readPlaylistOwnersFromStorage } from '../services/playlistOwnership'
import { getPlatformCapabilities, getPlatformCookie, getPlatformFavoriteLabels, platformLabel } from '../services/platforms'
import type { MusicPlatform } from '../services/platforms'
import { useEffect, useLayoutEffect, useState, useRef, useSyncExternalStore } from 'react'
import { isResonanceSuspended, RESONANCE_PUSH_EVENT, RESONANCE_PUSH_LABEL, subscribeResonanceSuspend } from '../features/resonance/push'
import { useTvBack } from '../tv/tvCore'
import CachedImage from './CachedImage'
import {
  applyFavoriteMutation,
  getFavoriteSongIdentifiers,
  getFavoriteUserId,
  loadFavoriteIdentifiers,
  peekSongFavoriteStatus,
} from '../services/favoriteStatusService'
import { getAppleLovedSongIds } from '../services/appleCatalog'
import { addSodaSongToPlaylist, checkSodaLiked, isSodaLoggedIn, setSodaTrackLiked } from '../services/sodaService'
import { addKugouSongToPlaylist, buildKugouSongLink, likeKugouSong } from '../services/kugouService'
import { loadQQDislikeIds, peekQQDislike, subscribeQQDislike, toggleQQDislike } from '../features/qqExplore/qqDislike'

/** 宿主一次性绑定给其它界面的右键菜单回调包（显隐/位置/song 由菜单自己管）。 */
export type SongMenuBindings =
  Omit<SongContextMenuProps, 'show' | 'x' | 'y' | 'song' | 'onClose' | 'platform'>
  & { platform?: SongContextMenuProps['platform'] }

interface SongContextMenuProps {
  show: boolean
  x: number
  y: number
  song: Song | null
  onClose: () => void
  onPlayNow: (song: Song) => void
  onPlayNext?: (song: Song) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => void
  onAddToPlaylist?: (song: Song, playlistId: string) => void
  onRemoveFromPlaylist?: (song: Song) => void
  onViewComments?: (song: Song) => void
  onViewAlbum?: (song: Song) => void
  onViewArtist?: (song: Song) => void
  onCopyInfo?: (song: Song) => void
  /** 分享：生成官方歌曲链接并复制（QQ/网易云客户端右键同款） */
  onShare?: (song: Song) => void
  onDislike?: (song: Song) => void
  onAdjustPreferences?: () => void
  onAdjustRecommendation?: (song: Song) => void
  /** 刷歌模式下额外提供「音乐偏好设置」入口（App 刷歌播放页右上角设置同源） */
  showMusicPreference?: boolean
  onOpenMusicPreference?: () => void
  userPlaylists: any[]
  platform: MusicPlatform
  playerTheme?: 'light' | 'dark'
  hideFavoriteAction?: boolean
  currentPlaylistId?: string
  /** 菜单每次打开时的副作用：例如按当前歌曲平台刷新「添加到」候选歌单
   *  （否则从队列/相似歌曲面板打开时，子菜单拿到的是空或上个平台的歌单）。 */
  onMenuOpen?: () => void
}

const SUBMENU_VIEWPORT_MARGIN = 10
const SUBMENU_MAX_HEIGHT = 300
const SUBMENU_MIN_WIDTH = 220

const showMenuToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
  window.dispatchEvent(new CustomEvent('showToast', { detail: { message, type } }))
}

/** 平台用户 ID 的 localStorage 键（apple 无此概念） */
const getUserStorageKey = (p: MusicPlatform): string => {
  switch (p) {
    case 'qq': return 'qq_user_id'
    case 'spotify': return 'spotify_user_id'
    case 'kugou': return 'kugou_user_id'
    case 'soda': return 'soda_user_id'
    default: return 'netease_user_id'
  }
}

/** 需菜单内拦截收藏/加歌单动作的第三方平台（登录态检查 + 能力提示） */
const isThirdPartyPlatform = (p: MusicPlatform): boolean =>
  p === 'spotify' || p === 'kugou' || p === 'soda'

/** Spotify 官方 API：收藏歌曲（放入音乐库） */
async function spotifySaveTrack(song: Song): Promise<boolean> {
  const token = getPlatformCookie('spotify')
  if (!token || !song.mid) return false
  try {
    const resp = await fetch(`https://api.spotify.com/v1/me/tracks?ids=${encodeURIComponent(song.mid)}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
    })
    return resp.ok
  } catch (error) {
    console.warn('[SongContextMenu] Spotify 收藏失败:', error)
    return false
  }
}

/** Spotify 官方 API：取消收藏歌曲 */
async function spotifyRemoveTrack(song: Song): Promise<boolean> {
  const token = getPlatformCookie('spotify')
  if (!token || !song.mid) return false
  try {
    const resp = await fetch(`https://api.spotify.com/v1/me/tracks?ids=${encodeURIComponent(song.mid)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    })
    return resp.ok
  } catch (error) {
    console.warn('[SongContextMenu] Spotify 取消收藏失败:', error)
    return false
  }
}

/** Spotify 官方 API：添加歌曲到歌单 */
async function spotifyAddTrackToPlaylist(song: Song, playlistId: string): Promise<boolean> {
  const token = getPlatformCookie('spotify')
  if (!token || !song.mid) return false
  try {
    const resp = await fetch(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/tracks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ uris: [`spotify:track:${song.mid}`] }),
    })
    return resp.ok
  } catch (error) {
    console.warn('[SongContextMenu] Spotify 添加到歌单失败:', error)
    return false
  }
}

export default function SongContextMenu({
  show,
  x,
  y,
  song,
  onClose,
  onPlayNow,
  onPlayNext,
  onAddToFavorites,
  onRemoveFromFavorites,
  onAddToPlaylist,
  onRemoveFromPlaylist,
  onViewComments,
  onViewAlbum,
  onViewArtist,
  onCopyInfo,
  onShare,
  onDislike,
  onAdjustPreferences,
  onAdjustRecommendation,
  showMusicPreference,
  onOpenMusicPreference,
  userPlaylists,
  platform,
  playerTheme = 'dark',
  hideFavoriteAction = false,
  currentPlaylistId,
  onMenuOpen
}: SongContextMenuProps) {
  const [showPlaylistSubmenu, setShowPlaylistSubmenu] = useState(false)
  const [submenuPosition, setSubmenuPosition] = useState<'right' | 'left'>('right')
  const [submenuTop, setSubmenuTop] = useState(0)
  const [submenuMaxHeight, setSubmenuMaxHeight] = useState(SUBMENU_MAX_HEIGHT)
  const menuRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const submenuAnchorRef = useRef<HTMLDivElement>(null)
  const [adjustedPosition, setAdjustedPosition] = useState({ x, y })
  const [imageLoaded, setImageLoaded] = useState(false)
  const resolvedPlatform = (song?.platform || platform) as MusicPlatform
  const favoriteLabels = getPlatformFavoriteLabels(resolvedPlatform)
  const favoriteUserId = getFavoriteUserId(resolvedPlatform)
  const [favoriteStatus, setFavoriteStatus] = useState<boolean | null>(() => (
    hideFavoriteAction ? true : song ? peekSongFavoriteStatus(song, resolvedPlatform, favoriteUserId) : null
  ))

  useEffect(() => {
    if (!show || !song) return
    // 调用方已确定「这首歌属于我喜欢」（我喜欢歌单 / 播放条已喜欢的当前曲）时，
    // 上下文就是权威：缓存未加载、归属键缺失（peekSongFavoriteStatus 在拿不到 userId 时
    // **直接返回 false** 而不是 null）都不能翻案 —— 否则在「我喜欢」里右键会显示「我喜欢」
    // （2026-09-27 用户实测事故，配合服务端 id/mid 形状 bug 一起修）。
    if (hideFavoriteAction) {
      setFavoriteStatus(true)
      return
    }
    // 红心状态唯一真相源：favoriteStatusService 归属键缓存（netease/qq/soda 统一，
    // 汽水归属键为 soda_user_id，喜欢列表由 playlistService.getLikedSongs 走 qishui-liked 分页拉全量）
    const cachedStatus = peekSongFavoriteStatus(song, resolvedPlatform, favoriteUserId)
    setFavoriteStatus(cachedStatus)
    if (!favoriteUserId || cachedStatus !== null) return

    let cancelled = false
    // 临时兜底（仅汽水）：identifiers 首次加载需分页拉全量（最多 20 页 × 50 条），可能耗时数秒；
    // 仅在「缓存未加载完成」这段等待期用单曲 checkSodaLiked 先行给出近似显示（乐观体验）。
    // 通用路径 resolve 后一律以缓存结果为准——peek 守卫保证兜底响应晚到时不会覆盖权威值。
    const sodaTrackId = resolvedPlatform === 'soda' ? String(song.mid || song.id) : ''
    if (sodaTrackId && isSodaLoggedIn()) {
      void checkSodaLiked([sodaTrackId])
        .then(likedMap => {
          if (!cancelled && peekSongFavoriteStatus(song, resolvedPlatform, favoriteUserId) === null) {
            setFavoriteStatus(Boolean(likedMap[sodaTrackId]))
          }
        })
        .catch(() => { /* 兜底失败保持加载态，等待通用路径 */ })
    }

    if (resolvedPlatform === 'apple') {
      const identifiers = getFavoriteSongIdentifiers(song)
      void getAppleLovedSongIds(identifiers)
        .then(ids => {
          if (!cancelled) setFavoriteStatus(ids.some(id => identifiers.includes(id)))
        })
        .catch(() => undefined)
      return () => { cancelled = true }
    }

    void loadFavoriteIdentifiers(resolvedPlatform, favoriteUserId)
      .then(() => {
        if (!cancelled) setFavoriteStatus(peekSongFavoriteStatus(song, resolvedPlatform, favoriteUserId) === true)
      })
      .catch(error => {
        if (!cancelled) {
          console.warn('Failed to resolve song favorite status:', error)
          setFavoriteStatus(hideFavoriteAction)
        }
      })
    return () => { cancelled = true }
  }, [favoriteUserId, hideFavoriteAction, resolvedPlatform, show, song])

  useEffect(() => {
    const handleFavoriteChange = (event: Event) => {
      const detail = (event as CustomEvent<any>).detail
      applyFavoriteMutation(detail || {})
      if (!show || !song || detail?.platform !== resolvedPlatform) return
      const changedIdentifiers = [detail.songId, detail.songMid]
        .filter((value: unknown) => value !== undefined && value !== null)
        .map((value: unknown) => String(value))
      if (!getFavoriteSongIdentifiers(song).some(identifier => changedIdentifiers.includes(identifier))) return
      setFavoriteStatus(detail.type === 'like')
    }
    window.addEventListener('playlist-content-changed', handleFavoriteChange)
    return () => window.removeEventListener('playlist-content-changed', handleFavoriteChange)
  }, [resolvedPlatform, show, song])

  // 打开即通知宿主（刷新「添加到」候选歌单）
  const onMenuOpenRef = useRef(onMenuOpen)
  onMenuOpenRef.current = onMenuOpen
  useEffect(() => {
    if (show) onMenuOpenRef.current?.()
  }, [show])

  // 重置图片加载状态
  useEffect(() => {
    if (show) {
      setImageLoaded(false)
      setShowPlaylistSubmenu(false)
    }
  }, [show, song])

  // 计算菜单位置，确保不超出屏幕
  useEffect(() => {
    if (show && menuRef.current) {
      // offsetWidth/offsetHeight 不受入场 scale 动画影响（getBoundingClientRect 会测到
      // 0.95 缩放值，导致贴屏幕右/下边缘时夹紧不足、菜单溢出约 5% 宽高）
      const menuWidth = menuRef.current.offsetWidth
      const menuHeight = menuRef.current.offsetHeight
      const windowWidth = window.innerWidth
      const windowHeight = window.innerHeight

      let newX = x
      let newY = y

      // 检查右边界
      if (x + menuWidth > windowWidth) {
        newX = windowWidth - menuWidth - 10
      }

      // 检查底部边界
      if (y + menuHeight > windowHeight) {
        newY = windowHeight - menuHeight - 10
      }

      // 检查左边界
      if (newX < 10) {
        newX = 10
      }

      // 检查顶部边界
      if (newY < 10) {
        newY = 10
      }

      setAdjustedPosition({ x: newX, y: newY })
    }
  }, [show, x, y])

  // 让子菜单始终留在可视区域内：横向自动翻转，纵向自动上移并限制高度。
  useLayoutEffect(() => {
    if (!showPlaylistSubmenu) return

    const updateSubmenuLayout = () => {
      const menuElement = menuRef.current
      const anchorElement = submenuAnchorRef.current
      const submenuElement = submenuRef.current
      if (!menuElement || !anchorElement || !submenuElement) return

      const menuRect = menuElement.getBoundingClientRect()
      const anchorRect = anchorElement.getBoundingClientRect()
      const submenuRect = submenuElement.getBoundingClientRect()
      const submenuWidth = Math.max(SUBMENU_MIN_WIDTH, submenuRect.width)
      const spaceOnRight = window.innerWidth - menuRect.right - SUBMENU_VIEWPORT_MARGIN

      setSubmenuPosition(spaceOnRight >= submenuWidth ? 'right' : 'left')

      const availableHeight = Math.max(
        64,
        window.innerHeight - SUBMENU_VIEWPORT_MARGIN * 2
      )
      const nextMaxHeight = Math.min(SUBMENU_MAX_HEIGHT, availableHeight)
      const desiredHeight = Math.min(
        submenuElement.scrollHeight || submenuRect.height,
        nextMaxHeight
      )
      const latestViewportTop = Math.max(
        SUBMENU_VIEWPORT_MARGIN,
        window.innerHeight - SUBMENU_VIEWPORT_MARGIN - desiredHeight
      )
      const viewportTop = Math.min(
        Math.max(anchorRect.top, SUBMENU_VIEWPORT_MARGIN),
        latestViewportTop
      )

      setSubmenuTop(viewportTop - anchorRect.top)
      setSubmenuMaxHeight(nextMaxHeight)
    }

    const animationFrame = window.requestAnimationFrame(updateSubmenuLayout)
    window.addEventListener('resize', updateSubmenuLayout)

    return () => {
      window.cancelAnimationFrame(animationFrame)
      window.removeEventListener('resize', updateSubmenuLayout)
    }
  }, [showPlaylistSubmenu, userPlaylists.length, adjustedPosition.x, adjustedPosition.y])

  // 点击外部关闭菜单
  useEffect(() => {
    if (show) {
      const handleClickOutside = (e: MouseEvent) => {
        if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
            (!submenuRef.current || !submenuRef.current.contains(e.target as Node))) {
          onClose()
        }
      }

      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [show, onClose])

  // ESC 关闭菜单（与 PlaylistContextMenu 对齐）
  useEffect(() => {
    if (!show) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [show, onClose])

  // TV 遥控器 BACK 关闭菜单（带 show 守卫：部分宿主常驻挂载本组件，无守卫会吞掉全场景 BACK 键）
  useTvBack(() => {
    if (show) {
      onClose()
      return true
    }
    return false
  })

  // 菜单未选中歌曲时的空渲染守卫：必须在所有 hooks 之后（下方还有 useSyncExternalStore/useState），
  // 否则 TraditionalView 这种「组件常驻挂载、song 后到」的宿主会在首次右键时
  // 触发 hooks 数量变化（Rendered more hooks than during the previous render）而崩溃整棵渲染树。

  // 获取歌曲封面URL
  const getCoverUrl = () => {
    if (!song) return ''
    if (song.album?.picUrl) {
      return getProxiedImageUrl(song.album.picUrl)
    }
    return ''
  }

  const currentUserId = platform === 'apple' ? '' : (localStorage.getItem(getUserStorageKey(platform)) || '')
  // 第三方平台（spotify/kugou/soda）操作拦截：未登录提示先登录；
  // 已登录 spotify 走官方收藏/加歌接口，soda 走 sodaService（喜欢/加歌），
  // kugou 走概念版通道（喜欢/取消喜欢/加歌均为真实写入；网页 cookie 通道由能力位隐藏取消项）
  const handleThirdPartyAction = (action: 'like' | 'unlike' | 'playlist', playlistId?: string): boolean => {
    const p = resolvedPlatform
    // 本函数只在下方 `if (!song) return null` 守卫之后被菜单项调用；这里补窄化兜底
    if (!song) return false
    if (!isThirdPartyPlatform(p)) return false
    if (!getPlatformCookie(p)) {
      showMenuToast(`请先登录${platformLabel(p)}`, 'error')
      return true
    }
    if (p === 'spotify') {
      if (action === 'playlist' && playlistId) {
        void spotifyAddTrackToPlaylist(song, playlistId).then(ok => {
          showMenuToast(ok ? '已添加到 Spotify 歌单' : '添加到 Spotify 歌单失败', ok ? 'success' : 'error')
        })
      } else if (action === 'like') {
        void spotifySaveTrack(song).then(ok => {
          if (ok) {
            // 与其他平台一致：成功后同步通用收藏缓存并乐观更新本菜单显示
            setFavoriteStatus(true)
            applyFavoriteMutation({ platform: 'spotify', type: 'like', songId: song.id, songMid: song.mid })
          }
          showMenuToast(ok ? '已收藏到 Spotify 音乐库' : '收藏失败，请检查登录状态', ok ? 'success' : 'error')
        })
      } else {
        void spotifyRemoveTrack(song).then(ok => {
          if (ok) {
            setFavoriteStatus(false)
            applyFavoriteMutation({ platform: 'spotify', type: 'unlike', songId: song.id, songMid: song.mid })
          }
          showMenuToast(ok ? '已从 Spotify 音乐库取消收藏' : '取消收藏失败，请检查登录状态', ok ? 'success' : 'error')
        })
      }
      return true
    }
    if (p === 'soda') {
      // 汽水：trackId 一律取 String(mid || id)；成功后同步通用收藏缓存并乐观更新本菜单显示
      const sodaTrackId = String(song.mid || song.id)
      if (action === 'playlist' && playlistId) {
        void addSodaSongToPlaylist(playlistId, song).then(ok => {
          showMenuToast(ok ? '已添加到汽水歌单' : '添加到汽水歌单失败', ok ? 'success' : 'error')
        })
      } else if (action === 'like') {
        void setSodaTrackLiked(sodaTrackId, true, song).then(ok => {
          if (ok) {
            setFavoriteStatus(true)
            applyFavoriteMutation({ platform: 'soda', type: 'like', songId: song.id, songMid: song.mid })
          }
          showMenuToast(ok ? '已加入汽水喜欢' : '喜欢失败，请检查登录状态', ok ? 'success' : 'error')
        })
      } else {
        void setSodaTrackLiked(sodaTrackId, false, song).then(ok => {
          if (ok) {
            setFavoriteStatus(false)
            applyFavoriteMutation({ platform: 'soda', type: 'unlike', songId: song.id, songMid: song.mid })
          }
          showMenuToast(ok ? '已从汽水喜欢中移除' : '取消喜欢失败，请检查登录状态', ok ? 'success' : 'error')
        })
      }
      return true
    }
    if (p === 'kugou') {
      // 酷狗：喜欢=概念版加入默认「我喜欢」歌单；取消=按 fileid 从「我喜欢」移除
      //（kugouService 会先查 hash→fileid 映射）。加歌=/v6/add_song。
      const kugouHash = String(song.mid || '')
      if (action === 'playlist' && playlistId) {
        void addKugouSongToPlaylist(playlistId, { hash: kugouHash }).then(ok => {
          showMenuToast(ok ? '已添加到酷狗歌单' : '添加到酷狗歌单失败', ok ? 'success' : 'error')
        })
      } else if (action === 'like') {
        void likeKugouSong({ hash: kugouHash, name: song.name }, true).then(ok => {
          if (ok) {
            setFavoriteStatus(true)
            applyFavoriteMutation({ platform: 'kugou', type: 'like', songId: song.id, songMid: song.mid })
          }
          showMenuToast(ok ? '已加入酷狗喜欢' : '喜欢失败，请检查登录状态', ok ? 'success' : 'error')
        })
      } else {
        void likeKugouSong({ hash: kugouHash, name: song.name }, false).then(ok => {
          if (ok) {
            setFavoriteStatus(false)
            applyFavoriteMutation({ platform: 'kugou', type: 'unlike', songId: song.id, songMid: song.mid })
          }
          showMenuToast(ok ? '已从酷狗喜欢中移除' : '取消喜欢失败，请检查登录状态', ok ? 'success' : 'error')
        })
      }
      return true
    }
    showMenuToast('该平台暂不支持此操作', 'info')
    return true
  }
  // 「添加到」候选 = 与歌曲同平台 + 平台可写 + 排除虚拟歌单（Apple 资料库/喜爱、汽水虚拟单）
  // + 排除他人的/已收藏的歌单 + 排除当前正在浏览的歌单。
  // 以前这里是另一套内联过滤（只排 isLike/isCollected），会把 Apple「我的音乐库」
  // 列成可添加目标，点了必然失败（2026-09-27 审计 A2）——现在与播放页弹窗共用
  // addablePlaylists 这一处实现。
  const ownedPlaylists = getAddablePlaylists(
    userPlaylists,
    resolvedPlatform,
    readPlaylistOwnersFromStorage(),
  ).filter(playlist => !currentPlaylistId || getPlaylistMutationId(playlist) !== String(currentPlaylistId))
  // 红心显示统一由 favoriteStatus 通用缓存驱动（含汽水）；identifiers 在途时显示加载占位
  // 专辑/歌手的可跳转 id：宿主 wrapper 在缺 id 时是"静默不动作"（点了没反应），
  // 菜单侧据此直接隐藏该项，避免出现点了没反应的条目（2026-09-27 审计 B2）。
  const hasUsableId = (value: unknown) => {
    if (value === undefined || value === null) return false
    const text = String(value).trim()
    return text !== '' && text !== '0'
  }
  // 有的平台按**名字**导航（汽水：宿主与 musicApi 都走名字搜索），没有 id 也能跳；
  // 只看 id 会把这类歌曲的菜单项误隐藏（2026-09-27 复查发现的回归）。
  const nameNavigablePlatform = resolvedPlatform === 'soda'
  const albumNavigable = Boolean(song?.album && (
    hasUsableId(song.album.appleId) || hasUsableId(song.album.mid) || hasUsableId(song.album.id)
    || (nameNavigablePlatform && String(song.album.name || '').trim() !== '')))
  const artistNavigable = Boolean((song?.artists || []).some(artist => artist && (
    hasUsableId(artist.appleId) || hasUsableId(artist.mid) || hasUsableId(artist.id)
    || (nameNavigablePlatform && String(artist.name || '').trim() !== ''))))

  const favoriteActionIsRemove = favoriteStatus ?? hideFavoriteAction
  const favoriteStatusLoading = favoriteStatus === null && Boolean(favoriteUserId)

  // 共振是否处于挂起态（人在别的模式但房间还活着）→ 决定要不要多一项「推送至共振」
  const resonanceSuspended = useSyncExternalStore(subscribeResonanceSuspend, isResonanceSuspended, () => false)

  // 多歌手选择弹窗：菜单关闭后仍要显示，故用独立状态承载（快照歌曲/歌手列表）
  const [artistPicker, setArtistPicker] = useState<{ song: Song; artists: Song['artists'] } | null>(null)

  // QQ「不喜欢」= App 同款歌曲黑名单（music.feedback.FeedbackBlack），需登录才有意义
  const qqDislikeAvailable = resolvedPlatform === 'qq' && Boolean(getPlatformCookie('qq'))
  const qqDisliked = useSyncExternalStore(
    subscribeQQDislike,
    () => peekQQDislike(qqDislikeAvailable ? song : null),
    () => null as boolean | null,
  )
  useEffect(() => {
    if (!show || !song || !qqDislikeAvailable) return
    void loadQQDislikeIds().catch(() => {})
  }, [show, song, qqDislikeAvailable])

  // 所有 hooks 已执行完毕，这里才是空歌曲的空渲染点（见上方说明）。
  if (!song) return null

  const menuItems = [
    {
      label: '播放',
      icon: Play,
      onClick: () => {
        onPlayNow(song)
        onClose()
      }
    },
    ...(onPlayNext ? [{
      label: '下一首播放',
      icon: ListPlus,
      onClick: () => {
        onPlayNext(song)
        onClose()
      }
    }] : []),
    { separator: true },
    ...(favoriteStatusLoading ? [{
      label: '正在检查收藏状态…',
      icon: Heart,
      disabled: true,
      onClick: () => undefined,
    }] : []),
    ...(!favoriteStatusLoading && !favoriteActionIsRemove && onAddToFavorites
      && getPlatformCapabilities(resolvedPlatform).likeSong ? [{
      label: favoriteLabels.add,
      icon: Heart,
      onClick: () => {
        if (handleThirdPartyAction('like')) { onClose(); return }
        onAddToFavorites(song)
        onClose()
      }
    }] : []),
    // 「取消喜欢」按能力位决定（酷狗概念版按 fileid 可移除，网页 cookie 通道不可）：
    // 与播放页径向菜单共用 capabilities.unlikeSong，避免两处入口一个隐藏一个假成功
    ...(!favoriteStatusLoading && favoriteActionIsRemove && onRemoveFromFavorites
      && getPlatformCapabilities(resolvedPlatform).unlikeSong ? [{
      label: favoriteLabels.remove,
      icon: HeartOff,
      onClick: () => {
        if (handleThirdPartyAction('unlike')) { onClose(); return }
        onRemoveFromFavorites(song)
        onClose()
      },
      danger: true
    }] : []),
    // Apple Music：单曲加入资料库（web 歌曲行「添加到资料库」同款；动态引入避免全平台包体膨胀）
    ...(resolvedPlatform === 'apple' && song?.appleId && !song.appleLibraryId ? [{
      label: '添加到资料库',
      icon: ListMusic,
      onClick: () => {
        void import('../services/appleCatalog').then(({ addAppleSongToLibrary, getLastAppleMutationResult }) =>
          addAppleSongToLibrary(String(song.appleId || song.id)).then(ok => {
            const failure = getLastAppleMutationResult()
            showMenuToast(ok ? '已添加到 Apple Music 资料库' : (failure.error || '添加到资料库失败'), ok ? 'success' : 'error')
            if (ok) {
              window.dispatchEvent(new CustomEvent('playlist-content-changed', {
                detail: { platform: 'apple', type: 'library-add', songId: String(song.appleId || song.id) },
              }))
            }
          }),
        )
        onClose()
      }
    }] : []),
    ...(onAddToPlaylist ? [{
      label: '添加到',
      icon: null, // 不显示图标
      hasSubmenu: true,
      onClick: () => setShowPlaylistSubmenu(value => !value),
      onMouseEnter: () => setShowPlaylistSubmenu(true),
      onMouseLeave: () => setShowPlaylistSubmenu(false)
    }] : []),
    ...(onRemoveFromPlaylist ? [{
      label: '从歌单移除',
      icon: null,
      onClick: () => {
        onRemoveFromPlaylist(song)
        onClose()
      },
      danger: true
    }] : []),
    ...(onViewComments && getPlatformCapabilities(resolvedPlatform).comments ? [{
      // 菜单项不带评论数：各平台评论数口径不一致（酷狗要单独拉接口、网易云/QQ 只有部分资源带），
      // 数字反而不稳；评论总数在评论弹窗里展示。
      label: '查看评论',
      icon: MessageSquare,
      onClick: () => {
        onViewComments(song)
        onClose()
      }
    }] : []),
    ...(onViewAlbum && albumNavigable ? [{
      label: '查看专辑',
      icon: Disc,
      onClick: () => {
        onViewAlbum?.(song)
        onClose()
      }
    }] : []),
    ...(onViewArtist && artistNavigable ? [{
      label: '查看歌手',
      icon: User,
      onClick: () => {
        // 多位歌手：先弹选择（背景用当前歌曲封面）；Apple 的父级按 appleId 取详情、不认选择，维持原样
        const artists = (song?.artists || []).filter(artist => artist && (artist.name || artist.mid || artist.id))
        if (artists.length > 1 && resolvedPlatform !== 'apple' && song) {
          setArtistPicker({ song, artists })
          onClose()
          return
        }
        onViewArtist?.(song)
        onClose()
      }
    }] : []),
    // 只有共振被挂起（人在别的模式、房间还活着）时才多这一项：
    // 直接派发全局事件，由 App 交给共振会话决定「设为下一曲」还是「预排队」。
    ...(resonanceSuspended ? [{
      label: RESONANCE_PUSH_LABEL,
      icon: Radio,
      onClick: () => {
        window.dispatchEvent(new CustomEvent(RESONANCE_PUSH_EVENT, { detail: song }))
        onClose()
      }
    }] : []),
    {
      label: '查看歌曲详情',
      icon: Info,
      onClick: () => {
        window.dispatchEvent(new CustomEvent('waveforge:show-song-detail', { detail: song }))
        onClose()
      }
    },
    ...(onAdjustPreferences && resolvedPlatform === 'qq' ? [{
      label: '调整听歌偏好',
      icon: SlidersHorizontal,
      onClick: () => { onAdjustPreferences(); onClose() },
    }] : []),
    ...(onAdjustRecommendation && resolvedPlatform === 'qq' ? [{
      label: '不感兴趣',
      icon: ThumbsDown,
      onClick: () => { onAdjustRecommendation(song); onClose() },
    }] : []),
    ...(showMusicPreference && onOpenMusicPreference ? [{
      label: '音乐偏好设置',
      icon: SlidersHorizontal,
      onClick: () => { onOpenMusicPreference(); onClose() },
    }] : []),
    ...(qqDislikeAvailable ? [{
      label: qqDisliked === true ? '取消不喜欢' : '不喜欢',
      icon: ThumbsDown,
      onClick: () => {
        if (!song) return
        void toggleQQDislike(song).then(
          next => showMenuToast(next ? '已标记为不喜欢' : '已取消不喜欢', 'success'),
          (error: unknown) => showMenuToast(error instanceof Error ? error.message : '操作失败，请稍后重试', 'error'),
        )
        onClose()
      },
    }] : []),
    ...(onDislike && song?.platform === 'netease' ? [{
      label: '不感兴趣',
      icon: ThumbsDown,
      onClick: () => {
        onDislike(song)
        onClose()
      }
    }] : []),
    ...(getPlatformCapabilities(resolvedPlatform).similarSongs ? [{
      label: '相似歌曲',
      icon: Lightbulb,
      onClick: () => {
        // 各平台原生行为不同：
        // - 网易云：客户端灯泡直接切到相似歌曲（插播），不打断当前播放
        // - 酷狗：官方客户端是**弹窗列表**（相似度排序的相似歌曲窗），不能套网易云那套
        // - 其余平台：同样是弹窗列表
        window.dispatchEvent(new CustomEvent(
          resolvedPlatform === 'kugou' ? 'waveforge:show-similar-songs' : 'waveforge:play-similar-song',
          { detail: song },
        ))
        onClose()
      }
    }] : []),
    ...(onCopyInfo ? [{
      label: '复制歌曲信息',
      icon: Copy,
      onClick: () => {
        onCopyInfo(song)
        onClose()
      }
    }] : []),
    ...(onShare ? [{
      label: '分享',
      icon: Share2,
      onClick: () => {
        onShare(song)
        onClose()
      }
    }] : []),
    // 酷狗专属：官方客户端右键的「复制链接」。
    // 不做「下载」（产品口径：本软件无下载功能），菜单里不留下载入口。
    ...(resolvedPlatform === 'kugou' ? [{
      label: '复制链接',
      icon: Link2,
      onClick: () => {
        const link = buildKugouSongLink(song)
        if (!link) {
          showMenuToast('缺少歌曲 hash，无法生成酷狗链接', 'error')
          onClose()
          return
        }
        void navigator.clipboard?.writeText(link)
          .then(() => showMenuToast('已复制酷狗歌曲链接', 'success'))
          .catch(() => showMenuToast('复制失败，请手动复制', 'error'))
        onClose()
      }
    }] : [])
  ]

  // 主题配色：菜单本身是液态玻璃风格，浅色模式下换成浅色底
  const isDark = playerTheme === 'dark'
  const menuBg = isDark ? 'from-gray-900 to-gray-800' : 'from-gray-50 to-gray-200'
  const coverOverlay = isDark ? 'bg-black/60' : 'bg-white/50'
  const hoverBg = isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
  const separatorColor = isDark ? 'bg-white/10' : 'bg-black/10'
  const textPrimary = isDark ? 'text-white/90' : 'text-black/85'
  const textMuted = isDark ? 'text-white/50' : 'text-black/50'
  const textDisabled = isDark ? 'text-white/45' : 'text-black/40'
  const dangerText = isDark ? 'text-red-400 hover:text-red-300' : 'text-red-600 hover:text-red-500'
  const scrollbarTrack = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)'
  const scrollbarThumb = isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.25)'

  return (
    <>
    <AnimatePresence>
      {show && (
        <>
          {/* 主菜单 */}
          <motion.div
            ref={menuRef}
            data-song-context-menu="true"
            data-tv-scope
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            transition={{ duration: 0.1 }}
            className="fixed z-[9999] rounded-xl shadow-2xl border py-2 min-w-[200px] overflow-visible"
            style={{
              left: `${adjustedPosition.x}px`,
              top: `${adjustedPosition.y}px`,
              borderColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.12)'
            }}
          >
            {/* 背景封面 + 液态玻璃效果 */}
            <div className="absolute inset-0 z-0 overflow-hidden rounded-xl">
              {/* 液态玻璃效果底层（始终显示） */}
              <div className={`absolute inset-0 bg-gradient-to-br backdrop-blur-2xl ${menuBg}`} />
              
              {/* 封面图片层（加载完成后淡入） */}
              {getCoverUrl() && (
                <div 
                  className="absolute inset-0 transition-opacity duration-500"
                  style={{ opacity: imageLoaded ? 1 : 0 }}
                >
                  <CachedImage
                    src={getCoverUrl()}
                    alt="cover"
                    className="w-full h-full object-cover"
                    onLoad={() => setImageLoaded(true)}
                  />
                  {/* 封面的液态玻璃效果遮罩 */}
                  <div className={`absolute inset-0 backdrop-blur-2xl ${coverOverlay}`} />
                </div>
              )}
            </div>
            
            {/* 菜单内容 */}
            <div className="relative z-10">
              {menuItems.map((item, index) => {
                if ('separator' in item && item.separator) {
                  return (
                    <div 
                      key={`separator-${index}`} 
                      className={`h-px my-1 mx-2 ${separatorColor}`}
                    />
                  )
                }
                
                const Icon = item.icon
                
                return (
                  <div
                    key={index}
                    ref={item.hasSubmenu ? submenuAnchorRef : undefined}
                    className="relative"
                    onMouseEnter={item.onMouseEnter}
                    onMouseLeave={item.onMouseLeave}
                  >
                    <button
                      onClick={item.onClick}
                      disabled={'disabled' in item && Boolean(item.disabled)}
                      className={`w-full px-4 py-2 text-left text-sm transition-colors flex items-center gap-3 ${hoverBg} ${
                        'disabled' in item && item.disabled
                          ? `cursor-wait ${textDisabled} hover:bg-transparent`
                          : 'danger' in item && item.danger ? dangerText : textPrimary
                      }`}
                    >
                      {Icon && <Icon className="w-4 h-4" />}
                      <span className="flex-1">{item.label}</span>
                      {item.hasSubmenu && (
                        <ChevronRight className={`w-4 h-4 ${textMuted}`} />
                      )}
                    </button>
                    
                    {/* 添加到歌单的子菜单 */}
                    {item.hasSubmenu && showPlaylistSubmenu && (
                      <motion.div
                        ref={submenuRef}
                        initial={{ opacity: 0, x: submenuPosition === 'right' ? -10 : 10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: submenuPosition === 'right' ? -10 : 10 }}
                        transition={{ duration: 0.1 }}
                        className="absolute z-30 rounded-xl shadow-2xl border py-2 min-w-[220px] overflow-hidden"
                        style={{
                          top: submenuTop,
                          maxHeight: submenuMaxHeight,
                          borderColor: isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.12)',
                          [submenuPosition === 'right' ? 'left' : 'right']: '100%',
                          [submenuPosition === 'right' ? 'marginLeft' : 'marginRight']: '0px',
                        }}
                      >
                        {/* 子菜单背景 */}
                        <div className="absolute inset-0 z-0">
                          {/* 液态玻璃效果底层（始终显示） */}
                          <div className={`absolute inset-0 bg-gradient-to-br backdrop-blur-2xl ${menuBg}`} />
                          
                          {/* 封面图片层（加载完成后淡入） */}
                          {getCoverUrl() && (
                            <div 
                              className="absolute inset-0 transition-opacity duration-500"
                              style={{ opacity: imageLoaded ? 1 : 0 }}
                            >
                              <CachedImage
                                src={getCoverUrl()}
                                alt="cover"
                                className="w-full h-full object-cover"
                              />
                              <div className={`absolute inset-0 backdrop-blur-2xl ${coverOverlay}`} />
                            </div>
                          )}
                        </div>
                        
                        {/* 子菜单内容 */}
                        <div 
                          className="relative z-10 overflow-y-auto"
                          style={{
                            maxHeight: Math.max(48, submenuMaxHeight - 16),
                            scrollbarWidth: 'thin',
                            scrollbarColor: `${scrollbarThumb} ${scrollbarTrack}`,
                            overscrollBehavior: 'contain'
                          }}
                        >
                          {ownedPlaylists.length === 0 ? (
                            <div className={`px-4 py-2 text-sm ${textMuted}`}>
                              暂无可添加的自建歌单
                            </div>
                          ) : (
                            ownedPlaylists.map((playlist) => (
                              <button
                                key={playlist.id}
                                onClick={() => {
                                  if (handleThirdPartyAction('playlist', String(playlist.dirId || playlist.id))) {
                                    onClose()
                                    return
                                  }
                                  onAddToPlaylist?.(song, String(playlist.dirId || playlist.id))
                                  onClose()
                                }}
                                className={`w-full px-4 py-2 text-left text-sm truncate transition-colors ${textPrimary} ${hoverBg}`}
                              >
                                {playlist.name}
                              </button>
                            ))
                          )}
                        </div>
                      </motion.div>
                    )}
                  </div>
                )
              })}
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
    {/* 多歌手选择：背景用当前歌曲封面（重糊压暗），列出全部歌手供选择 */}
    <AnimatePresence>
      {artistPicker && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[10020] flex items-center justify-center bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          aria-label="选择歌手"
          data-tv-scope
          onMouseDown={event => { if (event.target === event.currentTarget) setArtistPicker(null) }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97 }}
            transition={{ duration: 0.18 }}
            className="relative w-full max-w-md overflow-hidden rounded-2xl border border-white/[0.12] bg-[#101216] shadow-2xl"
          >
            {/* 卡片内部背景 = 当前歌曲封面（外部不铺图）；压暗保证文字可读 */}
            {artistPicker.song.album?.picUrl ? (
              <div className="absolute inset-0">
                <img
                  src={getProxiedImageUrl(artistPicker.song.album.picUrl, 512)}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
                <div className="absolute inset-0 bg-gradient-to-b from-black/62 via-black/58 to-black/72" />
              </div>
            ) : null}
            <div className="relative z-10 flex max-h-[70vh] flex-col">
            <div className="flex items-start justify-between gap-4 border-b border-white/[0.08] px-5 py-4">
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-white">选择歌手</h3>
                <p className="mt-0.5 truncate text-xs text-white/45">{artistPicker.song.name}</p>
              </div>
              <button type="button" onClick={() => setArtistPicker(null)} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-white/50 transition hover:bg-white/[0.08] hover:text-white" aria-label="关闭歌手选择">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="max-h-[46vh] space-y-1.5 overflow-y-auto p-4">
              {artistPicker.artists.map((artist, index) => {
                const avatar = String(artist.mid || '').trim()
                  ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${String(artist.mid).trim()}.jpg`
                  : ''
                return (
                  <button
                    key={`${artist.mid || artist.id || artist.name}-${index}`}
                    type="button"
                    onClick={() => {
                      onViewArtist?.({ ...artistPicker.song, artists: [artist] })
                      setArtistPicker(null)
                    }}
                    className="flex w-full items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.03] px-3 py-2.5 text-left transition hover:border-white/[0.14] hover:bg-white/[0.08]"
                  >
                    <span className="h-11 w-11 shrink-0 overflow-hidden rounded-full bg-white/[0.08]">
                      {avatar ? (
                        <img src={avatar} alt="" className="h-full w-full object-cover" draggable={false} />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center"><User className="h-5 w-5 text-white/40" /></span>
                      )}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-white/90">{artist.name}</span>
                    </span>
                    <ChevronRight className="h-4 w-4 shrink-0 text-white/30" />
                  </button>
                )
              })}
            </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
  )
}



