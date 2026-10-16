/**
 * 调音器页 —— 分享串 / MP3 导出 / 引擎信息
 */

import { memo, useEffect, useId, useRef, useState } from 'react'
import { Copy, ClipboardPaste, FileAudio, Cpu, Share2 } from 'lucide-react'
import { GlassCard, RangeStyle } from '../components/Primitives'
import type { HSETheme } from '../hse-theme'
import type { V3UiBridge } from '../bridge'
import type { V3ParamsController } from '../hooks'

interface TunerPageProps {
  bridge: V3UiBridge
  controller: V3ParamsController
  theme: HSETheme
  onOpenEffect: (key: string) => void
  exportMp3?: (() => Promise<void>) | null
  exporting?: boolean
}

/** 实时统计局部轮询，不让读数刷新重绘分享输入框。 */
const EngineInfo = memo(function EngineInfo({ bridge, theme }: { bridge: V3UiBridge; theme: HSETheme }) {
  const [stats, setStats] = useState(() => bridge.getStats())
  useEffect(() => {
    setStats(bridge.getStats())
    const timer = window.setInterval(() => setStats(bridge.getStats()), 500)
    return () => window.clearInterval(timer)
  }, [bridge])
  const rate = bridge.getSampleRate()
  const latency = rate > 0 && Number.isFinite(rate) ? bridge.getLatencySamples() / rate * 1000 : NaN
  const number = (value: number, digits: number, unit: string) => Number.isFinite(value) ? `${value.toFixed(digits)} ${unit}` : '—'
  return (
    <GlassCard theme={theme} className="@container">
      <div className="flex items-center gap-2 mb-3">
        <Cpu className="w-4 h-4" style={{ color: theme.accentColor }} />
        <span className={`${theme.textPrimary} text-sm font-medium`}>引擎信息</span>
      </div>
      <div className="grid gap-2 text-xs @min-[20rem]:grid-cols-2">
        {[
          { label: '采样率', value: number(rate, 0, 'Hz') },
          { label: '引擎延迟', value: number(latency, 1, 'ms') },
          { label: '整合响度', value: number(stats.lufsIntegrated, 1, 'LUFS') },
          { label: '限幅衰减', value: number(stats.limiterReductionDb, 1, 'dB') },
        ].map((item) => (
          <div key={item.label} className="flex min-w-0 flex-col gap-1 rounded-xl border px-3 py-2.5" style={{ background: theme.inputBg, borderColor: theme.cardBorder }}>
            <span className={theme.textSecondary}>{item.label}</span>
            <span className={`hse-mono ${theme.textPrimary} break-words font-medium tabular-nums`}>{item.value}</span>
          </div>
        ))}
      </div>
    </GlassCard>
  )
})

export default function TunerPage({ bridge, controller, theme, exportMp3, exporting }: TunerPageProps) {
  const { params, replace } = controller
  const [shareText, setShareText] = useState('')
  const [importText, setImportText] = useState('')
  const [copied, setCopied] = useState(false)
  const [shareFeedback, setShareFeedback] = useState('')
  const [exportFeedback, setExportFeedback] = useState('')
  const [exportPending, setExportPending] = useState(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const shareId = useId()
  const importId = useId()
  useEffect(() => () => { if (copyTimer.current !== null) clearTimeout(copyTimer.current) }, [])

  const handleExportShare = () => {
    try {
      setShareText(bridge.encodeShare(params))
      setCopied(false)
      setShareFeedback('已生成当前配置的分享串。')
    } catch {
      setShareFeedback('生成分享串失败，请重试。')
    }
  }

  const handleCopyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareText)
      setCopied(true)
      setShareFeedback('分享串已复制。')
      if (copyTimer.current !== null) clearTimeout(copyTimer.current)
      copyTimer.current = setTimeout(() => setCopied(false), 1500)
    } catch { setShareFeedback('复制失败，请选中上方分享串后手动复制。') }
  }

  const handleImportShare = () => {
    if (!importText.trim()) return
    try {
      const decoded = bridge.decodeShare(importText.trim())
      replace(decoded)
      setImportText('')
      setShareFeedback('分享串已导入并应用，可以试听当前配置。')
    } catch {
      setShareFeedback('导入失败：分享串无效，请检查是否完整。')
    }
  }

  const handleExportMp3 = async () => {
    if (!exportMp3 || exporting || exportPending) return
    setExportPending(true)
    setExportFeedback('正在处理音乐，请稍候…')
    try {
      await exportMp3()
      // 文件下载/取消的结果由宿主展示，避免在取消时误报导出成功。
      setExportFeedback('')
    } catch { setExportFeedback('导出失败，请重试。') }
    finally { setExportPending(false) }
  }

  return (
    <div className="@container space-y-5">
      <RangeStyle theme={theme} />
      <p className={`${theme.textSecondary} text-sm leading-relaxed`}>分享当前调音配置，导入其他配置试听，或导出处理后的音乐。</p>

      <div className="grid items-start gap-5 @min-[48rem]:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        {/* 分享串 */}
        <GlassCard theme={theme}>
          <div className="flex items-center gap-2 mb-3">
            <Share2 className="w-4 h-4" style={{ color: theme.accentColor }} />
            <span className={`${theme.textPrimary} text-sm font-medium`}>分享串</span>
          </div>
          <p className={`${theme.textSecondary} text-xs leading-relaxed mb-4`}>生成分享串保存当前参数，或导入其他配置立即试听。</p>
          <div className="flex flex-wrap gap-2 mb-3">
            <button type="button" onClick={handleExportShare}
              className="hse-glass-button hse-glass-primary flex min-h-9 items-center gap-1 rounded-xl px-4 py-2 text-xs text-white">
              <Copy className="w-3.5 h-3.5" /> 生成分享串
            </button>
            {shareText && (
              <button type="button" onClick={() => void handleCopyShare()}
                className={`hse-glass-button flex min-h-9 items-center gap-1 rounded-xl px-4 py-2 text-xs ${theme.textSecondary}`}>
                <Copy className="w-3.5 h-3.5" /> {copied ? '已复制' : '复制'}
              </button>
            )}
          </div>
          {shareText && (
            <div className="mb-4">
              <label htmlFor={shareId} className={`block text-xs mb-2 ${theme.textSecondary}`}>当前配置分享串</label>
              <textarea id={shareId} readOnly value={shareText}
                className={`hse-glass-input hse-mono h-24 w-full resize-y rounded-xl px-3 py-2 text-xs ${theme.textPrimary}`} />
            </div>
          )}
          <div className="mt-5 border-t pt-5" style={{ borderColor: theme.cardBorder }}>
            <label htmlFor={importId} className={`block text-xs mb-2 font-medium ${theme.textPrimary}`}>导入 HSE 分享串</label>
            <div className="flex flex-col items-start gap-3">
              <textarea id={importId} value={importText} onChange={(e) => setImportText(e.target.value)}
                placeholder="粘贴 HSE 分享串（以 wf3: 开头）"
                className={`hse-glass-input hse-mono h-24 w-full min-w-0 resize-y rounded-xl px-3 py-2 text-xs ${theme.textPrimary}`} />
              <button type="button" onClick={handleImportShare} disabled={!importText.trim()}
                className="hse-glass-button hse-glass-primary flex min-h-9 items-center justify-center gap-1 rounded-xl px-4 py-2 text-xs text-white disabled:cursor-not-allowed disabled:opacity-60">
                <ClipboardPaste className="w-3.5 h-3.5" /> 导入并应用
              </button>
            </div>
          </div>
          <p role="status" className={`${shareFeedback ? 'mt-3' : ''} text-xs ${theme.textSecondary}`}>{shareFeedback}</p>
        </GlassCard>

        <div className="space-y-5">
          {/* MP3 导出 */}
          <GlassCard theme={theme}>
            <div className="flex items-center gap-2 mb-3">
              <FileAudio className="w-4 h-4" style={{ color: theme.accentColor }} />
              <span className={`${theme.textPrimary} text-sm font-medium`}>导出处理后的音乐</span>
            </div>
            <div className={`${theme.textSecondary} text-xs mb-3`}>将当前音乐按这份配置处理并导出为 MP3 文件。</div>
            {exportMp3 ? (
              <button type="button" onClick={() => void handleExportMp3()} disabled={exporting || exportPending}
                className="hse-glass-button hse-glass-primary flex min-h-11 w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50">
                <FileAudio className="w-4 h-4" />
                {exporting || exportPending ? '导出中…' : '导出 MP3'}
              </button>
            ) : (
              <div className={`${theme.textSecondary} text-xs`}>当前播放内容暂不支持导出。</div>
            )}
            <p role="status" className={`${exportFeedback ? 'mt-3' : ''} text-xs ${theme.textSecondary}`}>{exportFeedback}</p>
          </GlassCard>

          {/* 引擎信息 */}
          <EngineInfo bridge={bridge} theme={theme} />
        </div>
      </div>
    </div>
  )
}
