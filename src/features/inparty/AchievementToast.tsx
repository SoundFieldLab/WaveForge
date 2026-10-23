/**
 * In Party 成就弹窗（Minecraft 风格）：
 *  - 普通：「进度已达成！」黄字 + 木箱风格图标框 + 灰像素边框
 *  - 史诗：「挑战已完成！」紫字 + 附魔紫光边框
 * 右上角滑入，3.5s 后滑出；队列排队逐个展示。
 * 像素感：硬边框 4px 阶梯灰、image-rendering pixelated、无圆角。
 */
import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ACHIEVEMENT_MAP, displayDef, type AchievementTier } from './achievements'

export interface AchievementPopup {
  id: string
  at: number
}

/** MC 像素风边框（双层：外深内浅，硬直角） */
function McFrame({ tier, children }: { tier: AchievementTier; children: React.ReactNode }) {
  const outer = tier === 'epic' ? '#2a1a3a' : '#1a1a1a'
  const edge = tier === 'epic' ? '#7a4fb0' : '#4a4a4a'
  const inner = tier === 'epic' ? '#3a2450' : '#262626'
  return (
    <div
      className="pointer-events-auto"
      style={{
        border: '4px solid',
        borderColor: `${edge} ${outer} ${outer} ${edge}`, // 上左亮、下右暗（MC 立体感）
        background: inner,
        boxShadow: tier === 'epic'
          ? '0 0 0 2px #b064e0, 0 0 18px rgba(176,100,224,0.55), inset 0 0 14px rgba(176,100,224,0.25)'
          : '0 0 0 2px #6a6a6a, 0 4px 12px rgba(0,0,0,0.6)',
      }}
    >
      {children}
    </div>
  )
}

/** 图标框（像素 emoji，MC 物品栏风） */
function McIcon({ icon, tier }: { icon: string; tier: AchievementTier }) {
  return (
    <span
      className="flex h-11 w-11 shrink-0 items-center justify-center text-[26px]"
      style={{
        border: '3px solid',
        borderColor: '#111 #555 #555 #111',
        background: tier === 'epic'
          ? 'linear-gradient(135deg,#3a2060,#1a1030)'
          : 'linear-gradient(135deg,#8a6a3a,#5a4525)',
        imageRendering: 'pixelated',
      }}
    >
      {icon}
    </span>
  )
}

/** 成就弹窗队列（全局挂一个实例） */
let queue: AchievementPopup[] = []
let notifying = false
const QUEUE_EVENT = 'waveforge:inparty-achievement-toast'

/** 入队（session/UI 任意处调用） */
export function notifyAchievement(id: string): void {
  if (!ACHIEVEMENT_MAP.has(id)) return
  queue = [...queue, { id, at: Date.now() }].slice(-4)
  window.dispatchEvent(new CustomEvent(QUEUE_EVENT))
}

export function AchievementToastLayer() {
  const [current, setCurrent] = useState<AchievementPopup | null>(null)

  useEffect(() => {
    const pump = () => {
      if (notifying) return
      const next = queue[0]
      if (!next) return
      notifying = true
      queue = queue.slice(1)
      setCurrent(next)
      window.setTimeout(() => {
        setCurrent(null)
        window.setTimeout(() => { notifying = false; window.dispatchEvent(new CustomEvent(QUEUE_EVENT)) }, 350)
      }, 3500)
    }
    window.addEventListener(QUEUE_EVENT, pump)
    pump()
    return () => window.removeEventListener(QUEUE_EVENT, pump)
  }, [])

  const def = current ? ACHIEVEMENT_MAP.get(current.id) : null
  const shown = def ? displayDef(def, true) : null

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[120] flex flex-col items-end gap-2">
      <AnimatePresence>
        {shown && (
          <motion.div
            key={current!.id + String(current!.at)}
            initial={{ x: 380, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 380, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30 }}
          >
            <McFrame tier={shown.tier}>
              <div className="flex items-center gap-3 px-3 py-2.5" style={{ minWidth: 280 }}>
                <McIcon icon={shown.icon} tier={shown.tier} />
                <div className="min-w-0">
                  <p
                    className="text-[15px] font-bold leading-tight"
                    style={{
                      color: shown.tier === 'epic' ? '#e8a0ff' : '#ffe83c',
                      textShadow: shown.tier === 'epic'
                        ? '2px 2px 0 #3a1060'
                        : '2px 2px 0 #3a3a00',
                      fontFamily: "'ZCOOL KuaiLe', 'Fusion Pixel zh-hans', monospace",
                    }}
                  >
                    {shown.tier === 'epic' ? '挑战已完成！' : '进度已达成！'}
                  </p>
                  <p
                    className="mt-0.5 text-[12px] leading-tight text-white/85"
                    style={{ textShadow: '1px 1px 0 #000', fontFamily: "'ZCOOL KuaiLe', 'Fusion Pixel zh-hans', monospace" }}
                  >
                    {shown.name}
                  </p>
                </div>
              </div>
            </McFrame>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
