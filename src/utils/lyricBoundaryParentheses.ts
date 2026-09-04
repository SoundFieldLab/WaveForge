export interface TimedLyricToken {
  word: string
  startTime: number
  duration: number
}

const getLeadingParentheses = (text: string) => text.trimStart().match(/^[（(]+/u)?.[0] || ''
const getTrailingParentheses = (text: string) => text.trimEnd().match(/[）)]+$/u)?.[0] || ''

/**
 * Reconcile only parentheses that the complete line already has at its outer
 * boundaries. Parentheses inside the lyric and all existing timings stay intact.
 */
export function reconcileBoundaryParentheses<T extends TimedLyricToken>(
  lineText: string,
  sourceTokens: readonly T[]
): TimedLyricToken[] {
  if (!lineText || sourceTokens.length === 0) return [...sourceTokens]

  let tokens: TimedLyricToken[] = sourceTokens.map(token => ({ ...token }))
  const completeLeading = Array.from(getLeadingParentheses(lineText))
  const timedLeading = Array.from(getLeadingParentheses(tokens.map(token => token.word).join('')))
  const missingLeading = completeLeading.slice(0, Math.max(0, completeLeading.length - timedLeading.length))

  if (missingLeading.length > 0) {
    tokens = [
      ...missingLeading.map(word => ({ word, startTime: 0, duration: 0 })),
      ...tokens,
    ]
  }

  const completeTrailing = Array.from(getTrailingParentheses(lineText))
  const timedTrailing = Array.from(getTrailingParentheses(tokens.map(token => token.word).join('')))
  const missingTrailingCount = Math.max(0, completeTrailing.length - timedTrailing.length)

  if (missingTrailingCount > 0) {
    const lastToken = tokens[tokens.length - 1]
    const boundaryStart = Math.max(0, lastToken.startTime + Math.max(0, lastToken.duration))
    const missingTrailing = completeTrailing.slice(completeTrailing.length - missingTrailingCount)
    tokens.push(...missingTrailing.map(word => ({ word, startTime: boundaryStart, duration: 0 })))
  }

  return tokens
}
