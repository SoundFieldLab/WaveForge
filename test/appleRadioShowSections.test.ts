import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 广播页「艺人主持节目 / Apple Music 电台主持人」分区回归。
 *
 * 实测：这两个分区在 groupings 响应里是 editorialElementKind=385 容器，
 * 其 children 是**未展开引用**（只有 {id, type}），完整属性在
 * resources['editorial-elements'] 里。解析器必须对每个 child 调 resolveResource 展开。
 *
 * 旧实现直接读 child.attributes（恒为空）→ name 取不到 → 整个分区被静默丢弃。
 * 表现为：官网上明明有「艺人主持节目」「Apple Music 电台主持人」两行，我们的广播页却一个都没有。
 */

const mocks = vi.hoisted(() => ({ api: vi.fn() }))

vi.mock('../src/services/appleApiBridge', () => ({ appleApiRequest: mocks.api }))
vi.mock('../src/services/appleAuth', () => ({
  getAppleCredentials: () => ({ developerToken: 'dev', mediaUserToken: 'user', storefront: 'cn' }),
}))
vi.mock('../src/services/appleMusic', () => ({ toHighResArtwork: (value: string) => value }))
vi.mock('../src/services/appleCatalog', async importOriginal => {
  const original = await importOriginal<typeof import('../src/services/appleCatalog')>()
  return {
    ...original,
    getAppleRecentPlayed: vi.fn(async () => []),
    getAppleLibraryPlaylists: vi.fn(async () => []),
    getAppleFavoriteSongIds: vi.fn(async () => null),
  }
})

const web = await import('../src/services/appleWebService')

/** 构造 groupings 响应：382 根 → 316 容器 → 385 节目区（children 为未展开引用） */
function radioPayload() {
  const showEl = (id: string, designTag: string) => ({
    id,
    type: 'editorial-elements',
    attributes: { editorialElementKind: '394', designTag, artwork: { url: 'https://art/' + id + '/{w}x{h}.jpg' } },
  })
  const resources: Record<string, any> = {
    'editorial-elements': {
      root: { id: 'root', type: 'editorial-elements', attributes: { editorialElementKind: '382' }, relationships: { children: { data: [{ id: 'c1', type: 'editorial-elements' }] } } },
      c1: { id: 'c1', type: 'editorial-elements', attributes: { editorialElementKind: '316' }, relationships: { children: { data: [{ id: 'shows1', type: 'editorial-elements' }] } } },
      // 385：children 只有 {id,type}，属性在下面的 394 里
      shows1: {
        id: 'shows1',
        type: 'editorial-elements',
        attributes: { editorialElementKind: '385', name: '艺人主持节目' },
        relationships: { children: { data: [{ id: 's1', type: 'editorial-elements' }, { id: 's2', type: 'editorial-elements' }] } },
      },
      s1: showEl('s1', 'Beats in Space'),
      s2: showEl('s2', 'Rocket Hour'),
    },
  }
  return {
    ok: true,
    status: 200,
    data: {
      data: [{ id: 'grp', type: 'groupings', attributes: { name: 'radio' }, relationships: { tabs: { data: [{ id: 'sub', type: 'groupings', attributes: { name: 'Subscriber' }, relationships: { children: { data: [{ id: 'root', type: 'editorial-elements' }] } } }] } } }],
      resources,
    },
  }
}

describe('Apple 广播页节目分区（385 未展开引用）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.api.mockResolvedValue(radioPayload())
  })

  it('resolves 385 children and keeps the 艺人主持节目 section', async () => {
    const page = await web.fetchAppleRadioPage('cn')
    const showSection = page.sections.find(section => section.title === '艺人主持节目')

    expect(showSection, '「艺人主持节目」分区不应被丢弃').toBeTruthy()
    // children 的 designTag 必须被展开读出（此前恒为空 → 分区消失）
    expect(showSection!.items.length).toBe(2)
    expect(showSection!.items.map(item => item.name)).toEqual(['Beats in Space', 'Rocket Hour'])
    expect(showSection!.items[0].bannerUrl).toBeTruthy()
  })
})
