/**
 * 拆分 country-state-city 城市数据（按国家/地区）为独立 JSON 文件
 *
 * 背景：country-state-city 的 city.json（约 148k 城市，约 7.9MB）整体打进 bundle 会让
 * vite build 出现 8MB+ 的巨型 chunk。本脚本将其按 countryCode 拆分为 `src/generated/city-data/<code>.json`，
 * 配合 `locationHierarchy.ts` 里的 `import.meta.glob` 按国家懒加载，使单个 chunk 控制在 3MB 以内。
 *
 * 生成时机：vite.config.ts 中的 `split-city-data` 插件会在 build/dev 启动前自动调用；
 * 也可手动运行：`node scripts/split-city-data.mjs`
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')

const CITY_SOURCE = join(projectRoot, 'node_modules/country-state-city/lib/assets/city.json')
const OUT_DIR = join(projectRoot, 'src', 'generated', 'city-data')

/**
 * 拆分 city.json 到 src/generated/city-data/<countryCode>.json
 * 返回生成的文件数；数据缺失（依赖未安装）时返回 0，不抛错。
 */
export function splitCityData() {
  if (!existsSync(CITY_SOURCE)) {
    console.warn('[split-city-data] 未找到 city.json，跳过拆分（请先 npm install）')
    return 0
  }

  const raw = JSON.parse(readFileSync(CITY_SOURCE, 'utf8'))
  if (!Array.isArray(raw) || raw.length === 0) {
    console.warn('[split-city-data] city.json 格式异常，跳过拆分')
    return 0
  }

  // 按国家分组；同时把 package 里的 [name, countryCode, stateCode, lat, lng] 转为对象，
  // 省去 countryCode 字段（由文件名隐含）
  const byCountry = new Map()
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 5) continue
    const [name, countryCode, stateCode, latitude, longitude] = entry
    if (!countryCode || !stateCode) continue
    let list = byCountry.get(countryCode)
    if (!list) {
      list = []
      byCountry.set(countryCode, list)
    }
    list.push({ name, stateCode, latitude, longitude })
  }

  if (byCountry.size === 0) {
    console.warn('[split-city-data] 未解析到任何城市数据，跳过拆分')
    return 0
  }

  // 清理旧文件，避免数据更新后残留过期国家
  mkdirSync(OUT_DIR, { recursive: true })
  for (const file of readdirSync(OUT_DIR)) {
    if (file.endsWith('.json')) rmSync(join(OUT_DIR, file), { force: true })
  }

  let count = 0
  for (const [countryCode, list] of byCountry) {
    writeFileSync(join(OUT_DIR, `${countryCode}.json`), JSON.stringify(list), 'utf8')
    count += 1
  }

  console.log(`[split-city-data] 已拆分 ${count} 个国家/地区的城市数据 -> ${OUT_DIR}`)
  return count
}

// 直接运行（node scripts/split-city-data.mjs）时执行拆分
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`) {
  splitCityData()
}
