// 苹果风格天气状态图标：全 SVG 矢量手绘（填充式，多色），任意尺寸清晰。
// 形状基调：白云 + 彩色点缀（晴日黄、夜月银白、雨滴蓝、闪电黄），对齐 Apple Weather 观感。

interface IconProps {
  className?: string
}

const CLOUD = '#eef2f8'
const CLOUD_DIM = '#c9d2de'
const SUN = '#ffd257'
const RAIN = '#8ec9f5'
const MOON = '#e8edf4'

function Sun({ cx = 32, cy = 30, r = 10, rays = true }: { cx?: number; cy?: number; r?: number; rays?: boolean }) {
  const ray = []
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4
    const x1 = cx + Math.cos(a) * (r + 3.2)
    const y1 = cy + Math.sin(a) * (r + 3.2)
    const x2 = cx + Math.cos(a) * (r + 7)
    const y2 = cy + Math.sin(a) * (r + 7)
    ray.push(<line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={SUN} strokeWidth="4" strokeLinecap="round" />)
  }
  return (
    <g>
      {rays && ray}
      <circle cx={cx} cy={cy} r={r} fill={SUN} />
    </g>
  )
}

function Crescent({ cx = 30, cy = 30, r = 14 }: { cx?: number; cy?: number; r?: number }) {
  return (
    <path
      d={`M ${cx + r * 0.55} ${cy - r * 0.82} A ${r} ${r} 0 1 0 ${cx + r * 0.72} ${cy + r * 0.7} A ${r * 0.86} ${r * 0.86} 0 1 1 ${cx + r * 0.55} ${cy - r * 0.82} Z`}
      fill={MOON}
    />
  )
}

function Cloud({ dim = false, x = 0, y = 0, scale = 1 }: { dim?: boolean; x?: number; y?: number; scale?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${scale})`} fill={dim ? CLOUD_DIM : CLOUD}>
      <circle cx="22" cy="34" r="10.5" />
      <circle cx="34.5" cy="27" r="13.5" />
      <circle cx="46" cy="35" r="9.5" />
      <rect x="18" y="33" width="30" height="12" rx="6" />
    </g>
  )
}

function Drops({ xs = [24, 32, 40], y = 46, long = false }: { xs?: number[]; y?: number; long?: boolean }) {
  return (
    <g stroke={RAIN} strokeWidth="4.6" strokeLinecap="round">
      {xs.map((x, i) => {
        const len = long ? 9 : 6.5
        const drop = i % 2 === 0 ? 0 : 3
        return <line key={i} x1={x + drop * 0.4} y1={y + drop} x2={x - 1.6 + drop * 0.4} y2={y + drop + len} />
      })}
    </g>
  )
}

function Bolt({ x = 32, y = 44 }: { x?: number; y?: number }) {
  return <path d={`M ${x + 2} ${y} l -8 12 h 6.5 l -3.5 9.5 l 11.5 -13.5 h -6.5 l 4.5 -8 z`} fill={SUN} />
}

function SnowMark({ x = 32, y = 52, r = 7 }: { x?: number; y?: number; r?: number }) {
  const arms = []
  for (let i = 0; i < 3; i++) {
    const a = (i * Math.PI) / 3
    arms.push(
      <line key={i} x1={x - Math.cos(a) * r} y1={y - Math.sin(a) * r} x2={x + Math.cos(a) * r} y2={y + Math.sin(a) * r} stroke="#eef2f8" strokeWidth="3.4" strokeLinecap="round" />,
    )
  }
  return <g>{arms}</g>
}

function FogLines({ y = 48 }: { y?: number }) {
  return (
    <g stroke={CLOUD} strokeWidth="4.4" strokeLinecap="round" opacity="0.9">
      <line x1="16" y1={y} x2="46" y2={y} />
      <line x1="21" y1={y + 8.5} x2="41" y2={y + 8.5} />
    </g>
  )
}

function IconFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      {children}
    </svg>
  )
}

// —— 晴 ——
export function IconClearDay({ className }: IconProps) {
  return <IconFrame className={className}><Sun cx={32} cy={32} r={11} /></IconFrame>
}
export function IconClearNight({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Crescent cx={29} cy={31} r={15} />
      <circle cx="45" cy="18" r="2" fill={MOON} />
      <circle cx="51" cy="27" r="1.5" fill={MOON} />
      <circle cx="44" cy="34" r="1.2" fill={MOON} />
    </IconFrame>
  )
}

// —— 多云 ——
export function IconPartlyDay({ className }: IconProps) {
  return <IconFrame className={className}><Sun cx={43} cy={21} r={9} /><Cloud y={4} /></IconFrame>
}
export function IconPartlyNight({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Crescent cx={42} cy={20} r={10} />
      <circle cx="49" cy="12" r="1.6" fill={MOON} />
      <Cloud y={5} />
    </IconFrame>
  )
}

// —— 阴 / 多云 ——
export function IconCloudy({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Cloud dim x={-2} y={-4} scale={0.8} />
      <Cloud y={6} />
    </IconFrame>
  )
}
export function IconCloudyNight({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Crescent cx={44} cy={14} r={8} />
      <Cloud dim x={-2} y={-4} scale={0.8} />
      <Cloud y={6} />
    </IconFrame>
  )
}

// —— 雨 ——
export function IconRain({ className }: IconProps) {
  return <IconFrame className={className}><Cloud y={-2} /><Drops y={45} /></IconFrame>
}
export function IconRainNight({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Crescent cx={45} cy={13} r={7} />
      <Cloud y={-2} />
      <Drops y={45} />
    </IconFrame>
  )
}
export function IconHeavyRain({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Cloud y={-4} />
      <Drops xs={[20, 28, 36, 44]} y={42} long />
    </IconFrame>
  )
}
export function IconHeavyRainNight({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Crescent cx={45} cy={11} r={7} />
      <Cloud y={-4} />
      <Drops xs={[20, 28, 36, 44]} y={42} long />
    </IconFrame>
  )
}
export function IconDrizzle({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Cloud y={-2} />
      <g stroke={RAIN} strokeWidth="4" strokeLinecap="round">
        <line x1="24" y1="47" x2="23" y2="51" />
        <line x1="33" y1="50" x2="32" y2="54" />
        <line x1="42" y1="47" x2="41" y2="51" />
      </g>
    </IconFrame>
  )
}
export function IconDrizzleNight({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Crescent cx={45} cy={13} r={7} />
      <Cloud y={-2} />
      <g stroke={RAIN} strokeWidth="4" strokeLinecap="round">
        <line x1="24" y1="47" x2="23" y2="51" />
        <line x1="33" y1="50" x2="32" y2="54" />
        <line x1="42" y1="47" x2="41" y2="51" />
      </g>
    </IconFrame>
  )
}
export function IconShowers({ className }: IconProps) {
  return <IconFrame className={className}><Sun cx={45} cy={17} r={8} rays={false} /><Cloud y={0} /><Drops xs={[26, 36]} y={47} /></IconFrame>
}
export function IconShowersNight({ className }: IconProps) {
  return <IconFrame className={className}><Crescent cx={45} cy={15} r={7.5} /><Cloud y={0} /><Drops xs={[26, 36]} y={47} /></IconFrame>
}

// —— 雷 ——
export function IconThunder({ className }: IconProps) {
  return <IconFrame className={className}><Cloud y={-3} /><Bolt /></IconFrame>
}
export function IconThunderNight({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Crescent cx={46} cy={12} r={6.5} />
      <Cloud y={-3} />
      <Bolt />
    </IconFrame>
  )
}
export function IconHeavyThunder({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Cloud y={-4} />
      <Drops xs={[20, 44]} y={42} />
      <Bolt x={32} y={42} />
    </IconFrame>
  )
}
export function IconHeavyThunderNight({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Crescent cx={46} cy={10} r={6} />
      <Cloud y={-4} />
      <Drops xs={[20, 44]} y={42} />
      <Bolt x={32} y={42} />
    </IconFrame>
  )
}

// —— 雪 / 雨夹雪 / 冰 ——
export function IconSnow({ className }: IconProps) {
  return <IconFrame className={className}><Cloud y={-3} /><SnowMark y={51} /></IconFrame>
}
export function IconSleet({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Cloud y={-3} />
      <line x1="25" y1="46" x2="24" y2="54" stroke={RAIN} strokeWidth="4.4" strokeLinecap="round" />
      <SnowMark x={40} y={51} r={5.5} />
    </IconFrame>
  )
}
export function IconSleetNight({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Crescent cx={46} cy={12} r={6.5} />
      <Cloud y={-3} />
      <line x1="25" y1="46" x2="24" y2="54" stroke={RAIN} strokeWidth="4.4" strokeLinecap="round" />
      <SnowMark x={40} y={51} r={5.5} />
    </IconFrame>
  )
}
function Thermometer({ color }: { color: string }) {
  return (
    <g>
      <rect x="27" y="12" width="10" height="28" rx="5" fill="none" stroke={CLOUD} strokeWidth="4" />
      <rect x="29.8" y="20" width="4.4" height="18" rx="2.2" fill={color} />
      <circle cx="32" cy="44" r="7.5" fill={color} />
    </g>
  )
}
export function IconHot({ className }: IconProps) {
  return <IconFrame className={className}><Thermometer color="#ff7a59" /></IconFrame>
}
export function IconIce({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Thermometer color="#6fb7f2" />
      <SnowMark x={47} y={16} r={5.5} />
    </IconFrame>
  )
}

// —— 雾 ——
export function IconFog({ className }: IconProps) {
  return <IconFrame className={className}><Cloud y={-6} scale={0.92} /><FogLines y={44} /></IconFrame>
}
export function IconFogNight({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Crescent cx={45} cy={11} r={6} />
      <Cloud y={-6} scale={0.92} />
      <FogLines y={44} />
    </IconFrame>
  )
}

// —— 日出 / 日落 ——
export function IconSunrise({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Sun cx={32} cy={38} r={9} rays={false} />
      <rect x="10" y="47" width="44" height="4" rx="2" fill={CLOUD} />
      <line x1="32" y1="14" x2="32" y2="22" stroke={SUN} strokeWidth="4" strokeLinecap="round" />
      <path d="M26 20 L32 13 L38 20" fill="none" stroke={SUN} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </IconFrame>
  )
}
export function IconSunset({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <Sun cx={32} cy={38} r={9} rays={false} />
      <rect x="10" y="47" width="44" height="4" rx="2" fill={CLOUD} />
      <line x1="32" y1="10" x2="32" y2="18" stroke={SUN} strokeWidth="4" strokeLinecap="round" />
      <path d="M26 14 L32 21 L38 14" fill="none" stroke={SUN} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
    </IconFrame>
  )
}

// —— 风（卡片装饰用）——
export function IconWindLines({ className }: IconProps) {
  return (
    <IconFrame className={className}>
      <g fill="none" stroke={CLOUD} strokeWidth="4.4" strokeLinecap="round">
        <path d="M12 24 h26 a6 6 0 1 0 -6 -6" />
        <path d="M12 36 h32 a6 6 0 1 1 -6 6" />
        <path d="M12 48 h20" />
      </g>
    </IconFrame>
  )
}

// WMO 代码 → 图标组件
type IconComponent = (props: IconProps) => React.ReactElement

const WMO_ICON_COMPONENTS: Array<[predicate: (code: number) => boolean, day: IconComponent, night: IconComponent]> = [
  [c => c === 0, IconClearDay, IconClearNight],
  [c => c >= 1 && c <= 2, IconPartlyDay, IconPartlyNight],
  [c => c === 3, IconCloudy, IconCloudyNight],
  [c => c === 45 || c === 48, IconFog, IconFogNight],
  [c => c >= 51 && c <= 55, IconDrizzle, IconDrizzleNight],
  [c => c === 56 || c === 57 || c === 66 || c === 67, IconIce, IconIce],
  [c => c === 61 || c === 63, IconRain, IconRainNight],
  [c => c === 65 || c === 82, IconHeavyRain, IconHeavyRainNight],
  [c => c === 80 || c === 81, IconShowers, IconShowersNight],
  [c => c >= 71 && c <= 77, IconSnow, IconSnow],
  [c => c === 85 || c === 86, IconSleet, IconSleetNight],
  [c => c === 95, IconThunder, IconThunderNight],
  [c => c >= 96, IconHeavyThunder, IconHeavyThunderNight],
]

export function AppleWeatherIcon({ code, isDay = true, className = 'h-8 w-8' }: { code: number; isDay?: boolean; className?: string }) {
  for (const [predicate, day, night] of WMO_ICON_COMPONENTS) {
    if (predicate(code)) {
      const Icon = isDay ? day : night
      return <Icon className={className} />
    }
  }
  const Fallback = isDay ? IconRain : IconRainNight
  return <Fallback className={className} />
}
