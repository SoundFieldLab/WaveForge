/**
 * WaveForge v3 调音室 UI —— 调音器页（分享串 / MP3 导出 / 引擎信息）
 *
 * v3 分享串：完整参数快照（版本 + FNV-1a 校验 + 白名单解码），比 v2 的 EQ JSON 更完整。
 * MP3 导出与引擎信息（latency/采样率）供融合侧接线。
 */

import { useState } from 'react'
import { Copy, ClipboardPaste, FileAudio, Cpu, Info } from 'lucide-react'
import type { V3Theme } from './theme'
import type { V3UiBridge } from './bridge'
import { ActionButton, GlassCard, InfoLine, SectionTitle } from './primitives'
import type { V3ParamsController } from './hooks'

export interface SharePanelProps {
  controller: V3ParamsController
  bridge: V3UiBridge
  theme: V3Theme
  /** 离线导出（融合侧实现：解码 → EngineV3.process → lamejs MP3） */
  exportMp3?: (() => Promise<void>) | null
  /** 导出进行中状态由父级管理 */
  exporting?: boolean
}

export function SharePanel({ controller, bridge, theme, exportMp3, exporting }: SharePanelProps) {
  const { params, replace } = controller
  const [shareText, setShareText] = useState('')
  const [importText, setImportText] = useState('')
  const [copied, setCopied] = useState(false)

  const handleExportShare = () => {
    try {
      setShareText(bridge.encodeShare(params))
    } catch (e) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '生成分享串失败：' + (e instanceof Error ? e.message : '未知错误'), type: 'error' } }))
    }
  }

  const handleCopyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareText)
      setCopied(true)
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '分享串已复制到剪贴板', type: 'info' } }))
      setTimeout(() => setCopied(false), 1500)
    } catch {
      handleExportShare()
    }
  }

  const handleImportShare = () => {
    try {
      const decoded = bridge.decodeShare(importText.trim())
      replace(decoded)
      setImportText('')
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '分享串已导入并应用', type: 'info' } }))
    } catch (e) {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '导入失败：' + (e instanceof Error ? e.message : '分享串无效'), type: 'error' } }))
    }
  }

  const stats = bridge.getStats()

  return (
    <div className="space-y-3">
      {/* 分享串 */}
      <GlassCard theme={theme}>
        <SectionTitle icon={<Copy className="w-4 h-4" style={{ color: theme.accentColor }} />} theme={theme}
          hint="完整参数快照（版本 + 校验 + 白名单），跨设备导入安全">
          分享串
        </SectionTitle>
        <div className="flex gap-2 mb-2">
          <ActionButton onClick={handleExportShare} theme={theme}>生成分享串</ActionButton>
          {shareText && (
            <ActionButton onClick={() => void handleCopyShare()} theme={theme} ghost>
              <Copy className="w-3.5 h-3.5" /> {copied ? '已复制' : '复制'}
            </ActionButton>
          )}
        </div>
        {shareText && (
          <textarea readOnly value={shareText} className={`w-full h-20 px-3 py-2 rounded-lg text-xs outline-none mb-3 ${theme.textPrimary}`}
            style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }} />
        )}
        <div className="flex gap-2">
          <textarea value={importText} onChange={(e) => setImportText(e.target.value)} placeholder="粘贴 v3 分享串（以 wf3: 开头的字符串）"
            className={`flex-1 h-16 px-3 py-2 rounded-lg text-xs outline-none ${theme.textPrimary}`}
            style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }} />
          <ActionButton onClick={handleImportShare} theme={theme}>
            <ClipboardPaste className="w-4 h-4" /> 导入
          </ActionButton>
        </div>
        <InfoLine theme={theme}>分享串含校验码，被篡改/截断的串会被拒绝；卷积 IR 以名称引用，不随串传输。</InfoLine>
      </GlassCard>

      {/* MP3 导出 */}
      <GlassCard theme={theme}>
        <SectionTitle icon={<FileAudio className="w-4 h-4" style={{ color: theme.accentColor }} />} theme={theme}>
          导出处理后的音乐
        </SectionTitle>
        <div className={`${theme.textSecondary} text-xs mb-3`}>把当前参数离线渲染成 MP3 文件下载（个人处理用途，涉及版权曲目请勿分发）；离线与实时共用同一内核，逐样本一致。</div>
        {exportMp3 ? (
          <button type="button" onClick={() => void exportMp3()} disabled={exporting}
            className="w-full py-2.5 rounded-lg text-sm font-medium text-white disabled:opacity-40 transition-all hover:brightness-110 active:scale-[0.98] flex items-center justify-center gap-2"
            style={{ backgroundColor: theme.accentColor, boxShadow: `0 6px 18px ${theme.accentColor}44` }}>
            <FileAudio className="w-4 h-4" />
            {exporting ? '导出中…' : '导出 MP3'}
          </button>
        ) : (
          <div className={`${theme.textTertiary} text-xs`}>融合侧接入离线导出后显示此按钮（见 UI_GUIDE）。</div>
        )}
      </GlassCard>

      {/* 引擎信息 */}
      <GlassCard theme={theme}>
        <SectionTitle icon={<Cpu className="w-4 h-4" style={{ color: theme.accentColor }} />} theme={theme}>引擎信息</SectionTitle>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}>
            <span className={`${theme.textSecondary}`}>采样率</span>
            <span className={`${theme.textPrimary} font-medium`}>{bridge.getSampleRate()} Hz</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}>
            <span className={`${theme.textSecondary}`}>引擎延迟</span>
            <span className={`${theme.textPrimary} font-medium`}>{(bridge.getLatencySamples() / bridge.getSampleRate() * 1000).toFixed(1)} ms</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}>
            <span className={`${theme.textSecondary}`}>整合响度</span>
            <span className={`${theme.textPrimary} font-medium`}>{Number.isFinite(stats.lufsIntegrated) ? stats.lufsIntegrated.toFixed(1) : '—'} LUFS</span>
          </div>
          <div className="flex items-center justify-between px-3 py-2 rounded-lg" style={{ background: theme.inputBg, border: `1px solid ${theme.glassBorder}` }}>
            <span className={`${theme.textSecondary}`}>限幅衰减</span>
            <span className={`${theme.textPrimary} font-medium`}>{stats.limiterReductionDb.toFixed(1)} dB</span>
          </div>
        </div>
        <InfoLine theme={theme}><Info className="w-3 h-3 shrink-0" /> 响度/限幅读数实时更新，详细分析见「分析」页。</InfoLine>
      </GlassCard>
    </div>
  )
}