/**
 * 通用调音室 UI（GenericMixingStudio）
 *
 * 为没有自带 UI 的音频引擎（studioMode: 'generic'）提供调音室界面。
 * 自带外壳（遮罩+玻璃面板+头部+版本按钮+Tab 栏），通过 IAudioEngineUiBridge
 * 接口驱动参数读写/导出。
 *
 * 当前为骨架实现：
 *  - 参数页：若 getParamSchema() 返回结构化描述 → 渲染 EQ 滑块 + 音效开关；
 *    否则渲染 JSON 只读展示 + 导入导出
 *  - 调音器页：导出 WAV 按钮
 * 未来无 UI 引擎接入时可在此扩展（频谱分析、场景等）
 */

import { useState, useMemo, type ReactNode } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { AudioLines, SlidersHorizontal, FileAudio, X, Download, Upload } from 'lucide-react'
import type { IAudioEngineUiBridge, ParamSchema, MixingStudioCommonProps } from './types'

interface GenericMixingStudioProps extends MixingStudioCommonProps {
  bridge: IAudioEngineUiBridge
  sourceUrl?: string
  sourceDuration?: number
  /** 导出进行中状态（由 adapter 管理，通过 onExportingChange 通知 App 重渲染） */
  exporting?: boolean
}

type Tab = 'params' | 'export'

export default function GenericMixingStudio({
  bridge,
  onClose,
  playerTheme,
  anchorRect,
  engineVersion,
  onSwitchEngine,
  availableEngines,
  sourceUrl,
  sourceDuration,
  exporting = false,
}: GenericMixingStudioProps) {
  const dark = playerTheme === 'dark'
  const accentColor = (typeof localStorage !== 'undefined' && localStorage.getItem('accentColor')) || '#8b5cf6'
  const textPrimary = dark ? 'text-white' : 'text-slate-900'
  const textSecondary = dark ? 'text-white/65' : 'text-slate-600'
  const textTertiary = dark ? 'text-white/40' : 'text-slate-400'
  const glassPanel = dark ? 'rgba(10,12,20,0.38)' : 'rgba(255,255,255,0.45)'
  const glassBorder = dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'
  const glassBlur = 'blur(30px) saturate(185%)'
  const glassPanelHighlight = dark
    ? 'linear-gradient(to bottom, rgba(255,255,255,0.06), transparent)'
    : 'linear-gradient(to bottom, rgba(255,255,255,0.4), transparent)'
  const inputBg = dark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)'

  const [activeTab, setActiveTab] = useState<Tab>('params')
  const [params, setParams] = useState<unknown>(() => bridge.getParams())
  const [importText, setImportText] = useState('')
  const schema = useMemo<ParamSchema | null>(() => bridge.getParamSchema(), [bridge])

  const refreshParams = () => setParams(bridge.getParams())
  const handleExport = async () => {
    if (!sourceUrl) return
    try {
      await bridge.exportWav(sourceUrl, sourceDuration || 0)
    } catch (err) {
      window.dispatchEvent(new CustomEvent('showToast', {
        detail: { message: `导出失败：${err instanceof Error ? err.message : String(err)}`, type: 'error' },
      }))
    }
  }
  const handleImport = () => {
    try {
      const parsed = JSON.parse(importText)
      bridge.setParams(parsed)
      refreshParams()
      setImportText('')
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '参数已导入', type: 'info' } }))
    } catch {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '导入失败：JSON 格式无效', type: 'error' } }))
    }
  }
  const handleCopyExport = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(params, null, 2))
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '参数已复制到剪贴板', type: 'info' } }))
    } catch {
      /* noop */
    }
  }

  const toggleEffect = (key: string) => {
    if (!schema?.effects) return
    const effect = schema.effects.find((e) => e.key === key)
    if (!effect) return
    const current = bridge.getParams() as Record<string, unknown>
    const next = JSON.parse(JSON.stringify(current))
    if (next.effects && typeof next.effects === 'object') {
      (next.effects as Record<string, Record<string, unknown>>)[key] = {
        ...((next.effects as Record<string, Record<string, unknown>>)[key] || {}),
        enabled: !effect.enabled,
      }
    }
    bridge.setParams(next)
    refreshParams()
  }

  const tabs: Array<{ key: Tab; label: string; icon: typeof AudioLines }> = [
    { key: 'params', label: '参数', icon: SlidersHorizontal },
    { key: 'export', label: '导出', icon: FileAudio },
  ]

  const cx = typeof window !== 'undefined' ? window.innerWidth / 2 : 0
  const cy = typeof window !== 'undefined' ? window.innerHeight / 2 : 0
  const fx = anchorRect ? anchorRect.x - cx : 0
  const fy = anchorRect ? anchorRect.y - cy : 0

  return (
    <AnimatePresence>
      <motion.div
        key="generic-studio-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[70] flex items-center justify-center p-4 sm:p-8"
        style={{
          backgroundColor: dark ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.18)',
          backdropFilter: 'blur(6px) saturate(140%)',
          WebkitBackdropFilter: 'blur(6px) saturate(140%)',
        }}
        onClick={onClose}
      >
        <motion.div
          initial={{ scale: 0.5, opacity: 0, x: fx, y: fy }}
          animate={{ scale: 1, opacity: 1, x: 0, y: 0 }}
          exit={{ scale: 0.5, opacity: 0, x: fx, y: fy }}
          transition={{ type: 'spring', damping: 26, stiffness: 300, mass: 0.9 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-3xl max-h-[88vh] flex flex-col overflow-hidden rounded-3xl shadow-2xl"
          style={{
            background: glassPanel,
            backdropFilter: glassBlur,
            WebkitBackdropFilter: glassBlur,
            border: `1px solid ${glassBorder}`,
            boxShadow: '0 24px 64px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.2)',
          }}
        >
          {/* 面板顶部渐变高光 */}
          <div className="pointer-events-none absolute inset-x-0 top-0 h-24" style={{ background: glassPanelHighlight, borderRadius: '1.5rem 1.5rem 0 0' }} />

          {/* 头部 */}
          <div className="relative flex items-center justify-between px-5 py-4" style={{ borderBottom: `1px solid ${glassBorder}` }}>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center"
                style={{ backgroundColor: `${accentColor}2e`, border: `1px solid ${accentColor}55`, boxShadow: `0 4px 14px ${accentColor}33` }}>
                <AudioLines className="w-4.5 h-4.5" style={{ color: accentColor }} />
              </div>
              <div>
                <h2 className={`text-lg font-semibold ${textPrimary}`}>调音室</h2>
                <div className={`${textTertiary} text-[11px] -mt-0.5`}>通用调音 · {engineVersion}</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {onSwitchEngine && (
                <div className="flex items-center rounded-full p-0.5"
                  style={{ background: inputBg, border: `1px solid ${glassBorder}`, backdropFilter: 'blur(8px)' }}>
                  {(availableEngines || []).map((eng) => (
                    <button key={eng.id} type="button" onClick={() => onSwitchEngine(eng.id)}
                      title={eng.description}
                      className="px-2.5 py-1 rounded-full text-[11px] font-medium transition-all"
                      style={engineVersion === eng.id
                        ? { backgroundColor: accentColor, color: '#fff', boxShadow: `0 0 10px ${accentColor}55` }
                        : { color: textSecondary }}>
                      {eng.displayName}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" onClick={onClose}
                className={`p-2 rounded-full transition-colors ${dark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`}>
                <X className={`w-5 h-5 ${textSecondary}`} />
              </button>
            </div>
          </div>

          {/* Tab 栏 */}
          <div className="flex gap-1 px-5 pt-3" style={{ borderBottom: `1px solid ${glassBorder}` }}>
            {tabs.map((tab) => {
              const active = activeTab === tab.key
              return (
                <button key={tab.key} type="button" onClick={() => setActiveTab(tab.key)}
                  className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium transition-all border-b-2 ${active ? '' : 'border-transparent'}`}
                  style={active ? { color: accentColor, borderColor: accentColor } : { color: textSecondary }}>
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                </button>
              )
            })}
          </div>

          {/* 内容区 */}
          <div className="flex-1 overflow-y-auto p-5 space-y-4">
            {activeTab === 'params' && (
              <>
                {/* 结构化 EQ 滑块（若 schema 提供） */}
                {schema?.eqBands && schema.eqBands.length > 0 && (
                  <Card dark={dark} glassBorder={glassBorder} inputBg={inputBg} textPrimary={textPrimary} textSecondary={textSecondary} title="均衡器">
                    <div className="space-y-2">
                      {schema.eqBands.map((band, i) => (
                        <div key={i} className="flex items-center gap-3">
                          <span className={`text-xs w-16 ${textSecondary}`}>{band.label || `${band.frequency}Hz`}</span>
                          <input type="range" min={-12} max={12} step={0.5} defaultValue={band.gain}
                            className="flex-1 wf-glass-range"
                            onChange={(e) => {
                              const current = bridge.getParams() as Record<string, unknown>
                              const next = JSON.parse(JSON.stringify(current))
                              if (next.eq?.proBands) {
                                next.eq.proBands[i].gain = parseFloat(e.target.value)
                              }
                              bridge.setParams(next)
                            }}
                            style={{ accentColor }} />
                          <span className={`text-xs w-12 text-right ${textSecondary}`}>{band.gain > 0 ? '+' : ''}{band.gain.toFixed(1)}dB</span>
                        </div>
                      ))}
                    </div>
                  </Card>
                )}

                {/* 结构化音效开关（若 schema 提供） */}
                {schema?.effects && schema.effects.length > 0 && (
                  <Card dark={dark} glassBorder={glassBorder} inputBg={inputBg} textPrimary={textPrimary} textSecondary={textSecondary} title="音效">
                    <div className="grid grid-cols-2 gap-2">
                      {schema.effects.map((eff) => (
                        <button key={eff.key} type="button" onClick={() => toggleEffect(eff.key)}
                          className="flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-all"
                          style={eff.enabled
                            ? { backgroundColor: `${accentColor}1a`, border: `1px solid ${accentColor}44`, color: textPrimary }
                            : { background: inputBg, border: `1px solid ${glassBorder}`, color: textSecondary }}>
                          <span>{eff.label}</span>
                          <span className={`w-2 h-2 rounded-full ${eff.enabled ? '' : 'opacity-30'}`}
                            style={{ backgroundColor: eff.enabled ? accentColor : '#888' }} />
                        </button>
                      ))}
                    </div>
                  </Card>
                )}

                {/* JSON 参数展示 + 导入导出 */}
                <Card dark={dark} glassBorder={glassBorder} inputBg={inputBg} textPrimary={textPrimary} textSecondary={textSecondary} title="参数（JSON）">
                  <div className="flex gap-2 mb-2">
                    <button type="button" onClick={handleCopyExport}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                      style={{ background: inputBg, border: `1px solid ${glassBorder}`, color: textSecondary }}>
                      <Download className="w-3.5 h-3.5" /> 复制
                    </button>
                  </div>
                  <pre className={`text-xs p-3 rounded-lg overflow-auto max-h-48 ${textSecondary}`}
                    style={{ background: inputBg, border: `1px solid ${glassBorder}` }}>
                    {JSON.stringify(params, null, 2)}
                  </pre>
                  <div className="flex gap-2 mt-2">
                    <input value={importText} onChange={(e) => setImportText(e.target.value)}
                      placeholder='粘贴 JSON 参数...'
                      className={`flex-1 px-3 py-1.5 rounded-lg text-xs outline-none ${textPrimary}`}
                      style={{ background: inputBg, border: `1px solid ${glassBorder}` }} />
                    <button type="button" onClick={handleImport}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white transition-all hover:brightness-110"
                      style={{ backgroundColor: accentColor }}>
                      <Upload className="w-3.5 h-3.5" /> 导入
                    </button>
                  </div>
                </Card>
              </>
            )}

            {activeTab === 'export' && (
              <Card dark={dark} glassBorder={glassBorder} inputBg={inputBg} textPrimary={textPrimary} textSecondary={textSecondary} title="离线导出">
                <p className={`text-xs leading-relaxed mb-3 ${textSecondary}`}>
                  把当前参数离线渲染成 WAV 文件下载（个人处理用途，涉及版权曲目请勿分发）。
                </p>
                <button type="button" onClick={handleExport} disabled={!sourceUrl || exporting}
                  className="w-full py-2.5 rounded-lg text-sm font-medium text-white disabled:opacity-40 transition-all hover:brightness-110 active:scale-[0.98] flex items-center justify-center gap-2"
                  style={{ backgroundColor: accentColor, boxShadow: `0 6px 18px ${accentColor}44` }}>
                  <FileAudio className="w-4 h-4" />
                  {exporting ? '导出中…' : '导出 WAV'}
                </button>
                {!sourceUrl && <p className={`text-xs mt-2 ${textTertiary}`}>当前无播放源，无法导出</p>}
              </Card>
            )}
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}

// —— 内部卡片组件 ——

function Card({ dark, glassBorder, inputBg, textPrimary, textSecondary, title, children }: {
  dark: boolean
  glassBorder: string
  inputBg: string
  textPrimary: string
  textSecondary: string
  title: string
  children: ReactNode
}) {
  return (
    <div className="rounded-2xl p-4" style={{ background: inputBg, border: `1px solid ${glassBorder}` }}>
      <div className={`text-sm font-medium mb-3 ${textPrimary}`}>{title}</div>
      {children}
    </div>
  )
}
