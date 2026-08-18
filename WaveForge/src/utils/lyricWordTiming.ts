import type { LyricLine, LyricWord } from '../services/musicApi'
import { reconcileBoundaryParentheses } from './lyricBoundaryParentheses'

export interface TimedLyricGlyph {
  text: string
  startTime: number
  endTime: number
  wordIndex: number
  glyphIndex: number
  isWhitespace: boolean
}

const FALLBACK_FIRST_WORD_DURATION_MS = 140

export const segmentLyricGraphemes = (text: string) => {
  const Segmenter = (Intl as typeof Intl & {
    Segmenter?: new (locale?: string, options?: { granularity: 'grapheme' }) => {
      segment: (value: string) => Iterable<{ segment: string }>
    }
  }).Segmenter

  if (!Segmenter) return Array.from(text)
  return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), item => item.segment)
}

const normalizeAbsoluteStarts = (words: LyricWord[], lineTimeSeconds: number) => {
  const lineStartMs = Math.max(0, lineTimeSeconds * 1000)
  const visibleStarts = words
    .filter(word => word.word?.trim() && Number.isFinite(word.startTime))
    .map(word => word.startTime)
  if (visibleStarts.length === 0 || lineStartMs < 1000) return words

  const firstStart = visibleStarts[0]
  const looksAbsolute = firstStart > 1000 && Math.abs(firstStart - lineStartMs) < 15000
  if (!looksAbsolute) return words

  return words.map(word => ({
    ...word,
    startTime: Math.max(0, word.startTime - lineStartMs),
  }))
}

export const restoreLyricWordSpacing = (words: LyricWord[], lineText: string) => {
  const expandedWords = words.flatMap(word => {
    if (/^\s+$/u.test(word.word)) return [{ ...word, duration: 0 }]

    const leadingWhitespace = word.word.match(/^\s+/u)?.[0] || ''
    const trailingWhitespace = word.word.match(/\s+$/u)?.[0] || ''
    const contentStart = leadingWhitespace.length
    const contentEnd = word.word.length - trailingWhitespace.length
    const content = word.word.slice(contentStart, Math.max(contentStart, contentEnd))
    const result: LyricWord[] = []

    if (leadingWhitespace) result.push({ word: leadingWhitespace, startTime: word.startTime, duration: 0 })
    if (content) result.push({ ...word, word: content })
    if (trailingWhitespace) {
      result.push({
        word: trailingWhitespace,
        startTime: word.startTime + Math.max(0, word.duration),
        duration: 0,
      })
    }
    return result.length > 0 ? result : [word]
  })

  const normalizedLineText = lineText.trim().replace(/\s+/gu, ' ')
  const visibleIndices = expandedWords
    .map((word, index) => word.word.trim() ? index : -1)
    .filter(index => index >= 0)
  const insertSpaceAfter = new Set<number>()
  let lineCursor = 0

  visibleIndices.forEach((wordIndex, visibleIndex) => {
    const token = expandedWords[wordIndex].word.trim()
    const tokenIndex = normalizedLineText.indexOf(token, lineCursor)
    if (tokenIndex < 0) return

    const tokenEnd = tokenIndex + token.length
    const separator = normalizedLineText.slice(tokenEnd).match(/^\s+/u)?.[0] || ''
    lineCursor = tokenEnd + separator.length
    const nextVisibleIndex = visibleIndices[visibleIndex + 1]
    if (!separator || nextVisibleIndex === undefined) return

    const alreadyHasWhitespace = expandedWords
      .slice(wordIndex + 1, nextVisibleIndex)
      .some(nextWord => /^\s+$/u.test(nextWord.word))
    if (!alreadyHasWhitespace) insertSpaceAfter.add(wordIndex)
  })

  return expandedWords.flatMap((word, index) => insertSpaceAfter.has(index)
    ? [
        word,
        {
          word: ' ',
          startTime: word.startTime + Math.max(0, word.duration),
          duration: 0,
        },
      ]
    : [word])
}

export const normalizeSequentialWordTiming = (words: LyricWord[]) => {
  if (words.length === 0) return words

  const visibleIndices = words
    .map((word, index) => word.word?.trim() ? index : -1)
    .filter(index => index >= 0)
  if (visibleIndices.length === 0) return words

  const starts: number[] = []
  visibleIndices.forEach((wordIndex, visibleIndex) => {
    const rawStart = Number.isFinite(words[wordIndex].startTime)
      ? Math.max(0, words[wordIndex].startTime)
      : 0
    if (visibleIndex === 0) {
      starts.push(rawStart)
      return
    }

    const previousStart = starts[visibleIndex - 1]
    const previousWord = words[visibleIndices[visibleIndex - 1]]
    const hasUsablePreviousDuration = Number.isFinite(previousWord.duration) && previousWord.duration > 8
    const minimumGap = rawStart <= previousStart || !hasUsablePreviousDuration
      ? FALLBACK_FIRST_WORD_DURATION_MS
      : 1
    starts.push(rawStart >= previousStart + minimumGap ? rawStart : previousStart + minimumGap)
  })

  const normalized = words.map(word => ({ ...word }))
  visibleIndices.forEach((wordIndex, visibleIndex) => {
    const word = words[wordIndex]
    const startTime = starts[visibleIndex]
    const nextStart = starts[visibleIndex + 1]
    const rawDuration = Number.isFinite(word.duration) && word.duration > 8
      ? word.duration
      : FALLBACK_FIRST_WORD_DURATION_MS
    const duration = nextStart !== undefined
      ? Math.max(1, Math.min(rawDuration, nextStart - startTime))
      : Math.max(1, rawDuration)
    normalized[wordIndex] = { ...word, startTime, duration }
  })

  let previousEnd = 0
  normalized.forEach((word, index) => {
    if (word.word?.trim()) previousEnd = word.startTime + word.duration
    else normalized[index] = { ...word, startTime: previousEnd, duration: 0 }
  })
  return normalized
}

export const prepareLyricWords = (line: Pick<LyricLine, 'time' | 'text' | 'words'> & { content?: string }) => {
  const fullText = line.text || line.content || ''
  const fixedWords = reconcileBoundaryParentheses(fullText, line.words || [])
  const relativeWords = normalizeAbsoluteStarts(fixedWords, line.time)
  return normalizeSequentialWordTiming(restoreLyricWordSpacing(relativeWords, fullText))
}

export const hasTrueWordTiming = (line: Pick<LyricLine, 'text' | 'words'>) => {
  const words = line.words?.filter(word => Boolean(word.word?.trim())) || []
  if (!words.some(word => Number.isFinite(word.startTime) && Number.isFinite(word.duration) && word.duration > 0)) {
    return false
  }
  return words.length > 1 || segmentLyricGraphemes(line.text.trim()).length <= 1
}

export const buildTimedLyricGlyphs = (line: LyricLine): TimedLyricGlyph[] => {
  if (!hasTrueWordTiming(line)) return []

  return prepareLyricWords(line).flatMap((word, wordIndex) => {
    const characters = segmentLyricGraphemes(word.word)
    if (characters.length === 0) return []
    const isWhitespaceWord = /^\s+$/u.test(word.word)
    const wordStart = line.time + Math.max(0, word.startTime) / 1000
    const wordDuration = isWhitespaceWord ? 0 : Math.max(0.001, word.duration / 1000)
    const glyphDuration = characters.length > 0 ? wordDuration / characters.length : 0

    return characters.map((text, glyphIndex) => ({
      text,
      startTime: wordStart + glyphDuration * glyphIndex,
      endTime: wordStart + glyphDuration * (glyphIndex + 1),
      wordIndex,
      glyphIndex,
      isWhitespace: /^\s+$/u.test(text),
    }))
  })
}

export const buildProgressiveLyricGlyphs = (line: LyricLine, fallbackDurationSeconds?: number): TimedLyricGlyph[] => {
  const timedGlyphs = buildTimedLyricGlyphs(line)
  if (timedGlyphs.length > 0) return timedGlyphs

  const graphemes = segmentLyricGraphemes(line.text || '')
  const visibleCount = graphemes.filter(text => !/^\s+$/u.test(text)).length
  if (visibleCount === 0) return []

  const fallbackDuration = fallbackDurationSeconds
    ?? Math.min(6.4, Math.max(2.1, 1.45 + visibleCount * 0.115))
  const glyphDuration = fallbackDuration / visibleCount
  let visibleIndex = 0
  let wordIndex = 0

  return graphemes.map((text, glyphIndex) => {
    const isWhitespace = /^\s+$/u.test(text)
    if (isWhitespace) {
      const time = line.time + glyphDuration * visibleIndex
      wordIndex += 1
      return { text, startTime: time, endTime: time, wordIndex, glyphIndex, isWhitespace }
    }

    const startTime = line.time + glyphDuration * visibleIndex
    visibleIndex += 1
    return {
      text,
      startTime,
      endTime: startTime + glyphDuration,
      wordIndex,
      glyphIndex,
      isWhitespace,
    }
  })
}

