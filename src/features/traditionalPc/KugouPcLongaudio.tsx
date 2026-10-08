// 酷狗音乐 PC 客户端「听书」页（传统模式，浅色皮肤）。
//
// 布局对齐官方听书页：分类胶囊（有声小说/儿童天地/相声曲艺…）+ 每日推荐卡片墙
// （卡片带 完结 / 听书VIP / 播放量 角标）+ 加载更多。
// 播放与详情**复用** src/features/kugouLongaudio 的独立 store 与 Overlay 播放器
// （不复用歌词播放器、不接主播放队列），这里只做卡片墙与分类筛选。
import { memo, useEffect, useSyncExternalStore } from 'react'
import { BookAudio, Crown, Headphones, Library, Loader2, Play, RefreshCw } from 'lucide-react'
import type { KugouLongaudioAlbum } from '../../services/kugouService'
import { PcCover, PcEmpty } from './pcKit'
import { kugouCount, type KugouPcPageContext } from './KugouPcShared'
import { kugouLongaudioStore, selectBrowseTags, selectVisibleBrowseAlbums, type LongaudioState } from '../kugouLongaudio/store'

export interface KugouPcLongaudioProps {
  ctx: KugouPcPageContext
}

function KugouPcLongaudio({ ctx }: KugouPcLongaudioProps) {
  const theme = ctx.theme
  const accent = ctx.accent
  const state = useSyncExternalStore(kugouLongaudioStore.subscribe, kugouLongaudioStore.getState) as LongaudioState
  const { browse } = state
  const albums = selectVisibleBrowseAlbums(state)
  const tags = selectBrowseTags(state)

  useEffect(() => {
    if (!ctx.active) return
    void kugouLongaudioStore.ensureBrowseLoaded()
  }, [ctx.active])

  const openAlbum = (album: KugouLongaudioAlbum) => {
    void kugouLongaudioStore.openAlbum(album.albumId, { summary: album })
  }

  return (
    <div className="pb-8" data-kugou-pc-page="longaudio">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className={`text-[26px] font-semibold leading-tight ${theme.text}`}>听书</h1>
          <p className={`mt-1 text-[12px] ${theme.subtle}`}>有声小说 / 相声评书 / 助眠解压 · 独立播放通道，不影响主播放队列</p>
        </div>
        <button
          type="button"
          onClick={() => kugouLongaudioStore.openLibrary()}
          className={`inline-flex h-8 items-center gap-1.5 rounded-full px-4 text-[13px] ${theme.solidBtn}`}
        >
          <Library className="h-3.5 w-3.5" /> 我的听书
        </button>
      </div>

      {tags.length > 0 && (
        // 官方听书页的分类胶囊是浅底矩形宽块（两行 5 列），不是小圆胶囊
        <div className="mb-5 grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-5">
          <button
            type="button"
            onClick={() => kugouLongaudioStore.setBrowseTag(null)}
            className={`rounded-[4px] px-3 py-2 text-[13px] transition ${browse.tag === null ? 'font-medium text-white' : theme.chipIdle}`}
            style={browse.tag === null ? { background: accent } : undefined}
          >
            全部
          </button>
          {tags.map(tag => (
            <button
              key={tag.name}
              type="button"
              onClick={() => kugouLongaudioStore.setBrowseTag(tag.name)}
              className={`truncate rounded-[4px] px-3 py-2 text-center text-[13px] transition ${browse.tag === tag.name ? 'font-medium text-white' : theme.chipIdle}`}
              style={browse.tag === tag.name ? { background: accent } : undefined}
              title={tag.name}
            >
              {tag.name}
            </button>
          ))}
        </div>
      )}

      {/* 官方区块标题「每日推荐」（右端刷新） */}
      <div className="mb-3 flex items-center justify-between">
        <h2 className={`text-[17px] font-semibold ${theme.text}`}>每日推荐</h2>
        <button
          type="button"
          onClick={() => void kugouLongaudioStore.ensureBrowseLoaded({ force: true })}
          disabled={browse.loading}
          className={`flex h-7 w-7 items-center justify-center rounded-full transition hover:bg-white/5 disabled:opacity-40 ${theme.subtle}`}
          aria-label="换一批"
          title="换一批"
        >
          <RefreshCw className={`h-4 w-4 ${browse.loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {browse.loading && browse.albums.length === 0 ? (
        <div className={`flex items-center justify-center gap-2 rounded-xl py-16 text-[13px] ${theme.faint} ${theme.surface}`}>
          <Loader2 className="h-4 w-4 animate-spin" /> 正在加载听书推荐…
        </div>
      ) : albums.length === 0 ? (
        <PcEmpty
          theme={theme}
          title={browse.tag ? `「${browse.tag}」下暂时没有听书` : '暂时没有听书推荐'}
          description={browse.error || '上游听书推荐池为空，换个分类或稍后再试'}
          action={(
            <button
              type="button"
              onClick={() => void kugouLongaudioStore.ensureBrowseLoaded({ force: true })}
              className="rounded-full px-4 py-2 text-[12px] font-medium text-white"
              style={{ background: accent }}
            >
              重新加载
            </button>
          )}
        />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {albums.map(album => (
              <button key={album.albumId} type="button" onClick={() => openAlbum(album)} className="group min-w-0 text-left">
                <span className="relative block">
                  <PcCover src={album.coverUrl} alt={album.name} className="aspect-square w-full" rounded="rounded-[8px]" />
                  <span className="pointer-events-none absolute left-1.5 top-1.5 flex flex-col items-start gap-1">
                    {album.finished && (
                      <span className="rounded-full bg-emerald-500/85 px-1.5 py-[2px] text-[11px] leading-none text-white">完结</span>
                    )}
                    {album.isPaid && (
                      <span className="flex items-center gap-0.5 rounded-full bg-[linear-gradient(135deg,#f7c948,#e8960c)] px-1.5 py-[2px] text-[11px] leading-none font-semibold text-[#3a2600]">
                        <Crown className="h-2.5 w-2.5" /> 听书VIP
                      </span>
                    )}
                  </span>
                  {kugouCount(album.playCount) ? (
                    <span className="pointer-events-none absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded-full bg-black/45 px-1.5 py-[2px] text-[11px] leading-none text-white backdrop-blur-sm">
                      <Headphones className="h-3 w-3" /> {kugouCount(album.playCount)}
                    </span>
                  ) : null}
                  <span className="absolute bottom-1.5 right-1.5 flex h-8 w-8 translate-y-1 items-center justify-center rounded-full text-white opacity-0 shadow-lg transition group-hover:translate-y-0 group-hover:opacity-100" style={{ background: accent }}>
                    <Play className="h-3.5 w-3.5 fill-current" />
                  </span>
                </span>
                <span className={`mt-2 line-clamp-2 text-[13px] font-medium leading-snug ${theme.text}`}>{album.name}</span>
                {/* 官方卡片只有标题一行：主播未知时整行不显示（不摆「未知主播 / N 章」占位） */}
                {album.author ? (
                  <span className={`mt-0.5 line-clamp-1 block text-[11px] ${theme.faint}`}>{album.author}</span>
                ) : null}
              </button>
            ))}
          </div>

          <div className="mt-6 flex justify-center">
            {browse.hasMore ? (
              <button
                type="button"
                disabled={browse.loading}
                onClick={() => void kugouLongaudioStore.loadMoreBrowse()}
                className={`inline-flex items-center gap-2 rounded-full px-5 py-2 text-[13px] transition disabled:opacity-50 ${theme.solidBtn}`}
              >
                {browse.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BookAudio className="h-3.5 w-3.5" />}
                加载更多
              </button>
            ) : (
              <p className={`text-[12px] ${theme.faint}`}>已加载全部听书推荐</p>
            )}
          </div>
          <p className={`mt-3 text-center text-[11px] ${theme.faint}`}>分类为已加载内容的标签聚合（上游没有按分类拉取的接口）；卡片角标只在字段真实存在时出现。</p>
        </>
      )}
    </div>
  )
}

export default memo(KugouPcLongaudio)
