/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/** TTML parser for Apple Music and the AMLL TTML database. */

export interface TTMLWord {
  text: string
  startTime: number
  endTime: number
}

export type TTMLAlternateTextType = 'translation' | 'romanization' | string

export interface TTMLAlternateText {
  role: TTMLAlternateTextType
  type: TTMLAlternateTextType
  text: string
  language?: string
  lang?: string
  agent?: string
  startTime: number
  endTime: number
  time: number
  words?: TTMLWord[]
}

export interface TTMLBackgroundVocal {
  text: string
  startTime: number
  endTime: number
  time: number
  words: TTMLWord[]
  agent?: string
  agentId?: string
  translation?: string
  roman?: string
  romanization?: string
  alternateTexts?: TTMLAlternateText[]
}

export interface TTMLLine {
  words: TTMLWord[]
  startTime: number
  endTime: number
  role?: string
  translation?: string
  roman?: string
  agent?: string
  alternateTexts?: TTMLAlternateText[]
  backgroundVocals?: TTMLBackgroundVocal[]
  /** Legacy compatibility for existing Apple lyric renderers. */
  bgWords?: TTMLWord[]
}

export interface TTMLAgent {
  id: string
  type: string
}

export interface TTMLLyric {
  lines: TTMLLine[]
  agents?: TTMLAgent[]
  leadingSilenceMs?: number
  /** 当前文档内没有主行可归并的独立翻译/罗马音，供跨 localization 文档归并。 */
  standaloneAlternates?: TTMLAlternateText[]
}

function parseTime(timeStr: string): number {
  const normalized = timeStr.trim()
  if (normalized.endsWith('ms')) return Number.parseFloat(normalized) || 0
  if (normalized.endsWith('s')) return (Number.parseFloat(normalized) || 0) * 1000
  if (/^\d+,\d+$/.test(normalized)) {
    const [secondsPart, msPart] = normalized.split(',')
    return (Number.parseInt(secondsPart, 10) || 0) * 1000 + (Number.parseInt(msPart, 10) || 0)
  }

  const parts = normalized.split(':')
  let seconds = 0
  if (parts.length === 3) {
    seconds = Number.parseInt(parts[0], 10) * 3600 + Number.parseInt(parts[1], 10) * 60 + Number.parseFloat(parts[2])
  } else if (parts.length === 2) {
    seconds = Number.parseInt(parts[0], 10) * 60 + Number.parseFloat(parts[1])
  } else {
    seconds = Number.parseFloat(normalized)
  }
  return Number.isFinite(seconds) ? seconds * 1000 : 0
}

const getTtmlAttr = (element: Element, name: string) =>
  element.getAttributeNS('http://www.w3.org/ns/ttml#metadata', name)
  || element.getAttribute(`ttm:${name}`)
  || element.getAttribute(name)
  || undefined

const getLanguage = (element: Element): string | undefined =>
  element.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang')
  || element.getAttribute('xml:lang')
  || undefined

const normalizeRole = (role?: string): TTMLAlternateTextType => {
  if (role === 'x-translation') return 'translation'
  if (role === 'x-roman') return 'romanization'
  return role || 'alternate'
}

const textOf = (element: Element) => (element.textContent || '').trim()

function collectTimedWords(element: Element, fallbackStart: number, fallbackEnd: number): TTMLWord[] {
  const words: TTMLWord[] = []
  const visit = (node: Node, inheritedStart: number, inheritedEnd: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || ''
      if (!text) return
      if (words.length > 0) words[words.length - 1].text += text
      else words.push({ text, startTime: inheritedStart, endTime: inheritedEnd })
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const child = node as Element
    if (child.localName !== 'span') return
    const role = getTtmlAttr(child, 'role')
    if (role === 'x-translation' || role === 'x-roman') return
    const start = child.getAttribute('begin') ? parseTime(child.getAttribute('begin')!) : inheritedStart
    const end = child.getAttribute('end') ? parseTime(child.getAttribute('end')!) : inheritedEnd
    const hasNestedSpan = Array.from(child.children).some(grandchild => grandchild.localName === 'span')
    if (!hasNestedSpan) {
      const text = child.textContent || ''
      if (text) words.push({ text, startTime: start, endTime: end })
      return
    }
    Array.from(child.childNodes).forEach(grandchild => visit(grandchild, start, end))
  }
  Array.from(element.childNodes).forEach(node => visit(node, fallbackStart, fallbackEnd))
  return words
}

function createAlternateText(
  element: Element,
  role: string,
  startTime: number,
  endTime: number,
  inheritedAgent?: string,
): TTMLAlternateText | null {
  const text = textOf(element)
  if (!text) return null
  const type = normalizeRole(role)
  const language = getLanguage(element)
  const agent = getTtmlAttr(element, 'agent') || inheritedAgent
  const words = collectTimedWords(element, startTime, endTime)
  return {
    role: type,
    type,
    text,
    language,
    lang: language,
    agent,
    startTime,
    endTime,
    time: startTime,
    words: words.length > 0 ? words : undefined,
  }
}

function appendAlternate(target: { alternateTexts?: TTMLAlternateText[] }, alternate: TTMLAlternateText) {
  const current = target.alternateTexts ?? []
  if (!current.some(item => item.role === alternate.role && item.text === alternate.text && item.language === alternate.language)) {
    current.push(alternate)
  }
  target.alternateTexts = current
}

function applyAlternateCompatibility(target: TTMLLine | TTMLBackgroundVocal, alternate: TTMLAlternateText) {
  appendAlternate(target, alternate)
  if (alternate.role === 'translation' && !target.translation) target.translation = alternate.text
  if (alternate.role === 'romanization' && !target.roman) target.roman = alternate.text
  if ('romanization' in target && alternate.role === 'romanization' && !target.romanization) {
    target.romanization = alternate.text
  }
}

function parseBackgroundVocal(
  element: Element,
  lineStart: number,
  lineEnd: number,
  inheritedAgent?: string,
): TTMLBackgroundVocal | null {
  const startTime = element.getAttribute('begin') ? parseTime(element.getAttribute('begin')!) : lineStart
  const endTime = element.getAttribute('end') ? parseTime(element.getAttribute('end')!) : lineEnd
  const agent = getTtmlAttr(element, 'agent') || inheritedAgent
  const words = collectTimedWords(element, startTime, endTime)
  const vocal: TTMLBackgroundVocal = {
    text: words.map(word => word.text).join('').trim(),
    startTime,
    endTime,
    time: startTime,
    words,
    agent,
    agentId: agent,
  }
  Array.from(element.children).forEach(child => {
    const role = getTtmlAttr(child, 'role')
    if (role !== 'x-translation' && role !== 'x-roman') return
    const alternate = createAlternateText(child, role, startTime, endTime, agent)
    if (alternate) applyAlternateCompatibility(vocal, alternate)
  })
  return vocal.text || vocal.alternateTexts?.length ? vocal : null
}

function sameTimedAgent(line: TTMLLine, alternate: TTMLAlternateText): boolean {
  const sameTime = Math.abs(line.startTime - alternate.startTime) <= 1
    && Math.abs(line.endTime - alternate.endTime) <= 1
  return sameTime && (line.agent || '') === (alternate.agent || '')
}

export function parseTTML(ttmlText: string): TTMLLyric {
  const xmlDoc = new DOMParser().parseFromString(ttmlText, 'text/xml')
  if (xmlDoc.getElementsByTagName('parsererror').length > 0) throw new Error('AMLL TTML XML 解析失败')

  const lines: TTMLLine[] = []
  const standaloneAlternates: TTMLAlternateText[] = []
  const agents: TTMLAgent[] = []
  let leadingSilenceMs: number | undefined

  Array.from(xmlDoc.getElementsByTagNameNS('*', 'metadata')).forEach(metadata => {
    Array.from(metadata.children).forEach(node => {
      if (node.localName === 'agent') {
        const id = node.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'id') || node.getAttribute('xml:id') || ''
        if (id && !agents.some(agent => agent.id === id)) agents.push({ id, type: node.getAttribute('type') || 'other' })
      } else if (node.localName === 'leadingSilence') {
        const text = textOf(node)
        const value = Number.parseFloat(text)
        if (Number.isFinite(value)) {
          leadingSilenceMs = text.endsWith('ms') ? Math.round(value) : text.includes('.') ? Math.round(value * 1000) : Math.round(value)
        }
      }
    })
  })

  Array.from(xmlDoc.getElementsByTagNameNS('*', 'p')).forEach(paragraph => {
    const begin = paragraph.getAttribute('begin')
    const end = paragraph.getAttribute('end')
    if (!begin || !end) return
    const startTime = parseTime(begin)
    const endTime = parseTime(end)
    const role = getTtmlAttr(paragraph, 'role')
    const agent = getTtmlAttr(paragraph, 'agent')

    if (role === 'x-translation' || role === 'x-roman') {
      const alternate = createAlternateText(paragraph, role, startTime, endTime, agent)
      if (alternate) standaloneAlternates.push(alternate)
      return
    }

    const words: TTMLWord[] = []
    const backgroundVocals: TTMLBackgroundVocal[] = []
    let primaryText = ''
    const line: TTMLLine = { words, startTime, endTime, role, agent }

    Array.from(paragraph.childNodes).forEach(node => {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent || ''
        primaryText += text
        if (text && words.length > 0) {
          const previousEnd = words[words.length - 1].endTime
          words.push({ text, startTime: previousEnd, endTime: previousEnd })
        }
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const span = node as Element
      if (span.localName !== 'span') return
      const spanRole = getTtmlAttr(span, 'role')
      if (spanRole === 'x-translation' || spanRole === 'x-roman') {
        const alternate = createAlternateText(span, spanRole, startTime, endTime, agent)
        if (alternate) applyAlternateCompatibility(line, alternate)
      } else if (spanRole === 'x-bg') {
        const vocal = parseBackgroundVocal(span, startTime, endTime, agent)
        if (vocal) backgroundVocals.push(vocal)
      } else {
        primaryText += span.textContent || ''
        words.push(...collectTimedWords(span, startTime, endTime))
      }
    })

    if (words.length === 0 && primaryText.trim()) words.push({ text: primaryText.trim(), startTime, endTime })
    if (words.length === 0) return
    if (backgroundVocals.length > 0) {
      line.backgroundVocals = backgroundVocals
      line.bgWords = backgroundVocals.flatMap(vocal => vocal.words)
    }
    lines.push(line)
  })

  const unmatchedAlternates: TTMLAlternateText[] = []
  standaloneAlternates.forEach(alternate => {
    const target = lines.find(line => sameTimedAgent(line, alternate))
    if (target) applyAlternateCompatibility(target, alternate)
    else unmatchedAlternates.push(alternate)
  })

  return {
    lines: lines.sort((a, b) => a.startTime - b.startTime),
    agents: agents.length > 0 ? agents : undefined,
    leadingSilenceMs,
    standaloneAlternates: unmatchedAlternates.length > 0 ? unmatchedAlternates : undefined,
  }
}

export function ttmlToLRC(ttml: TTMLLyric): string {
  return ttml.lines.map(line => {
    const minutes = Math.floor(line.startTime / 60000)
    const seconds = Math.floor((line.startTime % 60000) / 1000)
    const milliseconds = Math.floor((line.startTime % 1000) / 10)
    return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}]${line.words.map(word => word.text).join('')}`
  }).join('\n')
}

export function ttmlToTranslationLRC(ttml: TTMLLyric): string {
  return ttml.lines.filter(line => line.translation).map(line => {
    const minutes = Math.floor(line.startTime / 60000)
    const seconds = Math.floor((line.startTime % 60000) / 1000)
    const milliseconds = Math.floor((line.startTime % 1000) / 10)
    return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}]${line.translation}`
  }).join('\n')
}

export function ttmlToYRC(ttml: TTMLLyric): string {
  return ttml.lines.map(line => {
    const minutes = Math.floor(line.startTime / 60000)
    const seconds = Math.floor((line.startTime % 60000) / 1000)
    const milliseconds = Math.floor(line.startTime % 1000)
    const timestamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}]`
    return timestamp + line.words.map(word => `(${word.startTime},${word.endTime - word.startTime})${word.text}`).join('')
  }).join('\n')
}
