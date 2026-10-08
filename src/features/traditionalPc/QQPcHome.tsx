// QQ 音乐 PC 客户端「Hi xx 今日为你推荐」首页（逆向官方 PC 布局）。
//
// 数据源：**QQ 客户端的原生推荐流**（`music.recommend.RecommendFeed/get_recommend_feed`，
// 走 qqExplore 的 bootstrap 接口），不是探索页那套聚合数据——后者来自手机端模块，
// 卡片内容与 PC 客户端对不上（实测过：PC 流的模块标题就是「Hi <昵称>  今日为你推荐」）。
//
// 版式对齐官方客户端（2026-10 逐页取证）：
//   · 首屏卡行 = 一张两格宽的猜你喜欢大卡 + 四张一格彩色功能卡，**整行等高**；
//     大卡左边是推荐语（第一行大字、第二行小字）+ 绿色播放圆钮，右边是当前推荐曲封面；
//     每张卡下方两行小字（第一行「歌曲 - 歌手」、第二行栏目标签）。
//   · 之后是「你的歌单宝藏库」封面货架。
//   · 再往下是推荐流的其余货架（听「X」的也在听 / 歌单遨游指南 / 「昵称」，这是你的幸运好歌…），
//     按卡片 style 分红：歌曲架三列列表、歌单/专辑架六列封面卡；听书/节目/直播类整块不渲染。
// 卡片点击严格按 feed 里的 action 分发；数据拿不到就整块不渲染，不伪造数字。无任何下载类入口。
import { memo, useCallback, useEffect, useMemo, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react'
import { Compass, Play } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import type { ExplorePayload } from '../../services/exploreApi'
import { fetchQQGuessYouLikeBatchWithMeta } from '../../services/exploreApi'
import { getApiBase } from '../../services/apiConfig'
import { fetchQQExploreBootstrap, fetchQQExploreFeed, fetchQQRadarSongs } from '../qqExplore/api'
import { dedupeQQModules, qqCardPlaylist, type QQExploreCard, type QQExploreCursor, type QQExploreModule } from '../qqExplore/model'
import { PcCardGrid, PcCover, PcEmpty, PcPrimaryButton, PcSectionTitle, pcTheme, type PcTone } from './pcKit'
import {
  PcSongShelf, PcShelfTitle, isHiddenQQHomeModule, peekQQGuessYouLike, prefetchQQGuessYouLike,
  prefetchQQModuleSongs, qqCardPlayCount, qqCountTextToNumber, qqHomeModuleKind,
} from './qqHomeSections'
import type { PcActions, PcAccount, PcChrome } from './types'

/** 主推卡的蓝色渐变 + 绿色播放按钮（官方 For You 卡配色语义）。 */
const PROMO_GRADIENT = 'linear-gradient(112deg, #3E86F5 0%, #5EA6F9 48%, #8CC6FF 100%)'
const PROMO_PLAY_GREEN = '#1FCB57'
/** 推荐语缺失时的固定文案（官方 For You 卡原文）。 */
const FALLBACK_RECOMMENDATION_LINE = '尝试来点儿音乐提提神吧~'
/**
 * 官方封面底部的英文标签条：服务端只下发中文栏目名，英文文案是客户端固定的
 * （2026-10-07 官方 PC 客户端截图取证：Daily 30 / Favorites / New Songs；
 * 雷达卡官方没有标签条，这里也保持不渲染）。颜色按官方卡位取值。
 */
const CARD_STRIP_LABELS: Record<string, { text: string; color: string }> = {
  '每日30首': { text: 'Daily 30', color: '#2F8BE8' },
  百万收藏: { text: 'Favorites', color: '#E58A3C' },
  新歌推荐: { text: 'New Songs', color: '#7C5CE0' },
  歌手漫游: { text: 'Star Mix', color: '#22A75E' },
}
const DEFAULT_ACCENT = '#31c27c'
/** 官方首页每个歌曲架展示 9 首（三行三列）。 */
const SONG_SHELF_LIMIT = 9

/**
 * 首屏缓存（sessionStorage，按账号隔离，5 分钟 TTL）：
 * 切换平台回到 QQ 推荐页 / 刷新窗口时先用缓存瞬间铺满首屏（stale-while-revalidate），
 * 后台再拉最新一份覆盖——否则每次进入都要等一轮 bootstrap（实测 0.3~1s，上游慢时 3s+），
 * 期间整行推荐卡都是空的（2026-10-07 用户反馈「过了三四秒才完整」）。
 */
const QQ_HOME_CACHE_KEY = 'waveforge:qq-home-feed:v1'
const QQ_HOME_CACHE_TTL = 5 * 60 * 1000
interface QQHomeCache {
  at: number
  account: string
  modules: QQExploreModule[]
  cursor: QQExploreCursor | null
  daily30: { playlistId?: string; title?: string; coverUrl?: string; songs?: Song[]; dateKey?: string } | null
}

function readQQHomeCache(accountKey: string): QQHomeCache | null {
  try {
    const raw = sessionStorage.getItem(QQ_HOME_CACHE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as QQHomeCache
    if (!parsed || parsed.account !== (accountKey || '')) return null
    if (Date.now() - Number(parsed.at || 0) > QQ_HOME_CACHE_TTL) return null
    if (!Array.isArray(parsed.modules) || parsed.modules.length === 0) return null
    return parsed
  } catch {
    return null
  }
}

function writeQQHomeCache(accountKey: string, modules: QQExploreModule[], cursor: QQExploreCursor | null, daily30: QQHomeCache['daily30']): void {
  try {
    if (!modules.length) return
    sessionStorage.setItem(QQ_HOME_CACHE_KEY, JSON.stringify({ at: Date.now(), account: accountKey || '', modules, cursor: cursor || null, daily30: daily30 || null }))
  } catch {
    // sessionStorage 不可用/超配额：缓存是纯优化，失败不影响功能
  }
}

export interface QQPcHomeProps {
  /** 聚合 payload：仅用于「歌单宝藏库」在 PC 歌单接口不可用时的兜底。 */
  payload: ExplorePayload | null
  chrome?: PcChrome
  account?: PcAccount
  actions?: PcActions
  /** 页面是否可见（隐藏保活页为 false 时不请求） */
  active?: boolean
  /** 旧接线兼容（父层若还按老 props 传） */
  username?: string
  loggedIn?: boolean
  muted?: string
  surface?: string
}

const EMPTY_ACTIONS: PcActions = { onPlaySongs: () => {}, onSongMenu: () => {}, onOpenPlaylist: () => {}, onNavigate: () => {} }

const artistLine = (song: Song): string => (song.artists || []).map(artist => artist.name).filter(Boolean).join(' / ')
/** 官方卡片下第一行小字的格式：「歌曲 - 歌手」。 */
const songCaption = (song?: Song | null): string => (song ? [song.name, artistLine(song)].filter(Boolean).join(' - ') : '')

/** runCard 能分发的 action 类型；之外的卡片渲染成静态卡（与乐馆 QQPcHall 同一处理），不留点了没反应的死按钮。 */
const ACTIONABLE_CARD_TYPES = new Set(['play-radio', 'play-radar', 'play-songs', 'open-playlist', 'open-preferences'])
const isActionableCard = (card: QQExploreCard): boolean => ACTIONABLE_CARD_TYPES.has(card.action?.type || '')

interface TreasureItem { key: string; coverUrl?: string; title: string; subtitle?: string; playCount?: number; playlist: any }

function QQPcHome({ payload, chrome, account, actions, active = true, username, loggedIn, muted }: QQPcHomeProps) {
  // 旧接线兼容：父层的 muted token 里含 white 即深色皮肤
  const tone: PcTone = chrome?.tone ?? (typeof muted === 'string' && muted.includes('white') ? 'dark' : 'light')
  const theme = pcTheme(tone)
  const accent = chrome?.accent || DEFAULT_ACCENT
  const act = useMemo<PcActions>(() => ({ ...EMPTY_ACTIONS, ...(actions || {}) }), [actions])
  const isLoggedIn = account?.loggedIn ?? Boolean(loggedIn)
  const displayName = account?.username || username || ''
  /** 缓存隔离键：换账号后不能用上一个账号的猜你喜欢批次。 */
  const accountKey = account?.userId || displayName || ''

  const [modules, setModules] = useState<QQExploreModule[]>(() => readQQHomeCache(accountKey)?.modules || [])
  const [cursor, setCursor] = useState<QQExploreCursor | null>(() => readQQHomeCache(accountKey)?.cursor || null)
  const [daily30, setDaily30] = useState<{ playlistId?: string; title?: string; coverUrl?: string; songs?: Song[]; dateKey?: string } | null>(() => readQQHomeCache(accountKey)?.daily30 || null)
  const [loading, setLoading] = useState(() => !readQQHomeCache(accountKey))
  const [busyKey, setBusyKey] = useState('')
  const [notice, setNotice] = useState('')
  const [treasure, setTreasure] = useState<TreasureItem[]>([])
  /** 预取到的猜你喜欢首曲：主推卡卡面与卡下小字都用它（官方卡面显示的就是当前推荐曲）。 */
  const [guessPreview, setGuessPreview] = useState<Song | null>(null)
  /** 电台随批次下发的文案（电台名 + 当前曲推荐模板）——官方大卡第一行就是它，不是客户端写死的。 */
  const [guessRadioMeta, setGuessRadioMeta] = useState<{ name: string; reason: string; template: string } | null>(null)

  // PC 原生推荐流（含每日 30 首）；失败时不报错，交给下面的空态。
  // 命中首屏缓存时这里只做后台刷新（stale-while-revalidate），界面已经用缓存渲染完毕。
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setLoading(true)
    void fetchQQExploreBootstrap()
      .then(snapshot => {
        if (cancelled) return
        const nextModules = snapshot?.feed?.modules || []
        setModules(nextModules)
        setCursor(snapshot?.feed?.cursor || null)
        setDaily30(snapshot?.daily30 || null)
        writeQQHomeCache(accountKey, nextModules, snapshot?.feed?.cursor || null, snapshot?.daily30 || null)
      })
      .catch(() => { if (!cancelled) setModules(current => current.length ? current : []) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [active, accountKey])

  // 官方首页在首屏之后还有一整串货架（听「X」的也在听 / 「昵称」的专属乐流 / 歌单遨游指南…），
  // 它们来自推荐流的后续分页。首屏渲染完成后**并行**补第 2、3 页（服务端按 page 独立取数，
  // 页与页没有先后依赖）——旧实现串行推进 cursor，后续货架要多等一整轮往返（2026-10-07 优化）。
  useEffect(() => {
    if (!active || !cursor) return
    let cancelled = false
    const controller = new AbortController()
    const loadRest = async () => {
      const [pageTwo, pageThree] = await Promise.all([
        fetchQQExploreFeed({ page: 2, shelfCount: 0 }, [], [], null, controller.signal).catch(() => null),
        fetchQQExploreFeed({ page: 3, shelfCount: 0 }, [], [], null, controller.signal).catch(() => null),
      ])
      if (cancelled || controller.signal.aborted) return
      let merged = modules
      for (const page of [pageTwo, pageThree]) {
        if (!page || !page.modules.length) continue
        merged = dedupeQQModules([...merged, ...page.modules])
      }
      if (merged !== modules) setModules(merged)
    }
    void loadRest().catch(() => { /* 后续分页失败不打扰首屏 */ })
    return () => { cancelled = true; controller.abort() }
    // modules 只在 bootstrap 时随 cursor 一起更新，这里以 cursor 变化为触发点
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, cursor])

  // 猜你喜欢预取：首页一挂载就在后台拉两批（与主推卡点击同一接口）。
  // ① fast 批（5 首，≈1s）：卡面文案 + 秒开兜底；② 完整批（30 首，≈6s）：点击时的开播队列，
  //    避免「点开只有 5 首」——用户浏览首页的这几秒通常已经就绪。
  useEffect(() => {
    if (!active || !isLoggedIn) return
    let cancelled = false
    void prefetchQQGuessYouLike(accountKey, () => fetchQQGuessYouLikeBatchWithMeta(0, [], undefined, { count: 8, fast: true }))
      .then(batch => {
        if (cancelled) return
        const first = batch.songs[0] || null
        setGuessPreview(first)
        const reason = batch.radio?.reasons.find(item => item.mid === String(first?.mid || '')) || batch.radio?.reasons[0]
        setGuessRadioMeta(reason ? { name: batch.radio?.name || '猜你喜欢', reason: reason.reason, template: reason.template } : null)
      })
      .catch(() => {})
    void prefetchQQGuessYouLike(`${accountKey}:full`, () => fetchQQGuessYouLikeBatchWithMeta(0, [], undefined, { count: 30 }))
      .catch(() => {})
    return () => { cancelled = true }
  }, [active, isLoggedIn, accountKey])

  // 歌单宝藏库：走 QQ 公开歌单广场的「推荐」分类（music_cover + 标题|副标题，与客户端同款卡片）；
  // 接口异常时退回聚合 payload 的歌单，保证这一块不会空着。
  useEffect(() => {
    if (!active) return
    let cancelled = false
    const fallback = () => {
      if (payload?.playlists?.length) {
        setTreasure(payload.playlists.slice(0, 18).map((playlist, index) => ({
          key: `payload:${playlist.platform || 'qq'}:${playlist.id || index}`,
          title: playlist.name,
          subtitle: playlist.creator || undefined,
          coverUrl: playlist.coverUrl,
          playCount: playlist.playCount,
          playlist,
        })))
      }
    }
    void fetch(`${getApiBase()}/qq/songlist/list?id=10000000&page=1&pageSize=18&sort=5`, { cache: 'no-store' })
      .then(response => response.json())
      .then(data => {
        if (cancelled) return
        const list: any[] = data?.list || data?.data?.list || []
        const items: TreasureItem[] = list.map((item, index) => {
          const title = String(item.title || item.dissname || item.name || '').trim()
          if (!title) return null
          const id = String(item.dissid || item.content_id || item.tid || item.id || index)
          const coverUrl = String(item.picurl || item.cover || item.imgurl || '').replace(/^http:/, 'https:')
          return {
            // 官方广场列表偶尔会重复返回同一歌单：键带上位次，避免 React 同键告警
            key: `treasure:${id}:${index}`,
            title,
            // 官方这类卡片把「标题 | 副标题」拼在一行显示，副标题缺失就不拼
            subtitle: String(item.subtitle || '').trim() || undefined,
            coverUrl,
            playCount: Number(item.listennum || item.playcount || 0) || undefined,
            playlist: { id, name: title, coverUrl, platform: 'qq' as const, source: 'qq-songlist-recommend' },
          } as TreasureItem
        }).filter((item): item is TreasureItem => Boolean(item))
        if (items.length) setTreasure(items)
        else fallback()
      })
      .catch(() => { if (!cancelled) fallback() })
    return () => { cancelled = true }
  }, [active, payload])

  const heroModule = modules[0]
  const heroCards = useMemo(() => (heroModule?.cards || []).filter(card => card.action?.type !== 'unsupported'), [heroModule])

  /** 主推大卡：优先 style 201/203 的电台类卡片（官方就是这张蓝色大卡）。 */
  const promoCard = useMemo(() => heroCards.find(card => (card.style === 201 || card.style === 203) && (card.action?.type === 'play-radio' || card.action?.type === 'play-songs'))
    || heroCards.find(card => card.style === 201 || card.style === 203)
    || null, [heroCards])
  /** 彩色功能卡：style 202（每日30首 / 刷歌模式 / 百万收藏 / 新歌推荐 / 歌手漫游…），最多 4 张。 */
  // **取服务器顺序的前 4 张**（实测官方这一行 = 每日30首 → 雷达模式 → 百万收藏 → 新歌推荐）。
  // 旧实现只筛 `type === 500`，会把 202/900/991 那张「雷达模式」（客户端界面叫「刷歌模式」）漏掉，
  // 于是第 5 张「歌手漫游」被顶上来——和官方客户端对不上（2026-10-07 用户实测反馈）。
  const featureCards = useMemo(() => heroCards.filter(card => card.style === 202).slice(0, 4), [heroCards])

  /** 主推卡下面还有别的货架吗：其余模块按官方顺序渲染，听书/节目类整块丢掉（最多 6 块，与客户端首屏量级一致）。 */
  const feedModules = useMemo(
    () => modules.slice(1).filter(module => !isHiddenQQHomeModule(module)).slice(0, 6),
    [modules],
  )

  const runCard = useCallback(async (card: QQExploreCard) => {
    const type = card.action?.type
    const key = card.id || card.title
    try {
      setNotice('')
      setBusyKey(key)
      switch (type) {
        case 'play-radio': {
          // 猜你喜欢：优先用完整队列（30 首，后台预取）；完整批尚未就绪时用 fast 批先开播
          // （官方「先几首就播 + 持续推荐歌曲」的秒开语义），播放中由队列续载自动追加。
          const full = peekQQGuessYouLike(`${accountKey}:full`)
          const quick = peekQQGuessYouLike(accountKey)
          const songs = full?.songs?.length
            ? full.songs
            : quick?.songs?.length
              ? quick.songs
              : (await prefetchQQGuessYouLike(`${accountKey}:full`, () => fetchQQGuessYouLikeBatchWithMeta(0, [], undefined, { count: 30 }))).songs
          if (!songs.length) throw new Error('猜你喜欢暂时没有返回歌曲')
          act.onPlaySongs(songs[0], songs, 0, { continuous: true })
          return
        }
        case 'play-radar': {
          const result = await fetchQQRadarSongs({ page: 1, reqType: 0, entranceSongs: [] })
          const songs: Song[] = result?.songs || []
          if (!songs.length) throw new Error('雷达模式暂时没有返回歌曲')
          // 雷达续页：播放中按 result.page（服务端返回的待取页）自动续拉下一批
          act.onPlaySongs(songs[0], songs, 0, {
            continuous: true,
            radar: { page: Number(result?.page) || 2, reqType: 0, entranceSongs: [] },
          })
          return
        }
        case 'play-songs': {
          const songs = card.songs || []
          if (!songs.length) throw new Error('这张卡片暂时没有可播放的歌曲')
          act.onPlaySongs(songs[0], songs, 0)
          return
        }
        case 'open-playlist': {
          // 每日30首走 PC 流的槽位（客户端也是打开这张歌单）
          if (card.subtype === 510 && daily30?.playlistId) {
            act.onOpenPlaylist({
              id: String(daily30.playlistId),
              name: daily30.title || card.title || '每日30首',
              coverUrl: daily30.coverUrl || card.coverUrl || card.songs?.[0]?.album?.picUrl || '',
              platform: 'qq' as const,
              source: 'qq-daily-30',
            })
            return
          }
          const playlist = qqCardPlaylist(card)
          if (!playlist) throw new Error('这张卡片暂时打不开')
          act.onOpenPlaylist(playlist)
          return
        }
        case 'open-preferences':
          act.onNavigate({ kind: 'qq', page: 'settings' })
          return
        default:
          return
      }
    } catch (error) {
      setNotice(error instanceof Error && error.message ? error.message : '暂时无法打开，请稍后再试')
    } finally {
      setBusyKey('')
    }
  }, [act, accountKey, daily30])

  /** 歌曲架点击/播放全部：按 id 批量补歌曲详情后从第 index 首开播（同一货架的歌连播）。 */
  const playModuleAt = useCallback(async (module: QQExploreModule, index: number) => {
    try {
      setNotice('')
      setBusyKey(`module:${module.instanceId}`)
      const songs = await prefetchQQModuleSongs(module)
      if (!songs.length) throw new Error('这个栏目暂时没有可播放的歌曲')
      const start = Math.max(0, Math.min(index, songs.length - 1))
      act.onPlaySongs(songs[start], songs, start)
    } catch (error) {
      setNotice(error instanceof Error && error.message ? error.message : '这个栏目暂时无法播放')
    } finally {
      setBusyKey('')
    }
  }, [act])

  const featureLabel = useCallback((card: QQExploreCard): { strip: { text: string; color: string } | null; caption: string; subtitle: string } => {
    // 每日30首：用 PC 流的真实文案 + 首曲（官方封面底部是英文标签条 Daily 30）
    if (card.subtype === 510) {
      const first = daily30?.songs?.[0]
      return {
        strip: CARD_STRIP_LABELS['每日30首'],
        caption: card.subtitle || (first ? `${first.name} - ${artistLine(first)}` : (daily30?.title || '每日30首')),
        subtitle: '每日30首',
      }
    }
    // 雷达卡（202/900/991）：feed 里 title 是「雷达模式」，官方客户端的界面名是「刷歌模式」
    // （与左栏「刷歌」同一功能），卡面第一行是当前刷到的那首歌，第二行是功能名。
    // 官方这张卡封面没有英文标签条（2026-10-07 截图核对），所以 strip 保持 null。
    if (card.subtype === 991) {
      const first = card.songs?.[0]
      return {
        strip: null,
        caption: card.subtitle || (first ? `${first.name} - ${artistLine(first)}` : ''),
        subtitle: '刷歌模式',
      }
    }
    const first = card.songs?.[0]
    const layerTitle = String((card as { layerTitle?: string }).layerTitle || '').trim()
    const title = layerTitle || card.title || ''
    return {
      // 标签优先用官方英文固定文案（Daily 30 / Favorites / New Songs…），服务端只有中文名时不硬编
      strip: CARD_STRIP_LABELS[title] || CARD_STRIP_LABELS[card.title || ''] || null,
      caption: card.subtitle || (first ? `${first.name} - ${artistLine(first)}` : (card.reason || '')),
      subtitle: title || card.reason || '',
    }
  }, [daily30])

  /** 卡片架（歌单/专辑/榜单）点击分发：与乐馆 QQPcHall 同口径，打不开的卡不装成按钮。 */
  const moduleCardAction = useCallback((card: QQExploreCard): (() => void) | null => {
    const action = card.action
    switch (action.type) {
      case 'open-playlist': {
        const playlist = qqCardPlaylist(card)
        return playlist ? () => act.onOpenPlaylist(playlist) : null
      }
      case 'open-chart':
        return act.onOpenChart ? () => act.onOpenChart?.({
          id: action.chartId,
          name: card.title || 'QQ 音乐榜单',
          group: '',
          coverUrl: card.coverUrl || '',
          platform: 'qq' as const,
          songs: [],
        }) : null
      case 'open-album':
        return act.onOpenAlbum ? () => act.onOpenAlbum?.(action.albumId, 'qq') : null
      case 'open-mv':
        return act.onOpenMv ? () => act.onOpenMv?.(action.mvId, 'qq') : null
      case 'play-songs':
        return card.songs.length ? () => act.onPlaySongs(card.songs[0], card.songs, 0) : null
      default:
        return null
    }
  }, [act])

  const hasHero = Boolean(promoCard || featureCards.length)
  const nothingAtAll = !loading && !hasHero && treasure.length === 0 && feedModules.length === 0

  if (!isLoggedIn && nothingAtAll) {
    return (
      <PcEmpty
        theme={theme}
        title="登录后解锁个性化推荐"
        description="QQ 音乐的推荐流需要登录态"
        action={<PcPrimaryButton label="立即登录" accent={accent} onClick={() => act.onLogin?.()} />}
      />
    )
  }
  if (nothingAtAll) {
    return <PcEmpty theme={theme} title="暂时没有可用的推荐内容" description="稍后再试，或到乐馆逛逛" />
  }

  return (
    <div className="pb-8">
      <div className="mb-5 flex items-center justify-between gap-3">
        <h1 className={`text-[22px] font-semibold tracking-tight ${theme.text}`}>
          {displayName ? `Hi ${displayName}` : 'Hi'} <span className="font-normal">今日为你推荐</span>
        </h1>
      </div>

      {notice ? <div className={`mb-4 rounded-lg px-3 py-2 text-[12px] ${theme.surface} ${theme.subtle}`}>{notice}</div> : null}

      {/* 首屏骨架：bootstrap 未回来且没有缓存时先把卡行占位画出来（避免整行空白、内容「突然弹出」） */}
      {!hasHero && loading && (
        <div className="mb-9 grid grid-cols-2 items-stretch gap-x-4 gap-y-5 lg:grid-cols-6" aria-busy="true" aria-label="正在加载推荐">
          <div className={`col-span-2 min-h-[172px] animate-pulse rounded-2xl ${theme.surface}`} />
          {[0, 1, 2, 3].map(index => (
            <div key={index} className="flex min-w-0 flex-col gap-2">
              <div className={`aspect-square w-full animate-pulse rounded-2xl ${theme.surface}`} />
              <div className={`h-3 w-3/4 animate-pulse rounded ${theme.surface}`} />
              <div className={`h-3 w-1/2 animate-pulse rounded ${theme.surface}`} />
            </div>
          ))}
        </div>
      )}

      {/* 卡行：两格宽主推大卡 + 四张一格彩色功能卡。
          官方这一行是**等高**的：所有卡片的封面同高，卡下统一两行小字（歌曲-歌手 / 栏目标签）。 */}
      {hasHero && (
        <div className="mb-9 grid grid-cols-2 items-stretch gap-x-4 gap-y-5 lg:grid-cols-6">
          {promoCard && (() => {
            // 官方大卡的两行文案全部来自服务端随电台批次下发的推荐语（模板里的 {br} 是客户端约定的换行标记）；
            // 只有服务端没给模板时才退回卡自带文案/固定文案——不编文案（2026-10-07 实测：
            // 官方那行「夜深了 / 尝试来点儿音乐提提神吧~」对应电台 99 的 reasons[i].reason + 模板字段）。
            const radioLine = (guessRadioMeta?.template || guessRadioMeta?.reason || '').replace(/\{br\}/g, ' ').trim()
            const captionLine = radioLine || promoCard.content || promoCard.subtitle || FALLBACK_RECOMMENDATION_LINE
            const previewCaption = songCaption(guessPreview)
            const cover = guessPreview?.album?.picUrl || promoCard.coverUrl || promoCard.songs?.[0]?.album?.picUrl
            const busy = busyKey === (promoCard.id || promoCard.title)
            // 官方大卡第一行是电台自己的名字（会换，如「放松吧」），卡下第二行才是 feed 的栏目名
            // （官方显示为「猜你喜欢·沉浸刷歌」——就是把栏目标题里的连接号换成中点）。
            const promoTitle = (guessRadioMeta?.name || '').trim() || promoCard.title || '猜你喜欢'
            const promoLabel = (promoCard.title || '').replace(/^猜你喜欢-/, '猜你喜欢·') || promoTitle
            const body = (
              <>
                <span className="flex min-w-0 flex-1 flex-col justify-between py-1 pr-1">
                  <span>
                    <span className="block truncate text-[22px] font-semibold leading-tight text-white xl:text-[26px]">{promoTitle}</span>
                    <span className="mt-2 line-clamp-2 block max-w-[15rem] text-[13px] leading-snug text-white/85">{captionLine}</span>
                  </span>
                  <span className="mt-3 flex h-11 w-11 items-center justify-center rounded-full" style={{ background: PROMO_PLAY_GREEN }}>
                    <Play className="h-5 w-5 fill-white text-white" />
                  </span>
                </span>
                {cover ? (
                  /* 封面限宽：官方大卡封面约占卡片 4 成，不给上限会把左侧文案挤成一字一行 */
                  <span className="relative hidden h-full w-auto max-w-[45%] shrink-0 self-stretch overflow-hidden rounded-xl sm:block">
                    <img src={cover} alt={guessPreview?.name || promoCard.title || '推荐封面'} draggable={false} className="h-full w-full object-cover" loading="eager" referrerPolicy="no-referrer" />
                  </span>
                ) : null}
              </>
            )
            const promoClassName = 'group col-span-2 flex min-h-0 flex-col text-left'
            return (
              <div key="promo" className={promoClassName}>
                {isActionableCard(promoCard) ? (
                  <button
                    type="button"
                    onClick={() => { void runCard(promoCard) }}
                    disabled={busy}
                    title="猜你喜欢"
                    className="flex min-h-0 flex-1 items-stretch justify-between gap-4 overflow-hidden rounded-2xl px-5 py-4 text-left transition hover:brightness-[1.03] disabled:opacity-80"
                    style={{ background: PROMO_GRADIENT }}
                  >
                    {body}
                  </button>
                ) : (
                  <div className="flex min-h-0 flex-1 items-stretch justify-between gap-4 overflow-hidden rounded-2xl px-5 py-4" style={{ background: PROMO_GRADIENT }} title="该内容只能在 QQ 音乐客户端中打开">
                    {body}
                  </div>
                )}
                <span className={`mt-2 block truncate text-[13px] ${theme.text}`}>{previewCaption || promoCard.subtitle || ''}</span>
                <span className={`mt-0.5 block truncate text-[12px] ${theme.subtle}`}>{promoLabel}</span>
              </div>
            )
          })()}

          {featureCards.map((card, index) => {
            const { strip, caption, subtitle } = featureLabel(card)
            const cover = card.coverUrl || card.songs?.[0]?.album?.picUrl
            const busy = busyKey === (card.id || card.title)
            const body = (
              <>
                <span className="relative block aspect-square w-full overflow-hidden rounded-2xl">
                  {cover
                    ? <img src={cover} alt={card.title || '推荐封面'} draggable={false} className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
                    : <span className={`flex h-full w-full items-center justify-center ${theme.surface}`}><Compass className={`h-6 w-6 ${theme.faint}`} /></span>}
                  {/* 官方：封面底部一条实色英文标签条（大写字 + 右侧装饰圆/方块，
                      装饰块绝对定位，不参与文字宽度分配，窄卡也不会把标签挤成省略号） */}
                  {strip ? (
                    <span className="absolute inset-x-0 bottom-0 flex h-[34%] items-center overflow-hidden px-3" style={{ background: strip.color }}>
                      <span aria-hidden="true" className="pointer-events-none absolute -bottom-4 -right-2 h-14 w-14 rounded-full" style={{ background: 'rgba(255,255,255,0.2)' }} />
                      <span aria-hidden="true" className="pointer-events-none absolute bottom-2 right-9 h-4 w-4 rounded-[3px]" style={{ background: 'rgba(255,255,255,0.16)' }} />
                      <span className="relative min-w-0 flex-1 truncate text-[19px] font-semibold leading-none text-white xl:text-[21px] 2xl:text-[24px]">{strip.text}</span>
                    </span>
                  ) : null}
                </span>
                <span className={`mt-2 block truncate text-[13px] ${theme.text}`}>{caption}</span>
                <span className={`mt-0.5 block truncate text-[12px] ${theme.subtle}`}>{subtitle}</span>
              </>
            )
            // action 落不进 runCard 的卡（如 open-album/open-external）：静态卡 + 提示，与乐馆口径一致
            if (!isActionableCard(card)) {
              return (
                <div
                  key={card.id || `${card.title}:${index}`}
                  className="flex min-w-0 flex-col text-left"
                  title="该内容只能在 QQ 音乐客户端中打开"
                >
                  {body}
                </div>
              )
            }
            return (
              <button
                key={card.id || `${card.title}:${index}`}
                type="button"
                onClick={() => { void runCard(card) }}
                disabled={busy}
                className="group flex min-w-0 flex-col text-left disabled:opacity-80"
              >
                {body}
              </button>
            )
          })}

        </div>
      )}

      {/* 你的歌单宝藏库。
          pcH5 推荐流(2026-10-07)已把官方同源的个性化「你的歌单宝藏库/补给站」作为货架(271)随 feed 下发，
          命中时这里的老「公开歌单广场」兜底块不再渲染，避免同一版面出现两份宝藏库。 */}
      {treasure.length > 0 && !modules.some(module => module.id === '271' || /宝藏库|补给站/.test(module.title)) && (
        <section>
          <PcSectionTitle title="你的歌单宝藏库" theme={theme} />
          <PcCardGrid
            items={treasure.map(item => ({
              key: item.key,
              coverUrl: item.coverUrl,
              title: item.subtitle ? `${item.title} | ${item.subtitle}` : item.title,
              playCount: item.playCount,
              onClick: () => act.onOpenPlaylist(item.playlist),
              onContextMenu: (event: ReactMouseEvent) => { event.preventDefault(); act.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist: item.playlist }) },
            }))}
            theme={theme}
            accent={accent}
            columns={6}
          />
        </section>
      )}

      {/* 推荐流其余货架：官方顺序原样渲染（听「X」的也在听 / 歌单遨游指南 / 幸运好歌…） */}
      {feedModules.map(module => {
        const kind = qqHomeModuleKind(module)
        const busy = busyKey === `module:${module.instanceId}`
        if (kind === 'songs') {
          return (
            <section key={module.instanceId} className="mt-9">
              <PcShelfTitle
                title={module.title}
                theme={theme}
                accent={accent}
                playAllDisabled={busy}
                onPlayAll={() => { void playModuleAt(module, 0) }}
              />
              <PcSongShelf
                module={module}
                theme={theme}
                accent={accent}
                limit={SONG_SHELF_LIMIT}
                currentSongKey={act.currentSongKey || ''}
                onPlayAt={(target, index) => { void playModuleAt(target, index) }}
                onSongMenu={(event, song, card) => {
                  // 歌曲详情还没补全时先补（右键菜单需要真实 mid/专辑），补不到就不弹假菜单
                  if (song) { act.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs: [song] }); return }
                  void prefetchQQModuleSongs(module).then(songs => {
                    const index = module.cards.findIndex(item => item.id === card.id)
                    const resolved = index >= 0 ? songs[index] : undefined
                    if (resolved) act.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song: resolved, songs })
                  })
                }}
              />
            </section>
          )
        }
        const items = module.cards.map((card, index) => {
          const run = moduleCardAction(card)
          return {
            key: `${module.instanceId}:${card.id}:${index}`,
            coverUrl: card.coverUrl || card.songs?.[0]?.album?.picUrl,
            title: card.title || '推荐内容',
            // 304 三曲组合卡没有副标题，官方卡面就是把三首歌名列出来（这里同样只列真实歌曲名）
            subtitle: card.subtitle || card.reason
              || (card.style === 304 && card.songs.length ? card.songs.slice(0, 3).map(song => song.name).join(' / ') : '')
              || undefined,
            playCount: qqCardPlayCount(card) ?? qqCountTextToNumber(card.countContent),
            onClick: run || undefined,
            onContextMenu: card.action.type === 'open-playlist'
              ? (event: ReactMouseEvent) => {
                event.preventDefault()
                const playlist = qqCardPlaylist(card)
                if (playlist) act.onPlaylistMenu?.({ show: true, x: event.clientX, y: event.clientY, playlist })
              }
              : undefined,
          }
        })
        // PcCardGrid 只渲染按钮：打不开的卡片（客户端专有）整块丢掉，不留死按钮
        const clickable = items.filter(item => item.onClick)
        if (!clickable.length) return null
        // 「昵称」的专属乐流这类货架的卡片带 twoColumn 标记：官方是**两列横向流**（封面在左、文字在右），
        // 不是六列网格——之前套六列会剩一行孤零零 2 张（2026-10-07 用户反馈），这里按官方版式走两列。
        const twoColumn = module.cards.some(card => card.twoColumn)
        return (
          <section key={module.instanceId} className="mt-9">
            <PcShelfTitle
              title={module.title}
              theme={theme}
              accent={accent}
              onPlayAll={undefined}
            />
            {twoColumn ? (
              <div className="grid grid-cols-1 gap-x-6 gap-y-1 md:grid-cols-2">
                {module.cards.filter(card => moduleCardAction(card)).map((card, index) => {
                  const run = moduleCardAction(card)
                  const cover = card.coverUrl || card.songs?.[0]?.album?.picUrl
                  const subtitle = card.subtitle || card.reason
                    || (card.style === 304 && card.songs.length ? card.songs.slice(0, 3).map(song => song.name).join(' / ') : '')
                    || card.songs?.[0]?.name || ''
                  return (
                    <button
                      key={`two:${module.instanceId}:${card.id}:${index}`}
                      type="button"
                      onClick={run || undefined}
                      className={`group flex w-full min-w-0 items-center gap-3 rounded-md px-2 py-1.5 text-left transition ${theme.hover}`}
                      title={card.title}
                    >
                      <PcCover src={cover} alt={card.title || '推荐内容'} className="h-14 w-14 shrink-0" rounded="rounded-[6px]" />
                      <span className="min-w-0 flex-1">
                        <span className={`block truncate text-[13px] ${theme.text}`}>{card.title || '推荐内容'}</span>
                        {subtitle ? <span className={`mt-0.5 block truncate text-[12px] ${theme.faint}`}>{subtitle}</span> : null}
                      </span>
                      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full opacity-0 transition group-hover:opacity-100" style={{ background: accent }}>
                        <Play className="h-3.5 w-3.5 fill-white text-white" />
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <PcCardGrid items={clickable} theme={theme} accent={accent} columns={6} />
            )}
          </section>
        )
      })}

      {loading && !hasHero && treasure.length === 0 ? <PcEmpty theme={theme} title="正在加载今日推荐…" /> : null}

    </div>
  )
}

export default memo(QQPcHome)
