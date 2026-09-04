import { useEffect, useState } from 'react'
import { AlertTriangle, Loader2, ShieldCheck, ShieldX } from 'lucide-react'
import type { VmpStatus } from '../electron'

type VmpStatusCardProps = {
  dark: boolean
  accent: string
  background?: string
  borderColor?: string
  textColor?: string
  mutedColor?: string
  compact?: boolean
}

const UNAVAILABLE: VmpStatus = {
  status: 'unavailable',
  kind: null,
  daysLeft: null,
  expiresAt: null,
  checkedAt: 0,
  source: 'development-verify',
}

export function getVmpStatusPresentation(status: VmpStatus | null) {
  if (!status) return { tone: 'loading' as const, label: '正在校验…', detail: '读取 production streaming VMP 状态' }
  if (status.status === 'valid') {
    return { tone: 'valid' as const, label: `有效，剩余 ${status.daysLeft} 天`, detail: 'Apple Music 原生 CENC 可使用生产 VMP' }
  }
  if (status.status === 'expiring') {
    const urgent = (status.daysLeft ?? 0) <= 30
    return {
      tone: urgent ? 'danger' as const : 'warning' as const,
      label: `即将到期，剩余 ${status.daysLeft} 天`,
      detail: urgent ? '请尽快重新签名并发布更新' : '建议安排重新签名和版本更新',
    }
  }
  if (status.status === 'expired') {
    return { tone: 'danger' as const, label: '已过期', detail: '需要重新签名；Apple 原生 CENC 可能不可用' }
  }
  if (status.status === 'invalid') {
    return { tone: 'danger' as const, label: '签名无效', detail: '未检测到有效的 production streaming VMP' }
  }
  return { tone: 'muted' as const, label: '状态不可用', detail: '当前环境无法执行 VMP 校验' }
}

export default function VmpStatusCard({
  dark,
  accent,
  background,
  borderColor,
  textColor,
  mutedColor,
  compact = false,
}: VmpStatusCardProps) {
  const [status, setStatus] = useState<VmpStatus | null>(null)

  useEffect(() => {
    let active = true
    const bridge = window.electron?.diagnostics?.getVmpStatus
    if (!bridge) {
      setStatus(UNAVAILABLE)
      return () => { active = false }
    }
    void bridge()
      .then(value => { if (active) setStatus(value) })
      .catch(() => { if (active) setStatus(UNAVAILABLE) })
    return () => { active = false }
  }, [])

  const presentation = getVmpStatusPresentation(status)
  const toneColor = presentation.tone === 'valid'
    ? '#22c55e'
    : presentation.tone === 'warning'
      ? '#f59e0b'
      : presentation.tone === 'danger'
        ? '#ef4444'
        : presentation.tone === 'loading'
          ? accent
          : (mutedColor || (dark ? 'rgba(255,255,255,0.5)' : 'rgba(15,23,42,0.55)'))
  const Icon = presentation.tone === 'loading'
    ? Loader2
    : presentation.tone === 'valid'
      ? ShieldCheck
      : presentation.tone === 'muted'
        ? AlertTriangle
        : ShieldX
  const expiry = status?.expiresAt
    ? new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(status.expiresAt))
    : null

  return (
    <div
      data-testid="vmp-status-card"
      className={`flex items-start justify-between gap-3 rounded-lg border ${compact ? 'px-3 py-2.5' : 'p-3'}`}
      style={{
        background: background || (dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)'),
        borderColor: borderColor || (dark ? 'rgba(255,255,255,0.1)' : 'rgba(15,23,42,0.1)'),
      }}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${presentation.tone === 'loading' ? 'animate-spin' : ''}`} style={{ color: toneColor }} />
        <div className="min-w-0">
          <div className="text-xs font-medium" style={{ color: textColor || (dark ? 'rgba(255,255,255,0.92)' : 'rgba(15,23,42,0.92)') }}>
            Production streaming VMP
          </div>
          <div className="mt-0.5 text-[11px] leading-4" style={{ color: mutedColor || (dark ? 'rgba(255,255,255,0.5)' : 'rgba(15,23,42,0.58)') }}>
            {presentation.detail}{expiry ? ` · 约到期 ${expiry}` : ''}
          </div>
        </div>
      </div>
      <span className="flex-shrink-0 text-[11px] font-medium tabular-nums" style={{ color: toneColor }}>
        {presentation.label}
      </span>
    </div>
  )
}
