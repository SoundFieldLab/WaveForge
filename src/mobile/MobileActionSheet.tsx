/**
 * 移动端长按交互系统 —— 触屏没有右键/轮盘（PlaybackRadialMenu），对应的官方手机端
 * 惯例是「长按列表项 → 底部动作面板（Action Sheet）」。本模块提供：
 *  - useLongPress：触摸长按（450ms，移动 10px 内）触发，兼容鼠标（右键长按无意义，
 *    桌面调试时 contextmenu 触发）
 *  - MobileActionSheet：底部弹出面板（歌曲动作集 = 桌面轮盘同款语义的触屏版）
 */
import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { Song } from '../services/musicApi'
import { getSimilarSongs, getMVPlaybackInfo } from '../services/musicApi'
import { platformLabel, type MusicPlatform } from '../services/platforms'
import { peekSongFavoriteStatus } from '../services/favoriteStatusService'
import { useMobilePlayer } from './mobilePlayer'
import { useMobileBack } from './mobileBack'
import { Cover, IconClose, IconHeart, IconHeartFilled, IconMusicNote, mobileToast, songArtists } from './ui'
import type { MobileNavApi } from './nav'

const LONG_PRESS_MS = 450
const LONG_PRESS_SLOP = 10

/** 长按手势 hook：返回绑定到任意元素的长按事件 props。 */
export function useLongPress(onLongPress: () => void) {
  const timerRef = useRef<number | null>(null)
  const startRef = useRef<{ x: number; y: number } | null>(null)
  const firedRef = useRef(false)

  const cancel = useCallback(() => {
    if (timerRef.current != null) window.clearTimeout(timerRef.current)
    timerRef.current = null
    startRef.current = null
  }, [])

  useEffect(() => cancel, [cancel])

  return {
    onTouchStart: (e: React.TouchEvent) => {
      if (e.touches.length !== 1) return
      firedRef.current = false
      startRef.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }
      timerRef.current = window.setTimeout(() => {
        firedRef.current = true
        if (navigator.vibrate) { try { navigator.vibrate(12) } catch { /* ignore */ } }
        onLongPress()
      }, LONG_PRESS_MS)
    },
    onTouchMove: (e: React.TouchEvent) => {
      if (!startRef.current || e.touches.length !== 1) return
      const dx = e.touches[0].clientX - startRef.current.x
      const dy = e.touches[0].clientY - startRef.current.y
      if (Math.abs(dx) > LONG_PRESS_SLOP || Math.abs(dy) > LONG_PRESS_SLOP) cancel()
    },
    onTouchEnd: cancel,
    onTouchCancel: cancel,
    // 桌面浏览器调试：右键直接触发
    onContextMenu: (e: React.MouseEvent) => {
      e.preventDefault()
      if (!firedRef.current) onLongPress()
    },
  }
}

export interface SongActionTarget {
  song: Song
  /** 「下一首播放/加入队列」要插入的队列来源（可选，缺省仅对单曲操作） */
  list?: Song[]
  listLabel?: string
}

interface SongActionSheetProps {
  target: SongActionTarget | null
  onClose: () => void
  nav: MobileNavApi
}

/**
 * 歌曲底部动作面板：桌面右键菜单/播放轮盘的触屏对应物。
 * 动作集：立即播放 / 下一首播放 / 加入队列尾部 / 收藏 / 相似歌曲（直接播）/
 * 观看 MV / 查看歌手 / 查看专辑 / 复制信息。
 */
export const MobileSongActionSheet = memo(function MobileSongActionSheet({ target, onClose, nav }: SongActionSheetProps) {
  const player = useMobilePlayer()
  const [mvLoading, setMvLoading] = useState(false)
  const [favBusy, setFavBusy] = useState(false)
  useMobileBack(() => {
    if (target) { onClose(); return true }
    return false
  }, [Boolean(target), onClose])

  if (!target) return null
  const song = target.song
  const platform = (song.platform || 'netease') as MusicPlatform
  const like = peekSongFavoriteStatus(song, platform, nav.userId || '') ?? false

  const close = () => onClose()

  const actions: Array<{ icon: ReactNode; label: string; danger?: boolean; run: () => void | Promise<void> }> = [
    {
      icon: <IconMusicNote size={18} />,
      label: '立即播放',
      run: () => { player.playSongs(target.list?.length ? target.list : [song], target.list ? target.list.indexOf(song) : 0, target.listLabel || song.name); close() },
    },
    {
      icon: <IconMusicNote size={18} />,
      label: '下一首播放',
      run: () => { player.insertNext(song); close() },
    },
    {
      icon: <IconMusicNote size={18} />,
      label: '加入队列末尾',
      run: () => { player.appendToQueue(song); close() },
    },
    {
      icon: like ? <IconHeartFilled size={18} /> : <IconHeart size={18} />,
      label: like ? '取消喜欢' : '喜欢',
      run: async () => {
        setFavBusy(true)
        try { await player.toggleFavoriteFor(song, like) } finally { setFavBusy(false) }
        close()
      },
    },
    {
      icon: <IconMusicNote size={18} />,
      label: '相似歌曲',
      run: async () => {
        mobileToast('正在寻找相似歌曲…')
        try {
          const similar = await getSimilarSongs(String(song.platform === 'qq' ? (song.mid || song.id) : song.id), platform)
          if (similar?.length) { player.playSongs(similar, 0, `与「${song.name}」相似`); close() }
          else mobileToast('没有找到相似歌曲', 'error')
        } catch { mobileToast('相似歌曲获取失败', 'error') }
      },
    },
    {
      icon: <IconMusicNote size={18} />,
      label: mvLoading ? 'MV 匹配中…' : '观看 MV',
      run: async () => {
        // mv id 由搜索/详情接口透传（网易 mv 数字 id / QQ vid）；拿不到 id 才提示无 MV
        const mvId = song.mv ?? (song as { mvid?: number | string }).mvid
        if (!mvId) { mobileToast('这首歌没有 MV'); return }
        setMvLoading(true)
        try {
          const info = await getMVPlaybackInfo(mvId, 1080, platform)
          if (info.url) { nav.openMv({ url: info.url, title: song.name, artist: songArtists(song) }); close() }
          else mobileToast(info.error || info.needCookie ? 'MV 需要登录或版权受限' : 'MV 获取失败', 'error')
        } catch { mobileToast('MV 获取失败', 'error') } finally { setMvLoading(false) }
      },
    },
    ...song.artists?.slice(0, 1).map(a => ({
      icon: <IconMusicNote size={18} />,
      label: `歌手：${a.name}`,
      run: () => { if (a.id != null) { nav.openArtist({ id: String(a.id), name: a.name, platform }); close() } else mobileToast('该歌手暂无主页') },
    })) || [],
    ...(song.album?.id != null || song.album?.mid) ? [{
      icon: <IconMusicNote size={18} />,
      label: `专辑：${song.album?.name || ''}`,
      run: () => {
        const albumId = song.album?.id ?? song.album?.mid
        nav.openAlbum({ id: String(albumId), name: song.album?.name || '', coverUrl: song.album?.picUrl || '', platform })
        close()
      },
    }] : [],
    {
      icon: <IconClose size={16} />,
      label: '复制信息',
      run: async () => {
        const text = `${song.name} - ${songArtists(song)}（${platformLabel(platform)}）`
        try { await navigator.clipboard.writeText(text); mobileToast('已复制歌曲信息', 'success') } catch { mobileToast('复制失败', 'error') }
        close()
      },
    },
  ]

  return createPortal(
    <div className="wf-m-sheet-mask" onClick={close}>
      <div className="wf-m-actionsheet" onClick={e => e.stopPropagation()}>
        <div className="wf-m-actionsheet-head">
          <Cover song={song} size={120} rounded={10} />
          <div className="wf-m-actionsheet-meta">
            <div className="wf-m-actionsheet-title">{song.name}</div>
            <div className="wf-m-actionsheet-sub">{songArtists(song)}</div>
          </div>
        </div>
        <div className="wf-m-actionsheet-list">
          {actions.map((a, i) => (
            <button
              key={i}
              type="button"
              className={`wf-m-actionsheet-item ${a.danger ? 'is-danger' : ''}`}
              disabled={favBusy && a.label.includes('喜欢')}
              onClick={() => { void a.run() }}
            >
              {a.icon}<span>{a.label}</span>
            </button>
          ))}
        </div>
        <button type="button" className="wf-m-actionsheet-cancel" onClick={close}>取消</button>
      </div>
    </div>,
    document.body,
  )
})
