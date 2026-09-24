/**
 * 队列窗口化回归（源码断言）。
 *
 * 起因：ResonanceRoom 的队列虚拟列表写死了「渲染 12 行」，
 * 可视区高于 12 行（1440p 等大窗口）时，列表尾部在任何滚动位置都渲染不出来（底部一片空白）。
 * 这里既断言源码里不再写死行数，也复算一遍窗口几何，确保滚到底时最后一行一定被覆盖。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(__dirname, '..')
const source = (path: string) => readFileSync(resolve(root, path), 'utf8')

const ROOM = 'src/features/resonance/ResonanceRoom.tsx'

/** 常量从源码里读出来，避免测试与组件两处各写一份而漂移 */
function readNumber(name: string): number {
  const match = source(ROOM).match(new RegExp(`const ${name} = (\\d+)`))
  if (!match) throw new Error(`源码里找不到 ${name}`)
  return Number(match[1])
}

function windowFor(queueLength: number, viewportHeight: number, scrollTop: number, rowHeight: number, minRows: number, overscan: number) {
  const visibleRowCount = Math.max(minRows, Math.ceil(viewportHeight / rowHeight) + overscan * 2)
  const firstRow = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  return { firstRow, end: Math.min(queueLength, firstRow + visibleRowCount) }
}

describe('队列窗口化：按可视区高度渲染，滚到底覆盖最后一行', () => {
  const rowHeight = readNumber('ROW_HEIGHT')
  const minRows = readNumber('VISIBLE_ROWS')
  const overscan = readNumber('OVERSCAN_ROWS')

  it('源码按可视区高度算行数，不再写死固定行数', () => {
    const room = source(ROOM)
    // 必须监听容器高度（ResizeObserver），否则大窗口下尾部永远取不到
    expect(room).toContain('ResizeObserver')
    expect(room).toContain('queueViewportHeight')
    expect(room).toContain('Math.ceil(queueViewportHeight / ROW_HEIGHT)')
    // 旧的「固定 12 行」写法必须已经消失
    expect(room).not.toContain('firstRow + VISIBLE_ROWS + 4')
  })

  it('各种可视区高度 + 队列长度下，滚到底都能渲染到最后一行', () => {
    for (const viewport of [320, 512, 640, 768, 900, 1200, 1600, 2160]) {
      for (const length of [1, 5, 12, 13, 40, 300]) {
        const maxScroll = Math.max(0, length * rowHeight - viewport)
        const { firstRow, end } = windowFor(length, viewport, maxScroll, rowHeight, minRows, overscan)
        expect(end, `viewport=${viewport} length=${length} 时应渲染到最后一行`).toBe(length)
        if (length > 0) expect(firstRow).toBeLessThan(length)
      }
    }
  })

  it('可视区高于 12 行时，旧的固定 12 行算法确实会漏掉尾部（对照组）', () => {
    const viewport = 1600
    const length = 40
    const maxScroll = length * rowHeight - viewport
    const oldFirst = Math.max(0, Math.floor(maxScroll / rowHeight) - 2)
    expect(oldFirst + 12).toBeLessThan(length)
    expect(windowFor(length, viewport, maxScroll, rowHeight, minRows, overscan).end).toBe(length)
  })
})
