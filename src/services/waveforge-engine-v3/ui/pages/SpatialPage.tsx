/**
 * 空间音效页 —— 混响 + 3D 环绕 + 立体声宽度
 *
 * 仅承载 V3EngineParams 的「空间向」效果（reverb / surround3d / stereoWidth），
 * 与「空间音频」(Spatial Audio，双耳渲染 4 档模式) 严格分离——后者已独立为
 * SpatialAudioPage 顶级选项卡。视图模式（标准/专业）随空间音频一并迁出，
 * 本页恢复为纯卡片流（与混响/3D环绕/立体声宽度效果一一对应）。
 */

import { useRef } from 'react'
import { AudioLines, Headphones, Columns2, Settings2 } from 'lucide-react'
import { GlassCard, Toggle, Slider, Segmented, RangeStyle } from '../components/Primitives'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'
import type { PlaybackTimeStore } from '../../../../audio/playbackTimeStore'
import type { ReverbType } from '../../src/types'

interface SpatialPageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
  /** 播放时钟 store（可选）：保留以对齐 commonProps 形状，本页不直接使用
   *  （随曲目播放仅空间音频世界漫游模式需要，已随 SpatialAudioPage 迁出） */
  playbackTimeStore?: PlaybackTimeStore
}

const REVERB_TYPES: { value: ReverbType; label: string }[] = [
  { value: 'hall', label: '大厅' },
  { value: 'room', label: '房间' },
  { value: 'plate', label: '板式' },
  { value: 'spring', label: '弹簧' },
  { value: 'stage', label: '舞台' },
]

export default function SpatialPage({ controller, theme, onOpenEffect }: SpatialPageProps) {
  const { params, patch } = controller
  const rv = params.reverb
  const s3 = params.surround3d
  const fileRef = useRef<HTMLInputElement>(null)

  const details = (key: string, name: string) => (
    <button type="button" onClick={() => onOpenEffect(key)} aria-label={`${name}详细设置`}
      className={`hse-glass-button mt-3 inline-flex min-h-9 items-center gap-1.5 rounded-xl px-3 py-2 text-xs ${theme.textSecondary}`}>
      <Settings2 className="h-3.5 w-3.5" /> 详细设置
    </button>
  )

  const handleIrFile = async (file: File) => {
    let ctx: AudioContext | undefined
    try {
      const ctx = new AudioContext()
      try {
        const buf = await file.arrayBuffer()
        const decoded = await ctx.decodeAudioData(buf)
        const mono = new Float32Array(decoded.length)
        mono.set(decoded.getChannelData(0))
        patch({ reverb: { ...rv, mode: 'convolution', convolution: { ...rv.convolution, ir: mono, irName: file.name, dePeriodize: true } } })
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `已导入 IR「${file.name}」`, type: 'info' } }))
      } finally {
        void ctx.close()
      }
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: 'IR 文件解码失败', type: 'error' } }))
    } finally {
      if (ctx) void ctx.close()
    }
  }

  return (
    <div className="@container space-y-5">
      <RangeStyle theme={theme} />
      <p className={`${theme.textSecondary} text-sm leading-relaxed`}>混响与环绕可独立叠加。进入详细设置可调整预延迟、衰减阻尼和二维声场。</p>

      <div className="grid items-start gap-5 @min-[44rem]:grid-cols-2">
        {/* 混响 */}
        <GlassCard theme={theme}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <AudioLines className="w-4 h-4" style={{ color: theme.accentColor }} />
              <span className={`${theme.textPrimary} text-sm font-medium`}>混响</span>
            </div>
            <Toggle label="启用混响" checked={rv.enabled && rv.mode !== 'off'} onChange={(v) => patch({ reverb: { ...rv, enabled: v, mode: v && rv.mode === 'off' ? 'algorithmic' : rv.mode } })} theme={theme} />
          </div>

          <p className={`${theme.textSecondary} mb-4 text-xs leading-relaxed`}>
            <span className="font-medium" style={{ color: rv.enabled && rv.mode !== 'off' ? theme.accentColor : undefined }}>{rv.enabled && rv.mode !== 'off' ? '已启用' : '已关闭'}</span>
            <span className="mx-1.5" aria-hidden="true">·</span>用算法空间或脉冲响应塑造声音的余韵。
          </p>
          <Segmented label="混响类型" options={[
            { value: 'algorithmic', label: '算法混响' }, { value: 'convolution', label: '卷积混响' }, { value: 'off', label: '关闭' },
          ]} value={rv.mode} onChange={(mode) => patch({ reverb: { ...rv, mode, enabled: mode !== 'off' } })} theme={theme} small />

          {rv.mode === 'algorithmic' && rv.enabled && (
            <div className="mt-4 space-y-1">
              <Segmented label="算法混响空间" options={REVERB_TYPES} value={rv.algorithmic.type}
                onChange={(type) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, type } } })} theme={theme} small />
              <Slider label="空间大小" value={rv.algorithmic.roomSize} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, roomSize: v } } })} display={`${Math.round(rv.algorithmic.roomSize * 100)}%`} theme={theme} />
              <Slider label="湿声" value={rv.algorithmic.wet} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, wet: v } } })} display={`${Math.round(rv.algorithmic.wet * 100)}%`} theme={theme} />
              <Slider label="干声" value={rv.algorithmic.dry} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, algorithmic: { ...rv.algorithmic, dry: v } } })} display={`${Math.round(rv.algorithmic.dry * 100)}%`} theme={theme} />
            </div>
          )}

          {rv.mode === 'convolution' && rv.enabled && (
            <div className="mt-4 space-y-1">
              <div
                role="button"
                tabIndex={0}
                onClick={() => fileRef.current?.click()}
                aria-label="导入混响脉冲响应文件"
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click() } }}
                className="hse-glass-button rounded-xl p-4 text-center cursor-pointer"
              >
                <input ref={fileRef} type="file" accept="audio/*,.wav,.aiff,.flac" className="hidden"
                  onChange={(e) => { const file = e.target.files?.[0]; if (file) void handleIrFile(file); e.target.value = '' }} />
                <div className={`${theme.textPrimary} text-xs font-medium`}>{rv.convolution.irName ?? '点击导入脉冲响应（IR）'}</div>
                <div className={`${theme.textTertiary} text-[10px] mt-1`}>WAV / AIFF / FLAC</div>
              </div>
              <Slider label="湿声混合" value={rv.convolution.mix} min={0} max={1} step={0.01} onChange={(v) => patch({ reverb: { ...rv, convolution: { ...rv.convolution, mix: v } } })} display={`${Math.round(rv.convolution.mix * 100)}%`} theme={theme} />
            </div>
          )}
          {details('reverb', '混响')}
        </GlassCard>

        <div className="min-w-0 space-y-5">
        {/* 3D 环绕 */}
        <GlassCard theme={theme}>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <Headphones className="w-4 h-4" style={{ color: theme.accentColor }} />
              <span className={`${theme.textPrimary} text-sm font-medium`}>3D 环绕</span>
            </div>
            <Toggle label="启用 3D 环绕" checked={s3.enabled} onChange={(v) => patch({ surround3d: { ...s3, enabled: v } })} theme={theme} />
          </div>
          <p className={`${theme.textSecondary} mb-4 text-xs leading-relaxed`}>
            <span className="font-medium" style={{ color: s3.enabled ? theme.accentColor : undefined }}>{s3.enabled ? '已启用' : '已关闭'}</span>
            <span className="mx-1.5" aria-hidden="true">·</span>调整声像的距离、方向与旋转速度。
          </p>
          {s3.enabled && (
            <div className="space-y-1">
              <Slider label="环绕近远" value={s3.distance} min={0} max={1} step={0.01} onChange={(v) => patch({ surround3d: { ...s3, distance: v } })} display={`${Math.round(s3.distance * 100)}%`} theme={theme} />
              <Slider label="旋转角度" value={s3.angle} min={0} max={360} step={1} onChange={(v) => patch({ surround3d: { ...s3, angle: v } })} display={`${s3.angle}°`} theme={theme} />
              <Slider label="环绕速度" value={s3.speed} min={0.2} max={3} step={0.1} onChange={(v) => patch({ surround3d: { ...s3, speed: v } })} display={`${s3.speed.toFixed(1)} ×`} theme={theme} />
              <div className="flex gap-2">
                <Segmented label="环绕旋转方向" options={[{ value: 1, label: '正转 ↻' }, { value: -1, label: '反转 ↺' }]}
                  value={s3.direction} onChange={(direction) => patch({ surround3d: { ...s3, direction } })} theme={theme} small />
              </div>
            </div>
          )}
          {details('surround3d', '3D 环绕')}
        </GlassCard>

        {/* 立体声宽度 */}
        <GlassCard theme={theme} className="@container">
          <div className="flex items-center gap-2 mb-3">
            <Columns2 className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>立体声宽度</span>
          </div>
          <p className={`${theme.textSecondary} mb-4 text-xs leading-relaxed`}>宽度 1.00 × 为原始声像；人声与伴奏比例可单独调整。</p>
          <div className="grid gap-x-8 @min-[38rem]:grid-cols-2">
            <Slider label="宽度" value={params.stereoWidth} min={0} max={2} step={0.05} onChange={(v) => patch({ stereoWidth: v })} display={`${params.stereoWidth.toFixed(2)} ×`} theme={theme} />
            <Slider label="人声 ↔ 伴奏" value={params.pitch.voiceBalance} min={-1} max={1} step={0.05}
              onChange={(v) => patch({ pitch: { ...params.pitch, voiceBalance: v } })}
              display={params.pitch.voiceBalance === 0 ? '原声' : params.pitch.voiceBalance > 0 ? `人声 +${Math.round(params.pitch.voiceBalance * 100)}%` : `伴奏 +${Math.round(-params.pitch.voiceBalance * 100)}%`}
              theme={theme}
            />
          </div>
          {details('stereoWidth', '立体声宽度')}
        </GlassCard>
        </div>
      </div>
    </div>
  )
}
