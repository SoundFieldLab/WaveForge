import { motion, AnimatePresence } from 'framer-motion'
import { Play, ListPlus, Heart, HeartOff, MessageSquare, Disc, User, Copy, ChevronRight, Info, ListMusic, ThumbsDown } from 'lucide-react'
import { Song, getProxiedImageUrl } from '../services/musicApi'
import { getPlatformCapabilities, getPlatformCookie, platformLabel } from '../services/platforms'
import type { MusicPlatform } from '../services/platforms'
import { useEffect, useLayoutEffect, useState, useRef } from 'react'
import { useTvBack } from '../tv/tvCore'
import CachedImage from './CachedImage'
import {
  applyFavoriteMutation,
  getFavoriteSongIdentifiers,
  getFavoriteUserId,
  loadFavoriteIdentifiers,
  peekSongFavoriteStatus,
} from '../services/favoriteStatusService'
import { addSodaSongToPlaylist, checkSodaLiked, isSodaLoggedIn, setSodaTrackLiked } from '../services/sodaService'
import { addKugouSongToPlaylist, likeKugouSong } from '../services/kugouService'

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
  onDislike?: (song: Song) => void
  userPlaylists: any[]
  platform: MusicPlatform
  playerTheme?: 'light' | 'dark'
  hideFavoriteAction?: boolean
  currentPlaylistId?: string
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
  onDislike,
  userPlaylists,
  platform,
  playerTheme = 'dark',
  hideFavoriteAction = false,
  currentPlaylistId
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
  const favoriteUserId = getFavoriteUserId(resolvedPlatform)
  const [favoriteStatus, setFavoriteStatus] = useState<boolean | null>(() => (
    hideFavoriteAction ? true : song ? peekSongFavoriteStatus(song, resolvedPlatform, favoriteUserId) : null
  ))

  useEffect(() => {
    if (!show || !song) return
    // 红心状态唯一真相源：favoriteStatusService 归属键缓存（netease/qq/soda 统一，
    // 汽水归属键为 soda_user_id，喜欢列表由 playlistService.getLikedSongs 走 qishui-liked 分页拉全量）
    const cachedStatus = peekSongFavoriteStatus(song, resolvedPlatform, favoriteUserId)
    setFavoriteStatus(cachedStatus ?? (hideFavoriteAction ? true : null))
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

  // 菜单在未选中歌曲时仍会随页面渲染；此时保持空渲染，不能读取歌曲字段。
  if (!song) return null

  // 获取评论数显示文本
  const getCommentCountText = () => {
    if (!song) return ''
    const count = (song as Song & { commentCount?: number }).commentCount || 0
    if (count > 1000) {
      return '999+'
    }
    return count > 0 ? count.toString() : ''
  }

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
  // kugou 走 H5 网关（喜欢/加歌为真实能力；「取消喜欢」上游无移除端点，在按钮层隐藏）
  const handleThirdPartyAction = (action: 'like' | 'unlike' | 'playlist', playlistId?: string): boolean => {
    const p = resolvedPlatform
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
      // 酷狗：喜欢=H5 网关加入默认「我喜欢」歌单（真实写入），加歌=/v6/add_song（真实）。
      // 取消喜欢上游无移除端点（服务端对 like=false 只回执不落库），入口已在按钮层隐藏，
      // 这里兜底给出准确提示而不是假装成功。
      const kugouHash = String(song.mid || '')
      if (action === 'playlist' && playlistId) {
        void addKugouSongToPlaylist(playlistId, { hash: kugouHash }).then(ok => {
          showMenuToast(ok ? '已添加到酷狗歌单' : '添加到酷狗歌单失败', ok ? 'success' : 'error')
        })
      } else if (action === 'like') {
        void likeKugouSong({ hash: kugouHash }, true).then(ok => {
          if (ok) {
            setFavoriteStatus(true)
            applyFavoriteMutation({ platform: 'kugou', type: 'like', songId: song.id, songMid: song.mid })
          }
          showMenuToast(ok ? '已加入酷狗喜欢' : '喜欢失败，请检查登录状态', ok ? 'success' : 'error')
        })
      } else {
        showMenuToast('酷狗音乐暂不支持取消喜欢：上游未提供移除歌曲的接口', 'info')
      }
      return true
    }
    showMenuToast('该平台暂不支持此操作', 'info')
    return true
  }
  const ownedPlaylists = userPlaylists.filter((playlist) => {
    if (playlist.isCollected || playlist.isLike) return false
    // 显式标注平台的歌单：平台需与菜单平台或当前歌曲平台一致
    // （汽水歌曲右键时 platform prop 可能仍是浏览页平台，需按 resolvedPlatform 放行汽水歌单）
    const declaredPlatform = playlist.platform as MusicPlatform | undefined
    if (declaredPlatform && declaredPlatform !== platform && declaredPlatform !== resolvedPlatform) return false
    const mutationId = String(playlist.dirId || playlist.id)
    if (currentPlaylistId && mutationId === String(currentPlaylistId)) return false
    // 归属校验按歌单自身平台取对应 userId；未标注平台的歌单沿用菜单平台，行为不变
    const ownerPlatform = declaredPlatform || platform
    // Apple 资料库歌单无 userId 概念，直接放行
    if (ownerPlatform === 'apple') return true
    const playlistUserId = playlist.userId == null ? '' : String(playlist.userId)
    const ownerUserId = ownerPlatform === platform
      ? currentUserId
      : (localStorage.getItem(getUserStorageKey(ownerPlatform)) || '')
    // 歌单列表本身来自当前登录用户；旧会话没有落盘 userId 时也应能显示自建歌单。
    return !playlistUserId || !ownerUserId || playlistUserId === ownerUserId
  })
  // 红心显示统一由 favoriteStatus 通用缓存驱动（含汽水）；identifiers 在途时显示加载占位
  const favoriteActionIsRemove = favoriteStatus ?? hideFavoriteAction
  const favoriteStatusLoading = favoriteStatus === null && Boolean(favoriteUserId)

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
    ...(!favoriteStatusLoading && !favoriteActionIsRemove && onAddToFavorites ? [{
      label: '我喜欢',
      icon: Heart,
      onClick: () => {
        if (handleThirdPartyAction('like')) { onClose(); return }
        onAddToFavorites(song)
        onClose()
      }
    }] : []),
    // 酷狗「取消喜欢」上游无移除端点（/api/kugou/like like=false 只回执不生效）——诚实隐藏该入口，
    // 其余平台照常展示；「我喜欢」新增仍走真实网关不受影响
    ...(!favoriteStatusLoading && favoriteActionIsRemove && onRemoveFromFavorites && resolvedPlatform !== 'kugou' ? [{
      label: '从喜欢歌单中移除',
      icon: HeartOff,
      onClick: () => {
        if (handleThirdPartyAction('unlike')) { onClose(); return }
        onRemoveFromFavorites(song)
        onClose()
      },
      danger: true
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
      label: `查看评论${getCommentCountText() ? ` (${getCommentCountText()})` : ''}`,
      icon: MessageSquare,
      onClick: () => {
        onViewComments(song)
        onClose()
      }
    }] : []),
    ...(onViewAlbum ? [{
      label: '查看专辑',
      icon: Disc,
      onClick: () => {
        onViewAlbum?.(song)
        onClose()
      }
    }] : []),
    ...(onViewArtist ? [{
      label: '查看歌手',
      icon: User,
      onClick: () => {
        onViewArtist?.(song)
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
      icon: ListMusic,
      onClick: () => {
        window.dispatchEvent(new CustomEvent('waveforge:show-similar-songs', { detail: song }))
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
    }] : [])
  ]

  // 主题配色：菜单本身是液态玻璃风格，浅色模式下换成浅色底
  const isDark = playerTheme === 'dark'
  const menuBg = isDark ? 'from-gray-900 to-gray-800' : 'from-gray-50 to-gray-200'
  const coverOverlay = isDark ? 'bg-black/60' : 'bg-white/50'
  const borderColor = isDark ? 'border-white/10' : 'border-black/10'
  const hoverBg = isDark ? 'hover:bg-white/10' : 'hover:bg-black/5'
  const separatorColor = isDark ? 'bg-white/10' : 'bg-black/10'
  const textPrimary = isDark ? 'text-white/90' : 'text-black/85'
  const textMuted = isDark ? 'text-white/50' : 'text-black/50'
  const textDisabled = isDark ? 'text-white/45' : 'text-black/40'
  const dangerText = isDark ? 'text-red-400 hover:text-red-300' : 'text-red-600 hover:text-red-500'
  const scrollbarTrack = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)'
  const scrollbarThumb = isDark ? 'rgba(255, 255, 255, 0.3)' : 'rgba(0, 0, 0, 0.25)'

  return (
    <AnimatePresence>
      {show && (
        <>
          {/* 主菜单 */}
          <motion.div
            ref={menuRef}
            data-song-context-menu="true"
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
  )
}



