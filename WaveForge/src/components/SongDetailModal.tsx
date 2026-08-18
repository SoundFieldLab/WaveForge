import { memo, useEffect, useState, type ReactNode } from 'react'
import { motion } from 'framer-motion'
import { X, Music, Disc3, Clock, BadgeCheck, Crown, Calendar, Video, CircleDollarSign, ListMusic, Mic2, ScrollText, BookOpen, RefreshCw, Play, Activity } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { getLyrics, getNeteaseSongWiki, getQQSongPlaylist, getProxiedImageUrl, getQQListenAlso, getQQLikeAlso, getNeteaseSimiSong, getNeteaseRelatedPlaylist, getNeteaseSongBlog } from '../services/musicApi'
import LyricModal from './LyricModal'
import VideoPlayer from './VideoPlayer'
import { useTvBack } from '../tv/tvCore'

interface SongDetailModalProps {
  song: Song
  onClose: () => void
  playerTheme: 'dark' | 'light'
  onPlayNow?: (song: Song) => void
  onOpenPlaylist?: (playlistId: string, platform: 'netease' | 'qq') => void
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000))
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}

function formatDate(ms: number): string {
  const d = new Date(Number(ms) || 0)
  if (Number.isNaN(d.getTime()) || !ms) return ''
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 网易云 fee 字段：0 免费 / 1 VIP / 4 付费专辑 / 8 低音质免费
const NETBASE_FEE_LABELS: Record<number, string> = {
  0: '免费',
  1: 'VIP 专享',
  4: '付费专辑',
  8: '免费（低音质）',
}

function SongDetailModal({ song, onClose, onPlayNow, onOpenPlaylist }: SongDetailModalProps) {
  // TV 遥控器 BACK：关闭歌曲详情弹窗
  useTvBack(() => {
    onClose()
    return true
  }, [onClose])
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')
  const [extra, setExtra] = useState<{ publishTime?: number; mvId?: number; fee?: number; quality?: string; qualityLevels?: { key: string; label: string; br: number }[]; albumExtra?: { company?: string; subType?: string; type?: string }; publishDate?: string; bpm?: number; genreText?: string; languageText?: string; mvVid?: string } | null>(null)
  // MV 播放
  const [showMV, setShowMV] = useState(false)
  // QQ 歌曲详情的板块数据
  const [qqInfo, setQqInfo] = useState<any>(null)
  const [credits, setCredits] = useState<string[]>([])
  const [lyrics, setLyrics] = useState<{ time: number; text: string }[]>([])
  const [lyricsLoading, setLyricsLoading] = useState(false)
  // 网易云歌曲百科 / QQ 所在歌单
  const [wiki, setWiki] = useState<string>('')
  const [songPlaylists, setSongPlaylists] = useState<{ id: string; name: string; coverUrl: string }[]>([])
  // QQ「听也在听」15 首 + 「喜欢也爱歌单」6 个
  const [listenAlso, setListenAlso] = useState<Song[]>([])
  const [likeAlso, setLikeAlso] = useState<{ id: string; name: string; coverImgUrl: string; trackCount: number }[]>([])
  const [alsoLoading, setAlsoLoading] = useState(false)
  // 歌词弹窗
  const [showLyric, setShowLyric] = useState(false)
  // 换一批偏移
  const [likeAlsoOffset, setLikeAlsoOffset] = useState(0)
  //「也在听」展开
  const [listenAlsoExpanded, setListenAlsoExpanded] = useState(false)
  // 网易云「喜欢这首歌的人也爱听」10 首 + 「相关歌单」5 个
  const [neteaseSimi, setNeteaseSimi] = useState<Song[]>([])
  const [neteaseRelated, setNeteaseRelated] = useState<{ id: string; name: string; coverImgUrl: string; trackCount: number }[]>([])
  // 网易云「相关博客」2 条
  const [neteaseBlogs, setNeteaseBlogs] = useState<{ id: number | string; title: string; summary: string; author: string; time: number }[]>([])

  // 网易云推荐：喜欢这首歌的人也爱听 + 相关歌单
  useEffect(() => {
    if (song.platform !== 'netease') return
    let cancelled = false
    void Promise.all([getNeteaseSimiSong(song.id, 10), getNeteaseRelatedPlaylist(song.id)]).then(([simiData, relatedData]) => {
      if (cancelled) return
      setNeteaseSimi(Array.isArray(simiData) ? simiData.map((s: any) => ({
        id: s.id,
        name: s.name || '',
        artists: Array.isArray(s.artists) ? s.artists.map((a: any) => ({ name: a.name })) : [],
        album: s.album ? { name: s.album.name, picUrl: s.album.picUrl || s.album.pic || '' } : { name: '', picUrl: '' },
        duration: s.duration || s.dt || 0,
        platform: 'netease' as const
      })).filter((s: Song) => s.id) : [])
      setNeteaseRelated(Array.isArray(relatedData) ? relatedData.map((p: any) => ({
        id: String(p.id || ''),
        name: p.name || '',
        coverImgUrl: p.coverImgUrl || p.picUrl || '',
        trackCount: Number(p.trackCount || 0),
      })).filter((p: any) => p.id) : [])
    }).catch(() => {})
    return () => { cancelled = true }
  }, [song.id, song.platform])

  // 网易云「相关博客」：按歌曲所属专辑拉取（App 歌曲详情"相关博客"，含此歌曲的博客文章）
  useEffect(() => {
    if (song.platform !== 'netease') return
    let cancelled = false
    const albumId = song.album?.id
    if (!albumId) return
    void getNeteaseSongBlog(albumId).then((data) => {
      if (cancelled || !data) return
      const list = data?.data?.blogList || data?.data?.list || data?.data?.blogs || []
      const blogs = (Array.isArray(list) ? list : []).slice(0, 2).map((b: any) => ({
        id: b.blogId ?? b.id ?? 0,
        title: b.title || b.name || '',
        summary: b.summary || b.desc || b.content?.slice?.(0, 100) || '',
        author: b.nickname || b.creator?.nickname || b.userId ? '' : '',
        time: b.createTime || b.publishTime || b.time || 0,
      }))
      if (!cancelled) setNeteaseBlogs(blogs)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [song.id, song.platform, song.album?.id])

  // QQ 推荐：听 [歌曲] 的也在听 + 喜欢 [歌曲] 的人也爱它们
  useEffect(() => {
    if (song.platform !== 'qq') return
    let cancelled = false
    setAlsoLoading(true)
    const songid = String(song.id || '')
    const singermid = song.artists?.[0]?.mid
    void Promise.all([getQQListenAlso(songid, singermid), getQQLikeAlso(songid)]).then(([listenData, likeData]) => {
      if (cancelled) return
      setListenAlso(Array.isArray(listenData) ? listenData : [])
      setLikeAlso(Array.isArray(likeData) ? likeData : [])
      setAlsoLoading(false)
    }).catch(() => { if (!cancelled) setAlsoLoading(false) })
    return () => { cancelled = true }
  }, [song.id, song.platform])

  useEffect(() => {
    const handleAccent = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail) setAccentColor(detail)
    }
    window.addEventListener('accentColorChanged', handleAccent)
    return () => window.removeEventListener('accentColorChanged', handleAccent)
  }, [])

  // 拉取两平台支持的歌曲详情补充字段（发行时间 / MV / 付费类型 / 音质）
  useEffect(() => {
    let cancelled = false
    const fetchDetail = async () => {
      try {
        // Apple：无网易云/QQ 详情接口；歌词走融合链路（Apple 官方/AMLL/Lrclib）
        if (song.platform === 'apple') {
          setLyricsLoading(true)
          const lyricLines = await getLyrics(
            String(song.id),
            'apple',
            song.name,
            Array.isArray(song.artists) ? song.artists.map(a => a.name).join(', ') : '',
            song.duration
          )
          if (!cancelled && Array.isArray(lyricLines)) setLyrics(lyricLines)
          if (!cancelled) setLyricsLoading(false)
          return
        }
        if (song.platform === 'qq') {
          const mid = String(song.mid || song.id)
          const res = await fetch(`http://localhost:3001/api/qq/song/detail?mid=${encodeURIComponent(mid)}`)
          const data = await res.json()
          if (!cancelled && data?.song) {
            setExtra({
              publishTime: data.song.publishTime || data.song.album?.publishTime,
              mvId: data.song.mvId || data.song.mv,
              fee: data.song.fee,
              quality: data.song.vip ? '无损 / 高品质' : '标准',
              qualityLevels: Array.isArray(data.song.qualityLevels) ? data.song.qualityLevels : [],
              publishDate: data.song.publishDate,
              bpm: data.song.bpm,
              mvVid: data.song.mvVid,
            })
          }
          // 基础信息板块（语种/流派/唱片公司/发行时间/简介）
          if (!cancelled && data?.detail?.info) {
            setQqInfo(data.detail.info)
            const info = data.detail.info
            setExtra(prev => prev ? { ...prev, genreText: info.genre?.content?.[0]?.value || '', languageText: info.lan?.content?.[0]?.value || '' } : prev)
          }
          // 歌词 + 幕后团队（歌词前几行的“词/曲/编曲/制作人”等）
          setLyricsLoading(true)
          const lyricLines = await getLyrics(mid, 'qq', song.name, Array.isArray(song.artists) ? song.artists.map(a => a.name).join(', ') : '', song.duration)
          if (!cancelled && Array.isArray(lyricLines)) {
            setLyrics(lyricLines)
            const creditLines = lyricLines.slice(0, 20)
              .map(l => (l.text || '').trim())
              .filter(t => /^(词|曲|编曲|制作人|合声|和声|吉他|贝斯|鼓|录音|混音|母带|弦乐|小提琴|钢琴|键盘|监制)/.test(t))
            setCredits(creditLines)
          }
          if (!cancelled) setLyricsLoading(false)
        } else {
          const res = await fetch(`http://localhost:3001/api/netease/song/detail?ids=${encodeURIComponent(String(song.id))}`)
          const data = await res.json()
          const detail = data?.songs?.[0]
          if (!cancelled && detail) {
            const quality = detail.hr ? 'Hi-Res 无损'
              : detail.sq ? '无损 FLAC'
                : detail.h ? '高品质 320k'
                  : detail.m ? '标准 192k'
                    : detail.l ? '普通 128k'
                      : ''
            setExtra({
              publishTime: detail.publishTime || detail.al?.publishTime,
              mvId: detail.mv,
              fee: detail.fee,
              quality,
              qualityLevels: Array.isArray(detail.qualityLevels) ? detail.qualityLevels : [],
              albumExtra: detail.albumExtra || undefined,
            })
          }
          // 网易云歌词
          setLyricsLoading(true)
          const lyricLines = await getLyrics(String(song.id), 'netease', song.name, Array.isArray(song.artists) ? song.artists.map(a => a.name).join(', ') : '', song.duration)
          if (!cancelled && Array.isArray(lyricLines)) setLyrics(lyricLines)
          if (!cancelled) setLyricsLoading(false)
        }
      } catch {
        // 拉取失败时仅展示已有字段
      }
    }
    void fetchDetail()
    return () => { cancelled = true }
  }, [song.id, song.mid, song.platform])

  // 网易云歌曲百科 / QQ 歌曲所在歌单
  useEffect(() => {
    let cancelled = false
    if (song.platform === 'netease') {
      void getNeteaseSongWiki(song.id).then((summary) => {
        if (!cancelled && summary) setWiki(String(summary).slice(0, 300))
      })
    } else if (song.platform === 'qq' && song.mid) {
      void getQQSongPlaylist(String(song.mid)).then((data) => {
        if (cancelled || !data) return
        const list = data?.list || data?.songList || []
        setSongPlaylists(Array.isArray(list) ? list.slice(0, 5).map((p: any) => ({
          id: String(p.dissid || p.tid || ''),
          name: p.dissname || p.name || '未知歌单',
          coverUrl: p.imgurl || p.picUrl || '',
        })) : [])
      })
    }
    return () => { cancelled = true }
  }, [song.id, song.mid, song.platform])

  const artists = Array.isArray(song.artists) ? song.artists.map(a => a.name).filter(Boolean).join(' / ') : '未知歌手'
  const albumName = song.album?.name || '未知专辑'
  const coverUrl = song.album?.picUrl || ''
  const platformLabel = song.platform === 'qq' ? 'QQ音乐' : song.platform === 'netease' ? '网易云音乐' : ''
  const publishDate = formatDate(extra?.publishTime || 0)
  const feeLabel = extra?.fee != null && platformLabel === '网易云音乐'
    ? NETBASE_FEE_LABELS[extra.fee]
    : ''

  const textPrimary = 'text-white'
  const textSecondary = 'text-white/60'
  const textTertiary = 'text-white/40'

  const infoRow = (icon: ReactNode, label: string, value: string, mono = false) => (
    <div className="flex items-center gap-3 rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
      <span className="shrink-0" style={{ color: accentColor }}>{icon}</span>
      <span className={`${textSecondary} text-sm shrink-0`}>{label}</span>
      <span className={`flex-1 min-w-0 text-sm ${textPrimary} truncate text-right ${mono ? 'tabular-nums' : ''}`}>{value}</span>
    </div>
  )

  return (
    <motion.div
      data-tv-scope
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[85] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.5)', backdropFilter: 'blur(8px)' }}
      onClick={onClose}
    >
      <motion.div
        initial={{ scale: 0.94, opacity: 0, y: 12 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.94, opacity: 0, y: 12 }}
        transition={{ type: 'spring', damping: 28, stiffness: 320 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-5xl max-h-[90vh] flex flex-col overflow-hidden rounded-3xl shadow-2xl relative"
      >
        {/* 液态玻璃背景 - 使用歌曲封面 */}
        <div className="absolute inset-0 rounded-3xl overflow-hidden">
          {coverUrl && (
            <div
              className="absolute inset-0 bg-cover bg-center"
              style={{
                backgroundImage: `url(${getProxiedImageUrl(coverUrl)})`,
                filter: 'blur(40px) brightness(0.6)',
              }}
            />
          )}
          <div
            className="absolute inset-0"
            style={{
              background: 'linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(20,20,30,0.5) 50%, rgba(0,0,0,0.4) 100%)',
              backdropFilter: 'blur(80px) saturate(200%)',
              WebkitBackdropFilter: 'blur(80px) saturate(200%)',
            }}
          />
          <div
            className="absolute inset-0 rounded-3xl"
            style={{
              border: '1px solid rgba(255,255,255,0.2)',
              boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.15)',
              pointerEvents: 'none',
            }}
          />
        </div>

        {/* 内容区 */}
        <div className="relative z-10 flex flex-col h-full min-h-0">
          {/* 头部条 */}
          <div className="p-5 border-b flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${accentColor}26`, color: accentColor }}>
                  <Music className="w-4.5 h-4.5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-white">歌曲详情</h2>
                  {platformLabel && <div className={`${textSecondary} text-[11px] -mt-0.5`}>{platformLabel}</div>}
                </div>
              </div>
              <button type="button" onClick={onClose} className="p-2 rounded-full transition-colors hover:bg-white/15">
                <X className="w-5 h-5 text-white/60" />
              </button>
            </div>
          </div>

          {/* 头部横向：封面 + 歌曲信息 */}
          <div className="p-6 border-b flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.08)' }}>
            <div className="flex gap-5 items-center">
              <div className="w-32 h-32 rounded-2xl overflow-hidden shrink-0 shadow-xl" style={{ border: '1px solid rgba(255,255,255,0.12)', background: 'rgba(255,255,255,0.06)' }}>
                {coverUrl ? (
                  <img src={getProxiedImageUrl(coverUrl)} alt={song.name} className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Music className="w-10 h-10" style={{ color: accentColor }} />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <h1 className="text-2xl font-bold text-white leading-snug break-words">{song.name || '未知歌曲'}</h1>
                <p className={`${textSecondary} text-sm mt-1 truncate`}>{artists}</p>
                <div className="flex items-center gap-3 mt-3 flex-wrap">
                  {song.vip && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] text-white" style={{ backgroundColor: accentColor }}>
                      <Crown className="w-3 h-3" /> VIP
                    </span>
                  )}
                  {publishDate && <span className={`${textTertiary} text-xs`}>发行 {publishDate}</span>}
                  <span className={`${textTertiary} text-xs`}>{formatDuration(song.duration)}</span>
                  {/* 音质等级标签（该歌曲支持的所有音质） */}
                  {extra?.qualityLevels && extra.qualityLevels.length > 0 ? (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {extra.qualityLevels.map((q, i) => (
                        <span
                          key={`${q.key}-${i}`}
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium"
                          style={{
                            color: '#fff',
                            background: q.label.includes('无损') || q.label.includes('Hi-Res') || q.label.includes('杜比') || q.label.includes('臻品')
                              ? `linear-gradient(135deg, ${accentColor}cc, ${accentColor}88)`
                              : 'rgba(255,255,255,0.12)',
                            border: '1px solid rgba(255,255,255,0.18)',
                          }}
                        >
                          {q.label}
                        </span>
                      ))}
                    </div>
                  ) : feeLabel ? (
                    <span className={`${textTertiary} text-xs`}>{feeLabel}</span>
                  ) : null}
                </div>
              </div>
              {/* 查看歌词（横排最右，短按钮） */}
              <button
                type="button"
                onClick={() => setShowLyric(true)}
                className="shrink-0 flex items-center gap-1.5 px-4 py-2 rounded-full text-sm transition-colors hover:brightness-110"
                style={{ background: `${accentColor}33`, border: `1px solid ${accentColor}88`, color: '#fff' }}
              >
                <ScrollText className="w-4 h-4" /> 歌词
              </button>
            </div>
          </div>

          {/* 内容横向分栏 */}
          <div className="flex-1 min-h-0 overflow-hidden p-6 flex gap-6">
            {/* 左列：信息 / 基础信息 / 幕后团队 / 百科 / 所在歌单 */}
            <div className="w-80 flex-shrink-0 overflow-y-auto pr-1 space-y-5">
              <div className="space-y-2.5">
                {infoRow(<Disc3 className="w-4 h-4" />, '专辑', albumName)}
                {infoRow(<Clock className="w-4 h-4" />, '时长', formatDuration(song.duration), true)}
                {publishDate && infoRow(<Calendar className="w-4 h-4" />, '发行时间', publishDate, true)}
                {extra?.bpm ? infoRow(<Activity className="w-4 h-4" />, 'BPM', String(extra.bpm), true) : null}
                {extra?.genreText && infoRow(<Music className="w-4 h-4" />, '流派', extra.genreText)}
                {extra?.languageText && infoRow(<Mic2 className="w-4 h-4" />, '语种', extra.languageText)}
                {extra?.albumExtra?.company && infoRow(<Disc3 className="w-4 h-4" />, '唱片公司', extra.albumExtra.company)}
                {extra?.albumExtra?.subType && infoRow(<Disc3 className="w-4 h-4" />, '专辑类型', extra.albumExtra.subType)}
                {extra?.mvId != null && (
                  <button
                    type="button"
                    onClick={() => setShowMV(true)}
                    className="w-full flex items-center gap-3 rounded-xl px-3 py-2.5 transition-colors hover:bg-white/10 text-left"
                    style={{ background: 'rgba(255,255,255,0.05)', border: `1px solid ${accentColor}55` }}
                  >
                    <span className="shrink-0" style={{ color: accentColor }}><Video className="w-4 h-4" /></span>
                    <span className={`${textSecondary} text-sm shrink-0`}>MV</span>
                    <span className={`flex-1 min-w-0 text-sm ${textPrimary} truncate text-right flex items-center justify-end gap-1.5`}>
                      <Play className="w-3.5 h-3.5" fill="currentColor" /> 点击播放
                    </span>
                  </button>
                )}
                {extra?.qualityLevels && extra.qualityLevels.length > 0 && (
                  <div className="flex items-center gap-3 rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
                    <span className="shrink-0" style={{ color: accentColor }}><CircleDollarSign className="w-4 h-4" /></span>
                    <span className={`${textSecondary} text-sm shrink-0`}>音质</span>
                    <span className="flex-1 min-w-0 flex justify-end gap-1 flex-wrap">
                      {extra.qualityLevels.map((q, i) => (
                        <span
                          key={`${q.key}-${i}`}
                          className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium text-white"
                          style={{
                            background: q.label.includes('无损') || q.label.includes('Hi-Res') || q.label.includes('杜比') || q.label.includes('臻品')
                              ? `linear-gradient(135deg, ${accentColor}cc, ${accentColor}88)`
                              : 'rgba(255,255,255,0.12)',
                            border: '1px solid rgba(255,255,255,0.18)',
                          }}
                        >
                          {q.label}
                        </span>
                      ))}
                    </span>
                  </div>
                )}
                {platformLabel && infoRow(<BadgeCheck className="w-4 h-4" />, '来源', platformLabel)}
                {typeof song.commentCount === 'number' && infoRow(<Music className="w-4 h-4" />, '评论', song.commentCount.toLocaleString(), true)}
              </div>

              {/* QQ 基础信息板块（语种/流派/唱片公司/发行时间/简介） */}
              {song.platform === 'qq' && qqInfo && (
                <div>
                  <div className="flex items-center gap-2 mb-2.5">
                    <ListMusic className="w-4 h-4" style={{ color: accentColor }} />
                    <h4 className={`text-sm font-semibold ${textPrimary}`}>基础信息</h4>
                  </div>
                  <div className="space-y-2">
                    {qqInfo.lan?.content?.[0]?.value && infoRow(<Mic2 className="w-4 h-4" />, '语种', qqInfo.lan.content[0].value)}
                    {qqInfo.genre?.content?.[0]?.value && infoRow(<Music className="w-4 h-4" />, '流派', qqInfo.genre.content[0].value)}
                    {qqInfo.company?.content?.[0]?.value && infoRow(<Disc3 className="w-4 h-4" />, '唱片公司', qqInfo.company.content[0].value)}
                    {qqInfo.pub_time?.content?.[0]?.value && infoRow(<Calendar className="w-4 h-4" />, '发行时间', qqInfo.pub_time.content[0].value)}
                  </div>
                  {qqInfo.intro?.content?.[0]?.value && (
                    <div className="mt-3 rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
                      <p className={`${textSecondary} text-xs mb-1`}>歌曲简介</p>
                      <p className={`${textPrimary} text-sm leading-relaxed`}>{qqInfo.intro.content[0].value}</p>
                    </div>
                  )}
                </div>
              )}

              {/* 幕后团队（QQ 歌词头部信息） */}
              {song.platform === 'qq' && credits.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2.5">
                    <Mic2 className="w-4 h-4" style={{ color: accentColor }} />
                    <h4 className={`text-sm font-semibold ${textPrimary}`}>幕后团队</h4>
                  </div>
                  <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
                    {credits.map((line, i) => (
                      <p key={i} className={`${textPrimary} text-sm leading-6`}>{line}</p>
                    ))}
                  </div>
                </div>
              )}

              {/* 网易云歌曲百科 */}
              {song.platform === 'netease' && wiki && (
                <div>
                  <div className="flex items-center gap-2 mb-2.5">
                    <BookOpen className="w-4 h-4" style={{ color: accentColor }} />
                    <h4 className={`text-sm font-semibold ${textPrimary}`}>歌曲百科</h4>
                  </div>
                  <div className="rounded-xl px-3 py-2.5" style={{ background: 'rgba(255,255,255,0.05)' }}>
                    <p className={`${textPrimary} text-sm leading-relaxed`}>{wiki}</p>
                  </div>
                </div>
              )}

              {/* QQ 歌曲所在歌单 */}
              {song.platform === 'qq' && songPlaylists.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-2.5">
                    <ListMusic className="w-4 h-4" style={{ color: accentColor }} />
                    <h4 className={`text-sm font-semibold ${textPrimary}`}>收录于歌单</h4>
                  </div>
                  <div className="space-y-2">
                    {songPlaylists.map((p, i) => (
                      <div key={`${p.id}-${i}`} className="flex items-center gap-3 rounded-xl px-3 py-2" style={{ background: 'rgba(255,255,255,0.05)' }}>
                        <div className="w-9 h-9 rounded-md overflow-hidden shrink-0" style={{ background: 'rgba(255,255,255,0.08)' }}>
                          {p.coverUrl ? <img src={getProxiedImageUrl(p.coverUrl)} alt={p.name} className="w-full h-full object-cover" /> : <Music className="w-5 h-5 m-auto mt-2 text-white/30" />}
                        </div>
                        <p className={`${textPrimary} text-sm truncate`}>{p.name}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* 右列：推荐 */}
            <div className="flex-1 min-w-0 overflow-y-auto">

              {/* QQ：听 [歌曲] 的也在听 */}
              {song.platform === 'qq' && (
                <div className="mt-6">
                  <div className="flex items-center gap-2 mb-3">
                    <Music className="w-4 h-4" style={{ color: accentColor }} />
                    <h4 className={`text-sm font-semibold ${textPrimary}`}>听「{song.name}」的也在听</h4>
                  </div>
                  {alsoLoading ? (
                    <p className={`${textSecondary} text-xs py-2`}>加载推荐中...</p>
                  ) : listenAlso.length === 0 ? (
                    <p className={`${textSecondary} text-xs py-2`}>暂无推荐</p>
                  ) : (
                    <div className="space-y-1.5">
                      {listenAlso.slice(0, listenAlsoExpanded ? 15 : 5).map((s, i) => (
                        <div
                          key={`${s.mid || s.id || i}-${i}`}
                          className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5 transition-colors cursor-pointer group"
                          onClick={() => { if (onPlayNow) onPlayNow(s) }}
                        >
                          <span className={`w-5 text-center text-xs ${textTertiary}`}>{i + 1}</span>
                          <div className="w-9 h-9 rounded-md overflow-hidden shrink-0" style={{ background: 'rgba(255,255,255,0.08)' }}>
                            {s.album?.picUrl ? <img src={getProxiedImageUrl(s.album.picUrl, 100)} alt={s.name} className="w-full h-full object-cover" /> : <Music className="w-4 h-4 m-auto mt-2.5 text-white/30" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className={`${textPrimary} text-sm truncate`}>{s.name}</p>
                            <p className={`${textTertiary} text-xs truncate`}>{(s.artists || []).map(a => a.name).join(' / ')}</p>
                          </div>
                          <Play className={`w-3.5 h-3.5 ${textTertiary} opacity-0 group-hover:opacity-100 transition-opacity`} fill="currentColor" />
                        </div>
                      ))}
                      {listenAlso.length > 5 && (
                        <button
                          type="button"
                          onClick={() => setListenAlsoExpanded(v => !v)}
                          className="w-full mt-2 py-1.5 rounded-lg text-xs text-white/60 hover:text-white hover:bg-white/5 transition-colors"
                        >
                          {listenAlsoExpanded ? '收起' : `更多（${listenAlso.length} 首）`}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* QQ：喜欢 [歌曲] 的人也爱它们（歌单） */}
              {song.platform === 'qq' && (
                <div className="mt-6">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <ListMusic className="w-4 h-4" style={{ color: accentColor }} />
                      <h4 className={`text-sm font-semibold ${textPrimary}`}>喜欢「{song.name}」的人也爱它们</h4>
                    </div>
                    {likeAlso.length > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          const songid = String(song.id || '')
                          const nextOffset = likeAlsoOffset + 1
                          setLikeAlsoOffset(nextOffset)
                          void getQQLikeAlso(songid, nextOffset).then((data) => { if (Array.isArray(data)) setLikeAlso(data) })
                        }}
                        className="flex items-center gap-1 text-xs text-white/50 hover:text-white transition-colors"
                      >
                        <RefreshCw className="w-3 h-3" /> 换一批
                      </button>
                    )}
                  </div>
                  {alsoLoading ? (
                    <p className={`${textSecondary} text-xs py-2`}>加载推荐中...</p>
                  ) : likeAlso.length === 0 ? (
                    <p className={`${textSecondary} text-xs py-2`}>暂无推荐</p>
                  ) : (
                    <div className="grid grid-cols-3 gap-2.5">
                      {likeAlso.map((p, i) => (
                        <div key={`${p.id}-${i}`} className="group cursor-pointer" onClick={() => { if (onOpenPlaylist && p.id) onOpenPlaylist(p.id, 'qq') }}>
                          <div className="relative aspect-square rounded-lg overflow-hidden mb-1.5" style={{ background: 'rgba(255,255,255,0.08)' }}>
                            {p.coverImgUrl ? <img src={getProxiedImageUrl(p.coverImgUrl, 150)} alt={p.name} className="w-full h-full object-cover group-hover:scale-105 transition duration-300" /> : <Music className="w-6 h-6 m-auto text-white/30" />}
                          </div>
                          <p className={`${textPrimary} text-xs truncate`}>{p.name}</p>
                          {p.trackCount ? <p className={`${textTertiary} text-[11px] truncate`}>{p.trackCount} 首</p> : null}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 网易云：喜欢这首歌的人也爱听 */}
              {song.platform === 'netease' && (
                <div className="mt-6">
                  <div className="flex items-center gap-2 mb-3">
                    <Music className="w-4 h-4" style={{ color: accentColor }} />
                    <h4 className={`text-sm font-semibold ${textPrimary}`}>喜欢「{song.name}」的人也爱听</h4>
                  </div>
                  {neteaseSimi.length === 0 ? (
                    <p className={`${textSecondary} text-xs py-2`}>登录后获取推荐</p>
                  ) : (
                    <div className="space-y-1.5">
                      {neteaseSimi.slice(0, 10).map((s, i) => (
                        <div
                          key={`${s.id || i}-${i}`}
                          className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5 transition-colors cursor-pointer group"
                          onClick={() => { if (onPlayNow) onPlayNow(s) }}
                        >
                          <span className={`w-5 text-center text-xs ${textTertiary}`}>{i + 1}</span>
                          <div className="w-9 h-9 rounded-md overflow-hidden shrink-0" style={{ background: 'rgba(255,255,255,0.08)' }}>
                            {s.album?.picUrl ? <img src={getProxiedImageUrl(s.album.picUrl, 100)} alt={s.name} className="w-full h-full object-cover" /> : <Music className="w-4 h-4 m-auto mt-2.5 text-white/30" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className={`${textPrimary} text-sm truncate`}>{s.name}</p>
                            <p className={`${textTertiary} text-xs truncate`}>{(s.artists || []).map(a => a.name).join(' / ')}</p>
                          </div>
                          <Play className={`w-3.5 h-3.5 ${textTertiary} opacity-0 group-hover:opacity-100 transition-opacity`} fill="currentColor" />
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 网易云：相关歌单（包含此歌曲） */}
              {song.platform === 'netease' && (
                <div className="mt-6">
                  <div className="flex items-center gap-2 mb-3">
                    <ListMusic className="w-4 h-4" style={{ color: accentColor }} />
                    <h4 className={`text-sm font-semibold ${textPrimary}`}>相关歌单</h4>
                  </div>
                  {neteaseRelated.length === 0 ? (
                    <p className={`${textSecondary} text-xs py-2`}>登录后获取推荐</p>
                  ) : (
                    <div className="space-y-2">
                      {neteaseRelated.map((p, i) => (
                        <div key={`${p.id}-${i}`} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-white/5 transition-colors cursor-pointer" onClick={() => { if (onOpenPlaylist && p.id) onOpenPlaylist(p.id, 'netease') }}>
                          <div className="w-10 h-10 rounded-md overflow-hidden shrink-0" style={{ background: 'rgba(255,255,255,0.08)' }}>
                            {p.coverImgUrl ? <img src={getProxiedImageUrl(p.coverImgUrl, 100)} alt={p.name} className="w-full h-full object-cover" /> : <Music className="w-5 h-5 m-auto mt-2.5 text-white/30" />}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className={`${textPrimary} text-sm truncate`}>{p.name}</p>
                            {p.trackCount ? <p className={`${textTertiary} text-xs`}>{p.trackCount} 首</p> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* 网易云：相关博客（包含此歌曲，最多 2 条） */}
              {song.platform === 'netease' && neteaseBlogs.length > 0 && (
                <div className="mt-6">
                  <div className="flex items-center gap-2 mb-3">
                    <BookOpen className="w-4 h-4" style={{ color: accentColor }} />
                    <h4 className={`text-sm font-semibold ${textPrimary}`}>相关博客</h4>
                  </div>
                  <div className="space-y-2">
                    {neteaseBlogs.map((b, i) => (
                      <div key={`${b.id || i}-${i}`} className="rounded-lg px-3 py-2.5 cursor-pointer transition-colors hover:bg-white/5" style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)' }}>
                        <p className={`${textPrimary} text-sm font-medium truncate`}>{b.title || '博客文章'}</p>
                        {b.summary && <p className={`${textTertiary} text-xs mt-0.5 line-clamp-2`}>{b.summary}</p>}
                        {b.author && <p className={`${textTertiary} text-[11px] mt-1`}>{b.author}</p>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </motion.div>

      {/* 歌词弹窗 */}
      {showLyric && (
        <LyricModal
          songName={song.name || ''}
          artistName={artists}
          coverUrl={coverUrl}
          lyrics={lyrics}
          onClose={() => setShowLyric(false)}
        />
      )}

      {/* MV 播放器（点击播放） */}
      {showMV && extra?.mvId != null && (
        <VideoPlayer
          mvId={song.platform === 'qq' ? (extra.mvVid || String(extra.mvId)) : extra.mvId}
          mvName={song.name || ''}
          platform={song.platform === 'qq' ? 'qq' : 'netease'}
          onClose={() => setShowMV(false)}
        />
      )}
    </motion.div>
  )
}

// 弹窗在 App 全局挂载点常驻渲染，播放中 App 约 1Hz 重渲染时 props 稳定则跳过整棵弹窗子树重渲染
export default memo(SongDetailModal)
