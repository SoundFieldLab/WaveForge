/** @vitest-environment jsdom */
/**
 * 3.E 酷狗刷歌 UI 冒烟（jsdom）：
 * 1) 上游空数据（实测本账号恒空）必须给出「当前账号暂无动态」空态 + 刷新按钮；
 * 2) 字段未识别的卡片要原样展示（不因解析不出曲目就静默消失）；
 * 3) 「容器（板块）+ 全屏竖滑页」搭起来后，点卡片会把曲目交给主播放器回调（同 QQ 刷歌粒度）。
 * 数据来自 mock 的 kugouService，避免触网。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KugouYouthCard } from '../src/services/kugouService'

vi.mock('../src/components/CachedImage', () => ({
  default: ({ src, alt, className }: { src?: string; alt?: string; className?: string }) => (
    <img src={src || ''} alt={alt || ''} className={className} />
  ),
}))

const fetchKugouYouthDynamic = vi.fn()
const fetchKugouYouthRecent = vi.fn()
const reportKugouYouthListen = vi.fn(async () => true)

vi.mock('../src/services/kugouService', () => ({
  hasKugouConceptCredential: () => true,
  fetchKugouYouthDynamic: (...args: unknown[]) => fetchKugouYouthDynamic(...args),
  fetchKugouYouthRecent: (...args: unknown[]) => fetchKugouYouthRecent(...args),
  reportKugouYouthListen: (...args: unknown[]) => reportKugouYouthListen(...args),
  // store 只 import 上面几个；其余导出给出空实现防止误用（本测试文件不需要真实服务）
  parseKugouYouthCards: () => [],
  parseKugouYouthCard: () => ({ raw: null, song: null, mixsongid: 0, title: '', artist: '', coverUrl: '' }),
}))

import KugouYouthFeedBoard from '../src/features/kugouYouth/KugouYouthFeedBoard'
import KugouYouthFeedOverlay from '../src/features/kugouYouth/KugouYouthFeedOverlay'
import { kugouYouthStore } from '../src/features/kugouYouth/store'

const HASH = '0123456789abcdef0123456789abcdef'

const boardProps = {
  accent: '#ff7a00',
  compactCards: false,
  showSubtitles: true,
  exploreCardBg: '#101010',
  sectionStyle: () => ({}),
  sectionVisible: () => true,
  onPlaySongs: vi.fn(),
}

function playableCard(): KugouYouthCard {
  return {
    raw: { hash: HASH, name: '可播歌曲', author_name: '样例歌手' },
    song: {
      id: 1,
      mid: HASH,
      name: '可播歌曲',
      artists: [{ name: '样例歌手' }],
      album: { name: '', picUrl: '' },
      duration: 200000,
      platform: 'kugou',
      kugouMixSongId: 998877,
    },
    mixsongid: 998877,
    title: '可播歌曲',
    artist: '样例歌手',
    coverUrl: '',
  }
}

beforeEach(() => {
  kugouYouthStore.close()
  boardProps.onPlaySongs.mockReset()
  fetchKugouYouthDynamic.mockReset()
  fetchKugouYouthRecent.mockReset()
  fetchKugouYouthRecent.mockResolvedValue({ cards: [], empty: true })
})

afterEach(() => {
  cleanup()
  kugouYouthStore.close()
})

describe('KugouYouthFeedBoard（板块）', () => {
  it('上游空列表 → 「当前账号暂无动态」空态 + 刷新按钮（刷新会再次请求）', async () => {
    fetchKugouYouthDynamic.mockResolvedValue({ cards: [], isEnd: true, lastCid: '', empty: true })
    await kugouYouthStore.refresh()
    render(<KugouYouthFeedBoard {...boardProps} />)
    expect(await screen.findByText('当前账号暂无动态')).toBeTruthy()
    const callsBefore = fetchKugouYouthDynamic.mock.calls.length
    fireEvent.click(screen.getByRole('button', { name: /刷新/ }))
    await waitFor(() => expect(fetchKugouYouthDynamic.mock.calls.length).toBeGreaterThan(callsBefore))
  })

  it('识别不出的卡片原样展示（不静默丢弃）', async () => {
    fetchKugouYouthDynamic.mockResolvedValue({
      cards: [{ raw: { foo: '未知形态文案' }, song: null, mixsongid: 0, title: '未知形态文案', artist: '', coverUrl: '' }],
      isEnd: true,
      lastCid: '',
      empty: false,
    })
    await kugouYouthStore.refresh()
    render(<KugouYouthFeedBoard {...boardProps} />)
    expect(await screen.findByText('未知形态文案')).toBeTruthy()
    expect(screen.getByText('字段未识别 · 已原样透传')).toBeTruthy()
  })

  it('板块卡片 → 全屏竖滑页起播并把曲目交给主播放器回调', async () => {
    fetchKugouYouthDynamic.mockResolvedValue({ cards: [playableCard()], isEnd: true, lastCid: '', empty: false })
    await kugouYouthStore.refresh()
    const onTogglePlay = vi.fn()
    render(
      <>
        <KugouYouthFeedBoard {...boardProps} />
        <KugouYouthFeedOverlay playing={false} onTogglePlay={onTogglePlay} onPlaySongs={boardProps.onPlaySongs} />
      </>,
    )
    // 板块卡片点击 → 打开全屏页（板块挂载时会再刷新一次，等它落到卡片态）
    fireEvent.click(await screen.findByText('可播歌曲'))
    expect(await screen.findByRole('dialog', { name: '酷狗刷歌' })).toBeTruthy()
    await waitFor(() => expect(boardProps.onPlaySongs).toHaveBeenCalledWith(expect.objectContaining({ name: '可播歌曲' }), expect.any(Array), true))
    // 已听上报：refresh/select 触发一次
    expect(reportKugouYouthListen).toHaveBeenCalledWith(998877)
    fireEvent.click(screen.getByRole('button', { name: '退出刷歌模式' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: '酷狗刷歌' })).toBeNull())
  })
})
