// 酷狗音乐 PC 客户端「音乐 → 乐库」页。
//
// 对齐官方截图（D:\opencode\.tmp-kg-tab-yueku.png）：新歌速递（白色卡片、每行一首、
// 右上角播放按钮）→ 新碟速递 → 歌手目录。
// 官方新歌速递分华语/欧美/韩国三列；语种维度来自公开榜单接口（新歌榜 74534 / 欧美榜 31310 /
// 韩国榜 31311，实测首曲与官方乐库一致），拿不到时回退到 newsong_publish 单列。
import { memo, useEffect, useMemo, useState } from 'react'
import { Disc3, Mic2, Music2, Play } from 'lucide-react'
import type { ExplorePayload } from '../../services/exploreApi'
import { PcCover } from './pcKit'
import { kugouTrackToSong } from '../../services/kugouService'
import { kugouCount, kugouDuration, type KugouPcPageContext } from './KugouPcShared'

export interface KugouPcLibraryProps {
  ctx: KugouPcPageContext
  payload: ExplorePayload | null
}

function KugouPcLibrary({ ctx, payload }: KugouPcLibraryProps) {
  const theme = ctx.theme
  const accent = ctx.accent
  const kugou = payload?.kugou
  const newSongs = useMemo(() => (kugou?.newSongs || []).map(item => item), [kugou?.newSongs])
  const newAlbums = useMemo(() => {
    const merged = [...(kugou?.yueku?.newAlbums || []), ...(payload?.albums || []).filter(album => album.platform === 'kugou')]
    const seen = new Set<string>()
    return merged.filter(album => {
      const key = String(album.mid || album.id)
      if (!key || seen.has(key)) return false
      seen.add(key)
      return true
    })
  }, [kugou?.yueku?.newAlbums, payload?.albums])
  const singers = (kugou?.singers || []).slice(0, 24)
  const songList = newSongs.map(item => item.song)
  // 三语种新歌：独立拉取（公开榜单接口），失败/为空则回退单列
  const [langColumns, setLangColumns] = useState<Array<{ key: string; label: string; subtitle: string; tracks: import('../../services/kugouService').KugouTrack[] }>>([])
  useEffect(() => {
    let cancelled = false
    void import('../../services/kugouService')
      .then(m => m.fetchKugouNewSongsByLanguage(6))
      .then(columns => { if (!cancelled) setLangColumns(columns) })
      .catch(() => undefined)
    return () => { cancelled = true }
  }, [])

  const playNewSongs = (index: number) => {
    const song = songList[index]
    if (song) ctx.actions.onPlaySongs(song, songList, index)
  }

  return (
    <div className="pb-8" data-kugou-pc-page="library">
      {/* 新歌速递：官方是整块白卡 + 分组标题 + 行式列表 */}
      <section className={`rounded-xl p-4 ${theme.surface}`}>
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className={`text-[17px] font-semibold ${theme.text}`}>新歌速递</h2>
            <p className={`mt-0.5 text-[11px] ${theme.faint}`}>
              {langColumns.length ? '酷狗官方新歌首发 · 华语 / 欧美 / 韩国' : '酷狗官方新歌首发 · 上游未提供语种分组，按发布时间排列'}
            </p>
          </div>
          <button
            type="button"
            disabled={!songList.length}
            onClick={() => playNewSongs(0)}
            className="flex h-8 w-8 items-center justify-center rounded-full text-white transition disabled:opacity-40"
            style={{ background: accent }}
            aria-label="播放新歌"
            title="播放新歌"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
          </button>
        </div>

        {langColumns.length > 0 ? (
          // 官方形态：三张语种卡并排，每列 6 首，卡头右侧圆形播放按钮
          <div className="grid gap-4 lg:grid-cols-3">
            {langColumns.map(column => {
              const columnSongs = column.tracks.map(kugouTrackToSong)
              return (
                <div key={column.key} className={`rounded-lg p-3 ${theme.tone === 'dark' ? 'bg-white/[0.03]' : 'bg-black/[0.02]'}`}>
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <div>
                      <p className={`text-[15px] font-semibold ${theme.text}`}>{column.label}</p>
                      <p className={`text-[11px] ${theme.faint}`}>{column.subtitle}</p>
                    </div>
                    <button
                      type="button"
                      disabled={!columnSongs.length}
                      onClick={() => { const first = columnSongs[0]; if (first) ctx.actions.onPlaySongs(first, columnSongs, 0) }}
                      className="flex h-8 w-8 items-center justify-center rounded-full text-white transition disabled:opacity-40"
                      style={{ background: accent }}
                      aria-label={`播放${column.label}新歌`}
                      title={`播放${column.label}新歌`}
                    >
                      <Play className="h-3.5 w-3.5 fill-current" />
                    </button>
                  </div>
                  <div className="space-y-1">
                    {columnSongs.slice(0, 6).map((song, index) => (
                      <div
                        key={`${column.key}-${song.mid || song.id}-${index}`}
                        onDoubleClick={() => ctx.actions.onPlaySongs(song, columnSongs, index)}
                        onContextMenu={event => { event.preventDefault(); ctx.actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs: columnSongs }) }}
                        className={`group flex min-w-0 items-center gap-2.5 rounded-lg px-1.5 py-1.5 transition ${theme.hover}`}
                      >
                        <PcCover src={song.album?.picUrl} alt={song.name} className="h-10 w-10 shrink-0" rounded="rounded-md" />
                        <div className="min-w-0 flex-1">
                          <p className={`truncate text-[13px] ${theme.text}`}>{song.name}</p>
                          <p className={`mt-0.5 truncate text-[11px] ${theme.subtle}`}>{song.artists?.map(artist => artist.name).join(' / ')}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        ) : newSongs.length === 0 ? (
          <div className={`flex flex-col items-center justify-center rounded-lg py-12 ${theme.tone === 'dark' ? 'bg-white/[0.03]' : 'bg-black/[0.02]'}`}>
            <Music2 className={`h-6 w-6 ${theme.faint}`} />
            <p className={`mt-2 text-[13px] ${theme.subtle}`}>新歌速递暂时没有返回内容</p>
            <p className={`mt-1 text-[11px] ${theme.faint}`}>{kugou?.newSongsError || '稍后重试，或检查本地服务是否可用'}</p>
          </div>
        ) : (
          <div className="grid gap-x-4 gap-y-1 md:grid-cols-2 xl:grid-cols-3">
            {newSongs.slice(0, 18).map((item, index) => (
              <div
                key={`${item.song.mid || item.song.id}:${index}`}
                onDoubleClick={() => playNewSongs(index)}
                className={`group flex min-w-0 items-center gap-2.5 rounded-lg px-2 py-1.5 transition ${theme.hover}`}
              >
                <PcCover src={item.song.album?.picUrl} alt={item.song.name} className="h-11 w-11 shrink-0" rounded="rounded-md" />
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-[13px] ${theme.text}`}>{item.song.name}</p>
                  <p className={`mt-0.5 truncate text-[11px] ${theme.subtle}`}>{item.song.artists?.map(artist => artist.name).join(' / ')}</p>
                </div>
                <span className={`hidden shrink-0 text-[11px] tabular-nums sm:block ${theme.faint}`}>{kugouDuration((item.song.duration || 0) / 1000)}</span>
                <button
                  type="button"
                  onClick={() => playNewSongs(index)}
                  onContextMenu={event => { event.preventDefault(); ctx.actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song: item.song, songs: songList }) }}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full opacity-0 transition group-hover:opacity-100"
                  style={{ color: accent }}
                  aria-label={`播放 ${item.song.name}`}
                  title={`播放 ${item.song.name}`}
                >
                  <Play className="h-3.5 w-3.5 fill-current" />
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* 新碟速递 */}
      <section className="mt-7">
        <div className="mb-3 flex items-center gap-2">
          <Disc3 className="h-4 w-4" style={{ color: accent }} />
          <h2 className={`text-[17px] font-semibold ${theme.text}`}>新碟速递</h2>
          <span className={`text-[11px] ${theme.faint}`}>最新专辑</span>
        </div>
        {newAlbums.length === 0 ? (
          <div className={`flex items-center justify-center rounded-xl py-12 text-[13px] ${theme.faint} ${theme.surface}`}>暂时没有新碟数据</div>
        ) : (
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {newAlbums.slice(0, 12).map((album, index) => (
              <button
                key={`${album.mid || album.id}:${index}`}
                type="button"
                onClick={() => { const id = String(album.mid || album.id || ''); if (id) ctx.openAlbum?.(id) }}
                className="group min-w-0 text-left"
              >
                <PcCover src={album.coverUrl} alt={album.name} className="aspect-square w-full" rounded="rounded-[8px]" />
                <span className={`mt-2 line-clamp-1 block text-[13px] ${theme.text}`}>{album.name}</span>
                <span className={`mt-0.5 line-clamp-1 block text-[11px] ${theme.faint}`}>{album.artist}{album.publishTime ? ` · ${album.publishTime}` : ''}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* 歌手目录 */}
      <section className="mt-7">
        <div className="mb-3 flex items-center gap-2">
          <Mic2 className="h-4 w-4" style={{ color: accent }} />
          <h2 className={`text-[17px] font-semibold ${theme.text}`}>歌手</h2>
          <span className={`text-[11px] ${theme.faint}`}>热门歌手目录</span>
        </div>
        {singers.length === 0 ? (
          <div className={`flex items-center justify-center rounded-xl py-12 text-[13px] ${theme.faint} ${theme.surface}`}>
            {kugou?.singersError || '歌手目录暂时没有返回内容'}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-4 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
            {singers.map(singer => (
              <button key={singer.singerid} type="button" onClick={() => ctx.openArtist?.(singer.singerid)} className="group min-w-0 text-center">
                <PcCover src={singer.coverUrl} alt={singer.singername} className="aspect-square w-full" rounded="rounded-full" />
                <span className={`mt-2 block truncate text-[13px] ${theme.text}`}>{singer.singername}</span>
                {kugouCount(singer.fansCount) ? <span className={`mt-0.5 block truncate text-[11px] ${theme.faint}`}>{kugouCount(singer.fansCount)} 粉丝</span> : null}
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default memo(KugouPcLibrary)
