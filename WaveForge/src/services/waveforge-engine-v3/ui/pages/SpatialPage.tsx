/**
 * 空间音效页 —— 混响 + 3D 环绕 + 立体声宽度
 *
 * 仅承载 V3EngineParams 的「空间向」效果（reverb / surround3d / stereoWidth），
 * 与「空间音频」(Spatial Audio，双耳渲染 4 档模式) 严格分离——后者已独立为
 * SpatialAudioPage 顶级选项卡。视图模式（标准/专业）随空间音频一并迁出，
 * 本页恢复为纯卡片流（与混响/3D环绕/立体声宽度效果一一对应）。
 */

import { useRef } from 'react'
import { AudioLines, Headphones, Columns2 } from 'lucide-react'
import { GlassCard, Toggle, Slider, RangeStyle } from '../components/Primitives'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'
import type { PlaybackTimeStore } from '../../../../audio/playbackTimeStore'

interface SpatialPageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
  /** 播放时钟 store（可选）：保留以对齐 commonProps 形状，本页不直接使用
   *  （随曲目播放仅空间音频世界漫游模式需要，已随 SpatialAudioPage 迁出） */
  playbackTimeStore?: PlaybackTimeStore
}

const REVERB_TYPES = [
  { value: 'hall', label: '大厅' },
  { value: 'room', label: '房间' },
  { value: 'plate', label: '板式' },
  { value: 'spring', label: '弹簧' },
  { value: 'stage', label: '舞台' },
] as const

export default function SpatialPage({ controller, theme }: SpatialPageProps) {
  const { params, patch } = controller
  const rv = params.reverb
  const s3 = params.surround3d
  const fileRef = useRef<HTMLInputElement>(null)

  const handleIrFile = async (file: File) => {
    try {
      const ctx = new AudioContext()
      const buf = await file.arrayBuffer()
      const decoded = await ctx.decodeAudioData(buf)
      const mono = new Float32Array(decoded.length)
      mono.set(decoded.getChannelData(0))
      patch({ reverb: { ...rv, mode: 'convolution', convolution: { ...rv.convolution, ir: mono, irName: file.name, dePeriodize: true } } })
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已导入 IR「${file.name}」`, type: 'info' } }))
      void ctx.close()
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: 'IR 文件解码失败', type: 'error' } }))
    }
  }

  return (
    <div className="space-y-4">
      <RangeStyle theme={theme} />

      {/* 混响 */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <AudioLines className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>混响</span>
          </div>
          <Toggle checked={rv.enabled && rv.mode !== 'off'} onChange={(v) => patch({ reverb: { ...rv, enabled: v } })} theme={theme} />
        </div>

        <div className="flex gap-1.5 mb-3">
          {(['algorithmic', 'convolution', 'off'] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => patch({ reverb: { ...rv, mode: m } })}
              className={`flex-1 py-1.5 rounded-lg text-xs transition-all ${rv.mode === m ? 'text-white font-medium' : theme.textSecondary}`}
              style={rv.mode === m ? { backgroundColor: theme.accentColor } : { background: 'rgba(255,255,255,0.06)' }}
            >
              {m === 'algorithmic' ? '算法混响' : m === 'convolution' ? '卷积混响' : '关闭'}
            </button>
          ))}
        </div>

        {rv.mode === 'algorithmic' && rv.enabled && (
          <div className="space-y-3">
            <div className="flex gap-1.5">
              {REVERB_TYPES.map((rt) => (
                <button
                  key={rt.value}
                  type="button"
                  onClick={() => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, type: rt.value } } })}
                  className={`flex-1 py-1.5 rounded-lg text-[11px] transition-all ${rv.algorithmic.type === rt.value ? 'text-white font-medium' : theme.textSecondary}`}
                  style={rv.algorithmic.type === rt.value ? { backgroundColor: theme.accentColor } : { background: 'rgba(255,255,255,0.06)' }}
                >
                  {rt.label}
                </button>
              ))}
            </div>
            <Slider label="空间大小" value={rv.algorithmic.roomSize} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, roomSize: v } } })} display={`${Math.round(rv.algorithmic.roomSize * 100)}%`} theme={theme} />
            <Slider label="湿声" value={rv.algorithmic.wet} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, wet: v } } })} display={`${Math.round(rv.algorithmic.wet * 100)}%`} theme={theme} />
            <Slider label="干声" value={rv.algorithmic.dry} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, dry: v } } })} display={`${Math.round(rv.algorithmic.dry * 100)}%`} theme={theme} />
          </div>
        )}

        {rv.mode === 'convolution' && rv.enabled && (
          <div className="space-y-3">
            <div
              role="button"
              tabIndex={0}
              onClick={() => fileRef.current?.click()}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileRef.current?.click() }}
              className="rounded-xl p-3 text-center cursor-pointer transition-all"
              style={{ background: `${theme.accentColor}12`, border: `1px dashed ${theme.accentColor}55` }}
            >
              <input ref={fileRef} type="file" accept="audio/*,.wav,.aiff,.flac" className="hidden"
                onChange={(e) => { const file = e.target.files?.[0]; if (file) void handleIrFile(file); e.target.value = '' }} />
              <div className={`${theme.textPrimary} text-xs font-medium`}>{rv.convolution.irName ?? '点击导入脉冲响应（IR）'}</div>
              <div className={`${theme.textTertiary} text-[10px] mt-1`}>WAV / AIFF / FLAC</div>
            </div>
            <Slider label="湿声混合" value={rv.convolution.mix} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, convolution: { ...rv.convolution, mix: v } } })} display={`${Math.round(rv.convolution.mix * 100)}%`} theme={theme} />
          </div>
        )}
      </GlassCard>

      {/* 3D 环绕 */}
      <GlassCard theme={theme}>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Headphones className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>3D 环绕</span>
          </div>
          <Toggle checked={s3.enabled} onChange={(v) => patch({ surround3d: { ...s3, enabled: v } })} theme={theme} />
        </div>
        {s3.enabled && (
          <div className="space-y-3">
            <Slider label="环绕近远" value={s3.distance} min={0} max={1} step={0.01} onChange={(v) => patch({ surround3d: { ...s3, distance: v } })} display={`${Math.round(s3.distance * 100)}%`} theme={theme} />
            <Slider label="旋转角度" value={s3.angle} min={0} max={360} step={1} onChange={(v) => patch({ surround3d: { ...s3, angle: v } })} display={`${s3.angle}°`} theme={theme} />
            <Slider label="环绕速度" value={s3.speed} min={0.2} max={3} step={0.1} onChange={(v) => patch({ surround3d: { ...s3, speed: v } })} display={`${s3.speed.toFixed(1)}x`} theme={theme} />
            <div className="flex gap-2">
              <button type="button" onClick={() => patch({ surround3d: { ...s3, direction: 1 } })} className={`flex-1 py-2 rounded-xl text-xs transition-colors ${s3.direction === 1 ? 'text-white' : theme.textSecondary}`} style={s3.direction === 1 ? { backgroundColor: theme.accentColor } : { background: 'rgba(255,255,255,0.06)' }}>正转 ↻</button>
              <button type="button" onClick={() => patch({ surround3d: { ...s3, direction: -1 } })} className={`flex-1 py-2 rounded-xl text-xs transition-colors ${s3.direction === -1 ? 'text-white' : theme.textSecondary}`} style={s3.direction === -1 ? { backgroundColor: theme.accentColor } : { background: 'rgba(255,255,255,0.06)' }}>反转 ↺</button>
            </div>
          </div>
        )}
      </GlassCard>

      {/* 立体声宽度 */}
      <GlassCard theme={theme}>
        <div className="flex items-center gap-2 mb-3">
          <Columns2 className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>立体声宽度</span>
        </div>
        <Slider label="宽度" value={params.stereoWidth} min={0} max={2} step={0.05} onChange={(v) => patch({ stereoWidth: v })} display={`${params.stereoWidth.toFixed(2)}x`} theme={theme} />
        <Slider label="人声 ↔ 伴奏" value={params.pitch.voiceBalance} min={-1} max={1} step={0.05}
          onChange={(v) => patch({ pitch: { ...params.pitch, voiceBalance: v } })}
          display={params.pitch.voiceBalance === 0 ? '原声' : params.pitch.voiceBalance > 0 ? `人声 +${Math.round(params.pitch.voiceBalance * 100)}%` : `伴奏 +${Math.round(-params.pitch.voiceBalance * 100)}%`}
          theme={theme}
        />
      </GlassCard>
    </div>
  )
}
