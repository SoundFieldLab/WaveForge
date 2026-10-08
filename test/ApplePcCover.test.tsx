/** @vitest-environment jsdom */
// Apple 复刻页封面行为测试（2026-10-08 用户反馈「封面破图 + 排版塌」后新增）：
//  · 尺寸类必须挂在封面最外层容器上——图片未加载/加载失败时卡片也保持客户端版式
//  · 广播/主页的货架布局已改为直接嵌入探索面板（AppleExplorePanel），本文件只测封面/网格基件
//  · 加载失败时走中性占位（fallback），不再把浏览器的「破图 + alt 文本」留在页面上
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, within } from '@testing-library/react'
import { ApplePcCardGrid, ApplePcCover, applePcTheme } from '../src/features/traditionalPc/applePcKit'

const theme = applePcTheme('light')

describe('Apple 复刻页封面', () => {
  afterEach(() => cleanup())

  it('尺寸类挂在最外层：图片失败也不影响卡片版式', () => {
    const { container } = render(
      <ApplePcCover src="https://is1-ssl.mzstatic.com/x/{w}x{h}bb.jpg" alt="测试电台" className="aspect-[500/324] w-full" />,
    )
    const outer = container.firstElementChild as HTMLElement
    expect(outer.className).toContain('aspect-[500/324]')
    expect(outer.className).toContain('w-full')
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    // 图片层铺满外层（CachedImage 的包裹层 absolute inset-0），不参与撑高
    const layer = img.parentElement as HTMLElement
    expect(layer.className).toContain('absolute')
    expect(layer.className).toContain('inset-0')
    expect(layer.className).toContain('h-full')
  })

  it('封面加载失败 → 显示中性占位，且不再保留破图 <img alt>', async () => {
    const { container } = render(
      <ApplePcCover src="https://is1-ssl.mzstatic.com/image/thumb/broken/{w}x{h}bb.jpg" alt="坏封面电台" className="aspect-[500/324] w-full" />,
    )
    const img = container.querySelector('img') as HTMLImageElement
    expect(img).toBeTruthy()
    fireEvent.error(img)
    await waitFor(() => {
      expect(screen.getByLabelText('坏封面电台 封面占位')).toBeTruthy()
    })
    // 破图元素被移除（fallback 接管）
    expect(container.querySelector('img')).toBeNull()
    // 版式仍在
    const outer = container.firstElementChild as HTMLElement
    expect(outer.className).toContain('aspect-[500/324]')
  })

  it('网格卡：方形封面 + 标题副标题（图缺省时也保形）', () => {
    render(<ApplePcCardGrid theme={theme} items={[{ key: 'a1', title: '专辑甲', subtitle: '歌手甲' }]} />)
    const cell = screen.getByText('专辑甲').closest('button') as HTMLElement
    expect(within(cell).getByText('歌手甲')).toBeTruthy()
    expect(cell.querySelector('.aspect-square')).toBeTruthy()
  })
})
