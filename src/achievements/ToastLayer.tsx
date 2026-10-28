/**
 * 全局成就弹窗（Minecraft 风格进度/挑战弹窗）：
 *  - 普通：「进度已达成！」金绿色标题（MC advancement 绿）
 *  - 史诗：「挑战已完成！」紫色标题
 * 弹出：右上角右侧向左滑入（DPI 自适应：尺寸随 devicePixelRatio/视口缩放），
 * 常驻 5 秒后缩回。层级 z-[99990]——高于一切业务弹层（含 OOBE z-10000、模式面板 z-50）。
 *
 * 音效（实录提取，已响度归一 + 裁静音）：
 *  - slide-in.m4a   卡片弹出
 *  - slide-out.m4a  卡片缩回
 *  - pop-normal.m4a 普通成就卡片弹出后接播
 *  - pop-epic.m4a   史诗成就卡片弹出后接播
 * 音量策略：跟随软件本体音量（localStorage waveforge:volume）；
 * 本体音量 < 80% 时成就音效固定按 80% 播（实录素材响度不稳，保证可闻）。
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
  // DPI / 分辨率自适应：以 16px 视口高为基准的缩放（小屏缩小、高分屏保持 CSS 像素一致即可，
  // 浏览器缩放由 rem/vh 单位天然跟随），卡宽下限 300 上限 460
  const cardWidth = Math.min(460, Math.max(300, Math.round(window.innerWidth * 0.3)))

  return createPortal(
    <div className="pointer-events-none fixed right-0 top-[calc(env(safe-area-inset-top,0px)+12px)] z-[99990]">
      <AnimatePresence>
        <motion.div
          key={current.id + String(current.at)}
          initial={{ x: '110%', opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: '110%', opacity: 0 }}
          transition={{ type: 'spring', stiffness: 260, damping: 26, mass: 0.9 }}
          className="pointer-events-auto mr-3 overflow-hidden rounded-xl"
          style={{
            width: cardWidth,
            border: isEpic ? '2px solid rgba(199,125,255,0.55)' : '2px solid rgba(255,255,255,0.18)',
            background: isEpic
              ? 'linear-gradient(120deg, rgba(30,18,48,0.97), rgba(16,10,28,0.97))'
              : 'linear-gradient(120deg, rgba(24,26,30,0.97), rgba(14,15,18,0.97))',
            boxShadow: isEpic
              ? '0 8px 30px rgba(0,0,0,0.55), 0 0 22px rgba(160,90,255,0.35), inset 0 1px 0 rgba(255,255,255,0.08)'
              : '0 8px 30px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.08)',
          }}
        >
          <div className="flex items-center gap-3.5 px-4 py-3.5">
            <AchievementIcon icon={def.icon} unlocked tier={def.tier} size={30} />
            <div className="min-w-0 flex-1">
              <p
                className="truncate text-[17px] font-extrabold leading-tight tracking-wide"
                style={{
                  color: isEpic ? '#d18aff' : '#54fb54',
                  textShadow: isEpic ? '0 0 14px rgba(180,100,255,0.5)' : '0 0 12px rgba(84,251,84,0.35)',
                }}
              >
                {def.title}
              </p>
              <p className="mt-1 truncate text-[14px] font-semibold leading-tight text-white/90">
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
