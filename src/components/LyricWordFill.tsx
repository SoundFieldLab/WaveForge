/**
 * 学歌专用 · 播放页同源逐字填充行（从 LyricsDisplay.renderLyricLine 的
 * effectiveWordByWordEnabled + soft 分支逐行提取，保持同一套视觉参数）：
 *   - 底层灰字（inactiveColor 38%）+ 上层填充层（clip-path inset 从左到右推进）；
 *   - 柔光大羽化（fillExtension 42 的六段渐变 mask，参数与 LyricsDisplay.getWordEffectConfig
 *     的 soft 档完全一致）；
 *   - 字上浮（softLift 0.075em / 520ms cubic ease-out）；
 *   - 填充层唱完后常驻不卸载（避免灰闪）、垂直居中对齐（防叠印）；
 *   - 每个词用自己的 [start,end]（words 内时间为行内相对毫秒，与 LyricWord 语义一致）。
 *
 * 为什么提取而不是整组件复用：LyricsDisplay 是滚动歌词面板（自带列表/滚动/背景），
 * 学歌需要的是「自己的逐句列表布局 + 播放页同款的行内逐字效果」——只取行内渲染。
 * 由调用方（学歌视图）每帧传入 currentTime 驱动（与 LyricsDisplay 同机制）。
 */
import { useMemo, useRef, useState } from 'react'
import type { LyricLine } from '../services/musicApi'
import { normalizeSequentialWordTiming, prepareLyricWords } from '../utils/lyricWordTiming'
import { reconcileBoundaryParentheses } from '../utils/lyricBoundaryParentheses'

const clamp = (value: number) => Math.min(1, Math.max(0, value))

/** 与 LyricsDisplay.getWordEffectConfig('soft') 完全一致的参数（深浅主题按传入色计算） */
const SOFT_CONFIG = {
  wordRowGap: '0.12em',
  linePaddingX: '0.12em',
  wordLineHeight: 1.28,
  fillExtension: 42,
  inactiveFilter: 'blur(0.3px)',
  baseTextShadowDark: '0 2px 9px rgba(0,0,0,0.24)',
  baseTextShadowLight: '0 2px 9px rgba(255,255,255,0.24)',
  activeTextShadowDark: '0 0 14px rgba(255,255,255,0.25), 0 3px 12px rgba(0,0,0,0.36)',
  activeTextShadowLight: '0 3px 12px rgba(255,255,255,0.36)',
} as const

const parseRubyText = (text: string): Array<{ base: string; ruby?: string }> => {
  const parts: Array<{ base: string; ruby?: string }> = []
  const rubyPattern = /([\u4e00-\u9fff]+)\s*[（]([\u3040-\u309f\u30a0-\u30ff]+)[）]/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = rubyPattern.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push({ base: text.slice(lastIndex, match.index) })
    parts.push({ base: match[1], ruby: match[2] })
    lastIndex = rubyPattern.lastIndex
  }
  if (lastIndex < text.length) parts.push({ base: text.slice(lastIndex) })
  return parts.length > 0 ? parts : [{ base: text }]
}

const removeRubyAnnotations = (text: string): string =>
  text.replace(/([\u4e00-\u9fff]+)\s*[（]([\u3040-\u309f\u30a0-\u30ff]+)[）]/g, '$1')

/** 柔光大羽化填充层样式（与 LyricsDisplay 的 getFillOverlayStyle soft 分支同式） */
function getFillOverlayStyle(fillWidth: number): {
  width: string
  WebkitMaskImage: string
  maskImage: string
} {
  const extendedWidth = Math.min(100, fillWidth + SOFT_CONFIG.fillExtension)
  const fillEdge = extendedWidth > 0 ? fillWidth / extendedWidth * 100 : 0
  const featherStart = Math.max(0, fillEdge - 18)
  const featherShoulder = Math.max(featherStart, fillEdge - 6)
  const featherTail = fillEdge + (100 - fillEdge) * 0.54
  const fillMask = `linear-gradient(90deg,
    black 0%,
    black ${featherStart}%,
    rgba(0,0,0,0.94) ${featherShoulder}%,
    rgba(0,0,0,0.76) ${fillEdge}%,
    rgba(0,0,0,0.28) ${featherTail}%,
    transparent 100%)`
  return {
    width: `${extendedWidth}%`,
    WebkitMaskImage: fillMask,
    maskImage: fillMask,
  }
}

export interface LyricWordFillLineProps {
  lyric: LyricLine
  /** 播放进度（秒）；调用方每帧传入驱动（LyricsDisplay 同机制）。 */
  currentTime: number
  lyricOffset: number
  /** 填充亮色（通常 = 歌词主色/纯白）。 */
  activeColor: string
  dark: boolean
  /** 字号 class（text-4xl 等）。 */
  size?: string
  /** 点击某个词：从该词起始时间起播（咬字练习）。 */
  onPlayWord?: (timeSeconds: number) => void
}

export default function LyricWordFillLine({
  lyric,
  currentTime,
  lyricOffset,
  activeColor,
  dark,
  size,
  onPlayWord,
}: LyricWordFillLineProps) {
  const hoverTimerRef = useRef<number | null>(null)
  const [breathingIndex, setBreathingIndex] = useState<number | null>(null)

  // 词序列（与 LyricsDisplay.prepareLyricLine 同源：prepareLyricWords 处理合并/括号）
  const words = useMemo(() => {
    const sequential = prepareLyricWords(lyric)
    return normalizeSequentialWordTiming(sequential)
  }, [lyric])

  const lineStartMs = lyric.time * 1000
  // 与 LyricsDisplay 一致的 200ms 节拍延迟
  const currentMs = Math.max(0, (currentTime + lyricOffset) * 1000 - lineStartMs - 200)
  const inactiveColor = dark ? 'rgba(255,255,255,0.38)' : 'rgba(0,0,0,0.38)'
  const baseTextShadow = dark ? SOFT_CONFIG.baseTextShadowDark : SOFT_CONFIG.baseTextShadowLight

  return (
    <span
      className={`relative inline-flex w-full min-w-0 flex-wrap whitespace-normal break-words [overflow-wrap:anywhere]`}
      style={{
        columnGap: 0,
        rowGap: SOFT_CONFIG.wordRowGap,
        paddingLeft: SOFT_CONFIG.linePaddingX,
        paddingRight: SOFT_CONFIG.linePaddingX,
        lineHeight: SOFT_CONFIG.wordLineHeight,
      }}
    >
      {words.map((word, originalIndex) => {
        const originalWordText = word.word || ''
        if (!originalWordText) return null
        const wordText = removeRubyAnnotations(originalWordText)
        const parsedParts = parseRubyText(originalWordText)
        const hasRuby = parsedParts.some(part => part.ruby)
        const isSpace = wordText.trim() === ''
        if (isSpace) {
          return (
            <span
              key={`space-${originalIndex}`}
              aria-hidden="true"
              className="inline-block shrink-0"
              style={{ width: `${Math.max(1, Array.from(wordText).length) * 0.24}em` }}
            />
          )
        }

        const safeDuration = Math.max(word.duration, 1)
        const startTime = word.startTime
        const endTime = startTime + safeDuration
        // 柔和模式：整词一个单元（与播放页 soft 一致），填充在词内从左到右
        const fillProgress = clamp((currentMs - startTime) / safeDuration)
        const fillWidth = fillProgress * 100
        const fullyFilled = currentMs >= endTime
        const isInTimeRange = currentMs >= startTime && currentMs < endTime
        // 柔和字上浮：起唱前 180ms 预备、520ms cubic-out 到位
        const softLiftRaw = clamp((currentMs - (startTime - 180)) / 520)
        const softLiftProgress = 1 - Math.pow(1 - softLiftRaw, 3)
        const softLiftStyle = {
          transform: `translateY(${-0.075 * softLiftProgress}em)`,
          transformOrigin: 'center bottom' as const,
          willChange: 'transform' as const,
        }
        const shouldShowFill = fillWidth > 0 && (isInTimeRange || fullyFilled)
        const displayFillWidth = fullyFilled ? 100 : fillWidth
        const overlay = getFillOverlayStyle(displayFillWidth)
        const isActiveWord = isInTimeRange && fillProgress > 0.015

        return (
          <span
            key={`word-${originalIndex}`}
            className="lyric-word-effect inline-block relative py-[0.02em] cursor-pointer"
            style={{
              color: fullyFilled ? 'transparent' : inactiveColor,
              textShadow: isActiveWord
                ? (dark ? SOFT_CONFIG.activeTextShadowDark : SOFT_CONFIG.activeTextShadowLight)
                : fullyFilled
                  ? 'none'
                  : baseTextShadow,
              filter: fullyFilled ? 'none' : SOFT_CONFIG.inactiveFilter,
              transition: 'text-shadow 180ms ease-out, filter 180ms ease-out',
              ...softLiftStyle,
            }}
            onMouseEnter={() => {
              if (hoverTimerRef.current) window.clearTimeout(hoverTimerRef.current)
              hoverTimerRef.current = window.setTimeout(() => setBreathingIndex(originalIndex), 1000)
            }}
            onMouseLeave={() => {
              if (hoverTimerRef.current) { window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
              setBreathingIndex(current => (current === originalIndex ? null : current))
            }}
            onClick={(event) => {
              event.stopPropagation()
              if (hoverTimerRef.current) { window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null }
              setBreathingIndex(null)
              onPlayWord?.(lyric.time + startTime / 1000)
            }}
            title={`从「${wordText}」开始播（咬字练习）`}
          >
            <span className="relative z-0">
              {hasRuby
                ? parsedParts.map((part, idx) =>
                    part.ruby
                      ? <ruby key={idx}>{part.base}<rt>{part.ruby}</rt></ruby>
                      : <span key={idx}>{part.base}</span>,
                  )
                : wordText}
            </span>
            {shouldShowFill && displayFillWidth > 0 && (
              <span
                aria-hidden="true"
                className="absolute left-0 top-0 z-10 overflow-hidden whitespace-nowrap pointer-events-none"
                style={{
                  ...overlay,
                  // 唱完后填充层保留完整亮色（mask 移除），避免灰闪
                  ...(fullyFilled ? { WebkitMaskImage: 'none', maskImage: 'none' } : {}),
                  top: '50%',
                  transform: 'translateY(-50%)',
                  color: activeColor,
                  textShadow: 'none',
                  transition: 'none',
                }}
              >
                {hasRuby
                  ? parsedParts.map((part, idx) =>
                      part.ruby
                        ? <ruby key={idx}>{part.base}<rt>{part.ruby}</rt></ruby>
                        : <span key={idx}>{part.base}</span>,
                    )
                  : wordText}
              </span>
            )}
            {/* 呼吸辉光（咬字提示）：hover 1s 后触发，盖在词上不遮填充 */}
            {breathingIndex === originalIndex && (
              <span
                aria-hidden="true"
                className="absolute inset-0 rounded-md pointer-events-none"
                style={{ boxShadow: '0 0 14px rgba(196,181,253,0.8)', animation: 'singalongBreath 1.2s ease-in-out infinite' }}
              />
            )}
          </span>
        )
      })}
    </span>
  )
}

/**
 * 逐字罗马音行（播放页 LyricsDisplay 罗马音填充的同源简化版）：
 * 底层暗字 + 上层亮色填充层按词进度推进；romanWords 数量与主行词一致时
 * 借用主行时间，否则按时间递增/字符数均分对齐（与 LyricsDisplay.alignRomanWords 同思路）。
 */
export function RomanWordLine({ lyric, currentTime, lyricOffset, dark }: {
  lyric: LyricLine
  currentTime: number
  lyricOffset: number
  dark: boolean
}) {
  const romanWords = lyric.romanWords || []

  const aligned = useMemo(() => {
    const roman = romanWords.filter(word => word.word?.trim())
    const source = (lyric.words || []).filter(word => word.word?.trim())
    if (roman.length === 0) return []
    let timings: Array<{ start: number; end: number }>
    if (roman.length === source.length) {
      timings = roman.map((word, index) => ({
        start: (word.startTime ?? source[index].startTime),
        end: (word.startTime ?? source[index].startTime) + Math.max(1, word.duration ?? source[index].duration),
      }))
    } else {
      const hasIncreasing = roman.some((word, index) => index > 0 && (word.startTime ?? 0) > (roman[index - 1].startTime ?? 0))
      if (hasIncreasing) {
        timings = roman.map((word, index) => {
          const start = Math.max(0, word.startTime ?? 0)
          const rawEnd = start + Math.max(1, word.duration ?? 1)
          const nextStart = roman.slice(index + 1).find(next => (next.startTime ?? 0) > (word.startTime ?? 0))?.startTime
          return { start, end: nextStart != null ? Math.min(rawEnd, nextStart) : rawEnd }
        })
      } else {
        const sourceEnd = source.reduce((end, word) => Math.max(end, word.startTime + Math.max(1, word.duration)), 0)
        const totalChars = roman.reduce((count, word) => count + Math.max(1, Array.from(word.word).length), 0)
        let elapsed = 0
        timings = roman.map(word => {
          const chars = Math.max(1, Array.from(word.word).length)
          const start = sourceEnd * elapsed / totalChars
          elapsed += chars
          return { start, end: sourceEnd * elapsed / totalChars }
        })
      }
    }
    return roman.map((word, index) => ({ text: word.word, ...timings[index] }))
  }, [romanWords, lyric.words])

  const currentMs = (currentTime + lyricOffset) * 1000 - lyric.time * 1000 - 200

  return (
    <>
      {aligned.map((item, index) => {
        const fillProgress = clamp((currentMs - item.start) / Math.max(1, item.end - item.start))
        const fillWidth = fillProgress * 100
        const fullyFilled = currentMs >= item.end
        return (
          <span key={`roman-${index}`} className="relative inline-block" style={{ color: dark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)' }}>
            {item.text}
            {(fillWidth > 0 || fullyFilled) && (
              <span
                aria-hidden="true"
                className="absolute left-0 top-0 overflow-hidden whitespace-nowrap pointer-events-none"
                style={{
                  width: fullyFilled ? '100%' : `${fillWidth}%`,
                  color: dark ? 'rgba(110,231,183,0.95)' : 'rgba(16,185,129,0.95)',
                }}
              >
                {item.text}
              </span>
            )}
          </span>
        )
      })}
    </>
  )
}
