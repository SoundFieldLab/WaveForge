/**
 * 成就图标注册表：自绘 SVG（像素感线性图标，非 MC 素材）。
 * key → 渲染函数；unknown fallback。
 * 颜色由调用方传（普通金 / 史诗紫），图标内部只做描边风格。
 */
import type { CSSProperties, JSX } from 'react'

type IconProps = { size?: number; color?: string; style?: CSSProperties }

const stroke = (color: string) => ({
  stroke: color,
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none' as const,
})

function WelcomeIcon({ size = 24, color = '#ffd83d', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      {/* 派对彩带 */}
      <path d="M12 15V5" {...stroke(color)} />
      <path d="M12 5l-3-2M12 5l3-2M12 5l-1.5-3M12 5l1.5-3" {...stroke(color)} strokeWidth={1.4} />
      <path d="M8 15c1.2 2 2.5 3 4 3s2.8-1 4-3" {...stroke(color)} />
      <circle cx="5" cy="9" r="0.9" fill={color} />
      <circle cx="19" cy="10" r="0.9" fill={color} />
      <circle cx="4.5" cy="14" r="0.7" fill={color} />
      <circle cx="19.5" cy="14.5" r="0.7" fill={color} />
      <circle cx="8" cy="4" r="0.6" fill={color} />
      <circle cx="16" cy="4" r="0.6" fill={color} />
    </svg>
  )
}

function PlayIcon({ size = 24, color = '#ffd83d', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <circle cx="12" cy="12" r="8.5" {...stroke(color)} />
      <path d="M10 8.5v7l5.5-3.5z" fill={color} />
    </svg>
  )
}

function HeadphonesIcon({ size = 24, color = '#ffd83d', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" {...stroke(color)} />
      <rect x="3" y="13.5" width="4" height="6.5" rx="1.5" {...stroke(color)} />
      <rect x="17" y="13.5" width="4" height="6.5" rx="1.5" {...stroke(color)} />
    </svg>
  )
}

function VinylIcon({ size = 24, color = '#c77dff', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <circle cx="12" cy="12" r="8.5" {...stroke(color)} />
      <circle cx="12" cy="12" r="4.5" {...stroke(color)} strokeWidth={1.2} />
      <circle cx="12" cy="12" r="1.2" fill={color} />
      <path d="M6 7a8.5 8.5 0 0 1 3-2" {...stroke(color)} strokeWidth={1} />
    </svg>
  )
}

function SparkleIcon({ size = 24, color = '#ffd83d', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" {...stroke(color)} />
      <path d="M18.5 15.5l.9 2.1 2.1.9-2.1.9-.9 2.1-.9-2.1-2.1-.9 2.1-.9z" fill={color} opacity={0.85} />
    </svg>
  )
}

function GridIcon({ size = 24, color = '#c77dff', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <rect x="4" y="4" width="6.5" height="6.5" rx="1.2" {...stroke(color)} />
      <rect x="13.5" y="4" width="6.5" height="6.5" rx="1.2" {...stroke(color)} />
      <rect x="4" y="13.5" width="6.5" height="6.5" rx="1.2" {...stroke(color)} />
      <rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.2" {...stroke(color)} />
      <path d="M16.75 6.5v2M6.5 16.75h2" {...stroke(color)} strokeWidth={1.2} />
    </svg>
  )
}

function DjIcon({ size = 24, color = '#ffd83d', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <circle cx="9" cy="14" r="5.5" {...stroke(color)} />
      <circle cx="9" cy="14" r="1.5" fill={color} />
      <path d="M14.5 9.5L20 4M17 4h3v3" {...stroke(color)} />
      <path d="M15 13.5a5.5 5.5 0 0 1 5 5" {...stroke(color)} strokeWidth={1.2} />
    </svg>
  )
}

function SurroundIcon({ size = 24, color = '#ffd83d', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <circle cx="12" cy="12" r="2" fill={color} />
      <path d="M7.5 16.5a6.4 6.4 0 0 1 0-9M16.5 7.5a6.4 6.4 0 0 1 0 9" {...stroke(color)} />
      <path d="M4.8 19.2a10 10 0 0 1 0-14.4M19.2 4.8a10 10 0 0 1 0 14.4" {...stroke(color)} strokeWidth={1.2} />
    </svg>
  )
}

function MoonIcon({ size = 24, color = '#ffd83d', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <path d="M19 14.5A8 8 0 0 1 9.5 5a8 8 0 1 0 9.5 9.5z" {...stroke(color)} />
      <path d="M16 4l.6 1.7 1.7.6-1.7.6L16 8.6l-.6-1.7-1.7-.6 1.7-.6z" fill={color} />
    </svg>
  )
}

function SunriseIcon({ size = 24, color = '#ffd83d', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <path d="M6 16a6 6 0 0 1 12 0" {...stroke(color)} />
      <path d="M12 4v3M4.5 9l2 2M19.5 9l-2 2M2.5 16h3M18.5 16h3M2 20h20" {...stroke(color)} />
    </svg>
  )
}

function ListIcon({ size = 24, color = '#ffd83d', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <path d="M4 6h10M4 11h10M4 16h6" {...stroke(color)} />
      <path d="M17 13.5v6l4.5-3z" {...stroke(color)} fill={color} fillOpacity={0.25} />
    </svg>
  )
}

function DesktopIcon({ size = 24, color = '#ffd83d', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <rect x="3" y="4.5" width="18" height="12" rx="1.5" {...stroke(color)} />
      <path d="M9 20h6M12 16.5V20" {...stroke(color)} />
      <path d="M7 11.5h6M7 13.5h4" {...stroke(color)} strokeWidth={1.3} />
    </svg>
  )
}

function PaletteIcon({ size = 24, color = '#ffd83d', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.4 0 2-.8 2-1.7 0-1.4-1.3-1.8-1.3-3 0-1 .8-1.8 2-1.8h1.8c2.2 0 4-1.7 4-3.9C20.5 6 16.7 3.5 12 3.5z" {...stroke(color)} />
      <circle cx="8" cy="9" r="1.1" fill={color} />
      <circle cx="12.5" cy="7" r="1.1" fill={color} />
      <circle cx="16.5" cy="9.5" r="1.1" fill={color} />
      <circle cx="7.5" cy="13.5" r="1.1" fill={color} />
    </svg>
  )
}

function BugIcon({ size = 24, color = '#c77dff', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <ellipse cx="12" cy="14" rx="5.5" ry="6.5" {...stroke(color)} />
      <path d="M12 7.5v13M9.5 9.5c-1.5 3-1.5 9 0 11M14.5 9.5c1.5 3 1.5 9 0 11" {...stroke(color)} strokeWidth={1.3} />
      <path d="M9.5 5.5L8 3M14.5 5.5L16 3M8.5 4.8a4.5 4.5 0 0 1 7 0" {...stroke(color)} strokeWidth={1.3} />
      <path d="M6.5 11L3.5 9.5M6.5 15H3M6.5 18.5l-3 1.5M17.5 11l3-1.5M17.5 15H21M17.5 18.5l3 1.5" {...stroke(color)} strokeWidth={1.2} />
    </svg>
  )
}

function MysteryIcon({ size = 24, color = '#8a8a8a', style }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={style} aria-hidden>
      <circle cx="12" cy="12" r="8.5" {...stroke(color)} />
      <path d="M9.6 9.8a2.5 2.5 0 1 1 3.4 2.9c-.7.4-1 .9-1 1.8" {...stroke(color)} />
      <circle cx="12" cy="17" r="1" fill={color} />
    </svg>
  )
}

const REGISTRY: Record<string, (props: IconProps) => JSX.Element> = {
  welcome: WelcomeIcon,
  play: PlayIcon,
  headphones: HeadphonesIcon,
  vinyl: VinylIcon,
  sparkle: SparkleIcon,
  grid: GridIcon,
  dj: DjIcon,
  surround: SurroundIcon,
  moon: MoonIcon,
  sunrise: SunriseIcon,
  list: ListIcon,
  desktop: DesktopIcon,
  palette: PaletteIcon,
  bug: BugIcon,
  mystery: MysteryIcon,
}

export function AchievementIcon({ icon, unlocked, tier, size = 24, style }: { icon: string; unlocked: boolean; tier: 'normal' | 'epic'; size?: number; style?: CSSProperties }) {
  const color = tier === 'epic' ? '#c77dff' : '#ffd83d'
  const key = icon in REGISTRY ? icon : 'mystery'
  const Component = REGISTRY[key]
  return (
    <span
      className="flex shrink-0 items-center justify-center"
      style={{
        width: size * 1.6, height: size * 1.6,
        borderRadius: 10,
        background: unlocked
          ? (tier === 'epic'
            ? 'linear-gradient(135deg, rgba(160,90,255,0.28), rgba(80,40,150,0.35))'
            : 'linear-gradient(135deg, rgba(255,200,60,0.24), rgba(160,110,20,0.32))')
          : 'rgba(128,128,128,0.12)',
        border: `1px solid ${unlocked ? (tier === 'epic' ? 'rgba(199,125,255,0.4)' : 'rgba(255,216,61,0.38)') : 'rgba(128,128,128,0.2)'}`,
        ...style,
      }}
    >
      <Component size={size} color={unlocked ? color : '#6a6a6a'} />
    </span>
  )
}

export const MYSTERY_ICON = 'mystery'
