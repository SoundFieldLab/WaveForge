/**
 * WaveForge v3 调音室 UI —— 动态/调音类效果配置弹窗
 *
 * 动态压缩、齿音抑制、夜间模式、限幅器、智能均衡（IEQ）、变速变调、立体声宽度。
 * 视觉与交互沿用 v1/v2 弹窗规范（glass 面板 + wf-glass-range + 胶囊开关）。
 */

import { useRef } from 'react'
import { Activity, Mic2, Moon, Shield, Sparkles, Music, Columns2 } from 'lucide-react'
import type { V3Theme } from './theme'
import { InfoLine, Modal, Segmented, Slider, Toggle } from './primitives'
import type { V3ParamsController } from './hooks'

/* ─────────────────────────── X-Y 触控板（声场拟物化） ─────────────────────────── */

/** 二维触控板：X/Y 双参数同时拖拽，替代两个独立左右滑块（规划书 B4「拟物化旋钮」） */
function XYPad({ x, y, xMin, xMax, yMin, yMax, xCenter, yCenter, onChange, theme, xLabels, yLabels }: {
  x: number
  y: number
  xMin: number
  xMax: number
  yMin: number
  yMax: number
  xCenter: number
  yCenter: number
  onChange: (x: number, y: number) => void
  theme: V3Theme
  xLabels: { pos: number; label: string }[]
  yLabels: { pos: number; label: string }[]
}) {
  const ref = useRef<HTMLDivElement>(null)
  const xPct = ((x - xMin) / (xMax - xMin)) * 100
  const yPct = (1 - (y - yMin) / (yMax - yMin)) * 100
  const cxPct = ((xCenter - xMin) / (xMax - xMin)) * 100
  const cyPct = (1 - (yCenter - yMin) / (yMax - yMin)) * 100

  const handle = (clientX: number, clientY: number) => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    const fx = Math.max(0, Math.min(1, (clientX - r.left) / r.width))
    const fy = Math.max(0, Math.min(1, (clientY - r.top) / r.height))
    const nx = xMin + fx * (xMax - xMin)
    const ny = yMin + (1 - fy) * (yMax - yMin)
    onChange(Math.round(nx * 100) / 100, Math.round(ny * 100) / 100)
  }

  return (
    <div className="relative w-full rounded-xl overflow-hidden touch-none select-none" style={{ height: 180, background: 'rgba(255,255,255,0.04)', border: `1px solid ${theme.glassBorder}` }}>
      <div
        ref={ref}
        className="absolute inset-0 cursor-crosshair"
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); handle(e.clientX, e.clientY) }}
        onPointerMove={(e) => { if (e.buttons === 1) handle(e.clientX, e.clientY) }}
      >
        {/* 网格 */}
        {[25, 50, 75].map((p) => (
          <div key={`v${p}`} className="absolute top-0 bottom-0" style={{ left: `${p}%`, width: 1, background: 'rgba(255,255,255,0.06)' }} />
        ))}
        {[25, 50, 75].map((p) => (
          <div key={`h${p}`} className="absolute left-0 right-0" style={{ top: `${p}%`, height: 1, background: 'rgba(255,255,255,0.06)' }} />
        ))}
        {/* 中心十字（原声基准点） */}
        <div className="absolute top-0 bottom-0" style={{ left: `${cxPct}%`, width: 1, background: `${theme.accentColor}66` }} />
        <div className="absolute left-0 right-0" style={{ top: `${cyPct}%`, height: 1, background: `${theme.accentColor}66` }} />
        {/* 拖拽手柄 + 辉光 */}
        <div
          className="absolute rounded-full"
          style={{
            left: `${xPct}%`, top: `${yPct}%`, width: 16, height: 16, transform: 'translate(-50%, -50%)',
            background: theme.accentColor, boxShadow: `0 0 14px ${theme.accentColor}, 0 0 0 4px ${theme.accentColor}33`,
            transition: 'box-shadow 0.15s ease',
          }}
        />
        {/* 手柄到中心的连线（直观显示偏离原声的程度） */}
        <svg className="absolute inset-0 pointer-events-none" preserveAspectRatio="none" style={{ width: '100%', height: '100%' }}>
          <line x1={`${cxPct}%`} y1={`${cyPct}%`} x2={`${xPct}%`} y2={`${yPct}%`} stroke={theme.accentColor} strokeWidth={1} strokeDasharray="3 3" opacity={0.6} />
        </svg>
      </div>
      {/* 轴标签 */}
      <div className="absolute left-1.5 top-1/2 -translate-y-1/2 flex flex-col gap-0.5 pointer-events-none">
        {yLabels.map((l) => <span key={l.label} className="text-[9px] text-white/40">{l.label}</span>)}
      </div>
      <div className="absolute bottom-1 left-1/2 -translate-x-1/2 flex gap-3 pointer-events-none">
        {xLabels.map((l) => <span key={l.label} className="text-[9px] text-white/40">{l.label}</span>)}
      </div>
    </div>
  )
}

/* ─────────────────────────── 压缩传输曲线（参数可视化，规划书 B4） ─────────────────────────── */

/** 软拐点压缩输入→输出传输曲线 SVG；电平点沿曲线循环扫动（"增益衰减仪表盘跳动"） */
function CompressorCurve({ thresholdDb, ratio, kneeDb, makeupDb, theme }: {
  thresholdDb: number
  ratio: number
  kneeDb: number
  makeupDb: number
  theme: V3Theme
}) {
  const xMin = -60, xMax = 0
  const xPx = (db: number) => 10 + ((db - xMin) / (xMax - xMin)) * 95
  const yPx = (db: number) => 70 - ((db + makeupDb - xMin) / (xMax - xMin)) * 62
  const lo = thresholdDb - kneeDb / 2
  const hi = thresholdDb + kneeDb / 2
  const transfer = (x: number): number => {
    if (kneeDb <= 0.01) return x <= thresholdDb ? x : thresholdDb + (x - thresholdDb) / ratio
    if (x <= lo) return x
    if (x >= hi) return thresholdDb + (x - thresholdDb) / ratio
    const xW = (x - lo) / kneeDb
    const above = thresholdDb + (x - thresholdDb) / ratio
    return x + xW * xW * (above - x)
  }
  const pts: string[] = []
  for (let i = 0; i <= 40; i++) {
    const xd = xMin + (i / 40) * (xMax - xMin)
    pts.push(`${xPx(xd).toFixed(2)},${yPx(transfer(xd)).toFixed(2)}`)
  }
  const curvePath = `M${pts.join(' L')}`
  const unityPath = `M${xPx(xMin)},${yPx(xMin)} L${xPx(xMax)},${yPx(xMax)}`
  return (
    <div className="relative w-full rounded-xl overflow-hidden mb-3" style={{ background: 'rgba(255,255,255,0.03)', border: `1px solid ${theme.glassBorder}`, padding: 4 }}>
      <svg viewBox="0 0 110 80" className="w-full" style={{ height: 92 }}>
        {/* 网格 */}
        {[-40, -20].map((db) => <line key={`v${db}`} x1={xPx(db)} y1={8} x2={xPx(db)} y2={70} stroke="rgba(255,255,255,0.06)" strokeWidth={0.5} />)}
        {/* 1:1 参考线 */}
        <path d={unityPath} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={0.8} strokeDasharray="3 3" />
        {/* 阈值竖线 */}
        <line x1={xPx(thresholdDb)} y1={8} x2={xPx(thresholdDb)} y2={70} stroke={`${theme.accentColor}66`} strokeWidth={0.8} strokeDasharray="2 2" />
        {/* 传输曲线 */}
        <path id="hse-comp-curve" d={curvePath} fill="none" stroke={theme.accentColor} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 3px ${theme.accentColor}66)` }} />
        {/* 扫动电平点（沿曲线循环跳动） */}
        <circle r={2.6} fill={theme.accentColor} style={{ filter: `drop-shadow(0 0 4px ${theme.accentColor})` }}>
          <animateMotion dur="2.8s" repeatCount="indefinite" rotate="auto">
            <mpath href="#hse-comp-curve" />
          </animateMotion>
        </circle>
        {/* 标签 */}
        <text x={xPx(thresholdDb)} y={76} textAnchor="middle" fontSize={6} fill={`${theme.accentColor}cc`}>T={thresholdDb}</text>
        <text x={10} y={76} textAnchor="start" fontSize={6} fill="rgba(255,255,255,0.4)">输入 dB →</text>
        <text x={106} y={12} textAnchor="end" fontSize={6} fill="rgba(255,255,255,0.4)">↑ 输出 dB</text>
      </svg>
    </div>
  )
}

/* ─────────────────────────── 动态压缩 ─────────────────────────── */

export function CompressorModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const c = params.compressor
  return (
    <Modal title="动态压缩" icon={<Activity className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>软拐点压缩器压平音量起伏，让轻的部分更清晰、重的部分不爆。</p>
      <CompressorCurve thresholdDb={c.thresholdDb} ratio={c.ratio} kneeDb={c.kneeDb} makeupDb={c.makeupDb} theme={theme} />
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 动态压缩</span>
        <Toggle checked={c.enabled} onChange={(v) => patch({ compressor: { ...c, enabled: v } })} theme={theme} />
      </div>
      <Slider label="阈值" value={c.thresholdDb} min={-60} max={0} step={1} onChange={(v) => patch({ compressor: { ...c, thresholdDb: v } })} display={`${c.thresholdDb}dB`} theme={theme} />
      <Slider label="比率" value={c.ratio} min={1} max={20} step={0.5} onChange={(v) => patch({ compressor: { ...c, ratio: v } })} display={`${c.ratio.toFixed(1)}:1`} theme={theme} />
      <Slider label="拐点宽度" value={c.kneeDb} min={0} max={20} step={0.5} onChange={(v) => patch({ compressor: { ...c, kneeDb: v } })} display={`${c.kneeDb.toFixed(1)}dB`} theme={theme} />
      <Slider label="起始时间" value={c.attackMs} min={0} max={100} step={1} onChange={(v) => patch({ compressor: { ...c, attackMs: v } })} display={`${c.attackMs}ms`} theme={theme} />
      <Slider label="释放时间" value={c.releaseMs} min={10} max={1000} step={10} onChange={(v) => patch({ compressor: { ...c, releaseMs: v } })} display={`${c.releaseMs}ms`} theme={theme} />
      <Slider label="补偿增益" value={c.makeupDb} min={0} max={12} step={0.5} onChange={(v) => patch({ compressor: { ...c, makeupDb: v } })} display={`+${c.makeupDb.toFixed(1)}dB`} theme={theme} />
      <Slider label="输出增益" value={c.outputGain} min={0} max={2} step={0.05} onChange={(v) => patch({ compressor: { ...c, outputGain: v } })} display={`${c.outputGain.toFixed(2)}x`} theme={theme} />
    </Modal>
  )
}

/* ─────────────────────────── 齿音抑制 ─────────────────────────── */

export function DeesserModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const d = params.deesser
  return (
    <Modal title="齿音抑制" icon={<Mic2 className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>侧链带通检测 4-8kHz 齿音频段（s/z 音）并动态压低，消除刺耳齿音。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 齿音抑制</span>
        <Toggle checked={d.enabled} onChange={(v) => patch({ deesser: { ...d, enabled: v } })} theme={theme} />
      </div>
      <Segmented
        options={[
          { value: true as const, label: '分带式（推荐）' },
          { value: false as const, label: '宽带式' },
        ]}
        value={d.splitBand}
        onChange={(v) => patch({ deesser: { ...d, splitBand: v } })}
        theme={theme}
        small
      />
      <Slider label="中心频率" value={d.centerHz} min={2000} max={10000} step={100} onChange={(v) => patch({ deesser: { ...d, centerHz: v } })} display={`${d.centerHz >= 1000 ? (d.centerHz / 1000).toFixed(1) + 'k' : d.centerHz}Hz`} theme={theme} />
      <Slider label="触发阈值" value={d.thresholdDb} min={-50} max={0} step={1} onChange={(v) => patch({ deesser: { ...d, thresholdDb: v } })} display={`${d.thresholdDb}dB`} theme={theme} />
      <Slider label="压缩比率" value={d.ratio} min={1} max={20} step={0.5} onChange={(v) => patch({ deesser: { ...d, ratio: v } })} display={`${d.ratio.toFixed(1)}:1`} theme={theme} />
      <Slider label="起始时间" value={d.attackMs} min={0} max={10} step={0.1} onChange={(v) => patch({ deesser: { ...d, attackMs: v } })} display={`${d.attackMs.toFixed(1)}ms`} theme={theme} />
      <Slider label="释放时间" value={d.releaseMs} min={10} max={300} step={5} onChange={(v) => patch({ deesser: { ...d, releaseMs: v } })} display={`${d.releaseMs}ms`} theme={theme} />
      <Slider label="效果混合" value={d.mix} min={0} max={1} step={0.01} onChange={(v) => patch({ deesser: { ...d, mix: v } })} display={`${Math.round(d.mix * 100)}%`} theme={theme} />
    </Modal>
  )
}

/* ─────────────────────────── 夜间模式 ─────────────────────────── */

export function NightModeModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const n = params.nightMode
  return (
    <Modal title="夜间模式" icon={<Moon className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>动态压缩增强 + 6kHz 高频衰减：深夜低音量听感不刺耳、不吵人。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 夜间模式</span>
        <Toggle checked={n.enabled} onChange={(v) => patch({ nightMode: { ...n, enabled: v } })} theme={theme} />
      </div>
      <Slider label="强度" value={n.amount} min={0} max={10} step={1} onChange={(v) => patch({ nightMode: { ...n, amount: v } })} display={`${n.amount} 级`} theme={theme} />
      <InfoLine theme={theme}>强度为 0 时等效关闭；建议与音量自适应补偿同开，低音量听感更平衡。</InfoLine>
    </Modal>
  )
}

/* ─────────────────────────── 限幅器 ─────────────────────────── */

export function LimiterModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const l = params.limiter
  return (
    <Modal title="限幅器" icon={<Shield className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>前瞻式限幅保护输出：默认 -1dBFS 阈值，杜绝削波；真峰值检测为 4× 过采样。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 限幅器</span>
        <Toggle checked={l.enabled} onChange={(v) => patch({ limiter: { ...l, enabled: v } })} theme={theme} />
      </div>
      <Slider label="阈值" value={l.thresholdDb} min={-12} max={0} step={0.1} onChange={(v) => patch({ limiter: { ...l, thresholdDb: v } })} display={`${l.thresholdDb.toFixed(1)}dBFS`} theme={theme} />
      <Slider label="前瞻时间" value={l.lookaheadMs} min={0} max={20} step={0.5} onChange={(v) => patch({ limiter: { ...l, lookaheadMs: v } })} display={`${l.lookaheadMs.toFixed(1)}ms`} theme={theme} />
      <Slider label="起始时间" value={l.attackMs} min={0} max={5} step={0.1} onChange={(v) => patch({ limiter: { ...l, attackMs: v } })} display={`${l.attackMs.toFixed(1)}ms`} theme={theme} />
      <Slider label="释放时间" value={l.releaseMs} min={20} max={500} step={10} onChange={(v) => patch({ limiter: { ...l, releaseMs: v } })} display={`${l.releaseMs}ms`} theme={theme} />
      <div className="flex items-center justify-between mb-2">
        <span className={`${theme.textSecondary} text-xs`}>真峰值检测（4× 过采样）</span>
        <Toggle checked={l.truePeak} onChange={(v) => patch({ limiter: { ...l, truePeak: v } })} theme={theme} />
      </div>
      <InfoLine theme={theme}>前瞻时间贡献引擎延迟（见分析页 latency 读数）。</InfoLine>
    </Modal>
  )
}

/* ─────────────────────────── 智能均衡 IEQ ─────────────────────────── */

export const IEQ_CURVES: { value: 'flat' | 'warm' | 'bright' | 'vocal'; label: string; hint: string }[] = [
  { value: 'flat', label: '平坦', hint: '中性直白，还原混音' },
  { value: 'warm', label: '温暖', hint: '中低频略厚' },
  { value: 'bright', label: '通透', hint: '高频更亮' },
  { value: 'vocal', label: '人声', hint: '突出人声频段' },
]

export function IeqModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const ieq = params.ieq
  return (
    <Modal title="智能均衡" icon={<Sparkles className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>实时分析频谱并与目标曲线对比，慢速平滑自动修正频响，不会跟随音乐抽吸。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 智能均衡</span>
        <Toggle checked={ieq.enabled} onChange={(v) => patch({ ieq: { ...ieq, enabled: v } })} theme={theme} />
      </div>
      <div className={`${theme.textSecondary} text-xs mb-1.5`}>目标曲线</div>
      <div className="grid grid-cols-4 gap-1.5 mb-3">
        {IEQ_CURVES.map((cv) => {
          const active = ieq.targetCurve === cv.value
          return (
            <button key={cv.value} type="button" title={cv.hint} onClick={() => patch({ ieq: { ...ieq, targetCurve: cv.value } })}
              className="py-1.5 rounded-lg text-[11px] transition-all"
              style={active ? { backgroundColor: theme.accentColor, color: '#fff', boxShadow: `0 0 10px ${theme.accentColor}55` } : { background: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: theme.textSecondary }}>
              {cv.label}
            </button>
          )
        })}
      </div>
      <Slider label="修正强度" value={ieq.strength} min={0} max={1} step={0.01} onChange={(v) => patch({ ieq: { ...ieq, strength: v } })} display={`${Math.round(ieq.strength * 100)}%`} theme={theme} />
      <Slider label="平滑时间" value={ieq.timeConstantSec} min={0.5} max={10} step={0.1} onChange={(v) => patch({ ieq: { ...ieq, timeConstantSec: v } })} display={`${ieq.timeConstantSec.toFixed(1)}s`} theme={theme} />
      <InfoLine theme={theme}>强度 0% = 只分析不修正；建议 3s 平滑（默认）防抽吸。</InfoLine>
    </Modal>
  )
}

/* ─────────────────────────── 变速变调 ─────────────────────────── */

export function PitchModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const pitch = params.pitch
  return (
    <Modal title="变速变调" icon={<Music className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>独立变调与变速（相位声码器自研实现；融合侧可切 soundtouchjs LGPL 链接或 signalsmith WASM 路径）。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 变速变调</span>
        <Toggle checked={pitch.enabled} onChange={(v) => patch({ pitch: { ...pitch, enabled: v } })} theme={theme} />
      </div>
      <Slider label="变调" value={pitch.semitones} min={-10} max={10} step={0.5} onChange={(v) => patch({ pitch: { ...pitch, semitones: v } })} display={`${pitch.semitones > 0 ? '+' : ''}${pitch.semitones} 半音`} theme={theme} />
      <Slider label="倍速" value={pitch.rate} min={0.25} max={3} step={0.05} onChange={(v) => patch({ pitch: { ...pitch, rate: v } })} display={`${pitch.rate.toFixed(2)}x`} theme={theme} />
      <InfoLine theme={theme}>变调与变速互相独立；倍速 ≠ 播放器变速（仅在启用时作用于音色）。</InfoLine>
    </Modal>
  )
}

/* ─────────────────────────── 立体声宽度 ─────────────────────────── */

export function StereoWidthModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const p = params
  const vb = p.pitch.voiceBalance
  return (
    <Modal title="立体声宽度" icon={<Columns2 className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-3`}>基于中/侧声道分离：横向控制声场开合、纵向控制人声/伴奏比例——在二维声场里拖动圆点，比左右滑块更直观。</p>
      {/* X-Y 声场触控板（X=立体声宽度 0..2，Y=人声↔伴奏 -1..+1，中心=原声） */}
      <div className="mb-3">
        <XYPad
          x={p.stereoWidth} y={vb}
          xMin={0} xMax={2} xCenter={1}
          yMin={-1} yMax={1} yCenter={0}
          onChange={(x, y) => patch({ stereoWidth: x, pitch: { ...p.pitch, voiceBalance: y } })}
          theme={theme}
          xLabels={[{ pos: 0, label: '单声道' }, { pos: 1, label: '原声' }, { pos: 2, label: '极宽' }]}
          yLabels={[{ pos: -1, label: '人声↑' }, { pos: 0, label: '原声' }, { pos: 1, label: '伴奏↓' }]}
        />
        <div className={`flex justify-between mt-1.5 text-[10px] ${theme.textTertiary}`}>
          <span>宽度 <span className="hse-mono">{p.stereoWidth.toFixed(2)}x</span></span>
          <span>人声比例 <span className="hse-mono">{vb === 0 ? '原声' : vb > 0 ? `伴奏 +${Math.round(-vb * 100)}%` : `人声 +${Math.round(vb * 100)}%`}</span></span>
        </div>
      </div>
      <Slider label="立体声宽度（精调）" value={p.stereoWidth} min={0} max={2} step={0.05} onChange={(v) => patch({ stereoWidth: v })} display={`${p.stereoWidth.toFixed(2)}x`} theme={theme} />
      <Slider label="人声 ↔ 伴奏（精调）" value={vb} min={-1} max={1} step={0.05}
        onChange={(v) => patch({ pitch: { ...p.pitch, voiceBalance: v } })}
        display={vb === 0 ? '原声' : vb > 0 ? `人声 +${Math.round(vb * 100)}%` : `伴奏 +${Math.round(-vb * 100)}%`} theme={theme} />
      <InfoLine theme={theme}>宽度 1.0 = 原始；0 = 单声道；2 = 极宽。人声比例同时影响居中低频。中心十字为原声基准点。</InfoLine>
    </Modal>
  )
}

/* 聚合导出：动态/调音类弹窗按 key 分发 */
export function DynamicsModal({ effectKey: key, controller, theme, onClose }: { effectKey: 'compressor' | 'deesser' | 'nightMode' | 'limiter' | 'ieq' | 'pitch' | 'stereoWidth'; controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  if (key === 'compressor') return <CompressorModal controller={controller} theme={theme} onClose={onClose} />
  if (key === 'deesser') return <DeesserModal controller={controller} theme={theme} onClose={onClose} />
  if (key === 'nightMode') return <NightModeModal controller={controller} theme={theme} onClose={onClose} />
  if (key === 'limiter') return <LimiterModal controller={controller} theme={theme} onClose={onClose} />
  if (key === 'ieq') return <IeqModal controller={controller} theme={theme} onClose={onClose} />
  if (key === 'pitch') return <PitchModal controller={controller} theme={theme} onClose={onClose} />
  return <StereoWidthModal controller={controller} theme={theme} onClose={onClose} />
}