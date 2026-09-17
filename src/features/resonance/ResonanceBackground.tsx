/**
 * 共振模式背景层：可自定义（跟随封面 / 极光 / 浅色 / 自定义图片）+ 模糊 + 暗度。
 * 背景只是氛围，不参与交互（pointer-events-none）。
 */
import { motion } from 'framer-motion'
import CachedImage from '../../components/CachedImage'
import type { ResonanceSettings } from './settings'

export default function ResonanceBackground({ settings, coverUrl, isPlaying }: {
  settings: ResonanceSettings
  coverUrl: string
  isPlaying: boolean
}) {
  const dim = Math.min(90, Math.max(0, settings.backgroundDim)) / 100
  const blur = Math.min(80, Math.max(0, settings.backgroundBlur))

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      {settings.background === 'light' ? (
        <div className="absolute inset-0" style={{ background: 'linear-gradient(160deg, #f7f9fc 0%, #eef1f7 45%, #e6ecf5 100%)' }} />
      ) : settings.background === 'image' && settings.backgroundImage ? (
        <img
          src={settings.backgroundImage}
          alt=""
          className="absolute inset-0 h-full w-full scale-110 object-cover"
          style={{ filter: `blur(${blur}px) saturate(115%)` }}
        />
      ) : settings.background === 'cover' && coverUrl ? (
        // 设置里的「背景模糊」在这一档必须真的生效（之前只画了封面、没挂 filter）
        <div className="absolute inset-0 scale-110" style={{ filter: `blur(${blur}px) saturate(120%)` }}>
          <CachedImage
            src={coverUrl}
            alt=""
            platform="netease"
            retainPrevious
            role="background"
            priority="visible"
            className="h-full w-full object-cover"
            fit="cover"
          />
        </div>
      ) : (
        <>
          {/* 极光：三团缓慢漂移的色斑，作为无封面/选中极光时的默认氛围 */}
          <div className="absolute inset-0" style={{ background: 'linear-gradient(155deg, #121a33 0%, #0d1224 55%, #090c16 100%)' }} />
          {[
            { color: 'rgba(255,90,112,0.62)', size: 720, x: '-12%', y: '-22%', duration: 26 },
            { color: 'rgba(124,196,255,0.55)', size: 660, x: '52%', y: '4%', duration: 32 },
            { color: 'rgba(160,110,255,0.5)', size: 620, x: '14%', y: '48%', duration: 38 },
          ].map((blob, index) => (
            <motion.span
              key={index}
              className="absolute rounded-full"
              style={{
                width: blob.size,
                height: blob.size,
                left: blob.x,
                top: blob.y,
                background: `radial-gradient(circle at 50% 50%, ${blob.color}, transparent 70%)`,
                filter: `blur(${Math.max(28, blur)}px)`,
              }}
              animate={{ x: [0, 32, -18, 0], y: [0, -24, 20, 0], scale: isPlaying ? [1, 1.06, 1] : 1 }}
              transition={{ duration: blob.duration, repeat: Infinity, ease: 'easeInOut' }}
            />
          ))}
        </>
      )}

      {/* 压暗 + 上下渐变，保证文字对比度。极光/浅色档减弱压暗，否则色斑会被压成一片黑。 */}
      <div className="absolute inset-0" style={{ background: `rgba(6,8,13,${settings.background === 'cover' && coverUrl ? dim : dim * 0.55})` }} />
      <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(4,6,11,0.55) 0%, rgba(4,6,11,0.18) 32%, rgba(4,6,11,0.62) 100%)' }} />
    </div>
  )
}
