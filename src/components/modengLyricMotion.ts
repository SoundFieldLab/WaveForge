/**
 * 摩登模式歌词动画底座 —— LyricsBlossom 逆向规格移植。
 *
 * ⚠ 作用域：**仅供 ModengPlayerPage（摩登歌词模式）使用**。请勿被其他歌词模式引用，
 *   其他模式的动画体系（AMLL 弹簧等）与摩登模式彼此隔离。
 *
 * 规格来源：`逆向成果/动画系统与时序曲线.md`、`renderLine-逆向报告.md`
 *   - `CSSCubicBezierTiming::evaluate`（RVA 0x2A7D10）：Newton-Raphson ≤8 次迭代求 x(t)，
 *     再按三次贝塞尔 Y 公式求值。**LyricsBlossom 没有 spring 物理**，所谓"弹簧感"来自
 *     back 型贝塞尔（x1=0.4 > x2=0.2）在中段的加速-减速观感。
 *   - 六处预设构造点（0x2B8620 / 0x2FA0C0 / 0x2FA7C0 / 0x2FDC60 / 0x2FDD80 / 0x2FDEA0）
 *     提取出的全部 double 常量，见下方 LB_EASING。
 *   - 逐词渲染 = 整行文本一次绘制 + 文字颜色随演唱进度 ARGB 线性插值（0x2F6110 主题色板）。
 *     逆向二进制里的 0x2F5C70 词底圆角矩形经实机核实为**用户拖选歌词的选区背景**，
 *     正常播放时不绘制，故摩登模式不实现词底胶囊（见 ModengPlayerPage 逐词段注释）。
 *
 * 2026-10-01 增补（参考 Project Folia `folia-major` 的歌词动画实现）：
 *   在保留「整字 ARGB 混色、不做字形裁剪」这一 LyricsBlossom 身份的前提下，
 *   补上 folia classic 视觉器里三处摩登原先缺失的手感：
 *     ① 逐字形（grapheme）时间窗 → 同一词内多字不再齐亮，改为依次点亮（`buildLineGlyphs`）；
 *     ② 单点流动辉光 → 只有"正在唱的那一个字"承担 text-shadow 光晕，峰值在字形进度 30%
 *        （`glowEnvelope`，对齐 folia glow 层的 `times: [0, 0.3, 1]`）；
 *     ③ 尾焰缓动 → 唱完的字从 sung 色缓动回退到 unsung 色，而不是按词进度瞬跳
 *        （`LB_AFTERGLOW`，对齐 folia 的 `passed` 档）。
 *   另补 ④ 行进入的聚焦模糊与 ⑤ 短行自适应时长（对齐 folia 的 line enter 与 `renderHints`）。
 *
 * 2026-10-03 增补（第二轮，继续对齐 folia 的歌词手感）：
 *   ⑥ 罗马音逐词点亮 —— `romanWords` 对齐到主歌词词时间窗（`buildRomanWordSpans`），
 *      当前行的罗马音随演唱进度逐词混色（`romanWordColor`，端点弱于主行、不参与辉光）；
 *   ⑦ 亚帧字形窗口防护 —— 单字形窗口短于 `SUB_FRAME_GLYPH_SEC`（0.05s ≈ 3 帧）的词
 *      并回一个字形，避免"整词闪一下"与 1 帧辉光（对齐 folia `wordRevealMode:'instant'`）。
 *
 * 2026-10-07 增补（对齐 LyricsBlossom **实机录屏** `BV1JnE96PEuN`，证据
 *   `.workbuddy/verification/lb-video-2026-10-07/ANALYSIS.md`）：
 *   ⑧ **流动辉光削弱** —— 帧级量化证实 LyricsBlossom 原生**无任何文字辉光**
 *      已被 ② 引入的辉光是纯增强项；用户决定保留但削弱，强度集中到唯一旋钮
 *      `MODENG_GLOW_GAIN`（现 0.45）。另有两条**有意不做**：
 *        · `LB_THRESHOLD.lineDone`（行唱完收束）—— 实机逐帧确认无此动作（见该常量注释）；
 *        · 排版类数值（字号/行距/锚点）—— 该视频字号档位与 2026-09-12 标定基准不同，**不可比**，
 *          不得据此修改。
 */
import type { LyricLine } from '../services/musicApi'
import {
  buildTimedLyricGlyphs,
  hasTrueWordTiming,
  prepareLyricWords,
  segmentLyricGraphemes,
} from '../utils/lyricWordTiming'

/* ------------------------------------------------------------------ *
 * 一、CSSCubicBezierTiming（0x2A7D10 逐行还原）
 * ------------------------------------------------------------------ */

/** 三次贝塞尔单轴求值：B(t) = 3(1-t)²t·a + 3(1-t)t²·b + t³（端点 0 / 1） */
const bezierAxis = (t: number, a: number, b: number): number => {
  const u = 1 - t
  return 3 * u * u * t * a + 3 * u * t * t * b + t * t * t
}

/** 单轴导数：B'(t) = 3(1-t)²(P1-P0) + 6(1-t)t(P2-P1) + 3t²(P3-P2) */
const bezierAxisDeriv = (t: number, a: number, b: number): number => {
  const u = 1 - t
  return 3 * u * u * a + 6 * u * t * (b - a) + 3 * t * t * (1 - b)
}

/**
 * 按归一化时间求曲线值，语义等价于 CSS `cubic-bezier(x1,y1,x2,y2)` 的 y(x)。
 *
 * 逆向行为对齐（0x2A7D10）：
 *   - x <= 0 → 0；x >= 1 → 1（越界即完成，直接返回端点，不做外推）；
 *   - Newton-Raphson 最多 8 次迭代解 x(t) = x，导数过小或迭代越界即提前 break；
 *   - 最后按 Y 公式求值（y 分量不参与迭代）。
 *
 * @param progress 归一化进度（0..1，= elapsed / duration）
 */
export const cubicBezier = (
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  progress: number,
): number => {
  if (!(progress > 0)) return 0
  if (progress >= 1) return 1
  let t = progress
  for (let i = 0; i < 8; i++) {
    const dx = bezierAxisDeriv(t, x1, x2)
    if (Math.abs(dx) < 1e-6) break
    const next = t - (bezierAxis(t, x1, x2) - progress) / dx
    // 迭代越界即放弃（对齐逆向的边界裁剪分支），保留上一次有效值
    if (next < 0 || next > 1) break
    t = next
  }
  return bezierAxis(t, y1, y2)
}

/** 一条完整的时序曲线 = 贝塞尔控制点 + 时长（对应 CSSCubicBezierTiming 的 0x30 字节布局） */
export interface LbCurve {
  x1: number
  y1: number
  x2: number
  y2: number
  /** 动画时长（秒） */
  duration: number
}

/**
 * 六个预设构造点提取出的全部曲线（逆向文档 §2 常量表）。
 * 注释里的 RVA 是逆向时定位到的 CSSCubicBezierTiming 构造点。
 */
export const LB_EASING = {
  /** 0x2B8620：默认过渡 / 当前行"展开放大"钩子 —— ease-in-out 0.3s */
  easeInOut: { x1: 0.42, y1: 0, x2: 0.58, y2: 1, duration: 0.3 },
  /** 0x2FA0C0：行切换位移（封面/overlay 位移同款）—— 0.32s */
  switch: { x1: 0.4, y1: 0, x2: 0.2, y2: 1, duration: 0.32 },
  /** 0x2FDC60 / 0x2FDD80 / 0x2FDEA0：放大行淡入（慢版）—— 0.45s */
  expandFade: { x1: 0.4, y1: 0, x2: 0.2, y2: 1, duration: 0.45 },
  /** 0x2FA7C0：ease-in 偏门 —— 0.28s */
  easeIn: { x1: 0, y1: 0, x2: 0.58, y2: 1, duration: 0.28 },
} as const satisfies Record<string, LbCurve>

/**
 * 按"已过去秒数"求曲线值。传入负数返回 0，超过 duration 返回 1（对齐 evaluate 的越界分支）。
 * 这是渲染层唯一需要的入口 —— 各动画槽只需保存一个起始墙钟，每帧传入 elapsed 即可。
 */
export const evalCurve = (curve: LbCurve, elapsedSec: number): number =>
  cubicBezier(curve.x1, curve.y1, curve.x2, curve.y2, elapsedSec / curve.duration)

/* ------------------------------------------------------------------ *
 * 二、逐词/逐行渲染常量（0x2F6110 + 0x2F5C70）
 * ------------------------------------------------------------------ */

/** 行渲染状态机阈值（逆向文档 §5 阈值表） */
export const LB_THRESHOLD = {
  /**
   * 行进度达到该值视为"本行唱完"，行切换明暗 / 放大收束。
   *
   * ▼ 2026-10-07 已用**实机录屏**核实（`BV1JnE96PEuN`，LyricsBlossom 2K 录屏，证据见
   *   `.workbuddy/verification/lb-video-2026-10-07/`）：**LyricsBlossom 没有任何独立的
   *   "行唱完收束"动作** —— 逐帧（10fps）看完整次行切换，旧行只是随列表滚动上移并同步
   *   转入 distance 变暗/模糊，既无缩放收束、也无亮度脉冲。故**本项目有意不实现该阈值**，
   *   常量仅作逆向规格留档。若日后要实现，须先拿到能看出收束的对照素材。
   */
  lineDone: 0.997,
  /**
   * 已唱词淡出阈值（0x2F7C3E 处的 0.985 比较指令）。
   * ⚠ 2026-10-01：摩登的 sung → unsung 回退**已改为时间驱动**（见下方 LB_AFTERGLOW），
   *   不再按该阈值切窗口；此常量保留仅作逆向规格留档，勿再作为动画门控使用。
   */
  sungFade: 0.985,
  /** 行淡入到一半时复位行动画（逆向 dt/0.32 推进到 0.5 复位） */
  resetAt: 0.5,
  /** 词动画步长（0x2F76F7 循环步长系数 0.04） */
  wordStep: 0.04,
} as const

/* ------------------------------------------------------------------ *
 * 三、Project Folia 增补（2026-10-01）
 *   folia 的歌词动画与 LyricsBlossom 是两套独立体系（folia 用 framer-motion spring +
 *   独立的逐字形 glow 层）。此处**只取手感**，全部改写为摩登自己的 rAF + 贝塞尔语义：
 *   不引入 framer-motion，也不 import `src/vendor/folia` 下的任何模块，
 *   保证摩登模式自包含（铁律：摩登不得与其他歌词模式互相依赖）。
 * ------------------------------------------------------------------ */

/** 单个字形（grapheme）及其绝对时间窗。 */
export interface ModengGlyph {
  text: string
  /** 绝对秒 */
  startTime: number
  endTime: number
  /** 在所属词内的序号 */
  glyphIndex: number
  whitespace: boolean
}

/**
 * 亚帧字形阈值（秒）：单字形时间窗短于它就不再逐字推进，并回整词。
 *
 * 60fps 下一帧 16.7ms，0.05s ≈ 3 帧。比这更短的窗口里，rAF 每帧只能推进 1/3 个字，
 * "逐字扫过"根本来不及成形 —— 实机观感是整词同时亮起、且单点辉光只闪 1 帧（像故障）。
 * 快速念白 / 密集短句（部分 KTV 逐字数据把 4~5 个字的词压进 0.1s）正是这种情况。
 * 并回整词后，该词的揭示与辉光至少有一个完整可辨识的窗口，代价只是"这个词不逐字"。
 *
 * 对齐 folia `renderHints` 的 `wordRevealMode: 'instant'`（micro 档不逐字揭示）的意图，
 * 但阈值按**词**而非整行判 —— 摩登的推进粒度本来就是词内字形窗口。
 */
export const SUB_FRAME_GLYPH_SEC = 0.05

/**
 * 把一行歌词按「词 → 字形」二维展开。
 *
 * 有真实逐字数据时，字形在其所属词的时长内**均分**（等价 folia
 * `buildWordGraphemeTimings` 的 `buildEvenGraphemeTimings` 分支；摩登的数据源没有
 * syllable 子音节字段，故不走 syllable 分支）。
 * 于是同一时刻只有 1~2 个字形处于「正在唱」，形成 folia 那种逐字扫过的推进感 ——
 * 这是摩登原先「整词一次性混色」最缺的一环。
 *
 * 单字形窗口短于 `SUB_FRAME_GLYPH_SEC` 的词会**并回一个字形**（整词一个时间窗）：
 * 亚帧窗口下逐字推进与单点辉光都来不及成形，只会闪一下，合并后揭示才连贯。
 *
 * 无真实逐字数据时返回 []，调用方退回既有的「整行按线性推进」路径，行为不变。
 *
 * ⚠ 字形分组的词下标必须与 ModengPlayerPage 的 `buildLineWords` 对齐：两者都基于
 *   `prepareLyricWords(line)` 的词序，故 `glyph.wordIndex` 可直接当词下标使用。
 */
export const buildLineGlyphs = (line: LyricLine): ModengGlyph[][] => {
  const glyphs = buildTimedLyricGlyphs(line)
  if (glyphs.length === 0) return []
  const grouped: ModengGlyph[][] = []
  glyphs.forEach(glyph => {
    const bucket = grouped[glyph.wordIndex] ?? (grouped[glyph.wordIndex] = [])
    bucket.push({
      text: glyph.text,
      startTime: glyph.startTime,
      endTime: glyph.endTime,
      glyphIndex: glyph.glyphIndex,
      whitespace: glyph.isWhitespace,
    })
  })
  return grouped.map(bucket => {
    if (!bucket || bucket.length <= 1) return bucket ?? []
    const first = bucket[0]
    const last = bucket[bucket.length - 1]
    const wordSpan = last.endTime - first.startTime
    // 平均字形窗口仍够长 → 保持逐字；否则整词合成一个字形（文本拼回原词）。
    if (wordSpan / bucket.length >= SUB_FRAME_GLYPH_SEC) return bucket
    return [{
      text: bucket.map(glyph => glyph.text).join(''),
      startTime: first.startTime,
      endTime: last.endTime,
      glyphIndex: 0,
      whitespace: bucket.every(glyph => glyph.whitespace),
    }]
  })
}

/** 三次缓入缓出（t=0 / t=1 处导数均为 0 → 首尾无跳变） */
export const easeInOutCubic = (t: number): number =>
  t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2

/**
 * 尾焰（afterglow）参数 —— 对齐 folia `passed` 档的「唱完后缓动回到基色」。
 *
 * 摩登原实现把 sung → unsung 的 35% 通道回退挂在**词进度**的最后 1.5%
 * （`LB_THRESHOLD.sungFade = 0.985`）：一个 0.3s 的词 → 窗口仅 4.5ms，实机观感是
 * "唱完瞬间啪地变灰"。folia 的 `passed` 档是 0.8s easeInOut 回到基色 → 字尾拖出
 * 一道渐隐余晖。这里取介于两者之间的时长（0.42s），并把驱动量从「词进度」换成
 * 「唱完后的秒数」；回退的**终点仍是 35%**，只有时间曲线变了。
 */
export const LB_AFTERGLOW = {
  /** 回退总时长（秒） */
  duration: 0.42,
  /** 回退幅度（沿用 LyricsBlossom 的 35%） */
  amount: 0.35,
} as const

/**
 * 流动辉光包络 —— 对齐 folia classic glow 层的 `textShadow: [none, glow, none]`
 * 与 `times: [0, 0.3, 1]`：字形进度 0 → 0.3 迅速起亮，0.3 → 1 缓慢收到 0。
 *
 * 峰值落在进度 30% 而非 100%，有两个好处：
 *   ① 光点始终"跟得上"正在唱的字，不会滞后；
 *   ② 一个字唱完时辉光已归零，切到下一个字不会有两个光点同时发亮 → 逐字对比清晰。
 * 返回值 0..1，由调用方乘到颜色/半径上。
 */
export const glowEnvelope = (progress: number): number => {
  if (!(progress > 0) || progress >= 1) return 0
  return progress < 0.3
    ? easeInOutCubic(progress / 0.3)
    : 1 - easeInOutCubic((progress - 0.3) / 0.7)
}

/**
 * 流动辉光的**整体强度旋钮**（唯一调节点，勿在别处再乘系数）。
 *
 * ▼ 2026-10-07 削弱至 0.45 —— 依据 LyricsBlossom 实机录屏帧级量化
 *   （`BV1JnE96PEuN`，证据 `.workbuddy/verification/lb-video-2026-10-07/ANALYSIS.md`）：
 *   已唱白字**外 3px 环** `(56.7,48.3,59.3)` vs **外 12px 环** `(56.4,48.1,58.4)`，
 *   差 < 1 灰度 ⇒ **LyricsBlossom 原生没有任何文字辉光**。这里的辉光是 2026-10-01
 *   参考 Project Folia 引入的增强项；用户权衡后决定**保留但显著削弱**（而非移除），
 *   让"正在唱的字"仍有一点柔光但不再糊出光幕/过曝。
 *
 *   作用方式：同时缩**半径**（乘到 `glowEnvelope` 输出上）与**不透明度**（乘到 alpha 上），
 *   **不改变 `glowEnvelope` 的形状**（峰值仍在进度 30%，形状有单测钉死）。
 *   取值：`1` = folia 原始强度；`0.45` = 当前（约原来一半不到）；`0` = 视觉上等于关闭辉光
 *   （DOM 上仍会写入一条半径/alpha 全 0 的 text-shadow，以维持"任一时刻恰好 1 个光点"的契约）。
 */
export const MODENG_GLOW_GAIN = 0.45

/**
 * 短行自适应时长系数 —— 对齐 folia `renderHints` 的 micro / short 档。
 *
 * 行本身很短（快速念白、密集短句）时，0.3s 展开 + 0.45s 淡入还没走完就已切到下一行，
 * 会出现"刚要展开就被抽走"的抽搐。这里按行的演唱时长等比压缩进入动画窗口，下限 0.45
 * （仍保留可辨识的过渡）；正常长度（≥0.7s）的行系数恒为 1 → 行为与改动前完全一致。
 */
export const lineEnterFactor = (sungDurationSec: number): number => {
  if (!Number.isFinite(sungDurationSec) || sungDurationSec <= 0) return 1
  return Math.min(1, Math.max(0.45, sungDurationSec / 0.7))
}

/** 行进入时的峰值模糊（px @951 基准）—— 对齐 folia line enter 的 `blur(10px) → 0` */
export const ENTER_BLUR_PX = 6

/* ------------------------------------------------------------------ *
 * 四、Project Folia 增补 · 第二轮（2026-10-03）
 * ------------------------------------------------------------------ */

/** 一个罗马音词及其**绝对**时间窗（已对齐到主歌词的词时间窗）。 */
export interface ModengRomanSpan {
  text: string
  /** 绝对秒 */
  startTime: number
  endTime: number
  /** 对齐到的主歌词词下标；按比例铺排（未能一对一）时为 -1 */
  wordIndex: number
}

/**
 * 把 `line.romanWords` 对齐到主歌词的**词时间窗**，供当前行罗马音逐词点亮。
 *
 * 为什么需要这一步：`romanWords` 与 `words` 是两套独立数组，长度与切分口径都可能不同
 * （罗马音按音节切、歌词按词切），直接按下标取会错位。三条分支（与项目既有
 * `LyricsDisplay.alignRomanWordsToLyricTiming` 的语义保持一致，但此处独立实现，
 * 摩登不依赖其他歌词模式的模块）：
 *
 *   A. 长度相等 → 一一对应，直接复制主歌词词的时间窗（最可靠，绝大多数 AMLL 数据如此）；
 *   B. 罗马音自带递增时间 → 采信它自己的时间，向主歌词的整段区间内收（防止越界拖长）；
 *   C. 其余 → 按**字形数**加权，把罗马音铺满主歌词的整段演唱区间
 *      （用字形数而非词数加权：中英混排时「一个字」与「一个长单词」的演唱时长差很多）。
 *
 * 返回绝对秒（= line.time + 相对毫秒/1000），与 `ModengGlyph` 口径一致。
 *
 * 无 `romanWords`、无真实逐字数据、或无法定位主歌词词时返回 [] ——
 * 调用方退回原先的整行静态罗马音渲染，行为不变。
 */
export const buildRomanWordSpans = (line: LyricLine): ModengRomanSpan[] => {
  const romanWords = line.romanWords
  if (!romanWords || romanWords.length === 0) return []
  // 没有逐词时间就没有对齐参照（此时主歌词也不做逐字推进，罗马音保持一致）。
  if (!hasTrueWordTiming(line)) return []

  const roman = romanWords.filter(word => Boolean(word.word?.trim()))
  if (roman.length === 0) return []
  const lyricWords = prepareLyricWords(line).filter(word => !/^\s+$/u.test(word.word))
  if (lyricWords.length === 0) return []

  const toAbs = (relativeMs: number) => line.time + Math.max(0, relativeMs) / 1000
  const firstWord = lyricWords[0]
  const lastWord = lyricWords[lyricWords.length - 1]
  const sourceStart = toAbs(firstWord.startTime)
  const sourceEnd = Math.max(
    sourceStart + 0.001,
    toAbs(lastWord.startTime + Math.max(1, lastWord.duration)),
  )
  const clampToSource = (value: number) => Math.min(sourceEnd, Math.max(sourceStart, value))

  // —— A. 等长：一一对应 ——
  if (roman.length === lyricWords.length) {
    return roman.map((word, index) => {
      const source = lyricWords[index]
      const start = toAbs(source.startTime)
      return {
        text: word.word,
        startTime: start,
        endTime: start + Math.max(0.001, source.duration) / 1000,
        wordIndex: index,
      }
    })
  }

  // —— B. 自带递增时间：采信自身时间，向主歌词区间内收 ——
  const hasIncreasingTimes = roman.some((word, index) => (
    index > 0 && Number.isFinite(word.startTime) && word.startTime > roman[index - 1].startTime
  ))
  if (hasIncreasingTimes) {
    return roman.map((word, index) => {
      const start = clampToSource(toAbs(word.startTime))
      const nextStart = roman
        .slice(index + 1)
        .find(next => Number.isFinite(next.startTime) && next.startTime > word.startTime)?.startTime
      const rawEnd = toAbs(word.startTime + Math.max(1, word.duration))
      const end = clampToSource(Math.min(rawEnd, nextStart === undefined ? sourceEnd : toAbs(nextStart)))
      return { text: word.word, startTime: start, endTime: Math.max(start + 0.001, end), wordIndex: -1 }
    })
  }

  // —— C. 其余：按字形数加权铺满整段 ——
  const weights = roman.map(word => Math.max(1, segmentLyricGraphemes(word.word).length))
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0)
  const span = sourceEnd - sourceStart
  let elapsed = 0
  return roman.map((word, index) => {
    const start = sourceStart + span * (elapsed / totalWeight)
    elapsed += weights[index]
    const end = sourceStart + span * (elapsed / totalWeight)
    return { text: word.word, startTime: start, endTime: Math.max(start + 0.001, end), wordIndex: -1 }
  })
}

/**
 * 罗马音逐词混色端点（**弱化于主歌词**：罗马音是辅助信息，不该与主行抢视觉重心）。
 *
 * 主歌词未唱/已唱是 0.627 → 1.0（暗色），罗马音收窄到 0.40 → 0.86；
 * 亮色同理 0.40 → 0.80。唱完后的回退幅度沿用 `LB_AFTERGLOW.amount`（35%），
 * 与主歌词保持同一套手感，只是整体压低。
 */
export const ROMAN_COLOR = {
  dark: { sung: { r: 255, g: 255, b: 255, a: 0.86 }, unsung: { r: 235, g: 235, b: 245, a: 0.4 } },
  light: { sung: { r: 28, g: 28, b: 30, a: 0.8 }, unsung: { r: 60, g: 60, b: 67, a: 0.4 } },
} as const

/**
 * 罗马音逐词颜色：与主歌词同一套「线性混色 + 时间驱动尾焰」的算法，
 * 只把端点换成 `ROMAN_COLOR`（更收敛）。
 *
 * 之所以不复用主歌词的 `mixWordColor`：主歌词还要处理对唱色相（agent tint），
 * 罗马音不参与对唱取色；拆开后两边互不干扰，主歌词那支不必为罗马音加分支。
 */
export const romanWordColor = (
  progress: number,
  theme: 'dark' | 'light',
  sinceWordEndSec = 0,
): string => {
  const pair = ROMAN_COLOR[theme]
  const t = Math.min(1, Math.max(0, progress))
  const sung = pair.sung
  const unsung = pair.unsung

  // 尾焰：唱完后按与主歌词相同的 0.42s / 35% 缓动回退（算法见 LB_AFTERGLOW）。
  if (t >= 1 && sinceWordEndSec > 0) {
    const retreat = LB_AFTERGLOW.amount * easeInOutCubic(Math.min(1, sinceWordEndSec / LB_AFTERGLOW.duration))
    if (retreat > 0.001) {
      const mix = (from: number, to: number) => Math.round(from + (to - from) * retreat)
      const a = sung.a + (unsung.a - sung.a) * retreat
      return `rgba(${mix(sung.r, unsung.r)}, ${mix(sung.g, unsung.g)}, ${mix(sung.b, unsung.b)}, ${a.toFixed(3)})`
    }
  }

  // 未唱 → 已唱：ARGB 逐通道线性插值（与主歌词一致，不加缓动）。
  const channel = (from: number, to: number) => Math.round(from + (to - from) * t)
  const alpha = unsung.a + (sung.a - unsung.a) * t
  return `rgba(${channel(unsung.r, sung.r)}, ${channel(unsung.g, sung.g)}, ${channel(unsung.b, sung.b)}, ${alpha.toFixed(3)})`
}
