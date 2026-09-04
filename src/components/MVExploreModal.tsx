import { useEffect, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { X, Film, Play, Search, XCircle, ChevronRight } from 'lucide-react'
import {
  getAllMVs,
  getMVCategories,
  getMVListByCategory,
  getProxiedImageUrl,
  searchMVs
} from '../services/musicApi'
import VideoPlayer from './VideoPlayer'
import { useTvBack } from '../tv/tvCore'

interface MVItem {
  id: string | number
  name: string
  cover: string
  artistName: string
  playCount: number
  platform: 'netease' | 'qq'
}

interface MVExploreModalProps {
  initialPlatform?: 'netease' | 'qq'
  onClose: () => void
  playerTheme?: 'dark' | 'light'
}

const formatCount = (value?: number) => {
  const count = Number(value || 0)
  if (count >= 100000000) return `${(count / 100000000).toFixed(1)}亿`
  if (count >= 10000) return `${(count / 10000).toFixed(1)}万`
  return count ? String(count) : ''
}

// 网易云 mv_all 的地区/类型筛选项（与网易云接口的字符串参数一致）
const NETESE_AREAS = ['全部', '内地', '港台', '欧美', '日本', '韩国', '其他']
const NETEASE_TYPES = ['全部', '官方版', '原声', '现场版', '网易出品']

export default function MVExploreModal({ initialPlatform = 'netease', onClose, playerTheme = 'dark' }: MVExploreModalProps) {
  // TV 遥控器 BACK：关闭 MV 浏览弹窗
  useTvBack(() => {
    onClose()
    return true
  }, [onClose])
  const dark = playerTheme === 'dark'
  const textPrimary = dark ? 'text-white' : 'text-black'
  const textSecondary = dark ? 'text-white/60' : 'text-black/60'
  const [platform, setPlatform] = useState<'netease' | 'qq'>(initialPlatform)

  // 通用列表状态
  const [mvs, setMvs] = useState<MVItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState('')
  const [hasMore, setHasMore] = useState(true)
  const requestSeqRef = useRef(0)

  // 网易云筛选/分页
  const [neteaseArea, setNeteaseArea] = useState('全部')
  const [neteaseType, setNeteaseType] = useState('全部')
  const [neteaseOffset, setNeteaseOffset] = useState(0)

  // QQ 分类/分页
  const [qqCategories, setQqCategories] = useState<{ area: { id: number; name: string }[]; version: { id: number; name: string }[] }>({ area: [], version: [] })
  const [qqArea, setQqArea] = useState(15) // 全部
  const [qqVersion, setQqVersion] = useState(7) // 全部
  const [qqPage, setQqPage] = useState(1)

  // 正在播放的 MV
  const [playingMV, setPlayingMV] = useState<MVItem | null>(null)
  const [isVideoOpen, setIsVideoOpen] = useState(false)

  // 搜索状态
  const [searchKeyword, setSearchKeyword] = useState('')
  const [isSearchMode, setIsSearchMode] = useState(false)
  const [searchLoading, setSearchLoading] = useState(false)
  // 上次 effect 生效时的搜索词——用于区分「输入框打字」与「提交搜索」，
  // 避免浏览模式下每次击键都触发列表重载（重新请求 + 列表闪空白）
  const prevSearchKeywordRef = useRef(searchKeyword)

  // QQ 分类加载
  useEffect(() => {
    if (platform !== 'qq') return
    let cancelled = false
    getMVCategories().then((data) => {
      if (cancelled || !data?.data) return
      const d = data.data
      setQqCategories({
        area: Array.isArray(d.area) ? d.area : [],
        version: Array.isArray(d.version) ? d.version : []
      })
    })
    return () => { cancelled = true }
  }, [platform])

  // 平台切换/筛选变化时加载列表（搜索模式下按关键词搜索）
  useEffect(() => {
    // 未进入搜索模式时，仅搜索词变化（输入框打字、未提交）不重载列表
    const kwChanged = prevSearchKeywordRef.current !== searchKeyword
    prevSearchKeywordRef.current = searchKeyword
    if (!isSearchMode && kwChanged && searchKeyword !== '') return
    const seq = ++requestSeqRef.current
    setLoading(true)
    setError('')
    setHasMore(true)
    setMvs([])

    if (isSearchMode) {
      const kw = searchKeyword.trim()
      if (!kw) {
        setLoading(false)
        return
      }
      searchMVs(kw, platform, 30).then((data) => {
        if (seq !== requestSeqRef.current) return
        setMvs(platform === 'netease' ? normalizeNetease(data?.result?.mvs || []) : normalizeQQ(data?.mvs || []))
        setHasMore(false)
        setLoading(false)
      }).catch(() => {
        if (seq !== requestSeqRef.current) return
        setError('搜索MV失败')
        setLoading(false)
      })
      return
    }

    if (platform === 'netease') {
      const area = neteaseArea === '全部' ? '' : neteaseArea
      const type = neteaseType === '全部' ? '' : neteaseType
      getAllMVs(30, 0, area, type, '').then((data) => {
        if (seq !== requestSeqRef.current) return
        const list = data?.data || []
        setMvs(normalizeNetease(list))
        setHasMore(Boolean(data?.hasMore))
        setLoading(false)
      }).catch(() => {
        if (seq !== requestSeqRef.current) return
        setError('加载MV列表失败')
        setLoading(false)
      })
    } else {
      getMVListByCategory(qqVersion, qqArea, 1, 20).then((data) => {
        if (seq !== requestSeqRef.current) return
        const list = data?.data?.list || []
        setMvs(normalizeQQ(list))
        setHasMore(list.length >= 20)
        setLoading(false)
      }).catch(() => {
        if (seq !== requestSeqRef.current) return
        setError('加载MV列表失败')
        setLoading(false)
      })
    }
  }, [platform, neteaseArea, neteaseType, qqVersion, qqArea, isSearchMode, searchKeyword])

  const normalizeNetease = (list: any[]): MVItem[] => list.map((item) => ({
    id: item.id,
    name: item.name || '',
    cover: getProxiedImageUrl(item.cover || item.imgurl16v9 || '', 400),
    artistName: item.artistName || (Array.isArray(item.artists) ? item.artists.map((a: any) => a.name).join('/') : ''),
    playCount: item.playCount,
    platform: 'netease' as const
  }))

  const normalizeQQ = (list: any[]): MVItem[] => list.map((item) => ({
    id: item.vid,
    name: item.title || item.name || '',
    cover: getProxiedImageUrl(item.picurl || '', 400),
    artistName: Array.isArray(item.singers) ? item.singers.map((s: any) => s.name).join('/') : '',
    playCount: Number(item.playcnt || 0),
    platform: 'qq' as const
  }))

  // 加载更多
  const loadMore = async () => {
    if (loadingMore || !hasMore) return
    setLoadingMore(true)
    try {
      if (platform === 'netease') {
        const nextOffset = neteaseOffset + 30
        const area = neteaseArea === '全部' ? '' : neteaseArea
        const type = neteaseType === '全部' ? '' : neteaseType
        const data = await getAllMVs(30, nextOffset, area, type, '')
        const list = data?.data || []
        setMvs(prev => [...prev, ...normalizeNetease(list)])
        setHasMore(Boolean(data?.hasMore))
        setNeteaseOffset(nextOffset)
      } else {
        const nextPage = qqPage + 1
        const data = await getMVListByCategory(qqVersion, qqArea, nextPage, 20)
        const list = data?.data?.list || []
        setMvs(prev => [...prev, ...normalizeQQ(list)])
        setHasMore(list.length >= 20)
        setQqPage(nextPage)
      }
    } catch {
      /* 加载更多失败静默 */
    } finally {
      setLoadingMore(false)
    }
  }

  // 点击 MV 播放
  const playMV = (mv: MVItem) => {
    setPlayingMV(mv)
    setIsVideoOpen(true)
  }

  // 触发搜索（effect 依赖 searchKeyword/isSearchMode 变化自动加载）
  const handleSearch = () => {
    const kw = searchKeyword.trim()
    if (!kw) return
    setIsSearchMode(true)
  }

  const clearSearch = () => {
    setSearchKeyword('')
    setIsSearchMode(false)
  }

  const mvListForPlayer: any[] = playingMV ? [playingMV] : []

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[85] flex items-center justify-center p-4"
      style={{ backgroundColor: dark ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.3)', backdropFilter: 'blur(10px)' }}
      onClick={onClose}
    >
      <motion.div
        data-tv-scope
        initial={{ scale: 0.94, opacity: 0, y: 14 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.94, opacity: 0, y: 14 }}
        transition={{ type: 'spring', damping: 28, stiffness: 320 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl overflow-hidden rounded-3xl shadow-2xl max-h-[86vh] flex flex-col"
        style={{ background: dark ? 'rgba(14,17,24,0.9)' : 'rgba(255,255,255,0.94)', border: `1px solid ${dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)'}`, backdropFilter: 'blur(30px)' }}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between px-6 py-4 shrink-0" style={{ borderBottom: `1px solid ${dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)'}` }}>
          <div className="flex items-center gap-3">
            <Film className="w-5 h-5" style={{ color: '#3B82F6' }} />
            <h2 className={`text-base font-semibold ${textPrimary}`}>MV 专区</h2>
            {/* 平台切换 */}
            <div className={`flex rounded-full p-0.5 ml-2 ${dark ? 'bg-white/8' : 'bg-black/8'}`} style={{ background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}>
              {(['netease', 'qq'] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setPlatform(p)}
                  className={`px-3 py-1 rounded-full text-xs transition-colors ${platform === p ? (dark ? 'bg-white text-black' : 'bg-black text-white') : textSecondary}`}
                >
                  {p === 'netease' ? '网易云' : 'QQ 音乐'}
                </button>
              ))}
            </div>
          </div>
          <button onClick={onClose} className={`p-2 rounded-full transition-colors ${dark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`}>
            <X className={`w-5 h-5 ${textSecondary}`} />
          </button>
        </div>

        {/* 搜索栏 */}
        <div className="px-6 pt-3 shrink-0">
          <form
            onSubmit={(e) => { e.preventDefault(); handleSearch() }}
            className="flex items-center gap-2 rounded-xl px-3 py-2"
            style={{ background: dark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)', border: `1px solid ${dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.1)'}` }}
          >
            <Search className={`w-4 h-4 shrink-0 ${textSecondary}`} />
            <input
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              placeholder="搜索 MV（歌手名 / 歌曲名）"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-white/30"
              style={{ color: dark ? '#fff' : '#000' }}
            />
            {isSearchMode && searchKeyword ? (
              <button type="button" onClick={clearSearch} className={`p-1 rounded-full transition-colors ${dark ? 'hover:bg-white/15' : 'hover:bg-black/10'}`} aria-label="清除搜索">
                <XCircle className={`w-4 h-4 ${textSecondary}`} />
              </button>
            ) : null}
            <button
              type="submit"
              className={`px-3 py-1 rounded-lg text-xs transition-colors ${dark ? 'bg-white/12 hover:bg-white/20 text-white' : 'bg-black/10 hover:bg-black/20 text-black'}`}
              style={{ background: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.1)' }}
            >
              搜索
            </button>
          </form>
          {isSearchMode && (
            <div className={`text-xs mt-2 flex items-center justify-between ${textSecondary}`}>
              <span>「{searchKeyword}」的搜索结果</span>
              <button onClick={clearSearch} className="underline hover:opacity-80">返回分类浏览</button>
            </div>
          )}
        </div>

        {/* 筛选栏（搜索模式下隐藏） */}
        {!isSearchMode && (
        <div className="flex flex-wrap items-center gap-2 px-6 py-3 shrink-0">
          {platform === 'netease' ? (
            <>
              <div className={`flex flex-wrap items-center gap-1`}>
                {NETESE_AREAS.map((a) => (
                  <button
                    key={a}
                    onClick={() => setNeteaseArea(a)}
                    className={`px-2.5 py-1 rounded-full text-xs transition-colors ${neteaseArea === a ? (dark ? 'bg-white/15 text-white' : 'bg-black/10 text-black') : textSecondary}`}
                  >
                    {a}
                  </button>
                ))}
              </div>
              <span className={`w-px h-4 mx-1 shrink-0 ${dark ? 'bg-white/10' : 'bg-black/10'}`} />
              <div className="flex flex-wrap items-center gap-1">
                {NETEASE_TYPES.map((t) => (
                  <button
                    key={t}
                    onClick={() => setNeteaseType(t)}
                    className={`px-2.5 py-1 rounded-full text-xs transition-colors ${neteaseType === t ? (dark ? 'bg-white/15 text-white' : 'bg-black/10 text-black') : textSecondary}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <>
              <span className={`text-xs ${textSecondary}`}>地区</span>
              <div className="flex flex-wrap items-center gap-1">
                {qqCategories.area.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setQqArea(c.id)}
                    className={`px-2.5 py-1 rounded-full text-xs transition-colors ${qqArea === c.id ? (dark ? 'bg-white/15 text-white' : 'bg-black/10 text-black') : textSecondary}`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
              <span className={`w-px h-4 mx-1 shrink-0 ${dark ? 'bg-white/10' : 'bg-black/10'}`} />
              <span className={`text-xs ${textSecondary}`}>类型</span>
              <div className="flex flex-wrap items-center gap-1">
                {qqCategories.version.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setQqVersion(c.id)}
                    className={`px-2.5 py-1 rounded-full text-xs transition-colors ${qqVersion === c.id ? (dark ? 'bg-white/15 text-white' : 'bg-black/10 text-black') : textSecondary}`}
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        )}

        {/* MV 网格 */}
        <div className="flex-1 overflow-y-auto px-6 pb-4">
          {loading ? (
            <div className="text-center py-16">
              <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin mx-auto mb-3"></div>
              <p className={`text-sm ${textSecondary}`}>加载中...</p>
            </div>
          ) : error ? (
            <div className={`text-center py-16 ${textSecondary}`}>{error}</div>
          ) : mvs.length === 0 ? (
            <div className={`text-center py-16 ${textSecondary}`}>暂无 MV</div>
          ) : (
            <div className="grid gap-4 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
              {mvs.map((mv, index) => (
                <motion.button
                  key={`${mv.platform}-${mv.id}-${index}`}
                  type="button"
                  whileHover={{ y: -4 }}
                  onClick={() => playMV(mv)}
                  className="group relative overflow-hidden rounded-2xl border border-white/[0.08] bg-white/[0.045] text-left"
                >
                  <div className="relative aspect-video overflow-hidden">
                    {mv.cover ? (
                      <img
                        src={mv.cover}
                        alt={mv.name}
                        loading="lazy"
                        className="w-full h-full object-cover transition duration-500 group-hover:scale-105"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden' }}
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center" style={{ background: dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }}>
                        <Film className={`w-8 h-8 ${textSecondary}`} />
                      </div>
                    )}
                    <div className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 group-hover:opacity-100 transition-opacity">
                      <span className="w-10 h-10 rounded-full bg-white/90 flex items-center justify-center">
                        <Play className="w-5 h-5 text-black ml-0.5" fill="currentColor" />
                      </span>
                    </div>
                    {mv.playCount > 0 && (
                      <span className={`absolute top-2 right-2 text-[10px] px-1.5 py-0.5 rounded-md ${dark ? 'bg-black/60 text-white/80' : 'bg-black/50 text-white/90'}`}>
                        {formatCount(mv.playCount)}
                      </span>
                    )}
                  </div>
                  <div className="p-2.5">
                    <p className={`text-xs font-medium truncate ${textPrimary}`}>{mv.name}</p>
                    <p className={`text-[11px] truncate mt-0.5 ${textSecondary}`}>{mv.artistName || '未知歌手'}</p>
                  </div>
                </motion.button>
              ))}
            </div>
          )}

          {/* 加载更多 */}
          {!loading && !error && mvs.length > 0 && hasMore && (
            <div className="flex justify-center py-4">
              <button
                onClick={() => void loadMore()}
                disabled={loadingMore}
                className={`flex items-center gap-1 px-4 py-1.5 rounded-full text-xs transition-colors ${dark ? 'bg-white/8 hover:bg-white/15 text-white' : 'bg-black/8 hover:bg-black/15 text-black'}`}
                style={{ background: dark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}
              >
                {loadingMore ? '加载中...' : '加载更多'}
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          {!loading && !error && mvs.length > 0 && !hasMore && (
            <div className={`text-center py-4 text-xs ${textSecondary}`}>已经到底了</div>
          )}
        </div>
      </motion.div>

      {/* 视频播放器 */}
      {isVideoOpen && playingMV && (
        <VideoPlayer
          mvId={playingMV.id}
          mvName={playingMV.name}
          platform={playingMV.platform}
          onClose={() => setIsVideoOpen(false)}
          mvList={mvListForPlayer}
          currentIndex={0}
        />
      )}
    </motion.div>
  )
}
