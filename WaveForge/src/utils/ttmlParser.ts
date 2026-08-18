/**
 * TTML (Timed Text Markup Language) 解析器
 * 用于解析 Apple Music / AMLL TTML DB 的逐字歌词格式
 */

export interface TTMLWord {
  text: string
  startTime: number
  endTime: number
}

export interface TTMLLine {
  words: TTMLWord[]
  startTime: number
  endTime: number
  translation?: string
  roman?: string
  /** 演唱者（ttm:agent 引用，如 v1/v2）——对唱/多声部歌曲用于逐人着色 */
  agent?: string
  /** x-bg 背景和声词（带独立时间轴，可作弱化渲染） */
  bgWords?: TTMLWord[]
}

export interface TTMLAgent {
  id: string
  type: string
}

export interface TTMLLyric {
  lines: TTMLLine[]
  /** head 中声明的演唱者（person/group/other） */
  agents?: TTMLAgent[]
  /** 前导静音偏移（毫秒），时间轴整体平移用 */
  leadingSilenceMs?: number
}

/**
 * 解析时间字符串（格式：HH:MM:SS.mmm / MM:SS.mmm / 1,234 秒,毫秒 / 纯秒）
 */
function parseTime(timeStr: string): number {
  const normalized = timeStr.trim()
  if (normalized.endsWith('ms')) return Number.parseFloat(normalized) || 0
  if (normalized.endsWith('s')) return (Number.parseFloat(normalized) || 0) * 1000
  // AMLL 方言：begin="1,234" 表示 1秒+234毫秒
  if (/^\d+,\d+$/.test(normalized)) {
    const [secondsPart, msPart] = normalized.split(',')
    return (Number.parseInt(secondsPart, 10) || 0) * 1000 + (Number.parseInt(msPart, 10) || 0)
  }

  const parts = normalized.split(':')
  let seconds = 0
  
  if (parts.length === 3) {
    // HH:MM:SS.mmm
    seconds = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseFloat(parts[2])
  } else if (parts.length === 2) {
    // MM:SS.mmm
    seconds = parseInt(parts[0]) * 60 + parseFloat(parts[1])
  } else {
    seconds = parseFloat(timeStr)
  }
  
  return seconds * 1000 // 转换为毫秒
}

const getTtmlAttr = (element: Element, qualifiedName: string, namespace = 'http://www.w3.org/ns/ttml#metadata') =>
  element.getAttributeNS(namespace, qualifiedName) || element.getAttribute(`ttm:${qualifiedName}`)

/**
 * 解析TTML XML文本
 */
export function parseTTML(ttmlText: string): TTMLLyric {
  const parser = new DOMParser()
  const xmlDoc = parser.parseFromString(ttmlText, 'text/xml')
  if (xmlDoc.getElementsByTagName('parsererror').length > 0) {
    throw new Error('AMLL TTML XML 解析失败')
  }

  const lines: TTMLLine[] = []
  const agents: TTMLAgent[] = []
  let leadingSilenceMs: number | undefined

  // head 元数据：演唱者声明 + 前导静音
  const metadataNodes = Array.from(xmlDoc.getElementsByTagNameNS('*', 'metadata'))
  metadataNodes.forEach(metadata => {
    Array.from(metadata.children).forEach(node => {
      const local = node.localName || ''
      if (local === 'agent') {
        const id = node.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'id') || node.getAttribute('xml:id') || ''
        const type = node.getAttribute('type') || 'other'
        if (id && !agents.some(agent => agent.id === id)) agents.push({ id, type })
      } else if (local === 'leadingSilence') {
        const text = (node.textContent || '').trim()
        if (!text) return
        const value = Number.parseFloat(text)
        if (Number.isFinite(value)) {
          // 兼容三种写法：带 ms 后缀（毫秒）、小数（秒）、纯数字（毫秒）
          leadingSilenceMs = text.endsWith('ms')
            ? Math.round(value)
            : String(text).includes('.')
              ? Math.round(value * 1000)
              : Math.round(value)
        }
      }
    })
  })

  // 获取所有 <p> 元素（每个代表一行歌词）
  const paragraphs = Array.from(xmlDoc.getElementsByTagNameNS('*', 'p'))

  paragraphs.forEach(p => {
    // 个别 Apple 文件把翻译/罗马音作为独立 <p> 行：不作为主歌词行渲染
    const paragraphRole = getTtmlAttr(p, 'role')
    if (paragraphRole === 'x-translation' || paragraphRole === 'x-roman') return

    const begin = p.getAttribute('begin')
    const end = p.getAttribute('end')
    
    if (!begin || !end) return
    
    const lineStartTime = parseTime(begin)
    const lineEndTime = parseTime(end)
    
    const words: TTMLWord[] = []
    const bgWords: TTMLWord[] = []
    let translation = ''
    let roman = ''
    let primaryText = ''
    
    // 只解析当前行的直接子节点。背景人声 span 内还会嵌套 span，若递归
    // querySelectorAll 会把主歌词、背景歌词和辅助文本重复拼接。
    Array.from(p.childNodes).forEach(node => {
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
      const role = getTtmlAttr(span, 'role')

      if (role === 'x-translation') {
        // 翻译文本
        translation = span.textContent || ''
      } else if (role === 'x-roman') {
        // 罗马音
        roman = span.textContent || ''
      } else if (role === 'x-bg') {
        // 背景和声：递归收集带时间的词（弱化渲染用）
        const collectBg = (el: Element): TTMLWord[] => {
          const collected: TTMLWord[] = []
          Array.from(el.childNodes).forEach(child => {
            if (child.nodeType === Node.TEXT_NODE) {
              const text = child.textContent || ''
              if (text && collected.length > 0) {
                collected[collected.length - 1].text += text
              } else if (text) {
                collected.push({ text, startTime: lineStartTime, endTime: lineEndTime })
              }
              return
            }
            if (child.nodeType !== Node.ELEMENT_NODE) return
            const childEl = child as Element
            if (childEl.localName !== 'span') return
            const subRole = getTtmlAttr(childEl, 'role')
            if (subRole && subRole !== 'x-bg') return
            const wordBegin = childEl.getAttribute('begin')
            const wordEnd = childEl.getAttribute('end')
            const text = childEl.textContent || ''
            if (wordBegin && wordEnd && text) {
              collected.push({ text, startTime: parseTime(wordBegin), endTime: parseTime(wordEnd) })
            } else {
              collected.push(...collectBg(childEl))
            }
          })
          return collected
        }
        bgWords.push(...collectBg(span))
      } else {
        // 普通歌词词语
        const wordBegin = span.getAttribute('begin')
        const wordEnd = span.getAttribute('end')
        const text = span.textContent || ''
        primaryText += text
        
        if (wordBegin && wordEnd && text) {
          words.push({
            text,
            startTime: parseTime(wordBegin),
            endTime: parseTime(wordEnd)
          })
        } else if (text && words.length > 0) {
          words[words.length - 1].text += text
        }
      }
    })
    
    // 如果没有逐字时间轴，尝试获取整行文本
    if (words.length === 0) {
      if (primaryText.trim()) {
        words.push({
          text: primaryText.trim(),
          startTime: lineStartTime,
          endTime: lineEndTime
        })
      }
    }
    
    if (words.length > 0) {
      lines.push({
        words,
        startTime: lineStartTime,
        endTime: lineEndTime,
        translation: translation || undefined,
        roman: roman || undefined,
        agent: getTtmlAttr(p, 'agent') || undefined,
        bgWords: bgWords.length > 0 ? bgWords : undefined,
      })
    }
  })
  
  return { lines, agents: agents.length > 0 ? agents : undefined, leadingSilenceMs }
}

/**
 * 将TTML格式转换为LRC格式
 */
export function ttmlToLRC(ttml: TTMLLyric): string {
  const lrcLines: string[] = []
  
  ttml.lines.forEach(line => {
    const minutes = Math.floor(line.startTime / 60000)
    const seconds = Math.floor((line.startTime % 60000) / 1000)
    const milliseconds = Math.floor((line.startTime % 1000) / 10)
    
    const timestamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}]`
    const text = line.words.map(w => w.text).join('')
    
    lrcLines.push(`${timestamp}${text}`)
  })
  
  return lrcLines.join('\n')
}

/**
 * 将TTML格式转换为翻译LRC格式
 */
export function ttmlToTranslationLRC(ttml: TTMLLyric): string {
  const lrcLines: string[] = []
  
  ttml.lines.forEach(line => {
    if (!line.translation) return
    
    const minutes = Math.floor(line.startTime / 60000)
    const seconds = Math.floor((line.startTime % 60000) / 1000)
    const milliseconds = Math.floor((line.startTime % 1000) / 10)
    
    const timestamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(2, '0')}]`
    
    lrcLines.push(`${timestamp}${line.translation}`)
  })
  
  return lrcLines.join('\n')
}

/**
 * 将TTML格式转换为YRC逐字格式（类似网易云YRC）
 */
export function ttmlToYRC(ttml: TTMLLyric): string {
  const yrcLines: string[] = []
  
  ttml.lines.forEach(line => {
    const minutes = Math.floor(line.startTime / 60000)
    const seconds = Math.floor((line.startTime % 60000) / 1000)
    const milliseconds = Math.floor(line.startTime % 1000)
    
    const timestamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}]`
    
    // 构建逐字时间轴
    const wordTimings = line.words.map(word => {
      const duration = word.endTime - word.startTime
      return `(${word.startTime},${duration})${word.text}`
    }).join('')
    
    yrcLines.push(`${timestamp}${wordTimings}`)
  })
  
  return yrcLines.join('\n')
}
