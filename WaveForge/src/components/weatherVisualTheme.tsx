import {
  Cloud,
  CloudFog,
  CloudLightning,
  CloudMoon,
  CloudRain,
  CloudSun,
  MoonStar,
  Snowflake,
  Sun,
} from 'lucide-react'
import type { WeatherHazardTab } from './WeatherHazardsPanel'

// 天气可视化主题的轻量模块：从 WeatherDetailsModal 抽离，供桌面小组件静态使用，
// 避免把 leaflet（经 WeatherMapExperience）带进桌面模式的静态依赖图。
// 本模块只包含纯函数/类型与纯视觉组件，不依赖任何重库。

export type WeatherDetailsTab = 'weather' | WeatherHazardTab

export function WeatherGlyph({ code, isDay = true, className = 'h-8 w-8' }: { code: number; isDay?: boolean; className?: string }) {
  if (code === 0) return isDay ? <Sun className={className} /> : <MoonStar className={className} />
  if (code <= 2) return isDay ? <CloudSun className={className} /> : <CloudMoon className={className} />
  if (code === 3) return <Cloud className={className} />
  if (code === 45 || code === 48) return <CloudFog className={className} />
  if (code >= 95) return <CloudLightning className={className} />
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return <Snowflake className={className} />
  return <CloudRain className={className} />
}

export type WeatherSceneKind = 'clear' | 'partly-cloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'heavy-rain' | 'thunder' | 'snow'

export interface WeatherVisualTheme {
  kind: WeatherSceneKind
  isDay: boolean
  background: string
  cardBackground: string
  accent: string
  cloudOpacity: number
}

export function getWeatherVisualTheme(code: number, isDay: boolean): WeatherVisualTheme {
  let kind: WeatherSceneKind = 'clear'
  if (code >= 95) kind = 'thunder'
  else if (code === 65 || code === 67 || code === 82) kind = 'heavy-rain'
  else if (code === 53 || code === 55 || code === 63 || code === 66 || code === 81) kind = 'rain'
  else if (code === 51 || code === 56 || code === 57 || code === 61 || code === 80) kind = 'drizzle'
  else if ((code >= 71 && code <= 77) || code === 85 || code === 86) kind = 'snow'
  else if (code === 45 || code === 48) kind = 'fog'
  else if (code === 3) kind = 'cloudy'
  else if (code === 1 || code === 2) kind = 'partly-cloudy'

  const dayThemes: Record<WeatherSceneKind, Omit<WeatherVisualTheme, 'kind' | 'isDay'>> = {
    clear: { background: 'linear-gradient(180deg, #177bd5 0%, #50afe9 48%, #b8e1f8 100%)', cardBackground: 'linear-gradient(145deg, rgba(38,150,229,0.82), rgba(118,190,229,0.56))', accent: '#fde68a', cloudOpacity: 0.08 },
    'partly-cloudy': { background: 'linear-gradient(180deg, #388ac7 0%, #75add0 48%, #c6d7df 100%)', cardBackground: 'linear-gradient(145deg, rgba(74,139,185,0.82), rgba(148,169,181,0.58))', accent: '#fef3c7', cloudOpacity: 0.48 },
    cloudy: { background: 'linear-gradient(180deg, #557287 0%, #8399a7 54%, #bcc5ca 100%)', cardBackground: 'linear-gradient(145deg, rgba(71,96,116,0.86), rgba(132,145,153,0.62))', accent: '#e2e8f0', cloudOpacity: 0.72 },
    fog: { background: 'linear-gradient(180deg, #667887 0%, #9aa8b0 48%, #d6d9d8 100%)', cardBackground: 'linear-gradient(145deg, rgba(92,111,124,0.82), rgba(171,177,178,0.58))', accent: '#f1f5f9', cloudOpacity: 0.6 },
    drizzle: { background: 'linear-gradient(180deg, #315f7c 0%, #5c8195 52%, #9eb2bb 100%)', cardBackground: 'linear-gradient(145deg, rgba(39,91,122,0.88), rgba(95,126,140,0.66))', accent: '#a5f3fc', cloudOpacity: 0.72 },
    rain: { background: 'linear-gradient(180deg, #173e61 0%, #365b75 52%, #768f9c 100%)', cardBackground: 'linear-gradient(145deg, rgba(24,64,94,0.92), rgba(65,93,107,0.72))', accent: '#7dd3fc', cloudOpacity: 0.82 },
    'heavy-rain': { background: 'linear-gradient(180deg, #112c45 0%, #243f55 48%, #506573 100%)', cardBackground: 'linear-gradient(145deg, rgba(14,43,67,0.94), rgba(47,68,81,0.78))', accent: '#38bdf8', cloudOpacity: 0.92 },
    thunder: { background: 'linear-gradient(180deg, #15152d 0%, #30324c 48%, #50596a 100%)', cardBackground: 'linear-gradient(145deg, rgba(25,24,53,0.96), rgba(62,62,82,0.78))', accent: '#c4b5fd', cloudOpacity: 0.95 },
    snow: { background: 'linear-gradient(180deg, #668da6 0%, #9eb8c7 48%, #e2edf1 100%)', cardBackground: 'linear-gradient(145deg, rgba(89,126,148,0.84), rgba(189,208,216,0.62))', accent: '#ffffff', cloudOpacity: 0.7 },
  }
  const nightThemes: Record<WeatherSceneKind, Omit<WeatherVisualTheme, 'kind' | 'isDay'>> = {
    clear: { background: 'linear-gradient(180deg, #061329 0%, #102c55 52%, #29456f 100%)', cardBackground: 'linear-gradient(145deg, rgba(10,34,70,0.92), rgba(42,66,102,0.68))', accent: '#e0e7ff', cloudOpacity: 0.06 },
    'partly-cloudy': { background: 'linear-gradient(180deg, #0a1932 0%, #273b59 52%, #546779 100%)', cardBackground: 'linear-gradient(145deg, rgba(16,39,70,0.92), rgba(70,83,105,0.68))', accent: '#e2e8f0', cloudOpacity: 0.48 },
    cloudy: { background: 'linear-gradient(180deg, #111a2a 0%, #303b4d 54%, #596371 100%)', cardBackground: 'linear-gradient(145deg, rgba(22,31,48,0.94), rgba(72,80,94,0.72))', accent: '#cbd5e1', cloudOpacity: 0.76 },
    fog: { background: 'linear-gradient(180deg, #1c2735 0%, #4b5965 50%, #77828a 100%)', cardBackground: 'linear-gradient(145deg, rgba(29,41,55,0.92), rgba(93,105,115,0.7))', accent: '#e2e8f0', cloudOpacity: 0.68 },
    drizzle: { background: 'linear-gradient(180deg, #081c32 0%, #203b50 52%, #4d6471 100%)', cardBackground: 'linear-gradient(145deg, rgba(9,30,52,0.96), rgba(47,69,82,0.76))', accent: '#7dd3fc', cloudOpacity: 0.8 },
    rain: { background: 'linear-gradient(180deg, #071629 0%, #173047 52%, #3f5362 100%)', cardBackground: 'linear-gradient(145deg, rgba(6,23,43,0.97), rgba(36,57,72,0.8))', accent: '#38bdf8', cloudOpacity: 0.9 },
    'heavy-rain': { background: 'linear-gradient(180deg, #050f1e 0%, #102536 52%, #32434f 100%)', cardBackground: 'linear-gradient(145deg, rgba(4,16,31,0.98), rgba(28,47,60,0.84))', accent: '#0ea5e9', cloudOpacity: 0.96 },
    thunder: { background: 'linear-gradient(180deg, #080817 0%, #1d1831 48%, #39384b 100%)', cardBackground: 'linear-gradient(145deg, rgba(10,8,27,0.98), rgba(48,40,69,0.84))', accent: '#a78bfa', cloudOpacity: 0.98 },
    snow: { background: 'linear-gradient(180deg, #17263c 0%, #3d536c 50%, #71879b 100%)', cardBackground: 'linear-gradient(145deg, rgba(24,41,64,0.94), rgba(78,99,119,0.72))', accent: '#f8fafc', cloudOpacity: 0.76 },
  }
  return { kind, isDay, ...(isDay ? dayThemes[kind] : nightThemes[kind]) }
}

export function WeatherAtmosphere({ theme, compact = false }: { theme: WeatherVisualTheme; compact?: boolean }) {
  const rainCount = compact ? 12 : theme.kind === 'heavy-rain' || theme.kind === 'thunder' ? 52 : 32
  const showsRain = ['drizzle', 'rain', 'heavy-rain', 'thunder'].includes(theme.kind)
  const showsClouds = theme.cloudOpacity > 0.2
  const showsSnow = theme.kind === 'snow'

  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden weather-atmosphere weather-atmosphere-${theme.kind}`} style={{ background: compact ? theme.cardBackground : theme.background }}>
      {!theme.isDay && (
        <>
          {!compact && <div className="absolute -left-[12%] top-[8%] h-[44%] w-[118%] -rotate-[11deg] bg-[radial-gradient(ellipse,rgba(184,204,255,0.12),rgba(115,139,191,0.04)_42%,transparent_72%)] blur-3xl" />}
          {Array.from({ length: compact ? 18 : 78 }, (_, index) => {
            const size = index % 13 === 0 ? 3.4 : index % 5 === 0 ? 2.2 : 1 + (index % 3) * 0.45
            const starColor = index % 9 === 0 ? '#fff1c7' : index % 7 === 0 ? '#c7ddff' : '#ffffff'
            return (
              <i
                key={`star-${index}`}
                className="absolute rounded-full weather-star"
                style={{
                  left: `${1 + ((index * 37 + index * index * 3) % 98)}%`,
                  top: `${2 + ((index * 23 + index * index * 5) % 78)}%`,
                  width: `${compact ? Math.min(2.4, size) : size}px`,
                  height: `${compact ? Math.min(2.4, size) : size}px`,
                  backgroundColor: starColor,
                  boxShadow: index % 11 === 0 ? `0 0 ${compact ? 5 : 10}px ${starColor}` : `0 0 3px ${starColor}99`,
                  animationDelay: `${-(index % 17) * 0.27}s`,
                  animationDuration: `${2.4 + (index % 7) * 0.42}s`,
                }}
              />
            )
          })}
        </>
      )}

      {(theme.kind === 'clear' || theme.kind === 'partly-cloudy') && (
        <div
          className="absolute rounded-full weather-celestial"
          style={{
            right: compact ? '10%' : '8vw',
            top: compact ? '12%' : '6vh',
            width: compact ? '74px' : 'min(32vw, 420px)',
            height: compact ? '74px' : 'min(32vw, 420px)',
          }}
        >
          <div className={`absolute inset-0 rounded-full ${theme.isDay ? 'weather-sun-corona' : 'weather-moon-glow'}`} />
          <div
            className={`absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full ${theme.isDay ? 'weather-sun-disc' : 'weather-moon-disc'}`}
            style={{
              width: compact ? (theme.isDay ? '34px' : '39px') : (theme.isDay ? '38%' : '43%'),
              height: compact ? (theme.isDay ? '34px' : '39px') : (theme.isDay ? '38%' : '43%'),
            }}
          >
            <i className={`absolute inset-[7%] rounded-full ${theme.isDay ? 'weather-sun-surface' : 'weather-moon-surface'}`} />
          </div>
        </div>
      )}

      {showsClouds && Array.from({ length: compact ? 3 : 8 }, (_, index) => (
        <i
          key={`cloud-${index}`}
          className={`absolute weather-cloud weather-cloud-layer-${index % 3}`}
          style={{
            left: `${-18 + ((index * 29) % 112)}%`,
            top: `${4 + ((index * 17) % 54)}%`,
            width: compact ? `${110 + index * 20}px` : `${260 + (index % 3) * 130}px`,
            height: compact ? `${42 + index * 5}px` : `${84 + (index % 3) * 32}px`,
            opacity: theme.cloudOpacity * (0.45 + (index % 3) * 0.18),
            animationDelay: `${-index * 2.1}s`,
            animationDuration: `${18 + (index % 4) * 5}s`,
          }}
        />
      ))}

      {showsRain && Array.from({ length: rainCount }, (_, index) => (
        <i
          key={`rain-${index}`}
          className={`absolute weather-rain-drop ${index % 4 === 0 ? 'weather-rain-drop-near' : 'weather-rain-drop-far'}`}
          style={{
            left: `${(index * 47) % 101}%`,
            top: `${-18 - ((index * 13) % 70)}px`,
            height: theme.kind === 'drizzle' ? '14px' : theme.kind === 'heavy-rain' || theme.kind === 'thunder' ? '42px' : '26px',
            opacity: theme.kind === 'drizzle' ? 0.26 : 0.48 + (index % 4) * 0.1,
            animationDelay: `${-(index % 13) * 0.13}s`,
            animationDuration: `${theme.kind === 'heavy-rain' || theme.kind === 'thunder' ? 0.55 : 0.82 + (index % 5) * 0.08}s`,
          }}
        />
      ))}

      {showsRain && <div className="absolute inset-x-0 bottom-0 h-[34%] weather-rain-haze" />}
      {showsRain && !compact && Array.from({ length: 18 }, (_, index) => <i key={`splash-${index}`} className="absolute bottom-[2%] h-[5px] w-[18px] rounded-[50%] border border-cyan-100/35 weather-rain-splash" style={{ left: `${(index * 67) % 98}%`, animationDelay: `-${(index % 9) * .16}s` }} />)}

      {showsSnow && Array.from({ length: compact ? 14 : 42 }, (_, index) => (
        <i
          key={`snow-${index}`}
          className={`absolute rounded-full bg-white weather-snowflake weather-snowflake-${index % 3}`}
          style={{
            left: `${(index * 41) % 101}%`,
            top: `${-12 - ((index * 19) % 90)}px`,
            width: `${3 + (index % 4) * 2}px`,
            height: `${3 + (index % 4) * 2}px`,
            opacity: 0.42 + (index % 4) * 0.12,
            animationDelay: `${-(index % 11) * 0.4}s`,
            animationDuration: `${5 + (index % 5)}s`,
          }}
        />
      ))}

      {theme.kind === 'fog' && Array.from({ length: compact ? 3 : 7 }, (_, index) => (
        <i key={`fog-${index}`} className="absolute left-[-15%] w-[130%] rounded-full bg-white/16 blur-2xl weather-fog-band" style={{ top: `${16 + index * 12}%`, height: compact ? '22px' : '54px', animationDelay: `${-index * 1.6}s` }} />
      ))}

      {theme.kind === 'thunder' && <><div className="absolute -left-[12%] top-[-18%] h-[66%] w-[78%] rounded-full bg-violet-200/20 blur-3xl weather-storm-glow" /><div className="absolute inset-0 bg-violet-100 weather-lightning" /><div className="absolute left-[18%] top-[20%] h-[46%] w-[2px] origin-top rotate-[17deg] bg-gradient-to-b from-white via-violet-100 to-transparent opacity-0 weather-lightning-bolt" /></>}
      <div className="absolute inset-0 bg-gradient-to-b from-white/[0.025] via-transparent to-slate-950/28" />
    </div>
  )
}
