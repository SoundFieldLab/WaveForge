/**
 * 全局成就弹窗（Minecraft 风格进度/挑战弹窗）：
 *  - 普通：「进度已达成！」金黄色标题（图1 金色）
 *  - 史诗：「挑战已完成！」紫色标题（图1 紫色）
 * 弹出：右上角右侧向左滑入，常驻 5 秒后缩回。
 * 层级 z-[99990]——高于一切业务弹层。
 *
 * MC 砖块质感（对照原版进度弹窗截图）：
 *  - 整体深灰底 #313033，硬直角无圆角；
 *  - 双向斜面边框：左上亮（#f0f0f0 高光）/ 右下暗（#000000 阴影），阶梯式；
 *  - 图标槽：方形内嵌槽位，斜面方向与外框相反（凹陷感）；
 *  - 标题行带 MC 字体阴影（右下 2px 实色阴影，非模糊 glow）。
 *
 * 音效（实录提取，已响度归一 + 裁静音）：
 *  - slide-in.m4a 卡片弹出 / slide-out.m4a 卡片缩回
 *  - pop-normal.m4a 普通成就接播 / pop-epic.m4a 史诗接播
 * 音量策略：跟随软件本体音量（localStorage waveforge:volume）；低于 80% 抬到 80%。
 */
import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { AnimatePresence, motion } from 'framer-motion'
import { getAchievementDef, type AchievementDef } from './core'
import { AchievementIcon } from './icons'
import slideInSfx from '../assets/achievements/slide-in.m4a'
import slideOutSfx from '../assets/achievements/slide-out.m4a'
import popNormalSfx from '../assets/achievements/pop-normal.m4a'
import popEpicSfx from '../assets/achievements/pop-epic.m4a'

const TOAST_EVENT = 'waveforge:achievement-toast'
const VOLUME_KEY = 'waveforge:volume'
const BASE_VOLUME = 0.8

export interface ToastPayload {
  id: string
  at: number
}

/** 成就音效音量：本体音量低于 80% 时抬到 80%，否则跟随 */
function readSfxVolume(): number {
  try {
    const saved = parseFloat(localStorage.getItem(VOLUME_KEY) || '')
    const appVolume = Number.isFinite(saved) && saved >= 0 && saved <= 1 ? saved : 1
    return Math.max(appVolume, BASE_VOLUME)
  } catch {
    return BASE_VOLUME
  }
}

function playSfx(url: string, delayMs = 0): HTMLAudioElement {
  const audio = new Audio(url)
  audio.volume = readSfxVolume()
  audio.setAttribute('data-achievement-sfx', '')
  audio.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none'
  document.body.appendChild(audio)
  const play = () => { void audio.play().catch(() => { /* 自动播放拦截时静默 */ }) }
  if (delayMs > 0) window.setTimeout(play, delayMs)
  else play()
  audio.addEventListener('ended', () => audio.remove())
  return audio
}

/* ── 模块级弹窗队列（全局单实例消费）── */
let queue: ToastPayload[] = []
let busy = false
export function notifyAchievement(id: string): void {
  if (!getAchievementDef(id)) return
  queue = [...queue, { id, at: Date.now() }].slice(-4)
  window.dispatchEvent(new CustomEvent(TOAST_EVENT))
}

/** 弹窗常驻时长 */
const HOLD_MS = 5000

/* ── MC 砖块视觉常量（对照原版 UI 配色）── */
const MC = {
  /** 面板底色（原版深灰砖） */
  bg: '#313033',
  /** 外凸斜面：左/上高光，右/下阴影 */
  bevelLight: '#565559',
  bevelLightOuter: '#f2f2f2',
  bevelDark: '#212023',
  bevelDarkOuter: '#000000',
  /** 图标槽内凹底色 */
  slotBg: '#1e1d20',
}

/** MC 双层斜面边框（外圈亮暗分明 + 内圈过渡，硬直角） */
function mcBevelStyle(isEpic: boolean): React.CSSProperties {
  const outer = isEpic ? '#7b4fd0' : MC.bevelLightOuter
  const outerDark = isEpic ? '#3a1f66' : MC.bevelDarkOuter
  return {
    background: MC.bg,
    borderStyle: 'solid',
    borderWidth: 4,
    // MC 立体感：上左亮、下右暗
    borderTopColor: outer,
    borderLeftColor: outer,
    borderRightColor: outerDark,
    borderBottomColor: outerDark,
  }
}

export function AchievementToastLayer() {
  const [current, setCurrent] = useState<ToastPayload | null>(null)
  const currentRef = useRef<ToastPayload | null>(null)
  currentRef.current = current

  const pump = useCallback(() => {
    if (busy) return
    const next = queue[0]
    if (!next) return
    busy = true
    queue = queue.slice(1)
    setCurrent(next)
    playSfx(slideInSfx)
    const def = getAchievementDef(next.id)
    // 卡片弹出后接播等级音效（史诗 / 普通）
    if (def) playSfx(def.tier === 'epic' ? popEpicSfx : popNormalSfx, 320)
    window.setTimeout(() => {
      setCurrent(null)
      playSfx(slideOutSfx)
      window.setTimeout(() => {
        busy = false
        window.dispatchEvent(new CustomEvent(TOAST_EVENT))
      }, 420)
    }, HOLD_MS)
  }, [])

  useEffect(() => {
    window.addEventListener(TOAST_EVENT, pump)
    pump()
    return () => window.removeEventListener(TOAST_EVENT, pump)
  }, [pump])

  const def: AchievementDef | undefined = current ? getAchievementDef(current.id) : undefined
  if (!def || !current) return createPortal(<></>, document.body)

  const isEpic = def.tier === 'epic'
  const cardWidth = Math.min(460, Math.max(300, Math.round(window.innerWidth * 0.3)))
  const titleColor = isEpic ? '#c77dff' : '#ffd83d'
  const titleShadow = isEpic ? '2px 2px 0 #2a1245' : '2px 2px 0 #3a3000'

  return createPortal(
    <div className="pointer-events-none fixed right-0 top-[calc(env(safe-area-inset-top,0px)+12px)] z-[99990]">
      <AnimatePresence>
        <motion.div
          key={current.id + String(current.at)}
          initial={{ x: '110%', opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '110%', opacity: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26, mass: 0.9 }}
          className="pointer-events-auto mr-3"
          style={{
            width: cardWidth,
            borderRadius: 0, // MC 硬直角
            ...mcBevelStyle(isEpic),
            boxShadow: isEpic
              ? '0 0 0 1px rgba(199,125,255,0.35), 0 6px 20px rgba(0,0,0,0.5)'
              : '0 6px 20px rgba(0,0,0,0.5)',
          }}
        >
          <div
            className="flex items-center gap-3 px-3 py-2.5"
            style={{ boxShadow: 'inset 2px 2px 0 rgba(255,255,255,0.06), inset -2px -2px 0 rgba(0,0,0,0.35)' }}
          >
            {/* 图标槽：内凹斜面（与外框方向相反） */}
            <span
              className="flex shrink-0 items-center justify-center"
              style={{
                width: 44, height: 44,
                background: MC.slotBg,
                borderStyle: 'solid',
                borderWidth: 3,
                borderTopColor: MC.bevelDarkOuter,
                borderLeftColor: MC.bevelDarkOuter,
                borderRightColor: isEpic ? '#7b4fd0' : '#8a8a8a',
                borderBottomColor: isEpic ? '#7b4fd0' : '#8a8a8a',
              }}
            >
              <AchievementIcon icon={def.icon} unlocked tier={def.tier} size={26} style={{ borderRadius: 0, border: 'none', background: 'none', width: 'auto', height: 'auto' }} />
            </span>
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-[16px] font-extrabold leading-tight tracking-wide"
                style={{
                  color: titleColor,
                  textShadow: titleShadow,
                  fontFamily: "'ZCOOL KuaiLe', 'Fusion Pixel zh-hans', 'Segoe UI', monospace",
                }}
              >
                {def.title}
              </p>
              <p
                className="mt-0.5 truncate text-[13px] font-semibold leading-tight text-white"
                style={{ textShadow: '1.5px 1.5px 0 #000', fontFamily: "'ZCOOL KuaiLe', 'Fusion Pixel zh-hans', 'Segoe UI', monospace" }}
              >
                {def.name}
              </p>
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>,
    document.body,
  )
}
