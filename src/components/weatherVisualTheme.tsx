import { useEffect, useMemo, useRef } from 'react'
import type { WeatherHazardTab } from './WeatherHazardsPanel'
import { AppleWeatherIcon } from './AppleWeatherIcon'
import { azimuthDirection, computeSkyBodies, type SkyBodies } from '../services/moonPhase'
// 真实摄影素材（版权与来源见 src/assets/weather/CREDITS.md）
import moonUrl from '../assets/weather/moon.webp'
import skyDayUrl from '../assets/weather/sky-day.jpg'
import skyNightUrl from '../assets/weather/sky-night.jpg'

export function WeatherGlyph({ code, isDay = true, className = 'h-8 w-8' }: { code: number; isDay?: boolean; className?: string }) {
  return <AppleWeatherIcon code={code} isDay={isDay} className={className} />
}

// 天气可视化主题的轻量模块：从 WeatherDetailsModal 抽离，供桌面小组件静态使用，
// 避免把 leaflet（经 WeatherMapExperience）带进桌面模式的静态依赖图。
// 本模块只包含纯函数/类型与纯视觉组件，不依赖任何重库。

export type WeatherDetailsTab = 'weather' | WeatherHazardTab

export type WeatherSceneKind = 'clear' | 'partly-cloudy' | 'cloudy' | 'fog' | 'drizzle' | 'rain' | 'heavy-rain' | 'thunder' | 'snow'

export const isRainySceneKind = (kind: WeatherSceneKind) => kind === 'drizzle' || kind === 'rain' || kind === 'heavy-rain' || kind === 'thunder'

export const getUvLabel = (value: number) => value < 3 ? '低' : value < 6 ? '中等' : value < 8 ? '较高' : value < 11 ? '很高' : '极高'

export const getWindDirection = (degree: number) => {
  const directions = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  return directions[Math.round(degree / 45) % 8]
}

/** 风向罗盘（风力卡片） */
export function WindCompass({ degree }: { degree: number }) {
  return (
    <div className="relative h-[104px] w-[104px] shrink-0 self-center">
      <div className="absolute inset-0 rounded-full border border-white/22" />
      <span className="absolute left-1/2 top-0.5 -translate-x-1/2 text-[10px] text-white/55">北</span>
      <span className="absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-white/55">东</span>
      <span className="absolute left-1/2 bottom-0.5 -translate-x-1/2 text-[10px] text-white/55">南</span>
      <span className="absolute left-1 top-1/2 -translate-y-1/2 text-[10px] text-white/55">西</span>
      <div className="absolute inset-0 flex items-center justify-center" style={{ transform: `rotate(${(degree + 180) % 360}deg)` }}>
        <svg viewBox="0 0 24 24" className="h-10 w-10">
          <line x1="12" y1="20" x2="12" y2="6" stroke="rgba(255,255,255,0.85)" strokeWidth="1.8" strokeLinecap="round" />
          <path d="M12 3.2 L15 9 L9 9 Z" fill="#9fd0ff" />
        </svg>
      </div>
    </div>
  )
}

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
    clear: { background: 'linear-gradient(180deg, #0e63c6 0%, #3d97e8 34%, #7fc4f2 62%, #cfeafb 100%)', cardBackground: 'linear-gradient(145deg, rgba(24,116,205,0.82), rgba(110,182,226,0.56))', accent: '#fde68a', cloudOpacity: 0.1 },
    'partly-cloudy': { background: 'linear-gradient(180deg, #2f77b5 0%, #5b9cc9 40%, #a3c6d8 76%, #d9e6ec 100%)', cardBackground: 'linear-gradient(145deg, rgba(66,128,180,0.82), rgba(140,164,178,0.58))', accent: '#fef3c7', cloudOpacity: 0.5 },
    cloudy: { background: 'linear-gradient(180deg, #4d6579 0%, #7b8fa0 45%, #aab6bf 78%, #cdd4d8 100%)', cardBackground: 'linear-gradient(145deg, rgba(69,94,113,0.86), rgba(126,139,148,0.62))', accent: '#e2e8f0', cloudOpacity: 0.74 },
    fog: { background: 'linear-gradient(180deg, #6e7270 0%, #90938e 45%, #b2b3aa 76%, #d2d1c6 100%)', cardBackground: 'linear-gradient(145deg, rgba(88,107,119,0.82), rgba(165,171,172,0.58))', accent: '#f1f5f9', cloudOpacity: 0.62 },
    drizzle: { background: 'linear-gradient(180deg, #2c566e 0%, #4f7d95 45%, #8ba9b6 78%, #b9cdd4 100%)', cardBackground: 'linear-gradient(145deg, rgba(37,86,113,0.88), rgba(90,122,136,0.66))', accent: '#a5f3fc', cloudOpacity: 0.74 },
    rain: { background: 'linear-gradient(180deg, #14344e 0%, #2e5670 45%, #5f7f8f 78%, #8ba3ab 100%)', cardBackground: 'linear-gradient(145deg, rgba(22,58,86,0.92), rgba(62,90,101,0.72))', accent: '#7dd3fc', cloudOpacity: 0.84 },
    'heavy-rain': { background: 'linear-gradient(180deg, #0c2338 0%, #1e3d52 48%, #415a68 80%, #68808b 100%)', cardBackground: 'linear-gradient(145deg, rgba(13,41,63,0.94), rgba(45,66,79,0.78))', accent: '#38bdf8', cloudOpacity: 0.92 },
    thunder: { background: 'linear-gradient(180deg, #2a1a3e 0%, #45285c 42%, #6e4a70 78%, #97788e 100%)', cardBackground: 'linear-gradient(145deg, rgba(52,32,74,0.94), rgba(96,72,104,0.78))', accent: '#c4b5fd', cloudOpacity: 0.95 },
    snow: { background: 'linear-gradient(180deg, #79828f 0%, #98a1ab 45%, #b9bfc6 78%, #dbdee0 100%)', cardBackground: 'linear-gradient(145deg, rgba(108,118,130,0.84), rgba(180,188,196,0.62))', accent: '#ffffff', cloudOpacity: 0.7 },
  }
  const nightThemes: Record<WeatherSceneKind, Omit<WeatherVisualTheme, 'kind' | 'isDay'>> = {
    clear: { background: 'linear-gradient(180deg, #020814 0%, #0a1d3d 42%, #173a66 72%, #2b5688 100%)', cardBackground: 'linear-gradient(145deg, rgba(8,28,60,0.92), rgba(38,62,98,0.68))', accent: '#e0e7ff', cloudOpacity: 0.06 },
    'partly-cloudy': { background: 'linear-gradient(180deg, #050d1d 0%, #12263f 45%, #29415c 74%, #435d75 100%)', cardBackground: 'linear-gradient(145deg, rgba(14,36,66,0.92), rgba(66,79,101,0.68))', accent: '#e2e8f0', cloudOpacity: 0.5 },
    cloudy: { background: 'linear-gradient(180deg, #070d16 0%, #18222f 45%, #2c3a49 76%, #46545f 100%)', cardBackground: 'linear-gradient(145deg, rgba(20,29,46,0.94), rgba(68,76,90,0.72))', accent: '#cbd5e1', cloudOpacity: 0.78 },
    fog: { background: 'linear-gradient(180deg, #0f1114 0%, #24272c 45%, #3d4147 76%, #5a5f64 100%)', cardBackground: 'linear-gradient(145deg, rgba(24,27,32,0.92), rgba(64,69,75,0.7))', accent: '#e2e8f0', cloudOpacity: 0.7 },
    drizzle: { background: 'linear-gradient(180deg, #040f1d 0%, #102941 45%, #254358 78%, #3f5a68 100%)', cardBackground: 'linear-gradient(145deg, rgba(8,28,48,0.96), rgba(44,66,79,0.76))', accent: '#7dd3fc', cloudOpacity: 0.82 },
    rain: { background: 'linear-gradient(180deg, #030a15 0%, #0c1f33 45%, #1e3648 78%, #34505f 100%)', cardBackground: 'linear-gradient(145deg, rgba(5,21,39,0.97), rgba(33,54,68,0.8))', accent: '#38bdf8', cloudOpacity: 0.9 },
    'heavy-rain': { background: 'linear-gradient(180deg, #02060d 0%, #081726 48%, #152836 80%, #29414e 100%)', cardBackground: 'linear-gradient(145deg, rgba(3,15,28,0.98), rgba(26,44,57,0.84))', accent: '#0ea5e9', cloudOpacity: 0.96 },
    thunder: { background: 'linear-gradient(180deg, #04030c 0%, #150c26 45%, #2c1a42 78%, #463059 100%)', cardBackground: 'linear-gradient(145deg, rgba(7,4,20,0.98), rgba(40,26,62,0.84))', accent: '#a78bfa', cloudOpacity: 0.98 },
    snow: { background: 'linear-gradient(180deg, #0f141c 0%, #202733 48%, #38414d 78%, #525c67 100%)', cardBackground: 'linear-gradient(145deg, rgba(18,24,32,0.94), rgba(58,66,76,0.72))', accent: '#f8fafc', cloudOpacity: 0.76 },
  }
  return { kind, isDay, ...(isDay ? dayThemes[kind] : nightThemes[kind]) }
}

/** 背景小 tips：月亮/太阳的真实方位提示（按用户地区实时计算） */
export function WeatherSkyTip({ skyBodies, isDay }: { skyBodies: SkyBodies; isDay: boolean }) {
  const body = isDay ? skyBodies.sun : skyBodies.moon
  if (!body.visible) return null
  const dir = azimuthDirection(body.azimuth)
  const text = isDay
    ? `太阳在${dir}方 · 高度 ${Math.round(body.altitude)}°`
    : `${skyBodies.phaseName} · 月亮在${dir}方 · 高度 ${Math.round(body.altitude)}°`
  return (
    <div className="pointer-events-none absolute left-7 top-7 z-10 flex items-center gap-2 rounded-full border border-white/12 bg-black/30 px-4 py-2 text-xs text-white/75 backdrop-blur-md">
      <span
        className="h-2 w-2 rounded-full"
        style={isDay
          ? { background: '#fcd34d', boxShadow: '0 0 8px rgba(252,211,77,0.9)' }
          : { background: '#e2e8f0', boxShadow: '0 0 8px rgba(226,232,255,0.9)' }}
      />
      {text}
    </div>
  )
}

export function WeatherAtmosphere({ theme, compact = false, skyBodies }: { theme: WeatherVisualTheme; compact?: boolean; skyBodies?: SkyBodies }) {
  const rainCount = compact ? 12 : theme.kind === 'heavy-rain' || theme.kind === 'thunder' ? 56 : 34
  const showsRain = isRainySceneKind(theme.kind)
  const showsClouds = theme.cloudOpacity > 0.2
  const showsSnow = theme.kind === 'snow'
  const showsStars = !theme.isDay && (theme.kind === 'clear' || theme.kind === 'partly-cloudy')
  const showsCelestial = theme.kind === 'clear' || theme.kind === 'partly-cloudy'
  // 全屏晴/多云用真实摄影天空；紧凑卡片仍用渐变（小尺寸下照片发闷）
  const useRealSky = !compact && showsCelestial
  // 雷暴闪电每次挂载随机化（参考 iOS 26：没有两道相同的闪电）
  const stormSeed = useMemo(() => ({
    glowDur: 6.2 + Math.random() * 2.6,
    flashDur: 5.6 + Math.random() * 3.2,
    b1Left: 12 + Math.random() * 22,
    b1Top: 14 + Math.random() * 12,
    b1Rot: 11 + Math.random() * 12,
    b1Dur: 6.2 + Math.random() * 2.6,
    b1Delay: -Math.random() * 7,
    b2Left: 52 + Math.random() * 30,
    b2Top: 8 + Math.random() * 14,
    b2Rot: -(7 + Math.random() * 12),
    b2Dur: 8.2 + Math.random() * 3.4,
    b2Delay: -Math.random() * 9,
  }), [theme.kind])

  return (
    <div aria-hidden="true" className={`pointer-events-none absolute inset-0 overflow-hidden weather-atmosphere weather-atmosphere-${theme.kind}`} style={{ background: compact ? theme.cardBackground : theme.background }}>
      {useRealSky && (
        <>
          <div className="weather-sky-motion" style={{ animationDuration: '137s' }}>
            <div className="weather-sky-motion-y" style={{ animationDuration: '197s' }}>
              <img src={theme.isDay ? skyDayUrl : skyNightUrl} alt="" className="weather-sky-motion-img" style={{ animationDuration: '89s' }} />
            </div>
          </div>
          <div
            className="absolute inset-0"
            style={{ background: theme.isDay
              ? 'linear-gradient(180deg, rgba(14,99,198,0.26), rgba(127,196,242,0.10) 48%, rgba(207,234,251,0.18))'
              : 'linear-gradient(180deg, rgba(2,8,20,0.44), rgba(8,20,44,0.14) 46%, rgba(3,11,26,0.52))' }}
          />
        </>
      )}
      {!theme.isDay && (
        <>
          {!compact && <div className="absolute -left-[12%] top-[8%] h-[44%] w-[118%] -rotate-[11deg] bg-[radial-gradient(ellipse,rgba(184,204,255,0.12),rgba(115,139,191,0.04)_42%,transparent_72%)] blur-3xl" />}
          {showsStars && !compact && !useRealSky && <div className="weather-milkyway" />}
          {Array.from({ length: compact ? 18 : useRealSky ? 26 : 86 }, (_, index) => {
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

      {showsCelestial && (() => {
        // 有天体实测位置时按真实方位摆放（在坐标由纬度/时间推算），否则用固定构图
        const body = theme.isDay ? skyBodies?.sun : skyBodies?.moon
        if (!compact && skyBodies && body && !body.visible) return null
        const dynamic = !compact && skyBodies && body?.visible
        const posStyle: React.CSSProperties = dynamic
          ? { left: `${body!.x}%`, top: `${body!.y}%`, transform: 'translate(-50%, -50%)' }
          : { right: compact ? '10%' : '8vw', top: compact ? '12%' : '6vh' }
        return (
          <div
            className={`absolute rounded-full ${theme.isDay ? 'weather-celestial' : ''}`}
            style={{
              ...posStyle,
              width: compact ? '74px' : 'min(32vw, 420px)',
              height: compact ? '74px' : 'min(32vw, 420px)',
            }}
          >
          <div className={`absolute inset-0 rounded-full ${theme.isDay ? '' : 'weather-moon-glow'}`} />
          {theme.isDay ? (
            <>
              {/* 真实感太阳眩光：亮核 + 柔和光晕 + 斜向薄云漫射光路（无放射线条） */}
              <div
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  width: '240%', height: '240%',
                  background: 'radial-gradient(circle, rgba(255,250,235,0.38) 0%, rgba(255,246,222,0.15) 22%, rgba(255,240,200,0.05) 40%, transparent 60%)',
                  mixBlendMode: 'screen',
                }}
              />
              <div
                className="absolute left-1/2 top-1/2 rounded-full"
                style={{
                  width: '460%', height: '170%',
                  transform: 'translate(-64%, -42%) rotate(-24deg)',
                  background: 'radial-gradient(ellipse at 68% 50%, rgba(255,250,232,0.3) 0%, rgba(255,248,225,0.1) 45%, transparent 70%)',
                  mixBlendMode: 'screen', filter: 'blur(22px)',
                }}
              />
              <div
                className="absolute left-1/2 top-1/2 rounded-full"
                style={{
                  width: '300%', height: '110%',
                  transform: 'translate(-70%, -30%) rotate(-18deg)',
                  background: 'radial-gradient(ellipse at 62% 50%, rgba(255,252,240,0.18) 0%, transparent 62%)',
                  mixBlendMode: 'screen', filter: 'blur(26px)',
                }}
              />
              <div
                className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full"
                style={{
                  width: '92%', height: '92%',
                  background: 'radial-gradient(circle, rgba(255,255,255,0.94) 0%, rgba(255,253,244,0.5) 12%, rgba(255,248,224,0.18) 28%, rgba(255,242,206,0.05) 44%, transparent 62%)',
                  mixBlendMode: 'screen',
                }}
              />
            </>
          ) : !compact ? (
            <img
              src={moonUrl}
              alt=""
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full object-cover"
              style={{ width: '46%', height: '46%', filter: 'brightness(1.08) contrast(1.05)' }}
            />
          ) : (
            <div
              className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full weather-moon-disc"
              style={{ width: '39px', height: '39px' }}
            >
              <i className="absolute inset-[7%] rounded-full weather-moon-surface" />
            </div>
          )}
          {!theme.isDay && !compact && <div className="weather-sea-reflection" />}
          </div>
        )
      })()}

      {theme.isDay && (theme.kind === 'clear' || theme.kind === 'partly-cloudy') && !compact && [0, 1, 2].map(index => (
        <i
          key={`cirrus-${index}`}
          className="weather-cirrus"
          style={{
            top: `${7 + index * 12}%`,
            left: `${-24 + index * 34}%`,
            width: `${52 + index * 9}%`,
            animationDelay: `${-index * 24}s`,
          }}
        />
      ))}

      {showsClouds && Array.from({ length: compact ? 3 : 10 }, (_, index) => {
        // 阴雨雾雷用暗色云，避免白色云团把夜色冲成灰白
        const darkCloud = theme.kind !== 'clear' && theme.kind !== 'partly-cloudy' && theme.kind !== 'snow'
        return (
          <i
            key={`cloud-${index}`}
            className={`absolute weather-cloud weather-cloud-layer-${index % 3}`}
            style={{
              left: `${-18 + ((index * 29) % 112)}%`,
              top: `${3 + ((index * 17) % 56)}%`,
              width: compact ? `${110 + index * 20}px` : `${280 + (index % 3) * 150}px`,
              height: compact ? `${42 + index * 5}px` : `${90 + (index % 3) * 34}px`,
              opacity: theme.cloudOpacity * (0.45 + (index % 3) * 0.18),
              animationDelay: `${-index * 2.1}s`,
              animationDuration: `${18 + (index % 4) * 5}s`,
              background: darkCloud ? (theme.isDay ? 'rgba(74,90,104,0.6)' : 'rgba(17,26,39,0.78)') : undefined,
              boxShadow: darkCloud ? '52px 0 58px rgba(13,20,32,0.34), -42px 8px 50px rgba(10,16,28,0.3)' : undefined,
            }}
          />
        )
      })}

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

      {showsSnow && Array.from({ length: compact ? 14 : 46 }, (_, index) => (
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
      {showsSnow && !compact && <div className="absolute inset-x-0 bottom-0 h-[26%] bg-[radial-gradient(ellipse_at_50%_120%,rgba(255,255,255,0.2),transparent_68%)] blur-xl" />}

      {theme.kind === 'fog' && (
        <>
          {!compact && <div className="weather-fog-wash" />}
          {Array.from({ length: compact ? 3 : 8 }, (_, index) => (
            <i key={`fog-${index}`} className="absolute left-[-15%] w-[130%] rounded-full bg-white/16 blur-2xl weather-fog-band" style={{ top: `${12 + index * 11}%`, height: compact ? '22px' : `${44 + (index % 3) * 18}px`, animationDelay: `${-index * 1.6}s`, animationDuration: `${12 + (index % 4) * 4}s` }} />
          ))}
        </>
      )}

      {theme.kind === 'thunder' && (
        <>
          <div className="absolute -left-[12%] top-[-18%] h-[66%] w-[78%] rounded-full bg-violet-200/20 blur-3xl weather-storm-glow" style={{ animationDuration: `${stormSeed.glowDur}s` }} />
          <div className="absolute inset-0 bg-violet-100 weather-lightning" style={{ animationDuration: `${stormSeed.flashDur}s` }} />
          <div
            className="absolute h-[46%] w-[2px] origin-top bg-gradient-to-b from-white via-violet-100 to-transparent opacity-0 weather-lightning-bolt"
            style={{ left: `${stormSeed.b1Left}%`, top: `${stormSeed.b1Top}%`, '--bolt-rot': `${stormSeed.b1Rot}deg`, animationDuration: `${stormSeed.b1Dur}s`, animationDelay: `${stormSeed.b1Delay}s` } as React.CSSProperties}
          />
          <div
            className="absolute h-[38%] w-[2px] origin-top bg-gradient-to-b from-white via-violet-100 to-transparent opacity-0 weather-lightning-bolt-b"
            style={{ left: `${stormSeed.b2Left}%`, top: `${stormSeed.b2Top}%`, '--bolt-rot': `${stormSeed.b2Rot}deg`, animationDuration: `${stormSeed.b2Dur}s`, animationDelay: `${stormSeed.b2Delay}s` } as React.CSSProperties}
          />
        </>
      )}
      {/* 全场景微光扫过（微微动态，无循环缝） */}
      {!compact && <div className="weather-ambient-sweep" />}
      <div className="absolute inset-0 bg-gradient-to-b from-white/[0.025] via-transparent to-slate-950/28" />
    </div>
  )
}

// 雨滴打在玻璃上的效果：canvas 绘制附着的液滴（高光+暗缘），滑落的雨滴拖出尾迹并
// 吞并路径上的液滴。由使用方渲染在内容层之上（pointer-events-none），密度按场景
// 类型与画布面积自适应；prefers-reduced-motion 时只画一帧静态液滴。
export function WeatherRainGlass({ kind, className = '' }: { kind: WeatherSceneKind; className?: string }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dense = kind === 'heavy-rain' || kind === 'thunder'
    const baseDrops = kind === 'drizzle' ? 26 : dense ? 78 : 48
    const baseSliders = kind === 'drizzle' ? 2 : dense ? 7 : 4
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const rand = (a: number, b: number) => a + Math.random() * (b - a)

    interface Drop { x: number; y: number; r: number }
    interface Slider { x: number; y: number; r: number; vy: number; trail: Drop[] }
    let width = 0
    let height = 0
    let drops: Drop[] = []
    let sliders: Slider[] = []
    let raf = 0
    let last = performance.now()
    let acc = 0

    // 液滴精灵：一次绘制，运行时只做 drawImage 缩放，避免逐帧建渐变
    const sprite = document.createElement('canvas')
    sprite.width = sprite.height = 64
    const sctx = sprite.getContext('2d')
    if (sctx) {
      const g = sctx.createRadialGradient(24, 22, 2, 32, 34, 26)
      g.addColorStop(0, 'rgba(255,255,255,0.34)')
      g.addColorStop(0.42, 'rgba(214,232,252,0.12)')
      g.addColorStop(0.82, 'rgba(168,196,228,0.05)')
      g.addColorStop(1, 'rgba(150,182,216,0)')
      sctx.fillStyle = g
      sctx.beginPath()
      sctx.ellipse(32, 34, 26, 30, 0, 0, Math.PI * 2)
      sctx.fill()
      sctx.strokeStyle = 'rgba(255,255,255,0.2)'
      sctx.lineWidth = 1.4
      sctx.beginPath()
      sctx.ellipse(32, 34, 25, 29, 0, 0, Math.PI * 2)
      sctx.stroke()
      sctx.fillStyle = 'rgba(255,255,255,0.5)'
      sctx.beginPath()
      sctx.ellipse(24, 24, 4.2, 3, -0.6, 0, Math.PI * 2)
      sctx.fill()
    }

    const spawnDrop = (): Drop => ({ x: rand(0, width), y: rand(0, height), r: kind === 'drizzle' ? rand(1.2, 2.6) : rand(1.4, 4.8) })
    const spawnSlider = (anywhere = false): Slider => ({ x: rand(0, width), y: anywhere ? rand(0, height) : rand(-60, -10), r: rand(2.4, 5.4), vy: rand(16, 46), trail: [] })

    const resize = () => {
      const rect = canvas.getBoundingClientRect()
      width = Math.max(1, rect.width)
      height = Math.max(1, rect.height)
      canvas.width = Math.round(width * dpr)
      canvas.height = Math.round(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      const scale = Math.min(1.6, Math.max(0.5, (width * height) / (1280 * 720)))
      const count = Math.round(baseDrops * scale)
      drops = Array.from({ length: count }, spawnDrop)
      sliders = Array.from({ length: Math.round(baseSliders * scale) }, () => spawnSlider(true))
    }

    const drawDrop = (x: number, y: number, r: number, alpha: number) => {
      ctx.globalAlpha = alpha
      ctx.drawImage(sprite, x - r, y - r, r * 2, r * 2)
    }

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      acc += now - last
      last = now
      if (acc < 33) return
      acc = 0
      ctx.clearRect(0, 0, width, height)
      for (const d of drops) drawDrop(d.x, d.y, d.r, 0.9)
      for (const s of sliders) {
        s.y += s.vy * 0.033
        s.vy = Math.min(96, s.vy + 26 * 0.033)
        s.x += Math.sin((s.y + s.r * 9) * 0.02) * 0.35
        s.trail.push({ x: s.x, y: s.y, r: s.r * 0.7 })
        if (s.trail.length > 13) s.trail.shift()
        s.trail.forEach((p, i) => drawDrop(p.x, p.y, p.r * (0.4 + (0.6 * i) / s.trail.length), 0.42))
        drawDrop(s.x, s.y, s.r, 1)
        const hit = (d: Drop) => { const dx = d.x - s.x; const dy = d.y - s.y; const rad = d.r + s.r; return dx * dx + dy * dy < rad * rad }
        drops = drops.filter(d => !hit(d))
        if (s.y > height + 24) Object.assign(s, spawnSlider())
        if (drops.length < baseDrops * 0.6) drops.push(spawnDrop())
      }
    }

    resize()
    if (reduced) {
      ctx.clearRect(0, 0, width, height)
      for (const d of drops) drawDrop(d.x, d.y, d.r, 0.9)
    } else {
      raf = requestAnimationFrame(tick)
    }
    const observer = new ResizeObserver(() => {
      resize()
      if (reduced) {
        ctx.clearRect(0, 0, width, height)
        for (const d of drops) drawDrop(d.x, d.y, d.r, 0.9)
      }
    })
    observer.observe(canvas)
    return () => {
      cancelAnimationFrame(raf)
      observer.disconnect()
    }
  }, [kind])

  return <canvas ref={canvasRef} aria-hidden="true" className={`pointer-events-none h-full w-full ${className}`} />
}
