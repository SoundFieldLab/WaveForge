/**
 * 关于页 —— HyperSoundEngine 品牌信息（Logo 动画 + 微光背景 + 三行信息）
 */

import { useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Terminal } from 'lucide-react'
import { Toggle } from '../components/Primitives'
import type { HSETheme } from '../hse-theme'
import { isDevMode, setDevMode, HSE_DEV_MODE_EVENT } from '../sceneStore'

interface AboutPageProps {
  theme: HSETheme
}

export default function AboutPage({ theme }: AboutPageProps) {
  const [dev, setDev] = useState(isDevMode)

  useEffect(() => {
    const sync = () => setDev(isDevMode())
    window.addEventListener(HSE_DEV_MODE_EVENT, sync)
    return () => window.removeEventListener(HSE_DEV_MODE_EVENT, sync)
  }, [])

  return (
    <div className="relative flex min-h-[56vh] flex-col items-center justify-center text-center overflow-hidden">
      {/* 微光背景：双层径向辉光 + 缓慢呼吸 */}
      <motion.div
        className="pointer-events-none absolute inset-0"
        style={{ background: `radial-gradient(circle at 50% 45%, ${theme.accentColor}22 0%, transparent 55%)` }}
        animate={{ opacity: [0.55, 0.9, 0.55] }}
        transition={{ duration: 4.5, repeat: Infinity, ease: 'easeInOut' }}
      />
      <div
        className="pointer-events-none absolute left-1/2 top-[42%] -translate-x-1/2 -translate-y-1/2 rounded-full"
        style={{ width: 320, height: 320, background: `radial-gradient(circle, ${theme.accentColor}10 0%, transparent 70%)` }}
      />

      <div className="relative flex flex-col items-center">
        {/* Logo 标志：双层呼吸环 + 中心圆点 */}
        <motion.div
          className="relative mb-7 flex items-center justify-center"
          style={{ width: 64, height: 64 }}
        >
          <motion.div
            className="absolute inset-0 rounded-full"
            style={{ border: `1.5px solid ${theme.accentColor}55` }}
            animate={{ scale: [1, 1.18, 1], opacity: [0.55, 0.2, 0.55] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut' }}
          />
          <motion.div
            className="absolute rounded-full"
            style={{ inset: 10, border: `1.5px solid ${theme.accentColor}88` }}
            animate={{ scale: [1, 1.1, 1], opacity: [0.8, 0.4, 0.8] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: 0.4 }}
          />
          <motion.div
            className="rounded-full"
            style={{ width: 14, height: 14, background: theme.accentColor, boxShadow: `0 0 16px ${theme.accentColor}` }}
            animate={{ scale: [1, 1.12, 1] }}
            transition={{ duration: 3, repeat: Infinity, ease: 'easeInOut', delay: 0.2 }}
          />
        </motion.div>

        <motion.span
          className="text-3xl font-bold tracking-wide"
          style={{
            background: `linear-gradient(135deg, ${theme.accentColor} 0%, #fff 130%)`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            textShadow: `0 0 48px ${theme.accentGlow}`,
          }}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.15, type: 'spring', stiffness: 200, damping: 20 }}
        >
          HyperSoundEngine
        </motion.span>
        <motion.span
          className={`${theme.textSecondary} mt-3 text-sm`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.4 }}
        >
          WaveForge特供版
        </motion.span>
        <motion.span
          className={`${theme.textTertiary} mt-6 text-[11px] tracking-wide`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.6 }}
        >
          2026 © IceFire_Icer All Right Reserved
        </motion.span>
        <motion.span
          className="mt-2 text-[10px] tracking-wide"
          style={{ color: `${theme.accentColor}aa` }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8 }}
        >
          HyperSoundEngine 已授权 WaveForge 项目使用
        </motion.span>

        {/* 开发者模式开关：开启后「音效场景」页可直接微调内置场景并持久化 */}
        <motion.div
          className="mt-8 flex items-center gap-3 rounded-xl px-4 py-2.5"
          style={{ background: 'rgba(255,255,255,0.04)', border: `1px solid ${theme.cardBorder}` }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 1 }}
        >
          <Terminal className="w-3.5 h-3.5" style={{ color: dev ? theme.accentColor : theme.textTertiary }} />
          <div className="text-left">
            <div className={`${theme.textPrimary} text-xs font-medium`}>开发者模式</div>
            <div className={`${theme.textTertiary} text-[10px]`}>开启后可在「音效场景」页编辑内置场景参数并保存</div>
          </div>
          <Toggle checked={dev} onChange={(v) => { setDevMode(v); setDev(v) }} theme={theme} />
        </motion.div>
      </div>
    </div>
  )
}
