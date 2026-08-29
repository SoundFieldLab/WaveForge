import { useEffect, useMemo, useRef, type CSSProperties } from 'react'
import type { PlaybackTimeStore } from '../audio/playbackTimeStore'
import type { LyricLine } from '../services/musicApi'
import {
  buildProgressiveLyricGlyphs,
  type TimedLyricGlyph,
} from '../utils/lyricWordTiming'

interface ProgressiveGlyphTextProps {
  line: LyricLine
  playbackTimeStore: PlaybackTimeStore
  timeOffset: number
  filledColor: string
  inactiveColor: string
  glowColor: string
  fallbackDuration?: number
  className?: string
  style?: CSSProperties
}

interface GlyphGroup {
  key: string
  glyphs: TimedLyricGlyph[]
  whitespace: boolean
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value))
const containsCjk = (value: string) => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/u.test(value)

const groupGlyphs = (glyphs: TimedLyricGlyph[]): GlyphGroup[] => {
  const groups: GlyphGroup[] = []
  glyphs.forEach((glyph, index) => {
    if (glyph.isWhitespace) {
      groups.push({ key: `space-${index}`, glyphs: [glyph], whitespace: true })
      return
    }
    const previous = groups[groups.length - 1]
    if (previous && !previous.whitespace && previous.glyphs[0]?.wordIndex === glyph.wordIndex) {
      previous.glyphs.push(glyph)
      return
    }
    groups.push({ key: `word-${glyph.wordIndex}-${index}`, glyphs: [glyph], whitespace: false })
  })
  return groups
}

/**
 * Renders every grapheme as an independently clipped fill layer. Unlike a single
 * background gradient this remains sequential when the lyric wraps onto a new line.
 */
export default function ProgressiveGlyphText({
  line,
  playbackTimeStore,
  timeOffset,
  filledColor,
  inactiveColor,
  glowColor,
  fallbackDuration,
  className,
  style,
}: ProgressiveGlyphTextProps) {
  const glyphs = useMemo(
    () => buildProgressiveLyricGlyphs(line, fallbackDuration),
    [fallbackDuration, line],
  )
  const groups = useMemo(() => groupGlyphs(glyphs), [glyphs])
  const fillRefs = useRef<Array<HTMLSpanElement | null>>([])

  useEffect(() => {
    let animationFrame: number | null = null
    let anchorTime = 0
    let anchorWallTime = performance.now()
    let playing = false
    let lastFrame = -1
    // 高刷屏限 60fps + 逐字脏检查：避免 240Hz 下每帧对整行所有字形重复写样式/drop-shadow
    const lastProgress = new Float64Array(glyphs.length)
    const lastGlow = new Uint8Array(glyphs.length)
    // 行末时间（最后一个非空白字形的结束时间）。整行唱完后填充不再变化，
    // 停掉外推循环避免空转；下一行激活时 glyphs 变化会重跑本 effect 并重启循环。
    const lineEndTime = glyphs.reduce(
      (maxEnd, glyph) => (!glyph.isWhitespace ? Math.max(maxEnd, glyph.endTime) : maxEnd),
      0
    )

    const updateFill = (currentTime: number) => {
      glyphs.forEach((glyph, index) => {
        const element = fillRefs.current[index]
        if (!element || glyph.isWhitespace) return
        const duration = Math.max(0.001, glyph.endTime - glyph.startTime)
        const progress = clamp((currentTime - glyph.startTime) / duration)
        // 进度基本未变的帧：跳过该字全部样式写（宽度取 0.05% 步进，低于人眼分辨率）
        if (Math.abs(progress - lastProgress[index]) <= 0.0005) return
        lastProgress[index] = progress
        element.style.width = `${(progress * 100).toFixed(2)}%`
        element.style.opacity = progress <= 0.001 ? '0' : '1'
        const glowOn = progress > 0.002 && progress < 0.998
        if (glowOn !== Boolean(lastGlow[index])) {
          lastGlow[index] = glowOn ? 1 : 0
          element.style.filter = glowOn ? `drop-shadow(0 0 8px ${glowColor})` : 'none'
        }
      })
    }

    const tick = (now: number) => {
      // 限 60fps：跳过的帧沿用原有停帧条件
      if (lastFrame >= 0 && now - lastFrame < 1000 / 60) {
        animationFrame = playing && document.visibilityState === 'visible' ? requestAnimationFrame(tick) : null
        return
      }
      lastFrame = now
      const extrapolated = playing ? Math.min(0.5, (now - anchorWallTime) / 1000) : 0
      const currentTime = anchorTime + extrapolated + timeOffset
      updateFill(currentTime)
      // 整行已唱完则停帧（外推值已无可见变化），等下一次播放时间发布再经 syncClock 重启；
      // 窗口隐藏时也停（Electron backgroundThrottling 关闭，隐藏后 rAF 仍全速执行样式写）
      animationFrame = playing && document.visibilityState === 'visible' && currentTime < lineEndTime ? requestAnimationFrame(tick) : null
    }

    const syncClock = () => {
      const snapshot = playbackTimeStore.getSnapshot()
      anchorTime = snapshot.currentTime
      anchorWallTime = performance.now()
      playing = snapshot.isPlaying
      updateFill(anchorTime + timeOffset)
      if (playing && animationFrame === null && anchorTime + timeOffset < lineEndTime && document.visibilityState === 'visible') {
        animationFrame = requestAnimationFrame(tick)
      }
    }

    fillRefs.current.length = glyphs.length
    syncClock()
    const unsubscribe = playbackTimeStore.subscribe(syncClock)
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && playing && animationFrame === null) {
        animationFrame = requestAnimationFrame(tick)
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (animationFrame !== null) cancelAnimationFrame(animationFrame)
    }
  }, [glowColor, glyphs, playbackTimeStore, timeOffset])

  let glyphCursor = 0
  return (
    <span className={className} style={style}>
      {groups.map(group => {
        if (group.whitespace) {
          const glyph = group.glyphs[0]
          glyphCursor += 1
          return <span key={group.key} style={{ whiteSpace: 'pre-wrap' }}>{glyph.text}</span>
        }

        const groupText = group.glyphs.map(glyph => glyph.text).join('')
        const canBreakInside = containsCjk(groupText) && group.glyphs.length > 3
        return (
          <span
            key={group.key}
            style={{ display: canBreakInside ? 'contents' : 'inline-block', whiteSpace: canBreakInside ? undefined : 'nowrap' }}
          >
            {group.glyphs.map(glyph => {
              const refIndex = glyphCursor
              glyphCursor += 1
              return (
                <span
                  key={`${glyph.wordIndex}-${glyph.glyphIndex}-${glyph.startTime}`}
                  className="relative inline-block"
                  style={{ color: inactiveColor, lineHeight: 'inherit' }}
                >
                  <span aria-hidden="true">{glyph.text}</span>
                  <span
                    ref={element => { fillRefs.current[refIndex] = element }}
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-0 overflow-hidden"
                    style={{
                      width: 0,
                      color: filledColor,
                      whiteSpace: 'nowrap',
                      willChange: 'width',
                      textShadow: `0 0 1px rgba(255,255,255,.72), 0 0 16px ${glowColor}`,
                    }}
                  >
                    {glyph.text}
                  </span>
                </span>
              )
            })}
          </span>
        )
      })}
    </span>
  )
}
