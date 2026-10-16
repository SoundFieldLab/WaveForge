import { useState } from 'react'
import type { V3UiBridge } from '../bridge'
import type { HSETheme } from '../hse-theme'
import { EngineMetrics } from './EngineMetrics'
import { WaveformVisualizer } from './WaveformVisualizer'

export function WaveformPanel({ bridge, theme }: { bridge: V3UiBridge; theme: HSETheme }) {
  const [hasSignal, setHasSignal] = useState(false)
  const [hasRight, setHasRight] = useState<boolean | null>(null)

  return (
    <section className="min-w-0" aria-labelledby="realtime-audio-title">
      <h2 id="realtime-audio-title" className={`${theme.textPrimary} mb-2 text-sm font-semibold`}>实时音频</h2>
      <div className="relative h-[176px] sm:h-[190px]" data-testid="waveform-plot">
        <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 left-0 z-10 flex w-5 flex-col justify-around py-3 text-xs font-semibold" style={{ color: '#006A63' }}>
          <span>L</span>
          <span style={{ color: '#3E83A5' }}>R</span>
        </div>
        <div className="h-full w-full">
          <WaveformVisualizer
            bridge={bridge}
            onSignalChange={setHasSignal}
            onChannelChange={setHasRight}
          />
        </div>
        {!hasSignal && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center pl-6">
            <span className="rounded-md px-2 py-1 text-xs" style={{ color: '#536B66', background: '#F5F9F7E8' }}>
              等待音频信号
            </span>
          </div>
        )}
      </div>
      {hasRight === false && <p className={`${theme.textSecondary} mt-1 text-xs`}>当前音频源仅提供左声道</p>}
      <div className="mt-3 border-t pt-4" style={{ borderColor: '#DCEAE5' }}>
        <EngineMetrics bridge={bridge} theme={theme} />
      </div>
    </section>
  )
}
