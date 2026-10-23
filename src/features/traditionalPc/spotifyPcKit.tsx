// 传统模式「Spotify 客户端」共享 kit：品牌色/封面/曲目表（对齐官方 Windows 客户端布局）。
// 与 applePcKit 同思路，但配色与信息密度对齐 Spotify 官方：绿 accent、行内含 专辑列 + 添加日期列。
import type { ReactNode } from 'react'

export interface SpotifyPcTheme {
  tone: 'dark' | 'light'
  background: string
  content: string
  panel: string
  hover: string
  divider: string
  text: string
  secondary: string
  tertiary: string
  accent: string
}

export function spotifyPcTheme(tone: 'dark' | 'light'): SpotifyPcTheme {
  if (tone === 'dark') {
    return {
      tone,
      background: '#121212',
      content: '#181818',
      panel: '#242424',
      hover: '#2a2a2a',
      divider: '#2e2e2e',
      text: '#ffffff',
      secondary: '#b3b3b3',
      tertiary: '#7a7a7a',
      accent: '#1ed760',
    }
  }
  return {
    tone,
    background: '#f5f5f5',
    content: '#ffffff',
    panel: '#ececec',
    hover: '#e0e0e0',
    divider: '#d8d8d8',
    text: '#121212',
    secondary: '#5a5a5a',
    tertiary: '#8a8a8a',
    accent: '#1ed760',
  }
}

/** 官方大标题（歌单详情页顶部：巨大加粗标题） */
export function SpotifyPcHeroTitle({ theme, children }: { theme: SpotifyPcTheme; children: ReactNode }) {
  return (
    <h1 className="text-[clamp(2rem,5vw,4.5rem)] font-black leading-tight tracking-tight" style={{ color: theme.text }}>
      {children}
    </h1>
  )
}

/** 分区标题（页内小节：热门曲目/专辑/艺人） */
export function SpotifyPcSectionTitle({ theme, children }: { theme: SpotifyPcTheme; children: ReactNode }) {
  return <h2 className="mb-4 text-xl font-bold" style={{ color: theme.text }}>{children}</h2>
}

/** 绿色圆形播放按钮（歌单详情页主 CTA） */
export function SpotifyPcPlayButton({ size = 56, onPlay }: { size?: number; onPlay: () => void }) {
  return (
    <button
      type="button"
      onClick={onPlay}
      className="flex items-center justify-center rounded-full transition hover:scale-105 hover:brightness-110"
      style={{ width: size, height: size, background: '#1ed760', boxShadow: '0 8px 24px rgba(30,215,96,.4)' }}
      aria-label="播放"
    >
      <svg width={size * 0.4} height={size * 0.4} viewBox="0 0 24 24" fill="#000">
        <path d="M8 5v14l11-7z" />
      </svg>
    </button>
  )
}
