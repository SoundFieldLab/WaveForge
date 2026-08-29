/**
 * 插件中心主弹窗（横向长方形、圆角、App Store 风格）。
 * 卡片：Logo + 名称 + 一句话简介 + 开关（未查看详情的插件禁用开关）。
 */

import { motion, AnimatePresence } from 'framer-motion'
import { X, Blocks, Download, Lock } from 'lucide-react'
import { useEffect, useMemo, useReducer } from 'react'
import { useTvBack } from '../tv/tvCore'
import { getAllPluginManifests } from '../plugins/registry'
import { openDetailGated, requestTogglePlugin } from '../plugins/toggle'
import { usePluginHostState, openPluginImport, closePluginCenter, PLUGIN_STATE_EVENT } from '../services/pluginStore'
import { isPluginEnabled, hasViewedDetail } from '../services/pluginStore'
import type { PluginManifest } from '../plugins/types'

function PluginLogo({ manifest, size = 56 }: { manifest: PluginManifest; size?: number }) {
  const color = manifest.iconColor || '#3B82F6'
  if (manifest.icon) {
    return (
      <img
        src={manifest.icon}
        alt={manifest.name}
        className="rounded-2xl object-cover shrink-0"
        style={{ width: size, height: size }}
        draggable={false}
      />
    )
  }
  return (
    <div
      className="flex items-center justify-center rounded-2xl shrink-0 shadow-lg"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, ${color}33, ${color}55)`,
        border: `1px solid ${color}66`,
        color,
      }}
    >
      <span className="font-bold" style={{ fontSize: size * 0.42 }}>{manifest.name.slice(0, 1).toUpperCase()}</span>
    </div>
  )
}

function PluginToggle({ manifest }: { manifest: PluginManifest }) {
  const enabled = isPluginEnabled(manifest.id)
  const gated = Boolean(manifest.requireNotice) && !hasViewedDetail(manifest.id)
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={gated}
      onClick={(e) => {
        e.stopPropagation()
        requestTogglePlugin(manifest.id, !enabled)
      }}
      title={gated ? '请先查看插件详情，再开启功能' : undefined}
      className={`relative h-6 w-11 flex-shrink-0 rounded-full transition-all duration-200 ${enabled ? '' : gated ? 'bg-white/10 cursor-not-allowed opacity-50' : 'bg-white/15'}`}
      style={enabled ? { backgroundColor: manifest.iconColor || '#3B82F6' } : undefined}
    >
      <span className={`pointer-events-none absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform duration-200 ${enabled ? 'translate-x-5' : ''}`} />
      {gated && <Lock className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-3 h-3 text-white/60 pointer-events-none" />}
    </button>
  )
}

export default function PluginCenterModal() {
  const { centerOpen } = usePluginHostState()
  const [version, force] = useReducer((x: number) => x + 1, 0)
  useTvBack(() => {
    if (centerOpen) {
      closePluginCenter()
      return true
    }
    return false
  }, [centerOpen])

  // 导入/开关/卸载等状态变化后刷新卡片
  useEffect(() => {
    const handler = () => force()
    window.addEventListener(PLUGIN_STATE_EVENT, handler)
    return () => window.removeEventListener(PLUGIN_STATE_EVENT, handler)
  }, [])

  const plugins = useMemo(() => getAllPluginManifests(), [centerOpen, version])
  const enabledCount = plugins.filter(p => isPluginEnabled(p.id)).length

  return (
    <AnimatePresence>
      {centerOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[90] flex items-center justify-center p-6"
          style={{ backgroundColor: 'rgba(5,8,14,0.78)', backdropFilter: 'blur(14px)' }}
          data-tv-scope
          onClick={closePluginCenter}
        >
          <motion.div
            initial={{ scale: 0.94, y: 16, opacity: 0 }}
            animate={{ scale: 1, y: 0, opacity: 1 }}
            exit={{ scale: 0.94, y: 16, opacity: 0 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-6xl h-[min(82vh,660px)] rounded-[28px] overflow-hidden flex flex-col border border-white/10 shadow-2xl"
            style={{
              background: 'linear-gradient(145deg, rgba(16,20,30,0.97) 0%, rgba(10,13,20,0.98) 60%, rgba(14,12,10,0.98) 100%)',
              backdropFilter: 'blur(60px) saturate(180%)',
            }}
          >
            {/* 顶部 */}
            <div className="flex items-center justify-between px-7 pt-6 pb-4 border-b border-white/[0.07]">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl flex items-center justify-center" style={{ background: 'linear-gradient(135deg,#f0b429,#d97706)', boxShadow: '0 8px 24px rgba(240,180,41,0.35)' }}>
                  <Blocks className="w-5 h-5 text-[#141005]" />
                </div>
                <div>
                  <h2 className="text-lg font-bold text-white tracking-tight">插件</h2>
                  <p className="text-[11px] text-white/40">为 WaveForge 扩展更多玩法 · 小功能通过插件引入</p>
                </div>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-white/45">{enabledCount > 0 ? `已启用 ${enabledCount} 个` : '全部默认关闭，手动开启后记住'}</span>
                <motion.button
                  whileHover={{ scale: 1.04 }}
                  whileTap={{ scale: 0.96 }}
                  onClick={openPluginImport}
                  className="flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-semibold text-[#141005] transition-shadow"
                  style={{ background: 'linear-gradient(135deg,#f5c84c,#e0a41f)', boxShadow: '0 8px 22px rgba(240,180,41,0.3)' }}
                >
                  <Download className="w-4 h-4" />
                  导入插件
                </motion.button>
                <button onClick={closePluginCenter} className="p-2 rounded-xl hover:bg-white/10 transition-colors" aria-label="关闭">
                  <X className="w-5 h-5 text-white/70" />
                </button>
              </div>
            </div>

            {/* 卡片网格 */}
            <div className="flex-1 overflow-y-auto px-7 py-5 plugin-center-scroll">
              {plugins.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center gap-3 text-white/40">
                  <Blocks className="w-10 h-10" />
                  <p className="text-sm">暂无插件，点击右上角「导入插件」安装第一个吧</p>
                  <motion.button
                    whileHover={{ scale: 1.04 }}
                    whileTap={{ scale: 0.96 }}
                    onClick={openPluginImport}
                    className="mt-1 rounded-xl px-5 py-2 text-sm font-semibold text-[#141005]"
                    style={{ background: 'linear-gradient(135deg,#f5c84c,#e0a41f)' }}
                  >
                    立即导入
                  </motion.button>
                </div>
              ) : (
                <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                  {plugins.map(plugin => {
                    const enabled = isPluginEnabled(plugin.id)
                    const gated = Boolean(plugin.requireNotice) && !hasViewedDetail(plugin.id)
                    return (
                      <motion.button
                        key={plugin.id}
                        type="button"
                        whileHover={{ y: -4 }}
                        whileTap={{ scale: 0.985 }}
                        onClick={() => openDetailGated(plugin.id)}
                        className="text-left group rounded-2xl border p-4 transition-colors"
                        style={{
                          borderColor: enabled ? `${plugin.iconColor || '#f0b429'}55` : 'rgba(255,255,255,0.09)',
                          background: enabled ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.03)',
                        }}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="flex items-center gap-3 min-w-0">
                            <PluginLogo manifest={plugin} size={48} />
                            <div className="min-w-0">
                              <div className="flex items-center gap-2">
                                <h3 className="text-sm font-bold text-white truncate">{plugin.name}</h3>
                                <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-md text-white/40 bg-white/[0.07]">{plugin.version}</span>
                              </div>
                              <p className="text-[11px] text-white/35 truncate">{plugin.developer}</p>
                            </div>
                          </div>
                          <PluginToggle manifest={plugin} />
                        </div>
                        <p className="mt-3 text-xs leading-relaxed text-white/55 line-clamp-2 min-h-[2em]">{plugin.description}</p>
                        <div className="mt-3 flex items-center gap-1.5 text-[11px] text-white/35">
                          <span className={`w-1.5 h-1.5 rounded-full ${enabled ? '' : 'bg-white/20'}`} style={enabled ? { background: plugin.iconColor || '#f0b429', boxShadow: `0 0 8px ${plugin.iconColor || '#f0b429'}` } : undefined} />
                          {gated ? '查看详情后即可开启' : enabled ? '运行中' : '未启用'}
                          <span className="ml-auto opacity-0 group-hover:opacity-100 transition-opacity">查看详情 ›</span>
                        </div>
                      </motion.button>
                    )
                  })}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}