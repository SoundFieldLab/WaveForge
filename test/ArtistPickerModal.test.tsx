/** @vitest-environment jsdom */
/**
 * 播放页「查看歌手」：单歌手直进、多歌手弹选择器（含封面背景 / 头像惰性补齐 / 点选回调）。
 * 覆盖用户 2026-10-07 反馈：多歌手曲目在播放页只能看到第一个歌手 + 选完动作后右键菜单自现。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ArtistPickerModal from '../src/components/ArtistPickerModal'
import { resolveArtistIdentifier, resolveViewArtistIntent } from '../src/services/playbackArtist'
import type { Song } from '../src/services/musicApi'

vi.mock('../src/services/musicApi', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/services/musicApi')>()),
  searchArtists: vi.fn(async (keyword: string) => (
    keyword === '上原ひろみ'
      ? [{ id: 1, name: '上原ひろみ', picUrl: 'https://example.test/p1.jpg' }]
      : []
  )),
}))

vi.mock('../src/components/CachedImage', () => ({
  default: ({ src, alt, className }: { src?: string; alt?: string; className?: string }) => (
    <img src={src || ''} alt={alt || ''} className={className} />
  ),
}))

afterEach(cleanup)

const multiArtistSong = {
  id: 1,
  mid: 'm1',
  name: 'Dead Flat',
  artists: [{ id: 101, name: '上原ひろみ' }, { id: 102, name: 'Anthony Jackson' }, { id: 103, name: 'Simon Phillips' }],
  album: { name: 'Trio', picUrl: 'https://example.test/cover.jpg' },
  duration: 200_000,
  platform: 'netease',
} as unknown as Song

describe('查看歌手路由规则', () => {
  it('单歌手 → 直进歌手页', () => {
    expect(resolveViewArtistIntent([{ id: 1, name: 'A' }])).toEqual({ kind: 'direct', index: 0 })
  })

  it('多歌手 → 弹选择器；没有歌手 → none', () => {
    expect(resolveViewArtistIntent([{ id: 1, name: 'A' }, { id: 2, name: 'B' }])).toEqual({ kind: 'picker' })
    expect(resolveViewArtistIntent([])).toEqual({ kind: 'none' })
    expect(resolveViewArtistIntent(undefined)).toEqual({ kind: 'none' })
  })

  it('歌手标识按平台取字段：QQ=mid / Apple=appleId / 汽水=mid(真实艺人id)→名字回退 / 其余=数字 id', () => {
    const artist = { id: 7, mid: 'MID123', appleId: '999888', name: '名字' }
    expect(resolveArtistIdentifier('qq', artist)).toBe('MID123')
    expect(resolveArtistIdentifier('apple', artist)).toBe('999888')
    // 汽水：真实艺人接口接通后 mid（artist_id）优先；缺失时回退名字（伪艺人旧约定）
    expect(resolveArtistIdentifier('soda', artist)).toBe('MID123')
    expect(resolveArtistIdentifier('soda', { id: 7, name: '名字' })).toBe('7')
    expect(resolveArtistIdentifier('soda', { name: '名字' })).toBe('名字')
    expect(resolveArtistIdentifier('netease', artist)).toBe('7')
    expect(resolveArtistIdentifier('qq', undefined)).toBe('')
  })
})

describe('多歌手选择器', () => {
  it('列出全部歌手，点击回调带下标（不是只取第一个）', async () => {
    const onSelect = vi.fn()
    render(<ArtistPickerModal show song={multiArtistSong} onSelect={onSelect} onClose={() => {}} />)
    expect(screen.getByText('上原ひろみ')).toBeTruthy()
    expect(screen.getByText('Anthony Jackson')).toBeTruthy()
    expect(screen.getByText('Simon Phillips')).toBeTruthy()
    // 封面作为背景与缩略图都出现
    expect(document.querySelectorAll('img[src="https://example.test/cover.jpg"]').length).toBeGreaterThanOrEqual(2)
    fireEvent.click(screen.getByText('Anthony Jackson').closest('button') as HTMLButtonElement)
    expect(onSelect).toHaveBeenCalledWith(1)
  })

  it('头像惰性补齐：命中搜索的使用真头像，未命中保留占位（不冒充）', async () => {
    render(<ArtistPickerModal show song={multiArtistSong} onSelect={() => {}} onClose={() => {}} />)
    await waitFor(() => {
      expect(document.querySelector('img[src="https://example.test/p1.jpg"]')).toBeTruthy()
    })
    // 另外两位没有搜索结果 → 不产生头像 img（走首字占位）
    expect(document.querySelectorAll('img[src^="https://example.test/p1"]').length).toBe(1)
  })

  it('show=false 不渲染', () => {
    render(<ArtistPickerModal show={false} song={multiArtistSong} onSelect={() => {}} onClose={() => {}} />)
    expect(screen.queryByText('上原ひろみ')).toBeNull()
  })
})
