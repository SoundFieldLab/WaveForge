/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PlaylistGrid3D from '../src/components/PlaylistGrid3D'

vi.mock('../src/components/ScrollToTop', () => ({ default: () => null }))
vi.mock('../src/components/ScrollToCurrentSong', () => ({ default: () => null }))
vi.mock('../src/components/DeleteSongModal', () => ({ default: () => null }))
vi.mock('../src/components/SongContextMenu', () => ({
  default: ({ show, onRemoveFromPlaylist }: { show: boolean; onRemoveFromPlaylist?: (song: unknown) => void }) => (
    show && onRemoveFromPlaylist ? <button type="button">从歌单移除</button> : null
  ),
}))

const song = {
  id: 1,
  mid: 'spotify-track',
  name: 'Track',
  artists: [{ name: 'Artist' }],
  album: { name: 'Album', picUrl: '' },
  duration: 1000,
  platform: 'spotify' as const,
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
    observe() {}
    disconnect() {}
  })
})

afterEach(cleanup)

function renderGrid(onRemoveFromPlaylist?: () => void) {
  return render(
    <PlaylistGrid3D
      songs={[song]}
      loading={false}
      onPlaySong={vi.fn()}
      formatDuration={() => '0:01'}
      platform="spotify"
      neteaseVip={false}
      qqVip={false}
      onRemoveFromPlaylist={onRemoveFromPlaylist}
    />,
  )
}

describe('Desktop playlist removal actions', () => {
  it('hides unsupported remove action when no callback is supplied', () => {
    renderGrid()
    fireEvent.contextMenu(screen.getByText('Track'))
    expect(screen.queryByRole('button', { name: '从歌单移除' })).toBeNull()
  })

  it('shows remove action when the owned playlist supplies a callback', () => {
    renderGrid(vi.fn())
    fireEvent.contextMenu(screen.getByText('Track'))
    expect(screen.getByRole('button', { name: '从歌单移除' })).toBeTruthy()
  })
})
