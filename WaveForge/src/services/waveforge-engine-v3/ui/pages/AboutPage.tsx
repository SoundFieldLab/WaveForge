/**
 * 关于页 —— HyperSoundEngine 品牌信息（Logo 动画 + 微光背景 + 三行信息）
 */

import { motion } from 'framer-motion'
import type { HSETheme } from '../hse-theme'

interface AboutPageProps {
  theme: HSETheme
}

export default function AboutPage({ theme }: AboutPageProps) {
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
      </div>
    </div>
  )
}
