/**
 * 模式 D：舞台/影院面板（独立组件，供空间音效页挂载；GlassCard 由父面板包裹）
 *
 * 交互：场景卡片网格（4 选 1，卡片含 2D 俯视扬声器布局缩略图）→ 自定义声源
 * （规划书「可替换/添加个别声源」）→ 座位分段（前/中/后排）→ 房间大小滑块 →
 * 氛围混响滑块。
 * 所有变更走 onChange(patch) 深合并（StageSettings 局部字段），由融合层持久化/下发。
 * 场景预设的扬声器数值单事实源在 src/spatial/scenes.ts（本组件只展示与切换）；
 * 自定义声源不落 scenes——由 UI 本地参数（StageSettings.customSources）承载。
 */

import { useEffect, useRef } from 'react'
import { Mic2, Clapperboard, Piano, CloudRain, Plus, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Slider, Segmented } from './Primitives'
import type { HSETheme } from '../hse-theme'
import type { DeepPartial, SeatPosition, StagePreset, StageSettings, VirtualSpeakerCfg } from '../../src/spatial/types'
import { STAGE_SCENES } from '../../src/spatial/scenes'

interface StagePanelProps {
  params: StageSettings
  theme: HSETheme
  onChange: (patch: DeepPartial<StageSettings>) => void
}

/** 场景卡片元数据（与 STAGE_SCENES 顺序一致；描述为一句中文短语） */
const SCENE_CARDS: { id: StagePreset; name: string; desc: string; icon: LucideIcon }[] = [
  { id: 'stage', name: '音乐舞台', desc: 'Live 乐队全景', icon: Mic2 },
  { id: 'cinema', name: '电影院', desc: '7.1.4 影院环绕', icon: Clapperboard },
  { id: 'piano', name: '钢琴独奏', desc: '音乐厅长尾', icon: Piano },
  { id: 'nature', name: '自然场景', desc: '雨雷鸟溪户外', icon: CloudRain },
]

/** 座位选项（前端 middle 对应 ×1.0 基准距离，见 scenes.ts SEAT_DISTANCE_SCALE） */
const SEAT_OPTIONS: { value: SeatPosition; label: string }[] = [
  { value: 'front', label: '前排' },
  { value: 'middle', label: '中排' },
  { value: 'back', label: '后排' },
]

/** 自定义附加声源上限（附加过多会淹没预设布局；超限时「添加声源」按钮禁用） */
const MAX_CUSTOM_SOURCES = 8

/**
 * 场景卡片 2D 俯视扬声器布局缩略图（Canvas 2D，仿 SpatialModeVisual 范式）。
 * 规划书 §5.5「显示一个预设场景的 3D 缩略图」的简化实现：3D 渲染后续 wave，
 * 本波落地为 2D 俯视布局——圆心 = 听者，点 = 扬声器（方位角/距离 → 极坐标，
 * 画布上方为前方，与 SpatialModeVisual 同坐标约定），点色 accentFrom/accentTo
 * 交替。静态布局、无动画：每卡片挂载时绘制一次即可（无需 raf 循环）；选中态
 * 切换仅重绘一次着色（选中 accent 彩色 / 未选中灰调），每次都是全量重绘，成本
 * 可忽略（每卡片 ~11 个点，共 4 个实例）。
 */
function SceneThumb({ speakers, active, theme }: { speakers: VirtualSpeakerCfg[]; active: boolean; theme: HSETheme }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    // 一次绘制（静态布局，无需 raf）；devicePixelRatio 缩放防模糊（同 WaveformVisualizer）
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const w = Math.max(1, canvas.clientWidth || 96)
    const h = Math.max(1, canvas.clientHeight || 64)
    canvas.width = Math.round(w * dpr)
    canvas.height = Math.round(h * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const cx = w / 2
    const cy = h / 2
    // 距离按本场景最大扬声器距离归一化（布局填满缩略图，方向关系保真、距离成比例）
    const maxDist = Math.max(1, ...speakers.map((s) => s.distance))
    const radius = Math.min(w, h) / 2 - 5
    // 方位角/距离 → 屏幕坐标：az=0 朝上、az>0 偏右（与 SpatialModeVisual 同约定）
    const dotAt = (s: VirtualSpeakerCfg) => {
      const rad = (s.azimuthDeg * Math.PI) / 180
      const r = Math.max(2, Math.min(1, s.distance / maxDist)) * radius
      return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) }
    }

    if (!active) {
      // 未选中：灰调布局（只展示位置关系，弱化视觉不抢选中卡片）
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 4])
      ctx.beginPath()
      ctx.arc(cx, cy, radius, 0, Math.PI * 2)
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = 'rgba(255,255,255,0.28)'
      for (const s of speakers) {
        const p = dotAt(s)
        ctx.beginPath()
        ctx.arc(p.x, p.y, 2.4, 0, Math.PI * 2)
        ctx.fill()
      }
      ctx.fillStyle = 'rgba(255,255,255,0.42)'
      ctx.beginPath()
      ctx.arc(cx, cy, 3, 0, Math.PI * 2) // 听者
      ctx.fill()
      return
    }

    const from = theme.accentFrom
    const to = theme.accentTo
    // 听者圆环 + 前方朝向短线（az=0 方向）
    ctx.strokeStyle = `${from}66`
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(cx, cy, 6, 0, Math.PI * 2)
    ctx.stroke()
    ctx.strokeStyle = 'rgba(255,255,255,0.18)'
    ctx.setLineDash([2, 4])
    ctx.beginPath()
    ctx.moveTo(cx, cy - 6)
    ctx.lineTo(cx, cy - radius + 2)
    ctx.stroke()
    ctx.setLineDash([])
    // 扬声器小圆点：accentFrom/accentTo 交替 + 微光晕
    speakers.forEach((s, i) => {
      const p = dotAt(s)
      const color = i % 2 === 0 ? from : to
      ctx.save()
      ctx.shadowColor = color
      ctx.shadowBlur = 5
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    })
    ctx.fillStyle = from
    ctx.beginPath()
    ctx.arc(cx, cy, 2.6, 0, Math.PI * 2) // 听者
    ctx.fill()
  }, [speakers, active, theme.accentFrom, theme.accentTo])

  return (
    <canvas
      ref={canvasRef}
      role="img"
      aria-label="场景扬声器布局缩略图"
      className="w-full block mt-1.5 rounded-md"
      style={{ height: 64, backgroundColor: 'rgba(0,0,0,0.22)' }}
    />
  )
}

export default function StagePanel({ params, theme, onChange }: StagePanelProps) {
  /** 追加声源：id 序号取现有 custom-N 最大值 + 1（删除后不复用序号，id 保持单调递增）；
   *  默认位置正前 4m（与听者同高 1.6m → az 0 / dist 4），增益 1、点声源 size 0 */
  const addSource = () => {
    const list = params.customSources
    if (list.length >= MAX_CUSTOM_SOURCES) return
    let maxN = 0
    for (const s of list) {
      const m = /^custom-(\d+)$/.exec(s.id)
      if (m) maxN = Math.max(maxN, parseInt(m[1], 10))
    }
    onChange({
      customSources: [...list, { id: `custom-${maxN + 1}`, position: { x: 0, y: 1.6, z: 4 }, gain: 1, size: 0 }],
    })
  }

  /** 单个声源增益（整段替换 customSources） */
  const setSourceGain = (idx: number, gain: number): void => {
    onChange({ customSources: params.customSources.map((s, i) => (i === idx ? { ...s, gain } : s)) })
  }

  /** 单个声源位置（米；X 左右 / Y 高度 / Z 前后——方位由融合层相对默认听者计算）。
   *  坐标钳制 ±12m（XY）/ 0.2..12m（Z 高度下限防入地） */
  const setSourcePos = (idx: number, axis: 'x' | 'y' | 'z', v: number): void => {
    onChange({
      customSources: params.customSources.map((s, i) => {
        if (i !== idx) return s
        const clamped = axis === 'y' ? Math.min(12, Math.max(0.2, v)) : Math.min(12, Math.max(-12, v))
        return { ...s, position: { ...s.position, [axis]: Math.round(clamped * 10) / 10 } }
      }),
    })
  }

  /** 删除单个声源（整段替换 customSources） */
  const removeSource = (idx: number): void => {
    onChange({ customSources: params.customSources.filter((_, i) => i !== idx) })
  }

  return (
    <div>
      {/* 场景选择：4 卡片网格（2 列自适应，宽屏 4 列）；卡片内嵌 2D 俯视布局缩略图 */}
      <div className={`${theme.textSecondary} text-xs mb-1.5`}>场景</div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 mb-3">
        {SCENE_CARDS.map((c) => {
          const active = params.preset === c.id
          const Icon = c.icon
          // 缩略图数据来源：STAGE_SCENES 预设扬声器（scenes.ts 单事实源；SCENE_CARDS 与
          // STAGE_SCENES id 一一对应，防御性回退空列表 = 仅画听者点）
          const sceneSpeakers = STAGE_SCENES.find((s) => s.id === c.id)?.speakers ?? []
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onChange({ preset: c.id })}
              className={`relative rounded-xl p-2.5 text-left transition-all ${active ? 'text-white font-medium' : theme.textSecondary}`}
              style={active
                ? { background: theme.accentGradient, boxShadow: `0 4px 14px ${theme.accentColor}44` }
                : { backgroundColor: 'rgba(255,255,255,0.06)', border: `1px solid ${theme.cardBorder}` }}
            >
              <Icon className="w-4 h-4 mb-1.5" style={{ color: active ? 'rgba(255,255,255,0.95)' : theme.accentColor }} />
              <div className="text-xs">{c.name}</div>
              <div className={`text-[10px] mt-0.5 leading-tight ${active ? 'text-white/80' : theme.textTertiary}`}>{c.desc}</div>
              {/* 2D 俯视扬声器布局缩略图（3D 缩略图规划书 §5.5 的简化实现，注释见组件头） */}
              <SceneThumb speakers={sceneSpeakers} active={active} theme={theme} />
            </button>
          )
        })}
      </div>

      {/* 自定义声源：规划书「可替换/添加个别声源」——本波实现「添加」语义（「替换」=
       * 删除预设扬声器，完整布局编辑器后续 wave）；全部经 onChange({ customSources:
       * 整段替换 }) 提交（DeepPartial 数组整段替换），融合层 stageSpeakers 结果后
       * 按方位路由附加为虚拟扬声器 */}
      <div className="mb-3">
        <div className={`${theme.textSecondary} text-xs mb-1`}>自定义声源</div>
        <div className="space-y-1.5">
          {params.customSources.map((src, i) => (
            <div
              key={src.id}
              className="rounded-xl p-2"
              style={{ backgroundColor: 'rgba(255,255,255,0.06)', border: `1px solid ${theme.cardBorder}` }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={`${theme.textPrimary} text-xs font-medium`}>声源 {i + 1}</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    aria-label={`删除声源 ${i + 1}`}
                    title="删除声源"
                    onClick={() => removeSource(i)}
                    className="p-1 rounded-md transition-opacity hover:opacity-70"
                    style={{ color: theme.textTertiary }}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
              {/* 增益 0..2（透传 VirtualSpeaker.gain） */}
              <Slider
                label="增益"
                value={src.gain}
                min={0}
                max={2}
                step={0.05}
                onChange={(v) => setSourceGain(i, v)}
                display={src.gain.toFixed(2)}
                theme={theme}
              />
              {/* 声源位置（米，可调——原实现坐标写死 (0,1.6,4) 只读展示）：X 左右 /
                  Y 高度 / Z 前后，相对默认座位（原点听者 1.6m 高） */}
              <div className="grid grid-cols-3 gap-1.5">
                {(['x', 'y', 'z'] as const).map((axis) => (
                  <Slider
                    key={axis}
                    label={axis === 'x' ? '左右 X' : axis === 'y' ? '高度 Y' : '前后 Z'}
                    value={axis === 'y' ? Math.max(0.2, src.position.y) : src.position[axis]}
                    min={axis === 'y' ? 0.2 : -12}
                    max={12}
                    step={0.1}
                    onChange={(v) => setSourcePos(i, axis, v)}
                    display={`${(axis === 'y' ? Math.max(0.2, src.position.y) : src.position[axis]).toFixed(1)}m`}
                    theme={theme}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addSource}
          disabled={params.customSources.length >= MAX_CUSTOM_SOURCES}
          className="w-full mt-1.5 rounded-lg py-1.5 text-xs flex items-center justify-center gap-1 transition-all hover:brightness-110 disabled:opacity-40"
          style={{ border: `1px dashed ${theme.cardBorder}`, color: theme.textSecondary }}
        >
          <Plus className="w-3.5 h-3.5" />
          添加声源{params.customSources.length >= MAX_CUSTOM_SOURCES ? `（上限 ${MAX_CUSTOM_SOURCES}）` : ''}
        </button>
        <div className={`${theme.textTertiary} text-[10px] mt-1 leading-relaxed`}>
          附加声源相对默认座位（原点听者 1.6m 高）计算方位，与预设扬声器同一坐标系；预设声源删除（替换语义）完整布局编辑器后续 wave。
        </div>
      </div>

      {/* 座位：前排×0.8 / 中排×1.0 / 后排×1.35（距离感） */}
      <div className="mb-1.5">
        <div className={`${theme.textSecondary} text-xs mb-1`}>座位</div>
        <Segmented options={SEAT_OPTIONS} value={params.seat} onChange={(v) => onChange({ seat: v })} theme={theme} small />
      </div>

      {/* 房间大小：0.5..2，缩放扬声器距离与混响空间感 */}
      <Slider
        label="房间大小"
        value={params.roomSize}
        min={0.5}
        max={2}
        step={0.05}
        onChange={(v) => onChange({ roomSize: v })}
        display={`×${params.roomSize.toFixed(2)}`}
        theme={theme}
      />

      {/* 氛围混响：内部 0..1，UI 显示百分比 */}
      <Slider
        label="氛围混响"
        value={Math.round(params.reverbAmount * 100)}
        min={0}
        max={100}
        step={1}
        onChange={(v) => onChange({ reverbAmount: v / 100 })}
        display={`${Math.round(params.reverbAmount * 100)}%`}
        theme={theme}
      />
    </div>
  )
}
