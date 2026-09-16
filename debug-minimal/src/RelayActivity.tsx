/**
 * 中继日志面板：直接展示 server/dglab-relay.cjs 输出的原始日志。
 *
 * 与 DeviceMonitor 互补——那边看「最终下发帧」，这边看「引擎为何这样下发」：
 * 扫码地址、绑定、音频接入首帧、安全归零、钳位、风格诊断等都在这。
 * 调试波形效果时，这一栏通常是定位问题最快的地方。
 */

import { useEffect, useRef, useState } from 'react'
import { Terminal, Trash2 } from 'lucide-react'

const API = 'http://127.0.0.1:3101'

export default function RelayActivity({ api = API }: { api?: string }) {
  const [lines, setLines] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [paused, setPaused] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)

  useEffect(() => {
    let alive = true
    let timer: number | null = null
    const tick = async () => {
      if (!paused) {
        try {
          const res = await fetch(`${api}/api/debug/logs`, { signal: AbortSignal.timeout(3000) })
          const json = await res.json()
          if (!alive) return
          setError(null)
          setLines(Array.isArray(json?.lines) ? json.lines : [])
        } catch (err) {
          if (alive) setError(`无法读取中继日志：${err instanceof Error ? err.message : String(err)}`)
        }
      }
      if (alive) timer = window.setTimeout(tick, 700)
    }
    void tick()
    return () => {
      alive = false
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [api, paused])

  // 自动滚底（用户手动上滚后不再强行跟随）
  useEffect(() => {
    const box = boxRef.current
    if (!box || !stickRef.current) return
    box.scrollTop = box.scrollHeight
  }, [lines])

  const onScroll = () => {
    const box = boxRef.current
    if (!box) return
    stickRef.current = box.scrollHeight - box.scrollTop - box.clientHeight < 24
  }

  return (
    <div className="rounded-lg border border-white/10 bg-white/[0.03] p-2 min-w-0">
      <div className="flex items-center gap-2 mb-1.5">
        <Terminal className="w-3.5 h-3.5 text-white/60" />
        <span className="text-[11px] font-bold text-white/85">中继日志</span>
        <span className="text-[10px] text-white/35">{lines.length} 行</span>
        <button
          type="button"
          onClick={() => setPaused(p => !p)}
          className={`ml-auto px-1.5 py-0.5 rounded text-[10px] border transition-colors ${paused
            ? 'border-amber-300/40 bg-amber-300/10 text-amber-200'
            : 'border-white/15 text-white/55 hover:bg-white/10'}`}
          title={paused ? '继续刷新' : '暂停刷新（便于阅读）'}
        >
          {paused ? '已暂停' : '暂停'}
        </button>
        <button
          type="button"
          onClick={() => { setLines([]); stickRef.current = true }}
          className="p-1 rounded hover:bg-white/10 text-white/45 hover:text-white/80 transition-colors"
          title="清空显示（不影响后端）"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>

      {error && <p className="text-[10px] text-red-300/90 mb-1 leading-relaxed">{error}</p>}

      <div
        ref={boxRef}
        onScroll={onScroll}
        className="max-h-72 overflow-y-auto plugin-center-scroll plugin-log-select rounded bg-black/50 border border-white/[0.06] p-1.5 font-mono text-[10px] leading-relaxed"
      >
        {lines.length
          ? lines.map((line, i) => (
            <div key={`${i}-${line.slice(0, 24)}`} className="text-white/70 whitespace-pre-wrap break-all">{line}</div>
          ))
          : <p className="text-white/35">暂无日志。若一直为空，确认调试后端（3101）正在运行。</p>}
      </div>
    </div>
  )
}
