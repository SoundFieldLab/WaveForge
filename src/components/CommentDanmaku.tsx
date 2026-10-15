/**
 * 评论弹幕舞台（评论弹窗「总览」页）
 *
 * 把精彩评论铺成一条条横穿的弹幕：点击某条弹幕整幕暂停、该条被钉住，并在它旁边浮出
 * 点赞/回复面板；点击空白处恢复滚动，被钉住的弹幕从原地继续走。
 *
 * 实现要点（别改成「每帧 setState」的写法）：
 * - 弹幕位置推进不走 React state，rAF 里直接写 transform/opacity，整幕只在钉住、
 *   点赞等离散事件上重渲染
 * - 弹幕宽度按真实布局测量后才允许投放；轨道按「本轨道最右一条的右边缘已让出空间」
 *   判定，全幕恒定像素速度 → 同轨道内不会追尾，也不需要额外避让计算
 * - 弹幕池按轮询游标循环投放；池子比轨道少时允许同一条在其它轨道重复出现（避免空场）
 * - 弹幕 DOM 的 transform 只由引擎写，React 的 style prop 里不含 transform，
 *   否则点赞等重渲染会把位置重置回左上角
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { MessageCircle, Play, Trash2 } from 'lucide-react'
import CachedImage from './CachedImage'
import { formatCommentTime } from '../utils/commentFormat'
import { getReadableAccentColor } from '../utils/desktopAccentColor'

export interface DanmakuComment {
  commentId: string
  content: string
  user: { nickname: string; avatarUrl: string; userId?: string }
  time: number | string
  likedCount: number
  isLiked?: boolean
  isOwn?: boolean
  /** 精选热评：气泡加高亮描边和热标 */
  hot?: boolean
}

interface CommentDanmakuProps {
  comments: DanmakuComment[]
  /** 舞台背景：当前资源（歌曲/歌单）封面 */
  coverUrl: string
  playerTheme: 'light' | 'dark'
  accentColor: string
  /** 滚动速度倍率：0.5 / 1 / 1.5 / 2 */
  speed: number
  /** 弹幕外观：字号缩放 / 不透明度 / 昵称显示（设置面板持久化） */
  style?: { fontScale: number; opacity: number; showNickname: boolean }
  isLoggedIn: boolean
  /** 汽水评论无点赞/回复接口：行内操作退化为静态展示 */
  canInteract: boolean
  /** 是否需要登录后才能点赞/回复（用于按钮提示） */
  onLike: (comment: DanmakuComment) => void
  onReply: (comment: DanmakuComment) => void
  onDelete: (comment: DanmakuComment) => void
}

const BUBBLE_H = 38
const LANE_GAP = 12
const LANE_H = BUBBLE_H + LANE_GAP
const STAGE_PAD_Y = 22
/** 1x 时的恒定像素速度（px/s）：按「旧版 0.5x 的体感 = 新版 1x」整体减半（旧基准 120），
 *  1x=60px/s 时一条 200px 的弹幕约 23s 横穿 1400px 舞台，2x 正好对齐旧版 1x 的速度 */
const SPEED_BASE_PX = 30 // 0.5x 档也要能看清：整体减半（新 1x = 旧 0.5x）
/** 同轨道后车投放前，前车右边缘至少要离右边界这么远 */
const SPAWN_GAP = 56
/** 首屏预铺时，第一条与最后一条的右边缘在舞台宽度上的跨度（0.78 = 从最右一路铺到约 22% 处） */
const PRESEED_SPAN = 0.78
const MAX_ACTIVE_CAP = 14
const PANEL_W = 320
const PANEL_H = 196
/** 看门狗检查间隔：上一帧超过 400ms 没来就重启循环 */
const WATCHDOG_INTERVAL_MS = 500

interface LiveItem {
  comment: DanmakuComment
  el: HTMLDivElement | null
  width: number
  x: number
  y: number
  lane: number
  active: boolean
}

interface PinnedPanel {
  comment: DanmakuComment
  x: number
  y: number
}

export default function CommentDanmaku({
  comments,
  coverUrl,
  playerTheme,
  accentColor,
  speed,
  style,
  isLoggedIn,
  canInteract,
  onLike,
  onReply,
  onDelete,
}: CommentDanmakuProps) {
  const isDark = playerTheme === 'dark'
  const accent = useMemo(() => getReadableAccentColor(accentColor, '#ec4899'), [accentColor])

  const stageRef = useRef<HTMLDivElement>(null)
  const layerRef = useRef<HTMLDivElement>(null)
  const itemsRef = useRef<LiveItem[]>([])
  const sizeRef = useRef({ w: 0, h: 0 })
  const laneCountRef = useRef(1)
  const cursorRef = useRef(0)
  const seededRef = useRef(false)
  const pinnedIdRef = useRef<string | null>(null)
  const speedRef = useRef(speed)
  const rafRef = useRef(0)
  const lastTickAtRef = useRef(0)
  // 气泡元素表：ref 回调写入，引擎按 id 取。不放 React 的 style 里做透明度——
  // 透明度由引擎独占管理（见文件头注释），React 一旦也持有 opacity 就会在重渲染时把它抹回 0。
  const elMapRef = useRef(new Map<string, HTMLDivElement>())

  const [pinned, setPinned] = useState<PinnedPanel | null>(null)
  // 外观设置的不透明度：引擎所有显隐写入统一乘上它
  const styleOpacityRef = useRef(1)
  useEffect(() => { styleOpacityRef.current = style?.opacity ?? 1 }, [style?.opacity])

  useEffect(() => { speedRef.current = speed }, [speed])

  /**
   * 气泡挂载回调：必须是稳定引用，否则每次重渲染 React 都会先以 null 再以元素调用一遍，
   * 这里设置的初始隐藏态就会被反复打回。
   */
  const registerBubble = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const id = el.dataset.dmId
    if (!id) return
    elMapRef.current.set(id, el)
    // 初始态：藏在幕布右外侧（stage 是 overflow-hidden，等效于不可见），避免首帧闪在左上角
    el.style.opacity = '0'
    el.style.transform = `translate3d(${Math.max(sizeRef.current.w, 600) + 240}px,0,0)`
  }, [])

  /** 重新把 DOM 上的弹幕元素绑回引擎记录（池子变化/重挂载/元素被 React 换掉后调用） */
  const bindElements = useCallback(() => {
    const live = new Map<string, HTMLDivElement>()
    layerRef.current?.querySelectorAll<HTMLDivElement>('[data-dm-id]').forEach((el) => {
      const id = el.dataset.dmId
      if (id) live.set(id, el)
    })
    // 清掉已卸载的元素，避免 map 长期持有游离节点
    for (const id of Array.from(elMapRef.current.keys())) {
      if (!live.has(id)) elMapRef.current.delete(id)
    }
    for (const item of itemsRef.current) {
      const el = live.get(item.comment.commentId) ?? null
      if (el) elMapRef.current.set(item.comment.commentId, el)
      item.el = el
    }
  }, [])

  /** 整幕复位：清空在飞弹幕、隐藏所有气泡、解除钉住 */
  const resetStage = useCallback(() => {
    for (const item of itemsRef.current) {
      item.active = false
      item.lane = -1
      if (item.el) {
        item.el.style.opacity = '0'
        item.el.style.transform = `translate3d(${Math.max(sizeRef.current.w, 600) + 240}px,0,0)`
      }
    }
    cursorRef.current = 0
    seededRef.current = false
    pinnedIdRef.current = null
    setPinned(null)
  }, [])

  // 池子变化：重建引擎记录并复位（位置状态不适合跨池子复用）
  useEffect(() => {
    itemsRef.current = comments.map((comment) => ({
      comment,
      el: null,
      width: 0,
      x: 0,
      y: 0,
      lane: -1,
      active: false,
    }))
    bindElements()
    resetStage()
  }, [comments, bindElements, resetStage])

  // 舞台尺寸：ResizeObserver 是尺寸唯一真源；宽度明显变化时整幕重排，避免弹幕停在半空
  useEffect(() => {
    const stage = stageRef.current
    if (!stage) return
    const apply = () => {
      const rect = stage.getBoundingClientRect()
      const width = Math.max(0, rect.width)
      const height = Math.max(0, rect.height)
      const previous = sizeRef.current
      sizeRef.current = { w: width, h: height }
      laneCountRef.current = Math.max(1, Math.floor((height - STAGE_PAD_Y * 2) / LANE_H))
      if (previous.w > 0 && Math.abs(previous.w - width) / previous.w > 0.06) resetStage()
    }
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(stage)
    return () => ro.disconnect()
  }, [resetStage])

  // 引擎主循环：测量 → 推进 → 投放
  useEffect(() => {
    const laneY = (lane: number) => STAGE_PAD_Y + lane * LANE_H + (LANE_H - BUBBLE_H) / 2

    /**
     * 量不到宽度时的兜底估算：舞台不能因为个别气泡量不到就整幕不开演。
     * 只用于轨道让位判断，量到真值后会被覆盖。
     */
    const fallbackWidth = (item: LiveItem) => Math.min(560, 96 + item.comment.content.length * 15)

    /**
     * 逐帧补齐还没量到宽度的弹幕，返回仍未量到的条数。
     * 不做「全部量到才开演」——只要有一条量到就先铺开，其余在后续帧补量后由投放器接手，
     * 避免个别元素缺失时整幕永远不开演。
     */
    const measurePending = (items: LiveItem[]): number => {
      let pending = 0
      for (const item of items) {
        if (item.width > 0) continue
        if (item.el && item.el.isConnected) {
          const width = item.el.getBoundingClientRect().width
          if (width > 0) item.width = width
        }
        if (item.width <= 0) pending++
      }
      return pending
    }

    const place = (item: LiveItem, x: number, lane: number) => {
      item.active = true
      item.lane = lane
      item.x = x
      item.y = laneY(lane)
      if (!item.width || item.width <= 0) item.width = fallbackWidth(item)
      if (item.el) {
        item.el.style.transform = `translate3d(${item.x}px,${item.y}px,0)`
        item.el.style.opacity = String(styleOpacityRef.current)
      }
    }

    /** 找一条可以投放新弹幕的轨道：本轨道所有在飞弹幕右边缘都已让出足够空间 */
    const freeLane = (items: LiveItem[], stageWidth: number): number => {
      for (let lane = 0; lane < laneCountRef.current; lane++) {
        let busy = false
        for (const item of items) {
          if (!item.active || item.lane !== lane) continue
          if (item.x + item.width > stageWidth - SPAWN_GAP) {
            busy = true
            break
          }
        }
        if (!busy) return lane
      }
      return -1
    }

    const preseed = (items: LiveItem[], stageWidth: number) => {
      const laneCount = laneCountRef.current
      // 池子比轨道少时允许重复，但最多铺两轮，避免同一条霸屏
      const count = Math.min(laneCount, Math.max(items.length, 1) * 2)
      const allowDuplicate = items.length < laneCount
      // 阶梯按「右边缘」排布：直接按左边缘算会在舞台窄、气泡宽时被夹到同一条竖线上，
      // 越靠后的轨道越要往左压（左半截出画是弹幕流的常态），但不能让整条都出画。
      const step = count > 1 ? (stageWidth * PRESEED_SPAN) / (count - 1) : 0
      for (let index = 0; index < count; index++) {
        const item = items[allowDuplicate ? index % items.length : index]
        if (!item) continue
        const width = item.width > 0 ? item.width : fallbackWidth(item)
        if (item.width <= 0) item.width = width
        const rightEdge = Math.max(stageWidth * 0.22, stageWidth - index * step)
        place(item, rightEdge - width, index)
      }
      cursorRef.current = count % Math.max(1, items.length)
      seededRef.current = true
    }

    const spawn = (items: LiveItem[], stageWidth: number) => {
      const total = items.length
      if (!total) return
      const activeCount = items.reduce((sum, item) => (item.active ? sum + 1 : sum), 0)
      if (activeCount >= Math.min(laneCountRef.current, MAX_ACTIVE_CAP)) return
      let budget = 2
      let probe = 0
      while (budget > 0 && probe < total) {
        const candidate = items[cursorRef.current % total]
        cursorRef.current = (cursorRef.current + 1) % total
        probe++
        // active 候选一律跳过（含 allowDuplicate）：单元素模型下再次 place 同一条
        // 在飞弹幕 = 把它瞬移回右画外，小评论池（< 轨道数）时弹幕永远到不了左边缘、
        // 在右侧反复回跳，流完全失效。池小就接受空场（与 MAX_ACTIVE_CAP 克制一致）。
        if (candidate.active) continue
        if (candidate.el && !candidate.el.isConnected) {
          // 元素被 React 换掉了：重绑一次，避免一直往已卸载的节点上写样式
          bindElements()
        }
        if (!candidate.el && candidate.width <= 0) continue
        const lane = freeLane(items, stageWidth)
        if (lane < 0) return
        // 位移按轨道错开一点：否则同一帧投放的两条会在同一条竖线上排队，看着像列队
        place(candidate, stageWidth + 12 + (lane % 4) * 52, lane)
        budget--
      }
    }

    const tick = (now: number) => {
      const { w, h } = sizeRef.current
      const items = itemsRef.current
      // 空池/无尺寸：直接停帧（rAF 不自续），交给看门狗/可见性变化重新拉起——
      // 此前空池也会每帧自续 rAF，评论弹窗开着时白烧一帧
      if (!w || !h || !items.length) {
        lastTickAtRef.current = now
        rafRef.current = 0
        return
      }
      rafRef.current = requestAnimationFrame(tick)
      const last = lastTickAtRef.current
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
      lastTickAtRef.current = now
      if (!seededRef.current) {
        if (measurePending(items) >= items.length) return
        preseed(items, w)
      }
      if (dt <= 0) return
      // 钉住某条弹幕时整幕暂停：便于阅读与操作，点击空白处恢复
      if (pinnedIdRef.current !== null) return
      const step = SPEED_BASE_PX * speedRef.current * dt
      let needsRebind = false
      for (const item of items) {
        if (!item.active) continue
        if (!item.el) continue
        if (!item.el.isConnected) {
          // React 把节点换掉了：本帧先跳过，帧末统一重绑（下一帧会用新节点继续画）
          needsRebind = true
          item.el = null
          continue
        }
        // 轨道速度微差：近/中/远三档体感，画面更有层次（同轨内恒速，不会追尾）
        item.x -= step * (1 + ((item.lane % 3) - 1) * 0.12)
        if (item.x + item.width < -80) {
          item.active = false
          item.lane = -1
          item.el.style.opacity = '0'
          continue
        }
        item.el.style.transform = `translate3d(${item.x}px,${item.y}px,0)`
        // 在飞弹幕的可见性是引擎的唯一权威：任何把 opacity 打回 0 的情况（元素被重建、
        // 样式被外部改写）都在下一帧自愈，不再出现「有位置但全透明」的空幕。
        if (item.el.style.opacity !== String(styleOpacityRef.current)) item.el.style.opacity = String(styleOpacityRef.current)
      }
      if (needsRebind) bindElements()
      measurePending(items)
      spawn(items, w)
    }

    rafRef.current = requestAnimationFrame(tick)
    const onVisibility = () => {
      lastTickAtRef.current = 0
      if (document.visibilityState === 'visible' && rafRef.current === 0) {
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)
    // 看门狗：rAF 被外部取消、被节流到停摆、或元素被 React 换成新节点时，
    // 光靠 tick 自我重排无法恢复。这里定时检查「上一帧是否太久没来」，必要时重启循环。
    const watchdog = window.setInterval(() => {
      const stale = performance.now() - lastTickAtRef.current > 400
      if (!stale) return
      lastTickAtRef.current = 0
      bindElements()
      if (!sizeRef.current.w || !sizeRef.current.h) {
        const rect = stageRef.current?.getBoundingClientRect()
        if (rect && rect.width > 0 && rect.height > 0) {
          sizeRef.current = { w: rect.width, h: rect.height }
          laneCountRef.current = Math.max(1, Math.floor((rect.height - STAGE_PAD_Y * 2) / LANE_H))
        }
      }
      cancelAnimationFrame(rafRef.current)
      rafRef.current = requestAnimationFrame(tick)
    }, WATCHDOG_INTERVAL_MS)
    return () => {
      cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
      lastTickAtRef.current = 0
      window.clearInterval(watchdog)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [bindElements])

  const unpin = useCallback(() => {
    if (pinnedIdRef.current === null) return
    pinnedIdRef.current = null
    setPinned(null)
  }, [])

  // 点赞/删除后评论对象会被替换：钉住面板要跟着换新对象，评论被删掉则自动收起
  useEffect(() => {
    if (!pinned) return
    const fresh = comments.find((comment) => comment.commentId === pinned.comment.commentId)
    if (!fresh) {
      unpin()
      return
    }
    if (fresh !== pinned.comment) setPinned((previous) => (previous ? { ...previous, comment: fresh } : previous))
  }, [comments, pinned, unpin])

  const handlePin = useCallback((comment: DanmakuComment) => {
    if (pinnedIdRef.current === comment.commentId) return
    const item = itemsRef.current.find((entry) => entry.comment.commentId === comment.commentId)
    const { w, h } = sizeRef.current
    if (!item || !item.el || !w || !h) return
    pinnedIdRef.current = comment.commentId
    const x = Math.min(Math.max(12, item.x), Math.max(12, w - PANEL_W - 12))
    const below = item.y + BUBBLE_H + 12
    const y = below + PANEL_H <= h - 12 ? below : Math.max(12, item.y - PANEL_H - 12)
    setPinned({ comment: item.comment, x, y })
  }, [])

  // 钉住时 ESC 先解除钉住（阻止继续冒泡，避免把整个评论弹窗一起关掉）
  useEffect(() => {
    if (!pinned) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopImmediatePropagation()
      unpin()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [pinned, unpin])

  const bubbleClass = isDark
    ? 'bg-[rgba(12,12,18,0.6)] hover:bg-[rgba(26,26,36,0.78)] border-white/15'
    : 'bg-[rgba(255,255,255,0.9)] hover:bg-white border-black/6'
  const bubbleText = isDark ? 'text-white/92' : 'text-[rgba(18,18,24,0.9)]'
  const bubbleShadow = isDark ? '0 6px 18px rgba(0,0,0,0.38)' : '0 6px 18px rgba(15,15,30,0.12)'
  // 外观设置：字号缩放 / 不透明度 / 昵称显示
  const fontScale = style?.fontScale ?? 1
  const bubbleOpacity = style?.opacity ?? 1
  const showNickname = style?.showNickname ?? true
  // 高赞字号分级：赞越多字越大（万赞 15px / 千赞 14px / 普通 13px）
  const contentFontSize = (liked: number) => (liked >= 10000 ? 15 : liked >= 999 ? 14 : 13) * fontScale

  return (
    <div
      ref={stageRef}
      className="relative h-full w-full overflow-hidden"
      onClick={unpin}
      role="presentation"
    >
      {/* 封面背景：弹幕舞台比弹窗本体更清晰，让用户一眼看出是哪首歌 */}
      {coverUrl && (
        <div
          className="absolute -inset-6"
          aria-hidden="true"
          style={{
            backgroundImage: `url(${coverUrl})`,
            backgroundSize: 'cover',
            backgroundPosition: 'center',
            filter: isDark ? 'blur(18px) saturate(1.45) brightness(0.74)' : 'blur(18px) saturate(1.25) brightness(1.05)',
          }}
        />
      )}
      <div
        className="absolute inset-0"
        aria-hidden="true"
        style={{
          background: isDark
            ? 'linear-gradient(180deg, rgba(8,8,14,0.3) 0%, rgba(6,6,11,0.52) 100%)'
            : 'linear-gradient(180deg, rgba(255,255,255,0.3) 0%, rgba(248,248,246,0.58) 100%)',
        }}
      />

      {/* 弹幕层：容器不接事件，只有气泡本身可点，空白处即舞台本身。
          左右 8% 渐隐遮罩：弹幕从边缘自然浮现/退场，不再生硬穿帮 */}
      <style>{`
        .danmaku-layer-fade {
          -webkit-mask-image: linear-gradient(90deg, transparent 0%, #000 7%, #000 93%, transparent 100%);
          mask-image: linear-gradient(90deg, transparent 0%, #000 7%, #000 93%, transparent 100%);
        }
      `}</style>
      <div ref={layerRef} className="danmaku-layer-fade absolute inset-0" style={{ pointerEvents: 'none' }}>
        {comments.map((comment) => {
          const isPinnedBubble = pinned?.comment.commentId === comment.commentId
          return (
            <div
              key={comment.commentId}
              data-dm-id={comment.commentId}
              ref={registerBubble}
              onClick={(event) => {
                event.stopPropagation()
                handlePin(comment)
              }}
              className={`absolute left-0 top-0 flex cursor-pointer items-center gap-2 rounded-full border py-[3px] pl-1.5 pr-3.5 will-change-transform ${
                isPinnedBubble ? '' : bubbleClass
              }`}
              style={{
                width: 'max-content',
                maxWidth: 'min(560px, 52vw)',
                pointerEvents: 'auto',
                // 透明度不在这里声明：它由引擎逐帧接管（初始隐藏态在 registerBubble 里设），
                // 一旦 React 也持有 opacity，重渲染就会把在飞弹幕打回全透明。
                transition: 'opacity 420ms ease, background-color 160ms ease',
                background: isPinnedBubble ? (isDark ? 'rgba(255,255,255,0.16)' : 'rgba(255,255,255,0.98)') : undefined,
                // 外观设置的不透明度与引擎的显隐透明度叠加：引擎写 style.opacity（显隐），
                // 这里用 CSS 变量承载设置值，引擎透明度 = 显隐 × 设置值（在 tick 里合成）
                borderColor: isPinnedBubble || comment.isOwn || comment.hot ? accent : undefined,
                boxShadow: isPinnedBubble
                  ? `0 0 0 2px ${accent}, ${bubbleShadow}`
                  : comment.isOwn || comment.hot
                    ? `0 0 0 1px ${accent}, ${bubbleShadow}`
                    : bubbleShadow,
              }}
            >
              {comment.user.avatarUrl ? (
                <CachedImage
                  src={comment.user.avatarUrl}
                  alt={comment.user.nickname}
                  className="h-[24px] w-[24px] shrink-0 rounded-full object-cover"
                  role="row"
                  size={48}
                  priority="visible"
                />
              ) : (
                <span className="h-[24px] w-[24px] shrink-0 rounded-full opacity-70" style={{ background: accent }} />
              )}
              {comment.hot && (
                <span
                  className="shrink-0 rounded-full px-1 text-[9px] font-bold leading-[14px]"
                  style={{ background: `${accent}26`, color: accent }}
                  title="精选热评"
                >
                  热
                </span>
              )}
              {showNickname && (
                <span className="shrink-0 text-[13px] font-semibold" style={{ color: accent, fontSize: 13 * fontScale }}>
                  {comment.user.nickname}
                </span>
              )}
              <span
                className={`truncate ${bubbleText}`}
                style={{ fontSize: contentFontSize(comment.likedCount) }}
                onDoubleClick={(event) => {
                  // 双击弹幕直接点赞（不用先钉住）：动效与状态由点赞回调处理
                  event.stopPropagation()
                  onLike(comment)
                }}
                title="双击点赞 · 单击查看操作"
              >
                {comment.content}
              </span>
            </div>
          )
        })}
      </div>

      {/* 舞台信息条：只在整幕暂停时出提示（弹幕池数量角标已移除，没有信息量） */}
      <div className="pointer-events-none absolute left-4 top-4 flex items-center gap-2">
        {pinned && (
          <span
            className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px]"
            style={{ borderColor: accent, background: isDark ? 'rgba(0,0,0,0.45)' : 'rgba(255,255,255,0.86)', color: accent }}
          >
            <Play className="h-3 w-3 rotate-90" />
            已暂停 · 点击空白处继续
          </span>
        )}
      </div>

      {/* 底部操作提示 */}
      <div
        className={`pointer-events-none absolute bottom-4 left-4 text-[11px] ${
          isDark ? 'text-white/45' : 'text-black/40'
        }`}
      >
        点击弹幕可暂停并点赞 / 回复 · 点击空白处继续滚动
      </div>

      {/* 钉住的弹幕详情面板 */}
      <AnimatePresence>
        {pinned && (
          <motion.div
            key={pinned.comment.commentId}
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.97 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className={`absolute z-30 w-[320px] rounded-2xl border p-3.5 ${
              isDark ? 'border-white/12 text-white' : 'border-black/8 text-[rgba(18,18,24,0.92)]'
            }`}
            style={{
              left: pinned.x,
              top: pinned.y,
              background: isDark ? 'rgba(14,14,20,0.96)' : 'rgba(255,255,255,0.98)',
              boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
            }}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start gap-2.5">
              {pinned.comment.user.avatarUrl ? (
                <CachedImage
                  src={pinned.comment.user.avatarUrl}
                  alt={pinned.comment.user.nickname}
                  className="h-9 w-9 shrink-0 rounded-full object-cover"
                  role="row"
                  size={64}
                  priority="critical"
                />
              ) : (
                <span className="h-9 w-9 shrink-0 rounded-full opacity-70" style={{ background: accent }} />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-semibold" style={{ color: accent }}>
                    {pinned.comment.user.nickname}
                  </span>
                  {pinned.comment.isOwn && (
                    <span
                      className="shrink-0 rounded-full px-1.5 py-[1px] text-[10px]"
                      style={{ background: `${accent}22`, color: accent }}
                    >
                      我
                    </span>
                  )}
                </div>
                <div className={`text-[11px] ${isDark ? 'text-white/45' : 'text-black/40'}`}>
                  {formatCommentTime(pinned.comment.time)}
                </div>
              </div>
            </div>

            <div
              className={`custom-scrollbar mt-2.5 max-h-[132px] overflow-y-auto whitespace-pre-wrap break-words text-[13.5px] leading-6 ${
                isDark ? 'text-white/90' : 'text-[rgba(18,18,24,0.88)]'
              }`}
            >
              {pinned.comment.content}
            </div>

            <div className={`mt-3 flex items-center gap-1 border-t pt-2.5 ${isDark ? 'border-white/10' : 'border-black/6'}`}>
              <button
                type="button"
                onClick={() => (canInteract ? onLike(pinned.comment) : undefined)}
                disabled={!canInteract}
                className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs transition-colors disabled:cursor-default ${
                  pinned.comment.isLiked
                    ? ''
                    : isDark
                      ? 'text-white/60 hover:bg-white/10 hover:text-white'
                      : 'text-black/55 hover:bg-black/5 hover:text-black/80'
                }`}
                style={pinned.comment.isLiked ? { color: accent, background: `${accent}1f` } : undefined}
              >
                <ThumbsUpIcon filled={Boolean(pinned.comment.isLiked)} />
                <span>{pinned.comment.likedCount > 0 ? pinned.comment.likedCount : '赞'}</span>
              </button>

              {isLoggedIn && canInteract && (
                <button
                  type="button"
                  onClick={() => onReply(pinned.comment)}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs transition-colors ${
                    isDark ? 'text-white/60 hover:bg-white/10 hover:text-white' : 'text-black/55 hover:bg-black/5 hover:text-black/80'
                  }`}
                >
                  <MessageCircle className="h-3.5 w-3.5" />
                  <span>回复</span>
                </button>
              )}

              {pinned.comment.isOwn && isLoggedIn && canInteract && (
                <button
                  type="button"
                  onClick={() => onDelete(pinned.comment)}
                  className={`flex items-center gap-1.5 rounded-full px-2.5 py-1.5 text-xs transition-colors ${
                    isDark ? 'text-white/60 hover:bg-white/10 hover:text-red-300' : 'text-black/55 hover:bg-black/5 hover:text-red-500'
                  }`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  <span>删除</span>
                </button>
              )}

              <button
                type="button"
                onClick={unpin}
                className={`ml-auto rounded-full px-2.5 py-1.5 text-xs transition-colors ${
                  isDark ? 'text-white/45 hover:bg-white/10 hover:text-white' : 'text-black/40 hover:bg-black/5 hover:text-black/70'
                }`}
              >
                继续滚动
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 空场提示：封面背景照常展示，不留黑屏 */}
      {comments.length === 0 && (
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-1.5">
          <div className={`text-sm font-medium ${isDark ? 'text-white/80' : 'text-black/70'}`}>这首歌还没有精彩评论</div>
          <div className={`text-xs ${isDark ? 'text-white/50' : 'text-black/45'}`}>在左侧输入框发表第一条评论吧</div>
        </div>
      )}
    </div>
  )
}

/** 点赞图标：选中态实心（弹幕面板与列表共用同一套视觉） */
function ThumbsUpIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      className="h-3.5 w-3.5"
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M7 10v12" />
      <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
    </svg>
  )
}
