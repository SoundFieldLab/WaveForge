// 月相与月球位置的低阶天文近似（Meeus 截断式），展示精度足够（相位分钟级、月出月落 ±15 分钟）。

const SYNODIC = 29.530588853 // 朔望月（天）
const ReferenceNewMoonJD = 2451550.26 // 2000-01-06 18:14 UTC 新月

export interface MoonInfo {
  /** 月相 0-1：0 新月，0.5 满月 */
  phase: number
  /** 照亮比 0-1 */
  illumination: number
  /** 月龄（天） */
  ageDays: number
  /** 是否盈月（新月→满月） */
  waxing: boolean
  /** 距下次满月（天） */
  nextFullMoonDays: number
  /** 地心距离（km，近似） */
  distanceKm: number
  /** 相位中文名 */
  phaseName: string
}

const toJD = (date: Date) => date.getTime() / 86400000 + 2440587.5

export function moonPhaseAt(date: Date): number {
  const days = toJD(date) - ReferenceNewMoonJD
  return (((days / SYNODIC) % 1) + 1) % 1
}

export function moonIllumination(phase: number): number {
  return (1 - Math.cos(2 * Math.PI * phase)) / 2
}

export function moonPhaseName(phase: number): string {
  if (phase < 0.02 || phase >= 0.98) return '新月'
  if (phase < 0.23) return '娥眉月'
  if (phase < 0.27) return '上弦月'
  if (phase < 0.48) return '盈凸月'
  if (phase <= 0.52) return '满月'
  if (phase < 0.73) return '亏凸月'
  if (phase < 0.77) return '下弦月'
  return '残月'
}

export function moonInfoAt(date: Date): MoonInfo {
  const phase = moonPhaseAt(date)
  const ageDays = phase * SYNODIC
  // 平近点角 → 地心距离（截断式）
  const d = toJD(date) - 2451545.0
  const meanAnomaly = (2 * Math.PI * (((d / SYNODIC) % 1) + 1)) % (2 * Math.PI)
  const distanceKm = Math.round(385001 - 20905 * Math.cos(meanAnomaly))
  return {
    phase,
    illumination: moonIllumination(phase),
    ageDays,
    waxing: phase < 0.5,
    nextFullMoonDays: (((0.5 - phase) % 1) + 1) % 1 * SYNODIC,
    distanceKm,
    phaseName: moonPhaseName(phase),
  }
}

// —— 月出月落（近似） ——

const RAD = Math.PI / 180

/** 月球赤经赤纬（低阶截断式），jd 为儒略日 */
function moonEquatorial(jd: number): { ra: number; dec: number; parallax: number } {
  const d = jd - 2451545.0
  const L = (218.316 + 13.176396 * d) * RAD
  const M = (134.963 + 13.064993 * d) * RAD
  const F = (93.272 + 13.22935 * d) * RAD
  const lambda = L + 6.289 * RAD * Math.sin(M)
  const beta = 5.128 * RAD * Math.sin(F)
  const eps = 23.4393 * RAD
  const sinLambda = Math.sin(lambda)
  const cosLambda = Math.cos(lambda)
  const sinBeta = Math.sin(beta)
  const cosBeta = Math.cos(beta)
  const sinEps = Math.sin(eps)
  const cosEps = Math.cos(eps)
  const ra = Math.atan2(sinLambda * cosEps - (sinBeta / cosBeta) * sinEps, cosLambda)
  const dec = Math.asin(sinBeta * cosEps + cosBeta * sinEps * sinLambda)
  const distanceKm = 385001 - 20905 * Math.cos(M)
  const parallax = Math.asin(6378.14 / distanceKm) // 赤道地平视差
  return { ra: ((ra / (2 * Math.PI)) % 1 + 1) % 1, dec: dec / RAD, parallax: parallax / RAD }
}

function gmst(jd: number): number {
  return ((280.46061837 + 360.98564736629 * (jd - 2451545.0)) % 360 + 360) % 360
}

/** 月亮地平高度（度） */
function moonAltitude(jd: number, latDeg: number, lonDeg: number): number {
  const { ra, dec, parallax } = moonEquatorial(jd)
  const lst = (gmst(jd) + lonDeg) * RAD
  const H = lst - ra * 2 * Math.PI
  const lat = latDeg * RAD
  const decRad = dec * RAD
  const sinAlt = Math.sin(lat) * Math.sin(decRad) + Math.cos(lat) * Math.cos(decRad) * Math.cos(H)
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt))) / RAD
  // 视差修正（把地心高度化为地面高度）+ 大气折射近似
  return alt - parallax * Math.cos(alt * RAD) - 0.583
}

/** 求某地某天（UTC 日界内）的月出/月落，找不到事件返回 null */
function findMoonEvent(jd0: number, lat: number, lon: number, rising: boolean): number | null {
  const step = 0.125 // 3 小时粗扫
  let prevT: number | null = null
  let prevAlt: number | null = null
  for (let t = 0; t <= 24.0001; t += step) {
    const jd = jd0 + t / 24
    const alt = moonAltitude(jd, lat, lon)
    if (prevAlt !== null && prevT !== null) {
      const crossed = rising ? prevAlt < 0 && alt >= 0 : prevAlt > 0 && alt <= 0
      if (crossed) {
        // 二分细化到 1 分钟
        let a = prevT
        let b = jd
        for (let i = 0; i < 18; i++) {
          const mid = (a + b) / 2
          const midAlt = moonAltitude(mid, lat, lon)
          if (rising ? midAlt < 0 : midAlt > 0) a = mid
          else b = mid
        }
        return (a + b) / 2
      }
    }
    prevT = jd
    prevAlt = alt
  }
  return null
}

export interface MoonRiseSet {
  /** 本地时区 "HH:mm"，null 表示该日无此事件 */
  rise: string | null
  set: string | null
}

/** 取当地"今天"的月出月落（以本地 0 点为界往前凑 25 小时窗口，容忍跨日） */
export function moonRiseSet(date: Date, lat: number, lon: number): MoonRiseSet {
  const local = new Date(date)
  local.setHours(0, 0, 0, 0)
  const jd0 = toJD(local)
  const fmt = (jd: number | null): string | null => {
    if (jd === null) return null
    const d = new Date((jd - 2440587.5) * 86400000)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  let rise = findMoonEvent(jd0, lat, lon, true)
  let set = findMoonEvent(jd0, lat, lon, false)
  // 窗口内没找到时，顺延一天找下一次（月出月落平均每天推迟约 50 分钟）
  if (rise === null) rise = findMoonEvent(jd0 + 1, lat, lon, true)
  if (set === null) set = findMoonEvent(jd0 + 1, lat, lon, false)
  return { rise: fmt(rise), set: fmt(set) }
}

/** 距离下次满月还有几天（向上取整显示） */
export function daysToFullMoon(date: Date): number {
  return Math.max(1, Math.ceil(moonInfoAt(date).nextFullMoonDays))
}

// —— 太阳/月亮实时方位（方位角 0-360 罗盘方位，高度角 -90~90） ——

function altAz(jd: number, raTurns: number, decDeg: number, latDeg: number, lonDeg: number): { altitude: number; azimuth: number } {
  const lst = (gmst(jd) + lonDeg) * RAD
  const H = lst - raTurns * 2 * Math.PI
  const lat = latDeg * RAD
  const dec = decDeg * RAD
  const sinAlt = Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H)
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)))
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat))
  const azimuth = (az + Math.PI) % (2 * Math.PI)
  return { altitude: alt / RAD, azimuth: ((azimuth / RAD) % 360 + 360) % 360 }
}

export interface SkyPosition { altitude: number; azimuth: number; visible: boolean }

/** 太阳实时位置（低阶星历） */
export function sunSkyPosition(date: Date, lat: number, lon: number): SkyPosition {
  const jd = toJD(date)
  const n = jd - 2451545.0
  const meanLon = (280.46 + 0.9856474 * n) * RAD
  const meanAnom = (357.528 + 0.9856003 * n) * RAD
  const eclipticLon = meanLon + 1.915 * RAD * Math.sin(meanAnom) + 0.02 * RAD * Math.sin(2 * meanAnom)
  const eps = 23.439 * RAD
  const ra = Math.atan2(Math.cos(eps) * Math.sin(eclipticLon), Math.cos(eclipticLon)) / (2 * Math.PI)
  const dec = Math.asin(Math.sin(eps) * Math.sin(eclipticLon)) / RAD
  const { altitude, azimuth } = altAz(jd, ((ra % 1) + 1) % 1, dec, lat, lon)
  return { altitude, azimuth, visible: altitude > -3 }
}

/** 月亮实时位置 */
export function moonSkyPosition(date: Date, lat: number, lon: number): SkyPosition {
  const jd = toJD(date)
  const { ra, dec } = moonEquatorial(jd)
  const { altitude, azimuth } = altAz(jd, ra, dec, lat, lon)
  return { altitude, azimuth, visible: altitude > -3 }
}

/** 方位角 → 中文八方位 */
export function azimuthDirection(azimuth: number): string {
  const dirs = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']
  return dirs[Math.round((((azimuth % 360) + 360) % 360) / 45) % 8]
}

export interface SkyScreenPos { x: number; y: number; visible: boolean; altitude: number; azimuth: number }

/** 天体位置 → 背景屏幕坐标：高度角映射纵向，方位角相对正南折叠后映射横向 */
export function skyScreenPos(pos: SkyPosition): SkyScreenPos {
  let rel = ((pos.azimuth - 180 + 540) % 360) - 180
  if (rel > 90) rel -= 180
  if (rel < -90) rel += 180
  const x = 50 + (rel / 90) * 38
  const y = 86 - (Math.max(0, Math.min(70, pos.altitude)) / 70) * 74
  return { x, y, visible: pos.visible, altitude: pos.altitude, azimuth: pos.azimuth }
}

export interface SkyBodies {
  sun: SkyScreenPos
  moon: SkyScreenPos
  phaseName: string
  waxing: boolean
}

export function computeSkyBodies(date: Date, lat: number, lon: number): SkyBodies {
  const info = moonInfoAt(date)
  return {
    sun: skyScreenPos(sunSkyPosition(date, lat, lon)),
    moon: skyScreenPos(moonSkyPosition(date, lat, lon)),
    phaseName: info.phaseName,
    waxing: info.waxing,
  }
}
