import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Copy, Disc3, Heart, HeartOff, Info, ListMusic, MessageCircle, Repeat2, Search, UserRound , Lightbulb} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getPlatformCapabilities, getPlatformFavoriteLabels } from '../services/platforms'
import {
  getPlaybackRadialActions,
  getAvailablePlaybackRadialActions,
  PLAYBACK_RADIAL_MENU_SETTINGS_EVENT,
  type PlaybackRadialActionId,
} from '../services/playbackRadialMenuSettings'
import SongContextMenu from './SongContextMenu'
import PlaybackAddToPlaylistModal from './PlaybackAddToPlaylistModal'
import PlaybackRadialWheel from './PlaybackRadialWheel'


interface PlaybackRadialMenuProps {
  song: Song
  accentColor: string
  liked: boolean
  userPlaylists: any[]
  playlistsLoading?: boolean
  playerTheme?: 'light' | 'dark'
  onPlayNow: (song: Song) => void
  onPlayNext: (song: Song) => void
  onToggleFavorite: (song: Song, liked: boolean) => void
  onAddToFavorites: (song: Song) => void
  onRemoveFromFavorites: (song: Song) => void
  onAddToPlaylist: (song: Song, playlistId: string) => void
  onViewComments: (song: Song) => void
  onViewAlbum: (song: Song) => void
  onViewArtist: (song: Song) => void
  onCopyInfo: (song: Song) => void
  onContextMenuOpen?: () => void
  /** 当前播放来自 QQ 刷歌：右键菜单提供「音乐偏好设置」 */
  showMusicPreference?: boolean
  onOpenMusicPreference?: () => void
}

const LONG_PRESS_MS = 500
const DIRECTION_THRESHOLD = 38

const ACTION_ICONS: Record<PlaybackRadialActionId, LucideIcon> = {
  'play-next': Repeat2,
  favorite: Heart,
  comments: MessageCircle,
  album: Disc3,
  artist: UserRound,
  details: Info,
  'add-to-playlist': ListMusic,
  'copy-info': Copy,
  similar: Lightbulb,
}

export default function PlaybackRadialMenu({
  song,
  accentColor,
  liked,
  userPlaylists,
  playlistsLoading = false,
  playerTheme = 'dark',
  onPlayNow,
  onPlayNext,
  onToggleFavorite,
  onAddToFavorites,
  onRemoveFromFavorites,
  onAddToPlaylist,
  onViewComments,
  onViewAlbum,
  onViewArtist,
  onCopyInfo,
  onContextMenuOpen,
  showMusicPreference,
  onOpenMusicPreference,
}: PlaybackRadialMenuProps) {
  const [contextMenu, setContextMenu] = useState({ show: false, x: 0, y: 0 })
  const [showPlaylistPicker, setShowPlaylistPicker] = useState(false)
  const [radialCenter, setRadialCenter] = useState<{ x: number; y: number } | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null)
  const [configuredActions, setConfiguredActions] = useState<PlaybackRadialActionId[]>(() => getPlaybackRadialActions())
  const originRef = useRef({ x: 0, y: 0 })
  const selectedIndexRef = useRef<number | null>(null)
  const trackingRef = useRef(false)
  const radialVisibleRef = useRef(false)
  /** 手势期间 + 松手后一小段窗口内吞掉所有 contextmenu（时间戳）：
   *  Windows/Electron 的系统右键菜单在 mouseup **之后**才派发，而此刻光标下的元素可能已经被
   *  轮盘动作打开的模态框/歌单选择器换掉（目标不再属于播放页，按目标判断会漏过）→ 系统菜单闪一下。
   *  这次右键已经被轮盘消费，就不该再弹系统菜单。 */
  const contextMenuSuppressUntilRef = useRef(0)
  const longPressTimerRef = useRef<number | null>(null)
  const songRef = useRef(song)
  const likedRef = useRef(liked)
  const contextMenuOpenRef = useRef(onContextMenuOpen)
  const actionsRef = useRef({ onToggleFavorite, onViewComments, onViewAlbum, onViewArtist, onPlayNow, onPlayNext, onCopyInfo })
  songRef.current = song
  likedRef.current = liked
  contextMenuOpenRef.current = onContextMenuOpen
  actionsRef.current = { onToggleFavorite, onViewComments, onViewAlbum, onViewArtist, onPlayNow, onPlayNext, onCopyInfo }

  const availableActions = getAvailablePlaybackRadialActions(song.platform)
  const actionSet = new Set(availableActions.map(action => action.id))
  // 已喜欢 + 平台不支持取消喜欢（酷狗）→ 藏掉收藏键：否则点了会走"取消喜欢"但上游不落库，
  // 界面还 toast 成功（假成功）。与右键菜单 SongContextMenu 的判断保持同一来源。
  if (liked && !getPlatformCapabilities(song.platform || 'netease').unlikeSong) actionSet.delete('favorite')
  const actions = configuredActions.filter(id => actionSet.has(id)).slice(0, 8)
  const favoriteLabels = getPlatformFavoriteLabels(song.platform || 'netease')
  const isDark = playerTheme === 'dark'

  useEffect(() => {
    const sync = () => setConfiguredActions(getPlaybackRadialActions())
    window.addEventListener(PLAYBACK_RADIAL_MENU_SETTINGS_EVENT, sync)
    return () => window.removeEventListener(PLAYBACK_RADIAL_MENU_SETTINGS_EVENT, sync)
  }, [])

  useEffect(() => {
    const clearLongPressTimer = () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
    }
    const resetGesture = () => {
      clearLongPressTimer()
      trackingRef.current = false
      radialVisibleRef.current = false
      selectedIndexRef.current = null
      setSelectedIndex(null)
      setRadialCenter(null)
    }
    const isPlaybackPageTarget = (target: EventTarget | null) => target instanceof Element && Boolean(target.closest('[data-waveforge-playback-page="true"]'))
    const handleMouseDown = (event: MouseEvent) => {
      if (event.button !== 2 || !isPlaybackPageTarget(event.target)) return
      if (event.target instanceof Element && event.target.closest('[data-playback-radial-block="true"]')) return
      event.preventDefault()
      resetGesture()
      setContextMenu(previous => ({ ...previous, show: false }))
      trackingRef.current = true
      originRef.current = { x: event.clientX, y: event.clientY }
      longPressTimerRef.current = window.setTimeout(() => {
        if (!trackingRef.current) return
        radialVisibleRef.current = true
        setRadialCenter({ ...originRef.current })
        longPressTimerRef.current = null
      }, LONG_PRESS_MS)
    }
    const handleMouseMove = (event: MouseEvent) => {
      if (!trackingRef.current || !radialVisibleRef.current || actions.length === 0) return
      const dx = event.clientX - originRef.current.x
      const dy = event.clientY - originRef.current.y
      if (Math.hypot(dx, dy) < DIRECTION_THRESHOLD) {
        if (selectedIndexRef.current !== null) {
          selectedIndexRef.current = null
          setSelectedIndex(null)
        }
        return
      }
      const angle = Math.atan2(dy, dx) + Math.PI / 2
      const normalized = (angle + Math.PI * 2) % (Math.PI * 2)
      const index = Math.round(normalized / (Math.PI * 2 / actions.length)) % actions.length
      if (index !== selectedIndexRef.current) {
        selectedIndexRef.current = index
        setSelectedIndex(index)
      }
    }
    const handleMouseUp = (event: MouseEvent) => {
      if (event.button !== 2 || !trackingRef.current) return
      event.preventDefault()
      // 松手后系统还会补发一次 contextmenu（Windows 在 mouseup 之后），保持一段抑制窗口
      contextMenuSuppressUntilRef.current = Date.now() + 600
      if (radialVisibleRef.current) {
        const action = selectedIndexRef.current == null ? undefined : actions[selectedIndexRef.current]
        const currentSong = songRef.current
        if (action === 'favorite') actionsRef.current.onToggleFavorite(currentSong, likedRef.current)
        else if (action === 'play-next') actionsRef.current.onPlayNext(currentSong)
        else if (action === 'comments' && getPlatformCapabilities(currentSong.platform || 'netease').comments) actionsRef.current.onViewComments(currentSong)
        else if (action === 'album') actionsRef.current.onViewAlbum(currentSong)
        else if (action === 'artist') actionsRef.current.onViewArtist(currentSong)
        else if (action === 'copy-info') actionsRef.current.onCopyInfo(currentSong)
        else if (action === 'details') window.dispatchEvent(new CustomEvent('waveforge:show-song-detail', { detail: currentSong }))
        // 酷狗客户端的相似歌曲是弹窗列表（其余平台沿用网易云灯泡式直接切歌）
        else if (action === 'similar') window.dispatchEvent(new CustomEvent(
          (currentSong.platform || 'netease') === 'kugou' ? 'waveforge:show-similar-songs' : 'waveforge:play-similar-song',
          { detail: currentSong },
        ))
        else if (action === 'add-to-playlist') {
          contextMenuOpenRef.current?.()
          setShowPlaylistPicker(true)
        }
        resetGesture()
        return
      }
      clearLongPressTimer()
      trackingRef.current = false
      setContextMenu({ show: true, x: originRef.current.x, y: originRef.current.y })
      contextMenuOpenRef.current?.()
    }
    const handleContextMenu = (event: MouseEvent) => {
      // 正在右键手势中 / 手势刚结束：这一次右键已被轮盘或自绘菜单消费，系统菜单一律不弹。
      // 必须先于目标判断——轮盘动作可能当场换掉光标下的元素（模态框/歌单选择器/Toast），
      // 此时 event.target 已不在播放页内，只按目标判断就会漏过并闪出系统菜单（用户实测）。
      if (trackingRef.current || Date.now() < contextMenuSuppressUntilRef.current) {
        event.preventDefault()
        // 只 preventDefault 挡不住 React 的合成 onContextMenu：Windows 在 mouseup 之后补发的
        // 这一次 contextmenu 会落在「轮盘动作刚打开的新界面」上（例如歌手详情里的歌曲行），
        // 于是右键菜单跟着自己弹出来（用户实测：长按轮盘选「查看歌手」后菜单自现）。
        // 捕获阶段 stopPropagation 把这次残留事件整个吃掉。
        event.stopPropagation()
        return
      }
      if (!isPlaybackPageTarget(event.target)) return
      if (event.target instanceof Element && event.target.closest('[data-playback-radial-block="true"]')) return
      event.preventDefault()
      // TV 长按 OK：没有前置右键 mousedown 的 contextmenu 事件 = 遥控器菜单请求
      // → 在焦点元素位置打开 SongContextMenu（动作集与径向菜单一致，遥控器无右键手势）
      if (!trackingRef.current && !radialVisibleRef.current) {
        const rect = event.target instanceof Element ? event.target.getBoundingClientRect() : null
        setContextMenu({
          show: true,
          x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
          y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2,
        })
        contextMenuOpenRef.current?.()
      }
    }
    document.addEventListener('mousedown', handleMouseDown, true)
    document.addEventListener('mousemove', handleMouseMove, true)
    document.addEventListener('mouseup', handleMouseUp, true)
    document.addEventListener('contextmenu', handleContextMenu, true)
    window.addEventListener('blur', resetGesture)
    return () => {
      resetGesture()
      document.removeEventListener('mousedown', handleMouseDown, true)
      document.removeEventListener('mousemove', handleMouseMove, true)
      document.removeEventListener('mouseup', handleMouseUp, true)
      document.removeEventListener('contextmenu', handleContextMenu, true)
      window.removeEventListener('blur', resetGesture)
    }
  }, [actions.length, actions.join('|')])

  const menuLabels = new Map<PlaybackRadialActionId, string>([
    ['favorite', liked ? favoriteLabels.remove : favoriteLabels.add],
    ['comments', '查看评论'], ['album', '查看专辑'], ['artist', '查看歌手'], ['details', '查看详情'],
    ['play-next', '再听一次'], ['add-to-playlist', '添加到歌单'], ['copy-info', '复制信息'], ['similar', '相似歌曲'],
  ])

  return (
    <>
      <SongContextMenu
        show={contextMenu.show} x={contextMenu.x} y={contextMenu.y} song={song}
        onClose={() => setContextMenu(previous => ({ ...previous, show: false }))}
        onPlayNow={onPlayNow} onPlayNext={onPlayNext} onAddToFavorites={onAddToFavorites}
        onRemoveFromFavorites={onRemoveFromFavorites} onAddToPlaylist={onAddToPlaylist}
        onViewComments={onViewComments} onViewAlbum={onViewAlbum} onViewArtist={onViewArtist}
        onCopyInfo={onCopyInfo} userPlaylists={userPlaylists} platform={song.platform || 'netease'}
        playerTheme={playerTheme} hideFavoriteAction={liked}
        showMusicPreference={showMusicPreference}
        onOpenMusicPreference={onOpenMusicPreference}
      />
      <PlaybackAddToPlaylistModal
        show={showPlaylistPicker}
        song={song}
        playlists={userPlaylists}
        loading={playlistsLoading}
        accentColor={accentColor}
        playerTheme={playerTheme}
        onClose={() => setShowPlaylistPicker(false)}
        onAdd={onAddToPlaylist}
      />
      <AnimatePresence>
        {radialCenter && (
          <div className="pointer-events-none fixed z-[10020] h-80 w-80 -translate-x-1/2 -translate-y-1/2" style={{ left: radialCenter.x, top: radialCenter.y }}>
            <motion.div
              initial={{ opacity: 0, scale: 0.72, rotate: -8 }} animate={{ opacity: 1, scale: 1, rotate: 0 }} exit={{ opacity: 0, scale: 0.82 }}
              transition={{ type: 'spring', stiffness: 360, damping: 26 }}
              className="relative h-full w-full"
            >
              <PlaybackRadialWheel
                items={actions.map(actionId => ({
                  id: actionId,
                  label: menuLabels.get(actionId) || actionId,
                  Icon: actionId === 'favorite' && liked ? HeartOff : ACTION_ICONS[actionId],
                }))}
                selectedIndex={selectedIndex}
                accentColor={accentColor}
                isDark={isDark}
              />
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </>
  )
}
