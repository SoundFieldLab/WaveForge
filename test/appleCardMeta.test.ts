import { describe, expect, it } from 'vitest'
import { resolveAppleCardMeta } from '../src/components/apple-explore/cardMeta'
import type { AppleWebItem } from '../src/services/appleWebService'

const item = (over: Partial<AppleWebItem>): AppleWebItem => ({
  id: 'x',
  type: 'playlists',
  name: 'Title',
  ...over,
} as AppleWebItem)

/**
 * 这组断言对应「Apple 探索页卡片与官网不一致」的四个实测问题：
 *  ① 卡内小标签（官网「下一首」）此前被服务层解析却从未渲染；
 *  ② E 标（contentRating=explicit）同样一直取到却从未渲染；
 *  ③ 聚合卡（如「…与类似艺人」）的 name/subtitle/description 是同一串文本，
 *     逐行无条件渲染会把同一句话显示三遍（官网只显示两行不同内容）；
 *  ④ 卡片比例（在 UI 层断言，见 exploreAppleCategories）。
 */
describe('Apple 卡片文案归一', () => {
  it('把 editorialLabel 作为卡内小标签输出（官网「下一首」）', () => {
    const meta = resolveAppleCardMeta(item({ name: 'Rapsody', editorialLabel: '下一首', artistName: 'Apple Music' }))
    expect(meta.label).toBe('下一首')
    expect(meta.title).toBe('Rapsody')
  })

  it('contentRating=explicit 时标记 explicit（渲染 E 标），其余情况为 false', () => {
    expect(resolveAppleCardMeta(item({ contentRating: 'explicit' })).explicit).toBe(true)
    expect(resolveAppleCardMeta(item({ contentRating: 'Explicit' })).explicit).toBe(true)
    expect(resolveAppleCardMeta(item({ contentRating: 'clean' })).explicit).toBe(false)
    expect(resolveAppleCardMeta(item({})).explicit).toBe(false)
  })

  it('同一串文本重复出现在 name/subtitle/description 时只保留一次（实测「…与类似艺人」卡）', () => {
    const same = 'АДЛИН与类似艺人'
    const meta = resolveAppleCardMeta(item({ name: same, subtitle: same, description: same, artistName: same }))
    expect(meta.title).toBe(same)
    // 副标题与简介都被去重掉，不能重复出现
    expect(meta.subtitle).toBeNull()
    expect(meta.description).toBeNull()
  })

  it('标题与副标题同文时丢弃副标题，且不凭空补 Apple Music', () => {
    const meta = resolveAppleCardMeta(item({ name: '同名', subtitle: '同名' }))
    expect(meta.title).toBe('同名')
    // 关键：副标题因重复被丢弃 ≠ 没有副标题字段，不应回落到 'Apple Music'
    expect(meta.subtitle).toBeNull()
  })

  it('本就没有副标题字段时才回落到 Apple Music', () => {
    const meta = resolveAppleCardMeta(item({ name: '只有标题' }))
    expect(meta.subtitle).toBe('Apple Music')
  })

  it('小标签与标题同文时保留标题、丢弃标签', () => {
    const meta = resolveAppleCardMeta(item({ name: '专属推荐', editorialLabel: '专属推荐' }))
    expect(meta.title).toBe('专属推荐')
    expect(meta.label).toBeNull()
  })

  it('去重忽略大小写与首尾空白', () => {
    const meta = resolveAppleCardMeta(item({ name: 'Rapsody', subtitle: '  rapsody  ' }))
    expect(meta.subtitle).toBeNull()
  })

  it('正常卡片保留全部三行（不误伤）', () => {
    const meta = resolveAppleCardMeta(item({
      name: '能量充电',
      artistName: 'Apple Music',
      description: '工作日清晨或是周六夜晚，这份个性化活力歌单随时为你打气。',
    }))
    expect(meta.title).toBe('能量充电')
    expect(meta.subtitle).toBe('Apple Music')
    expect(meta.description).toContain('工作日清晨')
    expect(meta.label).toBeNull()
  })

  /**
   * 官网卡片第三行随类型取值（逐卡比对 music.apple.com/cn/home 的结果）：
   * 歌单印曲目艺人串、专辑印艺人名、电台印编辑简介。
   */
  describe('第三行（detail）按类型取值', () => {
    it('歌单用 artistNames（曲目艺人串），优先于编辑简介', () => {
      const meta = resolveAppleCardMeta(item({
        type: 'playlists',
        name: '能量充电',
        curatorName: 'Apple Music',
        artistNames: 'kessoku band、羽沢珈琲店にようこそ♪、一家Dumb Rock!',
        description: '工作日清晨或是周六夜晚，这份个性化活力歌单随时为你打气。',
      }))
      // 官网此处印的是艺人串，而不是那句简介
      expect(meta.detail).toBe('kessoku band、羽沢珈琲店にようこそ♪、一家Dumb Rock!')
    })

    it('专辑用艺人名（如「夜鷹 - Yodaka - Single」下面是「米津玄师」）', () => {
      const meta = resolveAppleCardMeta(item({
        type: 'albums',
        name: '夜鷹 - Yodaka - Single',
        artistName: '米津玄师',
      }))
      // 副标题与第三行同为艺人名；hero 覆盖层只渲染 detail，故第三行必须留住它
      expect(meta.subtitle).toBe('米津玄师')
      expect(meta.detail).toBe('米津玄师')
    })

    it('电台用编辑简介（如「精力充沛」下面是「高能节拍不停歇…」）', () => {
      const meta = resolveAppleCardMeta(item({
        type: 'stations',
        name: '精力充沛',
        description: '高能节拍不停歇，全力输出不设限。',
      }))
      expect(meta.detail).toBe('高能节拍不停歇，全力输出不设限。')
    })

    it('第三行与标签同文时丢弃（不重复显示同一句）', () => {
      const meta = resolveAppleCardMeta(item({
        type: 'stations',
        name: '某电台',
        editorialLabel: '专属推荐',
        description: '专属推荐',
      }))
      expect(meta.label).toBe('专属推荐')
      expect(meta.detail).toBeNull()
    })
  })

  /**
   * 歌单编辑图（superHeroTall.imageTraits 含 hasTitle）已把歌名烤进画面，
   * 官网此时不再重复渲染标题，否则同一名字会在卡片上出现两遍。
   */
  it('artworkHasTitle 的歌单不重复渲染标题', () => {
    const meta = resolveAppleCardMeta(item({
      type: 'playlists',
      name: '能量充电',
      artworkHasTitle: true,
      editorialLabel: '专属推荐',
    }))
    expect(meta.title).toBeNull()
    expect(meta.label).toBe('专属推荐')
  })

  it('未带 artworkHasTitle 时标题照常渲染（不误伤非 hero 卡）', () => {
    const meta = resolveAppleCardMeta(item({ type: 'playlists', name: '能量充电' }))
    expect(meta.title).toBe('能量充电')
  })
})
