/**
 * 移动端歌单管理弹窗集：
 *  - MobileCreatePlaylistSheet：新建歌单（输入名字 → createPlaylist）
 *  - MobileAddToPlaylistSheet：把歌曲加入/收藏到某个歌单（列出用户歌单 → addSongToPlaylist）
 * 服务层与 PC 完全同源（services/playlistService），本模块只做触屏 UI 接线。
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  createPlaylist, deletePlaylist, subscribePlaylist, addSongToPlaylist, getUserPlaylists,
} from '../services/playlistService'
import type { Song } from '../services/musicApi'
import { platformLabel, type MusicPlatform } from '../services/platforms'
import { mobileToast, IconClose, Spinner } from './ui'

interface AccountInfo { loggedIn?: boolean; userId?: string; username?: string }

function requireLogin(account: AccountInfo | undefined, platform: MusicPlatform): string | null {
  if (!account?.loggedIn || !account.userId) {
    mobileToast(`请先登录${platformLabel(platform)}`, 'error')
    return null
  }
  return account.userId
}

/** 新建歌单弹窗。onCreated 后调用方自行刷新列表。 */
export const MobileCreatePlaylistSheet = memo(function MobileCreatePlaylistSheet({
  open, platform, account, onClose, onCreated,
}: {
  open: boolean
  platform: MusicPlatform
  account: AccountInfo | undefined
  onClose: () => void
  onCreated?: () => void
}) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (open) setName('') }, [open])

  const submit = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed) { mobileToast('请输入歌单名'); return }
    const userId = requireLogin(account, platform)
    if (!userId || busy) return
    setBusy(true)
    try {
      await createPlaylist(trimmed, platform)
      mobileToast(`歌单「${trimmed}」创建成功`, 'success')
      onCreated?.()
      onClose()
    } catch (err) {
      mobileToast(err instanceof Error ? err.message : '创建歌单失败', 'error')
    } finally {
      setBusy(false)
    }
  }, [name, account, platform, busy, onClose, onCreated])

  if (!open) return null
  return createPortal(
    <div className="wf-m-sheet-mask" onClick={onClose}>
      <div className="wf-m-actionsheet" onClick={e => e.stopPropagation()}>
        <div className="wf-m-actionsheet-head">
          <div className="wf-m-actionsheet-meta">
            <div className="wf-m-actionsheet-title">新建歌单</div>
            <div className="wf-m-actionsheet-sub">{platformLabel(platform)}</div>
          </div>
          <button type="button" className="wf-m-iconbtn" onClick={onClose}><IconClose size={18} /></button>
        </div>
        <div className="wf-m-form-body">
          <input
            className="wf-m-form-input"
            type="text"
            maxLength={40}
            placeholder="歌单名（最多 40 字）"
            value={name}
            autoFocus
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') void submit() }}
          />
          <button type="button" className="wf-m-btn wf-m-btn-primary" disabled={busy} onClick={() => void submit()}>
            {busy ? <Spinner /> : '创建'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
})

interface UserPlaylistOption { id: string | number; name: string; isLike?: boolean; trackCount?: number }

/** 加入歌单弹窗：列出用户歌单（我喜欢的音乐固定第一个），点击即写入。 */
export const MobileAddToPlaylistSheet = memo(function MobileAddToPlaylistSheet({
  song, platform, account, onClose, onAdded,
}: {
  song: Song | null
  platform: MusicPlatform
  account: AccountInfo | undefined
  onClose: () => void
  onAdded?: () => void
}) {
  const [playlists, setPlaylists] = useState<UserPlaylistOption[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  useEffect(() => {
    if (!song) return
    setPlaylists(null)
    getUserPlaylists(platform, account?.userId || '').then((items: UserPlaylistOption[]) => {
      // 我喜欢的排最前
      const list = (items || []) as UserPlaylistOption[]
      list.sort((a, b) => Number(Boolean(b.isLike)) - Number(Boolean(a.isLike)))
      setPlaylists(list)
    }).catch(() => setPlaylists([]))
  }, [song, platform, account?.userId])

  const add = useCallback(async (pl: UserPlaylistOption) => {
    if (!song || busyId) return
    const userId = requireLogin(account, platform)
    if (!userId) return
    setBusyId(String(pl.id))
    try {
      await addSongToPlaylist(String(pl.id), String(song.platform === 'qq' ? (song.mid || song.id) : song.id), userId, platform, {
        songMid: song.mid,
        songType: song.songType,
        songName: song.name,
        songArtists: song.artists,
        songAlbumAudioId: typeof song.album?.id === 'number' ? song.album.id : undefined,
      })
      mobileToast(`已加入「${pl.name}」`, 'success')
      window.dispatchEvent(new CustomEvent('playlist-content-changed', {
        detail: { platform, type: 'add', songId: song.id, songMid: song.mid, playlistId: pl.id },
      }))
      onAdded?.()
      onClose()
    } catch (err) {
      mobileToast(err instanceof Error ? err.message : '添加失败', 'error')
    } finally {
      setBusyId(null)
    }
  }, [song, busyId, account, platform, onClose, onAdded])

  if (!song) return null
  return createPortal(
    <div className="wf-m-sheet-mask" onClick={onClose}>
      <div className="wf-m-actionsheet" onClick={e => e.stopPropagation()}>
        <div className="wf-m-actionsheet-head">
          <div className="wf-m-actionsheet-meta">
            <div className="wf-m-actionsheet-title">加入歌单</div>
            <div className="wf-m-actionsheet-sub">{song.name}</div>
          </div>
          <button type="button" className="wf-m-iconbtn" onClick={onClose}><IconClose size={18} /></button>
        </div>
        <div className="wf-m-actionsheet-list">
          {playlists === null && <Spinner label="加载歌单…" />}
          {playlists != null && !playlists.length && <p className="wf-m-hint">还没有歌单，先在「我的」页新建一个</p>}
          {playlists?.map(pl => (
            <button
              key={String(pl.id)}
              type="button"
              className="wf-m-actionsheet-item"
              disabled={busyId === String(pl.id)}
              onClick={() => void add(pl)}
            >
              {pl.isLike ? '❤️' : '🎵'}<span>{busyId === String(pl.id) ? '添加中…' : pl.name}</span>
            </button>
          ))}
        </div>
        <button type="button" className="wf-m-actionsheet-cancel" onClick={onClose}>取消</button>
      </div>
    </div>,
    document.body,
  )
})

/** 歌单行管理动作（我的页长按歌单）：删除（自建）/ 收藏或取消收藏。 */
export const MobilePlaylistManageSheet = memo(function MobilePlaylistManageSheet({
  playlist, platform, account, owned, onClose, onChanged,
}: {
  playlist: { id: string; name: string; subscribed?: boolean } | null
  platform: MusicPlatform
  account: AccountInfo | undefined
  /** 是否本人创建的歌单（可删除）；否则提供收藏/取消收藏 */
  owned: boolean
  onClose: () => void
  onChanged?: () => void
}) {
  const [busy, setBusy] = useState(false)
  if (!playlist) return null

  const run = async (fn: () => Promise<unknown>, okMsg: string) => {
    const userId = requireLogin(account, platform)
    if (!userId || busy) return
    setBusy(true)
    try {
      await fn()
      mobileToast(okMsg, 'success')
      onChanged?.()
      onClose()
    } catch (err) {
      mobileToast(err instanceof Error ? err.message : '操作失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="wf-m-sheet-mask" onClick={onClose}>
      <div className="wf-m-actionsheet" onClick={e => e.stopPropagation()}>
        <div className="wf-m-actionsheet-head">
          <div className="wf-m-actionsheet-meta">
            <div className="wf-m-actionsheet-title">{playlist.name}</div>
            <div className="wf-m-actionsheet-sub">{platformLabel(platform)}</div>
          </div>
          <button type="button" className="wf-m-iconbtn" onClick={onClose}><IconClose size={18} /></button>
        </div>
        <div className="wf-m-actionsheet-list">
          {owned ? (
            <button
              type="button"
              className="wf-m-actionsheet-item is-danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`确定删除歌单「${playlist.name}」？此操作不可撤销`)) {
                  void run(() => deletePlaylist(playlist.id, platform), '歌单已删除')
                }
              }}
            >
              🗑️<span>{busy ? '删除中…' : '删除歌单'}</span>
            </button>
          ) : (
            <button
              type="button"
              className="wf-m-actionsheet-item"
              disabled={busy}
              onClick={() => void run(() => subscribePlaylist(playlist.id, !playlist.subscribed, platform), playlist.subscribed ? '已取消收藏' : '已收藏歌单')}
            >
              {playlist.subscribed ? '💔' : '💚'}<span>{busy ? '操作中…' : playlist.subscribed ? '取消收藏' : '收藏歌单'}</span>
            </button>
          )}
        </div>
        <button type="button" className="wf-m-actionsheet-cancel" onClick={onClose}>取消</button>
      </div>
    </div>,
    document.body,
  )
})
