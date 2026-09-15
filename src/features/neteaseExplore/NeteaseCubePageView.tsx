import { useEffect, useState } from 'react'
import { ArrowLeft, Loader2 } from 'lucide-react'
import type { NeteaseNativeBlock } from './model'
import { NeteaseNativeBlockView, type ResourceCallbacks } from './NeteaseResourceView'
import { fetchNeteaseCubePage, fillNeteaseCubeCovers, normalizeNeteaseCubePage, type NeteaseCubeTab } from './discover'

// src/features/neteaseExplore/NeteaseCubePageView.tsx
// 站内渲染单个 cube 页（如「宝藏音乐人」这类 rnpage?component=cube-renderer-rn&page=xxx 入口），
// 复用曲风频道的 cube 渲染与封面回填逻辑。

interface NeteaseCubePageViewProps {
  pageId: string
  title: string
  callbacks: ResourceCallbacks
  onBack: () => void
}

export default function NeteaseCubePageView({ pageId, title, callbacks, onBack }: NeteaseCubePageViewProps) {
  const [tabs, setTabs] = useState<NeteaseCubeTab[]>([])
  const [blocks, setBlocks] = useState<NeteaseNativeBlock[]>([])
  const [activeTab, setActiveTab] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    void (async () => {
      try {
        const page = await fillNeteaseCubeCovers(normalizeNeteaseCubePage(await fetchNeteaseCubePage(pageId, controller.signal)), controller.signal)
        if (controller.signal.aborted) return
        setTabs(page.tabs)
        setBlocks(page.blocks)
        setActiveTab(0)
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '页面加载失败')
      } finally {
        if (!controller.signal.aborted) setLoading(false)
      }
    })()
    return () => controller.abort()
  }, [pageId])

  const visibleBlocks = tabs.length > 0 ? (tabs[activeTab]?.blocks || []) : blocks

  return (
    <div className="space-y-6 pb-40">
      <div className="flex items-center gap-3">
        <button type="button" onClick={onBack} aria-label="返回" className="flex h-9 w-9 items-center justify-center rounded-full border border-white/[0.1] text-white/60 transition hover:bg-white/[0.08] hover:text-white/90">
          <ArrowLeft className="h-4 w-4" />
        </button>
        <span className="text-sm font-medium text-white/80">{title}</span>
      </div>

      {tabs.length > 1 && (
        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="页面分区">
          {tabs.map((tab, index) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(index)}
              aria-pressed={activeTab === index}
              className={`h-8 shrink-0 rounded-full px-4 text-sm transition ${activeTab === index ? 'bg-white text-black' : 'bg-white/[0.06] text-white/60 hover:bg-white/[0.12] hover:text-white/90'}`}
            >
              {tab.title}
            </button>
          ))}
        </div>
      )}

      {error && <div role="alert" className="rounded-md border border-rose-500/25 bg-rose-500/[0.08] px-4 py-3 text-sm text-rose-100/80">{error}</div>}

      {loading
        ? <div className="flex min-h-40 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-white/45" /></div>
        : visibleBlocks.length > 0
          ? <div className="space-y-12">{visibleBlocks.map((block, index) => <NeteaseNativeBlockView key={`${block.blockCode}-${index}`} block={block} callbacks={callbacks} />)}</div>
          : <p className="py-10 text-center text-sm text-white/38">该页面暂无内容</p>}
    </div>
  )
}
