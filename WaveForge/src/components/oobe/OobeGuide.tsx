/**
 * OobeGuide —— OOBE 1：WaveForge 首次启动引导（第一层）
 *
 * 流程：主题选择 → 隐私欢迎动画 → 隐私条款 → 免责引导动画 → 15 条免责声明
 *      （逐条动画 + 滚动 + 8s 倒计时）→ 最终免责弹窗（5s）→ 欢迎页 → 进入软件
 *
 * ⚠ 未来 AI 接力：OOBE 2 = 功能介绍引导（第二层，暂未实现）。
 *   接入方式：直接在本组件 welcome 步骤之前插入功能介绍步骤，
 *   或在 App 层把 OOBE 2 的步骤编排进本组件，无需改动整体结构。
 *
 * 设计要点：
 * - 门面级视觉：玻璃拟态 + 液态光斑 + 底部水波（澜音风格），弹出/渐现渐隐动画
 * - 默认不自动触发（由 App 侧 OOBE_ENABLED 常量控制），未来接入二层 OOBE 时
 *   直接在 welcome 前插入功能介绍步骤即可，或通过 forceOpen 手动打开
 * - 主题选择即时派发 playerThemeChanged 事件（App 已监听并持久化）
 */
import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Moon, Sun, Check, ChevronRight, ArrowLeft, ShieldCheck, ShieldAlert, LogOut, X } from 'lucide-react'
import LegalAgreement from '../legal/LegalAgreement'
import { LocaleSwitcher, countdownLabel, renderRich, type LocaleCode } from '../../i18n'
import { OOBE_STRINGS, type OobeStringKey } from '../../i18n/oobe'
import './oobe.css'

const OOBE_FLAG = 'waveforge:oobe-shown'

const appLogoUrl = new URL('../../../logo.png', import.meta.url).href

type OobeStep = 'theme' | 'privacyIntro' | 'privacy' | 'disclaimerIntro' | 'disclaimer' | 'welcome'

interface OobeGuideProps {
  playerTheme?: 'light' | 'dark'
  /** App 侧常量 OOBE_ENABLED：暂时未实装时传 false，未来置 true 启用首次自动弹出 */
  enabled?: boolean
  /** 强制打开（设置里"重新查看引导"触发） */
  forceOpen?: boolean
  onComplete?: () => void
}

// ⚠⚠ 测试快捷入口（用户测试完成后删除或改为 false）：
// 打开软件直接进入"用户须知与免责声明"页，跳过主题选择/隐私/引导动画步骤
// 当前 false：从主题选择开始完整流程测试
const OOBE_TEST_JUMP_TO_DISCLAIMER = false

// 每行时长：正常中文阅读约 4 字/秒（认真阅读），读完留 2 秒思考，再加渐入渐出
// 10~11 字 → 约 2.6s 阅读 + 2s 思考 + 1.2s 渐入渐出 ≈ 5.8s
const PRIVACY_INTRO_LINE_MS = 5800
// 18~20 字 → 约 4.8s 阅读 + 2s 思考 + 1.2s 渐入渐出 ≈ 8s
const DISCLAIMER_INTRO_LINE_MS = 8000

// 每条免责声明的停留时长（秒）：长段 8s / 短段 5s
const DISCLAIMER_HOLDS_S: number[] = [8, 8, 8, 8, 5, 5, 8, 5, 8, 8, 8, 5, 8, 8, 5]
// 每条渐现动画时长
const ITEM_FADE_MS = 2000

// 背景上浮气泡（大小 / 水平位置 / 延时 / 周期 / 透明度）
const OOBE_BUBBLES: Array<{ size: number; left: string; delay: number; duration: number; opacity: number }> = [
  { size: 8, left: '6%', delay: 0, duration: 22, opacity: 0.35 },
  { size: 14, left: '16%', delay: 6, duration: 26, opacity: 0.28 },
  { size: 10, left: '27%', delay: 12, duration: 24, opacity: 0.3 },
  { size: 6, left: '38%', delay: 3, duration: 20, opacity: 0.4 },
  { size: 12, left: '49%', delay: 9, duration: 27, opacity: 0.25 },
  { size: 8, left: '60%', delay: 15, duration: 23, opacity: 0.32 },
  { size: 16, left: '71%', delay: 5, duration: 29, opacity: 0.22 },
  { size: 7, left: '82%', delay: 11, duration: 21, opacity: 0.35 },
  { size: 11, left: '91%', delay: 1, duration: 25, opacity: 0.28 },
  { size: 9, left: '95%', delay: 8, duration: 24, opacity: 0.3 },
]

export default function OobeGuide({ playerTheme = 'dark', enabled = false, forceOpen = false, onComplete }: OobeGuideProps) {
  // 初始主题：跟随 App 当前主题（默认深色）
  const [theme, setTheme] = useState<'dark' | 'light'>(playerTheme || 'dark')
  // 语言（右上角切换，默认简体中文）
  const [locale, setLocale] = useState<LocaleCode>('zh-CN')
  const t = (key: OobeStringKey) => OOBE_STRINGS[key][locale]
  const privacyIntroLines = [t('privacyIntro1'), t('privacyIntro2')]
  const disclaimerIntroLines = [t('disclaimerIntro1'), t('disclaimerIntro2')]
  const disclaimerItems = Array.from({ length: 15 }, (_, index) => t(`disclaimerItem${index + 1}` as OobeStringKey))
  const [step, setStep] = useState<OobeStep>(OOBE_TEST_JUMP_TO_DISCLAIMER ? 'disclaimer' : 'theme')
  const [showFinal, setShowFinal] = useState(false)
  const [countdown, setCountdown] = useState(0)
  const [introIndex, setIntroIndex] = useState(0)
  const [revealCount, setRevealCount] = useState(0)
  const [done, setDone] = useState(false)
  const [showLegalModal, setShowLegalModal] = useState(false)
  const [accentColor] = useState(() => {
    try { return localStorage.getItem('accentColor') || '#3B82F6' } catch { return '#3B82F6' }
  })
  const listRef = useRef<HTMLDivElement>(null)

  // 是否显示：forceOpen 优先；否则首次启动（enabled && 未完成）
  const [completedLocal] = useState(() => {
    try { return localStorage.getItem(OOBE_FLAG) === '1' } catch { return true }
  })
  const show = forceOpen || (enabled && !completedLocal)

  // 倒计时
  useEffect(() => {
    if (countdown <= 0) return
    const timer = window.setTimeout(() => setCountdown(v => v - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [countdown])

  // 进入各步骤时重置倒计时 / 逐条揭示
  useEffect(() => {
    if (step === 'privacy') {
      setCountdown(10)
    } else if (step === 'disclaimer') {
      setCountdown(0)
      setRevealCount(0)
      // 第一条快速出现（避免长时间空白），之后每条：渐现 → 停留（长 8s / 短 5s）→ 下一条
      const timers: number[] = []
      let elapsed = 400
      for (let i = 0; i < disclaimerItems.length; i++) {
        timers.push(window.setTimeout(() => setRevealCount(i + 1), elapsed))
        if (i < disclaimerItems.length - 1) {
          elapsed += ITEM_FADE_MS + DISCLAIMER_HOLDS_S[i] * 1000
        }
      }
      return () => timers.forEach(t => window.clearTimeout(t))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // 逐条显示完毕后启动 8s 倒计时
  useEffect(() => {
    if (step === 'disclaimer' && revealCount >= disclaimerItems.length && countdown <= 0) {
      setCountdown(8)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealCount, step])

  // 逐条出现时：仅当新条目超出可视区才滚动并钉到列表顶部；
  // 前几条（约 1~5）自然显示不动，第六条左右开始跟随，末尾几条浏览器自动限制在底部
  useEffect(() => {
    if (step !== 'disclaimer' || revealCount === 0) return
    const el = listRef.current
    if (!el) return
    const target = el.querySelector(`[data-item="${revealCount - 1}"]`) as HTMLElement | null
    if (!target) return
    const listTop = el.getBoundingClientRect().top
    const targetBottom = target.getBoundingClientRect().bottom
    // 新条目已完整在可视区内：不滚动
    if (targetBottom <= listTop + el.clientHeight) return
    // 超出可视区：把新条目钉到列表顶部
    el.scrollTo({ top: Math.max(0, target.offsetTop - 4), behavior: 'smooth' })
  }, [revealCount, step])

  // 隐私欢迎动画 / 免责引导动画自动推进（每行按阅读速度 + 2s 思考时间）
  useEffect(() => {
    if (step === 'privacyIntro') {
      setIntroIndex(0)
      const t1 = window.setTimeout(() => setIntroIndex(1), PRIVACY_INTRO_LINE_MS)
      const t2 = window.setTimeout(() => setStep('privacy'), PRIVACY_INTRO_LINE_MS * 2 + 300)
      return () => { window.clearTimeout(t1); window.clearTimeout(t2) }
    }
    if (step === 'disclaimerIntro') {
      setIntroIndex(0)
      const t1 = window.setTimeout(() => setIntroIndex(1), DISCLAIMER_INTRO_LINE_MS)
      const t2 = window.setTimeout(() => setStep('disclaimer'), DISCLAIMER_INTRO_LINE_MS * 2 + 300)
      return () => { window.clearTimeout(t1); window.clearTimeout(t2) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step])

  // 右上角关闭按钮：OOBE 可见时先显示 5 秒再向右滑出；
  // 鼠标悬停右上角热区再显示，移开 3 秒后滑出
  const [closeVisible, setCloseVisible] = useState(true)
  const hideCloseTimerRef = useRef<number | null>(null)

  useEffect(() => {
    if (!show) return
    // 每次 OOBE 变为可见时重新显示（组件常驻挂载，不能只在挂载时计时）
    setCloseVisible(true)
    const timer = window.setTimeout(() => setCloseVisible(false), 5000)
    return () => window.clearTimeout(timer)
  }, [show])

  useEffect(() => () => {
    if (hideCloseTimerRef.current) window.clearTimeout(hideCloseTimerRef.current)
  }, [])

  const showCloseButton = () => {
    if (hideCloseTimerRef.current) window.clearTimeout(hideCloseTimerRef.current)
    setCloseVisible(true)
  }
  const scheduleHideCloseButton = () => {
    if (hideCloseTimerRef.current) window.clearTimeout(hideCloseTimerRef.current)
    hideCloseTimerRef.current = window.setTimeout(() => setCloseVisible(false), 3000)
  }

  const applyTheme = (next: 'dark' | 'light') => {
    setTheme(next)
    try {
      window.dispatchEvent(new CustomEvent('playerThemeChanged', { detail: next }))
    } catch { /* ignore */ }
  }

  const allRevealed = step === 'disclaimer' && revealCount >= disclaimerItems.length

  const quitApp = () => {
    const bridge = (window as any).electron
    if (bridge?.system?.close) {
      void bridge.system.close()
    } else {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '请关闭本页面以退出', type: 'info' } }))
    }
  }

  const complete = () => {
    try { localStorage.setItem(OOBE_FLAG, '1') } catch { /* ignore */ }
    setDone(true)
    onComplete?.()
  }

  if (!show || done) return null

  const isDark = theme === 'dark'
  const textPrimary = isDark ? 'text-white' : 'text-black'
  const textSecondary = isDark ? 'text-white/65' : 'text-black/60'
  const textTertiary = isDark ? 'text-white/40' : 'text-black/40'
  const glassCard = isDark
    ? 'bg-[rgba(15,15,20,0.72)] border-white/10'
    : 'bg-[rgba(255,255,255,0.72)] border-black/10'
  const ghostBtn = isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-black/5 hover:bg-black/10'
  const bodyBg = isDark ? '#09090b' : '#f4f3ef'

  return (
    <div className="fixed inset-0 z-[10000] overflow-x-hidden overflow-y-auto" style={{ backgroundColor: bodyBg }}>
      {/* ── 顶部：语言切换（居中）+ 关闭（右上角热区，悬停显示/3 秒后滑出） ── */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[10030]">
        <LocaleSwitcher locale={locale} onChange={setLocale} theme={theme} accentColor={accentColor} align="center" />
      </div>
      <div
        className="absolute top-0 right-0 z-[10030] pt-3 pr-3 pl-10 pb-12"
        onMouseEnter={showCloseButton}
        onMouseLeave={scheduleHideCloseButton}
      >
        <motion.button
          onClick={quitApp}
          aria-label={t('ariaClose')}
          title={t('ariaClose')}
          initial={false}
          animate={{ opacity: closeVisible ? 1 : 0, x: closeVisible ? 0 : 56 }}
          transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className={`p-2.5 rounded-full transition-colors ${isDark ? 'bg-white/10 hover:bg-red-500/25' : 'bg-black/5 hover:bg-red-500/15'} ${textSecondary} hover:text-red-500`}
        >
          <X className="w-5 h-5" />
        </motion.button>
      </div>

      {/* ── 背景：accent 光晕 + 液态光斑 + 噪点 + 底部水波 ── */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden>
        {/* 极光背景：多色径向渐变缓慢漂移 + 色相旋转（深/浅主题各一套配色） */}
        <div
          className="oobe-aurora"
          style={{
            background: isDark
              ? `
                radial-gradient(38% 34% at 20% 16%, ${accentColor}38, transparent 62%),
                radial-gradient(30% 28% at 80% 20%, rgba(139,92,246,0.28), transparent 62%),
                radial-gradient(36% 32% at 68% 80%, ${accentColor}2a, transparent 62%),
                radial-gradient(26% 26% at 26% 74%, rgba(34,211,238,0.20), transparent 60%),
                radial-gradient(24% 22% at 50% 40%, rgba(34,211,238,0.08), transparent 60%)
              `
              : `
                radial-gradient(38% 34% at 20% 16%, ${accentColor}1f, transparent 62%),
                radial-gradient(30% 28% at 80% 20%, rgba(139,92,246,0.13), transparent 62%),
                radial-gradient(36% 32% at 68% 80%, ${accentColor}17, transparent 62%),
                radial-gradient(26% 26% at 26% 74%, rgba(34,211,238,0.10), transparent 60%),
                radial-gradient(24% 22% at 50% 40%, rgba(139,92,246,0.07), transparent 60%)
              `,
          }}
        />
        <div className="absolute inset-0" style={{ background: `radial-gradient(ellipse 80% 55% at 50% -5%, ${accentColor}26, transparent 65%)` }} />

        {/* 光斑（柔和光晕质感：纯色柔光，无白色核心，超长衰减） */}
        <div className="oobe-blob" style={{ width: 400, height: 400, top: '10%', left: '6%', background: `radial-gradient(circle, ${accentColor}30 0%, ${accentColor}14 22%, ${accentColor}05 55%, transparent 80%)` }} />
        <div className="oobe-blob" style={{ width: 320, height: 320, bottom: '12%', right: '8%', background: isDark ? `radial-gradient(circle, ${accentColor}26 0%, ${accentColor}10 22%, ${accentColor}04 55%, transparent 80%)` : `radial-gradient(circle, ${accentColor}1a 0%, ${accentColor}0c 22%, ${accentColor}03 55%, transparent 80%)`, animationDelay: '-8s' }} />
        <div className="oobe-blob" style={{ width: 240, height: 240, top: '46%', left: '54%', background: isDark ? 'radial-gradient(circle, rgba(139,92,246,0.20) 0%, rgba(139,92,246,0.10) 22%, rgba(139,92,246,0.04) 55%, transparent 80%)' : 'radial-gradient(circle, rgba(139,92,246,0.13) 0%, rgba(139,92,246,0.07) 22%, rgba(139,92,246,0.03) 55%, transparent 80%)', animationDelay: '-4s' }} />
        <div className="oobe-blob" style={{ width: 280, height: 280, top: '7%', right: '20%', background: isDark ? 'radial-gradient(circle, rgba(34,211,238,0.16) 0%, rgba(34,211,238,0.08) 22%, rgba(34,211,238,0.03) 55%, transparent 80%)' : 'radial-gradient(circle, rgba(34,211,238,0.10) 0%, rgba(34,211,238,0.05) 22%, rgba(34,211,238,0.02) 55%, transparent 80%)', animationDelay: '-12s' }} />

        {/* 星点（深色星空 / 浅色细点），整体缓慢呼吸 */}
        <div
          className="oobe-stars absolute inset-0"
          style={{
            backgroundImage: isDark
              ? `radial-gradient(1.5px 1.5px at 22% 18%, rgba(255,255,255,0.5), transparent 55%),
                 radial-gradient(1px 1px at 62% 34%, rgba(255,255,255,0.34), transparent 55%),
                 radial-gradient(1.2px 1.2px at 80% 12%, rgba(255,255,255,0.42), transparent 55%),
                 radial-gradient(1px 1px at 40% 55%, rgba(255,255,255,0.26), transparent 55%),
                 radial-gradient(1.4px 1.4px at 88% 62%, rgba(255,255,255,0.32), transparent 55%),
                 radial-gradient(1px 1px at 12% 72%, rgba(255,255,255,0.22), transparent 55%),
                 radial-gradient(1.2px 1.2px at 55% 80%, rgba(255,255,255,0.3), transparent 55%),
                 radial-gradient(1px 1px at 70% 48%, rgba(255,255,255,0.24), transparent 55%)`
              : `radial-gradient(1.5px 1.5px at 22% 18%, rgba(59,130,246,0.28), transparent 55%),
                 radial-gradient(1px 1px at 62% 34%, rgba(59,130,246,0.18), transparent 55%),
                 radial-gradient(1.2px 1.2px at 80% 12%, rgba(139,92,246,0.22), transparent 55%),
                 radial-gradient(1px 1px at 40% 55%, rgba(59,130,246,0.14), transparent 55%),
                 radial-gradient(1.4px 1.4px at 88% 62%, rgba(139,92,246,0.18), transparent 55%),
                 radial-gradient(1px 1px at 12% 72%, rgba(59,130,246,0.12), transparent 55%),
                 radial-gradient(1.2px 1.2px at 55% 80%, rgba(59,130,246,0.16), transparent 55%),
                 radial-gradient(1px 1px at 70% 48%, rgba(59,130,246,0.14), transparent 55%)`,
          }}
        />

        {/* 上浮气泡（澜音水感） */}
        {OOBE_BUBBLES.map((bubble, index) => (
          <span
            key={index}
            className="oobe-bubble"
            style={{
              left: bubble.left,
              width: bubble.size,
              height: bubble.size,
              borderColor: isDark ? 'rgba(255,255,255,0.42)' : 'rgba(59,130,246,0.36)',
              animationDuration: `${bubble.duration}s`,
              animationDelay: `${bubble.delay}s`,
              ['--bubble-opacity' as string]: bubble.opacity,
            }}
          />
        ))}

        <div className="absolute inset-0 opacity-[0.035]" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E")` }} />

        {/* 暗角：四周轻微压暗，增强纵深（浅色主题用极淡的阴影） */}
        <div
          className="absolute inset-0"
          style={{
            background: isDark
              ? 'radial-gradient(ellipse 120% 90% at 50% 50%, transparent 52%, rgba(0,0,0,0.42) 100%)'
              : 'radial-gradient(ellipse 120% 90% at 50% 50%, transparent 58%, rgba(0,0,0,0.05) 100%)',
          }}
        />

        {/* 底部水波：周期闭合波形（首尾同高，无缝循环）+ 容器级静态边缘渐隐 */}
        <div className="oobe-wave-wrap absolute inset-x-0 bottom-0 h-28" style={{ opacity: isDark ? 0.55 : 0.38 }}>
          <svg className="oobe-wave-line" viewBox="0 0 1200 120" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M0,60 C100,20 200,100 300,60 C400,20 500,100 600,60 C700,20 800,100 900,60 C1000,20 1100,100 1200,60 L1200,120 L0,120 Z" fill={accentColor} fillOpacity="0.35" />
            <path d="M0,60 C100,20 200,100 300,60 C400,20 500,100 600,60 C700,20 800,100 900,60 C1000,20 1100,100 1200,60 L1200,120 L0,120 Z" fill={accentColor} fillOpacity="0.35" transform="translate(1200,0)" />
          </svg>
        </div>
      </div>

      {/* ── 欢迎页（全屏构图，无卡片） ── */}
      {step === 'welcome' ? (
        <div className="relative min-h-full flex flex-col items-center justify-center px-6 text-center">
          <motion.p
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className={`text-lg mb-8 ${textSecondary}`}
          >
            {t('welcomeLine')}
          </motion.p>
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, delay: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="mb-7"
          >
            <img
              src={appLogoUrl}
              alt="WaveForge"
              className="w-32 h-32 sm:w-36 sm:h-36 rounded-[28px] object-cover"
              style={{ boxShadow: `0 0 60px ${accentColor}55, 0 18px 50px rgba(0,0,0,0.4)` }}
            />
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.55, ease: [0.22, 1, 0.36, 1] }}
            className={`text-4xl sm:text-5xl font-bold tracking-tight mb-12 ${textPrimary}`}
            style={{ textShadow: isDark ? `0 0 36px ${accentColor}66` : undefined }}
          >
            WaveForge
          </motion.h1>
          <motion.button
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.85, ease: [0.22, 1, 0.36, 1] }}
            onClick={complete}
            className="px-10 py-3.5 rounded-2xl text-base font-semibold text-white transition-all hover:brightness-110 active:scale-[0.98]"
            style={{ backgroundColor: accentColor, boxShadow: `0 12px 40px ${accentColor}55` }}
          >
            {t('welcomeEnter')}
          </motion.button>
        </div>
      ) : step === 'privacyIntro' || step === 'disclaimerIntro' ? (
        /* ── 渐现渐隐文字（Windows 欢迎式） ── */
        <div className="relative min-h-full flex items-center justify-center px-8">
          <motion.p
            key={step === 'privacyIntro' ? `p${introIndex}` : `d${introIndex}`}
            initial={{ opacity: 0, scale: 0.98, y: 8 }}
            animate={{ opacity: [0, 1, 1, 0], scale: [0.98, 1, 1, 0.99], y: [8, 0, 0, -6] }}
            transition={{ duration: step === 'privacyIntro' ? PRIVACY_INTRO_LINE_MS / 1000 : DISCLAIMER_INTRO_LINE_MS / 1000, times: [0, 0.12, 0.88, 1], ease: 'easeInOut' }}
            className={`text-3xl sm:text-4xl font-semibold text-center max-w-2xl leading-relaxed ${textPrimary}`}
            style={{ textShadow: isDark ? `0 0 30px ${accentColor}55` : undefined }}
          >
            {step === 'privacyIntro' ? privacyIntroLines[introIndex] : disclaimerIntroLines[introIndex]}
          </motion.p>
        </div>
      ) : (
        /* ── 卡片步骤：主题 / 隐私条款 / 免责声明 ── */
        <div className="relative min-h-full flex items-center justify-center p-4 sm:p-6">
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 22 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -14 }}
            transition={{ type: 'spring', damping: 26, stiffness: 280 }}
            className={`w-full max-w-2xl rounded-3xl border shadow-2xl backdrop-blur-2xl ${glassCard} ${step === 'disclaimer' ? 'h-[min(80vh,680px)] flex flex-col' : ''}`}
            style={{ boxShadow: `0 24px 80px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.1)` }}
          >
            <AnimatePresence mode="wait">
              {step === 'theme' && (
                <motion.div key="theme" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.3 }} className="p-7 sm:p-9">
                  <h2 className={`text-xl sm:text-2xl font-bold ${textPrimary}`}>{t('themeTitle')}</h2>
                  <p className={`mt-2 text-sm ${textSecondary}`}>{t('themeSubtitle')}</p>
                  <div className="mt-7 grid grid-cols-2 gap-4">
                    {([
                      { key: 'dark' as const, label: t('themeDark'), icon: <Moon className="w-7 h-7" /> },
                      { key: 'light' as const, label: t('themeLight'), icon: <Sun className="w-7 h-7" /> },
                    ]).map(item => {
                      const active = theme === item.key
                      return (
                        <motion.button
                          key={item.key}
                          whileHover={{ scale: 1.03 }}
                          whileTap={{ scale: 0.97 }}
                          onClick={() => applyTheme(item.key)}
                          className={`relative rounded-2xl border px-6 py-7 flex flex-col items-center gap-3 transition-colors ${
                            isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10'
                          } ${active ? 'border-transparent' : isDark ? 'border-white/10' : 'border-black/10'}`}
                          style={active ? { borderColor: accentColor, boxShadow: `0 0 0 2px ${accentColor}, 0 10px 30px ${accentColor}33` } : undefined}
                        >
                          <div style={{ color: active ? accentColor : undefined }} className={`${active ? '' : textTertiary}`}>{item.icon}</div>
                          <span className={`font-medium ${textPrimary}`}>{item.label}</span>
                          {active && (
                            <motion.span
                              initial={{ scale: 0 }}
                              animate={{ scale: 1 }}
                              transition={{ type: 'spring', damping: 15, stiffness: 400 }}
                              className="absolute top-3 right-3 w-6 h-6 rounded-full flex items-center justify-center"
                              style={{ backgroundColor: accentColor }}
                            >
                              <Check className="w-4 h-4 text-white" />
                            </motion.span>
                          )}
                        </motion.button>
                      )
                    })}
                  </div>
                  <div className="mt-8 flex justify-end">
                    <button
                      onClick={() => setStep('privacyIntro')}
                      className="px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 active:scale-[0.98] flex items-center gap-1.5"
                      style={{ backgroundColor: accentColor, boxShadow: `0 8px 24px ${accentColor}33` }}
                    >
                      {t('themeNext')} <ChevronRight className="w-4 h-4" />
                    </button>
                  </div>
                </motion.div>
              )}

              {step === 'privacy' && (
                <motion.div key="privacy" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.3 }} className="p-7 sm:p-9">
                  <div className="flex items-center gap-3 mb-1">
                    <ShieldCheck className="w-6 h-6" style={{ color: accentColor }} />
                    <h2 className={`text-xl sm:text-2xl font-bold ${textPrimary}`}>{t('privacyTitle')}</h2>
                  </div>
                  <p className={`mt-2 text-sm ${textSecondary}`}>{t('privacyIntro')}</p>
                  <div className={`mt-5 space-y-3 text-[15px] leading-relaxed ${textSecondary}`}>
                    {[t('privacyItem1'), t('privacyItem2'), t('privacyItem3'), t('privacyItem4'), t('privacyItem5')].map((item, index) => (
                      <motion.div
                        key={index}
                        initial={{ opacity: 0, x: -10 }}
                        animate={{ opacity: 1, x: 0 }}
                        transition={{ delay: 0.12 + index * 0.09, duration: 0.35 }}
                        className="flex items-start gap-3"
                      >
                        <span className="mt-[9px] w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: accentColor }} />
                        <span>{item}</span>
                      </motion.div>
                    ))}
                  </div>
                  <div className="mt-8 flex items-center justify-between">
                    <button
                      onClick={() => setStep('theme')}
                      className={`px-5 py-2.5 rounded-xl text-sm font-medium flex items-center gap-1.5 transition-colors ${ghostBtn} ${textPrimary}`}
                    >
                      <ArrowLeft className="w-4 h-4" /> {t('back')}
                    </button>
                    <button
                      onClick={() => setStep('disclaimerIntro')}
                      disabled={countdown > 0}
                      className={`px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all ${
                        countdown > 0 ? 'opacity-45 cursor-not-allowed' : 'hover:brightness-110 active:scale-[0.98]'
                      }`}
                      style={{ backgroundColor: accentColor, boxShadow: countdown > 0 ? undefined : `0 8px 24px ${accentColor}33` }}
                    >
                      {countdownLabel(t('confirmTpl'), countdown)}
                    </button>
                  </div>
                </motion.div>
              )}

              {step === 'disclaimer' && (
                <motion.div key="disclaimer" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.3 }} className="p-7 sm:p-9 flex-1 flex flex-col min-h-0">
                  <div className="flex items-center gap-3 mb-1 shrink-0">
                    <ShieldAlert className="w-6 h-6" style={{ color: '#f59e0b' }} />
                    <h2 className={`text-xl sm:text-2xl font-bold ${textPrimary}`}>{t('disclaimerTitle')}</h2>
                  </div>
                  <p className={`mt-2 text-sm ${textSecondary} shrink-0`}>{t('disclaimerSubtitle')}</p>

                  <div ref={listRef} className={`${allRevealed ? 'oobe-scroll' : 'oobe-scroll-hidden'} relative mt-5 flex-1 min-h-0 overflow-y-auto pr-2 space-y-3`}>
                    {/* 全部 15 条预渲染占位（未揭示时透明），揭示时仅透明度渐现：
                        布局恒定 → 已显示条目不会上移，无滚动跳动，动画平滑 */}
                    {disclaimerItems.map((item, index) => (
                      <motion.div
                        key={index}
                        data-item={index}
                        initial={false}
                        animate={{ opacity: index < revealCount ? 1 : 0 }}
                        transition={{ duration: 1.8, ease: 'easeInOut' }}
                        className="flex items-start gap-3 text-[15px] leading-relaxed"
                      >
                        <span
                          className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0 leading-none"
                          style={{ backgroundColor: `${accentColor}cc` }}
                        >
                          {index + 1}
                        </span>
                        <span className={`${textSecondary}`}>{renderRich(item, theme)}</span>
                      </motion.div>
                    ))}
                  </div>

                  {allRevealed && (
                    <motion.p
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.6 }}
                      className={`mt-4 text-sm ${textTertiary} shrink-0`}
                    >
                      {t('disclaimerHint')}{' '}
                      <button
                        onClick={() => setShowLegalModal(true)}
                        className="underline underline-offset-2 hover:opacity-80 transition-opacity"
                        style={{ color: accentColor }}
                      >
                        {t('legalLink')}
                      </button>
                    </motion.p>
                  )}

                  <div className="mt-7 flex items-center justify-between shrink-0">
                    <div className="flex items-center gap-2">
                      <button
                        onClick={quitApp}
                        className={`px-5 py-2.5 rounded-xl text-sm font-medium flex items-center gap-1.5 transition-colors ${ghostBtn} ${textPrimary}`}
                      >
                        <LogOut className="w-4 h-4" /> {t('exit')}
                      </button>
                      <button
                        onClick={() => setStep('privacy')}
                        className={`px-5 py-2.5 rounded-xl text-sm font-medium flex items-center gap-1.5 transition-colors ${ghostBtn} ${textPrimary}`}
                      >
                        <ArrowLeft className="w-4 h-4" /> {t('back')}
                      </button>
                    </div>
                    <button
                      onClick={() => { setShowFinal(true); setCountdown(10) }}
                      disabled={!allRevealed || countdown > 0}
                      className={`px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all ${
                        !allRevealed || countdown > 0 ? 'opacity-45 cursor-not-allowed' : 'hover:brightness-110 active:scale-[0.98]'
                      }`}
                      style={{ backgroundColor: accentColor, boxShadow: (!allRevealed || countdown > 0) ? undefined : `0 8px 24px ${accentColor}33` }}
                    >
                      {allRevealed ? countdownLabel(t('agreeTpl'), countdown) : t('readingHint')}
                    </button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        </div>
      )}

      {/* ── 最终免责声明弹窗（叠加于免责声明页之上，不关闭下层） ── */}
      <AnimatePresence>
        {showFinal && step === 'disclaimer' && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[10010] flex items-center justify-center p-4"
            style={{ backgroundColor: 'rgba(0,0,0,0.78)', backdropFilter: 'blur(4px)' }}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 16 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: 'spring', damping: 26, stiffness: 300 }}
              className={`w-full max-w-lg rounded-3xl border shadow-2xl overflow-hidden flex flex-col ${glassCard}`}
              style={{ boxShadow: '0 24px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1)' }}
            >
              <div className={`px-7 pt-7 pb-1 flex items-center gap-3`}>
                <ShieldAlert className="w-6 h-6" style={{ color: '#f59e0b' }} />
                <h3 className={`text-lg font-bold ${textPrimary}`}>{t('finalTitle')}</h3>
              </div>
              <div className="px-7 py-5 space-y-3 text-[15px] leading-relaxed">
                <p className={textSecondary}>{t('finalP1')}</p>
                <p className={textSecondary}>{t('finalP2')}</p>
                <p className={textSecondary}>{t('finalP3')}</p>
                <p className={textSecondary}>{t('finalP4')}</p>
              </div>
              <div className={`px-7 py-5 flex items-center justify-between border-t ${isDark ? 'border-white/10' : 'border-black/10'}`}>
                <button
                  onClick={quitApp}
                  className={`px-5 py-2.5 rounded-xl text-sm font-medium flex items-center gap-1.5 transition-colors ${ghostBtn} ${textPrimary}`}
                >
                  <LogOut className="w-4 h-4" /> {t('exit')}
                </button>
                <button
                  onClick={() => { setShowFinal(false); setStep('welcome') }}
                  disabled={countdown > 0}
                  className={`px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all ${
                    countdown > 0 ? 'opacity-45 cursor-not-allowed' : 'hover:brightness-110 active:scale-[0.98]'
                  }`}
                  style={{ backgroundColor: accentColor, boxShadow: countdown > 0 ? undefined : `0 8px 24px ${accentColor}33` }}
                >
                  {countdownLabel(t('confirmTpl'), countdown)}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── 完整《法律声明与用户协议》弹窗（从免责声明页/最终确认链接打开） ── */}
      <AnimatePresence>
        {showLegalModal && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[10020] flex items-center justify-center p-4"
            style={{ backgroundColor: 'rgba(0,0,0,0.8)' }}
            onClick={() => setShowLegalModal(false)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 16 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0 }}
              transition={{ type: 'spring', damping: 26, stiffness: 300 }}
              onClick={(e) => e.stopPropagation()}
              className={`w-full max-w-3xl max-h-[85vh] rounded-3xl border shadow-2xl overflow-hidden flex flex-col ${glassCard}`}
              style={{ boxShadow: '0 24px 80px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.1)' }}
            >
              <div className={`flex items-center justify-between px-6 py-4 border-b shrink-0 ${isDark ? 'border-white/10' : 'border-black/10'}`}>
                <h3 className={`text-lg font-bold ${textPrimary}`}>{t('legalModalTitle')}</h3>
                <button
                  onClick={() => setShowLegalModal(false)}
                  className={`p-2 rounded-lg transition-colors ${ghostBtn}`}
                  aria-label={t('ariaClose')}
                >
                  <X className={`w-5 h-5 ${textSecondary}`} />
                </button>
              </div>
              <div className="oobe-scroll flex-1 overflow-y-auto px-6 py-6 sm:px-8">
                <LegalAgreement theme={theme} locale={locale} />
              </div>
              <div className={`flex items-center justify-end px-6 py-4 border-t shrink-0 ${isDark ? 'border-white/10' : 'border-black/10'}`}>
                <button
                  onClick={() => setShowLegalModal(false)}
                  className={`px-6 py-2.5 rounded-xl text-sm font-semibold text-white transition-all hover:brightness-110 active:scale-[0.98]`}
                  style={{ backgroundColor: accentColor, boxShadow: `0 8px 24px ${accentColor}33` }}
                >
                  {t('legalModalClose')}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
