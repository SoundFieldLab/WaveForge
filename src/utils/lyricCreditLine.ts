/**
 * 歌词署名/元数据行识别（共享正则）。
 *
 * 使用方：musicApi（翻译/罗马音贪婪匹配时跳过元数据行）、mvAlignment（首句歌词判定）。
 * 覆盖中/日/英三语常见署名前缀：词/曲/编曲/作词/作曲/制作/混音/母带/訳詞 +
 * lyrics/composed/arranged/produced/mixed/mastered/written/words 等。
 * 注意「by」单列：'Lyrics by: X'、'Produced by: X'、'Mixed by: X' 都靠它命中。
 */
export const LYRIC_CREDIT_MARKER =
  '(?:词|詞|曲|编曲|編曲|作词|作詞|作曲|演唱|唱|歌手|专辑|專輯|制作|製作|混音|母带|母帶|录音|錄音|作|编|編|监制|監製|訳詞|译词|作詞・作曲|lyrics|composed|arranged|produced|mixed|mastered|written|music|words|remix|cover|vocal|guitar|piano|mix|by|ti|ar|al|offset)'

/** 完整署名行：标记开头（可多标记用 ·/、/,/&/+ 连接），后跟全角/半角冒号。'i' 兼容英文大小写。 */
export const LYRIC_CREDIT_LINE_RE = new RegExp(
  `^${LYRIC_CREDIT_MARKER}(?:\\s*[・·、,，/／&＆+＋]\\s*${LYRIC_CREDIT_MARKER})*\\s*[:：]`,
  'i',
)

/** 纯元数据歌词（只有署名行没有正文）判定：全部行都命中署名正则或为空。 */
export function isMetadataOnlyLyricTexts(texts: Array<string | undefined | null>): boolean {
  const nonEmpty = texts.map(t => (t || '').trim()).filter(Boolean)
  if (nonEmpty.length === 0) return false
  return !nonEmpty.some(text => !LYRIC_CREDIT_LINE_RE.test(text))
}
