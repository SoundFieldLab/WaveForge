const API_BASE = 'http://localhost:3001/api'
const OFFICIAL_KEY_URL = 'https://y.qq.com/n/ryqq_v2/qqmusic_skills'
const SESSION_KEY = 'waveforge.qqmusicSkills.sessionKey'

const normalizeKey = (value: unknown) => {
  const key = String(value || '').trim()
  return /^qmk-[A-Za-z0-9._-]+$/.test(key) ? key : ''
}

export async function getQQMusicSkillKey(): Promise<string> {
  try {
    if (window.electron?.credentials) {
      const result = await window.electron.credentials.getQQMusicSkillKey()
      return result.success ? normalizeKey(result.key) : ''
    }
  } catch {
    // 浏览器调试环境回退到仅当前标签页有效的 sessionStorage。
  }
  return normalizeKey(sessionStorage.getItem(SESSION_KEY))
}

export async function saveQQMusicSkillKey(value: string) {
  const key = normalizeKey(value)
  if (!key) throw new Error('API Key 格式应为 qmk-…')
  if (window.electron?.credentials) {
    const result = await window.electron.credentials.setQQMusicSkillKey(key)
    if (!result.success) throw new Error(result.error || 'API Key 保存失败')
    return { secure: result.secure !== false }
  }
  sessionStorage.setItem(SESSION_KEY, key)
  return { secure: false }
}

export async function deleteQQMusicSkillKey() {
  if (window.electron?.credentials) {
    const result = await window.electron.credentials.deleteQQMusicSkillKey()
    if (!result.success) throw new Error(result.error || 'API Key 删除失败')
  }
  sessionStorage.removeItem(SESSION_KEY)
}

export async function getQQMusicSkillHeaders(): Promise<Record<string, string>> {
  const key = await getQQMusicSkillKey()
  return key ? { 'X-QQMusic-Skill-Key': key } : {}
}

export async function openQQMusicSkillKeyPage(): Promise<{ success: boolean; apiKey?: string; error?: string }> {
  if (window.electron?.openQQSkillKeyWindow) {
    try {
      return await window.electron.openQQSkillKeyWindow()
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : '打开领取窗口失败' }
    }
  }
  window.open(OFFICIAL_KEY_URL, '_blank', 'noopener,noreferrer')
  return { success: false }
}

async function parseJsonResponse(response: Response) {
  const data = await response.json().catch(() => ({}))
  if (!response.ok || Number(data.code || 200) >= 400) {
    throw new Error(data.error || data.message || `请求失败 (${response.status})`)
  }
  return data
}

export async function verifyQQMusicSkillKey(cookie: string) {
  const headers = await getQQMusicSkillHeaders()
  const url = new URL(`${API_BASE}/explore/qq/skills/status`)
  if (cookie) url.searchParams.set('cookie', cookie)
  return parseJsonResponse(await fetch(url, { headers }))
}

export type QQMusicReportPeriod = 'd' | 'w' | 'm'

export async function fetchQQMusicListeningReport(period: QQMusicReportPeriod, cookie: string) {
  const headers = await getQQMusicSkillHeaders()
  const url = new URL(`${API_BASE}/explore/qq/skills/report`)
  url.searchParams.set('timeKey', period)
  if (cookie) url.searchParams.set('cookie', cookie)
  return parseJsonResponse(await fetch(url, { headers }))
}

const extractSseText = (payload: string) => {
  const trimmed = payload.trim()
  if (!trimmed || trimmed === '[DONE]') return ''
  try {
    const parsed = JSON.parse(trimmed)
    const candidates = [
      parsed.text,
      parsed.content,
      parsed.answer,
      parsed.response,
      parsed.message,
      parsed.reply,
      parsed.result,
      parsed.output,
      parsed.delta?.content,
      parsed.choices?.[0]?.delta?.content,
      parsed.data?.text,
      parsed.data?.content,
      parsed.data?.answer,
      parsed.data?.response,
      parsed.data?.delta?.content,
      parsed.data?.reply,
      parsed.data?.result,
    ]
    return String(candidates.find(value => typeof value === 'string' && value.trim()) || '')
  } catch {
    return trimmed
  }
}

export async function streamQQMusicInterpretation(
  query: string,
  cookie: string,
  onText: (fullText: string) => void,
) {
  const headers = await getQQMusicSkillHeaders()
  const response = await fetch(`${API_BASE}/explore/qq/skills/interpretation`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, cookie, assetTypes: [1, 2] }),
  })
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}))
    throw new Error(data.error || `AI 解读失败 (${response.status})`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let fullText = ''
  while (true) {
    const { done, value } = await reader.read()
    buffer += decoder.decode(value, { stream: !done })
    const events = buffer.split(/\r?\n\r?\n/)
    buffer = done ? '' : events.pop() || ''
    for (const event of events) {
      const payload = event
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      const text = extractSseText(payload)
      if (text) {
        fullText += text
        onText(fullText)
      }
    }
    if (done) break
  }
  if (buffer.trim()) {
    const text = extractSseText(buffer.replace(/^data:\s*/gm, ''))
    if (text) {
      fullText += text
      onText(fullText)
    }
  }
  return fullText
}
