/**
 * 使用须知弹窗（通用）：3 秒倒计时后才可点「我已知晓」。
 * 复用「灰色歌曲跨平台补全」弹窗模板：居中遮罩 + 倒计时门控 + 取消/确认。
 */

import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, ShieldAlert } from 'lucide-react'
import { useTvBack } from '../tv/tvCore'
import { getPluginManifest } from '../plugins/registry'
import type { NoticeKind } from '../services/pluginStore'

interface PluginNoticeModalProps {
  open: boolean
  pluginId: string
  kind: NoticeKind
  onResolve: (ok: boolean) => void
  playerTheme?: 'dark' | 'light'
}

export default function PluginNoticeModal({ open, pluginId, kind, onResolve, playerTheme = 'dark' }: PluginNoticeModalProps) {
  const dark = playerTheme === 'dark'
  const [countdown, setCountdown] = useState(3)
  const manifest = getPluginManifest(pluginId)
  const lines = kind === 'view' ? manifest?.notice?.entry : manifest?.notice?.consent

  useTvBack(() => {
    if (open) {
      onResolve(false)
      return true
    }
    return false
  }, [open, onResolve])

  // 打开时重置倒计时
  useEffect(() => {
    if (open) setCountdown(3)
  }, [open])

  // 每秒递减
  useEffect(() => {
    if (!open || countdown <= 0) return
    const timer = window.setTimeout(() => setCountdown(v => Math.max(0, v - 1)), 1000)
    return () => window.clearTimeout(timer)
  }, [open, countdown])

  if (!open) return null

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
        style={{ backgroundColor: 'rgba(0, 0, 0, 0.78)' }}
        data-tv-scope
        onClick={() => onResolve(false)}
      >
        <motion.div
          initial={{ scale: 0.92, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.92, opacity: 0 }}
          onClick={(e) => e.stopPropagation()}
          className={`${dark ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-gray-200'} rounded-2xl border shadow-2xl max-w-lg w-full overflow-hidden flex flex-col`}
        >
          <div className={`flex items-center justify-between px-6 py-4 border-b ${dark ? 'border-zinc-800' : 'border-gray-200'}`}>
            <div className="flex items-center gap-2.5">
              <ShieldAlert className="w-5 h-5" style={{ color: dark ? '#f0b429' : '#b45309' }} />
              <h2 className={`text-lg font-bold ${dark ? 'text-white' : 'text-black'}`}>
                {kind === 'view' ? '使用须知' : '使用前请确认'}
              </h2>
            </div>
            <button onClick={() => onResolve(false)} className="p-2 rounded-lg hover:bg-white/10">
              <X className="w-5 h-5 text-white/60" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5">
            <p className={`text-[13px] mb-4 ${dark ? 'text-amber-300/80' : 'text-amber-700'}`}>
              此内容涉及成人向设备，请谨慎阅读：
            </p>
            <ul className="space-y-2.5">
              {(lines ?? ['请仔细阅读并确认后再继续。']).map((line, index) => (
                <li key={index} className={`flex gap-2 text-sm leading-relaxed ${dark ? 'text-white/75' : 'text-black/70'}`}>
                  <span className="shrink-0 mt-0.5" style={{ color: dark ? '#f0b429' : '#b45309' }}>·</span>
                  {line}
                </li>
              ))}
            </ul>
            <div className={`mt-5 rounded-xl px-4 py-3 text-xs leading-relaxed ${dark ? 'bg-amber-400/10 text-amber-200/80 border border-amber-400/20' : 'bg-amber-100 text-amber-800 border border-amber-300'}`}>
              本插件仅供娱乐，一切风险与后果需自行承担。
            </div>
          </div>

          <div className={`flex items-center justify-end gap-3 px-6 py-4 border-t ${dark ? 'border-zinc-800' : 'border-gray-200'}`}>
            <button
              onClick={() => onResolve(false)}
              className={`px-5 py-2.5 rounded-xl text-sm ${dark ? 'bg-white/10 hover:bg-white/15 text-white/80' : 'bg-black/5 text-black/70'}`}
            >
              取消
            </button>
            <button
              onClick={() => onResolve(true)}
              disabled={countdown > 0}
              className="px-5 py-2.5 rounded-xl text-sm font-semibold text-white transition-all disabled:opacity-45"
              style={{
                backgroundColor: '#f0b429',
                boxShadow: countdown > 0 ? 'none' : '0 8px 24px rgba(240,180,41,0.35)',
              }}
            >
              {countdown > 0 ? `我已知晓（${countdown}）` : '我已知晓'}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}