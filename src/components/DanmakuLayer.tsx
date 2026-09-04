/**
 * B 站弹幕渲染层（canvas，覆盖在视频之上、控件之下）
 *
 * - 时间轴跟随视频 currentTime（音频时钟驱动的视频同步后自动对齐）
 * - 支持滚动/顶部/底部三种模式，轨道分配按活跃弹幕实时位置避免重叠
 * - 设置：不透明度/字号/显示区域/同屏上限/速度/模式开关/屏蔽词
 */

import { useEffect, useRef } from 'react'
import type { BilibiliDanmakuItem, DanmakuSettings } from '../services/bilibiliApi'

interface DanmakuLayerProps {
  items: BilibiliDanmakuItem[]
  settings: DanmakuSettings
  isPlaying: boolean
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** 弹幕时钟：默认 video.currentTime；看歌模式音画分离时传音频时间（视频可能未实际播放） */
  getTime?: () => number
}

interface ActiveDanmaku {
  text: string
  mode: number
  color: number
  fontSize: number
  x: number
  y: number
  vx: number
  width: number
  lane: number
  bornAt: number
  border?: boolean
}

const SCROLL_CROSS_SECONDS = 9 // 滚动弹幕横穿画布基准秒数（速度 1 时）
const FIXED_DURATION_MS = 4000 // 顶部/底部弹幕停留时长
const LANE_GAP = 6
// 高刷屏限 120fps：整层文本每帧重绘开销大，弹幕文字 120fps 与 240fps 肉眼无差异
const FRAME_MIN_INTERVAL_MS = 1000 / 120

export default function DanmakuLayer({ items, settings, isPlaying, videoRef, getTime }: DanmakuLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1

    const resize = () => {
      const rect = parent.getBoundingClientRect()
      canvas.width = Math.max(1, Math.floor(rect.width * dpr))
      canvas.height = Math.max(1, Math.floor(rect.height * dpr))
      canvas.style.width = `${rect.width}px`
      canvas.style.height = `${rect.height}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(parent)

    // 屏蔽词
    const shieldWords = settings.shieldKeywords.split(/[,，\s]+/).filter(Boolean)
    const filtered = items.filter((it) => !shieldWords.some((k) => it.text.includes(k)))

    const cssWidth = () => parent.getBoundingClientRect().width
    const cssHeight = () => parent.getBoundingClientRect().height
    const fontSizeAt = () => Math.max(12, Math.min(36, settings.fontSize * (cssWidth() / 1920)))
    const laneCountAt = () => {
      const h = cssHeight()
      const fs = fontSizeAt()
      return Math.max(1, Math.floor((h * settings.displayArea) / 100 / (fs + LANE_GAP)))
    }

    const active: ActiveDanmaku[] = []

    let raf = 0
    let spawnIndex = 0
    let lastTime = -1
    let lastFrame = -1

    const tick = (now: number) => {
      const video = videoRef.current
      // 传了音频时钟（看歌音画分离）时视频元素未就绪也能渲染；否则必须等视频
      if (!video && !getTime) {
        raf = requestAnimationFrame(tick)
        return
      }
      // 限 120fps：弹幕推进由音频时钟 dt 驱动，跳过的帧不影响位置正确性
      if (lastFrame >= 0 && now - lastFrame < FRAME_MIN_INTERVAL_MS) {
        raf = requestAnimationFrame(tick)
        return
      }
      lastFrame = now
      const w = cssWidth()
      const h = cssHeight()
      const fs = fontSizeAt()
      const laneCount = laneCountAt()
      ctx.clearRect(0, 0, w, h)

      const time = getTime ? getTime() : (video?.currentTime || 0)
      const alpha = Math.max(0, Math.min(1, settings.opacity / 100))
      // 推进量由时间钟驱动（音频时间前进 = 正在播放）：不依赖 isPlaying 状态——
      // 播放状态标记滞后/错位时，滚动弹幕在屏幕外 x=w 生成后永远不动，整层看似不显示
      const timeDelta = lastTime >= 0 ? time - lastTime : 0
      const effDt = timeDelta > 0 ? Math.min(0.1, timeDelta) : 0
      lastTime = time

      // 生成新弹幕：只渲染当前时间附近窗口内的（避免 seek/重挂载时把历史弹幕一次性灌入刷屏）
      const SPAWN_WINDOW_SECONDS = 8
      while (spawnIndex < filtered.length && filtered[spawnIndex].time <= time) {
        const item = filtered[spawnIndex]
        spawnIndex++
        // 距当前时间超过窗口的旧弹幕：消费但跳过渲染
        if (time - item.time > SPAWN_WINDOW_SECONDS) continue
        const mode = item.mode
        // 高级弹幕（mode>=7）：content 若是 JSON 命令（BAS/图片弹幕）跳过渲染；
        // 纯文本的高级弹幕按顶部弹幕展示
        if (mode >= 7) {
          const t = (item.text || '').trim()
          if (!t || t.startsWith('{') || t.startsWith('[')) continue
          if (!settings.showTop) continue
          if (active.length >= settings.maxOnScreen) continue
          ctx.font = `bold ${fs}px sans-serif`
          const width = ctx.measureText(item.text).width
          const lane = pickLane(false, 5, laneCount, active, w, width, fs + LANE_GAP)
          if (lane < 0) continue
          active.push({
            text: item.text,
            mode: 5,
            color: item.color,
            fontSize: fs,
            x: 0,
            y: lane * (fs + LANE_GAP),
            vx: 0,
            width,
            lane,
            bornAt: now,
          })
          continue
        }
        // 1/2/6 正向滚动、3 逆向滚动；4 底部；5 顶部
        const reverse = mode === 3 || mode === 6
        const isScroll = mode === 1 || mode === 2 || mode === 3 || mode === 6
        const isTop = mode === 5
        const isBottom = mode === 4
        if (!isScroll && !isTop && !isBottom) continue
        if (isScroll && !settings.showScroll) continue
        if (isTop && !settings.showTop) continue
        if (isBottom && !settings.showBottom) continue
        if (active.length >= settings.maxOnScreen) continue

        ctx.font = `bold ${fs}px sans-serif`
        const width = ctx.measureText(item.text).width
        const lane = pickLane(isScroll, mode, laneCount, active, w, width, fs + LANE_GAP)
        if (lane < 0) continue

        const y = isBottom
          ? h - (h * settings.displayArea) / 100 + (lane + 1) * (fs + LANE_GAP) - LANE_GAP
          : lane * (fs + LANE_GAP)
        active.push({
          text: item.text,
          mode,
          color: item.color,
          fontSize: fs,
          // 逆向滚动：从左侧进入向右移动；正向滚动：从右侧进入向左移动
          x: reverse ? -width : w,
          y,
          vx: isScroll ? (reverse ? (w + width) / (SCROLL_CROSS_SECONDS / settings.speed) : -((w + width) / (SCROLL_CROSS_SECONDS / settings.speed))) : 0,
          width,
          lane,
          bornAt: now,
          border: item.border,
        })
      }

      // 更新 + 绘制
      const nowAlive: ActiveDanmaku[] = []
      for (const a of active) {
        if (a.mode === 1 || a.mode === 2 || a.mode === 3 || a.mode === 6) {
          a.x += a.vx * effDt
          if (a.vx < 0 && a.x + a.width < -20) continue // 正向滚出屏幕
          if (a.vx > 0 && a.x > w + 20) continue // 逆向滚出屏幕
        } else {
          if (effDt > 0 && now - a.bornAt > FIXED_DURATION_MS) continue // 停留结束
        }
        ctx.font = `bold ${a.fontSize}px sans-serif`
        ctx.globalAlpha = alpha
        ctx.fillStyle = `#${a.color.toString(16).padStart(6, '0')}`
        if (a.border) {
          // 自己发的弹幕：白描边 + 底框突出
          ctx.strokeStyle = 'rgba(0,0,0,0.65)'
          ctx.lineWidth = 3
          ctx.strokeText(a.text, a.x, a.y + a.fontSize)
          ctx.strokeStyle = 'rgba(255,255,255,0.85)'
          ctx.lineWidth = 1.2
          ctx.strokeText(a.text, a.x, a.y + a.fontSize)
          ctx.fillText(a.text, a.x, a.y + a.fontSize)
        } else {
          ctx.fillText(a.text, a.x, a.y + a.fontSize)
        }
        nowAlive.push(a)
      }
      active.length = 0
      active.push(...nowAlive)
      ctx.globalAlpha = 1

      // 时间未推进（暂停）且无可见/待播弹幕时停帧；窗口隐藏时也停（Electron backgroundThrottling 关闭）
      const paused = effDt <= 0
      const hasVisible = active.length > 0 || spawnIndex < filtered.length
      if ((paused && !hasVisible) || document.visibilityState === 'hidden') {
        raf = 0
        return
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && raf === 0) raf = requestAnimationFrame(tick)
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      ro.disconnect()
    }
    // 依赖 items 引用：loadVideo 每次成功会替换新列表
  }, [items, settings, videoRef])

  return <canvas ref={canvasRef} className="absolute inset-0 pointer-events-none z-20" aria-hidden="true" />
}

/**
 * 选轨道：
 * - 顶部/底部：找一条当前没有同模式活跃弹幕的道
 * - 滚动：找一条"最右弹幕已让出足够空间"的道（按活跃弹幕实时 x 判断，避免只出几条后全部丢弃）
 */
function pickLane(
  isScroll: boolean,
  mode: number,
  laneCount: number,
  active: ActiveDanmaku[],
  canvasWidth: number,
  itemWidth: number,
  minLeading: number,
): number {
  if (!isScroll) {
    for (let i = 0; i < laneCount; i++) {
      const occupied = active.some((a) => a.lane === i && (a.mode === 4 || a.mode === 5))
      if (!occupied) return i
    }
    return -1
  }
  const laneRightmost = (lane: number): number => {
    let maxX = 0
    for (const a of active) {
      if ((a.mode === 1 || a.mode === 2 || a.mode === 3 || a.mode === 6) && a.lane === lane && Math.abs(a.x) > maxX) maxX = Math.abs(a.x)
    }
    return maxX
  }
  for (let i = 0; i < laneCount; i++) {
    const rightmost = laneRightmost(i)
    if (rightmost === 0 || rightmost < canvasWidth - itemWidth - minLeading) return i
  }
  return -1
}
