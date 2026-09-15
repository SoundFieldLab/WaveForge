/**
 * 跨平台借"逐字时间"时的安全校验。
 *
 * 场景：本平台歌词只有行级时间（如网易云 LRC、Apple 无逐字曲目），逐字光带没有数据可驱动。
 * 处理：去别的平台借词级时间，但**只借时间轴，不改正文**。
 *
 * 风险：两个平台的同一句歌词可能在简繁/标点/空格上有差异，若只按时间对齐，可能把
 * A 句的词时间挂到 B 句上。因此这里要求"归一化文本完全一致"才借，并要求整体命中率达标。
 */

export interface TimedWord {
  word: string
  startTime: number
  duration: number
}

export interface TimedLyricLine {
  time: number
  text: string
  words?: TimedWord[]
}

/** 归一化：去掉空白、标点与符号，只比较实际字词（简繁差异不在此处理，交给命中率兜底） */
export const normalizeLyricText = (text?: string): string =>
  (text || '').replace(/[\s\p{P}\p{S}]/gu, '')

export interface BorrowOptions {
  /** 行时间对齐容差（秒） */
  tolerance?: number
  /** 最低命中率：命中的行数 / 待补行数，低于此值整首放弃 */
  minRatio?: number
  /** 命中行数下限（避免短歌词用两三行就判定成功） */
  minHits?: number
}

/**
 * 从 candidates 中挑出可以安全借用的行（时间对齐 + 文本一致），同一候选只借一次。
 * 命中率不足时返回空数组，表示"这首不值得借"，由调用方保持行级渲染。
 */
export const selectTimingVerifiedLines = <T extends TimedLyricLine>(
  targets: ReadonlyArray<TimedLyricLine>,
  candidates: ReadonlyArray<T>,
  options: BorrowOptions = {},
): T[] => {
  const tolerance = options.tolerance ?? 0.6
  const minRatio = options.minRatio ?? 0.5
  const minHits = options.minHits ?? 3

  const pending = targets.filter(target => target.text?.trim() && !target.words?.length)
  if (pending.length === 0 || candidates.length === 0) return []

  const used = new Set<number>()
  const matched: T[] = []
  for (const target of pending) {
    const targetText = normalizeLyricText(target.text)
    if (!targetText) continue
    let bestIndex = -1
    let bestDiff = tolerance
    candidates.forEach((candidate, index) => {
      if (used.has(index) || !candidate.words?.length) return
      if (normalizeLyricText(candidate.text) !== targetText) return
      const diff = Math.abs((candidate.time || 0) - (target.time || 0))
      if (diff <= bestDiff) {
        bestDiff = diff
        bestIndex = index
      }
    })
    if (bestIndex >= 0) {
      used.add(bestIndex)
      matched.push(candidates[bestIndex])
    }
  }

  const required = Math.max(minHits, Math.ceil(pending.length * minRatio))
  return matched.length >= required ? matched : []
}
