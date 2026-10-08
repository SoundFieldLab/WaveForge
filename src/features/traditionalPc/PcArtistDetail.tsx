// 官方 PC 客户端风格歌手详情（两个平台共用外壳，skin 决定角标与细节）。
//
// 与旧版 TraditionalArtistDetail 的差别：这里完全按客户端排版（大头像头部 + 下划线页签 +
// 表格/卡片墙），数据沿用同一批 musicApi 包装（getArtistDetail / getArtistTopSongs /
// getArtistAlbums / getArtistMVs），不另造接口。MV 页签没有数据时整个隐藏，
// 专辑/MV 某一路失败也只降级对应页签，不挡热门歌曲。
// 隐藏保活页（active=false）不取数；musicApi 包装不支持 abort，用请求序号丢弃晚到的旧响应。
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Album, Artist, Song } from '../../services/musicApi'
import { getArtistAlbums, getArtistDetail, getArtistMVs, getArtistTopSongs } from '../../services/musicApi'
import type { MusicPlatform } from '../../services/platforms'
import {
  pcCount, PcCardGrid, PcDetailHeader, PcEmpty, PcGhostButton, PcPrimaryButton, PcSongTable, PcTabs,
  pcTheme, type PcSkin, type PcTone,
} from './pcKit'
import type { PcActions } from './types'

export interface PcArtistDetailProps {
  /** 歌手 id（QQ 实际按歌手 mid 查询，由上层归一化后传入） */
  id: string
  /** 数据来源平台：酷狗走 kugouService 的 mobilecdn 歌手通道（musicApi 内部已分流） */
  platform: MusicPlatform
  chrome: { tone: PcTone; skin: PcSkin; accent: string }
  actions: PcActions
  /** 隐藏保活页为 false：跳过取数 */
  active: boolean
}

/** 本页用到的 MV 字段（getArtistMVs 返回 any[]，进页面先收敛成稳定形状） */
interface PcArtistMv {
  id: string
  name: string
  picUrl: string
  playCount?: number
  publishTime?: number | string
}

/** QQ 的 pubdate/publishTime 可能是日期字符串、网易云是毫秒时间戳，统一取年份（失败退空）。 */
function mvYearOf(value?: number | string | null): string {
  if (!value) return ''
  const date = new Date(typeof value === 'number' ? value : String(value).replace(/-/g, '/'))
  if (Number.isNaN(date.getTime())) return ''
  return String(date.getFullYear())
}

function PcArtistDetail({ id, platform, chrome, actions, active }: PcArtistDetailProps) {
  const theme = pcTheme(chrome.tone)
  const skin = chrome.skin
  const accent = chrome.accent
  const [artist, setArtist] = useState<Artist | null>(null)
  const [songs, setSongs] = useState<Song[]>([])
  const [albums, setAlbums] = useState<Album[]>([])
  const [mvs, setMvs] = useState<PcArtistMv[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [tab, setTab] = useState('hot')
  const [revision, setRevision] = useState(0)
  const requestRef = useRef(0)

  useEffect(() => { setTab('hot') }, [id, platform])

  // 详情 + 热门歌曲 + 专辑 + MV 一次并发拉齐（服务层有 TTL 缓存，回前台重取不会重复打网）
  useEffect(() => {
    if (!active || !id) return
    const request = ++requestRef.current
    setLoading(true)
    setError('')
    void Promise.allSettled([
      getArtistDetail(id, platform),
      getArtistTopSongs(id, platform),
      getArtistAlbums(id, platform, 100, 0),
      getArtistMVs(id, platform, 100, 0),
    ]).then(([detailResult, hotResult, albumsResult, mvsResult]) => {
      if (request !== requestRef.current) return
      const detail = detailResult.status === 'fulfilled' ? detailResult.value : null
      const hotSongs = hotResult.status === 'fulfilled' && Array.isArray(hotResult.value) ? hotResult.value : []
      const albumList = albumsResult.status === 'fulfilled' && Array.isArray(albumsResult.value) ? albumsResult.value : []
      const mvList = mvsResult.status === 'fulfilled' && Array.isArray(mvsResult.value) ? mvsResult.value : []
      setArtist(detail)
      setSongs(hotSongs)
      setAlbums(albumList)
      setMvs(mvList
        .filter(mv => mv && mv.id != null && String(mv.id))
        .map(mv => ({
          id: String(mv.id),
          name: String(mv.name || 'MV'),
          picUrl: String(mv.picUrl || mv.imgurl || ''),
          playCount: Number(mv.playCount || 0) || undefined,
          publishTime: mv.publishTime as number | string | undefined,
        })))
      // 详情与热门歌曲双空才是真失败（仅专辑/MV 失败降级隐藏对应页签）
      if (!detail && hotSongs.length === 0) setError('歌手详情加载失败，请重试')
    }).finally(() => {
      if (request === requestRef.current) setLoading(false)
    })
  }, [id, platform, active, revision])

  const playAll = useCallback(() => {
    if (!songs.length) return
    actions.onPlaySongs(songs[0], songs, 0)
  }, [songs, actions])

  const meta = [
    artist?.fans ? `粉丝 ${pcCount(artist.fans) || artist.fans}` : '',
    artist?.musicSize ? `${artist.musicSize} 首歌曲` : '',
    artist?.albumSize ? `${artist.albumSize} 张专辑` : '',
  ].filter(Boolean).join(' · ')

  const tabItems = useMemo(() => {
    const items = [{ key: 'hot', label: '热门歌曲', count: songs.length }]
    if (albums.length) items.push({ key: 'albums', label: '专辑', count: albums.length })
    if (mvs.length) items.push({ key: 'mvs', label: 'MV', count: mvs.length })
    return items
  }, [songs.length, albums.length, mvs.length])

  if (error) {
    return (
      <div className="pb-8">
        <PcEmpty
          theme={theme}
          title="歌手详情加载失败"
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
        coverUrl={artist?.picUrl}
        title={artist?.name || '歌手'}
        meta={meta}
        description={artist?.briefDesc || artist?.description}
        actions={(
          <PcPrimaryButton label="播放热门" accent={accent} onClick={playAll} disabled={!songs.length} />
        )}
      />

      {/* 页签：热门歌曲 / 专辑 / MV（无 MV 数据时隐藏，与官方一致不留空页签） */}
      <div className={`mb-3 flex items-end justify-between gap-4 border-b ${theme.divider}`}>
        <PcTabs items={tabItems} value={tab} onChange={setTab} accent={accent} theme={theme} />
      </div>

      {tab === 'hot' && (
        <PcSongTable
          songs={songs}
          skin={skin}
          theme={theme}
          accent={accent}
          loading={loading && !songs.length}
          columns={{ index: true, like: true, album: true, duration: true }}
          playingKey={actions.currentSongKey}
          isPlaying={actions.isPlaying}
          onPlay={(song, index) => actions.onPlaySongs(song, songs, index)}
          onMenu={(event, song) => { event.preventDefault(); actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs }) }}
          likedKeys={actions.likedKeys}
          isLiked={actions.isLiked}
          onToggleLike={actions.onToggleLike}
          empty={<PcEmpty theme={theme} title="暂无热门歌曲" />}
          rowActions={(song) => (
            <button type="button" className={`text-[11px] ${theme.faint} hover:opacity-80`} onClick={event => { event.stopPropagation(); actions.onOpenComments?.(song) }}>评论</button>
          )}
        />
      )}

      {tab === 'albums' && (
        <PcCardGrid
          items={albums.map(album => ({
            key: `${album.id || album.mid}:${album.name}`,
            coverUrl: album.picUrl,
            title: album.name,
            subtitle: [
              album.publishTime ? mvYearOf(album.publishTime) : '',
              album.size ? `${album.size} 首` : '',
            ].filter(Boolean).join(' · ') || album.artist?.name || '',
            playCount: null,
            onClick: () => actions.onOpenAlbum?.(String(album.mid || album.id), platform),
          }))}
          theme={theme}
          accent={accent}
          columns={6}
        />
      )}

      {tab === 'mvs' && (
        <PcCardGrid
          items={mvs.map(mv => ({
            key: `${mv.id}:${mv.name}`,
            coverUrl: mv.picUrl,
            title: mv.name,
            subtitle: mvYearOf(mv.publishTime),
            playCount: mv.playCount,
            // MV 弹窗链路只认 QQ/网易云（酷狗 MV 能力为 false，上游也没有歌手 MV 接口，这里不会有点击）
            onClick: () => { if (platform === 'qq' || platform === 'netease') actions.onOpenMv?.(mv.id, platform) },
          }))}
          theme={theme}
          accent={accent}
          columns={6}
        />
      )}
    </div>
  )
}

export default memo(PcArtistDetail)
