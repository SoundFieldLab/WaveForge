import { useEffect, useRef, useState } from 'react'
import type { V3UiBridge } from '../bridge'
import { useStateFeedback } from '../feedback'

/** 固定状态条：LED 指示灯 + 引擎就绪状态 + 当前听感模式；只刷新自身。 */
export function OutputStatus({ bridge, modeText }: { bridge: V3UiBridge; modeText: string }) {
  const [stats, setStats] = useState(() => bridge.getStats())
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const timer = window.setInterval(() => setStats(bridge.getStats()), 200)
    return () => window.clearInterval(timer)
  }, [bridge])
  const clip = stats.truePeakDb >= 0 || stats.peakDb >= 0
  useStateFeedback(clip, ref)
  const rate = bridge.getSampleRate()
  const sampleRate = Number.isFinite(rate) && rate > 0 ? `${(rate / 1000).toFixed(rate % 1000 === 0 ? 0 : 1)} kHz` : '—'
  return <div ref={ref} className="hse-output-status flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs"
    aria-label={`引擎状态：${clip ? '峰值接近满刻' : '输出正常'}；目前模式：${modeText}`} aria-live="polite">
    <span className="hse-status-dot" data-state={clip ? 'warn' : 'ok'} aria-hidden="true"
      title={clip ? '峰值接近满刻' : '输出正常'} />
    <span className="whitespace-nowrap">HyperSoundEngine 已就绪 · DSP 双声道 · {sampleRate}</span>
    <span className="hse-status-separator" aria-hidden="true">/</span>
    <span className="whitespace-nowrap">目前模式：{modeText}</span>
  </div>
}
