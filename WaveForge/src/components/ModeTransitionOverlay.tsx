/**
 * 模式切换过渡动画（探索 / 简约 / 桌面）
 *
 * 模式切换时全屏覆盖加载动画，掩盖新模式挂载/数据加载带来的 1~3s（慢机 5~10s）卡顿。
 * - 所有内部动画均为无限循环（CSS keyframes），慢机加载多久都不会"断片"
 * - 中央徽章按模式区分风格：探索=罗盘旋转+轨道星、简约=呼吸光环、桌面=显示器+光标弹跳
 * - 深浅色主题自适应
 * - 组件本身只负责视觉；何时收起由 App 控制（目标模式已就绪 且 最短时长 ≥3s）
 */

import { useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Compass, House, Monitor, PanelsTopLeft } from 'lucide-react'

export type TransitionMode = 'explore' | 'minimal' | 'traditional' | 'desktop'

interface ModeTransitionOverlayProps {
  mode: TransitionMode | null
  theme?: 'light' | 'dark'
}

const MODE_META: Record<TransitionMode, { label: string; hint: string }> = {
  explore: { label: '探索', hint: '正在驶向星辰大海' },
  minimal: { label: '简约', hint: '正在整理你的音乐' },
  traditional: { label: '传统', hint: '正在铺开你的音乐馆' },
  desktop: { label: '桌面', hint: '正在铺开工作台' },
}

const PARTICLE_COUNT = 16

export default function ModeTransitionOverlay({ mode, theme = 'dark' }: ModeTransitionOverlayProps) {
  const dark = theme !== 'light'

  // 粒子位置：确定性生成（避免每次渲染重新随机导致跳动）
  const particles = useMemo(
    () =>
      Array.from({ length: PARTICLE_COUNT }, (_, i) => {
        const seed = (i * 2654435761) % 10000
        const seed2 = (i * 40503) % 10000
        return {
          left: `${(seed % 100)}%`,
          top: `${(seed2 % 100)}%`,
          size: 2 + ((seed >> 4) % 3),
          delay: `${(seed % 6) * 0.6}s`,
          duration: `${5 + (seed % 5)}s`,
          opacity: 0.25 + ((seed2 >> 3) % 4) * 0.15,
        }
      }),
    [],
  )

  const meta = mode ? MODE_META[mode] : null
  const accent = dark ? 'rgba(251,114,153,0.85)' : 'rgba(236,72,153,0.85)'

  return (
    <AnimatePresence>
      {mode && meta && (
        <motion.div
          key="mode-transition"
          // 首帧即不透明：任何模式内容都不能透过过渡动画露出来（此前从 opacity:0 淡入，
          // 新模式挂载快的机器会在动画半透明阶段露出目标页面）
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.35 } }}
          className="fixed inset-0 z-[9998] flex flex-col items-center justify-center overflow-hidden"
          style={{
            background: dark
              ? 'radial-gradient(120% 90% at 50% 110%, #1b2140 0%, #101426 42%, #0a0d18 100%)'
              : 'radial-gradient(120% 90% at 50% 110%, #fdf2f6 0%, #eef1f8 42%, #e6e9f3 100%)',
            color: dark ? '#fff' : '#1c2030',
          }}
          aria-label={`正在切换至${meta.label}模式`}
        >
          {/* 极光背景：两团模糊光斑缓慢漂移（无限循环） */}
          <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
            <div
              className="wm-aurora"
              style={{
                width: '70vmax',
                height: '70vmax',
                left: '-15vmax',
                top: '-20vmax',
                background: dark
                  ? 'radial-gradient(circle, rgba(114,96,255,0.34), transparent 60%)'
                  : 'radial-gradient(circle, rgba(129,120,255,0.32), transparent 60%)',
              }}
            />
            <div
              className="wm-aurora wm-aurora-2"
              style={{
                width: '60vmax',
                height: '60vmax',
                right: '-18vmax',
                bottom: '-22vmax',
                background: dark
                  ? 'radial-gradient(circle, rgba(251,114,153,0.26), transparent 60%)'
                  : 'radial-gradient(circle, rgba(251,114,153,0.28), transparent 60%)',
              }}
            />
            {/* 漂浮粒子（星星） */}
            {particles.map((p, i) => (
              <span
                key={i}
                className="wm-particle"
                style={{
                  left: p.left,
                  top: p.top,
                  width: p.size,
                  height: p.size,
                  opacity: p.opacity,
                  animationDelay: p.delay,
                  animationDuration: p.duration,
                  background: dark ? '#fff' : '#7c7f9e',
                  boxShadow: dark ? '0 0 6px rgba(255,255,255,0.8)' : '0 0 6px rgba(124,127,158,0.8)',
                }}
              />
            ))}
          </div>

          {/* 中央徽章 */}
          <div className="relative flex flex-col items-center justify-center" aria-hidden="true">
            <div className="relative w-28 h-28 flex items-center justify-center">
              {/* 呼吸光晕 */}
              <div
                className="wm-halo"
                style={{ border: `2px solid ${accent}`, boxShadow: `0 0 34px ${dark ? 'rgba(251,114,153,0.35)' : 'rgba(236,72,153,0.3)'}` }}
              />
              {/* 旋转虚线圈 */}
              <div className="wm-spin-ring" style={{ border: `1.5px dashed ${dark ? 'rgba(255,255,255,0.35)' : 'rgba(28,32,48,0.3)'}` }} />
              {/* 轨道星 */}
              <div className="wm-orbit">
                <span className="wm-orbit-dot" style={{ background: accent, boxShadow: `0 0 10px ${accent}` }} />
              </div>
              {/* 模式图标 */}
              <motion.div
                key={mode}
                initial={{ scale: 0.6, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 260, damping: 22 }}
                className="relative z-10"
              >
                {mode === 'explore' && <Compass size={52} strokeWidth={1.6} style={{ color: accent }} />}
                {mode === 'minimal' && <House size={52} strokeWidth={1.6} style={{ color: accent }} />}
                {mode === 'traditional' && <PanelsTopLeft size={52} strokeWidth={1.6} style={{ color: accent }} />}
                {mode === 'desktop' && <Monitor size={52} strokeWidth={1.6} style={{ color: accent }} />}
              </motion.div>
            </div>

            {/* 标题 */}
            <div className="mt-7 text-center">
              <h2 className="text-xl font-bold tracking-wide" style={{ color: dark ? '#fff' : '#1c2030' }}>
                正在切换至
                <span style={{ color: accent }}>{meta.label}</span>
                模式
              </h2>
              <p className="mt-1.5 text-sm" style={{ color: dark ? 'rgba(255,255,255,0.5)' : 'rgba(28,32,48,0.55)' }}>
                {meta.hint}
              </p>
            </div>

            {/* 三点加载（无限循环） */}
            <div className="mt-6 flex items-center gap-1.5" aria-hidden="true">
              <span className="wm-dot" style={{ animationDelay: '0s', background: accent }} />
              <span className="wm-dot" style={{ animationDelay: '0.18s', background: accent }} />
              <span className="wm-dot" style={{ animationDelay: '0.36s', background: accent }} />
            </div>
          </div>

          <style>{`
            @keyframes wm-aurora-a {
              0%, 100% { transform: translate(0, 0) scale(1); }
              50% { transform: translate(9vmax, 5vmax) scale(1.18); }
            }
            @keyframes wm-aurora-b {
              0%, 100% { transform: translate(0, 0) scale(1); }
              50% { transform: translate(-8vmax, -6vmax) scale(1.14); }
            }
            .wm-aurora { position: absolute; border-radius: 50%; animation: wm-aurora-a 11s ease-in-out infinite; will-change: transform; }
            .wm-aurora-2 { animation-name: wm-aurora-b; animation-duration: 13s; }

            @keyframes wm-float {
              0%, 100% { transform: translateY(0); opacity: 0.25; }
              50% { transform: translateY(-26px); opacity: 0.9; }
            }
            .wm-particle { position: absolute; border-radius: 50%; animation: wm-float 6s ease-in-out infinite; will-change: transform, opacity; }

            @keyframes wm-halo-pulse {
              0%, 100% { transform: scale(0.82); opacity: 0.45; }
              50% { transform: scale(1.06); opacity: 0.9; }
            }
            .wm-halo { position: absolute; inset: -6px; border-radius: 50%; animation: wm-halo-pulse 2.4s ease-in-out infinite; }

            @keyframes wm-ring-spin {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
            .wm-spin-ring { position: absolute; inset: -20px; border-radius: 50%; animation: wm-ring-spin 5s linear infinite; }

            @keyframes wm-orbit-rotate {
              from { transform: rotate(0deg); }
              to { transform: rotate(360deg); }
            }
            .wm-orbit { position: absolute; inset: -38px; border-radius: 50%; animation: wm-orbit-rotate 3.2s linear infinite; }
            .wm-orbit-dot { position: absolute; top: 0; left: 50%; width: 8px; height: 8px; margin-left: -4px; border-radius: 50%; }

            @keyframes wm-dot-bounce {
              0%, 80%, 100% { transform: translateY(0); opacity: 0.4; }
              40% { transform: translateY(-9px); opacity: 1; }
            }
            .wm-dot { width: 9px; height: 9px; border-radius: 50%; animation: wm-dot-bounce 1.2s ease-in-out infinite; }
          `}</style>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
