import type { AppleWebItem } from '../../services/appleWebService'

/**
 * 卡片文案行的归一（与 music.apple.com 官网卡片一致）。
 *
 * 官网卡片是「一行小标签 + 一行标题(可带 E 标) + 一行说明」：
 * - 小标签来自组内容的 `meta.reason.stringForDisplay`（服务层已解析为 `editorialLabel`），
 *   实测取值「下一首 / 最新发行 / 专属推荐 / <艺人>参与的作品」。它既不在资源标题里，
 *   也不在编辑简介里——只解析 plainEditorialNotes 永远拿不到，卡片就会缺这一行。
 * - 说明行的字段**随类型不同**（这是与官网逐卡比对的结果）：
 *   · 歌单 → `artistNames`（曲目艺人串，如「kessoku band、羽沢珈琲店にようこそ♪…」）
 *   · 专辑/单曲 → 艺人名
 *   · 电台 → 官网不显示第三行
 * - 标题行：歌单的编辑图常把歌名烤进画面（`superHeroTall.imageTraits` 含 `hasTitle`），
 *   官网此时**不再重复渲染标题**，否则卡片上会出现两遍同一个名字。
 *
 * 去重的必要性：部分条目（实测「…参与的作品」聚合卡）的 name / subtitle / description
 * 是**同一串文本**。逐行无条件渲染会把同一句话显示两三遍；而官网只显示两行不同内容。
 * 这里按 标题 → 标签 → 副标题 → 简介 的顺序登记，首次出现才保留，后续同文一律丢弃。
 */
export interface AppleCardMeta {
  /** 封面内的短标签（官网示例：「下一首」「最新发行」「专属推荐」） */
  label: string | null
  /** 主标题 */
  title: string | null
  /** 副标题（艺人 / 策展人 / 短名） */
  subtitle: string | null
  /** 编辑简介 */
  description: string | null
  /** 官网第三行（按类型取 artistNames / 艺人名；电台无此行） */
  detail: string | null
  /** 是否露骨内容（渲染 E 标） */
  explicit: boolean
}

export function resolveAppleCardMeta(item: AppleWebItem): AppleCardMeta {
  const seen = new Set<string>()
  const take = (value?: string | null): string | null => {
    const text = (value || '').trim()
    if (!text) return null
    const key = text.toLocaleLowerCase('zh-CN')
    if (seen.has(key)) return null
    seen.add(key)
    return text
  }

  // 标题先登记：小标签与标题同文时保留标题、丢弃标签（标题是卡片主行）。
  // 歌单编辑图已烤入歌名时不重复渲染标题（官网同款行为），此时标签仍会登记。
  const title = item.type === 'playlists' && item.artworkHasTitle ? null : take(item.name)
  const label = take(item.editorialLabel)
  // 先看原始副标题字段是否存在（空串/空白视为不存在），再判断是否与前面重复
  const rawSubtitle = (item.curatorName || item.artistName || item.subtitle || '').trim()
  const subtitle = take(rawSubtitle) ?? (rawSubtitle ? null : (title ? 'Apple Music' : null))
  // 官网卡片的第三行随类型不同（逐卡比对结果）：
  //   · 歌单 → 曲目艺人串（artistNames），如「kessoku band、羽沢珈琲店にようこそ♪…」；
  //     注意官网**优先于编辑简介**——「能量充电」的简介存在，但卡片上印的是艺人串。
  //   · 电台 → 编辑简介（如「精力充沛」下面是「高能节拍不停歇，全力输出不设限。」）
  //   · 专辑/单曲 → 艺人名（如「夜鷹 - Yodaka - Single」下面是「米津玄师」）
  const rawDetail = item.type === 'playlists'
    ? (item.artistNames || item.description || '')
    : item.type === 'stations' || item.type === 'radio-shows'
      ? (item.description || '')
      : (item.artistName || item.description || '')
  // 第三行只与「标签 + 标题」去重，不与副标题去重：专辑的副标题本来就是艺人名，
  // 若共用一套去重，官网那行「米津玄师」会被误删成两行卡。
  const detailText = rawDetail.trim()
  const detailKey = detailText.toLocaleLowerCase('zh-CN')
  const detailAlreadyShown = !detailText
    || [label, title].some(value => (value || '').trim().toLocaleLowerCase('zh-CN') === detailKey)
  const detail = detailAlreadyShown ? null : detailText
  // 简介：与标题、副标题、说明行同文时丢弃（官网不重复显示同一句）
  const description = take(item.description)

  return {
    label,
    title,
    subtitle,
    description,
    detail,
    explicit: /^explicit$/i.test(String(item.contentRating || '')),
  }
}
