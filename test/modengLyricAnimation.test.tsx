/** @vitest-environment jsdom */
/**
 * 摩登歌词模式动画精细化（2026-10-01 / 2026-10-03，参考 Project Folia）验证。
 *
 * 覆盖四件事：
 *   ① 动画底座的纯函数（字形切分 / 亚帧合并 / 辉光包络 / 尾焰缓动 / 短行系数 / 罗马音对齐）
 *      —— 可直接断言数学性质；
 *   ② 逐字形推进（同一词内多字不再齐亮、颜色随演唱进度单调推进）；
 *   ③ 单点流动辉光（任一时刻最多一个字带 text-shadow，且随时间在字之间移动）
 *      与尾焰（唱完后的颜色随时间缓动回退）；辉光强度受 `MODENG_GLOW_GAIN` 削弱（2026-10-07）；
 *   ④ 罗马音逐词点亮（2026-10-03）与当前行罗马音配色修正；
 *   ⑤ 右下角按钮组（2026-10-12 新增「播放列表」按钮，与翻译/罗马音同组同尺寸）。
 *
 * ⚠ 本文件只针对摩登模式；不触碰其它歌词模式的断言。
 */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlaybackTimeStore } from '../src/audio/playbackTimeStore'
import ModengPlayerPage from '../src/components/ModengPlayerPage'
import {
  buildLineGlyphs,
  buildRomanWordSpans,
  easeInOutCubic,
  glowEnvelope,
  LB_AFTERGLOW,
  lineEnterFactor,
  MODENG_GLOW_GAIN,
  romanWordColor,
  SUB_FRAME_GLYPH_SEC,
} from '../src/components/modengLyricMotion'
import type { LyricLine } from '../src/services/musicApi'

/** 两行逐字歌词：第一行 2 个词 × 2 个字，第二行仅用于让第一行有「下一句」参照。 */
const glyphLyrics: LyricLine[] = [
  {
    time: 10,
    endTime: 11,
    text: '美人画卷',
    words: [
      { word: '美人', startTime: 0, duration: 400 },
      { word: '画卷', startTime: 400, duration: 400 },
    ],
  },
  {
    time: 11,
    endTime: 12,
    text: '残留',
    words: [{ word: '残留', startTime: 0, duration: 500 }],
  },
]

/** 无逐字数据（no_syllable）的行：只做整行线性推进，不拆字形。 */
const plainLyrics: LyricLine[] = [
  { time: 10, endTime: 12, text: '整行无逐字数据' },
  { time: 12, endTime: 14, text: '下一句' },
]

/** 罗马音与主歌词词数**相同**（2 : 2）→ 走「一一对应」分支。 */
const romanEvenLyrics: LyricLine[] = [
  {
    time: 10,
    endTime: 11,
    text: '美人画卷',
    words: [
      { word: '美人', startTime: 0, duration: 400 },
      { word: '画卷', startTime: 400, duration: 400 },
    ],
    romanWords: [
      { word: 'mei', startTime: 0, duration: 0 },
      { word: 'ren', startTime: 0, duration: 0 },
    ],
  },
  {
    time: 11,
    endTime: 12,
    text: '残留余音',
    // 第二行同样具备「可逐词点亮」的条件（2 个词 + 等长罗马音）：
    //   用于验证**只有当前行**才渲染逐词 span，非当前行退回静态整行渲染。
    words: [
      { word: '残留', startTime: 0, duration: 240 },
      { word: '余音', startTime: 240, duration: 240 },
    ],
    romanWords: [
      { word: 'can', startTime: 0, duration: 0 },
      { word: 'liu', startTime: 0, duration: 0 },
    ],
  },
]

/** 罗马音(3) 与主歌词词数(2) **不同**、且自身无递增时间 → 走「按字形数加权铺满」分支。 */
const romanUnevenLyrics: LyricLine[] = [
  {
    time: 10,
    endTime: 11,
    text: '美人画卷',
    words: [
      { word: '美人', startTime: 0, duration: 400 },
      { word: '画卷', startTime: 400, duration: 400 },
    ],
    romanWords: [
      { word: 'mei', startTime: 0, duration: 0 },
      { word: 'ren', startTime: 0, duration: 0 },
      { word: 'huajuan', startTime: 0, duration: 0 },
    ],
  },
]

/** 词的「单字形时间窗」低于亚帧阈值：3 个字挤进 0.09s → 每个 30ms < 50ms。 */
const subFrameWordLyrics: LyricLine[] = [
  {
    time: 10,
    endTime: 11,
    text: '四个字啊',
    words: [
      { word: '四个字', startTime: 0, duration: 90 },
      { word: '啊', startTime: 90, duration: 300 },
    ],
  },
]

const parseColor = (value: string) => {
  const match = value.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/)
  if (!match) return null
  return {
    r: Number(match[1]),
    g: Number(match[2]),
    b: Number(match[3]),
    a: match[4] === undefined ? 1 : Number(match[4]),
  }
}

const renderModeng = (
  lyrics: LyricLine[],
  currentTime: number,
  extra: { romanEnabled?: boolean; onOpenPlaylist?: () => void } = {},
) => {
  const store = createPlaybackTimeStore({ currentTime, duration: 200, isPlaying: false })
  const view = render(
    <ModengPlayerPage
      lyrics={lyrics}
      currentIndex={0}
      playbackTimeStore={store}
      timeOffset={0}
      isPlaying={false}
      accentColor="#ffffff"
      playerTheme="dark"
      songTitle="Song"
      songArtist="Artist"
      {...extra}
    />,
  )
  return { store, view }
}

const glyphNodes = (view: ReturnType<typeof render>) =>
  Array.from(view.container.querySelectorAll<HTMLElement>('.modeng-glyph'))

const romanNodes = (view: ReturnType<typeof render>) =>
  Array.from(view.container.querySelectorAll<HTMLElement>('.modeng-roman-word'))

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
    observe() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('摩登动画底座 · 纯函数', () => {
  it('按「词 → 字形」二维切分，并在词内均分时间', () => {
    const grouped = buildLineGlyphs(glyphLyrics[0])

    expect(grouped).toHaveLength(2)
    expect(grouped[0].map(g => g.text)).toEqual(['美', '人'])
    expect(grouped[1].map(g => g.text)).toEqual(['画', '卷'])
    // 词 0 绝对时间 10.0 → 10.4，两字均分 → 每字 0.2s
    expect(grouped[0][0].startTime).toBeCloseTo(10, 5)
    expect(grouped[0][0].endTime).toBeCloseTo(10.2, 5)
    expect(grouped[0][1].startTime).toBeCloseTo(10.2, 5)
    expect(grouped[0][1].endTime).toBeCloseTo(10.4, 5)
    // wordIndex 用于做词下标，必须与 buildLineWords 对齐
    expect(grouped[0][0].glyphIndex).toBe(0)
    expect(grouped[1][0].glyphIndex).toBe(0)
  })

  it('无真实逐字数据时返回空（调用方退回整行推进）', () => {
    expect(buildLineGlyphs(plainLyrics[0])).toEqual([])
  })

  it('辉光包络：两端为 0、峰值 1 落在进度 30%，先升后降', () => {
    expect(glowEnvelope(0)).toBe(0)
    expect(glowEnvelope(1)).toBe(0)
    expect(glowEnvelope(-0.5)).toBe(0)
    expect(glowEnvelope(0.3)).toBeCloseTo(1, 5)
    // 单调升 / 单调降
    expect(glowEnvelope(0.1)).toBeLessThan(glowEnvelope(0.2))
    expect(glowEnvelope(0.2)).toBeLessThan(glowEnvelope(0.3))
    expect(glowEnvelope(0.5)).toBeGreaterThan(glowEnvelope(0.8))
    expect(glowEnvelope(0.8)).toBeGreaterThan(0)
  })

  it('尾焰缓动：0.5s 词唱完后 0.42s 内完成 35% 回退，起点无跳变', () => {
    expect(LB_AFTERGLOW.amount).toBeCloseTo(0.35, 5)
    expect(LB_AFTERGLOW.duration).toBeCloseTo(0.42, 5)
    // 起点导数为 0 → 与「刚唱完」的 sung 色无缝衔接
    expect(easeInOutCubic(0)).toBe(0)
    expect(easeInOutCubic(0.001)).toBeLessThan(0.001)
    expect(easeInOutCubic(0.5)).toBeCloseTo(0.5, 5)
    expect(easeInOutCubic(1)).toBe(1)
  })

  it('短行自适应系数：正常行恒为 1，极短行压到下限 0.45', () => {
    expect(lineEnterFactor(0.7)).toBe(1)
    expect(lineEnterFactor(3)).toBe(1)
    expect(lineEnterFactor(0.35)).toBeCloseTo(0.5, 5)
    expect(lineEnterFactor(0.05)).toBeCloseTo(0.45, 5)
    // 非常规输入不产生 NaN（否则会污染行进入动画的曲线时长）
    expect(lineEnterFactor(0)).toBe(1)
    expect(lineEnterFactor(Number.NaN)).toBe(1)
  })
})

describe('摩登当前行 · 逐字形推进', () => {
  it('把词拆成字形节点，且同一词内的字各自按自己的时间窗推进', () => {
    // t = 10.3 → 「美」已唱完（10.0~10.2）、「人」正在唱（10.2~10.4）、「画」「卷」未唱
    const { view } = renderModeng(glyphLyrics, 10.3)
    const glyphs = glyphNodes(view)

    expect(glyphs.map(node => node.textContent)).toEqual(['美', '人', '画', '卷'])

    const alpha = glyphs.map(node => parseColor(node.style.color)?.a ?? -1)
    // 正在唱的「人」必须比未唱的「画」「卷」更亮 —— 这就是"逐字推进"而非"整行齐亮"
    expect(alpha[1]).toBeGreaterThan(alpha[2])
    expect(alpha[1]).toBeGreaterThan(alpha[3])
    expect(alpha[2]).toBeCloseTo(alpha[3], 5)
    // 同一词内两字亮度不同（旧实现是整词同色）
    expect(alpha[0]).not.toBeCloseTo(alpha[1], 3)
  })

  it('无逐字数据的行不产生字形节点（其他行为不变）', () => {
    const { view } = renderModeng(plainLyrics, 10.5)
    expect(glyphNodes(view)).toHaveLength(0)
  })

  it('唱完的字色随时间缓动回退（尾焰），而不是瞬间变灰', () => {
    // 「美」在 10.2 唱完：紧接其后的时刻接近满亮，约 0.42s 后回退到 35% 处的稳态
    const early = glyphNodes(renderModeng(glyphLyrics, 10.21).view)
    const late = glyphNodes(renderModeng(glyphLyrics, 10.62).view)

    const aEarly = parseColor(early[0].style.color)?.a ?? -1
    const aLate = parseColor(late[0].style.color)?.a ?? -1
    expect(aEarly).toBeGreaterThan(aLate)
    expect(aLate).toBeLessThan(1)
    expect(aLate).toBeGreaterThan(0.627) // 回退终点是 unsung 色（0.627）之上的 35% 处
  })
})

describe('摩登当前行 · 单点流动辉光', () => {
  it('任一时刻最多一个字带辉光，且辉光随时间在字之间移动', () => {
    const at25 = glyphNodes(renderModeng(glyphLyrics, 10.25).view)
    const at45 = glyphNodes(renderModeng(glyphLyrics, 10.45).view)

    const glowing = (nodes: HTMLElement[]) => nodes.filter(node => node.style.textShadow)
    const glowAt25 = glowing(at25)
    const glowAt45 = glowing(at45)

    // 10.25s：正在唱「人」(10.2~10.4)
    expect(glowAt25).toHaveLength(1)
    expect(glowAt25[0].textContent).toBe('人')
    // 10.45s：正在唱「画」(10.4~10.6) —— 光点已移到下一个字
    expect(glowAt45).toHaveLength(1)
    expect(glowAt45[0].textContent).toBe('画')
  })

  it('辉光按字形进度"先盛后敛"（峰值落在进度 30%，不是全程等强）', () => {
    // 同一个字「人」：进度 0.25（接近峰值）对比 0.6（已过峰值、正在收敛）
    const near = glyphNodes(renderModeng(glyphLyrics, 10.25).view).find(node => node.style.textShadow)
    const late = glyphNodes(renderModeng(glyphLyrics, 10.32).view).find(node => node.style.textShadow)

    expect(near?.textContent).toBe('人')
    expect(late?.textContent).toBe('人')

    const radius = (node: HTMLElement) => Number(node.style.textShadow.match(/0 0 ([\d.]+)em/)?.[1] ?? Number.NaN)
    expect(radius(near!)).toBeGreaterThan(radius(late!))
  })

  it('行唱完后不留辉光（光点不会停在最后一个字上）', () => {
    const after = glyphNodes(renderModeng(glyphLyrics, 10.9).view)
    expect(after.filter(node => node.style.textShadow)).toHaveLength(0)
  })

  // ▼ 2026-10-07：依据 LyricsBlossom 实机录屏（BV1JnE96PEuN）—— 其原生**无任何文字辉光**
  //   （已唱字外 3px 环 vs 12px 环差 <1 灰度），本辉光为 folia 增强项，用户决定**保留但削弱**。
  //   本用例把"已削弱"钉住：强度旋钮在 (0,1)，且实际写出的半径 / alpha 都按该旋钮等比缩过，
  //   防止日后被无意改回 folia 全强度。
  it('辉光强度已按 MODENG_GLOW_GAIN 削弱（半径与 alpha 等比下调，不回到 folia 全强度）', () => {
    expect(MODENG_GLOW_GAIN).toBeGreaterThan(0)
    expect(MODENG_GLOW_GAIN).toBeLessThan(1)

    // 10.26s → 字形「人」进度恰好 0.3 → 包络取峰值 1，是强度最大的时刻
    const peak = glyphNodes(renderModeng(glyphLyrics, 10.26).view).find(node => node.style.textShadow)
    expect(peak?.textContent).toBe('人')
    const shadow = peak!.style.textShadow

    // 两条 text-shadow 的模糊半径（em）
    const radii = [...shadow.matchAll(/([\d.]+)em/g)].map(m => Number(m[1]))
    expect(radii).toHaveLength(2)
    // 严格低于 folia 原始基准 0.42em / 0.83em
    expect(radii[0]).toBeLessThan(0.42)
    expect(radii[1]).toBeLessThan(0.83)
    // 且精确等于「基准 × 旋钮」
    expect(radii[0]).toBeCloseTo(0.42 * MODENG_GLOW_GAIN, 2)
    expect(radii[1]).toBeCloseTo(0.83 * MODENG_GLOW_GAIN, 2)

    // alpha 同样乘了该旋钮（暗色主题基准 0.55）
    const alpha = Number(shadow.match(/rgba\([^)]*,\s*([\d.]+)\)/)?.[1] ?? Number.NaN)
    expect(alpha).toBeGreaterThan(0)
    expect(alpha).toBeLessThan(0.55)
    expect(alpha).toBeCloseTo(0.55 * MODENG_GLOW_GAIN, 2)

    // 削弱只改强弱、不改包络形状（峰值仍落在进度 30%）—— 与上面纯函数断言互补
    expect(glowEnvelope(0.3)).toBeCloseTo(1, 5)
  })
})

describe('摩登动画底座 · 罗马音对齐（2026-10-03）', () => {
  it('罗马音与主歌词词数相同时一一对应，沿用主歌词的词时间窗', () => {
    const spans = buildRomanWordSpans(romanEvenLyrics[0])

    expect(spans.map(s => s.text)).toEqual(['mei', 'ren'])
    expect(spans.map(s => s.wordIndex)).toEqual([0, 1])
    // 主歌词词 0 = 10.0~10.4、词 1 = 10.4~10.8
    expect(spans[0].startTime).toBeCloseTo(10, 5)
    expect(spans[0].endTime).toBeCloseTo(10.4, 5)
    expect(spans[1].startTime).toBeCloseTo(10.4, 5)
    expect(spans[1].endTime).toBeCloseTo(10.8, 5)
  })

  it('词数不等且无自带时间时，按字形数加权铺满整段（长词窗口更长、首尾贴合）', () => {
    const spans = buildRomanWordSpans(romanUnevenLyrics[0])

    expect(spans.map(s => s.text)).toEqual(['mei', 'ren', 'huajuan'])
    expect(spans.map(s => s.wordIndex)).toEqual([-1, -1, -1])
    // 铺满主歌词整段 10.0 → 10.8，且相邻首尾相接（不留空洞、不重叠）
    expect(spans[0].startTime).toBeCloseTo(10, 5)
    expect(spans[2].endTime).toBeCloseTo(10.8, 5)
    expect(spans[0].endTime).toBeCloseTo(spans[1].startTime, 5)
    expect(spans[1].endTime).toBeCloseTo(spans[2].startTime, 5)
    // 'huajuan'(7 字形) 的窗口必须比 'mei'(3 字形) 长
    const width = (span: { startTime: number; endTime: number }) => span.endTime - span.startTime
    expect(width(spans[2])).toBeGreaterThan(width(spans[0]))
  })

  it('无罗马音数据 / 无逐字数据时返回空（调用方退回静态整行渲染）', () => {
    expect(buildRomanWordSpans(glyphLyrics[0])).toEqual([])
    expect(buildRomanWordSpans(plainLyrics[0])).toEqual([])
    expect(buildRomanWordSpans({ ...romanUnevenLyrics[0], romanWords: [] })).toEqual([])
  })

  it('罗马音混色端点比主歌词收敛，且带与主歌词同一套时间驱动尾焰', () => {
    const alpha = (color: string) => parseColor(color)?.a ?? -1
    // 未唱 → 已唱单调变亮，端点是 0.40 / 0.86
    expect(alpha(romanWordColor(0, 'dark'))).toBeCloseTo(0.4, 3)
    expect(alpha(romanWordColor(0.5, 'dark'))).toBeGreaterThan(alpha(romanWordColor(0, 'dark')))
    expect(alpha(romanWordColor(1, 'dark'))).toBeCloseTo(0.86, 3)
    // 弱于主歌词（主行暗色是 0.627 → 1.0）—— 罗马音不该抢主行重心
    expect(alpha(romanWordColor(1, 'dark'))).toBeLessThan(1)
    // 唱完后 0.42s 缓动回退 35%，起点无跳变（sinceWordEndSec = 0 时仍是最亮的 sung 色）
    expect(alpha(romanWordColor(1, 'dark', 0))).toBeCloseTo(0.86, 3)
    const settled = alpha(romanWordColor(1, 'dark', LB_AFTERGLOW.duration))
    expect(settled).toBeLessThan(0.86)
    expect(settled).toBeCloseTo(0.86 - (0.86 - 0.4) * LB_AFTERGLOW.amount, 3)
    // 亮色主题同样成立
    expect(alpha(romanWordColor(0, 'light'))).toBeCloseTo(0.4, 3)
    expect(alpha(romanWordColor(1, 'light'))).toBeCloseTo(0.8, 3)
  })
})

describe('摩登动画底座 · 亚帧字形窗口防护（2026-10-03）', () => {
  it('单字形窗口短于阈值时，该词并回一个字形（整词一个时间窗）', () => {
    // 0.09s / 3 字 = 30ms < 50ms
    expect(SUB_FRAME_GLYPH_SEC).toBeCloseTo(0.05, 5)
    const grouped = buildLineGlyphs(subFrameWordLyrics[0])

    // 词 0「四个字」并回单个字形，文本拼回原词
    expect(grouped[0]).toHaveLength(1)
    expect(grouped[0][0].text).toBe('四个字')
    expect(grouped[0][0].startTime).toBeCloseTo(10, 5)
    expect(grouped[0][0].endTime).toBeCloseTo(10.09, 5)
    // 词 1「啊」本来就只有 1 个字形，行为不变
    expect(grouped[1]).toHaveLength(1)
    expect(grouped[1][0].text).toBe('啊')
  })

  it('字形窗口足够长时保持逐字拆分（不受亚帧防护影响）', () => {
    // 0.4s / 2 字 = 200ms ≫ 50ms
    const grouped = buildLineGlyphs(glyphLyrics[0])
    expect(grouped[0].map(g => g.text)).toEqual(['美', '人'])
    expect(grouped[1].map(g => g.text)).toEqual(['画', '卷'])
  })
})

describe('摩登当前行 · 罗马音逐词点亮（2026-10-03）', () => {
  it('当前行罗马音拆成逐词节点，颜色随演唱进度推进（不是整行同色）', () => {
    const early = romanNodes(renderModeng(romanEvenLyrics, 10.1, { romanEnabled: true }).view)
    const later = romanNodes(renderModeng(romanEvenLyrics, 10.5, { romanEnabled: true }).view)

    expect(early.map(node => node.textContent)).toEqual(['mei', 'ren'])

    const alpha = (node: HTMLElement) => parseColor(node.style.color)?.a ?? -1
    // 10.1s：'mei' 唱到 25%、'ren' 未开始 → 前词更亮（逐词推进）
    expect(alpha(early[0])).toBeGreaterThan(alpha(early[1]))
    // 10.5s：两词都比 10.1s 更亮（各自按自己的时间窗推进）
    expect(alpha(later[0])).toBeGreaterThan(alpha(early[0]))
    expect(alpha(later[1])).toBeGreaterThan(alpha(early[1]))
  })

  it('只有当前行渲染逐词节点，非当前行退回静态整行渲染', () => {
    const view = renderModeng(romanEvenLyrics, 10.1, { romanEnabled: true }).view
    // 两行都有罗马音，但只有当前行拆成逐词节点 → 节点数 = 当前行的罗马音词数
    expect(romanNodes(view)).toHaveLength(2)
    expect(view.container.querySelectorAll('[data-testid="modeng-roman"]')).toHaveLength(1)
  })

  it('当前行罗马音行取当前行基础色（不退化成距离兜底的 0.15）', () => {
    const view = renderModeng(romanEvenLyrics, 10.1, { romanEnabled: true }).view
    const row = view.container.querySelector<HTMLElement>('[data-testid="modeng-roman"]')

    expect(row).not.toBeNull()
    // 暗色当前行未唱色 rgba(235,235,245,0.627)
    expect(parseColor(row!.style.color)?.a).toBeCloseTo(0.627, 3)
  })
})

// ▼ 2026-10-12：右下角按钮组新增「播放列表」按钮（用户要求「与罗马音翻译那些按钮对齐」）。
//   对齐不是靠手调数值，而是靠**同容器 + 同尺寸类**——本组就是断言这件事，防止日后被单独改样式。
describe('摩登播放页 · 右下角按钮组（2026-10-12）', () => {
  it('新增「播放列表」按钮，与翻译/罗马音同容器、同尺寸（天然对齐）', () => {
    const view = renderModeng(glyphLyrics, 10.1).view
    const playlist = view.getByLabelText('播放列表')
    const translate = view.getByLabelText('翻译')
    const roman = view.getByLabelText('罗马音')

    // 三者同属右下角那一组 → 同一个 flex 容器、同一个 gap
    expect(playlist.parentElement).toBe(translate.parentElement)
    expect(playlist.parentElement).toBe(roman.parentElement)
    expect(playlist.parentElement!.style.gap).toBe(translate.parentElement!.style.gap)
    expect(playlist.parentElement!.style.gap).not.toBe('')

    // 尺寸与样式类完全一致（对齐的必要条件）
    for (const key of ['width', 'height'] as const) {
      expect(playlist.style[key]).toBe(translate.style[key])
      expect(playlist.style[key]).toBe(roman.style[key])
    }
    expect(playlist.className).toBe(roman.className)
    // 同一行：纵向偏移为 0（flex items-center）
    expect(playlist.parentElement!.className).toContain('items-center')
  })

  it('点击触发上层回调；未传回调时按钮禁用（不留"点了没反应"的死按钮）', () => {
    const onOpenPlaylist = vi.fn()
    const withCallback = renderModeng(glyphLyrics, 10.1, { onOpenPlaylist }).view
    fireEvent.click(withCallback.getByLabelText('播放列表'))
    expect(onOpenPlaylist).toHaveBeenCalledTimes(1)

    // getByLabelText 是文档级查询：第二次 render 前必须先清理，否则命中两份 DOM
    cleanup()
    const withoutCallback = renderModeng(glyphLyrics, 10.1).view
    expect((withoutCallback.getByLabelText('播放列表') as HTMLButtonElement).disabled).toBe(true)
  })
})
