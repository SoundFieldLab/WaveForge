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
 * 单个词的光带遮罩：光带按**该词在整句中的演唱进度**定位。
 *
 * 为什么必须逐词：CSS 的 mask 按元素的坐标轴计算，若把一条渐变铺在整行容器上，
 * 换行后的每一行都会各自出现"左亮右暗"，视觉上成了两条光带（用户实测反馈）。
 * 逐词各自带遮罩后，进度天然按阅读顺序推进（第一行唱完才轮到第二行）。
 *
 * 渐变必须写满四个色标（亮 0% → 亮 rampStart% → 暗 head% → 暗 100%）：
 * 只写「亮 start%、暗 end%」两个色标时，CSS 会把首个色标向右**也**延伸（即 0~start 恒为亮档），
 * 于是进度 0 的第一个词的左缘就已经是满亮——这就是"没到填充时间，首字却亮了一点点"的原因。
 * 四个色标让进度 0 时整词恒为暗档、进度 1 时整词恒为亮档，羽化只出现在推进中的前沿。
 */
export const bandMaskForProgress = (localProgress: number, fadePercent = 8): string => {
  const progress = Math.min(1, Math.max(0, localProgress))
  const bright = `rgb(0 0 0 / ${AMLL_BRIGHT_MASK_ALPHA})`
  const dark = `rgb(0 0 0 / ${AMLL_DARK_MASK_ALPHA})`
  // 两端直接给出纯色档，避免端点仍带一段羽化（进度 0 不应有亮区、进度 1 不应有暗尾）
  if (progress <= 0) return `linear-gradient(to right, ${dark} 0%, ${dark} 100%)`
  if (progress >= 1) return `linear-gradient(to right, ${bright} 0%, ${bright} 100%)`
  const head = progress * 100
  // 羽化整段落在前沿**之后**（head-fade → head），保证已唱区始终是满亮、
  // 未唱区始终是暗档，且 head=0 时亮区宽度为 0。
  const rampStart = Math.max(0, head - fadePercent)
  return `linear-gradient(to right, ${bright} 0%, ${bright} ${rampStart.toFixed(2)}%, ${dark} ${head.toFixed(2)}%, ${dark} 100%)`
}

/** 各词在整句中的字符区间（用于把整句进度换算成每个词的局部进度） */
export const computeWordRanges = (
  words: ReadonlyArray<{ word: string }>,
): Array<{ start: number; end: number; chars: number }> => {
  const counts = words.map(word => {
    const text = (word.word || '').trim()
    return text ? Math.max(1, Array.from(text).length) : 0
  })
  const total = counts.reduce((sum, value) => sum + value, 0)
  let accumulated = 0
  return counts.map(chars => {
    const start = total > 0 ? accumulated / total : 0
    accumulated += chars
    return { start, end: total > 0 ? accumulated / total : 0, chars }
  })
}

/**
 * 按"字符数加权"统计整行已唱比例（0~1）：完全唱过的词计满，正在唱的词按时间比例。
 *
 * 空白词的权重必须与 computeWordRanges 保持一致（都是 0）：若这里把空白词算作 1 个字符、
 * 而词区间那边算 0，两条曲线就不同步——整句进度会略快于实际演唱，表现为每句刚开头
 * 就有"已经唱了一点"的提前填充（用户实测反馈的正是这个观感）。
 */
export const computeSungRatio = (
  words: ReadonlyArray<{ word: string; startTime: number; duration: number }>,
  currentMs: number,
): number => {
  let sung = 0
  let total = 0
  for (const word of words) {
    const text = (word.word || '').trim()
    if (!text) continue
    const chars = Math.max(1, Array.from(text).length)
    total += chars
    // 时长为 0 的可见词（异常数据）不能瞬间计满：按未唱处理，等下一词推进。
    const progress = word.duration > 0
      ? clamp01((currentMs - word.startTime) / word.duration)
      : 0
    sung += chars * progress
  }
  return total > 0 ? sung / total : 0
}
