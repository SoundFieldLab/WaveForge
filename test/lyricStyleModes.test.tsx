/** @vitest-environment jsdom */
import { render, cleanup } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LyricsDisplay from '../src/components/LyricsDisplay'
import type { LyricLine } from '../src/services/musicApi'

/**
 * 歌词风格样式（柔和 / 摩登）与 Apple 特殊歌词（对唱左右分栏、背景和声）的渲染契约。
 * 风格由 lyricStyleMode 统一决定：
 *   柔和 = 柔光扩散逐字 + 传统滚动（非当前行缩小到 0.63×）
 *   摩登 = Apple 逐词点亮 + 弹簧滚动（各行同字号、SF Pro 字体、平台行视觉）
 */

const duetLyrics: LyricLine[] = [
  {
    time: 0,
    endTime: 2,
    text: 'first line here',
    words: [
      { word: 'first', startTime: 0, duration: 500 },
      { word: ' line', startTime: 500, duration: 500 },
      { word: ' here', startTime: 1000, duration: 1000 },
    ],
    agent: 'v1',
  },
  {
    time: 2,
    endTime: 4,
    text: 'second line now',
    words: [
      { word: 'second', startTime: 0, duration: 500 },
      { word: ' line', startTime: 500, duration: 500 },
      { word: ' now', startTime: 1000, duration: 1000 },
    ],
    agent: 'v2',
    isDuet: true,
    backgroundVocals: [{
      time: 2.2,
      endTime: 3.6,
      text: 'harmony here',
      words: [
        { word: 'harmony', startTime: 0, duration: 600 },
        { word: ' here', startTime: 600, duration: 700 },
      ],
      agentId: 'v2',
    }],
  },
  {
    time: 4,
    endTime: 6,
    text: 'third line back',
    words: [
      { word: 'third', startTime: 0, duration: 500 },
      { word: ' line', startTime: 500, duration: 500 },
      { word: ' back', startTime: 1000, duration: 1000 },
    ],
    agent: 'v1',
  },
]

const renderLyrics = (style: 'soft' | 'modern', currentTime = 2.6) => render(
  <LyricsDisplay
    currentTime={currentTime}
    isPlaying={false}
    accentColor="#ffffff"
    lyrics={duetLyrics}
    displayMode="scroll"
    lyricStyleMode={style}
  />,
)

const rowAt = (container: HTMLElement, index: number) =>
  container.querySelector(`[data-index="${index}"]`) as HTMLElement | null

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('appleMusicSettings', JSON.stringify({ duetColors: true }))
  vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
    observe() {}
    disconnect() {}
  })
  // jsdom 未实现滚动 API：传统滚动（classic）路径会调用 container.scrollTo
  Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('歌词风格样式', () => {
  it('摩登：非当前行与当前行同字号，并使用 Apple 行字体', () => {
    const { container } = renderLyrics('modern')
    const nonCurrentRow = rowAt(container, 0)
    const paragraph = nonCurrentRow?.querySelector('p') as HTMLParagraphElement | null
    expect(paragraph).toBeTruthy()
    // isModernScroll 下所有行同字号（不再缩到 0.63×）
    expect(paragraph!.style.fontSize).toBe('2.8rem')
  })

  it('柔和：非当前行缩小到 0.63×（传统滚动 + 柔光逐字）', () => {
    const { container } = renderLyrics('soft')
    const nonCurrentRow = rowAt(container, 0)
    const paragraph = nonCurrentRow?.querySelector('p') as HTMLParagraphElement | null
    expect(paragraph).toBeTruthy()
    expect(paragraph!.style.fontSize).toBe(`${2.8 * 0.63}rem`)
  })

  it('柔和与摩登都保留当前行全尺寸', () => {
    for (const style of ['soft', 'modern'] as const) {
      const { container } = renderLyrics(style)
      const currentRow = rowAt(container, 1)
      const paragraph = currentRow?.querySelector('p') as HTMLParagraphElement | null
      expect(paragraph!.style.fontSize).toBe('2.8rem')
      cleanup()
    }
  })
})

describe('逐字填充（连续光带）', () => {
  const spanMasks = (style: 'soft' | 'modern', currentTime: number) => {
    const { container } = renderLyrics(style, currentTime)
    const masks = Array.from(container.querySelectorAll('span'))
      .map(node => (node as HTMLElement).style.webkitMaskImage || (node as HTMLElement).style.maskImage || '')
      .filter(value => value.includes('linear-gradient'))
    cleanup()
    return masks
  }

  it('柔和：当前行用 span 级羽化填充层推进', () => {
    // currentTime 落在第一行第一个词的演唱区间内 → 出现从左推进的填充层
    expect(spanMasks('soft', 0.3).length).toBeGreaterThan(0)
  })

  it('摩登：当前行使用整行光带遮罩容器（AMLL 两档 alpha + em 羽化）', () => {
    const { container } = renderLyrics('modern', 0.3)
    // jsdom 会丢弃含 calc() / 斜杠 alpha 的 mask 值，这里以 mask-repeat 标记定位遮罩容器；
    // 渐变字符串本身的契约由 test/amllEmphasize.test.ts 的 buildLineBandMask 用例覆盖。
    const maskHost = Array.from(container.querySelectorAll('span'))
      .find(node => (node.getAttribute('style') || '').includes('mask-repeat'))
    expect(maskHost).toBeTruthy()
    // 遮罩容器必须是行内元素（<p> 内不能出现块级 <div>）
    expect(maskHost?.tagName).toBe('SPAN')
    cleanup()
  })

  it('摩登：遮罩挂在行内元素上（不产生 <p> 内的块级嵌套）', () => {
    const { container } = renderLyrics('modern', 0.3)
    const paragraph = container.querySelector('p')
    expect(paragraph?.querySelector('div')).toBeNull()
    cleanup()
  })

  it('摩登：长音字出现白色辉光（AM 版强调，而非柔和的彩色 sustainGlow）', () => {
    // 第二行 lineStart=2000，currentTime=3.6 → currentMs=1400，落在 ' now'（1000ms 长音）的强调区间
    const { container } = renderLyrics('modern', 3.6)
    const glows = Array.from(container.querySelectorAll('span'))
      .map(node => (node as HTMLElement).style.textShadow || '')
      .filter(value => value.includes('rgba(255, 255, 255,'))
    expect(glows.length).toBeGreaterThan(0)
  })
})

describe('Apple 对唱左右分栏', () => {
  it('对唱行靠右并让出左侧，其余行让出右侧', () => {
    const { container } = renderLyrics('modern')
    const firstRow = rowAt(container, 0)
    const duetRow = rowAt(container, 1)
    expect(duetRow!.style.textAlign).toBe('right')
    expect(duetRow!.style.paddingLeft).toBe('15%')
    expect(firstRow!.style.paddingRight).toBe('15%')
    expect(firstRow!.style.textAlign).toBe('')
  })

  it('没有对唱行时不产生左右分栏内缩', () => {
    const plain = duetLyrics.map(({ isDuet: _drop, ...rest }) => rest)
    const { container } = render(
      <LyricsDisplay
        currentTime={2.6}
        isPlaying={false}
        accentColor="#ffffff"
        lyrics={plain}
        displayMode="scroll"
        lyricStyleMode="modern"
      />,
    )
    for (const row of Array.from(container.querySelectorAll('[data-index]'))) {
      expect((row as HTMLElement).style.paddingRight).toBe('')
      expect((row as HTMLElement).style.paddingLeft).toBe('')
    }
  })

  it('沉浸式（居中）模式不做对唱分栏', () => {
    const { container } = render(
      <LyricsDisplay
        currentTime={2.6}
        isPlaying={false}
        accentColor="#ffffff"
        lyrics={duetLyrics}
        displayMode="single"
        lyricStyleMode="modern"
      />,
    )
    const rows = Array.from(container.querySelectorAll('[data-index]'))
    for (const row of rows) {
      expect((row as HTMLElement).style.paddingRight).toBe('')
    }
  })
})

describe('Apple 背景和声', () => {
  it('摩登：和声作为独立小字行、按自己的逐字时间拆分文本', () => {
    const { container } = renderLyrics('modern')
    const vocals = container.querySelectorAll('[data-testid="background-vocal"]')
    expect(vocals.length).toBe(1)
    const vocal = vocals[0] as HTMLElement
    // 不再使用括号包裹，且按 words 拆成多个 span（逐字点亮的基础）
    expect(vocal.textContent).toBe('harmony here')
    expect(vocal.textContent).not.toContain('（')
    const words = vocal.querySelectorAll('span')
    expect(words.length).toBe(2)
    expect(words[0].textContent).toBe('harmony')
  })

  it('柔和：和声保持整段文本（不做逐字拆分）', () => {
    const { container } = renderLyrics('soft')
    const vocal = container.querySelector('[data-testid="background-vocal"]') as HTMLElement
    expect(vocal.textContent).toBe('harmony here')
    expect(vocal.querySelectorAll('span').length).toBe(0)
  })

  it('和声继承对唱行的右对齐（靠右显示）', () => {
    const { container } = renderLyrics('modern')
    const duetRow = rowAt(container, 1)
    const vocal = duetRow!.querySelector('[data-testid="background-vocal"]') as HTMLElement
    // 和声所在行沿用该行左右分栏：靠右对齐 + 让出左侧
    const ownerRow = vocal.closest('[data-index]') as HTMLElement
    expect(ownerRow.style.textAlign).toBe('right')
    expect(ownerRow.style.paddingLeft).toBe('15%')
  })
})
