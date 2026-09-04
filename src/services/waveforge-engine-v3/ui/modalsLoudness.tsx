/**
 * WaveForge v3 调音室 UI —— 响度类配置弹窗
 *
 * 音量自适应补偿（等响度按音量通用曲线：auto/preset/custom 三模式，替代原"机型补偿"）
 * 与响度归一化（引擎内实时 BS.1770，无需外部服务）。
 */

import { Volume2, Gauge } from 'lucide-react'
import type { V3Theme } from './theme'
import { InfoLine, Modal, Segmented, Slider, Toggle } from './primitives'
import type { V3ParamsController } from './hooks'

/** v3 preset 模式预设（v2 兼容：flat/bass/vocal/warm/bright/night） */
export const COMP_PRESETS: { id: string; name: string; hint: string }[] = [
  { id: 'flat', name: '监听平直', hint: '中性直白' },
  { id: 'bass', name: '低频补偿', hint: '补足低频' },
  { id: 'vocal', name: '人声突出', hint: '突出中频人声' },
  { id: 'warm', name: '温暖', hint: '柔和暖声' },
  { id: 'bright', name: '通透', hint: '高频更亮' },
  { id: 'night', name: '夜间温和', hint: '低音量友好' },
]

/** custom 模式固定频点（v2 兼容 5 点） */
export const CUSTOM_BAND_FREQUENCIES = [80, 250, 1000, 4000, 12000]

/** auto 模式按音量曲线的展示辅助：给定音量百分比 → 低/高频提升 dB */
export function autoBoostAtVolume(volumePercent: number): { lowDb: number; highDb: number } {
  const spl = 50 + 30 * (Math.min(100, Math.max(0, volumePercent)) / 100)
  const lowDb = Math.min(12, Math.max(0, (80 - spl) * 0.35))
  const highDb = Math.min(6, Math.max(0, (80 - spl) * 0.15))
  return { lowDb, highDb }
}

/* ─────────────────────────── 音量自适应补偿 ─────────────────────────── */

export function LoudnessCompModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const comp = params.loudnessCompensation
  const mode = comp.mode
  const { lowDb, highDb } = autoBoostAtVolume(comp.volumePercent)

  const bands = comp.bands.length > 0
    ? comp.bands
    : CUSTOM_BAND_FREQUENCIES.map((frequency) => ({ frequency, gain: 0 }))

  return (
    <Modal title="音量自适应补偿" icon={<Volume2 className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>低音量下人耳对低频/高频不敏感。按系统音量动态补偿低频/高频（等响度通用曲线），或选择场景预设 / 自定义频段，让低音量听感更平衡。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 音量自适应补偿</span>
        <Toggle checked={comp.enabled} onChange={(v) => patch({ loudnessCompensation: { ...comp, enabled: v } })} theme={theme} />
      </div>

      <Segmented
        options={[
          { value: 'auto' as const, label: '自适应（等响度）' },
          { value: 'preset' as const, label: '场景预设' },
          { value: 'custom' as const, label: '自定义频段' },
        ]}
        value={mode}
        onChange={(v) => patch({ loudnessCompensation: { ...comp, mode: v } })}
        theme={theme}
      />

      {mode === 'auto' && (
        <>
          <Slider label="系统音量（补偿输入）" value={comp.volumePercent} min={0} max={100} step={1}
            onChange={(v) => patch({ loudnessCompensation: { ...comp, volumePercent: v } })}
            display={`${comp.volumePercent}%`} theme={theme} />
          <div className="rounded-2xl p-3 mb-3" style={{ background: `${theme.accentColor}12`, border: `1px solid ${theme.accentColor}44` }}>
            <div className={`${theme.textSecondary} text-[11px] mb-1.5`}>当前音量下的补偿曲线（等响度通用曲线）</div>
            <div className="flex gap-3 text-xs">
              <div className="flex-1">
                <div className={`${theme.textPrimary} font-medium`}>低频 120Hz</div>
                <div className="font-semibold" style={{ color: theme.accentColor }}>+{lowDb.toFixed(1)}dB</div>
              </div>
              <div className="flex-1">
                <div className={`${theme.textPrimary} font-medium`}>中频（不补偿）</div>
                <div className={`${theme.textSecondary}`}>0dB</div>
              </div>
              <div className="flex-1">
                <div className={`${theme.textPrimary} font-medium`}>高频 12kHz</div>
                <div className="font-semibold" style={{ color: theme.accentColor }}>+{highDb.toFixed(1)}dB</div>
              </div>
            </div>
            <div className={`${theme.textTertiary} text-[10px] mt-2`}>音量越低补偿越强：低频上限 +12dB、高频上限 +6dB；音量 100% 时曲线回平。</div>
          </div>
          <Slider label="最大提升" value={comp.maxBoostDb} min={0} max={24} step={1} onChange={(v) => patch({ loudnessCompensation: { ...comp, maxBoostDb: v } })} display={`${comp.maxBoostDb}dB`} theme={theme} />
          <Slider label="平滑时间" value={comp.smoothingSeconds} min={0.05} max={2} step={0.05} onChange={(v) => patch({ loudnessCompensation: { ...comp, smoothingSeconds: v } })} display={`${comp.smoothingSeconds.toFixed(2)}s`} theme={theme} />
          <InfoLine theme={theme}>音量变化由融合侧监听系统音量并写入 volumePercent；无系统音量源时可固定为 80。</InfoLine>
        </>
      )}

      {mode === 'preset' && (
        <>
          <div className={`${theme.textSecondary} text-xs mb-1.5`}>选择目标听感曲线（固定等响度曲线，不随音量变化）</div>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {COMP_PRESETS.map((p) => {
              const active = comp.preset === p.id
              return (
                <button key={p.id} type="button" title={p.hint} onClick={() => patch({ loudnessCompensation: { ...comp, mode: 'preset', preset: p.id } })}
                  className="px-3 py-1.5 rounded-lg text-xs transition-all"
                  style={active ? { backgroundColor: theme.accentColor, color: '#fff', boxShadow: `0 0 10px ${theme.accentColor}55` } : { background: theme.dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', color: theme.textSecondary }}>
                  {p.name}
                </button>
              )
            })}
          </div>
        </>
      )}

      {mode === 'custom' && (
        <>
          <div className={`${theme.textTertiary} text-xs leading-relaxed mb-3`}>自定义目标补偿曲线：拖动各频段增益（-8 ~ +8dB）。</div>
          {bands.map((band, i) => {
            const freq = CUSTOM_BAND_FREQUENCIES[i] ?? band.frequency
            const gain = band.gain || 0
            return (
              <div key={freq}>
                <div className="flex items-center justify-between mb-1">
                  <span className={`${theme.textSecondary} text-xs`}>{freq >= 1000 ? `${freq / 1000}k` : freq}Hz</span>
                  <span className={`${theme.textPrimary} text-xs font-medium`}>{gain > 0 ? '+' : ''}{gain.toFixed(1)}dB</span>
                </div>
                <input type="range" min={-8} max={8} step={0.5} value={gain}
                  onChange={(e) => {
                    const next = bands.map((b) => ({ ...b }))
                    if (next[i]) next[i].gain = parseFloat(e.target.value)
                    patch({ loudnessCompensation: { ...comp, mode: 'custom', bands: next } })
                  }}
                  className="wf-glass-range w-full h-2 rounded-full appearance-none cursor-pointer mb-3"
                  style={{ background: theme.sliderTrack(gain, -8, 8) }} />
              </div>
            )
          })}
        </>
      )}
    </Modal>
  )
}

/* ─────────────────────────── 响度归一化 ─────────────────────────── */

export function LoudnessNormModal({ controller, theme, onClose }: { controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  const { params, patch } = controller
  const ln = params.loudnessNormalization
  return (
    <Modal title="响度归一化" icon={<Gauge className="w-4.5 h-4.5" />} onClose={onClose} theme={theme}>
      <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>逐曲实时测量响度并对齐目标（BS.1770 引擎内测量，无需外部服务），切换歌曲音量一致。</p>
      <div className="flex items-center justify-between mb-4">
        <span className={`${theme.textPrimary} text-sm font-medium`}>启用 响度归一化</span>
        <Toggle checked={ln.enabled} onChange={(v) => patch({ loudnessNormalization: { ...ln, enabled: v } })} theme={theme} />
      </div>
      <Segmented
        options={[
          { value: true as const, label: '引擎内实时测量' },
          { value: false as const, label: '外部给定增益' },
        ]}
        value={ln.useRealtimeMeter}
        onChange={(v) => patch({ loudnessNormalization: { ...ln, useRealtimeMeter: v } })}
        theme={theme}
        small
      />
      <Slider label="目标响度" value={ln.targetLufs} min={-30} max={0} step={1} onChange={(v) => patch({ loudnessNormalization: { ...ln, targetLufs: v } })} display={`${ln.targetLufs} LUFS`} theme={theme} />
      <Slider label="最大增益（提升上限）" value={ln.maxGainDb} min={0} max={24} step={0.5} onChange={(v) => patch({ loudnessNormalization: { ...ln, maxGainDb: v } })} display={`+${ln.maxGainDb.toFixed(1)}dB`} theme={theme} />
      <Slider label="最小增益（衰减下限）" value={ln.minGainDb} min={-24} max={0} step={0.5} onChange={(v) => patch({ loudnessNormalization: { ...ln, minGainDb: v } })} display={`${ln.minGainDb.toFixed(1)}dB`} theme={theme} />
      {!ln.useRealtimeMeter && (
        <Slider label="外部增益（整曲测量换算）" value={ln.externalGainDb} min={-24} max={24} step={0.5} onChange={(v) => patch({ loudnessNormalization: { ...ln, externalGainDb: v } })} display={`${ln.externalGainDb > 0 ? '+' : ''}${ln.externalGainDb.toFixed(1)}dB`} theme={theme} />
      )}
      <InfoLine theme={theme}>实时测量模式下增益 3s 平滑过渡；测量未就绪时保持 0dB 不放大。</InfoLine>
    </Modal>
  )
}

/* 聚合导出 */
export function LoudnessModal({ effectKey: key, controller, theme, onClose }: { effectKey: 'loudnessCompensation' | 'loudnessNormalization'; controller: V3ParamsController; theme: V3Theme; onClose: () => void }) {
  if (key === 'loudnessCompensation') return <LoudnessCompModal controller={controller} theme={theme} onClose={onClose} />
  return <LoudnessNormModal controller={controller} theme={theme} onClose={onClose} />
}