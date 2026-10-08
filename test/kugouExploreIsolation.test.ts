/**
 * 酷狗探索页一级分区（音乐 / 听书 / 刷歌）的平台隔离守卫：
 * 1) 新增的区块 id 只出现在 kugou 能力表里，其它平台区块列表保持一字不变；
 * 2) ExploreView 里酷狗分区外壳只在 platform === 'kugou' 下渲染，
 *    通用「为你发现 / 推荐歌单 / 排行榜 / 最新音乐 / 新碟 / 声音与播客」区块对酷狗让位
 *    （酷狗版收纳在 KugouExplorePage 的音乐分区里，避免同一板块渲染两遍）；
 * 3) 分区外壳自身只引用酷狗专属板块组件，分区 id 与品牌色按验收要求落地。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { getPlatformCapabilities } from '../src/services/platforms'

const component = (name: string) => readFileSync(new URL(`../src/components/${name}`, import.meta.url), 'utf8')
const feature = (path: string) => readFileSync(new URL(`../src/features/${path}`, import.meta.url), 'utf8')

describe('酷狗探索页板块的平台隔离', () => {
  it('kugou 能力表只含一级分区收纳后的官方板块（音乐五板块 + 听书；刷歌已下线）', () => {
    const sections = getPlatformCapabilities('kugou').exploreSections
    expect(sections).toEqual([
      'discover',
      'kugouLibrary',
      'kugouPlaylistTags',
      'channels',
      'kugouCategories',
      'kugouLongaudio',
    ])
    expect(getPlatformCapabilities('kugou').channels).toBe(true)
    // 通用聚合板块（推荐歌单/排行榜/最新音乐/新碟）由酷狗五板块覆盖，不再出现在能力表里
    expect(sections as readonly string[]).not.toContain('playlists')
    expect(sections as readonly string[]).not.toContain('charts')
  })

  it('网易云/QQ/Apple/Spotify/汽水的区块列表与酷狗新增无关（逐字保持原值）', () => {
    expect(getPlatformCapabilities('netease').exploreSections).toEqual(
      ['discover', 'journey', 'playlists', 'charts', 'newSongs', 'albums', 'channels'],
    )
    expect(getPlatformCapabilities('qq').exploreSections).toEqual(
      ['discover', 'journey', 'playlists', 'charts', 'newSongs', 'albums', 'channels'],
    )
    expect(getPlatformCapabilities('apple').exploreSections).toEqual(
      ['discover', 'playlists', 'charts', 'newSongs', 'albums'],
    )
    expect(getPlatformCapabilities('spotify').exploreSections).toEqual(
      ['discover', 'playlists', 'charts', 'newSongs', 'albums'],
    )
    expect(getPlatformCapabilities('soda').exploreSections).toEqual(
      ['discover', 'playlists', 'charts', 'newSongs', 'albums'],
    )
    for (const platform of ['netease', 'qq', 'apple', 'spotify', 'soda'] as const) {
      const sections = getPlatformCapabilities(platform).exploreSections as readonly string[]
      expect(sections.some(section => section.startsWith('kugou'))).toBe(false)
    }
  })

  it('ExploreView 只在 kugou 分支渲染分区外壳，并让位全部通用区块', () => {
    const source = component('ExploreView.tsx').replace(/\r\n/g, '\n')
    expect(source).toContain("import KugouExplorePage from '../features/kugouExplore/KugouExplorePage'")
    expect(source).toContain("{platform === 'kugou' && (")
    expect(source).toContain('<KugouExplorePage')
    // 通用区块对酷狗让位（酷狗版本收纳在 KugouExplorePage 的音乐分区里）
    for (const section of ['discover', 'channels', 'playlists', 'charts', 'newSongs', 'albums']) {
      // 让位条件已收敛成 genericExploreSections 常量（ExploreView 侧的重构：= 非 kugou/soda），
      // 语义与原先的 platform !== 'kugou' 一致，这里跟着源码形状断言
      expect(source).toContain(`{sectionVisible('${section}') && genericExploreSections && (`)
    }
    // 酷狗频道空列表要显示板块（空态），不能因 payload.channels 为空而整块隐藏
    expect(source).toContain("return platform === 'kugou' ? Boolean(payload?.kugou) : (payload?.channels.length || 0) > 0")
    // 分区外壳内不再直接挂通用区块组件（避免两套板块并存）
    expect(source).not.toContain('<KugouDiscoverBoard')
  })

  it('KugouExplorePage 是音乐/听书两区外壳（刷歌已下线），且只引用酷狗专属板块', () => {
    const page = feature('kugouExplore/KugouExplorePage.tsx').replace(/\r\n/g, '\n')
    expect(page).toContain("export type KugouExploreZoneId = 'music' | 'longaudio'")
    for (const label of ["label: '音乐'", "label: '听书'"]) {
      expect(page).toContain(label)
    }
    // 三区内容分别由酷狗专属板块提供
    expect(page).toContain('<KugouDiscoverBoard')
    expect(page).toContain('<KugouExploreSections')
    expect(page).toContain('<KugouLongaudioBoard')
    // 独立听书播放器挂在外壳下；刷歌 Overlay 已随下线移除
    expect(page).toContain('<KugouLongaudioOverlay />')
    expect(page).not.toContain('<KugouYouthFeedOverlay')
    // 分区页签用酷狗品牌色（#FF7A00 系 accent 由宿主传入，激活项品牌色胶囊）
    expect(page).toContain('role="tablist"')
    expect(page).toContain("aria-label=\"酷狗探索分区\"")
    expect(page).toContain('data-kugou-zone=')
  })
})
