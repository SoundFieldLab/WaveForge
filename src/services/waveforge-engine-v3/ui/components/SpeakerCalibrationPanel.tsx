import { useRef, useState } from 'react'
import { calibrateSpeakerGeometry, calibrateSpeakerMeasurement, type SpeakerCalibrationResult } from '../../src/spatial/SpeakerCalibration'
import type { SpeakerCancellationSettings } from '../../src/spatial/CrosstalkCancellation'
import type { HSETheme } from '../hse-theme'
import { ActionBtn, InfoLine } from './Primitives'

/** 同组串扰参数的摆位估算与四路实测 IR 分析；不采集或生成个人 HRTF。 */
export function SpeakerCalibrationPanel({ theme, sampleRate, onApply }: {
  theme: HSETheme; sampleRate: number; onApply: (settings: SpeakerCancellationSettings) => void
}) {
  const [width, setWidth] = useState(1.5), [distance, setDistance] = useState(1.5)
  const [offset, setOffset] = useState(0), [yaw, setYaw] = useState(0)
  const [result, setResult] = useState<SpeakerCalibrationResult | null>(null)
  const [message, setMessage] = useState('')
  const picker = useRef<HTMLInputElement>(null)
  const field = (label: string, value: number, set: (value: number) => void, min: number, max: number) =>
    <label className={`text-xs ${theme.textSecondary}`}>{label}<input type="number" aria-label={label} value={value}
      min={min} max={max} step={0.05} className={`mt-1.5 min-h-10 w-full rounded-xl border px-3 ${theme.textPrimary}`}
      style={{ background: theme.inputBg, borderColor: theme.cardBorder }} onChange={event => {
        const next = event.currentTarget.valueAsNumber
        if (Number.isFinite(next) && next >= min && next <= max) set(next)
      }} /></label>
  return <div className="mt-4 space-y-3">
    <div className="grid grid-cols-2 gap-3">
      {field('音箱间距 m', width, setWidth, 0.2, 20)}
      {field('听者距音箱前沿 m', distance, setDistance, 0.2, 20)}
      {field('听者向右偏移 m', offset, setOffset, -10, 10)}
      {field('听者向右转头 °', yaw, setYaw, -90, 90)}
    </div>
    <div className="flex flex-wrap gap-2"><ActionBtn theme={theme} ghost onClick={() => {
      try {
        setResult(calibrateSpeakerGeometry({ leftSpeaker: { x: -width / 2, y: distance, z: 0 },
          rightSpeaker: { x: width / 2, y: distance, z: 0 }, listener: { x: offset, y: 0, z: 0 }, listenerYawDeg: yaw, sampleRate }))
        setMessage('已估算，请检查结果后应用。')
      } catch (error) { setResult(null); setMessage(error instanceof Error ? error.message : '摆位估算失败') }
    }}>估算摆位参数</ActionBtn>
      <ActionBtn theme={theme} ghost onClick={() => picker.current?.click()}>导入双耳测量 IR</ActionBtn>
      <ActionBtn theme={theme} disabled={!result?.settings.enabled} onClick={() => {
        if (result?.settings.enabled) { onApply(result.settings); setMessage('已将校准参数应用到串扰消除。') }
      }}>应用校准参数</ActionBtn></div>
    <input ref={picker} type="file" accept=".json,application/json" className="hidden" aria-label="双音箱测量 IR 文件" onChange={async event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''
      if (!file) return
      try {
        if (file.size > 32 * 1024 * 1024) throw new Error('测量文件不能超过 32 MiB')
        const value: unknown = JSON.parse(await file.text())
        if (!value || typeof value !== 'object') throw new Error('测量文件必须为 JSON 对象')
        const data = value as Record<string, unknown>
        const ir = (key: string) => {
          const samples = data[key]
          if (!Array.isArray(samples) || samples.length > 2_000_000 || !samples.every(x => typeof x === 'number' && Number.isFinite(x)))
            throw new Error(`${key} 必须为有限数值数组`)
          return Float32Array.from(samples)
        }
        if (typeof data.sampleRate !== 'number') throw new Error('测量文件缺少数值 sampleRate')
        setResult(calibrateSpeakerMeasurement({ sampleRate: data.sampleRate,
          leftSpeakerToLeftEar: ir('leftSpeakerToLeftEar'), leftSpeakerToRightEar: ir('leftSpeakerToRightEar'),
          rightSpeakerToRightEar: ir('rightSpeakerToRightEar'), rightSpeakerToLeftEar: ir('rightSpeakerToLeftEar') }))
        setMessage(`已分析 ${file.name}，请检查结果后应用。`)
      } catch (error) { setResult(null); setMessage(error instanceof Error ? error.message : '测量文件解析失败') }
    }} />
    {result && <div className={`rounded-xl border p-3 text-xs leading-relaxed ${theme.textSecondary}`} style={{ borderColor: theme.cardBorder }}>
      <p>{result.method === 'geometry' ? '几何估算' : '实测 IR 分析'} · 时差 {result.settings.delayMs.toFixed(3)} ms · 强度 {(result.settings.amount * 100).toFixed(0)}% · 上限 {result.settings.cutoffHz.toFixed(0)} Hz</p>
      {result.limitations.map((text, index) => <p className="mt-1" key={index}>{text}</p>)}
    </div>}
    <p role="status" className={`text-xs ${theme.textSecondary}`}>{message}</p>
    <InfoLine theme={theme}>几何估算按音箱与耳位计算声路；实测文件包含 sampleRate 与左右音箱分别到双耳的四条同时间基准 IR。输入应已完成测试信号反卷积。</InfoLine>
  </div>
}
