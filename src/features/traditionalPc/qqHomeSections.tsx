// QQ 首页（传统模式）的推荐流分节：官方首页在「猜你喜欢大卡 + 你的歌单宝藏库」之后
// 还有一串货架（听「X」的也在听 / 歌单遨游指南 / 「昵称」，这是你的幸运好歌 …），
// 这些货架来自同一个 PC 原生推荐流（feed.modules[1..]），按卡片 style 决定版式：
//   · 208（type 200）= 歌曲架 → 官方是「封面 + 歌名 + 品质标 + 歌手」的三列列表（实测 9 首/架）；
//   · 302/301        = 歌单卡 / 单曲卡 → 封面网格；
//   · 5122/1700 等    = 听书/节目/直播类，本软件没有对应数据源，整块不渲染（与乐馆同一口径）。
//
// 另外这里承载「点了就能出声」的预取：猜你喜欢（电台 99）在首页挂载时后台预拉一批，
// 点击直接用缓存开播；歌曲架的歌手/曲目也在悬停时预取，避免点击后再等两三个来回。
import { memo, useCallback, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Pause, Play } from 'lucide-react'
import { resolveQQExploreSongs } from '../qqExplore/api'
import type { QQExploreCard, QQExploreModule } from '../qqExplore/model'
import { PcCover, type PcTheme } from './pcKit'
import type { Song } from '../../services/musicApi'
import type { QQGuessYouLikeBatch } from '../../services/exploreApi'

/* ------------------------------------------------------------------ *
 * 猜你喜欢批次预取（点击到出声的延迟主要花在这条链路上）
 * ------------------------------------------------------------------ */

interface GuessBatchEntry { batch: QQGuessYouLikeBatch; at: number }
const GUESS_BATCH_TTL = 5 * 60 * 1000
const guessBatchCache = new Map<string, GuessBatchEntry>()
const guessBatchInflight = new Map<string, Promise<QQGuessYouLikeBatch>>()

/** 缓存键带上账号，避免切换 QQ 账号后播出上一个账号的推荐。 */
function guessBatchKey(accountKey: string): string { return `qq:${accountKey || 'anonymous'}` }

/**
 * 预取一批猜你喜欢并缓存（幂等：命中缓存或已有在途请求时直接复用）。
 * accountKey 传 userId/用户名即可——仅作为缓存隔离，不参与请求。
 * 返回带服务端文案的整批（songs + radio），首页大卡文案与开播队列共用同一份。
 */
export function prefetchQQGuessYouLike(accountKey: string, fetcher: () => Promise<QQGuessYouLikeBatch>): Promise<QQGuessYouLikeBatch> {
  const key = guessBatchKey(accountKey)
  const cached = guessBatchCache.get(key)
  if (cached && Date.now() - cached.at < GUESS_BATCH_TTL && cached.batch.songs.length) return Promise.resolve(cached.batch)
  const inflight = guessBatchInflight.get(key)
  if (inflight) return inflight
  const task = fetcher()
    .then(batch => {
      if (batch.songs.length) guessBatchCache.set(key, { batch, at: Date.now() })
      return batch
    })
    .finally(() => { guessBatchInflight.delete(key) })
  guessBatchInflight.set(key, task)
  return task
}

/** 读取缓存（过期返回 null），点击时同步可用就不必再等网络。 */
export function peekQQGuessYouLike(accountKey: string): QQGuessYouLikeBatch | null {
  const cached = guessBatchCache.get(guessBatchKey(accountKey))
  if (!cached) return null
  if (Date.now() - cached.at >= GUESS_BATCH_TTL) return null
  return cached.batch
}

/* ------------------------------------------------------------------ *
 * 歌曲架：按 id 解析成 Song 并缓存（208 卡只带 id/歌名/歌手，播放前必须补详情）
 * ------------------------------------------------------------------ */

const moduleSongsCache = new Map<string, Song[]>()
const moduleSongsInflight = new Map<string, Promise<Song[]>>()

export function prefetchQQModuleSongs(module: QQExploreModule): Promise<Song[]> {
  const cards = module.cards.slice(0, 36)
  if (!cards.length) return Promise.resolve([])
  const cached = moduleSongsCache.get(module.instanceId)
  if (cached?.length) return Promise.resolve(cached)
  const inflight = moduleSongsInflight.get(module.instanceId)
  if (inflight) return inflight
  const task = resolveQQExploreSongs(cards.map(card => ({
    songId: card.id,
    title: card.title,
    artist: card.subtitle,
    coverUrl: card.coverUrl,
  })))
    .then(songs => {
      if (songs.length) moduleSongsCache.set(module.instanceId, songs)
      return songs
    })
    .catch(() => [] as Song[])
    .finally(() => { moduleSongsInflight.delete(module.instanceId) })
  moduleSongsInflight.set(module.instanceId, task)
  return task
}

/* ------------------------------------------------------------------ *
 * 货架识别 / 隐藏规则
 * ------------------------------------------------------------------ */

/** 没有数据源或与音乐无关的货架（听书 / 节目 / 直播 / 星光 / 数字专辑…）整块不渲染。 */
const HIDDEN_QQ_HOME_MODULE_LABELS = [
  '热门节目', '听点不一样的', '听书', '有声', '节目', '直播', '星光', '数字专辑',
  '推荐游戏', '明星空降', '自定义',
  // pcH5 推荐流（2026-10-07）的播客货架标题会轮换：同一 shelf(272) 有「热门节目，听点不一样的🌿」
  // 与「随时随地，停不下来」两套文案，本软件不做听书/节目，两套都拦。
  '随时随地', '停不下来',
] as const

export function isHiddenQQHomeModule(module: QQExploreModule): boolean {
  if (!module.cards.length) return true
  // 标签只扫「栏目名」：历史上把卡面标题也扫进来，个性化歌单货架（如「你的歌单宝藏库」）轮换出的
  // 歌单卡偶尔有一张名字带「有声/直播/节目」等词，整块货架会被误杀——表现为首页有时整段少一块
  // （2026-10-07 用户实测：少了「你的私藏歌单」）。卡面级噪音交给下面的可操作性/卡型规则。
  const title = String(module.title || '')
  if (HIDDEN_QQ_HOME_MODULE_LABELS.some(label => title.includes(label))) return true
  // 听书/节目类卡型（style 5122/1700 等）在任何标题下都不渲染
  if (module.cards.every(card => card.style === 5122 || card.type === 1700 || card.style === 1100 || card.style === 217 || card.style === 85)) return true
  // 没有一张能用卡的货架整块不渲染（与「渲染出来的都要能用」同口径）：pcH5 推荐流的播客货架(272)
  // 标题在轮换、卡型也不在名单里，但卡全是本软件打不开的内容（action=unsupported），靠这条兜住。
  if (module.cards.length >= 3 && module.cards.every(card => card.action?.type === 'unsupported')) return true
  return false
}

export type QQHomeModuleKind = 'songs' | 'cards'

/** 歌曲架（208/301/304/206 等单曲卡）还是卡片架（歌单/专辑/榜单）。 */
export function qqHomeModuleKind(module: QQExploreModule): QQHomeModuleKind {
  const cards = module.cards
  const songCards = cards.filter(card => card.action.type === 'play-songs' && !card.songs.length).length
  return songCards > cards.length / 2 ? 'songs' : 'cards'
}

/** 卡片上的播放量文案（"84.2万" / "1w+"）转成数字，交给官方同款角标格式化。 */
export function qqCountTextToNumber(text?: string): number | undefined {
  const raw = String(text || '').trim()
  if (!raw) return undefined
  const match = raw.match(/^([\d.]+)\s*(亿|万|w|k)?/i)
  if (!match) return undefined
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return undefined
  const unit = (match[2] || '').toLowerCase()
  if (unit === '亿') return Math.round(value * 100000000)
  if (unit === '万') return Math.round(value * 10000)
  if (unit === 'w') return Math.round(value * 10000)
  if (unit === 'k') return Math.round(value * 1000)
  return Math.round(value)
}

/** 卡片副标题里的播放量（官方歌单架的「标题 | 副标题」会把播放量拼在副标题里）。 */
export function qqCardPlayCount(card: QQExploreCard): number | undefined {
  return qqCountTextToNumber(card.countContent)
    || qqCountTextToNumber((card.subtitle || '').match(/[\d.]+\s*(?:亿|万)/)?.[0])
}

/* ------------------------------------------------------------------ *
 * 歌曲架组件（官方三列歌曲列表）
 * ------------------------------------------------------------------ */

interface PcSongShelfProps {
  module: QQExploreModule
  theme: PcTheme
  accent: string
  /** 最多渲染几首（官方首页实测 9 首 = 三行三列） */
  limit?: number
  onPlayAt: (module: QQExploreModule, index: number) => void
  onSongMenu?: (event: ReactMouseEvent, song: Song | null, card: QQExploreCard) => void
  currentSongKey?: string
}

export const PcSongShelf = memo(function PcSongShelf({
  module, theme, accent, limit = 9, onPlayAt, onSongMenu, currentSongKey = '',
}: PcSongShelfProps) {
  const cards = useMemo(() => module.cards.slice(0, limit), [module, limit])
  const resolved = moduleSongsCache.get(module.instanceId) || []
  const warm = useCallback(() => { void prefetchQQModuleSongs(module) }, [module])

  return (
    <div className="grid grid-cols-1 gap-x-10 gap-y-0.5 md:grid-cols-2 xl:grid-cols-3">
      {cards.map((card, index) => {
        const song = resolved[index]
        const active = Boolean(currentSongKey && song && currentSongKey === `${song.platform || 'qq'}:${song.id || song.mid || ''}`)
        const cover = song?.album?.picUrl || card.coverUrl
        const tag = card.typeTag || card.badges[0] || ''
        return (
          <button
            key={`${module.instanceId}:${card.id}:${index}`}
            type="button"
            onMouseEnter={warm}
            onClick={() => onPlayAt(module, index)}
            onContextMenu={event => onSongMenu?.(event, song || null, card)}
            className={`group flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left transition ${theme.hover}`}
          >
            <PcCover src={cover} alt={card.title || '歌曲'} className="h-11 w-11 shrink-0" rounded="rounded-[6px]" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5">
                <span className={`truncate text-[13px] ${active ? '' : theme.text}`} style={active ? { color: accent } : undefined}>{card.title || song?.name || '未知歌曲'}</span>
                {tag ? (
                  <span className="shrink-0 rounded-[3px] border border-amber-400/60 px-1 text-[10px] leading-[15px] text-amber-500/90">{tag}</span>
                ) : null}
              </span>
              <span className={`mt-0.5 block truncate text-[12px] ${theme.faint}`}>{card.subtitle || (song?.artists || []).map(artist => artist.name).join('/')}</span>
            </span>
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full opacity-0 transition group-hover:opacity-100" style={{ background: accent }}>
              {active ? <Pause className="h-3.5 w-3.5 fill-white text-white" /> : <Play className="h-3.5 w-3.5 fill-white text-white" />}
            </span>
          </button>
        )
      })}
    </div>
  )
})

/** 分节标题（官方首页：标题 + 播放全部小按钮）。 */
export function PcShelfTitle({ title, theme, accent, onPlayAll, playAllDisabled }: { title: string; theme: PcTheme; accent: string; onPlayAll?: () => void; playAllDisabled?: boolean }) {
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const handlePlayAll = () => {
    if (!onPlayAll || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    onPlayAll()
    window.setTimeout(() => { busyRef.current = false; setBusy(false) }, 1200)
  }
  return (
    <div className="mb-3 flex items-center gap-2">
      <h2 className={`text-[17px] font-semibold ${theme.text}`}>{title}</h2>
      {onPlayAll ? (
        <button
          type="button"
          onClick={handlePlayAll}
          disabled={playAllDisabled || busy}
          aria-label={`播放全部 ${title}`}
          className={`flex h-6 w-6 items-center justify-center rounded-full transition disabled:opacity-40 ${theme.solidBtn}`}
        >
          <Play className="h-3 w-3 fill-current" style={{ color: accent }} />
        </button>
      ) : null}
    </div>
  )
}
