import { useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Music, Copy, ScrollText, Languages, Mic2 } from 'lucide-react'
import { getProxiedImageUrl } from '../services/musicApi'
import { useTvBack } from '../tv/tvCore'

interface LyricModalProps {
  songName: string
  artistName: string
  coverUrl: string
  lyrics: { time: number; text: string; translation?: string; roman?: string }[]
  onClose: () => void
}

const showToast = (message: string, type: 'success' | 'info' | 'error' = 'success') => {
  window.dispatchEvent(new CustomEvent('showToast', { detail: { message, type } }))
}

export default function LyricModal({ songName, artistName, coverUrl, lyrics, onClose }: LyricModalProps) {
  // TV 遥控器 BACK：关闭歌词详情弹窗
  useTvBack(() => {
    onClose()
    return true
  }, [onClose])
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')
  const [showTrans, setShowTrans] = useState(false)
  const [showRoman, setShowRoman] = useState(false)
  // 歌词弹窗内的复制提示（避免被全局 toast 层级遮挡）
  const [toastMsg, setToastMsg] = useState('')
  const toastTimer = useRef<number | null>(null)

  const localToast = (msg: string) => {
    setToastMsg(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToastMsg(''), 2000)
  }

  // 纯 execCommand 复制（App 复制歌曲信息同款，Electron 可靠）
  const copyText = (text: string): boolean => {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch { return false }
  }

  const copyLine = (text: string, roman?: string, trans?: string) => {
    const parts = [text]
    if (showRoman && roman) parts.push(roman)
    if (showTrans && trans) parts.push(trans)
    const content = parts.filter(Boolean).join('\n')
    if (copyText(content)) localToast(`已复制：${text.slice(0, 20)}${text.length > 20 ? '…' : ''}`)
    else localToast('复制失败')
  }

  const copyAll = () => {
    const lines = lyrics.map(l => {
      const parts = [l.text]
      if (showRoman && l.roman) parts.push(l.roman)
      if (showTrans && l.translation) parts.push(l.translation)
      return parts.filter(Boolean).join('\n')
    }).filter(Boolean)
    const full = lines.join('\n')
    if (copyText(full)) localToast(`已复制全部歌词（${lyrics.length} 行）`)
    else localToast('复制失败')
  }

  // 是否有翻译 / 罗马音（无则不显示对应开关）
  const hasTranslation = lyrics.some(l => l.translation)
  const hasRoman = lyrics.some(l => l.roman)

  return (
    <motion.div
      data-tv-scope
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[90] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)' }}
      onClick={(e) => { e.stopPropagation(); onClose() }}
    >
      <motion.div
        initial={{ scale: 0.94, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.94, opacity: 0, y: 12 }}
        transition={{ type: 'spring', damping: 28, stiffness: 320 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden rounded-3xl shadow-2xl relative"
      >
        {/* 液态玻璃背景 */}
        <div className="absolute inset-0 rounded-3xl overflow-hidden">
          {coverUrl && (
            <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${getProxiedImageUrl(coverUrl)})`, filter: 'blur(40px) brightness(0.6)' }} />
          )}
          <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(20,20,30,0.5) 50%, rgba(0,0,0,0.4) 100%)', backdropFilter: 'blur(80px) saturate(200%)', WebkitBackdropFilter: 'blur(80px) saturate(200%)' }} />
          <div className="absolute inset-0 rounded-3xl" style={{ border: '1px solid rgba(255,255,255,0.2)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.15)', pointerEvents: 'none' }} />
        </div>

        <div className="relative z-10 flex flex-col h-full min-h-0">
          {/* 头部 */}
          <div className="p-5 border-b flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${accentColor}26`, color: accentColor }}>
                  <ScrollText className="w-4.5 h-4.5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-white">歌词</h2>
                  <div className="text-white/50 text-[11px] -mt-0.5 truncate max-w-64">{songName} - {artistName}</div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={copyAll}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs text-white/80 hover:text-white hover:bg-white/10 transition-colors"
                >
                  <Copy className="w-3.5 h-3.5" /> 复制全部
                </button>
                <button type="button" onClick={onClose} className="p-2 rounded-full transition-colors hover:bg-white/15">
                  <X className="w-5 h-5 text-white/60" />
                </button>
              </div>
            </div>

            {/* 开关：翻译 / 罗马音 */}
            <div className="flex items-center gap-4 mt-3">
              {hasTranslation && (
                <button
                  type="button"
                  onClick={() => setShowTrans(v => !v)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-colors ${showTrans ? 'text-white' : 'text-white/50 hover:text-white/80'}`}
                  style={showTrans ? { background: `${accentColor}55`, border: `1px solid ${accentColor}88` } : { background: 'rgba(255,255,255,0.08)' }}
                >
                  <Languages className="w-3.5 h-3.5" /> 翻译
                </button>
              )}
              {hasRoman && (
                <button
                  type="button"
                  onClick={() => setShowRoman(v => !v)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs transition-colors ${showRoman ? 'text-white' : 'text-white/50 hover:text-white/80'}`}
                  style={showRoman ? { background: `${accentColor}55`, border: `1px solid ${accentColor}88` } : { background: 'rgba(255,255,255,0.08)' }}
                >
                  <Mic2 className="w-3.5 h-3.5" /> 罗马音
                </button>
              )}
              {(hasTranslation || hasRoman) && <span className="text-white/35 text-xs">点击任意歌词可复制该行</span>}
            </div>
          </div>

          {/* 歌词列表 */}
          <div className="flex-1 overflow-y-auto p-4 space-y-1">
            {lyrics.length === 0 ? (
              <div className="py-14 text-center text-white/50 text-sm">暂无歌词</div>
            ) : lyrics.map((l, i) => (
              l.text || l.translation || l.roman ? (
                <div
                  key={`${l.time}-${i}`}
                  className="rounded-lg px-3 py-1.5 hover:bg-white/5 transition-colors cursor-pointer group"
                  onClick={() => { if (l.text) copyLine(l.text, l.roman, l.translation) }}
                  title="点击复制该行"
                >
                  {l.text && <p className="text-white text-sm leading-6">{l.text}</p>}
                  {showRoman && l.roman && (
                    <p className="text-white/45 text-xs leading-5">{l.roman}</p>
                  )}
                  {showTrans && l.translation && (
                    <p className="text-white/55 text-xs leading-5">{l.translation}</p>
                  )}
                </div>
              ) : <div key={`${l.time}-${i}`} className="py-0.5" />
            ))}
          </div>
        </div>

        {/* 歌词弹窗内复制提示（最上层，避免被全局 toast 层级遮挡） */}
        {toastMsg && (
          <div className="absolute top-20 left-1/2 -translate-x-1/2 z-10 px-4 py-2 rounded-full text-xs text-white shadow-lg" style={{ background: `${accentColor}e6`, backdropFilter: 'blur(8px)' }}>
            {toastMsg}
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}
