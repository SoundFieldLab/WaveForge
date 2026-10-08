// 官方 PC 客户端风格专辑详情（两个平台共用外壳，skin 决定封面圆角与细节）。
//
// 与旧版 TraditionalAlbumDetail 的差别：这里完全按客户端排版（大封面头部 + 曲目表），
// 数据沿用同一批 musicApi 包装（getAlbumDetail / getAlbumSongs），不另造接口。
// 隐藏保活页（active=false）不取数；musicApi 包装不支持 abort，用请求序号丢弃晚到的旧响应。
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { Album, Song } from '../../services/musicApi'
import { getAlbumDetail, getAlbumSongs } from '../../services/musicApi'
import type { MusicPlatform } from '../../services/platforms'
import {
  PcDetailHeader, PcEmpty, PcGhostButton, PcPrimaryButton, PcSongTable,
  pcTheme, type PcSkin, type PcTone,
} from './pcKit'
import type { PcActions } from './types'

export interface PcAlbumDetailProps {
  /** 专辑 id（QQ 实际按专辑 mid 查询，由上层归一化后传入） */
  id: string
  /** 数据来源平台：酷狗走 kugouService 的 mobilecdn 专辑通道（musicApi 内部已分流） */
  platform: MusicPlatform
  chrome: { tone: PcTone; skin: PcSkin; accent: string }
  actions: PcActions
  /** 隐藏保活页为 false：跳过取数 */
  active: boolean
}

/** QQ 的 pub_time 是日期字符串、网易云是毫秒时间戳，统一转 YYYY-MM-DD（失败退空）。 */
function formatAlbumDate(value?: number | string | null): string {
  if (!value) return ''
  const date = new Date(typeof value === 'number' ? value : String(value).replace(/-/g, '/'))
  if (Number.isNaN(date.getTime())) return ''
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function PcAlbumDetail({ id, platform, chrome, actions, active }: PcAlbumDetailProps) {
  const theme = pcTheme(chrome.tone)
  const skin = chrome.skin
  const accent = chrome.accent
  const [album, setAlbum] = useState<Album | null>(null)
  const [songs, setSongs] = useState<Song[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const requestRef = useRef(0)

  // 详情 + 曲目一次并发拉齐（服务层有 TTL 缓存，回前台重取不会重复打网）
  useEffect(() => {
    if (!active || !id) return
    const request = ++requestRef.current
    setLoading(true)
    setError('')
    void Promise.allSettled([
      getAlbumDetail(id, platform),
      getAlbumSongs(id, platform),
    ]).then(([detailResult, songsResult]) => {
      if (request !== requestRef.current) return
      const detail = detailResult.status === 'fulfilled' ? detailResult.value : null
      const songList = songsResult.status === 'fulfilled' && Array.isArray(songsResult.value) ? songsResult.value : []
      setAlbum(detail)
      setSongs(songList)
      // 详情与曲目双空才是真失败
      if (!detail && songList.length === 0) setError('专辑详情加载失败，请重试')
    }).finally(() => {
      if (request === requestRef.current) setLoading(false)
    })
  }, [id, platform, active, revision])

  const playAll = useCallback(() => {
    if (!songs.length) return
    actions.onPlaySongs(songs[0], songs, 0)
  }, [songs, actions])

  const openArtist = useCallback(() => {
    // 歌手跳转 id：QQ 用 mid、网易云用数字 id（与列表页卡片同一口径）
    const artistId = album?.artist?.mid || album?.artist?.id || songs[0]?.artists?.[0]?.mid || songs[0]?.artists?.[0]?.id
    if (artistId) actions.onOpenArtist?.(String(artistId), platform)
  }, [album, songs, actions, platform])

  const artistName = album?.artist?.name
    || (songs[0]?.artists || []).map(artist => artist.name).filter(Boolean).join(' / ')
  const releaseDate = formatAlbumDate(album?.publishTime)
  const trackCount = songs.length || album?.size || 0

  if (error) {
    return (
      <div className="pb-8">
        <PcEmpty
          theme={theme}
          title="专辑详情加载失败"
          description="网络似乎不太顺畅，稍后再试试"
          action={<PcGhostButton label="重试" theme={theme} onClick={() => setRevision(value => value + 1)} />}
        />
      </div>
    )
  }

  return (
    <div className="pb-8">
      <PcDetailHeader
        theme={theme}
        skin={skin}
        coverUrl={album?.picUrl || songs[0]?.album?.picUrl}
        title={album?.name || '专辑'}
        description={album?.description}
        meta={(
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {artistName ? (
              <button type="button" onClick={openArtist} className="hover:underline" title="查看歌手">{artistName}</button>
            ) : null}
            {releaseDate ? <span>发行于 {releaseDate}</span> : null}
            {trackCount ? <span>{trackCount} 首</span> : null}
            {album?.company ? <span>{album.company}</span> : null}
          </span>
        )}
        actions={(
          <PcPrimaryButton label="播放全部" accent={accent} onClick={playAll} disabled={!songs.length} />
        )}
      />

      {/* 曲目表：专辑页没有专辑列（本身就是专辑） */}
      <PcSongTable
        songs={songs}
        skin={skin}
        theme={theme}
        accent={accent}
        loading={loading && !songs.length}
        columns={{ index: true, like: true, album: false, duration: true }}
        playingKey={actions.currentSongKey}
        isPlaying={actions.isPlaying}
        onPlay={(song, index) => actions.onPlaySongs(song, songs, index)}
        onMenu={(event, song) => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs }) }}
        likedKeys={actions.likedKeys}
        isLiked={actions.isLiked}
        onToggleLike={actions.onToggleLike}
        empty={<PcEmpty theme={theme} title="这个专辑还没有可播放的歌曲" />}
        rowActions={(song) => (
          <button type="button" className={`text-[11px] ${theme.faint} hover:opacity-80`} onClick={event => { event.stopPropagation(); actions.onOpenComments?.(song) }}>评论</button>
        )}
      />
    </div>
  )
}

export default memo(PcAlbumDetail)
