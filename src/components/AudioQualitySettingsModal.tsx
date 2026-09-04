import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Check, ChevronRight, Crown, Headphones, Music2, X } from 'lucide-react'
import {
  loadAudioQualitySettings,
  saveAudioQualitySettings,
  type AudioQualityPreference,
  type AudioQualitySettings,
} from '../services/audioQualitySettings'
import { useTvBack } from '../tv/tvCore'

interface AudioQualitySettingsModalProps {
  show: boolean
  onClose: () => void
  playerTheme?: 'light' | 'dark'
  neteaseVip: boolean
  qqVip: boolean
  neteaseLoggedIn: boolean
  qqLoggedIn: boolean
  spotifyLoggedIn?: boolean
  kugouLoggedIn?: boolean
  sodaLoggedIn?: boolean
}

type QualityOption = {
  value: AudioQualityPreference
  label: string
  description: string
  requiresVip?: boolean
}

const NETEASE_OPTIONS: QualityOption[] = [
  { value: 'auto', label: '自动最高音质', description: '按账号权限和歌曲可用性自动选择最高音质' },
  { value: 'standard', label: '标准音质', description: '兼容性最好，流量占用较低' },
  { value: 'high', label: '高品质', description: '网易云 exhigh，通常约 320 kbps' },
  { value: 'lossless', label: '无损音质', description: '优先请求 FLAC 无损音质', requiresVip: true },
  { value: 'hi-res', label: 'Hi-Res', description: '优先请求网易云 Hi-Res 音质', requiresVip: true },
]

const QQ_OPTIONS: QualityOption[] = [
  { value: 'auto', label: '自动最高音质', description: '按账号权限和歌曲可用性自动选择最高音质' },
  { value: 'standard', label: '标准音质', description: '优先使用 128 kbps MP3 / AAC 备用音源' },
  { value: 'high', label: '高品质', description: '优先使用 320 kbps MP3' },
  { value: 'lossless', label: '无损音质', description: '优先使用 FLAC 无损音质', requiresVip: true },
]

/** 新平台音质选项（自身直源受限时走网易云/QQ 载体音质） */
const GENERIC_OPTIONS: QualityOption[] = [
  { value: 'auto', label: '自动最高音质', description: '按账号权限和歌曲可用性自动选择最高音质' },
  { value: 'standard', label: '标准音质', description: '优先使用标准码率音源' },
  { value: 'high', label: '高品质', description: '优先使用高码率音源' },
  { value: 'lossless', label: '无损音质', description: '优先请求无损音质', requiresVip: true },
]

function QualityOptionButton({
  option,
  selected,
  playerTheme,
  accentColor,
  onClick,
}: {
  option: QualityOption
  selected: boolean
  playerTheme: 'light' | 'dark'
  accentColor: string
  onClick: () => void
}) {
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const border = selected ? accentColor : playerTheme === 'dark' ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-xl p-4 border text-left transition-all ${playerTheme === 'dark' ? 'bg-white/5 hover:bg-white/10' : 'bg-black/5 hover:bg-black/10'}`}
      style={{ borderColor: border, backgroundColor: selected ? `${accentColor}18` : undefined }}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 w-5 h-5 rounded-full border flex items-center justify-center flex-shrink-0" style={{ borderColor: selected ? accentColor : undefined }}>
          {selected && <Check className="w-3.5 h-3.5" style={{ color: accentColor }} />}
        </div>
        <div className="min-w-0 flex-1">
          <div className={`flex items-center gap-2 ${textPrimary} font-medium`}>
            <span>{option.label}</span>
            {option.requiresVip && <Crown className="w-3.5 h-3.5 text-amber-400" aria-label="会员音质" />}
          </div>
          <div className={`${textSecondary} text-xs mt-1 leading-relaxed`}>{option.description}</div>
        </div>
      </div>
    </button>
  )
}

export default function AudioQualitySettingsModal({
  show,
  onClose,
  playerTheme = 'dark',
  neteaseVip,
  qqVip,
  neteaseLoggedIn,
  qqLoggedIn,
  spotifyLoggedIn = false,
  kugouLoggedIn = false,
  sodaLoggedIn = false,
}: AudioQualitySettingsModalProps) {
  // TV 遥控器 BACK：关闭音质设置弹窗
  useTvBack(() => {
    if (show) {
      onClose()
      return true
    }
    return false
  }, [show, onClose])
  const [settings, setSettings] = useState<AudioQualitySettings>(loadAudioQualitySettings)
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')
  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const borderColor = playerTheme === 'dark' ? 'border-white/10' : 'border-black/10'
  const bgCard = playerTheme === 'dark' ? 'bg-white/5' : 'bg-black/5'

  useEffect(() => {
    if (!show) return
    setSettings(loadAudioQualitySettings())
  }, [show])

  useEffect(() => {
    const handleAccentColor = (event: Event) => {
      const color = (event as CustomEvent<string>).detail
      if (typeof color === 'string' && color) setAccentColor(color)
    }
    window.addEventListener('accentColorChanged', handleAccentColor)
    return () => window.removeEventListener('accentColorChanged', handleAccentColor)
  }, [])

  const update = (platform: keyof AudioQualitySettings, value: AudioQualityPreference) => {
    const next = saveAudioQualitySettings({ [platform]: value })
    setSettings(next)
  }

  const renderPlatform = (
    platform: keyof AudioQualitySettings,
    title: string,
    icon: ReactNode,
    options: QualityOption[],
    isVip: boolean,
    isLoggedIn: boolean,
  ) => (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center" style={{ backgroundColor: `${accentColor}20`, color: accentColor }}>
            {icon}
          </div>
          <div>
            <h3 className={`${textPrimary} font-semibold`}>{title}</h3>
            <p className={`${textTertiary} text-xs mt-0.5`}>{isVip ? '已识别为会员，可使用会员音质' : '非会员，将自动限制为账号可用最高音质'}</p>
          </div>
        </div>
        {isVip && <span className="inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-amber-300 bg-amber-400/10"><Crown className="w-3 h-3" />VIP</span>}
      </div>
      <div className="space-y-2">
        {options.map(option => (
          <QualityOptionButton
            key={option.value}
            option={option}
            selected={settings[platform] === option.value}
            playerTheme={playerTheme}
            accentColor={accentColor}
            onClick={() => update(platform, option.value)}
          />
        ))}
      </div>
    </section>
  )

  return (
    <AnimatePresence>
      {show && (
        <>
          <motion.div className="fixed inset-0 bg-black/50 backdrop-blur-sm z-[600]" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            data-tv-scope
            className="fixed right-0 top-0 h-full w-full max-w-lg z-[610] shadow-2xl overflow-hidden flex flex-col"
            initial={{ x: '100%', opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            style={{
              background: playerTheme === 'dark' ? 'rgba(12, 15, 24, 0.94)' : 'rgba(250, 250, 250, 0.96)',
              backdropFilter: 'blur(24px) saturate(160%)',
              WebkitBackdropFilter: 'blur(24px) saturate(160%)',
              borderLeft: '1px solid rgba(255,255,255,0.1)',
            }}
          >
            <div className={`flex-shrink-0 p-6 border-b ${borderColor} flex items-center justify-between`}>
              <div>
                <h2 className={`text-2xl font-bold ${textPrimary} flex items-center gap-2`}><Headphones className="w-6 h-6" style={{ color: accentColor }} />播放音质</h2>
                <p className={`${textSecondary} text-sm mt-1`}>默认自动使用账号权限范围内的最高音质</p>
              </div>
              <button type="button" onClick={onClose} className={`p-2 rounded-full transition-colors ${bgCard} hover:bg-white/10`} aria-label="关闭"><X className={`w-5 h-5 ${textPrimary}`} /></button>
            </div>
            <div className="flex-1 overflow-y-auto p-6 space-y-8" style={{ scrollbarWidth: 'thin' }}>
              <div className={`${bgCard} rounded-xl border ${borderColor} p-4 flex gap-3`}>
                <Music2 className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: accentColor }} />
                <p className={`${textSecondary} text-sm leading-relaxed`}>选择会员音质时，非会员账号不会报错或卡住，会自动回落到该账号和歌曲可用的最高音质；接口返回不可用时也会继续逐级降级。</p>
              </div>
              {renderPlatform('qq', 'QQ音乐', <span className="font-bold text-sm">QQ</span>, QQ_OPTIONS, qqVip, qqLoggedIn)}
              {renderPlatform('netease', '网易云音乐', <Music2 className="w-5 h-5" />, NETEASE_OPTIONS, neteaseVip, neteaseLoggedIn)}
              {renderPlatform('spotify', 'Spotify', <span className="font-bold text-sm">S</span>, GENERIC_OPTIONS, false, spotifyLoggedIn)}
              {renderPlatform('kugou', '酷狗音乐', <span className="font-bold text-sm">狗</span>, GENERIC_OPTIONS, false, kugouLoggedIn)}
              {renderPlatform('soda', '汽水音乐', <span className="font-bold text-sm">汽</span>, GENERIC_OPTIONS, false, sodaLoggedIn)}
              <p className={`${textTertiary} text-xs leading-relaxed`}>设置会立即保存，并作用于播放、下一首预加载及新的播放链接缓存。正在播放的歌曲会在下次加载该歌曲时应用新音质。Spotify/酷狗/汽水自身直源受限时，播放自动降级到网易云/QQ 载体，音质随载体平台设置。</p>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  )
}
