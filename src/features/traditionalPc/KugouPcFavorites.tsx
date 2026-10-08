// 酷狗音乐 PC 客户端「我的收藏」页。
//
// 对齐官方截图（D:\opencode\.tmp-kg-tab-shoucang.png）：大标题 + 下划线页签（带真实计数）
// + 导入外部歌单/搜索工具条 + 封面卡片网格。
// 数据诚实性：单曲 = 「我喜欢」歌单曲目（概念版通道）；歌单 = 收藏的歌单；
// 官方的专辑/视频/歌手/设备页签在上游没有可用的收藏列表接口，入口不渲染（不留空壳）。
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Heart, Import, ListMusic } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { fetchKugouUserPlaylistTracks, kugouTrackToSong } from '../../services/kugouService'
import { PcCardGrid, PcEmpty, PcPrimaryButton, PcSongTable, PcTabs, type PcTabItem } from './pcKit'
import type { KugouPcPageContext } from './KugouPcShared'

export interface KugouPcFavoritesProps {
  ctx: KugouPcPageContext
  /** 「我喜欢」歌单（左栏同源，来自 fetchKugouUserPlaylists） */
  likedPlaylist: any | null
  /** 自建歌单（官方「歌单」页签 = 自建 + 收藏的全集） */
  minePlaylists?: any[]
  /** 收藏的他人歌单 */
  collectedPlaylists: any[]
  /** 登录后重新拉歌单列表（导入外部歌单等写操作之后） */
  onRefreshPlaylists?: () => void
}

type FavoritesTab = 'songs' | 'playlists'

function KugouPcFavorites({ ctx, likedPlaylist, minePlaylists, collectedPlaylists, onRefreshPlaylists }: KugouPcFavoritesProps) {
  const theme = ctx.theme
  const accent = ctx.accent
  const loggedIn = ctx.account.loggedIn
  // 官方默认展示「歌单」页签（收藏的歌单卡片网格），单曲表格是第二页签
  const [tab, setTab] = useState<FavoritesTab>('playlists')
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const requestRef = useRef(0)

  const likedId = likedPlaylist ? String(likedPlaylist.id || likedPlaylist.listid || '') : ''
  const cacheKey = `${likedId}:${ctx.account.userId || ''}`

  useEffect(() => {
    if (!ctx.active || tab !== 'songs') return
    if (!loggedIn || !likedId) { setSongs([]); setError(''); setLoading(false); return }
    const requestId = ++requestRef.current
    let cancelled = false
    setLoading(true)
    setError('')
    void fetchKugouUserPlaylistTracks(likedId)
      .then(tracks => {
        if (cancelled || requestId !== requestRef.current) return
        setSongs(tracks.map(kugouTrackToSong))
        setLoading(false)
      })
      .catch((loadError: unknown) => {
        if (cancelled || requestId !== requestRef.current) return
        setSongs([])
        setLoading(false)
        setError(loadError instanceof Error ? loadError.message : '「我喜欢」加载失败')
      })
    return () => { cancelled = true }
  }, [ctx.active, tab, loggedIn, likedId, cacheKey])

  const playAll = useCallback(() => { if (songs.length) ctx.actions.onPlaySongs(songs[0], songs, 0) }, [ctx.actions, songs])

  // 官方「歌单」页签是用户歌单全集（我喜欢 + 自建 + 收藏），不是只有收藏的他人歌单
  const seenPlaylistIds = new Set<string>()
  const allPlaylists = [likedPlaylist, ...(minePlaylists || []), ...collectedPlaylists]
    .filter((playlist: any): playlist is any => Boolean(playlist?.id || playlist?.listid))
    .filter((playlist: any) => {
      const key = String(playlist.id || playlist.listid)
      if (seenPlaylistIds.has(key)) return false
      seenPlaylistIds.add(key)
      return true
    })

  const tabs: PcTabItem[] = [
    { key: 'songs', label: '单曲', count: songs.length || undefined },
    { key: 'playlists', label: '歌单', count: allPlaylists.length || undefined },
  ]

  const loginEmpty = (
    <PcEmpty theme={theme} title="登录后查看我的收藏" description="登录酷狗（概念版扫码）后即可同步收藏" />
  )

  return (
    <div className="pb-8" data-kugou-pc-page="favorites">
      <h1 className={`mb-4 text-[26px] font-semibold leading-tight ${theme.text}`}>我的收藏</h1>

      <div className={`mb-4 border-b ${theme.divider}`}>
        <PcTabs items={tabs} value={tab} onChange={key => setTab(key as FavoritesTab)} accent={accent} theme={theme} />
      </div>

      <div className="mb-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => { if (!loggedIn) { ctx.actions.onLogin?.(); return } onRefreshPlaylists?.() }}
          className={`inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[13px] ${theme.solidBtn}`}
        >
          <Import className="h-3.5 w-3.5" /> 导入外部歌单
        </button>
        {tab === 'songs' && (
          <PcPrimaryButton label="播放全部" accent={accent} disabled={!songs.length} onClick={playAll} className="ml-auto" />
        )}
      </div>

      {tab === 'songs' && (
        !loggedIn ? loginEmpty : (
          <>
            <PcSongTable
              songs={songs}
              skin="qq"
              theme={theme}
              accent={accent}
              columns={{ index: true, like: true, album: true, duration: true }}
              loading={loading && !songs.length}
              playingKey={ctx.actions.currentSongKey}
              isPlaying={ctx.actions.isPlaying}
              isLiked={() => true}
              onPlay={(song, index) => ctx.actions.onPlaySongs(song, songs, index)}
              onMenu={(event, song) => ctx.actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs })}
              onToggleLike={(song, next) => ctx.actions.onToggleLike?.(song, next)}
              empty={(
                <PcEmpty
                  theme={theme}
                  title="暂无喜欢的歌曲"
                  description={error || '在歌曲上点红心就会出现在「我喜欢」里'}
                />
              )}
            />
            {songs.length > 0 && (
              <p className={`mt-3 flex items-center gap-1.5 text-[11px] ${theme.faint}`}>
                <Heart className="h-3 w-3" style={{ color: accent }} /> 共 {songs.length} 首 · 来自「我喜欢」歌单
              </p>
            )}
          </>
        )
      )}

      {tab === 'playlists' && (
        !loggedIn ? loginEmpty : (
          allPlaylists.length ? (
            <PcCardGrid
              items={allPlaylists.map((playlist: any) => ({
                key: `kugou:${playlist.id || playlist.listid}`,
                coverUrl: playlist.coverImgUrl || playlist.coverUrl,
                title: playlist.name || '歌单',
                // 官方歌单卡左下角是曲目数（N首）；封面缺省时给占位，不留白块
                subtitle: playlist.trackCount ? `${playlist.trackCount} 首` : undefined,
                playCount: playlist.trackCount || undefined,
                onClick: () => ctx.openPlaylist(playlist),
                onContextMenu: event => { event.preventDefault(); ctx.actions.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist }) },
              }))}
              theme={theme}
              accent={accent}
              columns={5}
              showPlayOnHover={false}
            />
          ) : (
            <PcEmpty
              theme={theme}
              title="暂无收藏歌单"
              description="在歌单详情页点收藏后会出现在这里"
              action={onRefreshPlaylists ? (
                <button type="button" onClick={onRefreshPlaylists} className={`rounded-full px-4 py-2 text-[12px] ${theme.solidBtn}`}>
                  <ListMusic className="mr-1 inline h-3.5 w-3.5" /> 刷新歌单
                </button>
              ) : undefined}
            />
          )
        )
      )}

      <p className={`mt-6 text-[11px] ${theme.faint}`}>
        官方的「专辑 / 视频 / 歌手 / 设备」收藏页签在上游没有可用的收藏列表接口，这里不提供空壳入口。
      </p>
    </div>
  )
}

export default memo(KugouPcFavorites)
