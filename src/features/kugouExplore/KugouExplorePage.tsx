/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * 探索页-酷狗一级分区外壳：**发现 / 音乐 / 听书**（归属酷狗，不是通用板块瀑布）。
 * 「发现」= 酷狗概念版「发现」tab 的真机复刻（红心Radio + pxy 卡片流 + 曲风盲盒 + 频道推荐，
 *  见 KugouDiscoverBoard）；「音乐」分区收纳官方五板块（推荐/乐库/歌单/频道/分类）；
 * 「刷歌」分区已按产品决策下线（上游 /youth 动态流对本账号恒空，入口无内容）。
 * 做法规格对齐 QQ 探索页的「推荐 / 乐馆」与网易云探索页的「推荐 / 发现」：
 * 顶部一行分区页签，非激活分区保持挂载（display:none）——切回来不重新请求、
 * 不丢子板块内部状态（标签筛选、卡片墙数据）。
 *
 * 分区切换用酷狗品牌色 #FF7A00：激活项是品牌色实心胶囊，未激活为半透明底。
 * 分区显隐不新造偏好位，直接从板块显隐推导：
 *   发现 = kugouDiscover（独立板块位）；
 *   音乐 = 五个子板块（推荐/乐库/歌单/频道/分类）任一可见；
 *   听书 = kugouLongaudio。
 * 因此设置面板里隐藏某个板块后，其所属分区在没有可见子板块时自动消失。
 *
 * 平台隔离：只在 ExploreView 的 platform === 'kugou' 分支挂载。
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { BookAudio, Compass, Music2, Radio } from 'lucide-react'
import type { ExplorePayload } from '../../services/exploreApi'
import type { ExploreSectionId } from '../../components/ExploreSettingsPanel'
import KugouExploreSections, { KugouRecommendBoard, type KugouExploreHandlers } from './KugouExploreSections'
import KugouDiscoverBoard from './KugouDiscoverBoard'
import KugouLongaudioBoard from '../kugouLongaudio/KugouLongaudioBoard'
import KugouLongaudioOverlay from '../kugouLongaudio/KugouLongaudioOverlay'
import KugouYouthFeedBoard from '../kugouYouth/KugouYouthFeedBoard'
import KugouYouthFeedOverlay from '../kugouYouth/KugouYouthFeedOverlay'
import { kugouYouthStore } from '../kugouYouth/store'
import { kugouDiscoverSongToTrack, kugouTrackToSong } from '../../services/kugouService'

export type KugouExploreZoneId = 'discover' | 'music' | 'longaudio' | 'youth'

/** 「音乐」分区收纳的五个子板块（对应官方客户端页签：推荐 / 乐库 / 歌单 / 频道 / 分类） */
const KUGOU_MUSIC_SECTIONS: readonly ExploreSectionId[] = [
  'discover',
  'kugouLibrary',
  'kugouPlaylistTags',
  'channels',
  'kugouCategories',
]

export interface KugouExplorePageProps extends KugouExploreHandlers {
  payload: ExplorePayload
  accent: string
  accentRgb: string
  compactCards: boolean
  showDescriptions: boolean
  expandedHome: boolean
  exploreCardBg: string
  showSubtitles: boolean
  loggedIn?: boolean
  onOpenChannelPanel?: (channel: { id: string; name: string }) => void
  /** 发现页歌曲行红心切换（酷狗概念版喜欢通道） */
  onToggleLike?: (song: import('../../services/kugouService').KugouDiscoverSong, next: boolean) => void
  sectionStyle: (section: ExploreSectionId) => CSSProperties
  sectionVisible: (section: ExploreSectionId) => boolean
}

export default function KugouExplorePage(props: KugouExplorePageProps) {
  const { accent, accentRgb, sectionVisible, loggedIn = false } = props
  const [requestedZone, setRequestedZone] = useState<KugouExploreZoneId>('discover')

  const zones: Array<{ id: KugouExploreZoneId; label: string; hint: string; icon: ReactNode }> = []
  zones.push({ id: 'discover', label: '发现', hint: '红心Radio · 私人推荐 · 曲风盲盒 · 频道（酷狗概念版同源）', icon: <Compass className="h-4 w-4" /> })
  if (KUGOU_MUSIC_SECTIONS.some(section => sectionVisible(section))) {
    zones.push({ id: 'music', label: '音乐', hint: '推荐 · 乐库 · 歌单 · 频道 · 分类', icon: <Music2 className="h-4 w-4" /> })
  }
  if (sectionVisible('kugouLongaudio')) {
    zones.push({ id: 'longaudio', label: '听书', hint: '有声小说 · 相声评书 · 助眠解压（独立听书播放器）', icon: <BookAudio className="h-4 w-4" /> })
  }
  // 「刷歌」分区（官方一级入口；账号无动态时板块内展示空态 + 最近动态）
  if (sectionVisible('kugouYouth')) {
    zones.push({ id: 'youth', label: '刷歌', hint: '竖滑切歌 · 猜你爱听（账号暂无动态时显示最近刷到）', icon: <Radio className="h-4 w-4" /> })
  }

  // 当前选中的分区在设置里被隐藏（或其全部子板块被隐藏）时回落到第一个可用分区。
  // 用计算值而不是 effect 校正：设置面板一改动就立即生效，不会渲染一帧空白。
  const availableZones = zones.map(zone => zone.id)
  const activeZone: KugouExploreZoneId = availableZones.includes(requestedZone)
    ? requestedZone
    : (availableZones[0] ?? 'discover')
  const activeMeta = zones.find(zone => zone.id === activeZone)
  // 没有任何可用分区（用户在设置里把酷狗板块全关了）时不渲染空面板
  const paneClass = (zone: KugouExploreZoneId) => (zones.length > 0 && activeZone === zone ? 'contents' : 'hidden')

  return (
    <div className="space-y-8" data-kugou-zone-root>
      {/* 一级分区页签：与 QQ/网易云同一个位置、同一套交互，只换品牌色与图标 */}
      {zones.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2" data-kugou-zone-nav>
          <div className="flex items-center gap-1 rounded-full border border-white/[0.09] bg-white/[0.035] p-1" role="tablist" aria-label="酷狗探索分区">
            {zones.map(zone => {
              const active = activeZone === zone.id
              return (
                <button
                  key={zone.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setRequestedZone(zone.id)}
                  className={`flex h-10 items-center gap-2 rounded-full px-5 text-sm transition ${active ? 'font-semibold' : 'text-white/55 hover:bg-white/[0.07] hover:text-white/85'}`}
                  style={active
                    ? { background: `linear-gradient(135deg, ${accent}, #FF9E3D)`, color: '#081017', boxShadow: `0 10px 30px rgba(${accentRgb}, 0.28)` }
                    : undefined}
                >
                  {zone.icon}
                  {zone.label}
                </button>
              )
            })}
          </div>
          {activeMeta && (
            <span className="flex items-center gap-2 text-xs text-white/38">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: accent }} />
              {activeMeta.hint}
            </span>
          )}
        </div>
      )}

      {/* 发现分区：酷狗概念版「发现」tab 的完整复刻（数据/交互/层级对齐真机） */}
      <div className={paneClass('discover')} aria-hidden={activeZone !== 'discover'} data-kugou-zone="discover">
        <KugouDiscoverBoard
          accent={props.accent}
          accentRgb={props.accentRgb}
          exploreCardBg={props.exploreCardBg}
          loggedIn={loggedIn}
          onPlayTracks={(tracks, startIndex) => {
            // KugouTrack[] → Song：kugouTrackToSong 与文件顶部同一服务模块的静态导入
            const songs = tracks.map(kugouTrackToSong).filter(song => song.mid || song.kugouMixSongId)
            const start = Math.max(0, startIndex || 0)
            if (songs[start]) props.onPlaySongs(songs[start], songs, true)
            else if (songs[0]) props.onPlaySongs(songs[0], songs, true)
          }}
          onOpenChannel={props.onOpenChannelPanel}
          onOpenSearch={props.onOpenSearch}
          onToggleLike={props.onToggleLike}
          onSongContextMenu={(event, song, songs) => {
            // KugouDiscoverSong → Song：与 onPlayTracks 同一套映射（singerId 供「查看歌手」跳转）
            const toSong = (s: typeof song) => kugouTrackToSong({
              hash: s.hash || '', songName: s.songName, singerName: s.singerName,
              singerId: s.singerId, albumId: s.albumId, albumAudioId: s.albumAudioId,
              mixSongId: s.mixSongId, coverUrl: s.coverUrl, duration: s.duration,
            })
            props.onSongContextMenu(event, toSong(song), songs.map(toSong))
          }}
        />
      </div>

      {/* 音乐分区：收纳官方五板块（板块顺序仍按用户在设置里的排序，用 flex order 生效） */}
      <div className={paneClass('music')} aria-hidden={activeZone !== 'music'} data-kugou-zone="music">
        <div className="flex flex-col gap-12">
          <KugouRecommendBoard
            payload={props.payload}
            accent={props.accent}
            accentRgb={props.accentRgb}
            compactCards={props.compactCards}
            showDescriptions={props.showDescriptions}
            expandedHome={props.expandedHome}
            exploreCardBg={props.exploreCardBg}
            showSubtitles={props.showSubtitles}
            sectionStyle={props.sectionStyle}
            sectionVisible={props.sectionVisible}
            onPlaySongs={props.onPlaySongs}
            onSongSelect={props.onSongSelect}
            onOpenPlaylist={props.onOpenPlaylist}
            onOpenAlbum={props.onOpenAlbum}
            onOpenArtist={props.onOpenArtist}
            onSongContextMenu={props.onSongContextMenu}
            onOpenMoreSection={props.onOpenMoreSection}
            onRetry={props.onRetry}
          />
          <KugouExploreSections
            payload={props.payload}
            accent={props.accent}
            accentRgb={props.accentRgb}
            compactCards={props.compactCards}
            showDescriptions={props.showDescriptions}
            expandedHome={props.expandedHome}
            exploreCardBg={props.exploreCardBg}
            showSubtitles={props.showSubtitles}
            sectionStyle={props.sectionStyle}
            sectionVisible={props.sectionVisible}
            onPlaySongs={props.onPlaySongs}
            onSongSelect={props.onSongSelect}
            onOpenPlaylist={props.onOpenPlaylist}
            onOpenAlbum={props.onOpenAlbum}
            onOpenArtist={props.onOpenArtist}
            onSongContextMenu={props.onSongContextMenu}
            onOpenMoreSection={props.onOpenMoreSection}
            onOpenSearch={props.onOpenSearch}
            onRetry={props.onRetry}
          />
        </div>
      </div>

      {/* 听书分区：分类胶囊 + 卡片墙（数据/状态在 kugouLongaudio 独立 store） */}
      <div className={paneClass('longaudio')} aria-hidden={activeZone !== 'longaudio'} data-kugou-zone="longaudio">
        <KugouLongaudioBoard
          accent={props.accent}
          compactCards={props.compactCards}
          showSubtitles={props.showSubtitles}
          expandedHome={props.expandedHome}
          exploreCardBg={props.exploreCardBg}
          sectionStyle={props.sectionStyle}
          sectionVisible={props.sectionVisible}
        />
      </div>

      {/* 刷歌分区：入口卡片条 + 空态 + 最近动态（数据/状态在 kugouYouth 独立 store） */}
      <div className={paneClass('youth')} aria-hidden={activeZone !== 'youth'} data-kugou-zone="youth">
        <KugouYouthFeedBoard
          accent={props.accent}
          compactCards={props.compactCards}
          showSubtitles={props.showSubtitles}
          exploreCardBg={props.exploreCardBg}
          sectionStyle={props.sectionStyle}
          sectionVisible={props.sectionVisible}
          onPlaySongs={props.onPlaySongs}
          onSongContextMenu={props.onSongContextMenu}
        />
      </div>

      {/* 独立听书播放器挂在分区外壳下面，只在 kugou 下存在。 */}
      <KugouLongaudioOverlay />
      {/* 刷歌全屏竖滑页（store 共享：分区卡片条/其它入口的「开始刷歌」按钮都开它） */}
      <KugouYouthFeedOverlay
        playing={false}
        onTogglePlay={() => { /* 播放控制由 onPlaySongs 起播的主播放器承担 */ }}
        onPlaySongs={(song, songs) => props.onPlaySongs(song, songs, true)}
        onSongContextMenu={(event, song, songs) => props.onSongContextMenu(event, song, songs)}
      />
    </div>
  )
}
