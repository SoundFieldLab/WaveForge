/**
 * 调音器页 —— 分享串 / WAV 导出 / 引擎信息
 */

import { useState } from 'react'
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
  exportWav?: (() => Promise<void>) | null
  exporting?: boolean
}

export default function TunerPage({ bridge, controller, theme, exportWav, exporting }: TunerPageProps) {
  const { params, replace } = controller
  const [shareText, setShareText] = useState('')
  const [importText, setImportText] = useState('')
  const [copied, setCopied] = useState(false)

  const stats = bridge.getStats()

  const handleExportShare = () => {
    try { setShareText(bridge.encodeShare(params)) } catch (e) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '生成分享串失败', type: 'error' } }))
    }
  }

  const handleCopyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareText)
      setCopied(true)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '分享串已复制', type: 'info' } }))
      setTimeout(() => setCopied(false), 1500)
    } catch { handleExportShare() }
  }

  const handleImportShare = () => {
    try {
      const decoded = bridge.decodeShare(importText.trim())
      replace(decoded)
      setImportText('')
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '分享串已导入并应用', type: 'info' } }))
    } catch (e) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '导入失败：分享串无效', type: 'error' } }))
    }
  }

  return (
    <div className="space-y-4">
      <RangeStyle theme={theme} />

      {/* 分享串 */}
      <GlassCard theme={theme}>
        <div className="flex items-center gap-2 mb-3">
          <Share2 className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>分享串</span>
        </div>
        <div className="flex gap-2 mb-2">
          <button type="button" onClick={handleExportShare}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-white transition-all hover:brightness-110"
            style={{ backgroundColor: theme.accentColor }}>
            <Copy className="w-3.5 h-3.5" /> 生成分享串
          </button>
          {shareText && (
            <button type="button" onClick={() => void handleCopyShare()}
              className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs transition-all hover:brightness-110 ${theme.textSecondary}`}
              style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${theme.cardBorder}` }}>
              <Copy className="w-3.5 h-3.5" /> {copied ? '已复制' : '复制'}
            </button>
          )}
        </div>
        {shareText && (
          <textarea readOnly value={shareText}
            className={`w-full h-16 px-3 py-2 rounded-lg text-xs outline-none mb-3 text-white bg-white/5 border border-white/10`} />
        )}
        <div className="flex gap-2">
          <textarea value={importText} onChange={(e) => setImportText(e.target.value)}
            placeholder="粘贴 v3 分享串（以 wf3: 开头）"
            className="flex-1 h-14 px-3 py-2 rounded-lg text-xs outline-none text-white bg-white/5 border border-white/10" />
          <button type="button" onClick={handleImportShare}
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-white transition-all hover:brightness-110"
            style={{ backgroundColor: theme.accentColor }}>
            <ClipboardPaste className="w-3.5 h-3.5" /> 导入
          </button>
        </div>
      </GlassCard>

      {/* WAV 导出 */}
      <GlassCard theme={theme}>
        <div className="flex items-center gap-2 mb-3">
          <FileAudio className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>导出处理后的音乐</span>
        </div>
        <div className={`${theme.textSecondary} text-xs mb-3`}>把当前参数离线渲染成 WAV 文件下载（个人处理用途，涉及版权曲目请勿分发）。</div>
        {exportWav ? (
          <button type="button" onClick={() => void exportWav()} disabled={exporting}
            className="w-full py-2.5 rounded-lg text-sm font-medium text-white disabled:opacity-40 transition-all hover:brightness-110 active:scale-[0.98] flex items-center justify-center gap-2"
            style={{ backgroundColor: theme.accentColor }}>
            <FileAudio className="w-4 h-4" />
            {exporting ? '导出中…' : '导出 WAV'}
          </button>
        ) : (
          <div className={`${theme.textTertiary} text-xs`}>融合侧接入离线导出后显示此按钮。</div>
        )}
      </GlassCard>

      {/* 引擎信息 */}
      <GlassCard theme={theme}>
        <div className="flex items-center gap-2 mb-3">
          <Cpu className="w-4 h-4" style={{ color: theme.accentColor }} />
          <span className={`${theme.textPrimary} text-sm font-medium`}>引擎信息</span>
        </div>
        <div className="grid grid-cols-2 gap-2 text-xs">
          {[
            { label: '采样率', value: `${bridge.getSampleRate()} Hz` },
            { label: '引擎延迟', value: `${(bridge.getLatencySamples() / bridge.getSampleRate() * 1000).toFixed(1)} ms` },
            { label: '整合响度', value: `${Number.isFinite(stats.lufsIntegrated) ? stats.lufsIntegrated.toFixed(1) : '—'} LUFS` },
            { label: '限幅衰减', value: `${stats.limiterReductionDb.toFixed(1)} dB` },
          ].map((item) => (
            <div key={item.label} className="flex items-center justify-between px-3 py-2 rounded-lg bg-white/5 border border-white/10">
              <span className={`${theme.textSecondary}`}>{item.label}</span>
              <span className={`${theme.textPrimary} font-medium`}>{item.value}</span>
            </div>
          ))}
        </div>
      </GlassCard>
    </div>
  )
}
