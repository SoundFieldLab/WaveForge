/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import QQRadarPlayer, { type QQRadarContinuation } from '../src/features/qqExplore/QQRadarPlayer'
import type { Song } from '../src/services/musicApi'

function song(id: number, name = `歌曲 ${id}`): Song {
  return {
    id,
    mid: `mid-${id}`,
    name,
    artists: [{ id: id + 100, name: `歌手 ${id}` }],
    album: { id: id + 200, name: `专辑 ${id}`, picUrl: `https://img.test/${id}.jpg` },
    duration: 180000,
    platform: 'qq',
  } as Song
}

const continuation: QQRadarContinuation = { mode: 'radar', page: 1, reqType: 0, entranceSongs: [] }

afterEach(() => cleanup())

describe('QQRadarPlayer', () => {
  it('renders the current song and native playback controls', () => {
    render(<QQRadarPlayer songs={[song(1), song(2)]} continuation={continuation} playing onClose={vi.fn()} onPlaySong={vi.fn()} onRequestMore={vi.fn().mockResolvedValue({ songs: [], page: 2 })} onTogglePlay={vi.fn()} />)
    expect(screen.getByRole('dialog', { name: 'QQ 刷歌模式' })).toBeTruthy()
    expect(screen.getByText('歌曲 1')).toBeTruthy()
    expect(screen.getByRole('button', { name: '上一曲' })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '下一曲' })).toHaveProperty('disabled', false)
    expect(screen.getByRole('button', { name: '暂停' })).toBeTruthy()
  })

  it('switches songs with previous/next buttons and vertical swipe', () => {
    const onPlaySong = vi.fn()
    render(<QQRadarPlayer songs={[song(1), song(2), song(3)]} continuation={continuation} playing={false} onClose={vi.fn()} onPlaySong={onPlaySong} onRequestMore={vi.fn().mockResolvedValue({ songs: [], page: 2 })} onTogglePlay={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '下一曲' }))
    expect(onPlaySong).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }), expect.any(Array), continuation)
    const dialog = screen.getByRole('dialog', { name: 'QQ 刷歌模式' })
    const gestureArea = dialog.querySelector('.flex-1') as HTMLElement
    fireEvent.pointerDown(gestureArea, { pointerId: 1, clientY: 500 })
    fireEvent.pointerUp(gestureArea, { pointerId: 1, clientY: 380 })
    expect(onPlaySong).toHaveBeenLastCalledWith(expect.objectContaining({ id: 3 }), expect.any(Array), continuation)
  })

  it('closes and toggles playback', () => {
    const onClose = vi.fn()
    const onTogglePlay = vi.fn()
    render(<QQRadarPlayer songs={[song(1)]} continuation={continuation} playing={false} onClose={onClose} onPlaySong={vi.fn()} onRequestMore={vi.fn().mockResolvedValue({ songs: [], page: 2 })} onTogglePlay={onTogglePlay} />)
    fireEvent.click(screen.getByRole('button', { name: '退出刷歌模式' }))
    fireEvent.click(screen.getByRole('button', { name: '播放' }))
    expect(onClose).toHaveBeenCalledOnce()
    expect(onTogglePlay).toHaveBeenCalledOnce()
  })

  it('requests another radar page near the end and appends unique songs', async () => {
    const onRequestMore = vi.fn().mockResolvedValue({ songs: [song(2), song(4)], page: 2 })
    render(<QQRadarPlayer songs={[song(1), song(2), song(3), song(5), song(6)]} continuation={continuation} playing={false} onClose={vi.fn()} onPlaySong={vi.fn()} onRequestMore={onRequestMore} onTogglePlay={vi.fn()} />)
    expect(onRequestMore).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByText('1 / 6')).toBeTruthy())
    fireEvent.click(screen.getByRole('button', { name: '下一曲' }))
    fireEvent.click(screen.getByRole('button', { name: '下一曲' }))
    fireEvent.click(screen.getByRole('button', { name: '下一曲' }))
    fireEvent.click(screen.getByRole('button', { name: '下一曲' }))
    await act(async () => {})
    expect(screen.getByText('5 / 6')).toBeTruthy()
  })
})
