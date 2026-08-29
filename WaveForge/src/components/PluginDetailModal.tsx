/**
 * 插件详情弹窗：大 Logo、名称、版本、开发者、更新日期、详细介绍、运行截图区、
 * 右上角开关（同样受「首次开启须知」门控）、卸载（仅导入插件）、DG_LAB 控制台入口。
 */

import { useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Trash2, Download } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'
import { getPluginManifest, isBuiltinPlugin } from '../plugins/registry'
import { requestTogglePlugin, showToast } from '../plugins/toggle'
import {
  usePluginHostState,
  closePluginDetail,
  isPluginEnabled,
  hasViewedDetail,
  uninstallImportedPlugin,
} from '../services/pluginStore'

function ScreenshotTile({ index, manifest }: { index: number; manifest: ReturnType<typeof getPluginManifest> }) {
  const color = manifest?.iconColor || '#3B82F6'
  const src = manifest?.screenshots?.[index]
  if (src) {
    return <img src={src} alt={`截图${index + 1}`} className="w-full aspect-video rounded-xl object-cover border border-white/10" draggable={false} />
  }
  return (
    <div
      className="w-full aspect-video rounded-xl flex items-center justify-center border"
      style={{
        background: `linear-gradient(135deg, ${color}22, ${color}08), linear-gradient(160deg, rgba(255,255,255,0.04), transparent)`,
        borderColor: `${color}44`,
      }}
    >
      <span className="text-xs text-white/35">运行截图占位 {index + 1}</span>
    </div>
  )
}

export default function PluginDetailModal() {
  const { detailPluginId } = usePluginHostState()
  const [confirmUninstall, setConfirmUninstall] = useState(false)
  useTvBack(() => {
    if (detailPluginId) {
      closePluginDetail()
      return true
    }
    return false
  }, [detailPluginId])

  const manifest = detailPluginId ? getPluginManifest(detailPluginId) : undefined
  if (!detailPluginId || !manifest) return null

  const enabled = isPluginEnabled(manifest.id)
  const gated = Boolean(manifest.requireNotice) && !hasViewedDetail(manifest.id)
  const builtin = isBuiltinPlugin(manifest.id)
  const screenshotCount = Math.max(2, manifest.screenshots?.length ?? 2)

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[92] flex items-center justify-center p-6"
        style={{ backgroundColor: 'rgba(5,8,14,0.8)', backdropFilter: 'blur(14px)' }}
        data-tv-scope
        onClick={closePluginDetail}
      >
        {confirmUninstall && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[94] flex items-center justify-center p-4"
            style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
            onClick={() => setConfirmUninstall(false)}
          >
            <motion.div
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.94, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-sm rounded-2xl border border-white/10 bg-[#14171f] p-6 shadow-2xl"
            >
              <h3 className="text-[15px] font-bold text-white">卸载插件「{manifest.name}」？</h3>
              <p className="mt-2 text-xs leading-relaxed text-white/50">
                卸载后将移除该插件的开关与使用记录，插件的波形等数据不受影响。内置插件不可卸载。
              </p>
              <div className="mt-5 flex items-center justify-end gap-3">
                <button onClick={() => setConfirmUninstall(false)} className="rounded-xl bg-white/10 hover:bg-white/15 px-4 py-2 text-sm text-white/80">取消</button>
                <button
                  onClick={() => {
                    uninstallImportedPlugin(manifest.id)
                    setConfirmUninstall(false)
                    closePluginDetail()
                    showToast(`插件「${manifest.name}」已卸载`, 'info')
                  }}
                  className="rounded-xl px-4 py-2 text-sm font-semibold text-white"
                  style={{ backgroundColor: '#ef4444' }}
                >
                  确认卸载
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}

        <motion.div
          initial={{ scale: 0.94, y: 16, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.94, y: 16, opacity: 0 }}
          transition={{ type: 'spring', damping: 28, stiffness: 320 }}
          onClick={(e) => e.stopPropagation()}
          className="relative w-full max-w-5xl h-[min(84vh,640px)] rounded-[28px] overflow-hidden flex flex-col border border-white/10 shadow-2xl"
          style={{
            background: `linear-gradient(150deg, ${manifest.iconColor || '#16324f'}14, rgba(10,13,20,0.98) 45%, rgba(10,12,14,0.98) 100%)`,
            backdropFilter: 'blur(60px) saturate(180%)',
          }}
        >
          {/* 顶部：TitleBar 区（大 Logo + 元信息 + 右上角开关） */}
          <div className="flex items-start justify-between gap-6 px-8 pt-7 pb-5 border-b border-white/[0.07]">
            <div className="flex items-center gap-5 min-w-0">
              {manifest.icon ? (
                <img src={manifest.icon} alt={manifest.name} className="w-24 h-24 rounded-3xl object-cover shadow-2xl shrink-0" draggable={false} />
              ) : (
                <div
                  className="w-24 h-24 rounded-3xl flex items-center justify-center shrink-0 shadow-2xl"
                  style={{
                    background: `linear-gradient(135deg, ${manifest.iconColor || '#3B82F6'}44, ${manifest.iconColor || '#3B82F6'}77)`,
                    border: `1px solid ${manifest.iconColor || '#3B82F6'}88`,
                    color: manifest.iconColor || '#7ab8ff',
                  }}
                >
                  <span className="font-black text-5xl">{manifest.name.slice(0, 1).toUpperCase()}</span>
                </div>
              )}
              <div className="min-w-0 pt-1">
                <h2 className="text-2xl font-bold text-white tracking-tight">{manifest.name}</h2>
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-white/45">
                  <span>版本 <b className="text-white/70">{manifest.version}</b></span>
                  <span>开发者 <b className="text-white/70">{manifest.developer}</b></span>
                  <span>更新日期 <b className="text-white/70">{manifest.updated}</b></span>
                </div>
                <p className="mt-2 text-[13px] text-white/55 max-w-[520px] leading-relaxed">{manifest.description}</p>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0 pt-1">
              {!builtin && (
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={() => setConfirmUninstall(true)}
                  className="flex items-center gap-1.5 rounded-xl px-3 py-2 text-xs text-white/55 hover:text-red-400 bg-white/[0.06] hover:bg-red-500/15 transition-colors"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  卸载
                </motion.button>
              )}
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                disabled={gated}
                title={gated ? '请先在右上角查看详情并阅读须知' : undefined}
                onClick={() => requestTogglePlugin(manifest.id, !enabled)}
                className={`relative h-7 w-12 flex-shrink-0 rounded-full transition-all duration-200 ${enabled ? '' : gated ? 'bg-white/10 opacity-55 cursor-not-allowed' : 'bg-white/15'}`}
                style={enabled ? { backgroundColor: manifest.iconColor || '#f0b429' } : undefined}
              >
                <span className={`pointer-events-none absolute left-0.5 top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform duration-200 ${enabled ? 'translate-x-5' : ''}`} />
              </button>
              <button onClick={closePluginDetail} className="p-2 rounded-xl hover:bg-white/10 transition-colors" aria-label="关闭">
                <X className="w-5 h-5 text-white/70" />
              </button>
            </div>
          </div>

          {/* 内容区 */}
          <div className="flex-1 overflow-y-auto px-8 py-6 space-y-6 plugin-center-scroll">
            {(manifest.detail ?? []).length > 0 && (
              <section>
                <h3 className="text-sm font-bold text-white/80 mb-3 flex items-center gap-2">
                  <span className="w-1 h-4 rounded-full" style={{ background: manifest.iconColor || '#f0b429' }} />
                  详细介绍
                </h3>
                <div className="space-y-2.5">
                  {(manifest.detail ?? []).map((paragraph, index) => (
                    <p key={index} className={`text-[13px] leading-relaxed ${index === 0 ? 'text-white/70' : 'text-white/50'}`}>{paragraph}</p>
                  ))}
                </div>
              </section>
            )}

            <section>
              <h3 className="text-sm font-bold text-white/80 mb-3 flex items-center gap-2">
                <span className="w-1 h-4 rounded-full" style={{ background: manifest.iconColor || '#f0b429' }} />
                运行截图
              </h3>
              <div className="grid gap-4 grid-cols-2 md:grid-cols-3">
                {Array.from({ length: screenshotCount }, (_, index) => <ScreenshotTile key={index} index={index} manifest={manifest} />)}
              </div>
            </section>
          </div>

          <div className="px-8 py-4 border-t border-white/[0.07] flex items-center justify-between">
            <span className="text-[11px] text-white/35 flex items-center gap-1.5">
              <Download className="w-3.5 h-3.5" />
              {builtin ? '内置插件 · 随应用发布' : `导入于 ${new Date(manifest.installedAt || Date.now()).toLocaleDateString('zh-CN')}`}
            </span>
            <span className={`text-xs ${enabled ? 'text-emerald-400/90' : 'text-white/40'}`}>{enabled ? '● 运行中' : '○ 未启用'}</span>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}