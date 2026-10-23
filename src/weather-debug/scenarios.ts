import type { WeatherSnapshot } from '../services/weatherService'

export const WEATHER_DEBUG_SCENARIOS = [
  { id: 'clear', label: '晴朗', code: 0 },
  { id: 'partly-cloudy', label: '局部多云', code: 2 },
  { id: 'cloudy', label: '阴天', code: 3 },
  { id: 'fog', label: '雾', code: 45 },
  { id: 'drizzle', label: '毛毛雨', code: 51 },
  { id: 'rain', label: '小雨 / 中雨', code: 63 },
  { id: 'heavy-rain', label: '暴雨', code: 65 },
  { id: 'thunder', label: '雷暴', code: 95 },
  { id: 'snow', label: '中雪', code: 73 },
] as const

export type WeatherDebugScenarioId = typeof WEATHER_DEBUG_SCENARIOS[number]['id']
export type WeatherDebugScenario = typeof WEATHER_DEBUG_SCENARIOS[number]

const scenarioById = Object.fromEntries(WEATHER_DEBUG_SCENARIOS.map(scenario => [scenario.id, scenario])) as Record<WeatherDebugScenarioId, WeatherDebugScenario>

const pad = (value: number) => String(value).padStart(2, '0')
const addHours = (baseHour: number, offset: number) => {
  const date = new Date(Date.UTC(2026, 8, 5, baseHour + offset, 0, 0))
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(date.getUTCHours())}:00`
}

const intensityFor = (scenario: WeatherDebugScenarioId) => {
  switch (scenario) {
    case 'fog': return { precipitation: 0, probability: 0, snowfall: 0, cloud: 95, wind: 4, visibility: 700 }
    case 'drizzle': return { precipitation: 0.25, probability: 45, snowfall: 0, cloud: 86, wind: 8, visibility: 7000 }
    case 'rain': return { precipitation: 1.1, probability: 72, snowfall: 0, cloud: 92, wind: 15, visibility: 5000 }
    case 'heavy-rain': return { precipitation: 6.5, probability: 96, snowfall: 0, cloud: 99, wind: 28, visibility: 2200 }
    case 'thunder': return { precipitation: 9.4, probability: 98, snowfall: 0, cloud: 100, wind: 38, visibility: 1800 }
    case 'snow': return { precipitation: 1.2, probability: 80, snowfall: 1.8, cloud: 94, wind: 18, visibility: 3500 }
    case 'cloudy': return { precipitation: 0, probability: 12, snowfall: 0, cloud: 84, wind: 11, visibility: 11000 }
    case 'partly-cloudy': return { precipitation: 0, probability: 5, snowfall: 0, cloud: 48, wind: 9, visibility: 16000 }
    default: return { precipitation: 0, probability: 0, snowfall: 0, cloud: 8, wind: 7, visibility: 19000 }
  }
}

export function createWeatherDebugSnapshot(scenarioId: WeatherDebugScenarioId, isDay: boolean): WeatherSnapshot {
  const scenario = scenarioById[scenarioId]
  const intensity = intensityFor(scenarioId)
  const baseHour = isDay ? 12 : 22
  const currentTime = addHours(baseHour, 0)
  const baseTemperature = scenarioId === 'snow' ? -2 : scenarioId === 'thunder' ? 26 : scenarioId === 'fog' ? 16 : 24
  const hourly = Array.from({ length: 25 }, (_, index) => {
    const weatherCode = index > 14 && scenarioId === 'clear' ? 2 : scenario.code
    const variation = Math.sin(index / 3) * (scenarioId === 'snow' ? 1.2 : 2.4)
    return {
      time: addHours(baseHour, index),
      temperature: Number((baseTemperature + variation).toFixed(1)),
      apparentTemperature: Number((baseTemperature + variation + (intensity.wind > 24 ? -1.5 : 1)).toFixed(1)),
      precipitationProbability: Math.max(0, Math.min(100, intensity.probability - Math.max(0, index - 8) * 3)),
      precipitation: Number(Math.max(0, intensity.precipitation * (0.78 + Math.sin(index * 0.7) * 0.22)).toFixed(1)),
      snowfall: Number(Math.max(0, intensity.snowfall * (0.72 + Math.cos(index * 0.6) * 0.28)).toFixed(1)),
      weatherCode,
      windSpeed: Math.max(0, Math.round(intensity.wind + Math.sin(index * 0.5) * 4)),
      windGusts: Math.max(0, Math.round(intensity.wind * 1.45 + Math.cos(index * 0.4) * 6)),
      visibility: Math.max(300, Math.round(intensity.visibility * (0.86 + Math.sin(index * 0.3) * 0.12))),
      uvIndex: isDay ? Math.max(0, Number((5.8 * Math.sin(Math.max(0, Math.min(1, index / 12)) * Math.PI)).toFixed(1))) : 0,
      humidity: Math.min(100, Math.round(50 + intensity.cloud * 0.45 + Math.sin(index) * 5)),
      pressure: Math.round(1014 - intensity.precipitation * 0.7 + Math.sin(index * 0.4) * 3),
      dewPoint: Math.round(baseTemperature - (scenarioId === 'snow' ? 2 : 4)),
      cloudCover: Math.min(100, Math.max(0, Math.round(intensity.cloud + Math.sin(index * 0.35) * 8))),
      // 扩展字段（WeatherHour 必填）：调试场景用稳定的派生值填充，保证快照形状与真实接口一致
      windDirection: (index * 15) % 360,
      snowDepth: scenarioId === 'snow' ? Number((0.05 + index * 0.012).toFixed(3)) : 0,
      freezingLevel: scenarioId === 'snow' ? 400 : 3200 + index * 40,
      cape: scenarioId === 'thunder' ? 1200 + index * 55 : Math.round(intensity.precipitation * 30),
      shortwaveRadiation: isDay ? Math.max(0, Math.round(760 * Math.sin(Math.max(0, Math.min(1, index / 12)) * Math.PI))) : 0,
      cloudCoverLow: Math.min(100, Math.round(intensity.cloud * 0.7)),
      cloudCoverMid: Math.min(100, Math.round(intensity.cloud * 0.5)),
      cloudCoverHigh: Math.min(100, Math.round(intensity.cloud * 0.3)),
      windSpeed80m: Number((intensity.wind * 1.6 + Math.sin(index * 0.5) * 3).toFixed(1)),
      uvIndexClearSky: isDay ? Math.max(0, Number((7.2 * Math.sin(Math.max(0, Math.min(1, index / 12)) * Math.PI)).toFixed(1))) : 0,
    }
  })
  const daily = Array.from({ length: 10 }, (_, index) => {
    const date = new Date(Date.UTC(2026, 8, 5 + index))
    const dateText = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    return {
      date: dateText,
      weatherCode: index > 2 && scenarioId !== 'snow' ? 2 : scenario.code,
      temperatureMax: Math.round(baseTemperature + (scenarioId === 'snow' ? 2 : 4) + Math.sin(index) * 2),
      temperatureMin: Math.round(baseTemperature - (scenarioId === 'snow' ? 5 : 4) + Math.cos(index) * 2),
      apparentTemperatureMax: Math.round(baseTemperature + 5),
      apparentTemperatureMin: Math.round(baseTemperature - 4),
      precipitationProbability: Math.max(0, Math.min(100, intensity.probability - index * 5)),
      precipitationSum: Number(Math.max(0, intensity.precipitation * (1.4 - index * 0.1)).toFixed(1)),
      windSpeedMax: Math.round(intensity.wind * 1.35),
      windGustsMax: Math.round(intensity.wind * 1.65),
      uvIndexMax: isDay ? Math.round(6 - index * 0.3) : 0,
      sunrise: `${dateText}T05:28`,
      sunset: `${dateText}T18:22`,
      // 扩展字段（WeatherDay 必填）：调试场景用稳定的派生值填充
      rainSum: Number((intensity.precipitation * (1.4 - index * 0.1)).toFixed(1)),
      showersSum: Number((intensity.precipitation * 0.35).toFixed(1)),
      snowfallSum: scenarioId === 'snow' ? Number((intensity.snowfall * (1.4 - index * 0.1)).toFixed(1)) : 0,
      precipitationHours: intensity.precipitation > 0 ? Math.max(1, Math.round(intensity.precipitation * 1.5)) : 0,
      windDirectionDominant: (index * 30 + 135) % 360,
      uvIndexClearSkyMax: isDay ? Math.round(7 - index * 0.3) : 0,
    }
  })

  return {
    location: {
      name: '浦东新区', province: '上海', city: '上海', district: '浦东新区', region: '华东', country: '中国',
      formattedAddress: '中国 上海市 浦东新区', latitude: 31.2304, longitude: 121.4737, source: 'manual',
    },
    timezone: 'Asia/Shanghai',
    current: {
      time: currentTime,
      temperature: baseTemperature,
      apparentTemperature: baseTemperature + (intensity.wind > 25 ? -1 : 1),
      humidity: Math.min(100, Math.round(52 + intensity.cloud * 0.45)),
      weatherCode: scenario.code,
      isDay,
      windSpeed: intensity.wind,
      windDirection: scenarioId === 'thunder' ? 135 : 210,
      windGusts: Math.round(intensity.wind * 1.5),
      pressure: Math.round(1014 - intensity.precipitation * 0.8),
      visibility: intensity.visibility,
      precipitation: intensity.precipitation,
      cloudCover: intensity.cloud,
    },
    hourly,
    daily,
    alerts: [],
    airQuality: null,
    updatedAt: Date.now(),
  }
}

export const getWeatherDebugScenario = (id: WeatherDebugScenarioId) => scenarioById[id]
