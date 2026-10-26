/**
 * 移动端「我的」页：当前平台的我创建/收藏歌单 + 我喜欢的音乐 + 最近播放。
 */
import { memo, useCallback, useEffect, useState } from 'react'
import { getUserPlaylists } from '../../services/playlistService'
import type { Song } from '../../services/musicApi'
import { platformLabel } from '../../services/platforms'
import { useMobileNav } from '../nav'
import { useMobilePlayer } from '../mobilePlayer'
import { useAccounts } from '../mobileLogin'
import { Cover, EmptyState, ErrorRetry, IconHeartFilled, Spinner, songArtists, useLazyList } from '../ui'

const RECENT_KEY = 'waveforge:mobile-recent'

interface UserPlaylistItem {
  id: string | number
  name: string
  coverImgUrl?: string
  coverUrl?: string
  trackCount?: number
  isLike?: boolean
  creator?: string | { nickname?: string }
}

export default memo(function MobileLibrary() {
  const nav = useMobileNav()
  const { accounts } = useAccounts()
  const account = accounts[nav.platform]
  const [playlists, setPlaylists] = useState<UserPlaylistItem[] | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [recent, setRecent] = useState<Song[]>(() => readRecent())

  function readRecent(): Song[] {
    try {
      const raw = localStorage.getItem(RECENT_KEY)
      const list = raw ? (JSON.parse(raw) as Song[]) : []
      return Array.isArray(list) ? list.filter(s => s && s.name) : []
    } catch {
      return []
    }
  }

  const load = useCallback(() => {
    // 酷狗/汽水/Apple/Spotify 没有传统用户歌单接口
    if (nav.platform !== 'netease' && nav.platform !== 'qq') {
      setPlaylists([])
      setLoading(false)
      return
    }
    if (!account?.loggedIn || !account.userId) {
      setPlaylists(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setError('')
    getUserPlaylists(nav.platform, account.userId, account.username || undefined)
      .then(items => { setPlaylists(items || []) })
      .catch(err => setError(err instanceof Error ? err.message : '歌单加载失败'))
      .finally(() => setLoading(false))
  }, [nav.platform, account?.loggedIn, account?.userId, account?.username])

  useEffect(() => { load() }, [load])
  // 从其他页面回来时刷新最近播放（页面栈 pop 回本页重新挂载即可，这里兜底监听播放态）
  useEffect(() => {
    const onVisible = () => setRecent(readRecent())
    window.addEventListener('waveforge-mobile-resume', onVisible)
    return () => window.removeEventListener('waveforge-mobile-resume', onVisible)
  }, [])

  const liked = playlists?.find(p => p.isLike)
  const created = playlists?.filter(p => !p.isLike) || []

  const openPlaylist = useCallback((item: UserPlaylistItem) => {
    nav.openPlaylist({
      id: String(item.id),
      name: item.name,
      coverUrl: item.coverImgUrl || item.coverUrl || '',
      platform: nav.platform,
      trackCount: item.trackCount,
    })
  }, [nav])

  return (
    <div className="wf-m-page">
      <header className="wf-m-header">
        <div className="wf-m-header-title">我的音乐</div>
        <div className="wf-m-header-sub">{platformLabel(nav.platform)} · {account?.username || (account?.loggedIn ? '已登录' : '未登录')}</div>
      </header>

      {nav.platform !== 'netease' && nav.platform !== 'qq' && (
        <EmptyState text={`${platformLabel(nav.platform)}的云端歌单暂未适配移动端，可在「发现」页浏览内容`} />
      )}
      {nav.platform === 'netease' || nav.platform === 'qq' ? (
        !account?.loggedIn ? (
          <EmptyState text={`登录${platformLabel(nav.platform)}后同步你的歌单`} action={
            <button type="button" className="wf-m-btn wf-m-btn-primary" onClick={() => nav.switchTab('settings')}>
              去登录
            </button>
          } />
        ) : loading ? (
          <Spinner label="加载歌单…" />
        ) : error ? (
          <ErrorRetry text={error} onRetry={load} />
        ) : (
          <>
            {liked && (
              <section className="wf-m-section">
                <button type="button" className="wf-m-like-card" onClick={() => openPlaylist(liked)}>
                  <Cover url={liked.coverImgUrl || liked.coverUrl} size={200} rounded={14} />
                  <span className="wf-m-like-meta">
                    <span className="wf-m-like-title"><IconHeartFilled size={16} /> 我喜欢的音乐</span>
                    <span className="wf-m-like-sub">{liked.trackCount || 0}首</span>
                  </span>
                </button>
              </section>
            )}
            <section className="wf-m-section">
              <h3 className="wf-m-section-title">创建/收藏的歌单（{created.length}）</h3>
              {!created.length && <p className="wf-m-hint">还没有歌单</p>}
              <ul className="wf-m-pl-list">
                {created.map(pl => (
                  <li key={`${pl.id}`}>
                    <button type="button" className="wf-m-pl-row" onClick={() => openPlaylist(pl)}>
                      <Cover url={pl.coverImgUrl || pl.coverUrl} size={180} rounded={10} />
                      <span className="wf-m-pl-row-meta">
                        <span className="wf-m-pl-row-name">{pl.name}</span>
                        <span className="wf-m-pl-row-sub">{pl.trackCount || 0}首</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          </>
        )
      ) : null}

      <RecentSection recent={recent} />
    </div>
  )
})

const RecentSection = memo(function RecentSection({ recent }: { recent: Song[] }) {
  const player = useMobilePlayer()
  const nav = useMobileNav()
  const { visible, sentinelRef } = useLazyList(recent.length, 30)
  if (!recent.length) return null
  return (
    <section className="wf-m-section">
      <div className="wf-m-section-head">
        <h3 className="wf-m-section-title">最近播放</h3>
        <button type="button" className="wf-m-playall" onClick={() => player.playSongs(recent, 0, '最近播放')}>
          播放全部
        </button>
      </div>
      <ul className="wf-m-song-list">
        {recent.slice(0, visible).map((song, i) => (
          <li key={`${song.platform || ''}-${song.id ?? song.mid}-${i}`}>
            <button
              type="button"
              className={`wf-m-song-mini ${player.currentSong?.id === song.id && player.currentSong?.platform === song.platform ? 'is-active' : ''}`}
              onClick={() => player.playSongs(recent, i, '最近播放')}
              onContextMenu={e => { e.preventDefault(); nav.openSongActions({ song, list: recent, listLabel: '最近播放' }) }}
            >
              <Cover song={song} size={72} rounded={6} />
              <span className="wf-m-song-meta">
                <span className="wf-m-song-name">{song.name}</span>
                <span className="wf-m-song-sub">{songArtists(song)}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
      <div ref={sentinelRef} />
    </section>
  )
})
