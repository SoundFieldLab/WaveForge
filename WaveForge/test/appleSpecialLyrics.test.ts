/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest'
import { parseTTML } from '../src/utils/ttmlParser'
import { collectAppleTtml, convertAppleTTMLToLyrics, getAgentTintColor, mergeAppleTtmlBundle } from '../src/services/appleMusic'

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xml:lang="en">
  <head><metadata>
    <ttm:agent xml:id="lead" type="person"/>
    <ttm:agent xml:id="guest" type="person"/>
    <ttm:leadingSilence>500ms</ttm:leadingSilence>
  </metadata></head>
  <body><div>
    <p begin="00:00:01.000" end="00:00:04.000" ttm:agent="lead">
      <span begin="00:00:01.000" end="00:00:02.000">Hello</span> <span begin="00:00:02.000" end="00:00:04.000">world</span>
      <span ttm:role="x-bg" ttm:agent="guest" begin="00:00:02.000" end="00:00:03.500">
        <span begin="00:00:02.000" end="00:00:03.500">sing along</span>
        <span ttm:role="x-translation" xml:lang="zh-Hans">一起唱</span>
      </span>
    </p>
    <p begin="00:00:01.000" end="00:00:04.000" ttm:agent="lead" ttm:role="x-translation" xml:lang="zh-Hans">你好世界</p>
    <p begin="00:00:01.000" end="00:00:04.000" ttm:agent="lead" ttm:role="x-roman">Harō wārudo</p>
    <p begin="00:00:04.000" end="00:00:06.000" ttm:agent="guest"><span begin="00:00:04.000" end="00:00:06.000">Reply</span></p>
  </div></body>
</tt>`

describe('Apple special TTML', () => {
  it('merges standalone alternates and preserves duet/background vocals', () => {
    const parsed = parseTTML(FIXTURE)
    expect(parsed.agents?.map(agent => agent.id)).toEqual(['lead', 'guest'])
    expect(parsed.lines).toHaveLength(2)
    expect(parsed.lines[0].translation).toBe('你好世界')
    expect(parsed.lines[0].roman).toBe('Harō wārudo')
    expect(parsed.lines[0].backgroundVocals?.[0]).toMatchObject({ text: 'sing along', agent: 'guest', translation: '一起唱' })
  })

  it('merges standalone translations from a separate localization document', () => {
    const base = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div><p begin="1s" end="3s" ttm:agent="lead"><span begin="1s" end="3s">Base lyric</span></p></div></body></tt>`
    const localized = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div><p begin="1s" end="3s" ttm:agent="lead" ttm:role="x-translation" xml:lang="zh-Hans">基础歌词</p></div></body></tt>`
    const merged = mergeAppleTtmlBundle({ primary: base, localizations: [localized] })
    const parsed = parseTTML(merged)
    expect(parsed.lines[0].text).toBeUndefined()
    expect(parsed.lines[0].words.map(word => word.text).join('')).toBe('Base lyric')
    expect(parsed.lines[0].translation).toBe('基础歌词')
  })

  it('assigns stable colors to arbitrary non-numeric agent ids by appearance order', () => {
    expect(getAgentTintColor('lead', 2, true, undefined, ['lead', 'guest'])).toBeUndefined()
    expect(getAgentTintColor('guest', 2, true, undefined, ['lead', 'guest'])).toBe('#ff9f43')
  })

  it('prioritizes the configured localization independent of locale casing', () => {
    const base = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="2s"><span begin="1s" end="2s">Base</span></p></div></body></tt>`
    const traditional = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="2s"><span begin="1s" end="2s">繁體</span></p></div></body></tt>`
    const simplified = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="1s" end="2s"><span begin="1s" end="2s">简体</span></p></div></body></tt>`
    const settings = { enabled: true, developerToken: '', mediaUserToken: '', storefront: 'cn', lyricLang: 'zh-hant-tw', preferAppleCover: true, duetColors: true }
    const bundle = collectAppleTtml({ ttml: base, ttmlLocalizations: { 'zh-Hans': simplified, 'ZH-HANT': traditional } }, settings)
    expect(bundle?.primary).toBe(traditional)
  })

  it('maps every special field into the common lyric model', () => {
    const result = convertAppleTTMLToLyrics(FIXTURE, ['Lead singer', 'Guest singer'])
    expect(result.hasDuet).toBe(true)
    expect(result.lyrics[0]).toMatchObject({
      time: 0.5,
      endTime: 3.5,
      text: 'Hello world',
      translation: '你好世界',
      roman: 'Harō wārudo',
      agent: 'lead',
      agentName: 'Lead singer',
    })
    expect(result.lyrics[0].backgroundVocals?.[0]).toMatchObject({
      time: 1.5,
      endTime: 3,
      agent: 'guest',
      agentName: 'Guest singer',
      translation: '一起唱',
    })
    expect(result.lyrics[1].agent).toBe('guest')
  })
})
