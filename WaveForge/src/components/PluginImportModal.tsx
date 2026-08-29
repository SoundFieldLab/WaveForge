/**
 * 导入插件：读取 manifest（.json / .wfplugin.json），校验必填字段，预览后安装。
 * 安装成功：美化内置弹窗（金勾动画 + 「插件安装成功」）+ 成功 toast。
 */

import { useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, FileJson, CheckCircle2, AlertCircle, Upload } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'
import { installImportedPlugin, usePluginHostState, closePluginImport } from '../services/pluginStore'
import { showToast } from '../plugins/toggle'
import type { PluginManifest } from '../plugins/types'

const REQUIRED_FIELDS = ['id', 'name', 'version', 'developer', 'description', 'updated'] as const

class ManifestError extends Error {}

export default function PluginImportModal() {
  const { importOpen } = usePluginHostState()
  const fileRef = useRef<HTMLInputElement>(null)
  const [manifest, setManifest] = useState<PluginManifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [installed, setInstalled] = useState(false)
  const [installing, setInstalling] = useState(false)

  useTvBack(() => {
    if (importOpen) {
      closePluginImport()
      return true
    }
    return false
  }, [importOpen])

  const reset = () => {
    setManifest(null)
    setError(null)
    setInstalled(false)
    setInstalling(false)
  }

  const handleFile = (file: File) => {
    setError(null)
    setManifest(null)
    setInstalled(false)
    const reader = new FileReader()
    reader.onload = () => {
      const text = String(reader.result ?? '')
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>
        validateManifest(parsed)
        setManifest({
          ...parsed as unknown as PluginManifest,
          source: 'imported',
        })
      } catch (err) {
        setError(err instanceof ManifestError ? err.message : `无法解析插件文件：${String((err as Error)?.message || err)}`)
      }
    }
    reader.onerror = () => setError('读取文件失败')
    reader.readAsText(file)
  }

  const validateManifest = (obj: Record<string, unknown>) => {
    for (const field of REQUIRED_FIELDS) {
      if (typeof obj[field] !== 'string' || !(obj[field] as string).trim()) {
        throw new ManifestError(`缺少必填字段：${field}`)
      }
    }
    if (!/^[a-z0-9-]+$/i.test(String(obj.id))) {
      throw new ManifestError('插件 id 只能包含字母、数字与短横线')
    }
  }

  const handleInstall = () => {
    if (!manifest || installing) return
    setInstalling(true)
    const result = installImportedPlugin(manifest)
    if (result.ok) {
      setInstalling(false)
      setInstalled(true)
      showToast(`插件「${manifest.name}」安装成功`, 'success', 3600)
      window.setTimeout(() => {
        reset()
        closePluginImport()
      }, 1700)
    } else {
      setInstalling(false)
      setError(result.error)
      showToast(result.error, 'error')
    }
  }

  if (!importOpen) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[93] flex items-center justify-center p-4"
        style={{ backgroundColor: 'rgba(5,8,14,0.72)' }}
        data-tv-scope
        onClick={() => { reset(); closePluginImport() }}
      >
        <motion.div
          initial={{ scale: 0.94, y: 14, opacity: 0 }}
          animate={{ scale: 1, y: 0, opacity: 1 }}
          exit={{ scale: 0.94, y: 14, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className="w-full max-w-lg rounded-[24px] border border-white/10 bg-[#12151d] overflow-hidden shadow-2xl"
        >
          <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.07]">
            <div className="flex items-center gap-2.5">
              <FileJson className="w-5 h-5 text-amber-400" />
              <h2 className="text-base font-bold text-white">导入插件</h2>
            </div>
            <button onClick={() => { reset(); closePluginImport() }} className="p-2 rounded-lg hover:bg-white/10 transition-colors">
              <X className="w-5 h-5 text-white/60" />
            </button>
          </div>

          {installed ? (
            /* 安装成功美化弹窗 */
            <div className="px-8 py-12 flex flex-col items-center gap-4">
              <motion.div
                initial={{ scale: 0.4, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', damping: 12, stiffness: 260 }}
                className="w-20 h-20 rounded-full flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg,#f5c84c,#e0a41f)', boxShadow: '0 12px 40px rgba(240,180,41,0.45)' }}
              >
                <CheckCircle2 className="w-10 h-10 text-[#141005]" />
              </motion.div>
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.15 }} className="text-center">
                <p className="text-lg font-bold text-white">插件安装成功</p>
                <p className="mt-1 text-sm text-white/55">「{manifest?.name}」已加入你的插件库</p>
              </motion.div>
            </div>
          ) : (
            <div className="p-6 space-y-4">
              {/* 选择文件 */}
              {!manifest && (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="w-full rounded-2xl border-2 border-dashed border-white/15 py-10 flex flex-col items-center gap-3 hover:border-amber-400/50 hover:bg-amber-400/[0.04] transition-colors"
                >
                  <Upload className="w-8 h-8 text-white/35" />
                  <span className="text-sm text-white/60">选择插件 manifest 文件（.json / .wfplugin.json）</span>
                  <span className="text-[11px] text-white/30">必填：id / name / version / developer / description / updated · 可选：code / icon / screenshots</span>
                </button>
              )}
              <input
                ref={fileRef}
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) handleFile(file)
                  e.target.value = ''
                }}
              />

              {/* 预览 */}
              {manifest && !error && (
                <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center text-lg font-black" style={{ background: 'linear-gradient(135deg,#f5c84c44,#e0a41f66)', color: '#f5c84c' }}>
                      {manifest.name.slice(0, 1).toUpperCase()}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-bold text-white truncate">{manifest.name}</span>
                        <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-white/[0.08] text-white/45">v{manifest.version}</span>
                      </div>
                      <p className="text-[11px] text-white/40">{manifest.developer} · {manifest.updated}</p>
                    </div>
                  </div>
                  <p className="text-xs leading-relaxed text-white/60">{manifest.description}</p>
                  <div className="flex flex-wrap gap-2 text-[10px] text-white/45">
                    <span className="rounded-md bg-white/[0.06] px-2 py-0.5">{manifest.code ? '含运行时代码（受限沙箱）' : '仅元信息（展示型插件）'}</span>
                    <span className="rounded-md bg-white/[0.06] px-2 py-0.5">{manifest.screenshots?.length ? `${manifest.screenshots.length} 张截图` : '无截图'}</span>
                  </div>
                </div>
              )}

              {error && (
                <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 flex items-start gap-2.5">
                  <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <p className="text-xs text-red-300/90 leading-relaxed">{error}</p>
                </div>
              )}

              <div className="flex items-center justify-end gap-3">
                <button onClick={() => { reset() }} className="rounded-xl bg-white/10 hover:bg-white/15 px-4 py-2 text-sm text-white/80">
                  {manifest ? '重新选择' : '取消'}
                </button>
                {manifest && !error && (
                  <motion.button
                    whileHover={{ scale: 1.03 }}
                    whileTap={{ scale: 0.97 }}
                    disabled={installing}
                    onClick={handleInstall}
                    className="rounded-xl px-5 py-2 text-sm font-semibold text-[#141005] disabled:opacity-50"
                    style={{ background: 'linear-gradient(135deg,#f5c84c,#e0a41f)', boxShadow: '0 8px 22px rgba(240,180,41,0.3)' }}
                  >
                    {installing ? '安装中…' : '确认安装'}
                  </motion.button>
                )}
              </div>
            </div>
          )}
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}