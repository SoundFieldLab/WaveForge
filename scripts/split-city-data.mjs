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
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectRoot = resolve(__dirname, '..')

const CITY_SOURCE = join(projectRoot, 'node_modules/country-state-city/lib/assets/city.json')
const OUT_DIR = join(projectRoot, 'src', 'generated', 'city-data')
const STAMP_FILE = join(OUT_DIR, '.stamp.json')

/**
 * 拆分 city.json 到 src/generated/city-data/<countryCode>.json
 * 返回生成的文件数；数据缺失（依赖未安装）时返回 0，不抛错。
 *
 * 增量：源数据 sha1 与 .stamp.json 一致且 .json 文件数吻合 → 跳过重建。
 * （此前每次 vite 启动都全量删+重写 ~150 个文件：既慢又触发 safe-delete 批量护栏。）
 */
export function splitCityData() {
  if (!existsSync(CITY_SOURCE)) {
    console.warn('[split-city-data] 未找到 city.json，跳过拆分（请先 npm install）')
    return 0
  }

  const sourceBuf = readFileSync(CITY_SOURCE)
  const fingerprint = createHash('sha1').update(sourceBuf).digest('hex')

  if (existsSync(STAMP_FILE)) {
    try {
      const stamp = JSON.parse(readFileSync(STAMP_FILE, 'utf8'))
      // ⚠️ 排除戳自身（.stamp.json 也以 .json 结尾，计入会导致恒失配 → 每次全量重建）
      const jsonCount = readdirSync(OUT_DIR).filter((f) => f.endsWith('.json') && f !== '.stamp.json').length
      if (stamp.fingerprint === fingerprint && stamp.count === jsonCount) {
        return stamp.count
      }
    } catch {
      // 戳损坏 → 走全量重建
    }
  }

  const raw = JSON.parse(sourceBuf.toString('utf8'))
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

  writeFileSync(STAMP_FILE, JSON.stringify({ fingerprint, count }), 'utf8')
  console.log(`[split-city-data] 已拆分 ${count} 个国家/地区的城市数据 -> ${OUT_DIR}`)
  return count
}

// 直接运行（node scripts/split-city-data.mjs）时执行拆分。
// ⚠️ Windows 下 argv[1] 拼 file:// 会少一个斜杠（file://C:/ vs file:///C:/）恒不匹配
// → 静默退出（曾致「直跑重建零输出零产物」），必须用 pathToFileURL 规范化比较。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  splitCityData()
}
