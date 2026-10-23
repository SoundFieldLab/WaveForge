/**
 * 模式切换过渡动画（探索 / 简约 / 传统 / 桌面 / 共振）
 *
 * 两个变体（设置 → 个性化 → 转场动画 可切换，全局生效）：
 *
 * 【simple 简易】原版加载徽章动画：极光 + 漂浮粒子 + 呼吸光环/旋转虚线圈/轨道星
 *   + 模式图标弹入 + 三点加载，全部无限循环兜底。加载机制同旧版（viewModeChanged
 *   时才拉目标 chunk）。
 *
 * 【complex 复杂 · 默认】逐帧对照 Steam 大屏幕模式启动动画重做，同构不同形：
 *   1) 深色渐晕背景首帧即不透明（盖住来源模式，任何机况都不露底）
 *   2) 模式专属「多笔画线稿」以白色粗描边逐笔画出（48×48 视窗、约 150px 居中，
 *      主描边纯白 + 轻辉光，与 Steam 手柄白描边同款质感）
 *   3) 主线稿画完后，一段模式色渐变弧线沿标志外沿扫入并无限巡游
 *      （Steam 蓝紫弧的同构：draw-on 一圈后持续巡游，慢机兜底不断片）
 *   4) 形变期浮现「黄金角螺旋散射点阵」（Steam 同款 phyllotaxis 布点，
 *      确定性生成不跳动），随后缓慢消散
 *   5) Steam 风格合成音效（WebAudio 实时合成，零音频资源），每个模式专属音色，
 *      可在设置中关闭
 *   6) 每个模式一套专属图标线稿 + 配色/背景/音色（探索=星轨罗盘、简约=声波、
 *      传统=专辑墙、桌面=工作台显示器、共振=双环共鸣）
 *   7) 退场是「变速穿越」：整层放大 + 模糊 + 淡出（cubic-bezier(.83,0,.17,1)），
 *      内层图标反向缩小，形成镜头穿过的纵深感
 *   8) 每个模式的长耗时资源（chunk / 后续歌曲的音频-歌词-封面缓存）在动画窗口内
 *      并行预加载（见 App.tsx），快机动画播完内容即热、慢机由无限循环动画兜底
 *
 * quick 档（仅复杂变体；目标模式本次会话已挂载过、内容就绪）：整体 ~0.4 倍速压紧、
 * 不显示文案/进度线，约 0.9s 完成丝滑过渡，不让用户白等。
 *
 * - 深浅色主题自适应；prefers-reduced-motion 时跳过绘制直接呈现完整图标
 * - 组件本身只负责视觉与声音；何时收起由 App 控制（目标模式已就绪 且 最短时长达标）
 */

import { useEffect, useMemo } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Compass, House, Monitor, PanelsTopLeft, Radio, Users } from 'lucide-react'
import { playModeTransitionSound } from '../services/modeTransitionSound'

export type TransitionMode = 'explore' | 'minimal' | 'traditional' | 'desktop' | 'resonance' | 'singalong' | 'inparty'

interface ModeTransitionOverlayProps {
  mode: TransitionMode | null
  theme?: 'light' | 'dark'
  /** 转场风格：'complex'（Steam 风格线稿动画，默认） | 'simple'（原版徽章） */
  variant?: 'simple' | 'complex'
  /** 快速档：目标模式内容已就绪，播放压紧版动画（仅复杂变体生效） */
  quick?: boolean
  /** 复杂变体的转场音效开关 */
  sound?: boolean
}

const MODE_META: Record<TransitionMode, { label: string; hint: string }> = {
  explore: { label: '探索', hint: '正在驶向星辰大海' },
  minimal: { label: '简约', hint: '正在整理你的音乐' },
  traditional: { label: '传统', hint: '正在铺开你的音乐馆' },
  desktop: { label: '桌面', hint: '正在铺开工作台' },
  resonance: { label: '共振', hint: '正在接入一起听房间' },
  singalong: { label: '学歌', hint: '正在打开跟唱练习室' },
  inparty: { label: 'In Party', hint: '正在打开互控派对' },
}

/**
 * 复杂变体的模式专属视觉：配色 / 背景 / 点阵色 / 弧线巡游节奏。
 * grad = 收尾弧线的渐变两色（模式识别色，对应 Steam 的蓝→紫弧）。
 */
const MODE_VISUALS: Record<TransitionMode, {
  darkBg: [string, string, string]
  auroraA: string
  auroraB: string
  grad: [string, string]
  glow: string
  dot: string
  dotLight: string
  cometDur: number
}> = {
  explore: {
    darkBg: ['#141b3f', '#0e1228', '#070a16'],
    auroraA: 'rgba(96,110,255,0.30)', auroraB: 'rgba(167,139,250,0.22)',
    grad: ['#60a5fa', '#a78bfa'], glow: 'rgba(139,180,255,0.45)',
    dot: '#8fb0ff', dotLight: '#6474b8', cometDur: 5.2,
  },
  minimal: {
    darkBg: ['#2b1f2c', '#1d1522', '#110d18'],
    auroraA: 'rgba(251,114,153,0.20)', auroraB: 'rgba(167,139,250,0.18)',
    grad: ['#fb7299', '#c084fc'], glow: 'rgba(251,114,153,0.4)',
    dot: '#ffa8c4', dotLight: '#c97ba0', cometDur: 6.4,
  },
  traditional: {
    darkBg: ['#2e2418', '#20180f', '#120d08'],
    auroraA: 'rgba(245,158,11,0.18)', auroraB: 'rgba(251,191,36,0.12)',
    grad: ['#fbbf24', '#f59e0b'], glow: 'rgba(245,158,11,0.4)',
    dot: '#fcd9a0', dotLight: '#c9a05e', cometDur: 5.6,
  },
  desktop: {
    darkBg: ['#0e2630', '#0a1a24', '#060f16'],
    auroraA: 'rgba(34,211,238,0.18)', auroraB: 'rgba(96,165,250,0.16)',
    grad: ['#22d3ee', '#60a5fa'], glow: 'rgba(34,211,238,0.4)',
    dot: '#8fe8f5', dotLight: '#5ea8bb', cometDur: 4.8,
  },
  resonance: {
    darkBg: ['#241536', '#180e26', '#0c0716'],
    auroraA: 'rgba(217,70,239,0.22)', auroraB: 'rgba(139,92,246,0.22)',
    grad: ['#e879f9', '#a78bfa'], glow: 'rgba(232,121,249,0.45)',
    dot: '#eeb0fc', dotLight: '#b57ec9', cometDur: 4.2,
  },
  singalong: {
    darkBg: ['#1d1740', '#141031', '#0a0818'],
    auroraA: 'rgba(124,92,255,0.24)', auroraB: 'rgba(52,211,153,0.16)',
    grad: ['#a78bfa', '#7c5cff'], glow: 'rgba(124,92,255,0.45)',
    dot: '#c4b5fd', dotLight: '#8f7bd8', cometDur: 4.6,
  },
  inparty: {
    darkBg: ['#241b08', '#171208', '#0a0908'],
    auroraA: 'rgba(255,232,156,0.22)', auroraB: 'rgba(255,140,90,0.16)',
    grad: ['#FFE89C', '#d9a13c'], glow: 'rgba(255,232,156,0.42)',
    dot: '#ffe9a8', dotLight: '#c9a558', cometDur: 4.4,
  },
}

/**
 * 各模式专属「多笔画线稿」（48×48 视窗，居中 24,24，渲染到约 150px）。
 * 参照 Steam 手柄的多笔画白描边：每个模式 2~5 笔，一笔一笔画出来，
 * 元素要能一眼认出模式身份，而不是通用小图标。
 * 每个形状都会加 pathLength=1 参与描边绘制动画。
 */
type IconShape =
  | { kind: 'circle'; cx: number; cy: number; r: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number; rotate?: number }
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx?: number }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'path'; d: string }

const MODE_ICONS: Record<TransitionMode, IconShape[]> = {
  // In Party = 中心节点 + 三圈电波 + 三个成员点（互控派对的意象）
  inparty: [
    { kind: 'circle', cx: 24, cy: 24, r: 3.2 },
    { kind: 'circle', cx: 24, cy: 24, r: 9 },
    { kind: 'circle', cx: 24, cy: 24, r: 15.5 },
    { kind: 'circle', cx: 36.5, cy: 12.5, r: 2 },
    { kind: 'circle', cx: 12, cy: 33, r: 2 },
    { kind: 'circle', cx: 34, cy: 36, r: 2 },
  ],
  // 探索 = 北极星 + 倾斜星轨 + 轨道上的行星（星辰大海）
  explore: [
    { kind: 'path', d: 'M24 7 L27.4 20.6 L41 24 L27.4 27.4 L24 41 L20.6 27.4 L7 24 L20.6 20.6 Z' },
    { kind: 'ellipse', cx: 24, cy: 24, rx: 19.5, ry: 7.5, rotate: -22 },
    { kind: 'circle', cx: 38.5, cy: 14.5, r: 2.2 },
  ],
  // 简约 = 一条主声波 + 一条回声波（音乐的本质曲线）
  minimal: [
    { kind: 'path', d: 'M6 24 C 11 9, 17 9, 24 24 S 37 39, 42 24' },
    { kind: 'path', d: 'M13 33 C 16.5 27.5, 20.5 27.5, 24 33 S 31.5 38.5, 35 33' },
  ],
  // 传统 = 2×2 专辑墙（铺开音乐馆）
  traditional: [
    { kind: 'rect', x: 7, y: 7, width: 15, height: 15, rx: 2.5 },
    { kind: 'rect', x: 26, y: 7, width: 15, height: 15, rx: 2.5 },
    { kind: 'rect', x: 7, y: 26, width: 15, height: 15, rx: 2.5 },
    { kind: 'rect', x: 26, y: 26, width: 15, height: 15, rx: 2.5 },
    { kind: 'circle', cx: 33.5, cy: 33.5, r: 2.4 },
  ],
  // 桌面 = 工作台显示器：屏 + 标题栏线 + 支架 + 底座
  desktop: [
    { kind: 'rect', x: 6, y: 9, width: 36, height: 24, rx: 2.5 },
    { kind: 'line', x1: 6, y1: 16.5, x2: 42, y2: 16.5 },
    { kind: 'line', x1: 24, y1: 33, x2: 24, y2: 39 },
    { kind: 'line', x1: 15, y1: 40.5, x2: 33, y2: 40.5 },
  ],
  // 共振 = 双环交叠 + 交点脉冲 + 两侧扩散波（一起听）
  resonance: [
    { kind: 'circle', cx: 18.5, cy: 24, r: 10.5 },
    { kind: 'circle', cx: 29.5, cy: 24, r: 10.5 },
    { kind: 'circle', cx: 24, cy: 24, r: 2.6 },
    { kind: 'path', d: 'M7.5 13.5 A 15 15 0 0 0 7.5 34.5' },
    { kind: 'path', d: 'M40.5 13.5 A 15 15 0 0 1 40.5 34.5' },
  ],
  // 学歌 = 麦克风 + 声波弧（逐句跟学）
  singalong: [
    { kind: 'rect', x: 18.5, y: 7, width: 11, height: 19, rx: 5.5 },
    { kind: 'line', x1: 24, y1: 26, x2: 24, y2: 33 },
    { kind: 'line', x1: 17.5, y1: 33, x2: 30.5, y2: 33 },
    { kind: 'path', d: 'M14 24 A 10 10 0 0 0 14 24.01' },
    { kind: 'path', d: 'M34 24 A 10 10 0 0 1 34 24.01' },
  ],
}

/** 自定义 CSS 变量并入 style（TS 的 CSSProperties 不带索引签名，统一收口转换） */
const cssVars = (vars: Record<string, string | number>) => vars as React.CSSProperties

export default function ModeTransitionOverlay({ mode, theme = 'dark', variant = 'complex', quick = false, sound = true }: ModeTransitionOverlayProps) {
  if (variant === 'simple') {
    return <SimpleOverlay mode={mode} theme={theme} />
  }
  return <ComplexOverlay mode={mode} theme={theme} quick={quick} sound={sound} />
}

// ═══════════════════════════ simple：原版加载徽章动画 ═══════════════════════════

const SIMPLE_PARTICLE_COUNT = 16

function SimpleOverlay({ mode, theme }: { mode: TransitionMode | null; theme: 'light' | 'dark' }) {
  const dark = theme !== 'light'

  // 粒子位置：确定性生成（避免每次渲染重新随机导致跳动）
  const particles = useMemo(
    () =>
      Array.from({ length: SIMPLE_PARTICLE_COUNT }, (_, i) => {
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
          key="mode-transition-simple"
          // 过渡遮罩盖住全屏：不加 data-tv-skip 时 tvCore 的 elementFromPoint 命中判定会把
          // 所有底层候选都判为不可命中，3–12 秒的过渡期间遥控完全失灵。标记后焦点导航忽略它
          //（鼠标点击/触摸仍被遮罩挡住，交互语义不变）。
          data-tv-skip=""
          // 首帧即不透明：任何模式内容都不能透过过渡动画露出来
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
                {/* 共振：同心环图标（与侧栏入口、房间头图同一套视觉），此前这一档没有图标会留一个空环 */}
                {mode === 'resonance' && <Radio size={52} strokeWidth={1.6} style={{ color: accent }} />}
                {mode === 'inparty' && <Users size={52} strokeWidth={1.6} style={{ color: accent }} />}
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

// ═══════════════════════════ complex：Steam 风线稿动画 ═══════════════════════════

/** 黄金角（phyllotaxis / 向日葵螺旋）——Steam 点阵的布点方式 */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
/** 点阵总数（铺满约 1.5 倍图标高度的圆形区域，中心密外围疏的自然散射） */
const DOT_COUNT = 240

function ComplexOverlay({ mode, theme, quick, sound }: { mode: TransitionMode | null; theme: 'light' | 'dark'; quick: boolean; sound: boolean }) {
  const dark = theme !== 'light'
  // quick 档整体时间压缩系数：线稿/弧线/点阵全部按 k 缩放，~0.9s 内播完主线
  const k = quick ? 0.38 : 1

  // 转场音效：复杂变体 + 开关打开时，随动画出现播放（每个模式专属音色）
  useEffect(() => {
    if (!mode || !sound) return
    playModeTransitionSound(mode)
  }, [mode, sound])

  const visual = mode ? MODE_VISUALS[mode] : null

  // 黄金角螺旋点阵：r = R·√(i/N) 均匀铺开、带固定微扰动，确定性生成不跳动。
  // 形变期浮现、随后缓慢消散（Steam 同款节奏），坐标存为容器百分比。
  const dots = useMemo(() => {
    const list: Array<{ xPct: number; yPct: number; size: number; opacity: number }> = []
    for (let i = 0; i < DOT_COUNT; i++) {
      const r01 = Math.sqrt((i + 0.5) / DOT_COUNT)
      const angle = i * GOLDEN_ANGLE
      const seed = (i * 31 + 17) % 97
      list.push({
        xPct: 50 + Math.cos(angle) * r01 * 48,
        yPct: 50 + Math.sin(angle) * r01 * 48 * 0.82,
        size: 2 + (seed % 3) * 0.7,
        // 中心稍亮、外围稍淡 + 微随机
        opacity: (0.5 - r01 * 0.24) * (0.65 + ((seed % 5) / 5) * 0.35),
      })
    }
    return list
  }, [])

  const meta = mode ? MODE_META[mode] : null
  const shapes = mode ? MODE_ICONS[mode] : null
  const accent = visual ? visual.grad[1] : '#fb7299'
  const cometDur = visual?.cometDur ?? 5.2
  // 主描边：Steam 同款纯白粗描边（浅色主题用深色）
  const mainStroke = dark ? '#ffffff' : '#1c2030'
  const dotColor = visual ? (dark ? visual.dot : visual.dotLight) : '#8fb0ff'

  return (
    <AnimatePresence>
      {mode && meta && shapes && visual && (
        <motion.div
          key="mode-transition-complex"
          // 过渡遮罩盖住全屏：不加 data-tv-skip 时 tvCore 的 elementFromPoint 命中判定会把
          // 所有底层候选都判为不可命中，过渡期间遥控完全失灵。标记后焦点导航忽略它
          //（鼠标点击/触摸仍被遮罩挡住，交互语义不变）。
          data-tv-skip=""
          // 首帧即不透明：任何模式内容都不能透过过渡动画露出来
          initial={{ opacity: 1 }}
          animate={{ opacity: 1 }}
          // 退场「变速穿越」：整层放大 + 模糊 + 淡出，镜头穿过图标飞向新模式
          exit={{
            opacity: 0,
            scale: 1.16,
            filter: 'blur(12px)',
            transition: { duration: 0.55, ease: [0.83, 0, 0.17, 1] },
          }}
          className="fixed inset-0 z-[9998] flex flex-col items-center justify-center overflow-hidden"
          style={{
            background: dark
              ? `radial-gradient(120% 90% at 50% 110%, ${visual.darkBg[0]} 0%, ${visual.darkBg[1]} 42%, ${visual.darkBg[2]} 100%)`
              : 'radial-gradient(120% 90% at 50% 110%, #fdf2f6 0%, #eef1f8 42%, #e6e9f3 100%)',
            color: dark ? '#fff' : '#1c2030',
          }}
          aria-label={`正在切换至${meta.label}模式`}
        >
          {/* 极光背景：两团模式色模糊光斑缓慢漂移（无限循环，兜底不断片） */}
          <div className="absolute inset-0 pointer-events-none" aria-hidden="true">
            <div
              className="wm-aurora"
              style={{
                width: '70vmax',
                height: '70vmax',
                left: '-15vmax',
                top: '-20vmax',
                background: `radial-gradient(circle, ${visual.auroraA}, transparent 60%)`,
              }}
            />
            <div
              className="wm-aurora wm-aurora-2"
              style={{
                width: '60vmax',
                height: '60vmax',
                right: '-18vmax',
                bottom: '-22vmax',
                background: `radial-gradient(circle, ${visual.auroraB}, transparent 60%)`,
              }}
            />
            {/* 黄金角螺旋点阵：形变期浮现、随后缓慢消散（Steam 同款）。
                容器取 92vmin 见方居中；坐标为容器百分比 */}
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ width: '92vmin', height: '92vmin' }} aria-hidden="true">
              {dots.map((d, i) => (
                <span
                  key={`dot-${i}`}
                  className="wm-dot-field"
                  style={{
                    left: `${d.xPct}%`,
                    top: `${d.yPct}%`,
                    width: d.size,
                    height: d.size,
                    opacity: 0,
                    ...cssVars({ '--wm-o': d.opacity }),
                    animationDelay: `${(1.05 + (i % 40) * 0.008) * k}s`,
                    animationDuration: '4.2s',
                    transform: 'translate(-50%, -50%)',
                    background: dotColor,
                    boxShadow: dark ? `0 0 4px ${dotColor}66` : 'none',
                  }}
                />
              ))}
            </div>
          </div>

          {/* 中央舞台：多笔画线稿 + 模式色渐变弧扫（大小对齐 Steam：约 150px 居中） */}
          <motion.div
            className="relative flex flex-col items-center justify-center"
            aria-hidden="true"
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ duration: 0.5 * k, ease: [0.22, 1, 0.36, 1] }}
            exit={{ scale: 0.9, opacity: 0, transition: { duration: 0.3, ease: 'easeIn' } }}
          >
            <motion.svg
              key={mode}
              viewBox="0 0 48 48"
              className="relative z-10 block"
              style={{
                width: 150,
                height: 150,
                filter: `drop-shadow(0 0 12px ${visual.glow})`,
              }}
              fill="none"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              initial={{ opacity: 0, scale: 0.94 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4 * k }}
            >
              <defs>
                <linearGradient id="wm-arc-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" stopColor={visual.grad[0]} />
                  <stop offset="100%" stopColor={visual.grad[1]} />
                </linearGradient>
              </defs>

              {/* 模式专属线稿：白色粗描边逐笔画出（Steam 手柄同款质感） */}
              {shapes.map((s, i) => {
                const common = {
                  pathLength: 1 as const,
                  className: 'wm-stroke',
                  stroke: mainStroke,
                  style: cssVars({
                    '--d': `${(0.3 + i * 0.18) * k}s`,
                    '--wd': `${0.72 * k}s`,
                  }),
                }
                if (s.kind === 'circle') return <circle key={i} cx={s.cx} cy={s.cy} r={s.r} {...common} />
                if (s.kind === 'ellipse') {
                  return (
                    <ellipse
                      key={i}
                      cx={s.cx}
                      cy={s.cy}
                      rx={s.rx}
                      ry={s.ry}
                      transform={s.rotate ? `rotate(${s.rotate} ${s.cx} ${s.cy})` : undefined}
                      {...common}
                    />
                  )
                }
                if (s.kind === 'rect') return <rect key={i} x={s.x} y={s.y} width={s.width} height={s.height} rx={s.rx} {...common} />
                if (s.kind === 'line') return <line key={i} x1={s.x1} y1={s.y1} x2={s.x2} y2={s.y2} {...common} />
                return <path key={i} d={s.d} {...common} />
              })}

              {/* 收尾弧线：主稿画完后沿标志外沿扫入，之后作为模式色弧段无限巡游
                  （Steam 蓝紫弧同构；draw-on 后持续环绕，慢机加载多久都不会断片） */}
              <circle
                cx="24" cy="24" r="22"
                pathLength={1}
                className="wm-arc"
                stroke="url(#wm-arc-grad)"
                strokeWidth="2.2"
                strokeLinecap="round"
                style={{
                  animationDelay: `${1.7 * k}s`,
                  animationDuration: `${cometDur}s`,
                  filter: `drop-shadow(0 0 6px ${visual.glow})`,
                }}
              />
            </motion.svg>
          </motion.div>

          {/* 完整档才显示文案 + 进度线（quick 档保持纯净的图形过渡） */}
          {!quick && (
            <motion.div
              className="relative z-10 flex flex-col items-center"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.9 * k, duration: 0.5, ease: 'easeOut' }}
            >
              <div className="text-center">
                <h2 className="text-xl font-bold tracking-wide" style={{ color: dark ? '#fff' : '#1c2030' }}>
                  正在切换至
                  <span style={{ color: accent }}>{meta.label}</span>
                  模式
                </h2>
                <p className="mt-1.5 text-sm" style={{ color: dark ? 'rgba(255,255,255,0.5)' : 'rgba(28,32,48,0.55)' }}>
                  {meta.hint}
                </p>
              </div>

              {/* 流光进度线：无限循环（不是真实进度，慢机加载多久都在流动） */}
              <div className="wm-progress mt-7" aria-hidden="true">
                <span className="wm-progress-sheen" style={{ background: `linear-gradient(90deg, transparent, ${accent}, transparent)` }} />
              </div>
            </motion.div>
          )}

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

            /* 描边绘制：pathLength=1 归一化，dashoffset 1 -> 0 逐笔画出 */
            @keyframes wm-draw { to { stroke-dashoffset: 0; } }
            .wm-stroke {
              fill: none;
              stroke-dasharray: 1;
              stroke-dashoffset: 1;
              animation: wm-draw var(--wd, 0.72s) cubic-bezier(0.65, 0, 0.35, 1) var(--d, 0s) forwards;
            }
            /* 收尾弧线：dasharray 0.26/0.74 的弧段，先扫入一圈（前 20% 时长），
               之后持续巡游（dashoffset 持续前进 = 弧段绕标志转圈），无限循环兜底。
               fill-mode: both 让延迟期间保持 0% 帧的 opacity:0 */
            @keyframes wm-arc-run {
              0% { stroke-dashoffset: 1; opacity: 0; }
              5% { opacity: 1; }
              20% { stroke-dashoffset: 0; }
              100% { stroke-dashoffset: -2; opacity: 1; }
            }
            .wm-arc {
              stroke-dasharray: 0.26 0.74;
              stroke-dashoffset: 1;
              opacity: 0;
              animation: wm-arc-run 5.2s linear infinite both;
            }

            /* 点阵浮现→缓慢消散：淡入到目标透明度后衰减到约 1/3（Steam 节奏） */
            @keyframes wm-dot-in {
              0% { opacity: 0; }
              30% { opacity: var(--wm-o, 0.3); }
              100% { opacity: calc(var(--wm-o, 0.3) * 0.35); }
            }
            .wm-dot-field {
              position: absolute;
              border-radius: 50%;
              animation: wm-dot-in ease-out both;
              will-change: opacity;
            }

            /* 流光进度线 */
            .wm-progress { position: relative; width: 190px; height: 2px; border-radius: 2px; overflow: hidden; background: rgba(128,128,160,0.18); }
            @keyframes wm-sheen { 0% { transform: translateX(-130%); } 100% { transform: translateX(340%); } }
            .wm-progress-sheen { position: absolute; inset: 0; width: 42%; animation: wm-sheen 1.5s ease-in-out infinite; will-change: transform; }

            @media (prefers-reduced-motion: reduce) {
              .wm-stroke { animation: none !important; stroke-dashoffset: 0 !important; }
              .wm-dot-field { animation: none !important; opacity: calc(var(--wm-o, 0.3) * 0.5) !important; }
              .wm-arc { animation: none !important; opacity: 1 !important; stroke-dashoffset: 0 !important; }
              .wm-aurora, .wm-progress-sheen { animation: none !important; }
            }
          `}</style>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
