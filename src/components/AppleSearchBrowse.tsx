/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
/**
 * Apple Music 搜索落地页（1:1 复刻 music.apple.com/cn/search 无关键词视图）
 *
 * - 默认视图：「类别浏览」= apple-curators 网格（舞曲 / 国语流行 / K-Pop / 空间音频…）
 * - 点击分类：进入 curator 详情页（头部 + 歌单分区 + 歌曲/电台分区），如同进入一个新类别
 * - 歌单点击：复用全局歌单详情面板（onOpenPlaylist）
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { ArrowLeft, ListMusic, Loader2, Music, Play, Radio } from 'lucide-react'
import {
  fetchAppleCuratorPage,
  fetchAppleSearchLanding,
  appleWebItemToSong,
  type AppleCuratorPage,
  type AppleWebItem,
  type AppleWebSection,
} from '../services/appleWebService'
import type { SongSelectHandler } from '../types/playbackNavigation'
import type { Song } from '../services/musicApi'
import { useTvBack } from '../tv/tvCore'

interface AppleSearchBrowseProps {
  playerTheme?: 'light' | 'dark'
  onSongSelect: SongSelectHandler
  playbackOrigin?: import('../types/playbackNavigation').PlaybackOrigin
  /** 按资源真实类型交给探索页统一分派。 */
  onOpenItem?: (item: AppleWebItem, items: AppleWebItem[]) => void
  /** 打开歌单详情（全局面板） */
  onOpenPlaylist?: (playlist: { id: string; name: string; coverImgUrl: string; trackCount: number; creator: string; platform: 'apple' }) => void
}

export default function AppleSearchBrowse({ playerTheme = 'dark', onSongSelect, playbackOrigin, onOpenItem, onOpenPlaylist }: AppleSearchBrowseProps) {
  const [curators, setCurators] = useState<AppleWebItem[]>([])
  const [loading, setLoading] = useState(true)
  const [curatorPage, setCuratorPage] = useState<AppleCuratorPage | null>(null)
  const [curatorLoading, setCuratorLoading] = useState(false)
  const [curatorError, setCuratorError] = useState('')
  const landingRequestRef = useRef(0)
  const curatorRequestRef = useRef(0)
  const lastCuratorRef = useRef<AppleWebItem | null>(null)

  const loadLanding = useCallback(() => {
    const requestId = ++landingRequestRef.current
    setLoading(true)
    void fetchAppleSearchLanding().then(page => {
      if (requestId !== landingRequestRef.current) return
      const items = page.sections.find(section => section.kind === 'curators')?.items || []
      setCurators(items)
      setLoading(false)
    }).catch(() => {
      if (requestId === landingRequestRef.current) setLoading(false)
    })
  }, [])

  useEffect(() => {
    loadLanding()
    return () => {
      landingRequestRef.current += 1
      curatorRequestRef.current += 1
    }
  }, [loadLanding])

  const openCurator = useCallback((curator: AppleWebItem) => {
    lastCuratorRef.current = curator
    const requestId = ++curatorRequestRef.current
    setCuratorLoading(true)
    setCuratorError('')
    setCuratorPage(null)
    void fetchAppleCuratorPage(curator.playId || curator.id).then(page => {
      if (requestId !== curatorRequestRef.current) return
      setCuratorPage(page)
      if (!page) setCuratorError('分类内容加载失败，请稍后重试')
      setCuratorLoading(false)
    }).catch(error => {
      if (requestId !== curatorRequestRef.current) return
      setCuratorError(error instanceof Error ? error.message : '分类内容加载失败，请稍后重试')
      setCuratorLoading(false)
    })
  }, [])

  const closeCurator = useCallback(() => {
    curatorRequestRef.current += 1
    setCuratorLoading(false)
    setCuratorError('')
    setCuratorPage(null)
  }, [])

  useTvBack(() => {
    if (!curatorPage && !curatorLoading && !curatorError) return false
    closeCurator()
    return true
  }, [closeCurator, curatorError, curatorLoading, curatorPage])

  const playSectionSongs = (section: AppleWebSection) => {
    const songs = section.items
      .filter(item => item.type === 'songs' && item.playId)
      .map(item => appleWebItemToSong(item))
    if (songs.length > 0) onSongSelect(songs[0], songs, playbackOrigin)
  }

  const openPlaylist = (item: AppleWebItem) => {
    if (onOpenPlaylist) {
      onOpenPlaylist({
        id: item.playId || item.id,
        name: item.name,
        coverImgUrl: item.artworkUrl || '',
        trackCount: item.trackCount || 0,
        creator: item.curatorName || 'Apple Music',
        platform: 'apple',
      })
    }
  }

  const isDark = playerTheme === 'dark'
  const textPrimary = isDark ? 'text-white' : 'text-black'
  const textSecondary = isDark ? 'text-white/55' : 'text-black/55'
  const textTertiary = isDark ? 'text-white/35' : 'text-black/35'
  const cardBg = isDark ? 'bg-white/[0.05]' : 'bg-black/[0.04]'
  const cardBorder = isDark ? 'border-white/[0.09]' : 'border-black/[0.08]'

  // ── curator 详情页 ──
  if (curatorLoading) {
    return <div className={`flex items-center justify-center gap-2 py-20 text-sm ${textSecondary}`}><Loader2 className="h-4 w-4 animate-spin" />正在加载分类内容…</div>
  }
  if (curatorError) {
    return <div className={`${textPrimary}`}><button type="button" onClick={closeCurator} className={`mb-5 flex items-center gap-1.5 rounded-full border ${cardBorder} ${cardBg} px-4 py-2 text-sm`}><ArrowLeft className="h-4 w-4" />返回类别浏览</button><div className={`flex flex-col items-center gap-4 py-16 text-center text-sm ${textSecondary}`}><span>{curatorError}</span><button type="button" onClick={() => { if (lastCuratorRef.current) openCurator(lastCuratorRef.current) }} className={`rounded-full border ${cardBorder} ${cardBg} px-4 py-2`}>重试</button></div></div>
  }
  if (curatorPage) {
    const { curator, sections, playlists, playlistCount } = curatorPage
    return (
      <div className={`${textPrimary}`}>
        <button
          type="button"
          onClick={closeCurator}
          className={`mb-5 flex items-center gap-1.5 rounded-full border ${cardBorder} ${cardBg} px-4 py-2 text-sm transition hover:bg-white/10`}
        >
          <ArrowLeft className="h-4 w-4" /> 返回类别浏览
        </button>
        {/* 头部 */}
        <div className="mb-6 flex items-center gap-5">
          {curator.heroArtworkUrl ? (
            <img src={curator.heroArtworkUrl} alt={curator.name} className="h-24 w-44 shrink-0 rounded-2xl object-cover shadow-xl md:h-28 md:w-52" />
          ) : curator.artworkUrl ? (
            <img src={curator.artworkUrl} alt={curator.name} className="h-24 w-24 shrink-0 rounded-2xl object-cover shadow-xl" />
          ) : null}
          <div className="min-w-0">
            <h2 className="truncate text-2xl font-bold md:text-3xl">{curator.name}</h2>
            {curator.description && <p className={`${textSecondary} mt-1.5 line-clamp-2 max-w-xl text-sm`}>{curator.description}</p>}
            {typeof playlistCount === 'number' && (
              <p className={`${textTertiary} mt-1 text-xs`}>{playlistCount} 个歌单</p>
            )}
          </div>
        </div>
        {/* 歌单分区（grouping 树解析） */}
        {sections.map(section => (
          <section key={section.id} className="mb-7">
            <h3 className="mb-3 text-lg font-semibold">{section.title}</h3>
            {section.items.length > 0 && section.items.every(item => item.type === 'songs') ? (
              <div className="grid gap-x-6 md:grid-cols-2 xl:grid-cols-3">
                {section.items.slice(0, 30).map((item, index) => (
                  <div
                    key={`${section.id}-${item.id}`}
                    tabIndex={0}
                    data-tv-focus
                    className="group flex cursor-pointer items-center gap-3 rounded-xl px-2 py-2 outline-none transition hover:bg-white/[0.05] focus-visible:ring-2 focus-visible:ring-[#fa2d48]"
                    onClick={() => {
                      const song = appleWebItemToSong(item)
                      onSongSelect(song, section.items.filter(entry => entry.type === 'songs' && entry.playId).map(entry => appleWebItemToSong(entry)), playbackOrigin)
                    }}
                  >
                    <span className={`w-6 shrink-0 text-center text-sm tabular-nums ${index < 3 ? 'font-semibold' : textTertiary}`}>{index + 1}</span>
                    {item.artworkUrl ? (
                      <img src={item.artworkUrl} alt={item.name} loading="lazy" className="h-11 w-11 shrink-0 rounded-lg object-cover" />
                    ) : (
                      <div className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-lg ${isDark ? 'bg-white/[0.06]' : 'bg-black/[0.06]'}`}>
                        <Music className="h-5 w-5 opacity-40" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium">{item.name}</p>
                      <p className={`mt-0.5 truncate text-xs ${textTertiary}`}>{item.artistName || item.subtitle}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {section.items.map(item => (
                  <div key={`${section.id}-${item.id}`} className="group min-w-0 cursor-pointer" onClick={() => onOpenItem?.(item, section.items)}>
                    <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
                      {item.artworkUrl ? (
                        <img src={item.artworkUrl} alt={item.name} loading="lazy" className="aspect-square w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
                      ) : (
                        <div className="flex aspect-square w-full items-center justify-center bg-white/[0.06]">
                          <ListMusic className="h-7 w-7 opacity-40" />
                        </div>
                      )}
                      <span className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-white text-[#0a0f14] opacity-0 shadow-xl transition group-hover:opacity-100">
                        <Play className="h-4 w-4 fill-current" />
                      </span>
                    </div>
                    <p className="mt-2 truncate text-[13px] font-medium">{item.name}</p>
                    <p className={`mt-0.5 truncate text-[11px] ${textTertiary}`}>{item.curatorName || 'Apple Music'}</p>
                  </div>
                ))}
              </div>
            )}
          </section>
        ))}
        {/* 顶部歌单列表（include=playlists） */}
        {playlists.length > 0 && (
          <section className="mb-7">
            <h3 className="mb-3 text-lg font-semibold">歌单</h3>
            <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
              {playlists.map(item => (
                <div key={item.id} className="group min-w-0 cursor-pointer" onClick={() => openPlaylist(item)}>
                  <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
                    {item.artworkUrl ? (
                      <img src={item.artworkUrl} alt={item.name} loading="lazy" className="aspect-square w-full object-cover transition duration-500 group-hover:scale-[1.03]" />
                    ) : (
                      <div className="flex aspect-square w-full items-center justify-center bg-white/[0.06]">
                        <ListMusic className="h-7 w-7 opacity-40" />
                      </div>
                    )}
                    <span className="absolute bottom-3 right-3 flex h-10 w-10 items-center justify-center rounded-full bg-white text-[#0a0f14] opacity-0 shadow-xl transition group-hover:opacity-100">
                      <Play className="h-4 w-4 fill-current" />
                    </span>
                  </div>
                  <p className="mt-2 truncate text-[13px] font-medium">{item.name}</p>
                  <p className={`mt-0.5 truncate text-[11px] ${textTertiary}`}>{item.curatorName || 'Apple Music'}</p>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>
    )
  }

  // ── 类别浏览网格 ──
  return (
    <div className={`${textPrimary}`}>
      <h2 className="mb-4 text-xl font-bold">类别浏览</h2>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-20 text-sm text-white/45">
          <Loader2 className="h-4 w-4 animate-spin" /> 正在加载类别…
        </div>
      ) : curators.length === 0 ? (
        <div className={`flex flex-col items-center justify-center py-16 ${textTertiary}`}>
          <Radio className="mb-3 h-14 w-14 opacity-20" />
          <p>类别浏览暂无数据</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-6 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {curators.map(curator => (
            <motion.div
              key={curator.id}
              whileHover={{ y: -3 }}
              tabIndex={0}
              data-tv-focus
              className="group min-w-0 cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-[#fa2d48]"
              onClick={() => openCurator(curator)}
            >
              <div className="relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.04]">
                {curator.artworkUrl ? (
                  <img src={curator.artworkUrl} alt={curator.name} loading="lazy" className="aspect-square w-full object-cover transition duration-500 group-hover:scale-[1.04]" />
                ) : (
                  <div className="flex aspect-square w-full items-center justify-center bg-white/[0.06]">
                    <Music className="h-7 w-7 opacity-40" />
                  </div>
                )}
              </div>
              <p className="mt-2 truncate text-[13px] font-medium">{curator.name}</p>
              <p className={`mt-0.5 truncate text-[11px] ${textTertiary}`}>Apple Music 分类</p>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  )
}
