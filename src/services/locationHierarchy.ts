/**
 * 行政区划数据服务（懒加载优化）
 *
 * 数据来源：
 * - country-state-city：全球国家 / 州省 / 城市数据。城市数据（city.json 约 148k 条 / 7.9MB）
 *   会在 `npm run build` 时被 scripts/split-city-data.mjs 按国家/地区拆分为
 *   `src/generated/city-data/<code>.json`，这里通过 `import.meta.glob` 按国家懒加载，
 *   避免打包出 8MB+ 巨型 chunk。仅在选择非中国地区的省/州时才动态加载对应国家的数据。
 * - china-area-data：中国省市区数据（约 637KB），全国省市县在本地轻量读取。
 */
import Country from 'country-state-city/lib/country'
import State from 'country-state-city/lib/state'
import chinaAreaData from 'china-area-data'

export interface LocationOption {
  code: string
  name: string
}

type ChinaAreaMap = Record<string, Record<string, string>>

const chinaAreas = chinaAreaData as ChinaAreaMap
const countryNames = typeof Intl.DisplayNames === 'function'
  ? new Intl.DisplayNames(['zh-CN'], { type: 'region' })
  : null

const sortByName = (items: LocationOption[]) =>
  items.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

export const getCountries = (): LocationOption[] => {
  const countries = Country.getAllCountries().map(country => ({
    code: country.isoCode,
    name: countryNames?.of(country.isoCode) || country.name,
  }))

  return sortByName(countries)
}

export const getProvinces = (countryCode: string): LocationOption[] => {
  if (countryCode === 'CN') {
    return Object.entries(chinaAreas['86'] || {}).map(([code, name]) => ({ code, name }))
  }

  return sortByName(State.getStatesOfCountry(countryCode).map(state => ({
    code: state.isoCode,
    name: state.name,
  })))
}

// 城市数据懒加载：由 scripts/split-city-data.mjs 拆分为按国家/地区的 JSON 文件，
// 每个文件都是一个独立 chunk（最大约 2MB，美国），仅在用户选择非中国地区的省/州时加载。
interface CityEntry {
  name: string
  stateCode: string
  latitude: string
  longitude: string
}

const cityDataModules = import.meta.glob<CityEntry[]>('../generated/city-data/*.json')

export const getCities = async (
  countryCode: string,
  provinceCode: string,
): Promise<LocationOption[]> => {
  if (!provinceCode) return []
  if (countryCode === 'CN') {
    return Object.entries(chinaAreas[provinceCode] || {}).map(([code, name]) => ({ code, name }))
  }

  const loader = cityDataModules[`../generated/city-data/${countryCode}.json`]
  if (!loader) return []
  const cities = await loader()
  return sortByName(cities
    .filter(city => city.stateCode === provinceCode)
    .map(city => ({
      code: `${city.name}|${city.latitude || ''}|${city.longitude || ''}`,
      name: city.name,
    })))
}

export const getDistricts = (
  countryCode: string,
  _provinceCode: string,
  cityCode: string,
): LocationOption[] => {
  if (!cityCode || countryCode !== 'CN') return []
  return Object.entries(chinaAreas[cityCode] || {}).map(([code, name]) => ({ code, name }))
}
