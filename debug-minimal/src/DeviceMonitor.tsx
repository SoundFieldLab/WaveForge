/**
 * 真机观测台：显示「中继实际下发给真机的东西」。
 *
 * 这是调试平台最核心的一块——波形好不好，最终只看两件事：
 *   1) 强度轨迹：A/B 通道随时间如何起伏（音乐动态有没有跟出来）；
 *   2) 脉冲波形帧：beat 触发时下发的 freq/strength 序列（波形形状对不对）。
 *
 * 数据来自 frame-tap 旁听「中继 → 真机」的下发帧，未经任何美化，
 * 因此就是手机真正收到的内容，可直接用来验收映射效果。
 */

import { useEffect, useRef, useState } from 'react'
import { Activity, RotateCw } from 'lucide-react'

const API = 'http://127.0.0.1:3101'

interface DeviceState {
  /** 中继当前协议与真机绑定信息（由 frame-tap 读取中继内部状态）。 */
  version: string | null
  appId: string | null
  remoteBound: boolean
  counters: { strength: number; pulse: number; clear: number; pulseFrames: number; heartbeat: number; other: number }
  seq: number
  eventCount: number
}

interface EngineState {
  running: boolean
  paused: boolean
  outputOn: boolean
  seenAudio: boolean
  lastAudioAt: number
  A: { target: number; current: number }
  B: { target: number; current: number }
  energyEnv: number
  speed: number
  agc: number
  dutyOn: number
}

interface PulseFrame { seq: number; at: number; channel: string; freq: number; strength: number }

interface EventRow { seq: number; at: number; kind: string; channel: string; value?: number; frames?: { freq: number; strength: number }[]; note?: string }

const GOLD = '#FFE89C'
const CYAN = '#22d3ee'

export default function DeviceMonitor({ api = API }: { api?: string }) {
  const [device, setDevice] = useState<DeviceState | null>(null)
  const [engine, setEngine] = useState<EngineState | null>(null)
  const [events, setEvents] = useState<EventRow[]>([])
  const [error, setError] = useState<string | null>(null)
  /** App 回传的实时强度/上限（来自中继 softLimit/deviceStrength）。 */
  const [appLimit, setAppLimit] = useState<{
    softLimit: { A: number; B: number } | null
    deviceStrength: { A: number; B: number } | null
  }>({ softLimit: null, deviceStrength: null })
  /** 用户设定上限（中继设置里的 caps），用于对比「设定 vs App 允许」。 */
  const [userCaps, setUserCaps] = useState<{ A: number; B: number } | null>(null)

  const seqRef = useRef(0)
  /** 强度轨迹环形缓冲（画 A/B 两条线）。 */
  const traceRef = useRef<{ A: number[]; B: number[] }>({ A: [], B: [] })
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const pulseCanvasRef = useRef<HTMLCanvasElement>(null)
  const latestPulseRef = useRef<PulseFrame[]>([])

  /* ------------------------------ 轮询 ------------------------------ */

  useEffect(() => {
    let alive = true
    let timer: number | null = null

    const tick = async () => {
      try {
        const res = await fetch(`${api}/api/debug/events?since=${seqRef.current}`, { signal: AbortSignal.timeout(3000) })
        const json = await res.json()
        if (!alive) return
        setError(null)
        if (json.device) setDevice(json.device)
        if (json.engine) setEngine(json.engine)
        if (json.appLimit) {
          setAppLimit({ softLimit: json.appLimit.softLimit ?? null, deviceStrength: json.appLimit.deviceStrength ?? null })
          setUserCaps(json.appLimit.userCaps ?? null)
        }

        const incoming: EventRow[] = Array.isArray(json.events) ? json.events : []
        if (incoming.length) {
          seqRef.current = Math.max(seqRef.current, ...incoming.map(e => e.seq))
          // 事件表保留最近 200 条
          setEvents(prev => [...prev, ...incoming].slice(-200))

          // 强度轨迹：把 strength 事件推入缓冲
          const trace = traceRef.current
          for (const ev of incoming) {
            if (ev.kind === 'strength') {
              if (ev.channel === 'A') trace.A.push(ev.value ?? 0)
              if (ev.channel === 'B') trace.B.push(ev.value ?? 0)
            }
          }
          const cap = 900
          if (trace.A.length > cap) trace.A.splice(0, trace.A.length - cap)
          if (trace.B.length > cap) trace.B.splice(0, trace.B.length - cap)
        }

        const incomingPulses: PulseFrame[] = Array.isArray(json.pulses) ? json.pulses : []
        if (incomingPulses.length) {
          latestPulseRef.current = [...latestPulseRef.current, ...incomingPulses].slice(-600)
        }
      } catch (err) {
        if (alive) setError(`无法连接调试后端（${api}）：${err instanceof Error ? err.message : String(err)}`)
      } finally {
        if (alive) timer = window.setTimeout(tick, 120)
      }
    }

    void tick()
    return () => {
      alive = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [api])

  /* ------------------------------ 强度曲线 ------------------------------ */

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0

    const draw = () => {
      raf = 0
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cw = canvas.clientWidth || 340
      const ch = canvas.clientHeight || 90
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr)
        canvas.height = Math.round(ch * dpr)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }
      ctx.clearRect(0, 0, cw, ch)
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(0, 0, cw, ch)

      // 网格（0 / 50 / 100 / 150 / 200 五档，对应郊狼强度刻度）
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'
      ctx.lineWidth = 1
      for (let i = 0; i <= 4; i += 1) {
        const y = (ch / 4) * i
        ctx.beginPath()
        ctx.moveTo(0, y)
        ctx.lineTo(cw, y)
        ctx.stroke()
      }
      ctx.fillStyle = 'rgba(255,255,255,0.3)'
      ctx.font = '9px ui-monospace, monospace'
      ctx.fillText('200', 2, 10)
      ctx.fillText('0', 2, ch - 3)

      const trace = traceRef.current
      const drawLine = (data: number[], color: string) => {
        if (data.length < 2) return
        const n = data.length
        ctx.beginPath()
        data.forEach((value, i) => {
          const x = (i / (n - 1)) * cw
          const y = ch - (Math.max(0, Math.min(200, value)) / 200) * (ch - 6) - 3
          if (i === 0) ctx.moveTo(x, y)
          else ctx.lineTo(x, y)
        })
        ctx.strokeStyle = color
        ctx.lineWidth = 1.4
        ctx.shadowColor = color
        ctx.shadowBlur = 4
        ctx.stroke()
        ctx.shadowBlur = 0
      }
      drawLine(trace.A, GOLD)
      drawLine(trace.B, CYAN)
      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => { if (raf) cancelAnimationFrame(raf) }
  }, [])

  /* ------------------------------ 脉冲波形帧 ------------------------------ */

  useEffect(() => {
    const canvas = pulseCanvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    let raf = 0
    let lastSeq = -1

    const draw = () => {
      raf = 0
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const cw = canvas.clientWidth || 340
      const ch = canvas.clientHeight || 70
      if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
        canvas.width = Math.round(cw * dpr)
        canvas.height = Math.round(ch * dpr)
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      }

      const all = latestPulseRef.current
      const newest = all.length ? all[all.length - 1].seq : -1
      if (newest === lastSeq) { raf = requestAnimationFrame(draw); return }
      lastSeq = newest

      ctx.clearRect(0, 0, cw, ch)
      ctx.fillStyle = 'rgba(0,0,0,0.45)'
      ctx.fillRect(0, 0, cw, ch)

      // 滚动显示最近的脉冲帧流（按时间左→右）。
      //
      // 之前只画「同一 seq 的最后一帧组」，但引擎每个 100ms 会单独下发一帧
      // LiveWave（A/B 交替），所以面板常年只显示一根柱 —— 看不出波形形状。
      // 改成滚动条带后，节拍脉冲的 6 帧衰减包络与 100ms 实时帧连成一条连续波形，
      // 正好对应手机 App 上看到的实时波形。
      const frames = all.slice(-120)
      if (!frames.length) { raf = requestAnimationFrame(draw); return }

      const slot = cw / frames.length
      const baseY = ch - 10
      frames.forEach((frame, i) => {
        const h = (Math.max(0, Math.min(200, frame.strength)) / 200) * (ch - 16)
        const x = i * slot
        const isB = frame.channel === 'B'
        ctx.fillStyle = isB ? 'rgba(34,211,238,0.7)' : 'rgba(255,232,156,0.78)'
        ctx.fillRect(x, baseY - h, Math.max(1, slot - 0.5), h)
      })
      // 基线
      ctx.strokeStyle = 'rgba(255,255,255,0.12)'
      ctx.beginPath()
      ctx.moveTo(0, baseY)
      ctx.lineTo(cw, baseY)
      ctx.stroke()

      const last = frames[frames.length - 1]
      ctx.fillStyle = 'rgba(255,255,255,0.45)'
      ctx.font = '9px ui-monospace, monospace'
      ctx.fillText(`最近 ${frames.length} 帧 · 最新 #${last.seq} ch=${last.channel} freq=${last.freq} str=${last.strength}`, 3, 10)
      ctx.fillStyle = 'rgba(255,255,255,0.25)'
      ctx.fillText('每帧 ≈100ms（节拍脉冲 6 帧衰减 + 实时帧）', 3, ch - 1)
      raf = requestAnimationFrame(draw)
    }

    raf = requestAnimationFrame(draw)
    return () => { if (raf) cancelAnimationFrame(raf) }
  }, [])

  /* ------------------------------ 渲染 ------------------------------ */

  const clearObservations = async () => {
    await fetch(`${api}/api/debug/device/clear`, { method: 'POST' }).catch(() => undefined)
    seqRef.current = 0
    traceRef.current = { A: [], B: [] }
    latestPulseRef.current = []
    setEvents([])
  }

  const fresh = engine?.lastAudioAt ? Date.now() - engine.lastAudioAt < 1000 : false

  return (
    <div className="space-y-2 min-w-0">
      {error && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] text-red-200 leading-relaxed">
          {error}
        </div>
      )}

      {/* 真机状态 */}
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
        <div className="flex items-center gap-2 mb-1.5">
          <Activity className="w-3.5 h-3.5 text-white/60" />
          <span className="text-[11px] font-bold text-white/85">真机连接</span>
          <span className={`ml-auto flex items-center gap-1 text-[10px] ${device?.remoteBound ? 'text-emerald-300' : 'text-amber-300/80'}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${device?.remoteBound ? 'bg-emerald-400' : 'bg-amber-400/70'}`} />
            {device?.remoteBound ? '真机已绑定' : '等待扫码'}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
          <Field label="协议" value={(device?.version ?? '-').toUpperCase()} />
          <Field label="App" value={device?.appId ? `${device.appId.slice(0, 8)}…` : '-'} />
          <Field label="下发强度帧" value={String(device?.counters.strength ?? 0)} />
          <Field label="下发脉冲" value={`${device?.counters.pulse ?? 0}（${device?.counters.pulseFrames ?? 0}帧）`} />
          <Field label="归零指令" value={String(device?.counters.clear ?? 0)} />
          <Field label="心跳" value={String(device?.counters.heartbeat ?? 0)} />
        </div>
        {!device?.remoteBound && (
          <p className="text-[10px] text-amber-300/70 leading-relaxed mt-1.5">
            用手机 DG-Lab App 扫「控制台」里的二维码连入。手机需与电脑在同一 WiFi；
            连接前不会有任何波形下发数据。
          </p>
        )}
      </div>

      {/* App 实时上限（理解体感的关键）*/}
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] font-bold text-white/85">App 实时上限</span>
          <span className="text-[10px] text-white/35">V3 强度回传</span>
          <span className={`ml-auto text-[10px] ${appLimit.softLimit ? 'text-emerald-300/90' : 'text-amber-300/80'}`}>
            {appLimit.softLimit ? '已回传' : '未回传'}
          </span>
        </div>
        {appLimit.softLimit ? (
          <>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
              <Field label="App 允许上限" value={`A ${appLimit.softLimit.A} · B ${appLimit.softLimit.B}`} />
              <Field label="设备当前强度" value={appLimit.deviceStrength ? `A ${appLimit.deviceStrength.A} · B ${appLimit.deviceStrength.B}` : '-'} />
              <Field label="我方设定上限" value={userCaps ? `A ${userCaps.A} · B ${userCaps.B}` : '-'} />
              <Field
                label="实际生效上限"
                value={userCaps
                  ? `A ${Math.min(userCaps.A, appLimit.softLimit.A)} · B ${Math.min(userCaps.B, appLimit.softLimit.B)}`
                  : '-'}
              />
            </div>
            <p className="text-[10px] text-white/40 leading-relaxed mt-1.5">
              实际生效 = min(我方设定, App 允许)。App 上限会按它的「增加速率」设置逐秒爬升——
              刚连上时可能只有个位数，此时下发再大也会被钳住，体感自然很弱。
            </p>
          </>
        ) : (
          <p className="text-[10px] text-amber-300/70 leading-relaxed">
            尚未收到 App 的强度回传。App 在「通道强度或上限变化」时才会主动上报；
            刚连上时可以先在 App 里动一下强度滚轮，或等上限爬升触发一次上报。
          </p>
        )}
      </div>

      {/* 引擎状态 */}
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] font-bold text-white/85">映射引擎（中继内部）</span>
          <span className={`ml-auto text-[10px] ${engine?.running ? 'text-emerald-300' : 'text-white/40'}`}>
            {engine?.running ? (engine.paused ? '暂停归零' : engine.outputOn ? '运行中' : '输出已关') : '未启动'}
          </span>
        </div>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
          <Field label="音频流" value={engine?.seenAudio ? (fresh ? '实时' : '已停（>1s 无帧）') : '未接入'} />
          <Field label="A 目标/当前" value={engine ? `${Math.round(engine.A.target)} / ${Math.round(engine.A.current)}` : '-'} />
          <Field label="B 目标/当前" value={engine ? `${Math.round(engine.B.target)} / ${Math.round(engine.B.current)}` : '-'} />
          <Field label="能量包络" value={engine ? engine.energyEnv.toFixed(3) : '-'} />
          <Field label="乐速因子" value={engine ? engine.speed.toFixed(2) : '-'} />
          <Field label="AGC / 占空" value={engine ? `${engine.agc.toFixed(2)} / ${engine.dutyOn.toFixed(1)}s` : '-'} />
        </div>
      </div>

      {/* 强度轨迹 */}
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] font-bold text-white/85">强度轨迹</span>
          <span className="text-[10px] text-white/35">A/B 通道（真机实收）</span>
          <button
            type="button" onClick={() => void clearObservations()}
            className="ml-auto p-1 rounded hover:bg-white/10 text-white/45 hover:text-white/80 transition-colors"
            title="清空观测数据"
          >
            <RotateCw className="w-3 h-3" />
          </button>
        </div>
        <canvas ref={canvasRef} className="w-full h-[90px] rounded border border-white/10" />
        <div className="flex items-center gap-3 mt-1 text-[10px]">
          <span className="flex items-center gap-1"><span className="w-2 h-0.5" style={{ background: GOLD }} />A 通道</span>
          <span className="flex items-center gap-1"><span className="w-2 h-0.5" style={{ background: CYAN }} />B 通道</span>
        </div>
      </div>

      {/* 脉冲波形帧 */}
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] font-bold text-white/85">脉冲波形帧</span>
          <span className="text-[10px] text-white/35">最近一次 beat 下发</span>
        </div>
        <canvas ref={pulseCanvasRef} className="w-full h-[70px] rounded border border-white/10" />
      </div>

      {/* 事件流 */}
      <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2">
        <div className="flex items-center gap-2 mb-1.5">
          <span className="text-[11px] font-bold text-white/85">下发事件流</span>
          <span className="text-[10px] text-white/35">{events.length} 条</span>
        </div>
        <div className="max-h-52 overflow-y-auto plugin-center-scroll plugin-log-select space-y-0.5 font-mono text-[10px]">
          {[...events].reverse().map(ev => (
            <div key={ev.seq} className="flex items-center gap-1.5 px-1 py-0.5 rounded hover:bg-white/[0.04]">
              <span className="text-white/30 shrink-0">{new Date(ev.at).toLocaleTimeString('zh-CN', { hour12: false })}</span>
              <span className={`shrink-0 ${ev.kind === 'strength' ? 'text-amber-200/90' : ev.kind === 'pulse' ? 'text-cyan-300/90' : ev.kind === 'clear' ? 'text-red-300/90' : 'text-white/45'}`}>
                {ev.kind}
              </span>
              <span className="text-white/50 shrink-0">ch={ev.channel}</span>
              {ev.value !== undefined && <span className="text-white/80">{ev.value}</span>}
              {ev.frames?.length ? <span className="text-white/55 truncate">freq={ev.frames.map(f => f.freq).join(',')} str={ev.frames.map(f => f.strength).join(',')}</span> : null}
              {ev.note && <span className="text-white/40 truncate">{ev.note}</span>}
            </div>
          ))}
          {!events.length && <p className="text-white/35 px-1">暂无下发帧——检查「插件已启用 + 真机已扫码绑定 + 音乐在播」。</p>}
        </div>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-1.5 min-w-0">
      <span className="text-white/40 shrink-0">{label}</span>
      <span className="text-white/85 truncate tabular-nums">{value}</span>
    </div>
  )
}
