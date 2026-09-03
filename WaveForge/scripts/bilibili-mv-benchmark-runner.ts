import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import {
  buildQueries,
  findBestBilibiliMv,
  setBilibiliApiBaseForTest,
  type CandidateScore,
  type MatchContext,
} from '../src/services/bilibiliApi'

interface CorpusCase extends MatchContext {
  id: string
  split: 'dev' | 'holdout'
  title: string
  duration: number
  category: string
  locale: string
  popularity: string
  targetVersion: NonNullable<MatchContext['targetVersion']>
  franchise?: string
}

interface RequestLog {
  path: string
  ok: boolean
  status?: number
  statusText?: string
  error?: string
}

interface CaseResult {
  case: CorpusCase
  status: 'ok' | 'failed'
  matchStatus?: 'auto' | 'confirm' | 'none' | 'error'
  queries: string[]
  requestLog: RequestLog[]
  candidates: CandidateScore[]
  error?: string
}

const here = dirname(fileURLToPath(import.meta.url))
const root = process.env.BILIBILI_BENCHMARK_ROOT ? resolve(process.env.BILIBILI_BENCHMARK_ROOT) : resolve(here, '..')
const corpusPath = resolve(root, 'benchmark/bilibili-mv/corpus.json')
const outputArg = process.argv.find((arg) => arg.startsWith('--output='))?.slice(9)
const outputPath = resolve(root, outputArg || `benchmark/bilibili-mv/reports/run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
if (extname(outputPath).toLowerCase() !== '.json') throw new Error('--output must end with .json')
const allowFailures = process.argv.includes('--allow-failures')
const split = process.argv.find((arg) => arg.startsWith('--split='))?.slice(8)
const ids = new Set((process.argv.find((arg) => arg.startsWith('--ids='))?.slice(6) || '').split(',').filter(Boolean))
const limit = Number(process.argv.find((arg) => arg.startsWith('--limit='))?.slice(8) || 0)
const apiBase = process.env.BILIBILI_BENCHMARK_API || 'http://127.0.0.1:3011/api/bilibili'
const delayScale = Number(process.env.BILIBILI_BENCHMARK_DELAY_SCALE || 1)
const throttleMs = Number(process.env.BILIBILI_BENCHMARK_REQUEST_DELAY_MS || 500)

setBilibiliApiBaseForTest(apiBase)

const sleep = (ms: number) => new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, ms * delayScale)))
const nativeFetch = globalThis.fetch
let activeRequestLog: RequestLog[] | null = null
let nextRequestAt = 0

async function reserveRequestSlot(path: string): Promise<void> {
  const delay = path.startsWith('/search') ? Math.max(1200, throttleMs) : Math.max(500, throttleMs)
  const now = Date.now()
  const startAt = Math.max(now, nextRequestAt)
  nextRequestAt = startAt + delay * delayScale
  if (startAt > now) await sleep((startAt - now) / Math.max(delayScale, Number.EPSILON))
}

globalThis.fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  const path = url.startsWith(apiBase) ? url.slice(apiBase.length) : url
  await reserveRequestSlot(path)
  try {
    const response = await nativeFetch(input, init)
    activeRequestLog?.push({ path, ok: response.ok, status: response.status, statusText: response.statusText })
    return response
  } catch (error) {
    activeRequestLog?.push({ path, ok: false, error: error instanceof Error ? error.message : String(error) })
    throw error
  }
}

async function collectCase(item: CorpusCase): Promise<CaseResult> {
  const requestLog: RequestLog[] = []
  const song: MatchContext = {
    songTitle: item.title,
    artists: item.artists,
    songDuration: item.duration,
    targetVersion: item.targetVersion,
    franchise: item.franchise,
  }
  const queries = buildQueries(song)

  activeRequestLog = requestLog
  try {
    const result = await findBestBilibiliMv(song, {
      settings: {
        matchPreference: 'balanced',
        autoPlayStrictness: 'standard',
        keywordTemplate: 'auto',
        customKeywordTemplate: '',
        forceAutoPlayHighest: false,
        useRememberedOverride: false,
      },
    })
    const status = result.status === 'error' ? 'failed' : 'ok'
    return {
      case: item,
      status,
      matchStatus: result.status,
      queries,
      requestLog,
      candidates: result.fallbackChain,
      ...(result.error ? { error: result.error } : {}),
    }
  } catch (error) {
    return { case: item, status: 'failed', queries, requestLog, candidates: [], error: error instanceof Error ? error.message : String(error) }
  } finally {
    activeRequestLog = null
  }
}

function markdownReport(results: CaseResult[], generatedAt: string): string {
  const ok = results.filter((result) => result.status === 'ok').length
  const lines = [
    '# Bilibili MV benchmark',
    '',
    `Generated: ${generatedAt}`,
    '',
    `Cases: ${results.length}; successful: ${ok}; failed: ${results.length - ok}.`,
    '',
  ]
  for (const result of results) {
    lines.push(`## ${result.case.title} - ${result.case.artists.join(', ')}`)
    lines.push('')
    lines.push(`Category: ${result.case.category}; split: ${result.case.split}; target: ${result.case.targetVersion}.`)
    lines.push('')
    if (result.status !== 'ok') {
      lines.push(`Failed: ${result.error || 'unknown error'}`, '')
      continue
    }
    lines.push('| Rank | Score | Plays | Duration | Uploader | Title |')
    lines.push('|---:|---:|---:|---:|---|---|')
    result.candidates.slice(0, 5).forEach((candidate, index) => {
      const safe = (value: unknown) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
      lines.push(`| ${index + 1} | ${candidate.score.toFixed(1)} | ${candidate.video.play} | ${candidate.video.duration}s | ${safe(candidate.video.author)} | ${safe(candidate.video.title)} |`)
    })
    lines.push('')
  }
  return lines.join('\n')
}

async function main() {
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8')) as CorpusCase[]
  const selected = corpus
    .filter((item) => !split || item.split === split)
    .filter((item) => ids.size === 0 || ids.has(item.id))
    .slice(0, limit || undefined)
  const results: CaseResult[] = []
  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index]
    console.log(`[${index + 1}/${selected.length}] ${item.title} - ${item.artists.join(', ')}`)
    results.push(await collectCase(item))
    await mkdir(dirname(outputPath), { recursive: true })
    await writeFile(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), apiBase, results }, null, 2), 'utf8')
    await sleep(1800)
  }
  let gitCommit = ''
  let gitDirty = false
  try {
    gitCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
    gitDirty = Boolean(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim())
  } catch { /* optional metadata */ }
  const sourceFiles = [
    'src/services/bilibiliApi.ts',
    'server/bilibili-api.mjs',
    'scripts/bilibili-mv-benchmark-runner.ts',
    'benchmark/bilibili-mv/corpus.json',
    'benchmark/bilibili-mv/source-registry.json',
  ]
  const sourceHash = createHash('sha256')
  for (const file of sourceFiles) sourceHash.update(await readFile(resolve(root, file)))
  const generatedAt = new Date().toISOString()
  const report = {
    generatedAt,
    apiBase,
    gitCommit,
    gitDirty,
    sourceHash: sourceHash.digest('hex'),
    settings: { matchPreference: 'balanced', autoPlayStrictness: 'standard', forceAutoPlayHighest: false, useRememberedOverride: false },
    results,
  }
  await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8')
  await writeFile(outputPath.replace(/\.json$/i, '.md'), markdownReport(results, generatedAt), 'utf8')
  const failures = results.filter((result) => result.status === 'failed').length
  console.log(`Wrote ${results.length} cases to ${outputPath}`)
  if (failures && !allowFailures) process.exitCode = 1
}

await main()
