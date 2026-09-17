/** @vitest-environment jsdom */
/**
 * 歌单详情面板开/关生命周期回归。
 *
 * 修的是关闭掉帧与封面闪烁：关闭时若同帧把面板与数据一起卸掉，面板内部
 * AnimatePresence 的 exit 永远不执行（面板"直接消失"不成动画），封面与动态封面
 * HLS 也在同一帧被销毁，同时 60px 封面模糊 + 80px backdrop-filter 一起重排。
 *
 * 这里锁住三件事：
 *  1. 关闭只置可见性：退场动画跑完前，面板 DOM、歌曲行与动态封面都还在；
 *  2. 退场期间玻璃层（backdrop-filter）已摘掉，退场只剩 transform/opacity；
 *  3. 退场结束后才回调 onExitComplete（调用方据此释放数据），且退场中重新打开
 *     不会把已就绪的封面/HLS 打回重建。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import PlaylistDetailPanel from '../src/components/PlaylistDetailPanel'
import type { Song } from '../src/services/musicApi'

const hlsState = vi.hoisted(() => ({ instances: [] as any[], destroyed: 0 }))

vi.mock('hls.js', () => ({
  default: class FakeHls {
    static isSupported = () => true
    static Events = { ERROR: 'error', MANIFEST_PARSED: 'manifest' }
    destroyed = false
    constructor() { hlsState.instances.push(this) }
    on() {}
    attachMedia() {}
    loadSource() {}
    destroy() { this.destroyed = true; hlsState.destroyed += 1 }
  },
}))

vi.mock('../src/services/appleWebService', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/appleWebService')>()
  return { ...actual, fetchApplePlaylistMotion: vi.fn() }
})

vi.mock('../src/services/artworkLoader', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/artworkLoader')>()
  return {
    ...actual,
    preloadArtwork: vi.fn(() => new Promise(() => {})),
    getResolvedArtworkUrl: (src: string) => src,
    getArtworkCacheKey: () => null,
  }
})

const { fetchApplePlaylistMotion } = await import('../src/services/appleWebService')
const motionMock = vi.mocked(fetchApplePlaylistMotion)

const song = (id: number): Song => ({
  id,
  name: `Song ${id}`,
  artists: [{ id: 1, name: 'Artist' }],
  album: { name: 'Album', picUrl: '' },
  duration: 200000,
  platform: 'apple',
})

const playlist = (id: string, name: string) => ({
  id,
  playId: id,
  name,
  coverImgUrl: `https://example.test/${id}.jpg`,
  trackCount: 3,
  platform: 'apple' as const,
})

/** 可控开关的宿主：模拟 App.tsx 里"可见性与数据分离"的用法。 */
function Host({ onExitComplete }: { onExitComplete?: () => void }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button onClick={() => setOpen(true)}>open</button>
      <button onClick={() => setOpen(false)}>close</button>
      <PlaylistDetailPanel
        show={open}
        playlist={playlist('pl.1', 'Test Playlist')}
        songs={[song(1), song(2), song(3)]}
        loading={false}
        onClose={() => setOpen(false)}
        onExitComplete={onExitComplete}
        onSongSelect={vi.fn()}
        currentPlatform="apple"
      />
    </>
  )
}

beforeEach(() => {
  hlsState.instances.length = 0
  hlsState.destroyed = 0
  motionMock.mockReset()
  motionMock.mockResolvedValue({ video: 'https://example.test/motion.m3u8', poster: '' } as any)
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
    unobserve() {}
  })
  // jsdom 未实现 HTMLMediaElement.play/pause（play 返回 undefined 而非 Promise，
  // 组件里的 .catch 会抛）。补最小实现，让动态封面生命周期可测。
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    this.dispatchEvent(new Event('loadeddata'))
    return Promise.resolve()
  })
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const click = (name: string) => {
  const button = screen.getByRole('button', { name })
  act(() => { button.click() })
}

const findByText = async (text: string) => {
  await vi.waitFor(() => expect(screen.queryByText(text)).not.toBeNull(), { timeout: 5000 })
  return screen.getByText(text)
}

describe('PlaylistDetailPanel open/close lifecycle', () => {
  it('keeps the panel and its rows mounted while the exit animation is playing', async () => {
    const onExitComplete = vi.fn()
    render(<Host onExitComplete={onExitComplete} />)

    click('open')
    await findByText('Test Playlist')
    expect(screen.getByText('Song 1')).toBeTruthy()

    click('close')
    // 关键回归点：关闭不是同帧卸载。若这里立刻为空，说明退场动画又被跳过了。
    expect(screen.getByText('Test Playlist')).toBeTruthy()
    expect(screen.queryByText('Song 1')).not.toBeNull()
    expect(onExitComplete).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(onExitComplete).toHaveBeenCalledTimes(1), { timeout: 5000 })
  })

  it('clears the expensive backdrop blur during exit so the animation is transform-only', async () => {
    render(<Host />)
    click('open')
    await findByText('Test Playlist')

    // 入场停稳后玻璃层到位：80px 模糊（动画期间刻意保持 0，见 GLASS_LAYER_MOTION）
    const blurred = await vi.waitFor(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('[style*="backdrop-filter"]'))
      const hit = nodes.find(node => node.style.backdropFilter.includes('80px'))
      expect(hit).toBeTruthy()
      return hit!
    }, { timeout: 5000 })
    expect(blurred.style.backdropFilter).toContain('blur(80px)')

    click('close')
    // 退场一开始玻璃层就该清零：backdrop-filter 采样元素背后的画面，
    // 元素在动时逐帧重算快照是关闭卡顿的主因；清零后只剩 transform 合成。
    await vi.waitFor(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('[style*="backdrop-filter"]'))
      expect(nodes.every(node => !node.style.backdropFilter.includes('80px'))).toBe(true)
    }, { timeout: 5000 })

    // 退场中的面板仍在（transform 驱动），没被卸载
    expect(screen.getByText('Test Playlist')).toBeTruthy()
  })

  it('does not rebuild the dynamic cover when reopened during the exit animation', async () => {
    render(<Host />)
    click('open')
    await findByText('Test Playlist')
    await findByText('Song 1')

    // 动态封面就绪 → HLS 实例建立
    await vi.waitFor(() => expect(hlsState.instances.length).toBe(1), { timeout: 5000 })
    expect(hlsState.destroyed).toBe(0)

    click('close')
    click('open')

    await findByText('Test Playlist')
    // 退场中重开：视频元素没被销毁重建，HLS 也没重新建实例
    expect(hlsState.destroyed).toBe(0)
    expect(hlsState.instances.length).toBe(1)
  })

  it('survives a rapid same-playlist toggle without losing the panel', async () => {
    const onExitComplete = vi.fn()
    render(<Host onExitComplete={onExitComplete} />)

    click('open')
    await findByText('Test Playlist')
    click('close')
    click('open')
    await findByText('Test Playlist')

    // 退场被中断，面板还在；此时不应把数据释放掉（回调里读的是"此刻"是否可见）
    expect(screen.getByText('Song 1')).toBeTruthy()
  })
})
