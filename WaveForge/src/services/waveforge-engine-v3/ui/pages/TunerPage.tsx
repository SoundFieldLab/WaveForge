/**
 * 调音器页 —— 分享串 / WAV 导出 / 引擎信息
 */

import { useEffect, useState } from 'react'
import { X, Copy, ClipboardPaste, FileAudio, Cpu, Share2 } from 'lucide-react'
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

  // WAV 导出免责确认（每次导出前 8 秒倒计时）
  const [showExportDisclaimer, setShowExportDisclaimer] = useState(false)
  const [exportCountdown, setExportCountdown] = useState(8)

  useEffect(() => {
    if (!showExportDisclaimer || exportCountdown <= 0) return
    const timer = window.setTimeout(() => setExportCountdown(value => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [showExportDisclaimer, exportCountdown])

  const handleExportClick = () => {
    setExportCountdown(8)
    setShowExportDisclaimer(true)
  }

  const confirmExport = () => {
    setShowExportDisclaimer(false)
    if (exportWav) void exportWav()
  }

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
          <button type="button" onClick={handleExportClick} disabled={exporting}
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

      {/* WAV 导出免责确认弹窗（8 秒倒计时） */}
      {showExportDisclaimer && (
        <div
          className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
          onClick={() => setShowExportDisclaimer(false)}
        >
          <div
            className="w-full max-w-lg rounded-2xl border overflow-hidden flex flex-col shadow-2xl"
            style={{ background: '#17140f', borderColor: theme.cardBorder }}
            onClick={(e) => e.stopPropagation()}
          >
            {/* 标题栏 */}
            <div className="flex items-center justify-between px-6 py-4 border-b" style={{ borderColor: theme.cardBorder }}>
              <div className={`${theme.textPrimary} text-lg font-bold`}>导出 WAV · 版权确认</div>
              <button type="button" onClick={() => setShowExportDisclaimer(false)} className="p-2 rounded-lg transition-colors hover:bg-white/10" aria-label="关闭">
                <X className="w-5 h-5" style={{ color: theme.textSecondary }} />
              </button>
            </div>
            {/* 内容区域 */}
            <div className="px-6 py-5 space-y-4 text-sm leading-relaxed" style={{ color: theme.textSecondary }}>
              <div>
                <div className={`${theme.textPrimary} text-base font-semibold mb-2`}>导出前请仔细阅读</div>
                <p>导出的 WAV 文件是您对当前播放曲目进行音效处理后的音频，其版权归原权利人所有。点击"确定"即表示您已知悉并同意：</p>
              </div>
              <ul className="list-disc pl-5 space-y-1.5">
                <li>导出的文件<strong className={theme.textPrimary}>仅限个人学习、研究、音效调试等非商业用途</strong>使用；</li>
                <li><strong className={theme.textPrimary}>严禁</strong>将导出的文件上传、分享、转售、公开发布或以任何形式向他人传播，尤其涉及受版权保护的曲目；</li>
                <li>因下载、分发、商用或其他违法行为产生的全部法律责任由<strong className={theme.textPrimary}>您本人自行承担</strong>，软件开发者不承担任何责任。</li>
              </ul>
            </div>
            {/* 底部按钮 */}
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t" style={{ borderColor: theme.cardBorder }}>
              <button
                type="button"
                onClick={() => setShowExportDisclaimer(false)}
                className="px-5 py-2.5 rounded-xl text-sm font-medium transition-colors hover:bg-white/10"
                style={{ color: theme.textPrimary, background: 'rgba(255,255,255,0.06)' }}
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmExport()}
                disabled={exportCountdown > 0}
                className={`px-5 py-2.5 rounded-xl text-sm font-semibold transition-all ${exportCountdown > 0 ? 'opacity-50 cursor-not-allowed' : 'hover:brightness-110'}`}
                style={{ backgroundColor: theme.accentColor, color: '#ffffff' }}
              >
                确定{exportCountdown > 0 ? `（${exportCountdown}）` : ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
