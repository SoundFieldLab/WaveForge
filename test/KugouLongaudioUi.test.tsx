/** @vitest-environment jsdom */
/**
 * 听书板块 + 独立播放器 UI 冒烟（jsdom）：
 * 1) 卡片角标（听书VIP / 播放量）与分类胶囊筛选；
 * 2) 播放器章节列表：点击章节行切章、当前章节高亮，倍速按钮作用到 store/音频元素。
 * 数据来自 mock 的 kugouService，避免触网；音频用假实现的 Audio 全局替换。
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/components/CachedImage', () => ({
  default: ({ src, alt, className }: { src?: string; alt?: string; className?: string }) => (
    <img src={src || ''} alt={alt || ''} className={className} />
  ),
}))

vi.mock('../src/services/kugouService', () => ({
  fetchKugouLongaudioDaily: vi.fn(async () => ({
    albums: [
      {
        albumId: '1',
        name: '玄界之门',
        author: '样例主播',
        authors: ['样例主播'],
        coverUrl: 'https://example.test/1.jpg',
        intro: '玄幻爽文',
        playCount: 67594990,
        chapterCount: 3,
        isPaid: true,
        primaryTag: '玄幻异界',
        tags: ['玄幻异界'],
      },
      {
        albumId: '2',
        name: '助眠雨声',
        author: '晚安',
        authors: ['晚安'],
        coverUrl: 'https://example.test/2.jpg',
        intro: '白噪音',
        playCount: 300,
        chapterCount: 10,
        isPaid: false,
        primaryTag: '自然疗愈',
        tags: ['自然疗愈'],
      },
    ],
    hasMore: false,
  })),
  fetchKugouLongaudioAlbumDetail: vi.fn(async (albumId: string) => ({
    album: {
      albumId,
      name: '玄界之门',
      author: '样例主播',
      authors: ['样例主播'],
      coverUrl: 'https://example.test/1.jpg',
      intro: '玄幻爽文',
      playCount: 67594990,
      tags: ['玄幻异界'],
      isPublished: true,
      isPaid: true,
    },
  })),
  fetchKugouLongaudioChapters: vi.fn(async (_albumId: string, page: number) => ({
    chapters: page === 1
      ? [
          { hash: 'HASH-A', albumAudioId: 11, name: '第1集 起点', duration: 300, sort: 1, disc: 1, payType: 0, privilege: 0 },
          { hash: 'HASH-B', albumAudioId: 12, name: '第2集 入门', duration: 320, sort: 2, disc: 1, payType: 0, privilege: 0 },
        ]
      : [],
    hasMore: false,
  })),
  getKugouLongaudioUrl: vi.fn(async (hash: string) => ({ url: `https://cdn.example.test/${hash}.mp3` })),
}))

/** 假音频：jsdom 的 HTMLMediaElement.play 未实现（会抛 not implemented） */
class FakeAudio {
  src = ''
  currentTime = 0
  duration = 0
  playbackRate = 1
  paused = true
  play = vi.fn(async () => { this.paused = false })
  pause = vi.fn(() => { this.paused = true })
  addEventListener = vi.fn()
  removeEventListener = vi.fn()
}

const loadModules = async () => {
  vi.resetModules()
  const storeModule = await import('../src/features/kugouLongaudio/store')
  const Board = (await import('../src/features/kugouLongaudio/KugouLongaudioBoard')).default
  const Overlay = (await import('../src/features/kugouLongaudio/KugouLongaudioOverlay')).default
  return { store: storeModule.kugouLongaudioStore, Board, Overlay }
}

const boardProps = {
  accent: '#FF7A00',
  compactCards: false,
  showSubtitles: true,
  expandedHome: false,
  exploreCardBg: 'rgba(255,255,255,0.05)',
  sectionStyle: () => ({}),
  sectionVisible: () => true,
}

beforeEach(() => {
  vi.stubGlobal('Audio', FakeAudio)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('听书板块', () => {
  it('渲染卡片角标（听书VIP / 播放量）与主播信息', async () => {
    const { Board } = await loadModules()
    render(<Board {...boardProps} />)
    expect(await screen.findByText('玄界之门')).toBeTruthy()
    // 67594990 → 6759万（≥100 万的量级不保留小数）；听书VIP 角标只对 is_pay=1 的专辑出现
    expect(screen.getByText('听书VIP')).toBeTruthy()
    expect(screen.getByText('6759万')).toBeTruthy()
    expect(screen.getByText('助眠雨声')).toBeTruthy()
  })

  it('分类胶囊按 tag_name 筛选卡片', async () => {
    const { Board } = await loadModules()
    render(<Board {...boardProps} />)
    expect(await screen.findByText('玄界之门')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '自然疗愈' }))
    await waitFor(() => expect(screen.queryByText('玄界之门')).toBeNull())
    expect(screen.getByText('助眠雨声')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(await screen.findByText('玄界之门')).toBeTruthy()
  })
})

describe('独立听书播放器', () => {
  it('点击章节行切章：当前章节高亮并播放对应直链', async () => {
    const { store, Board, Overlay } = await loadModules()
    render(<Board {...boardProps} />)
    render(<Overlay />)
    await waitFor(() => expect(store.getState().browse.albums).toHaveLength(2))

    await store.openAlbum('1')
    expect(screen.getByText('章节列表')).toBeTruthy()
    const secondChapter = await screen.findByText('第2集 入门')

    fireEvent.click(secondChapter)
    await waitFor(() => expect(store.getState().player.currentIndex).toBe(1))
    expect(store.getState().player.status).toBe('playing')
    expect(screen.getByText('倍速')).toBeTruthy()
  })

  it('倍速按钮把速率写回 store 并钳制在 0.75~2x', async () => {
    const { store, Overlay } = await loadModules()
    render(<Overlay />)
    await store.openAlbum('1')
    await store.selectChapter(0)
    fireEvent.click(screen.getByRole('button', { name: '2x' }))
    await waitFor(() => expect(store.getState().player.rate).toBe(2))
  })
})
