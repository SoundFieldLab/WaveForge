/**
 * DG_LAB 常驻悬浮小组件（左上角、可拖拽、记忆位置、任何模式下置顶显示）。
 * 内容：A/B 通道实时强度数值 + 双通道实时波形（跟随映射输出）。
 * 开关：控制台「实时输出」区「实时波形常驻」；小 × 也可关闭。
 */

import { useEffect, useRef, useState } from 'react'
import { X, Zap } from 'lucide-react'
import { useDGLabStatus, getGlobalAudioAnalysers } from '../plugins/clients/DGLabClient'
import {
  isPluginEnabled,
  PLUGIN_STATE_EVENT,
  isDGLabWidgetVisible,
  setDGLabWidgetVisible,
  DGLAB_WIDGET_EVENT,
} from '../services/pluginStore'

const WIDGET_W = 240
const WIDGET_H = 104
const GOLD = '#FFE89C'
const CYAN = '#22d3ee'
const POS_KEY = 'wf_dglab_widget_pos'

type Pos = { x: number; y: number }

function loadPos(): Pos {
  try {
    const raw = localStorage.getItem(POS_KEY)
    if (raw) {
      const p = JSON.parse(raw)
      if (typeof p?.x === 'number' && typeof p?.y === 'number') return { x: p.x, y: p.y }
    }
  } catch {
    /* ignore */
  }
  return { x: 16, y: 16 }
}

const clampPos = (pos: Pos): Pos => ({
  x: Math.max(0, Math.min(pos.x, window.innerWidth - WIDGET_W - 8)),
  y: Math.max(0, Math.min(pos.y, window.innerHeight - WIDGET_H - 8)),
})

function persistPos(pos: Pos) {
  try {
    localStorage.setItem(POS_KEY, JSON.stringify(pos))
  } catch {
    /* ignore */
  }
}

export default function DGLabWidget() {
  const status = useDGLabStatus()
  const [pluginOn, setPluginOn] = useState(() => isPluginEnabled('dglab'))
  const [visible, setVisible] = useState(() => isDGLabWidgetVisible())
  const [pos, setPos] = useState<Pos>(() => loadPos())
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const envARef = useRef<number[]>([])
  const envBRef = useRef<number[]>([])
  const timeBufRef = useRef<Uint8Array | null>(null)
  const statusRef = useRef(status)
  statusRef.current = status
  const dragRef = useRef<{ dx: number; dy: number } | null>(null)

  // 插件开关 / 小组件开关变化
  useEffect(() => {
    const onPlugin = () => setPluginOn(isPluginEnabled('dglab'))
    const onWidget = () => setVisible(isDGLabWidgetVisible())
    window.addEventListener(PLUGIN_STATE_EVENT, onPlugin)
    window.addEventListener(DGLAB_WIDGET_EVENT, onWidget)
    return () => {
      window.removeEventListener(PLUGIN_STATE_EVENT, onPlugin)
      window.removeEventListener(DGLAB_WIDGET_EVENT, onWidget)
    }
  }, [])

  // 窗口尺寸变化时把小组件拉回可视区
  useEffect(() => {
    const onResize = () => setPos(p => clampPos(p))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // 波形绘制
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    let raf = 0
    const draw = () => {
      raf = 0
      const cw = canvas.clientWidth || 140
      const ch = canvas.clientHeight || 56
      const targetW = Math.round(cw * dpr)
      const targetH = Math.round(ch * dpr)
      if (canvas.width !== targetW || canvas.height !== targetH) {
        canvas.width = targetW
        canvas.height = targetH
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      ctx.clearRect(0, 0, cw, ch)
      ctx.fillStyle = 'rgba(0,0,0,0.35)'
      ctx.fillRect(0, 0, cw, ch)

      const out = statusRef.current.out
      const { left, right } = getGlobalAudioAnalysers()
      if (left && !timeBufRef.current) timeBufRef.current = new Uint8Array(left.frequencyBinCount)

      // 每帧一次峰值 → 右→左滚动包络（低-平-高），性能友好
      const samplePeak = (analyser: AnalyserNode | null): number => {
        if (analyser && timeBufRef.current) {
          analyser.getByteTimeDomainData(timeBufRef.current)
          let peak = 0
          const buf = timeBufRef.current
          for (let i = 0; i < buf.length; i += 1) {
            const v = Math.abs(buf[i] - 128) / 128
            if (v > peak) peak = v
          }
          return peak
        }
        return 0
      }
      const drawWave = (analyser: AnalyserNode | null, env: number[], getInt: () => number, color: string) => {
        const baseline = ch / 2
        env.push(Math.max(samplePeak(analyser), getInt() / 200))
        const cols = Math.max(1, Math.floor(cw / 2))
        while (env.length > cols) env.shift()
        const step = cw / Math.max(1, cols - 1)
        ctx.beginPath()
        env.forEach((v, i) => {
          const y = baseline - Math.min(1, Math.max(0, v)) * (ch * 0.5 - 3)
          if (i === 0) ctx.moveTo(i * step, y)
          else ctx.lineTo(i * step, y)
        })
        ctx.strokeStyle = color
        ctx.lineWidth = 1.3
        ctx.shadowColor = color
        ctx.shadowBlur = 4
        ctx.stroke()
        ctx.shadowBlur = 0
      }
      drawWave(left, envARef.current, () => out?.A ?? 0, GOLD)
      drawWave(right, envBRef.current, () => out?.B ?? 0, CYAN)
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      envARef.current = []
      envBRef.current = []
    }
  }, [])

  if (!pluginOn || !visible) return null

  const startDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('[data-widget-close]')) return
    dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    const next = clampPos({ x: e.clientX - dragRef.current.dx, y: e.clientY - dragRef.current.dy })
    setPos(next)
    persistPos(next)
  }
  const onUp = () => {
    dragRef.current = null
  }

  return (
    <div
      className="fixed z-[9990] rounded-xl overflow-hidden shadow-2xl border cursor-grab active:cursor-grabbing select-none"
      style={{
        left: pos.x,
        top: pos.y,
        width: WIDGET_W,
        height: WIDGET_H,
        background: 'linear-gradient(160deg, rgba(13,13,16,0.95), rgba(21,16,5,0.95))',
        borderColor: 'rgba(245,200,76,0.35)',
        backdropFilter: 'blur(14px)',
        touchAction: 'none',
        pointerEvents: 'auto',
      }}
      onPointerDown={startDrag}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={onUp}
      onDoubleClick={(e) => e.stopPropagation()}
      title="DG-LAB 实时波形（可拖动）"
    >
      {/* 头部：标题 + 状态点 + 关闭（不影响拖动，唯一可点的小 ×） */}
      <div className="flex items-center gap-1.5 px-2 pt-1.5 pb-0.5">
        <Zap className="w-3 h-3 text-amber-300" />
        <span className="text-[9px] font-bold text-white/85 uppercase tracking-wide">DG_LAB</span>
        <span
          className="w-1.5 h-1.5 rounded-full ml-auto"
          style={{ background: status.state === 'bound' ? '#34d399' : status.state === 'waiting' ? GOLD : '#64748b', boxShadow: status.state === 'bound' ? `0 0 6px #34d399` : 'none' }}
        />
        <button
          data-widget-close
          type="button"
          onClick={() => setDGLabWidgetVisible(false)}
          className="p-0.5 rounded hover:bg-white/10 text-white/50 hover:text-white transition-colors"
          aria-label="关闭悬浮波形"
          title="关闭常驻波形（控制台可再次开启）"
        >
          <X className="w-3 h-3" />
        </button>
      </div>

      {/* 波形 + 数值 */}
      <div className="flex items-center gap-1.5 px-2 pb-1.5">
        <canvas ref={canvasRef} className="flex-1 h-14 rounded-lg border border-white/10" style={{ background: 'rgba(0,0,0,0.4)' }} />
        <div className="shrink-0 text-right space-y-0.5">
          <div className="flex items-center gap-1 justify-end">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: GOLD }} />
            <span className="text-base font-black text-white leading-none">{status.out?.A ?? 0}</span>
          </div>
          <div className="flex items-center gap-1 justify-end">
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: CYAN }} />
            <span className="text-base font-black text-white leading-none">{status.out?.B ?? 0}</span>
          </div>
          <div className="text-[8px] text-white/35">A / B 强度</div>
        </div>
      </div>
    </div>
  )
}