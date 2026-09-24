import { useEffect, useRef, useState } from 'react'
import { Clock, Disc3, Headphones, Loader2, MessageSquareText, Play, Radio, Share2, UserRound, X } from 'lucide-react'
import CachedImage from '../../components/CachedImage'
import { fetchNeteaseProgramDetail, fetchNeteaseRadioDetail } from './api'

// src/features/neteaseExplore/NeteaseRadioDetailPanel.tsx
// 电台 / 播客节目的二级详情页。
// App 里点节目卡是「直接播放」（orpheus://nm/voice/playRcmd），因此本面板不替代播放，
// 而是补上 App 原生 voicelist/program 详情页提供的信息层：DJ、简介、节目数、时长、互动数。

export interface NeteaseRadioDetailTarget {
  kind: 'radio' | 'program'
  id: string
  title: string
  coverUrl?: string
}

function formatCount(value?: number) {
  const count = Number(value || 0)
  if (!count) return ''
  if (count >= 100_000_000) return `${(count / 100_000_000).toFixed(1)}亿`
  if (count >= 10_000) return `${(count / 10_000).toFixed(1)}万`
  return String(count)
}

function formatDuration(ms?: number) {
  const total = Math.round(Number(ms || 0) / 1000)
  if (!total) return ''
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatDate(value?: number) {
  const time = Number(value || 0)
  if (!time) return ''
  const date = new Date(time)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

interface Props {
  target: NeteaseRadioDetailTarget
  onClose: () => void
  onPlay?: () => void
  /** 从节目详情跳到所属电台 */
  onOpenRadio?: (radioId: string, name: string) => void
  onOpenUser?: (userId: string) => void
}

export default function NeteaseRadioDetailPanel({ target, onClose, onPlay, onOpenRadio, onOpenUser }: Props) {
  const [data, setData] = useState<any | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  // 面板现在保持挂载（冻结）：同一 kind:id 已经有数据时直接复用，不再重新请求。
  // 只在成功时记录 key，失败保留重试路径。
  const loadedKeyRef = useRef('')

  useEffect(() => {
    const key = `${target.kind}:${target.id}`
    if (loadedKeyRef.current === key) return
    let cancelled = false
    setLoading(true)
    setError('')
    setData(null)
    const task = target.kind === 'radio'
      ? fetchNeteaseRadioDetail(target.id)
      : fetchNeteaseProgramDetail(target.id)
    void task.then(result => {
      if (cancelled) return
      if (!result) setError(target.kind === 'radio' ? '电台详情加载失败' : '节目详情加载失败')
      else { loadedKeyRef.current = key; setData(result) }
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [target.kind, target.id])

  const cover = data?.coverUrl || target.coverUrl || ''
  const title = data?.name || target.title || ''

  return (
    <div className="fixed inset-0 z-[178] flex items-center justify-center bg-black/65 p-5 backdrop-blur-xl" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-md border border-white/[0.1] bg-[#0d1118] text-white"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-start gap-5 border-b border-white/[0.08] p-6">
          <span className="relative block h-28 w-28 shrink-0 overflow-hidden rounded-md bg-white/[0.06]">
            {cover
              ? <CachedImage src={cover} alt="" platform="netease" className="h-full w-full object-cover" role="hero" priority="visible" fallback={<span className="flex h-full w-full items-center justify-center"><Disc3 className="h-7 w-7 text-white/25" /></span>} />
              : <span className="flex h-full w-full items-center justify-center"><Disc3 className="h-7 w-7 text-white/25" /></span>}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-xs text-white/42">
                  {target.kind === 'radio' ? <Radio className="h-3.5 w-3.5" /> : <Headphones className="h-3.5 w-3.5" />}
                  {target.kind === 'radio' ? '电台' : '播客节目'}
                </p>
                <h3 className="mt-2 line-clamp-2 text-lg font-semibold leading-snug">{title}</h3>
              </div>
              <button type="button" onClick={onClose} aria-label="关闭详情" className="shrink-0 text-white/60 transition hover:text-white"><X className="h-5 w-5" /></button>
            </div>

            {loading && <div className="mt-4 flex items-center gap-2 text-sm text-white/45"><Loader2 className="h-4 w-4 animate-spin" />加载详情…</div>}
            {error && <p className="mt-4 text-sm text-rose-200/85">{error}</p>}

            {data && (
              <>
                <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-white/50">
                  {data.dj?.nickname && (
                    <button
                      type="button"
                      onClick={() => data.dj.userId && onOpenUser?.(String(data.dj.userId))}
                      disabled={!data.dj.userId || !onOpenUser}
                      className="flex items-center gap-1.5 transition enabled:hover:text-pink-300 disabled:cursor-default"
                    >
                      <UserRound className="h-3.5 w-3.5" />{data.dj.nickname}
                    </button>
                  )}
                  {target.kind === 'radio' && data.programCount > 0 && <span>共 {data.programCount} 集</span>}
                  {target.kind === 'program' && data.duration > 0 && <span className="flex items-center gap-1"><Clock className="h-3.5 w-3.5" />{formatDuration(data.duration)}</span>}
                  {data.listenerCount > 0 && <span className="flex items-center gap-1"><Headphones className="h-3.5 w-3.5" />{formatCount(data.listenerCount)}</span>}
                  {data.subCount > 0 && <span>{formatCount(data.subCount)} 订阅</span>}
                  {data.commentCount > 0 && <span className="flex items-center gap-1"><MessageSquareText className="h-3.5 w-3.5" />{formatCount(data.commentCount)}</span>}
                  {data.shareCount > 0 && <span className="flex items-center gap-1"><Share2 className="h-3.5 w-3.5" />{formatCount(data.shareCount)}</span>}
                  {data.createTime > 0 && <span>{formatDate(data.createTime)}</span>}
                </div>

                {/* 节目 → 所属电台（三级入口） */}
                {target.kind === 'program' && data.radio?.id && (
                  <button
                    type="button"
                    onClick={() => onOpenRadio?.(String(data.radio.id), String(data.radio.name || ''))}
                    disabled={!onOpenRadio}
                    className="mt-3 flex max-w-full items-center gap-2 rounded-md border border-white/[0.09] px-3 py-2 text-left text-xs transition enabled:hover:bg-white/[0.06] disabled:cursor-default"
                  >
                    {data.radio.coverUrl && <CachedImage src={data.radio.coverUrl} alt="" platform="netease" className="h-8 w-8 shrink-0 rounded" role="compact" />}
                    <span className="min-w-0">
                      <span className="block truncate text-white/80">{data.radio.name}</span>
                      {data.radio.programCount > 0 && <span className="block text-white/40">共 {data.radio.programCount} 集</span>}
                    </span>
                  </button>
                )}

                {onPlay && (
                  <button
                    type="button"
                    onClick={onPlay}
                    className="mt-4 flex h-9 items-center gap-2 rounded-full bg-white px-4 text-sm font-medium text-black transition hover:bg-white/90"
                  >
                    <Play className="h-4 w-4 fill-current" />播放
                  </button>
                )}
              </>
            )}
          </div>
        </div>

        {data?.desc && (
          <div className="overflow-y-auto p-6">
            <h4 className="mb-2 text-sm font-medium text-white/70">{target.kind === 'radio' ? '电台简介' : '节目简介'}</h4>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-white/55">{data.desc}</p>
          </div>
        )}

        {Array.isArray(data?.tags) && data.tags.length > 0 && (
          <div className="border-t border-white/[0.07] px-6 py-4">
            <div className="flex flex-wrap gap-2">
              {data.tags.map((tag: any) => (
                <span key={String(tag)} className="rounded-full border border-white/[0.11] px-2.5 py-1 text-xs text-white/55">{String(tag)}</span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
