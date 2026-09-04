/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * 汽水逐字歌词归一化模块（端到端接通 /api/soda/lyric 的 words 字段）。
 *
 * 上游真相：汽水自己的 wire 格式是行内 token 文本（`[行起点,行长]<相对偏移,时长,0>词` /
 * `(绝对起点,时长,0)词`），由 server/qishui-api.mjs 的 parseSodaYrcTimeline / buildSodaWordTimeline
 * 结构化为绝对毫秒时间轴；本模块不做汽水→网易语义的搬运（铁律：不照抄网易解析器），
 * 只按消费端的既有契约做形状归一化——即 musicApi.parseYrc 输出的 LyricLine/LyricWord：
 *   line.time = 行起点（秒）；word.startTime = 相对行首毫秒；word.duration = 毫秒。
 * LyricsDisplay 的逐字渲染被 localStorage 设置 wordByWordLyrics 门控、与平台无关，
 * 因此只要此处产出一致契约，汽水歌曲即可复用全部现有逐字 UI。
 */
import type { LyricLine, LyricWord } from './musicApi'

/** 后端 words 行的 wire 结构（绝对毫秒时间轴） */
export interface SodaWordRowWire {
  start: number
  end: number
  text: string
  /** 翻译内联（后端 buildSodaWordTimeline 按 ≤500ms 就近对齐写入，可能缺失） */
  translated?: string
  /** 词级时间轴；头部元数据等无字级 token 的行可能缺省 */
  words?: SodaWordTokenWire[]
}

export interface SodaWordTokenWire {
  text: string
  start: number
  end: number
}

function isSodaWordToken(value: unknown): value is SodaWordTokenWire {
  return !!value && typeof value === 'object'
    && typeof (value as SodaWordTokenWire).text === 'string'
    && typeof (value as SodaWordTokenWire).start === 'number'
    && typeof (value as SodaWordTokenWire).end === 'number'
}

/** 行级守卫：必须有合法起点且带文本或词级数据（防止脏数据混进渲染链） */
function isSodaWordRow(value: unknown): value is SodaWordRowWire {
  if (!value || typeof value !== 'object') return false
  const row = value as SodaWordRowWire
  if (typeof row.start !== 'number') return false
  return (typeof row.text === 'string' && row.text.trim() !== '')
    || (Array.isArray(row.words) && row.words.length > 0)
}

/**
 * 响应中 words 字段守卫：null/非数组/全不合法 → 返回 null，
 * 调用方据此平静回退普通 LRC 渲染（公开目录兜底/负缓存路径均无逐字数据）。
 */
export function asSodaWordRows(value: unknown): SodaWordRowWire[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const rows = value.filter(isSodaWordRow)
  return rows.length ? rows : null
}

/** 单个 wire 词 token → 前端 LyricWord（绝对毫秒 → 相对行首毫秒） */
function toLyricWord(token: SodaWordTokenWire, lineStartMs: number): LyricWord | null {
  if (!token.text) return null
  const tokenStartMs = Math.max(0, Math.round(token.start))
  const tokenEndMs = Math.max(tokenStartMs, Math.round(token.end))
  return {
    word: token.text,
    startTime: Math.max(0, tokenStartMs - lineStartMs),
    duration: Math.max(0, tokenEndMs - tokenStartMs),
  }
}

/**
 * 汽水 words wire 结构 → 前端逐字渲染契约（LyricLine[]）。
 * 空文本行被丢弃；无字级 token 的行保留为纯文本行；结果按行起点升序。
 */
export function sodaWordRowsToLyricLines(rows: SodaWordRowWire[]): LyricLine[] {
  const lines: LyricLine[] = []
  for (const row of rows) {
    const startMs = Math.max(0, Math.round(row.start))
    const words: LyricWord[] = []
    if (Array.isArray(row.words)) {
      for (const token of row.words) {
        const normalized = isSodaWordToken(token) ? toLyricWord(token, startMs) : null
        if (normalized) words.push(normalized)
      }
    }
    const text = (typeof row.text === 'string' && row.text.trim())
      ? row.text.replace(/\s+/g, ' ').trim()
      : words.map(word => word.word).join('').replace(/\s+/g, ' ').trim()
    if (!text) continue
    const translation = typeof row.translated === 'string' ? row.translated.trim() : ''
    lines.push({
      time: startMs / 1000,
      text,
      words: words.length > 0 ? words : undefined,
      translation: translation || undefined,
    })
  }
  return lines.sort((a, b) => a.time - b.time)
}
