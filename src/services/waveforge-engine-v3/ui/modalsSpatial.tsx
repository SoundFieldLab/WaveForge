/**
 * WaveForge v3 调音室 UI —— 空间/染色类效果配置弹窗
 *
 * 混响（双路由：卷积/算法/off + IR 导入入口）、3D 环绕（圆形拖拽可视化）、
 * 低音增强（4 种谐波非线性）。视觉与交互沿用 v1/v2 弹窗规范。
 */

import { useRef } from 'react'
import { AudioLines, Headphones, Music2 } from 'lucide-react'
import type { V3Theme } from './theme'
import { InfoLine, Modal, Segmented, Slider, Toggle } from './primitives'
import type { V3ParamsController } from './hooks'

export const REVERB_TYPES: { value: 'hall' | 'room' | 'plate' | 'spring' | 'stage'; label: string; hint: string }[] = [
  { value: 'hall', label: '大厅', hint: '开阔空间，长混响' },
  { value: 'room', label: '房间', hint: '中小房间，自然' },
  { value: 'plate', label: '板式', hint: '金属板，明亮密实' },
  { value: 'spring', label: '弹簧', hint: '弹簧混响，复古' },
  { value: 'stage', label: '舞台', hint: '舞台空间，纵深' },
]

export const HARMONIC_TYPES: { value: 'odd' | 'even' | 'atan' | 'soft'; label: string; hint: string }[] = [
  { value: 'odd', label: '奇次', hint: 'x³ 奇次谐波，温暖厚实' },
  { value: 'even', label: '偶次', hint: '整流偶次谐波，冲击力强' },
  { value: 'atan', label: 'ATSR', hint: '反正切饱和，平滑' },
  { value: 'soft', label: '软饱和', hint: 'tanh 软饱和，柔和' },
]

/* ─────────────────────────── 混响 ─────────────────────────── */

export function ReverbModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const rv = params.reverb
  const fileRef = useRef<HTMLInputElement>(null)

  // IR 文件选择：读取 WAV/任意音频 → 解码为单声道 Float32Array（浏览器 AudioContext 解码）
  const handleIrFile = async (file: File) => {
    try {
      const ctx = new AudioContext()
      const buf = await file.arrayBuffer()
      const decoded = await ctx.decodeAudioData(buf)
      const mono = new Float32Array(decoded.length)
      const ch0 = decoded.getChannelData(0)
      mono.set(ch0)
      patch({ reverb: { ...rv, mode: 'convolution', convolution: { ...rv.convolution, ir: mono, irName: file.name, dePeriodize: true } } })
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已导入 IR「${file.name}」`, type: 'info' } }))
      void ctx.close()
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: 'IR 文件解码失败（请提供 WAV/AIFF 等格式）', type: 'error' } }))
    }
  }

  return (
    <Modal title="混响" icon={<AudioLines className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>v3 混响支持双路由：算法混响（Freeverb 类，五种空间）与分区卷积混响（可导入 IR，自动去周期化消除循环伪影）。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 混响</span>
        <Toggle checked={rv.enabled} onChange={(v) => patch({ reverb: { ...rv, enabled: v } })} theme={theme} />
      </div>

      <div className="mb-4">
        <div className={`${theme.textSecondary} text-xs mb-1.5`}>路由</div>
        <Segmented
          options={[
            { value: 'algorithmic' as const, label: '算法混响' },
            { value: 'convolution' as const, label: '卷积混响' },
            { value: 'off' as const, label: '关闭' },
          ]}
          value={rv.mode}
          onChange={(v) => patch({ reverb: { ...rv, mode: v } })}
          theme={theme}
        />
      </div>

      {rv.mode === 'algorithmic' && (
        <>
          <div className={`${theme.textSecondary} text-xs mb-1.5`}>空间类型</div>
          <div className="grid grid-cols-5 gap-1.5 mb-3">
            {REVERB_TYPES.map((rt) => {
              const active = rv.algorithmic.type === rt.value
              return (
                <button key={rt.value} type="button" title={rt.hint} onClick={() => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, type: rt.value } } })}
                  className="py-1.5 rounded-lg text-[11px] transition-all"
                  style={active ? { backgroundColor: theme.accentColor, color: '#fff', boxShadow: `0 0 10px ${theme.accentColor}55` } : { background: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: theme.textSecondary }}>
                  {rt.label}
                </button>
              )
            })}
          </div>
          <Slider label="空间大小" value={rv.algorithmic.roomSize} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, roomSize: v } } })} display={`${Math.round(rv.algorithmic.roomSize * 100)}%`} theme={theme} />
          <Slider label="衰减阻尼" value={rv.algorithmic.damping} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, damping: v } } })} display={`${Math.round(rv.algorithmic.damping * 100)}%`} theme={theme} />
          <Slider label="湿声" value={rv.algorithmic.wet} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, wet: v } } })} display={`${Math.round(rv.algorithmic.wet * 100)}%`} theme={theme} />
          <Slider label="干声" value={rv.algorithmic.dry} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, dry: v } } })} display={`${Math.round(rv.algorithmic.dry * 100)}%`} theme={theme} />
          <Slider label="预延迟" value={rv.algorithmic.preDelayMs} min={0} max={200} step={1} onChange={(v) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, preDelayMs: v } } })} display={`${rv.algorithmic.preDelayMs}ms`} theme={theme} />
          <Slider label="立体声宽度" value={rv.algorithmic.width} min={0} max={2} step={0.05} onChange={(v) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, width: v } } })} display={`${rv.algorithmic.width.toFixed(2)}x`} theme={theme} />
        </>
      )}

      {rv.mode === 'convolution' && (
        <>
          <div
            role="button"
            tabIndex={0}
            onClick={() => fileRef.current?.click()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click() }}
            className="rounded-2xl p-4 mb-3 text-center cursor-pointer transition-all hover:brightness-110"
            style={{ background: `${theme.accentColor}12`, border: `1px dashed ${theme.accentColor}66` }}
          >
            <input ref={fileRef} type="file" accept="audio/*,.wav,.aiff,.flac" className="hidden"
              onChange={(e) => { const file = e.target.files?.[0]; if (file) void handleIrFile(file); e.target.value = '' }} />
            <div className={`${theme.textPrimary} text-sm font-medium`}>{rv.convolution.irName ?? '点击导入脉冲响应（IR）'}</div>
            <div className={`${theme.textTertiary} text-[11px] mt-1`}>WAV / AIFF / FLAC，自动转为单声道；未导入时回退算法混响</div>
          </div>
          <Slider label="湿声混合" value={rv.convolution.mix} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, convolution: { ...rv.convolution, mix: v } } })} display={`${Math.round(rv.convolution.mix * 100)}%`} theme={theme} />
          <Slider label="预延迟" value={rv.convolution.preDelayMs} min={0} max={200} step={1} onChange={(v) => patch({ reverb: { ...rv, convolution: { ...rv.convolution, preDelayMs: v } } })} display={`${rv.convolution.preDelayMs}ms`} theme={theme} />
          <div className="flex items-center justify-between mb-2">
            <span className={`${theme.textSecondary} text-xs`}>IR 去周期化（消除循环伪影）</span>
            <Toggle checked={rv.convolution.dePeriodize} onChange={(v) => patch({ reverb: { ...rv, convolution: { ...rv.convolution, dePeriodize: v } } })} theme={theme} />
          </div>
          <InfoLine theme={theme}>分区卷积流式处理，延迟 = 分区长（见引擎 stats 中的 latency）。</InfoLine>
        </>
      )}
    </Modal>
  )
}

/* ─────────────────────────── 3D 环绕 ─────────────────────────── */

export function Surround3dModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const s3 = params.surround3d
  const angleRad = (s3.angle * Math.PI) / 180
  const distRatio = Math.min(1, Math.max(0, s3.distance))
  const dotX = 50 + Math.cos(angleRad) * distRatio * 40
  const dotY = 50 + Math.sin(angleRad) * distRatio * 40

  const setFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    const dx = e.clientX - cx
    const dy = e.clientY - cy
    const angle = Math.round((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 360
    const dist = Math.min(1, Math.hypot(dx, dy) / (Math.min(rect.width, rect.height) / 2))
    patch({ surround3d: { ...s3, angle, distance: Math.round(dist * 100) / 100 } })
  }

  return (
    <Modal title="3D 环绕" icon={<Headphones className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>轻量立体声旋转：拖动圆点设置角度与距离，声音在耳机内绕头旋转。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 3D 环绕</span>
        <Toggle checked={s3.enabled} onChange={(v) => patch({ surround3d: { ...s3, enabled: v } })} theme={theme} />
      </div>

      <div className="relative h-48 rounded-xl mb-3 touch-none overflow-hidden select-none" style={{ background: theme.dark ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)', border: `1px solid ${theme.glassBorder}` }}>
        <span className="absolute top-1.5 left-2 text-[10px]" style={{ color: theme.dark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)' }}>角度 {s3.angle}°</span>
        <span className="absolute top-1.5 right-2 text-[10px] font-semibold" style={{ color: theme.accentColor }}>距离 {Math.round(s3.distance * 100)}%</span>
        <div
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-36 h-36 cursor-pointer touch-none"
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setFromPointer(e) }}
          onPointerMove={(e) => { if (e.buttons === 1) setFromPointer(e) }}
        >
          {[0.33, 0.66, 1].map((r) => (
            <div key={r} className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full border" style={{ width: `${r * 100}%`, height: `${r * 100}%`, borderColor: theme.dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)' }} />
          ))}
          <div className="absolute left-1/2 top-0 bottom-0 w-px" style={{ background: theme.dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }} />
          <div className="absolute top-1/2 left-0 right-0 h-px" style={{ background: theme.dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)' }} />
          <div className="absolute left-1/2 top-1/2 w-2.5 h-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ background: theme.dark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.5)' }} />
          <div className="absolute w-4 h-4 -translate-x-1/2 -translate-y-1/2 rounded-full" style={{ left: `${dotX}%`, top: `${dotY}%`, background: theme.accentColor, boxShadow: `0 0 14px ${theme.accentColor}aa` }} />
        </div>
        <span className="absolute bottom-1 inset-x-0 text-center text-[10px]" style={{ color: theme.dark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)' }}>拖动圆点调整角度与距离</span>
      </div>
      <Slider label="环绕近远" value={s3.distance} min={0} max={1} step={0.01} onChange={(v) => patch({ surround3d: { ...s3, distance: v } })} display={`${Math.round(s3.distance * 100)}%`} theme={theme} />
      <Slider label="旋转角度" value={s3.angle} min={0} max={360} step={1} onChange={(v) => patch({ surround3d: { ...s3, angle: v } })} display={`${s3.angle}°`} theme={theme} />
      <Slider label="环绕速度" value={s3.speed} min={0.2} max={3} step={0.1} onChange={(v) => patch({ surround3d: { ...s3, speed: v } })} display={`${s3.speed.toFixed(1)}x`} theme={theme} />
      <div className="flex gap-2">
        <button type="button" onClick={() => patch({ surround3d: { ...s3, direction: 1 } })} className={`flex-1 py-2 rounded-xl text-sm transition-colors ${s3.direction === 1 ? 'text-white' : theme.textSecondary}`} style={s3.direction === 1 ? { backgroundColor: theme.accentColor } : { backgroundColor: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}>正转 ↻</button>
        <button type="button" onClick={() => patch({ surround3d: { ...s3, direction: -1 } })} className={`flex-1 py-2 rounded-xl text-sm transition-colors ${s3.direction === -1 ? 'text-white' : theme.textSecondary}`} style={s3.direction === -1 ? { backgroundColor: theme.accentColor } : { backgroundColor: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }}>反转 ↺</button>
      </div>
    </Modal>
  )
}

/* ─────────────────────────── 低音增强 ─────────────────────────── */

export function BassEnhancerModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const bass = params.bassEnhancer
  return (
    <Modal title="低音增强" icon={<Music2 className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>低通提取低频并生成谐波，让小型设备也能感知低频；「低音下潜」同时提升真实低频能量（v2 低音增强的 lowshelf 语义）。四种非线性可选。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 低音增强</span>
        <Toggle checked={bass.enabled} onChange={(v) => patch({ bassEnhancer: { ...bass, enabled: v } })} theme={theme} />
      </div>
      <div className={`${theme.textSecondary} text-xs mb-1.5`}>谐波类型</div>
      <div className="grid grid-cols-4 gap-1.5 mb-3">
        {HARMONIC_TYPES.map((ht) => {
          const active = bass.harmonicType === ht.value
          return (
            <button key={ht.value} type="button" title={ht.hint} onClick={() => patch({ bassEnhancer: { ...bass, harmonicType: ht.value } })}
              className="py-1.5 rounded-lg text-[11px] transition-all"
              style={active ? { backgroundColor: theme.accentColor, color: '#fff', boxShadow: `0 0 10px ${theme.accentColor}55` } : { background: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: theme.textSecondary }}>
              {ht.label}
            </button>
          )
        })}
      </div>
      <Slider label="低通截止" value={bass.cutoffHz} min={40} max={250} step={5} onChange={(v) => patch({ bassEnhancer: { ...bass, cutoffHz: v } })} display={`${bass.cutoffHz}Hz`} theme={theme} />
      <Slider label="谐波增益" value={bass.harmonicGain} min={0} max={1} step={0.01} onChange={(v) => patch({ bassEnhancer: { ...bass, harmonicGain: v } })} display={`${Math.round(bass.harmonicGain * 100)}%`} theme={theme} />
      <Slider label="干湿混合" value={bass.mix} min={0} max={1} step={0.01} onChange={(v) => patch({ bassEnhancer: { ...bass, mix: v } })} display={`${Math.round(bass.mix * 100)}%`} theme={theme} />
      <Slider label="整体电平" value={bass.levelDb} min={-6} max={6} step={0.5} onChange={(v) => patch({ bassEnhancer: { ...bass, levelDb: v } })} display={`${bass.levelDb > 0 ? '+' : ''}${bass.levelDb.toFixed(1)}dB`} theme={theme} />
      <Slider label="低音下潜" value={bass.lowBoostDb} min={-6} max={12} step={0.5} onChange={(v) => patch({ bassEnhancer: { ...bass, lowBoostDb: v } })} display={`${bass.lowBoostDb > 0 ? '+' : ''}${bass.lowBoostDb.toFixed(1)}dB`} theme={theme} />
      <InfoLine theme={theme}>偶次谐波对低音冲击感最强；奇次更温暖。低音下潜提升真实低频能量，建议与限幅器同开以防削波。</InfoLine>
    </Modal>
  )
}

/* 聚合导出：空间/染色类弹窗按 key 分发 */
export function SpatialModal({ effectKey: key, controller, theme, onClose }: { effectKey: 'reverb' | 'surround3d' | 'bassEnhancer'; controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  if (key === 'reverb') return <ReverbModal controller={controller} theme={theme} onClose={onClose} />
  if (key === 'surround3d') return <Surround3dModal controller={controller} theme={theme} onClose={onClose} />
  return <BassEnhancerModal controller={controller} theme={theme} onClose={onClose} />
}