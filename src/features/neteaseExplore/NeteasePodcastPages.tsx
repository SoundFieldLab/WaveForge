import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Loader2, Radio } from 'lucide-react'
import type { NeteaseNativeBlock, NeteaseNativeResource } from './model'
import { NeteaseNativeBlockView, type ResourceCallbacks } from './NeteaseResourceView'
import {
  fetchNeteaseMyPodcasts,
  fetchNeteasePodcastCategories,
  fetchNeteasePodcastCategoryRadios,
  type NeteasePodcastCategory,
} from './discover'

// src/features/neteaseExplore/NeteasePodcastPages.tsx
// 播客固定入口的站内原生页面：我的播客 / 全部分类 / 分类电台。
// App 内这些是 RN 页，WaveForge 用同一批服务端接口本地渲染，避免跳系统浏览器。

export type NeteasePodcastView =
  | { kind: 'categories' }
  | { kind: 'mine' }
  | { kind: 'category'; id: string; name: string }

interface NeteasePodcastPagesProps {
  view: NeteasePodcastView
  accountUserId?: string
  callbacks: ResourceCallbacks
  onBack: () => void
  onOpenCategory: (id: string, name: string) => void
}

function radioBlock(resources: NeteaseNativeResource[], title: string): NeteaseNativeBlock {
  // grid 布局：播客/电台数量不多，直接铺开，不要挤成一排横向拖动
  return { id: `podcast-${title}`, blockCode: 'NETEASE_RADIO_GRID', showType: 'MIXED_GRID', title, subtitle: '', resources, layout: 'grid', raw: {} }
}

export default function NeteasePodcastPages({ view, accountUserId, callbacks, onBack, onOpenCategory }: NeteasePodcastPagesProps) {
  const [categories, setCategories] = useState<NeteasePodcastCategory[]>([])
  const [radios, setRadios] = useState<NeteaseNativeResource[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 同一视图已经加载过就直接复用（页面重新挂载/来回进入时不重拉）；失败时保留重试路径。
  const loadedKeyRef = useRef('')

  const load = useCallback(async (signal: AbortSignal) => {
    const key = view.kind === 'category' ? `category:${view.id}` : view.kind === 'mine' ? `mine:${accountUserId || ''}` : 'categories'
    if (loadedKeyRef.current === key) { setLoading(false); setError(''); return }
    setLoading(true)
    setError('')
    try {
      if (view.kind === 'categories') {
        const list = await fetchNeteasePodcastCategories(signal)
        if (!signal.aborted) { setCategories(list); if (list.length > 0) loadedKeyRef.current = key }
      } else if (view.kind === 'category') {
        const list = await fetchNeteasePodcastCategoryRadios(view.id, 0, 18, signal)
        if (!signal.aborted) { setRadios(list); if (list.length > 0) loadedKeyRef.current = key }
      } else {
        if (!accountUserId) { setError('登录后可查看我的播客'); setRadios([]); }
        else {
          const list = await fetchNeteaseMyPodcasts(accountUserId, 0, 30, signal)
          if (!signal.aborted) { setRadios(list); if (list.length > 0) loadedKeyRef.current = key }
        }
      }
    } catch (err) {
      if (!signal.aborted) setError(err instanceof Error ? err.message : '加载失败')
    } finally {
      if (!signal.aborted) setLoading(false)
    }
  }, [accountUserId, view])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const categoryName = view.kind === 'category' ? view.name : ''
  const title = view.kind === 'categories' ? '全部分类' : view.kind === 'mine' ? '我的播客' : categoryName
  const block = useMemo(() => (radios.length ? radioBlock(radios, view.kind === 'mine' ? '我订阅的播客' : `「${categoryName}」热门播客`) : null), [categoryName, radios, view.kind])

  return (
    <div className="space-y-6 pb-40">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} aria-label="返回播客首页" className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.1] text-white/60 transition hover:bg-white/[0.08] hover:text-white/90">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="flex items-center gap-2 text-sm font-medium text-white/80"><Radio className="h-4 w-4" />{title}</div>
      </div>

      {error && <div role="alert" className="rounded-md border border-rose-500/25 bg-rose-500/[0.08] px-4 py-3 text-sm text-rose-100/80">{error}</div>}

      {loading ? (
        <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-white/45" /></div>
      ) : view.kind === 'categories' ? (
        <div className="space-y-8">
          {categories.map(category => (
            <section key={category.id}>
              <h3 className="mb-3 text-lg font-semibold text-white/85">{category.name}</h3>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => onOpenCategory(category.id, category.name)}
                  className="h-8 rounded-full bg-white/[0.12] px-4 text-sm text-white/85 transition hover:bg-white/[0.2]"
                >
                  全部{category.name}
                </button>
                {category.children.map(child => (
                  <button
                    key={child.id}
                    type="button"
                    title={child.description}
                    onClick={() => onOpenCategory(category.id, child.name)}
                    className="h-8 rounded-full bg-white/[0.06] px-4 text-sm text-white/60 transition hover:bg-white/[0.14] hover:text-white/90"
                  >
                    {child.name}
                  </button>
                ))}
              </div>
            </section>
          ))}
          {categories.length === 0 && <p className="py-10 text-center text-sm text-white/38">暂无分类</p>}
        </div>
      ) : (
        <>
          {block
            ? <NeteaseNativeBlockView block={block} callbacks={callbacks} />
            : <p className="py-10 text-center text-sm text-white/38">{view.kind === 'mine' ? '还没有订阅任何播客' : '该分类暂无播客'}</p>}
        </>
      )}
    </div>
  )
}
