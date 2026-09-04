/**
 * 全局更新提示（App 根部渲染，任何视图模式都可见）。
 *
 * 分客户端显示：
 *  - Windows（Electron）：顶部卡片「检测到新版本」→ 立即更新走 downloadAndInstall 真下载安装；
 *  - Android TV：不显示卡片（原生 UpdateChecker 启动时已弹窗），成功弹窗仍生效；
 *  - 浏览器（调试/网页）：显示卡片，但「立即更新」跳转 Gitee 发布页（无安装器）。
 *
 * 成功弹窗三端统一：更新生效后（本地版本 ≥ 标记的目标版本）首次打开时显示
 * 「版本更新成功」+ 更新内容（过长可折叠），点确定清除标记。
 */
import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Download, Sparkles, ChevronDown, ChevronUp } from 'lucide-react'
import packageInfo from '../../package.json'
import {
  fetchUpdateManifest,
  compareVersions,
  withDownloadProxies,
  GITEE_RELEASES_URL,
  type UpdateManifest,
} from '../services/updateConstants'
import { getVersionDisplay } from '../services/versionInfo'
import { isAndroid, isDesktop } from '../platform'

interface UpdatePromptProps {
  playerTheme?: 'dark' | 'light'
}

const SKIP_VERSION_KEY = 'waveforge:update-skip-version' // 此次版本不再提示（持久）
const APPLIED_MARKER_KEY = 'waveforge:update-applied' // 更新已生效标记（成功后清除）
const DISMISS_SESSION_KEY = 'waveforge:update-dismiss-session' // 稍后提示（本次会话）

function readJSON(key: string): { version?: string; notes?: string } | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as { version?: string; notes?: string }) : null
  } catch {
    return null
  }
}

export default function UpdatePrompt({ playerTheme = 'dark' }: UpdatePromptProps) {
  const isDark = playerTheme === 'dark'
  const [manifest, setManifest] = useState<UpdateManifest | null>(null)
  const [checking, setChecking] = useState(false)
  const [cardVisible, setCardVisible] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [successInfo, setSuccessInfo] = useState<{ version: string; notes: string } | null>(null)
  const [notesExpanded, setNotesExpanded] = useState(false)

  // 更新成功弹窗：本地版本 ≥ 标记目标版本 → 说明更新已生效
  useEffect(() => {
    const marker = readJSON(APPLIED_MARKER_KEY)
    if (!marker?.version) return
    if (compareVersions(packageInfo.version, marker.version) >= 0) {
      setSuccessInfo({ version: marker.version, notes: marker.notes || '' })
    }
  }, [])

  // 检查更新（Android 端由原生 UpdateChecker 弹窗，卡片跳过避免重复提示）
  useEffect(() => {
    if (isAndroid()) return
    let cancelled = false
    const run = async () => {
      setChecking(true)
      try {
        const m = await fetchUpdateManifest()
        if (cancelled || !m?.version) return
        if (compareVersions(m.version, packageInfo.version) <= 0) return
        // 跳过逻辑：持久跳过 / 本次会话稍后
        if (m.version === localStorage.getItem(SKIP_VERSION_KEY)) return
        try {
          if (sessionStorage.getItem(DISMISS_SESSION_KEY) === m.version) return
        } catch {
          // ignore
        }
        setManifest(m)
        setCardVisible(true)
      } finally {
        if (!cancelled) setChecking(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [])

  const isNewer = manifest?.version ? compareVersions(manifest.version, packageInfo.version) > 0 : false
  const notes = manifest?.notes || ''
  const notesLong = notes.length > 120
  const displayedNotes = notesLong && !notesExpanded ? notes.slice(0, 120) + '…' : notes

  const handleImmediateUpdate = async () => {
    if (!manifest) return
    // Windows：真下载安装；浏览器/无桥：跳发布页
    const winArtifact = manifest.artifacts?.['win-x64']
    const bridge = window.electron?.update
    if (isDesktop() && winArtifact?.urls?.length && bridge?.downloadAndInstall) {
      setDownloading(true)
      try {
        // manifest 的 urls 已按 Gitee → ghproxy(GitHub) → GitHub 排好序，整表传入逐个尝试
        const result = await bridge.downloadAndInstall(winArtifact.urls, winArtifact.sha256 || '')
        if (result.success) {
          // 写入成功标记：更新生效后下次启动显示成功弹窗
          try {
            localStorage.setItem(APPLIED_MARKER_KEY, JSON.stringify({ version: manifest.version, notes }))
          } catch {
            // ignore
          }
          setCardVisible(false)
        }
      } finally {
        setDownloading(false)
      }
      return
    }
    // 浏览器/网页：跳转 Gitee 发布页
    window.open(GITEE_RELEASES_URL, '_blank')
    setCardVisible(false)
  }

  const handleLater = () => {
    if (!manifest) return
    try {
      sessionStorage.setItem(DISMISS_SESSION_KEY, manifest.version || '')
    } catch {
      // ignore
    }
    setCardVisible(false)
  }

  const handleSkipVersion = () => {
    if (!manifest) return
    try {
      localStorage.setItem(SKIP_VERSION_KEY, manifest.version || '')
    } catch {
      // ignore
    }
    setCardVisible(false)
  }

  const handleSuccessConfirm = () => {
    try {
      localStorage.removeItem(APPLIED_MARKER_KEY)
    } catch {
      // ignore
    }
    setSuccessInfo(null)
  }

  const textPrimary = isDark ? 'text-white' : 'text-black'
  const textSecondary = isDark ? 'text-white/60' : 'text-black/55'
  const cardBg = isDark ? 'rgba(15, 19, 28, 0.94)' : 'rgba(255, 255, 255, 0.95)'
  const cardBorder = isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)'
  const btnGhostBg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)'
  const accent = localStorage.getItem('accentColor') || '#3B82F6'

  return (
    <AnimatePresence>
      {/* 顶部更新卡片（任何模式可见；Android 端由原生弹窗处理，不显示） */}
      {cardVisible && !isAndroid() && isNewer && manifest && (
        <motion.div
          key="update-card"
          initial={{ opacity: 0, y: -32, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -24, scale: 0.97 }}
          transition={{ type: 'spring', damping: 26, stiffness: 320 }}
          className="fixed left-1/2 top-5 z-[6000] w-[min(94vw,600px)] -translate-x-1/2 rounded-2xl border p-5 shadow-2xl backdrop-blur-xl"
          style={{
            background: cardBg,
            borderColor: cardBorder,
            boxShadow: '0 20px 60px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08)',
          }}
        >
          <div className="flex items-start gap-4">
            <div
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
              style={{ backgroundColor: `${accent}22`, color: accent }}
            >
              <Sparkles className="h-5 w-5" />
            </div>
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-semibold ${textPrimary}`}>
                检测到新的软件版本（{isDesktop() ? 'Windows' : '网页版'}）
              </div>
              <div className={`mt-1 text-xs ${textSecondary}`}>
                版本号：{getVersionDisplay(manifest.version || '')}
              </div>
              {notes && (
                <p className={`mt-2 text-xs leading-relaxed ${textSecondary}`}>{displayedNotes}</p>
              )}
              {downloading && (
                <p className="mt-2 text-xs" style={{ color: accent }}>正在下载更新安装包，请稍候…</p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <button
                  onClick={() => void handleImmediateUpdate()}
                  disabled={downloading}
                  className="inline-flex items-center gap-1.5 rounded-xl px-4 py-2 text-sm font-medium text-white transition-transform active:scale-95 disabled:opacity-60"
                  style={{ backgroundColor: accent }}
                >
                  <Download className="h-4 w-4" />
                  {downloading ? '下载中…' : '立即更新'}
                </button>
                <button
                  onClick={handleLater}
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${textPrimary}`}
                  style={{ backgroundColor: btnGhostBg }}
                >
                  稍后提示
                </button>
                <button
                  onClick={handleSkipVersion}
                  className={`rounded-xl px-3 py-2 text-xs transition-colors ${textSecondary}`}
                >
                  此次版本不再提示
                </button>
              </div>
            </div>
          </div>
        </motion.div>
      )}

      {/* 更新成功弹窗（全局） */}
      {successInfo && (
        <motion.div
          key="update-success"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[6000] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
          style={{ backgroundColor: isDark ? 'rgba(0,0,0,0.62)' : 'rgba(0,0,0,0.4)' }}
        >
          <motion.div
            initial={{ scale: 0.92, opacity: 0, y: 14 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0 }}
            transition={{ type: 'spring', damping: 26, stiffness: 300 }}
            className="w-[min(92vw,520px)] rounded-2xl border p-6 shadow-2xl backdrop-blur-xl"
            style={{
              background: cardBg,
              borderColor: cardBorder,
              boxShadow: '0 24px 70px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.08)',
            }}
          >
            <div className="flex items-start gap-4">
              <div
                className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl"
                style={{ backgroundColor: `${accent}22`, color: accent }}
              >
                <Sparkles className="h-6 w-6" />
              </div>
              <div className="min-w-0 flex-1">
                <h3 className={`text-lg font-semibold ${textPrimary}`}>版本更新成功</h3>
                <p className={`mt-1 text-sm ${textSecondary}`}>
                  当前版本：{getVersionDisplay(packageInfo.version)}
                </p>
                {successInfo.notes && (
                  <div className={`mt-3 rounded-xl p-3 text-sm leading-relaxed ${isDark ? 'bg-white/5' : 'bg-black/5'}`}>
                    <div className={`text-xs font-medium ${textSecondary}`}>更新内容</div>
                    <p className={`mt-1 ${textPrimary}`} style={{ whiteSpace: 'pre-wrap' }}>
                      {successInfo.notes.length > 200 && !notesExpanded
                        ? successInfo.notes.slice(0, 200) + '…'
                        : successInfo.notes}
                    </p>
                    {successInfo.notes.length > 200 && (
                      <button
                        onClick={() => setNotesExpanded((v) => !v)}
                        className={`mt-2 inline-flex items-center gap-1 text-xs font-medium ${textSecondary}`}
                      >
                        {notesExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        {notesExpanded ? '收起' : '展开全部'}
                      </button>
                    )}
                  </div>
                )}
                <div className="mt-5 flex justify-end">
                  <button
                    onClick={handleSuccessConfirm}
                    className="rounded-xl px-6 py-2.5 text-sm font-semibold text-white transition-transform active:scale-95"
                    style={{ backgroundColor: accent }}
                  >
                    确定
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
