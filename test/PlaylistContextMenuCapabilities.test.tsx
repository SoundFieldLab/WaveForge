/** @vitest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import PlaylistContextMenu from '../src/components/PlaylistContextMenu'

const baseProps = {
  show: true,
  x: 20,
  y: 20,
  playlist: { id: '1', name: 'List', platform: 'qq' },
  onClose: vi.fn(),
  onEdit: vi.fn(),
  onDelete: vi.fn(),
  onSubscribe: vi.fn(),
  onShare: vi.fn(),
}

describe('PlaylistContextMenu capabilities', () => {
  it('supports delete without exposing edit', () => {
    render(<PlaylistContextMenu {...baseProps} isOwner canEdit={false} canDelete canSubscribe={false} canShare={false} />)
    expect(screen.queryByText('编辑歌单')).toBeNull()
    fireEvent.click(screen.getByText('删除歌单'))
    expect(baseProps.onDelete).toHaveBeenCalled()
  })

  it('hides subscription for unsupported non-owner platforms', () => {
    render(<PlaylistContextMenu {...baseProps} isOwner={false} canEdit={false} canDelete={false} canSubscribe={false} canShare={false} />)
    expect(screen.queryByText('收藏歌单')).toBeNull()
    expect(screen.queryByText('取消收藏')).toBeNull()
  })
})
