import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import type { V3UiBridge } from '../bridge'
import { useStateFeedback } from '../feedback'

/** 固定状态条只刷新自身。浮窗出现时，仍能读取峰值与输出增益。 */
export function OutputStatus({ bridge, gainDb }: { bridge: V3UiBridge; gainDb: number }) {
  const [stats, setStats] = useState(() => bridge.getStats())
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timer = window.setInterval(() => setStats(bridge.getStats()), 200)
    return () => window.clearInterval(timer)
  }, [bridge])
  const clip = stats.truePeakDb >= 0 || stats.peakDb >= 0
  useStateFeedback(clip, ref)
  return <div ref={ref} className="hse-output-status flex items-center gap-3 text-xs" data-clip={clip} aria-label="输出监测">
    <span className="hse-mono whitespace-nowrap">手动增益 {Number.isFinite(gainDb) ? `${gainDb > 0 ? '+' : ''}${gainDb.toFixed(1)}` : '—'} dB</span>
    <span className="hse-mono whitespace-nowrap">TP {Number.isFinite(stats.truePeakDb) ? stats.truePeakDb.toFixed(1) : '—'} dBFS</span>
    <span className="flex items-center gap-1 whitespace-nowrap">{clip ? <AlertTriangle size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}{clip ? '峰值越界' : Number.isFinite(stats.truePeakDb) ? '峰值正常' : '等待信号'}</span>
  </div>
}
