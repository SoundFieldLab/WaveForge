/**
 * Apple Music「长音字强调」——参数与帧值照搬 AMLL（applemusic-like-lyrics）core：
 *   packages/core/src/lyric-player/base/line.ts            → shouldEmphasize（触发阈值）
 *   packages/core/src/lyric-player/dom/animation/emphasize/index.ts → 参数与关键帧
 *   packages/core/src/lyric-player/dom/animation/mask/utils.ts      → 光带渐变
 *
 * 触发：CJK 字唱满 1 秒；非 CJK 词唱满 1 秒且去空白后长度 2~7。
 * 表现：白色辉光（textShadow）+ 字级缩放 + 相邻字推挤 + 上浮 + 字符级错落；行末词加强。
 */

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff66-\uff9f]/

export interface EmphasizableWord {
  word: string
  startTime: number
  duration: number
}

/** AMLL：只有"长音"才强调（含行末加强的判定输入） */
export const shouldEmphasizeWord = (word: EmphasizableWord): boolean => {
  const text = word.word || ''
  if (!text.trim()) return false
  if (word.duration < 1000) return false
  if (CJK_PATTERN.test(text)) return true
  const length = text.trim().length
  return length > 1 && length <= 7
}

export interface EmphasizeParams {
  amount: number
  blur: number
  /** 强调动画时长（毫秒），已按行末词 ×1.2 修正 */
  du: number
  /** 词相对行首的起始延迟（毫秒） */
  de: number
  anchorCharCount: number
}

/** AMLL calculateEmphasizeParams 的等价实现 */
export const computeEmphasizeParams = (
  duration: number,
  delay: number,
  charCount: number,
  isLastWord: boolean,
): EmphasizeParams => {
  const de = Math.max(0, delay)
  let du = Math.max(1000, duration)
  const anchorCharCount = Math.max(1, charCount)

  let amount = du / 2000
  amount = amount > 1 ? Math.sqrt(amount) : amount ** 3
  let blur = du / 3000
  blur = blur > 1 ? Math.sqrt(blur) : blur ** 3

  amount *= 0.6
  blur *= 0.5

  if (isLastWord) {
    amount *= 1.6
    blur *= 1.5
    du *= 1.2
  }

  return {
    amount: Math.min(1.2, amount),
    blur: Math.min(0.8, blur),
    du,
    de,
    anchorCharCount,
  }
}

// ── cubic-bezier 求值（等价于 AMLL 依赖的 bezier-easing）──
const cubicBezier = (x1: number, y1: number, x2: number, y2: number) => {
  const ax = 1 - 3 * x2 + 3 * x1
  const bx = 3 * x2 - 6 * x1
  const cx = 3 * x1
  const ay = 1 - 3 * y2 + 3 * y1
  const by = 3 * y2 - 6 * y1
  const cy = 3 * y1
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx

  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    // 牛顿迭代求 t（x 单调），失败退二分
    let t = x
    for (let i = 0; i < 8; i += 1) {
      const diff = sampleX(t) - x
      if (Math.abs(diff) < 1e-6) return sampleY(t)
      const slope = slopeX(t)
      if (Math.abs(slope) < 1e-6) break
      t -= diff / slope
    }
    let low = 0
    let high = 1
    t = x
    for (let i = 0; i < 20; i += 1) {
      const current = sampleX(t)
      if (Math.abs(current - x) < 1e-6) break
      if (current < x) low = t
      else high = t
      t = (low + high) / 2
    }
    return sampleY(t)
  }
}

const bezIn = cubicBezier(0.2, 0.4, 0.58, 1.0)
const bezOut = cubicBezier(0.3, 0.0, 0.58, 1.0)
const clamp01 = (value: number) => Math.min(1, Math.max(0, value))

/** AMLL empEasing：前半段入场（bezIn），后半段出场（1 - bezOut） */
export const emphasizeEasing = (x: number): number => {
  const clamped = clamp01(x)
  if (clamped < 0.5) return bezIn(clamp01(clamped / 0.5))
  return 1 - bezOut(clamp01((clamped - 0.5) / 0.5))
}

export interface EmphasizeCharFrame {
  /** 字级缩放（AMLL: 1 + transX * 0.1 * amount） */
  scale: number
  /** 相邻字推挤（em） */
  offsetXEm: number
  /** 上浮（em，不含 float） */
  offsetYEm: number
  /** 白色辉光透明度（0 表示不发光） */
  glowAlpha: number
  /** 白色辉光模糊半径（em） */
  glowEm: number
}

/** 单个字符在当前时刻的强调帧值；elapsedMs 为该字符动画已过去的毫秒数 */
export const emphasizeCharFrame = (
  params: EmphasizeParams,
  charIndex: number,
  totalChars: number,
  elapsedMs: number,
): EmphasizeCharFrame => {
  const x = clamp01(elapsedMs / Math.max(1, params.du))
  const transX = emphasizeEasing(x)
  const glowAlpha = transX * params.blur
  return {
    scale: 1 + transX * 0.1 * params.amount,
    offsetXEm: -transX * 0.03 * params.amount * (totalChars / 2 - charIndex),
    offsetYEm: -transX * 0.025 * params.amount,
    glowAlpha,
    glowEm: Math.min(0.3, params.blur * 0.3),
  }
}

/** 每个字符的错落延迟（AMLL: wordDe = de + du / 2.5 / anchorCharCount * i） */
export const charEmphasizeDelay = (params: EmphasizeParams, charIndex: number): number =>
  params.de + (params.du / 2.5 / params.anchorCharCount) * charIndex

/** 上浮动画（AMLL float）：比辉光提前 400ms 起，时长 ×1.4，幅度 -sin(x·π)·0.05em（背景人声 ×2） */
export const charFloatYEm = (params: EmphasizeParams, elapsedMs: number, isBackground = false): number => {
  const duration = params.du * 1.4
  const x = clamp01(elapsedMs / Math.max(1, duration))
  const amplitude = Math.sin(x * Math.PI) * (isBackground ? 2 : 1)
  return -amplitude * 0.05
}

export const CHAR_FLOAT_LEAD_MS = 400

// ── 逐字光带（AMLL mask/utils.ts 的等价参数）──

/** AMLL 默认 wordFadeWidth（字号倍数）：0.5 ≈ iPad 版 AM，1 ≈ Android 版 AM */
export const AMLL_WORD_FADE_WIDTH = 0.5
/** 激活行遮罩两档 alpha（AMLL lyric-player.module.css） */
export const AMLL_BRIGHT_MASK_ALPHA = 1
export const AMLL_DARK_MASK_ALPHA = 0.4

/** AMLL generateFadeGradient：返回渐变与总宽倍数（totalAspect = 2 + width） */
export const generateFadeGradient = (width: number): readonly [gradient: string, totalAspect: number] => {
  const totalAspect = 2 + width
  const halfFadePercent = (width / totalAspect) * 50
  return [
    `linear-gradient(to right, rgb(0 0 0 / ${AMLL_BRIGHT_MASK_ALPHA}) ${50 - halfFadePercent}%, rgb(0 0 0 / ${AMLL_DARK_MASK_ALPHA}) ${50 + halfFadePercent}%)`,
    totalAspect,
  ] as const
}

/**
 * 整行光带遮罩：光带位于"已唱宽度占比"处，边界羽化 ≈ 0.32em（= 字高 × 0.5 / 2 的近似）。
 * 说明：AMLL 逐词各自一条 mask-position 关键帧（按像素宽度累计）；这里用整行一条遮罩 +
 * 字符数加权的进度，视觉等效（光带在词边界对齐、边界同样羽化）且无需测量 DOM 宽度。
 */
export const buildLineBandMask = (
  sungRatio: number,
  fadeEm = 0.32,
): string => {
  const position = Math.min(100, Math.max(0, sungRatio * 100))
  return `linear-gradient(to right, rgb(0 0 0 / ${AMLL_BRIGHT_MASK_ALPHA}) calc(${position.toFixed(2)}% - ${fadeEm}em), rgb(0 0 0 / ${AMLL_DARK_MASK_ALPHA}) calc(${position.toFixed(2)}% + ${fadeEm}em))`
}

/** 按"字符数加权"统计整行已唱比例（0~1）：完全唱过的词计满，正在唱的词按时间比例 */
export const computeSungRatio = (
  words: ReadonlyArray<{ word: string; startTime: number; duration: number }>,
  currentMs: number,
): number => {
  let sung = 0
  let total = 0
  for (const word of words) {
    const chars = Math.max(1, Array.from((word.word || '').trim()).length)
    total += chars
    const progress = clamp01((currentMs - word.startTime) / Math.max(1, word.duration))
    sung += chars * progress
  }
  return total > 0 ? sung / total : 0
}
