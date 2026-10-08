// 多歌手「查看歌手」选择弹窗。
//
// 背景：一首歌有多个歌手时，「查看歌手」不能默认挑第一个（用户实测：多歌手曲目点进去
// 只会看到第一个歌手，其余歌手无从选择）。这里弹出一个美化选择器：当前歌曲封面做背景
// （模糊 + 暗化 + 渐变，保证文字可读），歌手逐个以「头像 + 名字」卡片呈现，用户点谁看谁。
//
// 头像来源：用各平台已公开的歌手搜索（searchArtists，同名匹配）惰性补齐；拿不到就退化成
// 名字首字渐变占位（不编头像、不拿歌曲封面冒充艺人头像）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import { Loader2, Music2, UserRound, X } from 'lucide-react'
import type { Song } from '../services/musicApi'
import { searchArtists } from '../services/musicApi'
import type { MusicPlatform } from '../services/platforms'
import CachedImage from './CachedImage'

export interface ArtistPickerModalProps {
  show: boolean
  song: Song | null
  /** 主题色（按钮/高亮） */
  accent?: string
  /** 打开某个歌手（index 为 song.artists 下标；同名歌手按 index 定位） */
  onSelect: (index: number) => void
  onClose: () => void
}

interface ArtistEntry {
  name: string
  avatarUrl: string
  /** 头像是否已尝试解析（失败也置 true，避免反复请求） */
  resolved: boolean
}

/** 首字占位色：按名字哈希取一组稳定的渐变色，保证同名同色、不同名有区分度。 */
const PLACEHOLDER_GRADIENTS = [
  'linear-gradient(135deg,#f97316,#ec4899)',
  'linear-gradient(135deg,#22d3ee,#6366f1)',
  'linear-gradient(135deg,#34d399,#0ea5e9)',
  'linear-gradient(135deg,#a78bfa,#f472b6)',
  'linear-gradient(135deg,#facc15,#f97316)',
  'linear-gradient(135deg,#60a5fa,#22c55e)',
]
function placeholderGradient(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 997
  return PLACEHOLDER_GRADIENTS[hash % PLACEHOLDER_GRADIENTS.length]
}

export default function ArtistPickerModal({ show, song, accent = '#31c27c', onSelect, onClose }: ArtistPickerModalProps) {
  const artists = useMemo(() => song?.artists || [], [song])
  const [entries, setEntries] = useState<ArtistEntry[]>([])
  const generationRef = useRef(0)

  // 打开时惰性补头像：逐个 searchArtists 同名匹配（并行），失败/未命中留占位
  useEffect(() => {
    if (!show || !song) return
    const platform = (song.platform || 'netease') as MusicPlatform
    const generation = ++generationRef.current
    // 歌曲自带的歌手头像（汽水链路已从后端 url_avatar 透传）优先；缺失才走搜索补图
    const initial: ArtistEntry[] = artists.map(artist => {
      const inline = (artist as { avatarUrl?: string }).avatarUrl
      return { name: artist.name, avatarUrl: inline ? String(inline) : '', resolved: Boolean(inline) }
    })
    setEntries(initial)
    void Promise.all(artists.map(async (artist, index) => {
      const trimmed = String(artist.name || '').trim()
      if (!trimmed) return null
      try {
        const found = await searchArtists(trimmed, platform)
        const hit = found.find(item => item.name?.trim() === trimmed) || found[0]
        return hit?.picUrl ? { index, avatarUrl: hit.picUrl } : { index, avatarUrl: '' }
      } catch {
        return { index, avatarUrl: '' }
      }
    })).then(results => {
      if (generation !== generationRef.current) return
      setEntries(previous => previous.map((entry, index) => {
        const hit = results.find(item => item?.index === index)
        return hit ? { ...entry, avatarUrl: hit.avatarUrl, resolved: true } : { ...entry, resolved: true }
      }))
    })
    return () => { generationRef.current += 1 }
  }, [show, song, artists])

  // ESC 关闭
  useEffect(() => {
    if (!show) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [show, onClose])

  if (!show || !song) return null
  const cover = song.album?.picUrl || ''
  const pending = entries.some(entry => !entry.resolved)

  return (
    <div className="fixed inset-0 z-[10030] flex items-center justify-center p-6" role="dialog" aria-modal="true" aria-label="选择要查看的歌手">
      <div className="absolute inset-0 bg-black/62 backdrop-blur-md" onClick={onClose} />
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.22, ease: 'easeOut' }}
        className="relative w-full max-w-[560px] overflow-hidden rounded-[24px] border border-white/[0.12] shadow-2xl"
      >
        {/* 背景：当前歌曲封面（放大模糊 + 暗化 + 底部渐变），保证前景文字始终可读 */}
        {cover ? (
          <div className="absolute inset-0">
            <CachedImage
              src={cover}
              alt=""
              role="background"
              priority="visible"
              className="absolute inset-0 h-full w-full scale-125 object-cover blur-2xl"
            />
            <div className="absolute inset-0 bg-black/55" />
            <div className="absolute inset-0 bg-gradient-to-b from-black/25 via-black/45 to-black/72" />
          </div>
        ) : (
          <div className="absolute inset-0 bg-[#15171c]" />
        )}

        <div className="relative px-6 pb-6 pt-5">
          <div className="flex items-start gap-3">
            {cover ? (
              <CachedImage src={cover} alt={song.name} className="h-14 w-14 shrink-0 rounded-xl shadow-lg" role="row" priority="visible" />
            ) : (
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-white/10"><Music2 className="h-6 w-6 text-white/60" /></span>
            )}
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[16px] font-semibold text-white">{song.name}</span>
              <span className="mt-1 block truncate text-[12px] text-white/62">
                这首歌有 {artists.length} 位歌手，选择要查看的歌手
              </span>
            </span>
            <button type="button" onClick={onClose} aria-label="关闭" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/10 text-white/70 transition hover:bg-white/18 hover:text-white">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-3">
            {artists.map((artist, index) => {
              const entry = entries[index]
              const initial = String(artist.name || '?').trim().slice(0, 1) || '?'
              return (
                <button
                  key={`${artist.name}:${index}`}
                  type="button"
                  onClick={() => onSelect(index)}
                  className="group flex min-w-0 flex-col items-center gap-2 rounded-2xl border border-white/[0.1] bg-white/[0.06] px-3 py-4 text-center transition hover:-translate-y-0.5 hover:border-white/25 hover:bg-white/[0.12]"
                  title={`查看歌手 ${artist.name}`}
                >
                  <span className="relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-full" style={{ background: placeholderGradient(artist.name) }}>
                    {entry?.avatarUrl ? (
                      <CachedImage src={entry.avatarUrl} alt={artist.name} className="h-16 w-16 rounded-full object-cover" role="row" priority="visible" />
                    ) : entry && !entry.resolved ? (
                      <Loader2 className="h-5 w-5 animate-spin text-white/85" />
                    ) : (
                      <>
                        <UserRound className="absolute h-8 w-8 text-white/28" />
                        <span className="relative text-[22px] font-semibold text-white drop-shadow">{initial}</span>
                      </>
                    )}
                  </span>
                  <span className="line-clamp-2 w-full break-words text-[13px] font-medium leading-snug text-white">{artist.name}</span>
                </button>
              )
            })}
          </div>

          {pending ? (
            <p className="mt-4 text-center text-[11px] text-white/45">正在获取歌手头像…</p>
          ) : null}
        </div>
      </motion.div>
    </div>
  )
}
