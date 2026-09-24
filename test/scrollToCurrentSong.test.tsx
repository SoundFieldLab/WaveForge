/** @vitest-environment jsdom */
// 「滚动到当前歌曲」浮标按钮的可见性回归测试。
// 该按钮此前 showButton 恒为 false（setter 从未被调用）→ 7 个调用点的浮标永不出现；
// 修复后按「列表可滚动 + 滚动超过 threshold + 当前歌曲整行滚出可视区」判定显示。
// jsdom 不产生真实布局，这里用 defineProperty 给容器装上可控的几何量（clientHeight/scrollHeight/scrollTop）。
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useRef } from 'react'
import ScrollToCurrentSong from '../src/components/ScrollToCurrentSong'

const VIEWPORT_HEIGHT = 500
const TOTAL_HEIGHT = 5000
const ROW_HEIGHT = 100

interface HarnessProps {
  currentSongIndex: number
  threshold?: number
  initialScrollTop?: number
}

function Harness({ currentSongIndex, threshold = 100, initialScrollTop = 0 }: HarnessProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  return (
    <div
      data-testid="scroll-container"
      ref={node => {
        containerRef.current = node
        if (!node) return
        Object.defineProperty(node, 'clientHeight', { value: VIEWPORT_HEIGHT, configurable: true })
        Object.defineProperty(node, 'scrollHeight', { value: TOTAL_HEIGHT, configurable: true })
        let top = initialScrollTop
        Object.defineProperty(node, 'scrollTop', {
          get: () => top,
          set: (value: number) => { top = value },
          configurable: true,
        })
      }}
    >
      <ScrollToCurrentSong
        containerRef={containerRef}
        currentSongIndex={currentSongIndex}
        threshold={threshold}
        cardsPerRow={1}
        cardHeight={ROW_HEIGHT}
        cardGapY={0}
        contentPaddingTop={0}
      />
    </div>
  )
}

const button = () => screen.queryByLabelText('滚动到当前歌曲')

afterEach(cleanup)

describe('ScrollToCurrentSong 浮标可见性', () => {
  it('当前歌曲就在可视区内时不显示', () => {
    render(<Harness currentSongIndex={0} />)
    expect(button()).toBeNull()
  })

  it('当前歌曲已滚出可视区，但滚动幅度未超过 threshold 时不显示', () => {
    // 第 11 行（1000~1100px）在 0~500 的可视区之外，但 scrollTop = 0
    render(<Harness currentSongIndex={10} threshold={100} initialScrollTop={0} />)
    expect(button()).toBeNull()
  })

  it('已滚动超过 threshold 且当前歌曲滚出可视区时显示', () => {
    // scrollTop = 101 已越过 threshold 100；可视区 101~601，当前行 1000~1100 在可视区之外
    render(<Harness currentSongIndex={10} threshold={100} initialScrollTop={101} />)
    expect(button()).not.toBeNull()
  })

  it('滚到当前歌曲所在位置（行重新进入可视区）时不显示', () => {
    // scrollTop = 900，可视区 900~1400，当前行 1000~1100 落在其中
    render(<Harness currentSongIndex={10} threshold={100} initialScrollTop={900} />)
    expect(button()).toBeNull()
  })

  it('列表不足以滚动时不显示', () => {
    const Tall = () => {
      const containerRef = useRef<HTMLDivElement>(null)
      return (
        <div
          data-testid="scroll-container"
          ref={node => {
            containerRef.current = node
            if (!node) return
            // 内容比视口还矮：scrollHeight === clientHeight
            Object.defineProperty(node, 'clientHeight', { value: VIEWPORT_HEIGHT, configurable: true })
            Object.defineProperty(node, 'scrollHeight', { value: VIEWPORT_HEIGHT, configurable: true })
            Object.defineProperty(node, 'scrollTop', { get: () => 0, set: () => {}, configurable: true })
          }}
        >
          <ScrollToCurrentSong containerRef={containerRef} currentSongIndex={10} threshold={100} />
        </div>
      )
    }
    render(<Tall />)
    expect(button()).toBeNull()
  })
})
