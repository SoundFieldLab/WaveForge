/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPlaybackTimeStore } from '../src/audio/playbackTimeStore'
import { convertLyricsToFoliaLines } from '../src/components/FoliaLyricsPage'
import { convertLyricsToFoliaLines as convertDioramaLines } from '../src/components/foliaDiorama/FoliaDioramaLyrics'
import { toPvLyrics } from '../src/components/pvLyrics/pvBridge'
import LyricsDisplay from '../src/components/LyricsDisplay'
import ModengPlayerPage from '../src/components/ModengPlayerPage'
import type { LyricLine } from '../src/services/musicApi'

const specialLyrics: LyricLine[] = [{
  time: 10,
  endTime: 14,
  text: 'Main vocal',
  words: [{ word: 'Main', startTime: 0, duration: 500 }],
  translation: '主唱翻译',
  roman: 'main roman',
  agentId: 'v1',
  alternateTexts: [
    { role: 'translation', language: 'zh', text: '备用翻译' },
    { role: 'romanization', text: 'alternate roman' },
  ],
  backgroundVocals: [{
    time: 10.5,
    endTime: 12,
    text: 'Harmony',
    words: [{ word: 'Harmony', startTime: 0, duration: 700 }],
    translation: '和声翻译',
    romanization: 'harmony roman',
    agentId: 'v2',
    alternateTexts: [{ role: 'translation', text: '和声备用翻译' }],
  }],
}]

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('appleMusicSettings', JSON.stringify({ duetColors: true }))
  vi.stubGlobal('ResizeObserver', class ResizeObserverMock {
    observe() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('special lyric rendering', () => {
  it('maps agents, alternates and background vocals to Folia lines', () => {
    const [line] = convertLyricsToFoliaLines(specialLyrics, 'track', true, true)

    expect(line).toMatchObject({
      startTime: 10,
      endTime: 14,
      translation: '主唱翻译',
      romanization: 'main roman',
      agentId: 'v1',
      alternateTexts: [
        { role: 'translation', language: 'zh', text: '备用翻译' },
        { role: 'romanization', text: 'alternate roman' },
      ],
    })
    expect(line.words[0]).toMatchObject({ startTime: 10, endTime: 10.5 })
    expect(line.backgroundVocals?.[0]).toMatchObject({
      text: 'Harmony',
      startTime: 10.5,
      endTime: 12,
      agentId: 'v2',
      translation: '和声翻译',
      romanization: 'harmony roman',
    })
    expect(line.backgroundVocals?.[0].words[0]).toMatchObject({ startTime: 10.5, endTime: 11.2 })
  })

  it('honors Folia subtitle switches without dropping agents or harmony', () => {
    const [line] = convertLyricsToFoliaLines(specialLyrics, 'track', false, false)

    expect(line.translation).toBeUndefined()
    expect(line.romanization).toBeUndefined()
    expect(line.alternateTexts).toBeUndefined()
    expect(line.agentId).toBe('v1')
    expect(line.backgroundVocals?.[0].agentId).toBe('v2')
    expect(line.backgroundVocals?.[0].translation).toBeUndefined()
    expect(line.backgroundVocals?.[0].romanization).toBeUndefined()
  })

  it('preserves special lyric fields in Diorama and PV adapters', () => {
    const [diorama] = convertDioramaLines(specialLyrics)
    expect(diorama).toMatchObject({
      endTime: 14,
      agentId: 'v1',
      backgroundVocals: [{ text: 'Harmony', agentId: 'v2' }],
    })
    const [pv] = toPvLyrics(specialLyrics)
    expect(pv).toMatchObject({
      agentId: 'v1',
      backgroundVocals: [{ text: 'Harmony', agentId: 'v2' }],
    })
    expect(pv.alternateTexts).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'translation', text: '备用翻译' }),
      expect.objectContaining({ role: 'romanization', text: 'alternate roman' }),
    ]))
  })

  it('shows parenthesized background vocals only inside their time window', async () => {
    const view = render(
      <LyricsDisplay
        currentTime={11}
        isPlaying={false}
        accentColor="#ffffff"
        lyrics={specialLyrics}
        displayMode="single"
      />,
    )

    expect(await screen.findByText('（Harmony）')).toBeTruthy()

    view.rerender(
      <LyricsDisplay
        currentTime={12.5}
        isPlaying={false}
        accentColor="#ffffff"
        lyrics={specialLyrics}
        displayMode="single"
      />,
    )
    await waitFor(() => expect(screen.queryByText('（Harmony）')).toBeNull())
  })

  it('uses controlled Modern switches and displays enabled subtitles', () => {
    const onTranslationToggle = vi.fn()
    const onRomanToggle = vi.fn()
    const store = createPlaybackTimeStore({ currentTime: 10.8, duration: 180, isPlaying: false })
    const view = render(
      <ModengPlayerPage
        lyrics={specialLyrics}
        currentIndex={0}
        playbackTimeStore={store}
        timeOffset={0}
        isPlaying={false}
        accentColor="#ffffff"
        playerTheme="dark"
        songTitle="Song"
        songArtist="Artist"
        translationEnabled
        romanEnabled
        onTranslationToggle={onTranslationToggle}
        onRomanToggle={onRomanToggle}
      />,
    )

    expect(screen.getByTestId('modeng-translation').textContent).toBe('主唱翻译')
    expect(screen.getByTestId('modeng-roman').textContent).toBe('main roman')
    const translationButton = screen.getByRole('button', { name: '翻译' })
    const romanButton = screen.getByRole('button', { name: '罗马音' })
    expect(translationButton.getAttribute('aria-pressed')).toBe('true')
    expect(romanButton.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(translationButton)
    fireEvent.click(romanButton)
    expect(onTranslationToggle).toHaveBeenCalledOnce()
    expect(onRomanToggle).toHaveBeenCalledOnce()

    view.rerender(
      <ModengPlayerPage
        lyrics={specialLyrics}
        currentIndex={0}
        playbackTimeStore={store}
        timeOffset={0}
        isPlaying={false}
        accentColor="#ffffff"
        playerTheme="dark"
        songTitle="Song"
        songArtist="Artist"
        translationEnabled={false}
        romanEnabled={false}
      />,
    )
    expect(screen.queryByTestId('modeng-translation')).toBeNull()
    expect(screen.queryByTestId('modeng-roman')).toBeNull()
  })
})
