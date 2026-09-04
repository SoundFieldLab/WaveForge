import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputPath = path.join(root, 'src', 'data', 'afdianSponsors.generated.json')
const configuredEnvPath = String(process.env.WAVEFORGE_AFDIAN_ENV || '').trim()
const developerConfigDir = process.env.APPDATA
  ? path.join(process.env.APPDATA, 'WaveForge Developer')
  : path.join(os.homedir(), '.waveforge-developer')
const externalEnvCandidates = [
  configuredEnvPath ? path.resolve(configuredEnvPath) : null,
  path.resolve(root, '..', 'WaveForge-Afdian.env'),
  path.join(developerConfigDir, 'WaveForge-Afdian.env'),
].filter(Boolean)
const externalEnvPath = externalEnvCandidates.find(candidate => fs.existsSync(candidate))
const optional = process.argv.includes('--optional')

function loadExternalEnv(filePath) {
  if (!fs.existsSync(filePath)) return
  const contents = fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '')
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (!process.env[key]) process.env[key] = value
  }
}

if (externalEnvPath) loadExternalEnv(externalEnvPath)
const userId = process.env.AFDIAN_USER_ID || '8813900a1cd511ea87be52540025c377'
const token = String(process.env.AFDIAN_TOKEN || '').trim()
const endpoint = 'https://afdian.net/api/open/query-sponsor'
const qualifyingPrices = new Set(['50.00', '88.88'])
const qualifyingPlanIds = new Set([
  '4f729182c35711eab20e52540025c377',
  'd34a3d9e919511f1b8cd52540025c377',
])

function writeEmptyIfMissing() {
  if (fs.existsSync(outputPath)) return
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  fs.writeFileSync(outputPath, JSON.stringify({ syncedAt: null, source: 'afdian-open-api', supporters: [] }, null, 2) + '\n', 'utf8')
}

if (!token) {
  writeEmptyIfMissing()
  if (optional) {
    console.log('未设置 AFDIAN_TOKEN，保留现有赞助名单。')
    process.exit(0)
  }
  console.error('缺少 AFDIAN_TOKEN。请在爱发电开发者后台创建开放 API Token 后，以环境变量传入。')
  process.exit(1)
}

function signedBody(page) {
  const params = JSON.stringify({ page })
  const ts = Math.floor(Date.now() / 1000)
  const sign = crypto.createHash('md5').update(`${token}params${params}ts${ts}user_id${userId}`).digest('hex')
  return { user_id: userId, params, ts, sign }
}

async function queryPage(page) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(signedBody(page)),
  })
  if (!response.ok) throw new Error(`爱发电开放 API 返回 HTTP ${response.status}`)
  const result = await response.json()
  if (result.ec !== 200) throw new Error(`爱发电开放 API 错误 ${result.ec}: ${result.em || '未知错误'}`)
  return result.data
}

const first = await queryPage(1)
const pages = [first]
for (let page = 2; page <= Number(first.total_page || 1); page += 1) pages.push(await queryPage(page))

const supporters = pages
  .flatMap(page => Array.isArray(page.list) ? page.list : [])
  .filter(sponsor => {
    const plans = [sponsor.current_plan, ...(Array.isArray(sponsor.sponsor_plans) ? sponsor.sponsor_plans : [])].filter(Boolean)
    return plans.some(plan => qualifyingPlanIds.has(plan.plan_id) || qualifyingPrices.has(Number(plan.price).toFixed(2)))
  })
  .map(sponsor => {
    const plans = [sponsor.current_plan, ...(Array.isArray(sponsor.sponsor_plans) ? sponsor.sponsor_plans : [])].filter(Boolean)
    const qualifyingPlan = plans
      .filter(plan => qualifyingPlanIds.has(plan.plan_id) || qualifyingPrices.has(Number(plan.price).toFixed(2)))
      .sort((a, b) => Number(b.price) - Number(a.price))[0]
    return {
      id: sponsor.user?.user_id || crypto.createHash('sha256').update(`${sponsor.user?.name || '匿名'}:${sponsor.first_pay_time || 0}`).digest('hex').slice(0, 16),
      name: String(sponsor.user?.name || '匿名赞助者').trim().slice(0, 40),
      avatar: String(sponsor.user?.avatar || ''),
      tier: Number(qualifyingPlan?.price || 0).toFixed(2),
      tierName: String(qualifyingPlan?.name || ''),
      firstSponsoredAt: Number(sponsor.first_pay_time || sponsor.create_time || 0),
    }
  })
  .sort((a, b) => a.firstSponsoredAt - b.firstSponsoredAt || a.name.localeCompare(b.name, 'zh-CN'))

const output = {
  syncedAt: new Date().toISOString(),
  source: 'afdian-open-api',
  creatorUserId: userId,
  qualifyingPlanIds: Array.from(qualifyingPlanIds),
  supporters,
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true })
fs.writeFileSync(outputPath, JSON.stringify(output, null, 2) + '\n', 'utf8')
console.log(`已同步 ${supporters.length} 位符合 50.00 / 88.88 档位的赞助者。`)
