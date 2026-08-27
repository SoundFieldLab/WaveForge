/**
 * pvDirector —— PV 歌词页自动编排（凝彩式导演层，纯自动、无用户配置）。
 *
 * 输入歌词时间结构（行间隙）+ 分析信号（sections/逐拍能量）+ 全曲推荐池，
 * 编译出按时间排列的场景列：每段自带模板索引与能量强度（intensity），
 * 相邻段落模板不重复，段落边界即「建议切换」时机（engine.fadeToTemplate 平滑过渡）。
 *
 * 参考凝彩（folia tempera）的段落划分思想：行间隙中位数×2.5 作为段落阈值、
 * 换气段只用安静构图、副歌不落到安静 —— 这里用同样规则选模板族。
 */
import type { LyricLine as PvLyricLine } from '../../vendor/pv/core/types'
import type { TrackAnalysis } from '../../audio/types'

export type PvSceneKind = 'intro' | 'breath' | 'passage' | 'chorus' | 'outro'

export interface PvScene {
  start: number
  end: number
  templateIndex: number
  /** 段落能量强度 0~1：驱动节拍响应/后期滤镜/动画速度的参数曲线 */
  intensity: number
  kind: PvSceneKind
}

export interface PvDirectorSignals {
  /** 引擎歌词行（time 秒 + 逐字可选） */
  lyrics: PvLyricLine[]
  analysis: TrackAnalysis | null
  /** 全曲自动推荐 top3 模板索引 */
  recommended: number[]
}

/** 段落模板族的风格基分（与 recommended 加分叠加后取最高，保证相邻不重复） */
const KIND_POOLS: Partial<Record<PvSceneKind, number[]>> = {
  intro: [4, 9, 23, 27, 14],
  breath: [9, 4, 23, 27, 29],
  passage: [5, 4, 10, 29, 21],
  chorus: [0, 1, 8, 24, 18],
  outro: [4, 9, 14, 27, 23],
}

const KIND_INTENSITY: Record<PvSceneKind, number> = {
  intro: 0.35,
  breath: 0.4,
  passage: 0.55,
  chorus: 0.78,
  outro: 0.32,
}

/** 编译场景列。lyrics 为空时返回空数组（组件兜底显示歌名）。 */
export function compileScenes(signals: PvDirectorSignals): PvScene[] {
  const { lyrics, analysis, recommended } = signals
  if (lyrics.length === 0) return []

  // 1. 段落划分：间隙 ≥ 阈值（中位数×2.5，钳 1.25~3.5s）的行界作为切点
  const gapThreshold = resolveGapThreshold(lyrics)
  const sectionTypes = resolveSectionTypes(analysis)

  const groups: { start: number; end: number; lineStart: number; lineEnd: number; kind: PvSceneKind; wordCount: number }[] = []
  let groupStartLine = 0
  for (let i = 0; i < lyrics.length; i++) {
    const line = lyrics[i]
    const next = lyrics[i + 1]
    const gap = next ? next.time - lineEndOf(line) : Infinity
    const atSectionBoundary = next ? (sectionTypes.get(next.time) !== undefined) : false
    const isChorusLine = next ? (sectionTypes.get(next.time) === 'chorus') : false
    if (next && (gap >= gapThreshold || atSectionBoundary) && i > groupStartLine) {
      pushGroup(groups, lyrics, groupStartLine, i)
      groupStartLine = i + 1
    }
  }
  pushGroup(groups, lyrics, groupStartLine, lyrics.length - 1)

  // 2. 段落定性 + intensity
  const total = groups.length
  const scenes: { start: number; end: number; kind: PvSceneKind; wordCount: number; energy: number }[] = groups.map((g, idx) => {
    let kind: PvSceneKind = 'passage'
    const section = sectionTypes.get(g.start)
    if (idx === 0) kind = 'intro'
    else if (idx === total - 1) kind = 'outro'
    else if (section === 'chorus' || section === 'drop' || g.wordCount <= 0) kind = 'chorus'
    else if (section === 'bridge' || (g.end - g.start >= gapThreshold * 1.6) || g.wordCount <= 2) kind = 'breath'
    return { start: g.start, end: g.end, kind, wordCount: g.wordCount, energy: measureEnergy(analysis, g.start, g.end) }
  })

  // 3. 模板分配：kind 族基分 + 推荐加分，取最高且 ≠ 前一模板
  const assigned: number[] = []
  for (let idx = 0; idx < scenes.length; idx++) {
    const kindPool = KIND_POOLS[scenes[idx].kind] ?? []
    const pool = new Set([...kindPool, ...recommended])
    let best = -1
    let bestScore = -Infinity
    for (const tpl of pool) {
      const prev = idx > 0 ? assigned[idx - 1] : -1
      if (tpl === prev) continue
      let score = 0
      if (recommended.includes(tpl)) score += 2.5
      const rank = kindPool.indexOf(tpl)
      if (rank >= 0) score += 2 - rank * 0.35
      if (score > bestScore) { bestScore = score; best = tpl }
    }
    assigned.push(best < 0 ? (recommended[0] ?? 0) : best)
  }

  // 4. 组装场景（强度按实际能量，带 kind 修正）
  return scenes.map((s, idx) => ({
    start: s.start,
    end: s.end,
    templateIndex: assigned[idx],
    kind: s.kind,
    intensity: clampIntensity(resolveIntensity(s.kind, s.energy)),
  }))
}

/** 下一段 start（= 本段 end）。衔接处留 60ms 覆盖避免空窗 */
function pushGroup(
  groups: { start: number; end: number; lineStart: number; lineEnd: number; kind: PvSceneKind; wordCount: number }[],
  lyrics: PvLyricLine[],
  from: number,
  to: number,
): void {
  const start = lyrics[from].time
  const last = lyrics[to]
  const end = lineEndOf(last)
  const wordCount = lyrics.slice(from, to + 1).reduce((sum, l) => sum + (l.words?.length ?? 1), 0)
  groups.push({ start, end, lineStart: from, lineEnd: to, kind: 'passage', wordCount })
}

function lineEndOf(line: PvLyricLine): number {
  const words = line.words
  if (words && words.length > 0) return words[words.length - 1].endTime
  return line.time + 3
}

function resolveGapThreshold(lyrics: PvLyricLine[]): number {
  const gaps: number[] = []
  for (let i = 0; i < lyrics.length - 1; i++) {
    const gap = lyrics[i + 1].time - lineEndOf(lyrics[i])
    if (gap > 0) gaps.push(gap)
  }
  if (gaps.length === 0) return 2.5
  const sorted = [...gaps].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  return Math.max(1.25, Math.min(3.5, median * 2.5))
}

/** sections 节拍时间点 → 段落类型映射（lineStart 对齐用） */
function resolveSectionTypes(analysis: TrackAnalysis | null): Map<number, string> {
  const map = new Map<number, string>()
  if (!analysis || !Array.isArray(analysis.sections)) return map
  for (const s of analysis.sections) map.set(s.time, s.type)
  return map
}

/** [start,end) 内逐拍能量均值；无分析/无拍点返回 0.5 */
function measureEnergy(analysis: TrackAnalysis | null, start: number, end: number): number {
  if (!analysis || !Array.isArray(analysis.beatFeatures) || analysis.beatFeatures.length === 0) return 0.5
  let sum = 0
  let count = 0
  for (const f of analysis.beatFeatures) {
    if (f.time >= start && f.time < end) {
      sum += f.energy ?? 0
      count++
    }
  }
  return count > 0 ? sum / count : 0.5
}

function resolveIntensity(kind: PvSceneKind, energy: number): number {
  let v = energy
  if (kind === 'intro' || kind === 'outro') v *= 0.62
  else if (kind === 'breath') v *= 0.7
  else if (kind === 'chorus') v = Math.max(v, 0.62)
  return v
}

function clampIntensity(v: number): number {
  return Math.max(0.25, Math.min(1, v))
}