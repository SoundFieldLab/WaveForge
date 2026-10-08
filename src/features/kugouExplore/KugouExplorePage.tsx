/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * 探索页-酷狗一级分区外壳：**音乐 / 听书**（归属酷狗，不是通用板块瀑布）。
 * 「刷歌」分区已按产品决策下线（上游 /youth 动态流对本账号恒空，入口无内容）。
 * 做法规格对齐 QQ 探索页的「推荐 / 乐馆」与网易云探索页的「推荐 / 发现」：
 * 顶部一行分区页签，非激活分区保持挂载（display:none）——切回来不重新请求、
 * 不丢子板块内部状态（标签筛选、卡片墙数据）。
 *
 * 分区切换用酷狗品牌色 #FF7A00：激活项是品牌色实心胶囊，未激活为半透明底。
 * 分区显隐不新造偏好位，直接从板块显隐推导：
 *   音乐 = 五个子板块（推荐/乐库/歌单/频道/分类）任一可见；
 *   听书 = kugouLongaudio。
 * 因此设置面板里隐藏某个板块后，其所属分区在没有可见子板块时自动消失。
 *
 * 平台隔离：只在 ExploreView 的 platform === 'kugou' 分支挂载。
 */
import { useState, type CSSProperties, type ReactNode } from 'react'
import { BookAudio, Music2 } from 'lucide-react'
import type { ExplorePayload } from '../../services/exploreApi'
import type { ExploreSectionId } from '../../components/ExploreSettingsPanel'
import KugouExploreSections, { KugouDiscoverBoard, type KugouExploreHandlers } from './KugouExploreSections'
import KugouLongaudioBoard from '../kugouLongaudio/KugouLongaudioBoard'
import KugouLongaudioOverlay from '../kugouLongaudio/KugouLongaudioOverlay'

export type KugouExploreZoneId = 'music' | 'longaudio'

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
  sectionStyle: (section: ExploreSectionId) => CSSProperties
  sectionVisible: (section: ExploreSectionId) => boolean
}

export default function KugouExplorePage(props: KugouExplorePageProps) {
  const { accent, accentRgb, sectionVisible } = props
  const [requestedZone, setRequestedZone] = useState<KugouExploreZoneId>('music')

  const zones: Array<{ id: KugouExploreZoneId; label: string; hint: string; icon: ReactNode }> = []
  if (KUGOU_MUSIC_SECTIONS.some(section => sectionVisible(section))) {
    zones.push({ id: 'music', label: '音乐', hint: '推荐 · 乐库 · 歌单 · 频道 · 分类', icon: <Music2 className="h-4 w-4" /> })
  }
  if (sectionVisible('kugouLongaudio')) {
    zones.push({ id: 'longaudio', label: '听书', hint: '有声小说 · 相声评书 · 助眠解压（独立听书播放器）', icon: <BookAudio className="h-4 w-4" /> })
  }

  // 当前选中的分区在设置里被隐藏（或其全部子板块被隐藏）时回落到第一个可用分区。
  // 用计算值而不是 effect 校正：设置面板一改动就立即生效，不会渲染一帧空白。
  const availableZones = zones.map(zone => zone.id)
  const activeZone: KugouExploreZoneId = availableZones.includes(requestedZone)
    ? requestedZone
    : (availableZones[0] ?? 'music')
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

      {/* 音乐分区：收纳官方五板块（板块顺序仍按用户在设置里的排序，用 flex order 生效） */}
      <div className={paneClass('music')} aria-hidden={activeZone !== 'music'} data-kugou-zone="music">
        <div className="flex flex-col gap-12">
          <KugouDiscoverBoard
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

      {/* 独立听书播放器挂在分区外壳下面，只在 kugou 下存在。
          （KugouYouthFeedOverlay 随「刷歌」下线一起移除。） */}
      <KugouLongaudioOverlay />
    </div>
  )
}
