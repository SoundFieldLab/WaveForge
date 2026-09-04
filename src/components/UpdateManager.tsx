/**
 * 更新中心（全局挂载）：更新详情 / 下载进度 / 已就绪 / 确认重启 / 更新成功 / 更新日志
 * 弹窗，以及启动时的自动检测提示。全部为应用内美化弹窗（非系统弹窗）。
 *
 * 触发方式：
 * - SettingsPanel 检查到新版本后派发 window 事件 'waveforge:update-open-details'（携带版本/更新内容/下载地址）
 * - 后台下载进度/结果经 preload update.onDownloadStatus 事件
 * - 启动时 consumeLastApplied → 首次启动弹「更新日志」
 * - 自动检测（可在「关于 → 更新」关闭）：限频每 24h 一次、延时 6s、失败静默，检测到仅提示
 *
 * 流程（对标主流桌面软件）：
 *   详情（稍后再说/立即更新）→ 后台静默下载（可关弹窗继续用）→ 已就绪（稍后/更新）→
 *   确认重启（稍后/立即更新）→ 更新成功（稍后重启/立即重启）→ 重启后新版本 + 更新日志。
 *   「稍后」的更新会持久化，退出应用时自动应用，下次启动即为新版本。
 */
import React, { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Download, RefreshCw, CheckCircle2, AlertTriangle, Rocket } from 'lucide-react'
import { fetchUpdateManifest, compareVersions } from '../services/updateConstants'
import { getVersionDisplay } from '../services/versionInfo'
import { parseStoredBoolean } from '../utils/storage'
import packageInfo from '../../package.json'

interface UpdateInfo {
  version: string
  notes: string
  hotUrls?: string[]
  hotSha?: string
  installUrls?: string[]
  installSha?: string
}

type View = 'idle' | 'details' | 'downloading' | 'ready' | 'confirm-restart' | 'applying' | 'applied' | 'changelog'

/** 把多行 notes 按「分类标题 / 条目」渲染为带符号列表 */
function NotesBody({ notes, className = '' }: { notes: string; className?: string }) {
  const lines = String(notes || '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (!lines.length) return <p className={className}>本次更新已应用。</p>
  return (
    <div className={`space-y-1 ${className}`}>
      {lines.map((line, i) => {
        // 分类标题（如「✨ 新功能」「修复」）：短行且去掉符号/emoji 后是已知分类名
        const stripped = line.replace(/^[\s#*•\-]*(?:[\u{1F300}-\u{1FAFF}])*\s*/u, '')
        if (/^(新功能|改进|优化|修复|性能|安全)$/.test(stripped) && line.length < 30) {
          return <p key={i} className="text-sm font-medium mt-2 first:mt-0" style={{ color: 'inherit' }}>{line}</p>
        }
        return (
          <p key={i} className="text-sm leading-relaxed" style={{ color: 'inherit' }}>
            {line.startsWith('- ') || line.startsWith('• ') ? line : `- ${line}`}
          </p>
        )
      })}
    </div>
  )
}

export default function UpdateManager() {
  const [view, setView] = useState<View>('idle')
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [percent, setPercent] = useState(0)
  const [autoCheck, setAutoCheck] = useState(() => parseStoredBoolean(localStorage.getItem('autoCheckUpdate'), true))
  const busyRef = useRef(false)

  const toast = (message: string, type: 'info' | 'error' | 'success' = 'info', duration = 4000) => {
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('showToast', { detail: { message, type, duration } }))
    }, 0)
  }

  const openDetails = (d: UpdateInfo) => {
    if (busyRef.current) return // 单一弹窗守卫
    setInfo(d)
    setPercent(0)
    setView('details')
  }

  // SettingsPanel 检查到新版本 → 打开详情
  useEffect(() => {
    const open = (e: Event) => {
      const d = (e as CustomEvent).detail as UpdateInfo | undefined
      if (d?.version) openDetails(d)
    }
    window.addEventListener('waveforge:update-open-details', open)
    return () => window.removeEventListener('waveforge:update-open-details', open)
  }, [])

  // 后台下载状态事件
  useEffect(() => {
    const off = window.electron?.update?.onDownloadStatus?.((status) => {
      if (status.state === 'progress') {
        setPercent(status.percent ?? 0)
        // 用户已关闭下载中弹窗则保持关闭，不打扰；仅完成/失败时再次提示
      } else if (status.state === 'done') {
        setPercent(100)
        busyRef.current = false
        setView('ready') // 无论下载中弹窗是否被关闭，就绪弹窗都会出现
      } else if (status.state === 'failed') {
        busyRef.current = false
        toast(`更新下载失败：${status.error || '网络异常'}，请稍后重试`, 'error', 6000)
        setView('idle')
      }
    })
    return () => off?.()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 启动：更新后首次启动弹「更新日志」
  useEffect(() => {
    void window.electron?.update?.consumeLastApplied?.().then((applied) => {
      if (applied?.version) {
        setInfo({ version: applied.version, notes: applied.notes || '本次更新已应用。' })
        setView('changelog')
      }
    }).catch(() => {})
  }, [])

  // 启动：自动检测新版本（每次启动延时 6s 检测，可关闭、失败静默；已跳过的版本不再提示）
  useEffect(() => {
    if (!autoCheck) return
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const manifest = await fetchUpdateManifest()
          if (!manifest?.version) return
          // 「跳过此版本」后该版本不再自动提示（手动检查仍可用）
          if (manifest.version === localStorage.getItem('skippedUpdateVersion')) return
          if (compareVersions(manifest.version, packageInfo.version) > 0) {
            toast(`检测到新版本 ${getVersionDisplay(manifest.version)}，可前往「关于」查看更新`, 'info', 8000)
          }
        } catch { /* 静默失败，下次启动再试 */ }
      })()
    }, 6000)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck])

  const startDownload = async () => {
    if (!info?.hotUrls?.length) return
    busyRef.current = true
    setPercent(0)
    setView('downloading')
    try {
      const result = await window.electron?.update?.downloadBackground?.({
        version: info.version,
        notes: info.notes || '',
        urls: info.hotUrls,
        sha256: info.hotSha || '',
      })
      if (result && !result.success) {
        toast(`更新下载失败：${result.error || '网络异常'}，请稍后重试`, 'error', 6000)
        setView('idle')
        busyRef.current = false
      }
      // 成功时由 onDownloadStatus done 事件切换到「已就绪」
    } catch {
      toast('更新下载失败，请稍后重试', 'error', 6000)
      setView('idle')
      busyRef.current = false
    }
  }

  // 无热更新产物（大版本）→ 回落完整安装包流程
  const startInstallerDownload = async () => {
    if (!info?.installUrls?.length) return
    busyRef.current = true
    setPercent(0)
    setView('downloading')
    try {
      const result = await window.electron?.update?.downloadAndInstall?.(info.installUrls, info.installSha || '')
      busyRef.current = false
      if (result?.success) {
        toast('安装包已下载，请在弹出的安装向导中完成安装', 'success', 6000)
        setView('idle')
      } else {
        toast(`下载失败：${result?.error || '网络异常'}`, 'error', 6000)
        setView('idle')
      }
    } catch {
      busyRef.current = false
      toast('下载失败，请稍后重试', 'error', 6000)
      setView('idle')
    }
  }

  const confirmApply = async () => {
    setView('applying')
    try {
      const result = await window.electron?.update?.applyPending?.()
      if (result && !result.success) {
        toast('应用更新失败，请稍后重试', 'error')
        setView('ready')
        return
      }
      window.setTimeout(() => setView('applied'), 900)
    } catch {
      toast('应用更新失败，请稍后重试', 'error')
      setView('ready')
    }
  }

  const restartNow = () => {
    void window.electron?.update?.restartForUpdate?.()
  }

  const close = () => {
    if (view === 'applying') return // 应用过程中不可关闭
    setView('idle')
  }

  const canCloseBackdrop = view !== 'applying'
  const actionLabel = info?.hotUrls?.length ? '立即更新' : '下载完整安装包'
  const onPrimaryAction = info?.hotUrls?.length ? startDownload : startInstallerDownload

  return (
    <AnimatePresence>
      {view !== 'idle' && (
        <motion.div
          key="update-modal"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[300] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)' }}
          onClick={canCloseBackdrop ? close : undefined}
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 12 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md overflow-hidden rounded-3xl shadow-2xl relative"
          >
            <div className="absolute inset-0 rounded-3xl overflow-hidden">
              <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(30,30,45,0.96) 0%, rgba(20,20,30,0.98) 50%, rgba(12,12,20,0.98) 100%)', backdropFilter: 'blur(80px) saturate(200%)' }} />
              <div className="absolute inset-0 rounded-3xl" style={{ border: '1px solid rgba(255,255,255,0.14)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.12)', pointerEvents: 'none' }} />
            </div>

            {/* 头部 */}
            <div className="relative z-10 p-5 border-b" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0" style={{ backgroundColor: 'rgba(99,102,241,0.18)' }}>
                  {view === 'applied' || view === 'changelog'
                    ? <CheckCircle2 className="w-5 h-5" style={{ color: '#34d399' }} />
                    : view === 'downloading'
                      ? <Download className="w-5 h-5" style={{ color: '#818cf8' }} />
                      : view === 'ready'
                        ? <Rocket className="w-5 h-5" style={{ color: '#818cf8' }} />
                        : view === 'confirm-restart'
                          ? <AlertTriangle className="w-5 h-5 text-red-400" />
                          : <RefreshCw className="w-5 h-5" style={{ color: '#818cf8' }} />}
                </div>
                <div className="flex-1 min-w-0">
                  <h3 className="text-base font-semibold text-white">{viewTitle(view)}</h3>
                  <p className="text-white/55 text-xs mt-0.5">
                    {view === 'changelog' ? `已更新至 ${getVersionDisplay(info?.version || '')}` : view === 'applied' ? '热更新已完成文件替换' : `WaveForge ${packageInfo.version} → ${getVersionDisplay(info?.version || '')}`}
                  </p>
                </div>
                {canCloseBackdrop && (
                  <button type="button" onClick={close} className="p-2 rounded-full transition-colors hover:bg-white/15 -m-1">
                    <X className="w-5 h-5 text-white/60" />
                  </button>
                )}
              </div>
            </div>

            {/* 内容 */}
            <div className="relative z-10 p-5">
              {view === 'details' && (
                <>
                  <NotesBody notes={info?.notes || ''} className="max-h-[38vh] overflow-y-auto pr-1 text-white/80" />
                  <p className="text-white/40 text-xs mt-3">
                    {info?.hotUrls?.length
                      ? '更新包下载完成后可在后台应用，无需安装向导。'
                      : '此版本改动较大，需下载完整安装包安装。'}
                  </p>
                </>
              )}
              {view === 'downloading' && (
                <div>
                  {info?.hotUrls?.length ? (
                    <>
                      <div className="flex items-center justify-between text-xs mb-2">
                        <span className="text-white/70">正在后台静默下载更新包…</span>
                        <span className="text-white/90 font-medium">{percent}%</span>
                      </div>
                      <div className="h-2 w-full overflow-hidden rounded-full bg-white/10">
                        <div className="h-full rounded-full transition-[width] duration-300" style={{ width: `${Math.max(2, Math.min(100, percent))}%`, background: '#818cf8' }} />
                      </div>
                      <p className="text-white/45 text-xs mt-3">您可以关闭此弹窗继续使用软件，下载将在后台进行，完成后会再次提醒。</p>
                    </>
                  ) : (
                    <p className="text-white/60 text-sm">正在下载完整安装包，完成后将打开安装向导…</p>
                  )}
                </div>
              )}
              {view === 'ready' && (
                <>
                  <p className="text-white/80 text-sm leading-relaxed">新版本 <span className="text-white font-medium">{getVersionDisplay(info?.version || '')}</span> 已准备完毕，是否立即更新？</p>
                  <p className="text-white/40 text-xs mt-2">选择「稍后」不会丢失本次下载，退出应用时自动应用，下次启动即为新版本。</p>
                </>
              )}
              {view === 'confirm-restart' && (
                <>
                  <p className="text-white/80 text-sm leading-relaxed">更新将重启软件，正在进行的操作（播放、下载、AI 混音等）会中断，未保存的内容可能会丢失。</p>
                  <p className="text-white/40 text-xs mt-2">选择「稍后」则退出应用时再自动应用。</p>
                </>
              )}
              {view === 'applying' && (
                <div className="flex items-center justify-center gap-3 py-4">
                  <span className="inline-block h-5 w-5 rounded-full border-2 border-transparent animate-spin" style={{ borderTopColor: '#818cf8', borderRightColor: '#818cf8' }} />
                  <span className="text-white/70 text-sm">正在准备更新…</span>
                </div>
              )}
              {view === 'applied' && (
                <>
                  <p className="text-white/80 text-sm leading-relaxed">更新成功，需要重启软件以应用修改。</p>
                  <p className="text-white/40 text-xs mt-2">您可以继续使用软件（保存好当前内容），下次启动即为新版本。</p>
                </>
              )}
              {view === 'changelog' && (
                <NotesBody notes={info?.notes || ''} className="max-h-[45vh] overflow-y-auto pr-1 text-white/80" />
              )}
            </div>

            {/* 操作按钮 */}
            <div className="relative z-10 flex gap-3 p-5 pt-0">
              {(view === 'details' || view === 'ready' || view === 'confirm-restart') && (
                <button
                  type="button"
                  onClick={close}
                  className="flex-1 py-2.5 px-4 rounded-xl text-white/80 transition-colors hover:bg-white/10"
                  style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                >
                  {view === 'details' ? '稍后再说' : '稍后'}
                </button>
              )}
              {view === 'details' && (
                <button type="button" onClick={() => void onPrimaryAction()} className="flex-1 py-2.5 px-4 rounded-xl font-medium text-white" style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', boxShadow: '0 4px 16px rgba(99,102,241,0.4)' }}>
                  {actionLabel}
                </button>
              )}
              {view === 'ready' && (
                <button type="button" onClick={() => setView('confirm-restart')} className="flex-1 py-2.5 px-4 rounded-xl font-medium text-white" style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', boxShadow: '0 4px 16px rgba(99,102,241,0.4)' }}>
                  更新
                </button>
              )}
              {view === 'confirm-restart' && (
                <button type="button" onClick={() => void confirmApply()} className="flex-1 py-2.5 px-4 rounded-xl font-medium text-white" style={{ background: 'linear-gradient(135deg, #ef4444, #dc2626)', boxShadow: '0 4px 16px rgba(239,68,68,0.4)' }}>
                  立即更新
                </button>
              )}
              {view === 'applied' && (
                <>
                  <button type="button" onClick={close} className="flex-1 py-2.5 px-4 rounded-xl text-white/80 transition-colors hover:bg-white/10" style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}>
                    稍后重启
                  </button>
                  <button type="button" onClick={restartNow} className="flex-1 py-2.5 px-4 rounded-xl font-medium text-white" style={{ background: 'linear-gradient(135deg, #10b981, #059669)', boxShadow: '0 4px 16px rgba(16,185,129,0.4)' }}>
                    立即重启
                  </button>
                </>
              )}
              {view === 'changelog' && (
                <button type="button" onClick={close} className="flex-1 py-2.5 px-4 rounded-xl font-medium text-white" style={{ background: 'linear-gradient(135deg, #6366f1, #8b5cf6)', boxShadow: '0 4px 16px rgba(99,102,241,0.4)' }}>
                  确定
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

function viewTitle(view: View): string {
  switch (view) {
    case 'details': return '发现新版本'
    case 'downloading': return '正在下载更新'
    case 'ready': return '更新已准备完毕'
    case 'confirm-restart': return '确认重启更新'
    case 'applying': return '正在应用更新'
    case 'applied': return '更新成功'
    case 'changelog': return '版本更新日志'
    default: return ''
  }
}
