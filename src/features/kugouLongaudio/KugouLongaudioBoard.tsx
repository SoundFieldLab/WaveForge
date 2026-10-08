/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * 探索页-酷狗「听书」板块：分类胶囊 + 每日推荐卡片墙 + 进入听书 / 我的听书入口。
 * 布局对齐酷狗官方客户端听书页（分类胶囊 + 卡片墙，卡片带 完结 / 听书VIP / 播放量 角标）。
 * 分类只能对已加载内容按 tag_info.tag_name 聚合筛选：上游没有实测过的按分类拉取接口。
 */
import { memo, useCallback, useEffect, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import {
  AlertCircle,
  BookAudio,
  ChevronRight,
  Crown,
  Headphones,
  History,
  Library,
  Loader2,
  Music2,
  Play,
  RefreshCw,
} from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import type { ExploreSectionId } from '../../components/ExploreSettingsPanel'
import {
  kugouLongaudioStore,
  selectBrowseTags,
  selectVisibleBrowseAlbums,
  type LongaudioState,
} from './store'
import type { KugouLongaudioAlbum } from '../../services/kugouService'

const formatCount = (value?: number) => {
  const count = Number(value || 0)
  if (!count) return ''
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(count >= 1_000_000_000 ? 0 : 1)}亿`
  if (count >= 10_000) return `${(count / 10_000).toFixed(count >= 1_000_000 ? 0 : 1)}万`
  return String(count)
}

const KgCover = memo(function KgCover({ src, alt, className = '' }: { src?: string; alt: string; className?: string }) {
  return (
    <CachedImage
      src={src || ''}
      alt={alt}
      className={className}
      draggable={false}
      lazy
      role="card"
      priority="visible"
      fallback={<div className="flex h-full w-full items-center justify-center bg-[linear-gradient(135deg,rgba(255,122,0,0.85),rgba(20,184,166,0.6))] text-white/80"><Music2 className="h-5 w-5" /></div>}
    />
  )
})

function Heading({ icon, title, subtitle, action }: { icon: ReactNode; title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
      <div>
        <div className="flex items-center gap-2.5 text-white">
          <span className="text-white/70">{icon}</span>
          <h2 className="text-xl font-semibold tracking-tight md:text-2xl">{title}</h2>
        </div>
        {subtitle && <p className="mt-1.5 text-sm text-white/45">{subtitle}</p>}
      </div>
      {action}
    </div>
  )
}

function BoardState({ icon, title, hint, action }: { icon: ReactNode; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[24px] border border-white/[0.07] bg-white/[0.03] px-6 py-10 text-center">
      <span className="mb-3 text-white/25">{icon}</span>
      <p className="text-sm font-medium text-white/70">{title}</p>
      {hint && <p className="mt-1.5 max-w-md text-xs leading-relaxed text-white/38">{hint}</p>}
      {action}
    </div>
  )
}

/** 卡片角标：完结 / 听书VIP（实测可用信号 is_pay）/ 播放量。
 *  上游 daily/album/audios 实测都没有「完结」字段，该角标只在字段真实存在时出现。 */
function AlbumBadges({ album }: { album: KugouLongaudioAlbum }) {
  const playText = formatCount(album.playCount)
  return (
    <>
      <div className="pointer-events-none absolute left-2.5 top-2.5 flex flex-col items-start gap-1.5">
        {album.finished && (
          <span className="rounded-full bg-emerald-500/85 px-2 py-0.5 text-[10px] font-medium text-white shadow-sm">完结</span>
        )}
        {album.isPaid && (
          <span className="flex items-center gap-0.5 rounded-full bg-[linear-gradient(135deg,#f7c948,#e8960c)] px-2 py-0.5 text-[10px] font-semibold text-[#3a2600] shadow-sm">
            <Crown className="h-2.5 w-2.5" /> 听书VIP
          </span>
        )}
      </div>
      {playText && (
        <span className="pointer-events-none absolute bottom-2.5 left-2.5 flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] text-white/80">
          <Headphones className="h-3 w-3" /> {playText}
        </span>
      )}
    </>
  )
}

export interface KugouLongaudioBoardProps {
  accent: string
  compactCards: boolean
  showSubtitles: boolean
  expandedHome: boolean
  exploreCardBg: string
  sectionStyle: (section: ExploreSectionId) => CSSProperties
  sectionVisible: (section: ExploreSectionId) => boolean
}

export default function KugouLongaudioBoard(props: KugouLongaudioBoardProps) {
  const state = useSyncExternalStore(kugouLongaudioStore.subscribe, kugouLongaudioStore.getState) as LongaudioState
  const { browse } = state
  const albums = selectVisibleBrowseAlbums(state)
  const tags = selectBrowseTags(state)
  const accent = props.accent

  useEffect(() => {
    if (!props.sectionVisible('kugouLongaudio')) return
    void kugouLongaudioStore.ensureBrowseLoaded()
  }, [props.sectionVisible])

  const handleSelectTag = useCallback((tag: string | null) => {
    kugouLongaudioStore.setBrowseTag(tag)
  }, [])

  // 打开专辑/进入播放器全在 feature 内部走独立 store：ExploreView 只挂载板块与 Overlay
  const openAlbum = useCallback((album: KugouLongaudioAlbum, autoplay = false) => {
    void kugouLongaudioStore.openAlbum(album.albumId, { play: autoplay, summary: album })
  }, [])

  if (!props.sectionVisible('kugouLongaudio')) return null

  const entryButton = (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={() => kugouLongaudioStore.enter()}
        className="flex items-center gap-2 rounded-full px-4 py-1.5 text-xs font-semibold text-[#081017] transition hover:brightness-110"
        style={{ background: accent }}
      >
        <BookAudio className="h-3.5 w-3.5" /> 进入听书
      </button>
      <button
        type="button"
        onClick={() => kugouLongaudioStore.openLibrary()}
        className="flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.055] px-4 py-1.5 text-xs text-white/62 transition hover:bg-white/[0.1] hover:text-white"
      >
        <Library className="h-3.5 w-3.5" /> 我的听书
      </button>
    </div>
  )

  return (
    <section style={props.sectionStyle('kugouLongaudio')} data-kugou-board="longaudio">
      <Heading
        icon={<BookAudio className="h-5 w-5" />}
        title="听书"
        subtitle={props.showSubtitles ? '有声小说 / 相声评书 / 助眠解压（分类为已加载内容的标签聚合）' : undefined}
        action={entryButton}
      />

      {tags.length > 0 && (
        <div className="mb-5 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => handleSelectTag(null)}
            className="rounded-full border px-3 py-1 text-xs transition"
            style={browse.tag === null
              ? { background: accent, borderColor: accent, color: '#081017' }
              : { borderColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.55)' }}
          >
            全部
          </button>
          {tags.map(tag => (
            <button
              key={tag.name}
              type="button"
              onClick={() => handleSelectTag(tag.name)}
              className="rounded-full border px-3 py-1 text-xs transition hover:bg-white/[0.08] hover:text-white"
              style={browse.tag === tag.name
                ? { background: accent, borderColor: accent, color: '#081017' }
                : { borderColor: 'rgba(255,255,255,0.1)', color: 'rgba(255,255,255,0.55)' }}
            >
              {tag.name}
            </button>
          ))}
        </div>
      )}

      {browse.loading && browse.albums.length === 0 ? (
        <div className="flex min-h-32 items-center justify-center gap-2 rounded-[24px] border border-white/[0.07] bg-white/[0.03] text-sm text-white/50">
          <Loader2 className="h-4 w-4 animate-spin" /> 正在加载听书推荐…
        </div>
      ) : browse.error && browse.albums.length === 0 ? (
        <BoardState
          icon={<AlertCircle className="h-6 w-6" />}
          title="听书推荐加载失败"
          hint={browse.error}
          action={(
            <button
              type="button"
              onClick={() => void kugouLongaudioStore.ensureBrowseLoaded({ force: true })}
              className="mt-4 flex items-center gap-2 rounded-full px-4 py-2 text-xs font-medium text-[#081017]"
              style={{ background: accent }}
            >
              <RefreshCw className="h-3.5 w-3.5" /> 重试
            </button>
          )}
        />
      ) : albums.length === 0 ? (
        <BoardState
          icon={<BookAudio className="h-6 w-6" />}
          title={browse.tag ? `「${browse.tag}」下暂时没有听书` : '暂时没有听书推荐'}
          hint="上游听书推荐池按标签筛选后为空，换个分类或稍后再试。"
          action={browse.tag ? (
            <button
              type="button"
              onClick={() => handleSelectTag(null)}
              className="mt-4 flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.055] px-4 py-2 text-xs text-white/62 transition hover:bg-white/[0.1] hover:text-white"
            >
              查看全部分类
            </button>
          ) : undefined}
        />
      ) : (
        <>
          <div className={`grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 md:grid-cols-4 ${props.compactCards ? 'xl:grid-cols-7' : 'xl:grid-cols-6 min-[1900px]:grid-cols-7'}`}>
            {albums.slice(0, props.expandedHome ? 24 : 12).map(album => (
              <motion.div
                key={album.albumId}
                whileHover={{ y: -5 }}
                className="group min-w-0 cursor-pointer"
                onClick={() => openAlbum(album)}
              >
                <div className="relative aspect-square overflow-hidden rounded-[20px] border border-white/[0.08] shadow-xl shadow-black/10" style={{ backgroundColor: props.exploreCardBg }}>
                  <KgCover src={album.coverUrl} alt={album.name} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                  <AlbumBadges album={album} />
                  <button
                    type="button"
                    onClick={event => {
                      event.stopPropagation()
                      openAlbum(album, true)
                    }}
                    className="absolute bottom-2.5 right-2.5 flex h-10 w-10 translate-y-2 items-center justify-center rounded-full text-[#081017] opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100"
                    style={{ background: accent }}
                    aria-label={`播放 ${album.name}`}
                  >
                    <Play className="h-4 w-4 fill-current" />
                  </button>
                </div>
                <h3 className="mt-2.5 line-clamp-2 text-sm font-medium leading-snug text-white/86">{album.name}</h3>
                <p className="mt-1 truncate text-xs text-white/38">
                  {album.author || '未知主播'}
                  {album.chapterCount ? ` · ${album.chapterCount} 章` : ''}
                </p>
              </motion.div>
            ))}
          </div>
          {browse.hasMore && (
            <div className="mt-6 flex justify-center">
              <button
                type="button"
                disabled={browse.loading}
                onClick={() => void kugouLongaudioStore.loadMoreBrowse()}
                className="flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.055] px-5 py-2 text-sm text-white/62 transition hover:bg-white/[0.1] hover:text-white disabled:cursor-wait disabled:opacity-50"
              >
                {browse.loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ChevronRight className="h-4 w-4" />}
                加载更多
              </button>
            </div>
          )}
          <div className="mt-4 flex items-center gap-2 text-[11px] text-white/30">
            <History className="h-3.5 w-3.5" />
            最近收听会在「我的听书」里保留，播放走独立通道，不会改动主播放器队列。
          </div>
        </>
      )}
    </section>
  )
}
