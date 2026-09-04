/** @vitest-environment jsdom */
import React from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AppleSearchBrowse from '../src/components/AppleSearchBrowse'
import { dispatchTvBack } from '../src/tv/tvCore'
import * as appleWeb from '../src/services/appleWebService'

vi.mock('framer-motion', () => ({
  motion: new Proxy({}, { get: (_target, key) => key }),
}))

vi.mock('../src/services/appleWebService', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/services/appleWebService')>()
  return {
    ...actual,
    fetchAppleSearchLanding: vi.fn(),
    fetchAppleCuratorPage: vi.fn(),
  }
})

const curator = (id: string, name: string) => ({
  id,
  playId: id,
  type: 'apple-curators' as const,
  name,
})

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(next => { resolve = next })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Apple Explore categories', () => {
  it('ignores stale curator responses and lets TV back return to category browsing', async () => {
    vi.mocked(appleWeb.fetchAppleSearchLanding).mockResolvedValue({
      sections: [{ id: 'curators', title: 'Categories', kind: 'curators', items: [curator('one', 'One'), curator('two', 'Two')] }],
      hero: null,
      personalized: false,
      sourceLabel: 'test',
    })
    const first = deferred<any>()
    const second = deferred<any>()
    vi.mocked(appleWeb.fetchAppleCuratorPage)
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    render(<AppleSearchBrowse onSongSelect={vi.fn()} />)
    await screen.findByText('One')
    fireEvent.click(screen.getByText('One'))
    act(() => { expect(dispatchTvBack()).toBe(true) })
    fireEvent.click(await screen.findByText('Two'))

    await act(async () => {
      first.resolve({ curator: curator('one', 'One Detail'), sections: [], playlists: [], playlistCount: 0 })
      second.resolve({ curator: curator('two', 'Two Detail'), sections: [], playlists: [], playlistCount: 0 })
    })

    await screen.findByText('Two Detail')
    expect(screen.queryByText('One Detail')).toBeNull()
    expect(dispatchTvBack()).toBe(true)
    await waitFor(() => expect(screen.getByText('类别浏览')).toBeTruthy())
  })

  it('retries a failed curator request locally', async () => {
    vi.mocked(appleWeb.fetchAppleSearchLanding).mockResolvedValue({
      sections: [{ id: 'curators', title: 'Categories', kind: 'curators', items: [curator('one', 'One')] }],
      hero: null,
      personalized: false,
      sourceLabel: 'test',
    })
    vi.mocked(appleWeb.fetchAppleCuratorPage)
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ curator: curator('one', 'Recovered'), sections: [], playlists: [], playlistCount: 0 })

    render(<AppleSearchBrowse onSongSelect={vi.fn()} />)
    fireEvent.click(await screen.findByText('One'))
    fireEvent.click(await screen.findByText('重试'))
    await screen.findByText('Recovered')
    expect(appleWeb.fetchAppleCuratorPage).toHaveBeenCalledTimes(2)
  })
})
