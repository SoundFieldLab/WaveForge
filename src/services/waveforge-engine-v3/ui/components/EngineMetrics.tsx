import { useEffect, useState } from 'react'
import type { V3UiBridge } from '../bridge'
import type { HSETheme } from '../hse-theme'
import type { EngineStats } from '../../src/types'

function metric(value: number, digits: number): string {
  return Number.isFinite(value) ? value.toFixed(digits) : '—'
}

export function EngineMetrics({ bridge, theme }: { bridge: V3UiBridge; theme: HSETheme }) {
  const [stats, setStats] = useState<EngineStats>(() => bridge.getStats())

  useEffect(() => {
    const tick = () => setStats(bridge.getStats())
    tick()
    const timer = window.setInterval(tick, 300)
    return () => window.clearInterval(timer)
  }, [bridge])

  const sampleRate = bridge.getSampleRate()
  const latencyMs = sampleRate > 0 && Number.isFinite(sampleRate)
    ? stats.engineLatencySamples / sampleRate * 1000
    : NaN
  const items = [
    { label: '整合响度', value: metric(stats.lufsIntegrated, 1), unit: 'LUFS' },
    { label: '引擎延迟', value: metric(latencyMs, 1), unit: 'ms' },
    { label: '限幅衰减', value: metric(stats.limiterReductionDb, 1), unit: 'dB' },
  ]
  const signalItems = [
    { label: '峰值', value: metric(stats.peakDb, 1), unit: 'dBFS', description: '已测量音频的最高样本电平' },
    { label: '真峰值', value: metric(stats.truePeakDb, 1), unit: 'dBFS', description: '过采样估算的最高电平，包含样本之间的峰值' },
    { label: '响度范围', value: metric(stats.lra, 1), unit: 'LU', description: 'LRA：已测量音频的响度变化范围' },
  ]

  return (
    <div className="space-y-4">
      <dl className="grid grid-cols-3 divide-x" aria-label="引擎实时指标">
        {items.map((item) => (
          <div key={item.label} className="min-w-0 px-3 first:pl-0 last:pr-0" style={{ borderColor: theme.panelBorder }}>
            <dt className={`${theme.textSecondary} text-xs`}>{item.label}</dt>
            <dd className={`hse-mono mt-1 flex flex-wrap items-baseline gap-x-1 ${theme.textPrimary} font-semibold`}>
              <span className="text-xl">{item.value}</span>
              <span className={`${theme.textSecondary} text-xs font-normal`}>{item.unit}</span>
            </dd>
          </div>
        ))}
      </dl>
      <dl className="grid grid-cols-3 gap-3 rounded-xl border px-3 py-3" style={{ background: theme.inputBg, borderColor: theme.panelBorder }} aria-label="补充音频读数">
        {signalItems.map((item) => (
          <div key={item.label} className="min-w-0" title={item.description}>
            <dt className={`${theme.textSecondary} text-xs`}>{item.label}</dt>
            <dd className={`hse-mono mt-1 flex flex-wrap items-baseline gap-x-1 ${theme.textPrimary}`}>
              <span className="text-base font-semibold">{item.value}</span>
              <span className={`${theme.textSecondary} text-[11px]`}>{item.unit}</span>
            </dd>
          </div>
        ))}
      </dl>
    </div>
  )
}
