/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * 探索页-酷狗「刷歌」板块（3.E）：入口卡片条 + 空态 + 进入全屏竖滑页。
 * 与 QQ 刷歌同粒度：卡片点击 → 主播放器队列；全屏竖滑页见 KugouYouthFeedOverlay。
 *
 * 上游实测本账号动态恒为空（list:[] + is_end:1），因此：
 * - 空态是主路径：「当前账号暂无动态」+ 刷新 + 最近动态（/recent_dynamic）；
 * - 有卡片时按原始数组渲染，识别不出曲目的卡片也能展示（不猜字段、不静默丢）。
 */
import { useEffect, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { AlertCircle, Music2, Play, Radio, RefreshCw, Sparkles } from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import type { ExploreSectionId } from '../../components/ExploreSettingsPanel'
import type { Song } from '../../services/musicApi'
import { hasKugouConceptCredential } from '../../services/kugouService'
import { kugouYouthStore, selectYouthSongs, type KugouYouthState } from './store'

export interface KugouYouthFeedBoardProps {
  accent: string
  compactCards: boolean
  showSubtitles: boolean
  exploreCardBg: string
  sectionStyle: (section: ExploreSectionId) => CSSProperties
  sectionVisible: (section: ExploreSectionId) => boolean
  onPlaySongs: (song: Song, songs: Song[], continuous?: boolean) => void
  onSongContextMenu?: (event: React.MouseEvent, song: Song, songs: Song[]) => void
}

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

export default function KugouYouthFeedBoard(props: KugouYouthFeedBoardProps) {
  const { accent, showSubtitles, sectionStyle, sectionVisible, onPlaySongs, onSongContextMenu } = props
  const state = useSyncExternalStore(kugouYouthStore.subscribe, kugouYouthStore.getState) as KugouYouthState
  const { cards, recentCards, loading, error, empty, recentError } = state
  const loggedIn = hasKugouConceptCredential()

  useEffect(() => {
    if (!loggedIn) return
    void kugouYouthStore.refresh()
    // 只在挂载时拉一次；刷新由板块/播放页按钮触发（与其它酷狗板块一致）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn])

  // 动态为空时用「最近动态」兜底：官方客户端的刷歌历史入口语义
  useEffect(() => {
    if (!loggedIn || loading || !empty) return
    void kugouYouthStore.loadRecent()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loggedIn, loading, empty])

  // 刷歌是酷狗探索页的一级分区（与音乐/听书并列），显隐走独立板块位而不是「为你发现」
  if (!sectionVisible('kugouYouth')) return null

  // 预览按原始顺序，不因为「识别不出曲目」就把条目从列表里剔掉（识别不出的卡片会以占位形态出现）
  const previewCards = cards.slice(0, 8)

  return (
    <section style={sectionStyle('kugouYouth')} data-kugou-board="youth">
      <Heading
        icon={<Radio className="h-5 w-5" />}
        title="刷歌"
        subtitle={showSubtitles ? '竖滑动态流 · 滑到下一首，播放交给主播放器' : undefined}
        action={
          <button
            type="button"
            onClick={() => kugouYouthStore.open()}
            disabled={!loggedIn}
            className="flex items-center gap-2 rounded-full border border-white/[0.08] bg-white/[0.05] px-4 py-2 text-sm text-white/80 transition hover:bg-white/[0.12] disabled:opacity-50"
          >
            <Sparkles className="h-4 w-4" /> 进入刷歌
          </button>
        }
      />

      {!loggedIn ? (
        <div className="flex flex-col items-center justify-center rounded-[24px] border border-white/[0.07] bg-white/[0.03] px-6 py-10 text-center">
          <Music2 className="mb-3 h-6 w-6 text-white/25" />
          <p className="text-sm text-white/70">请先登录酷狗音乐（概念版扫码），刷歌需要登录态</p>
        </div>
      ) : loading ? (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="rounded-[20px] border border-white/[0.06] bg-white/[0.03]">
              <div className="aspect-square animate-pulse rounded-[20px] bg-white/[0.05]" />
              <div className="mt-2 h-3 w-3/4 animate-pulse rounded bg-white/[0.05]" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center rounded-[24px] border border-rose-300/15 bg-rose-500/[0.06] px-6 py-10 text-center">
          <AlertCircle className="mb-3 h-6 w-6 text-rose-200/70" />
          <p className="text-sm text-rose-100/85">{error}</p>
          <button
            type="button"
            onClick={() => void kugouYouthStore.refresh()}
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
          >
            <RefreshCw className="h-4 w-4" /> 重试
          </button>
        </div>
      ) : empty || cards.length === 0 ? (
        <div className="rounded-[24px] border border-white/[0.07] bg-white/[0.03] px-6 py-10 text-center" data-kugou-youth="empty">
          <Music2 className="mx-auto mb-3 h-6 w-6 text-white/25" />
          <p className="text-sm font-medium text-white/72">当前账号暂无动态</p>
          <p className="mx-auto mt-1.5 max-w-[520px] text-xs leading-relaxed text-white/40">
            酷狗 concept /youth/v3/user/get_dynamic 对当前账号返回空列表（is_end=1）：动态卡片字段无法实测，
            客户端已按「数组原样透传 + 多形态兼容解析」实现，接口一有数据就会直接显示。
          </p>
          <button
            type="button"
            onClick={() => { void kugouYouthStore.refresh(); void kugouYouthStore.loadRecent() }}
            className="mt-4 inline-flex items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> 刷新
          </button>
          {recentCards.length > 0 && (
            <div className="mt-8 text-left">
              <div className="mb-3 flex items-center justify-between">
                <p className="text-sm text-white/60">最近刷到</p>
              </div>
              <div className="grid grid-cols-3 gap-x-4 gap-y-6 md:grid-cols-5 xl:grid-cols-6">
                {recentCards.slice(0, 6).map((card, index) => (
                  <button
                    key={`${index}-${card.title || 'card'}`}
                    type="button"
                    onClick={() => { if (card.song) onPlaySongs(card.song, selectYouthSongs(recentCards), true) }}
                    className="group min-w-0 text-left"
                  >
                    <span className="relative block aspect-square overflow-hidden rounded-[18px] border border-white/[0.08]" style={{ backgroundColor: props.exploreCardBg }}>
                      {card.coverUrl ? (
                        <CachedImage src={card.coverUrl} alt={card.title || '刷歌卡片'} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                      ) : (
                        <span className="flex h-full w-full items-center justify-center"><Music2 className="h-6 w-6 text-white/30" /></span>
                      )}
                    </span>
                    <span className="mt-2 block truncate text-sm text-white/80">{card.title || '未识别动态卡片'}</span>
                    <span className="block truncate text-xs text-white/40">{card.artist || '字段未识别'}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
          {!recentCards.length && recentError && <p className="mt-3 text-xs text-white/35">最近动态获取失败：{recentError}</p>}
        </div>
      ) : (
        <div
          className="grid grid-cols-2 gap-x-4 gap-y-6 md:grid-cols-4 xl:grid-cols-6"
          onContextMenu={event => {
            // 卡片条右键：命中该卡片曲目时复用宿主页歌曲菜单
            if (!onSongContextMenu) return
            const target = (event.target as HTMLElement).closest('[data-kugou-youth-card]')
            if (!target) return
            const cardIndex = Number(target.getAttribute('data-kugou-youth-card'))
            const card = cards[cardIndex]
            if (!card?.song) return
            event.preventDefault()
            onSongContextMenu(event, card.song, selectYouthSongs(cards))
          }}
        >
          {previewCards.map((card, index) => {
            const cardIndex = cards.indexOf(card)
            return (
              <motion.button
                key={`${cardIndex}-${card.title || 'card'}`}
                type="button"
                data-kugou-youth-card={cardIndex}
                whileHover={{ y: -4 }}
                onClick={() => {
                  kugouYouthStore.select(cardIndex)
                  kugouYouthStore.open()
                }}
                className="group min-w-0 text-left"
              >
                <span className="relative block aspect-square overflow-hidden rounded-[20px] border border-white/[0.08] shadow-xl shadow-black/10" style={{ backgroundColor: props.exploreCardBg }}>
                  {card.coverUrl ? (
                    <CachedImage src={card.coverUrl} alt={card.title || '刷歌卡片'} className="h-full w-full object-cover transition duration-500 group-hover:scale-105" />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center"><Music2 className="h-6 w-6 text-white/30" /></span>
                  )}
                  {card.song && (
                    <span className="absolute bottom-2.5 right-2.5 flex h-9 w-9 translate-y-2 items-center justify-center rounded-full text-[#081017] opacity-0 shadow-xl transition group-hover:translate-y-0 group-hover:opacity-100" style={{ background: accent }}>
                      <Play className="h-4 w-4 fill-current" />
                    </span>
                  )}
                </span>
                <span className="mt-2.5 line-clamp-2 block text-sm font-medium leading-snug text-white/86">{card.title || '未识别动态卡片'}</span>
                <span className="mt-1 block truncate text-xs text-white/38">{card.artist || (card.song ? '未知歌手' : '字段未识别 · 已原样透传')}</span>
              </motion.button>
            )
          })}
        </div>
      )}
    </section>
  )
}
