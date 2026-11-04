/**
 * 移动端热评面板：底部弹层列出当前曲热门评论（网易云官方热评口径，与 PC CommentModal
 * 共用同一后端接口）。纯浏览（点赞/回复走 PC 端，移动端后续按需加）。
 */
import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getHotComments } from '../services/musicApi'
import type { Song } from '../services/musicApi'
import { Cover, IconClose, Spinner } from './ui'
import { useMobileBack } from './mobileBack'

interface CommentItem {
  user?: { nickname?: string; avatarUrl?: string }
  content?: string
  time?: number
  likedCount?: number
}

export default memo(function MobileCommentsSheet({ song, onClose }: { song: Song | null; onClose: () => void }) {
  // BACK：面板开着时关闭面板而不是退应用（MobileApp 分层返回期望各弹层自消费）
  useMobileBack(() => {
    if (song) { onClose(); return true }
    return false
  }, [song, onClose])
  const [comments, setComments] = useState<CommentItem[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!song) return
    const id = String(song.platform === 'qq' ? (song.mid || song.id) : song.id)
    setComments(null)
    setError('')
    getHotComments(id, 0, 30).then((data: any) => {
      const hot = (data?.hotComments || data?.comments || []) as CommentItem[]
      if (hot.length) setComments(hot)
      else setError('这首歌还没有热门评论')
    }).catch(() => setError('评论加载失败（当前仅支持网易云音源评论）'))
  }, [song])

  if (!song) return null
  return createPortal(
    <div className="wf-m-sheet-mask" onClick={onClose}>
      <div className="wf-m-actionsheet wf-m-comments" onClick={e => e.stopPropagation()}>
        <div className="wf-m-actionsheet-head">
          <Cover song={song} size={52} rounded={8} />
          <div className="wf-m-actionsheet-meta">
            <div className="wf-m-actionsheet-title">热门评论</div>
            <div className="wf-m-actionsheet-sub">{song.name}</div>
          </div>
          <button type="button" className="wf-m-iconbtn" onClick={onClose}><IconClose size={18} /></button>
        </div>
        <div className="wf-m-comments-list">
          {comments === null && !error && <Spinner label="加载评论…" />}
          {error && <p className="wf-m-hint">{error}</p>}
          {comments?.map((c, i) => (
            <div key={i} className="wf-m-comment">
              <img className="wf-m-comment-avatar" src={c.user?.avatarUrl || ''} alt="" loading="lazy" />
              <div className="wf-m-comment-body">
                <div className="wf-m-comment-head">
                  <span className="wf-m-comment-name">{c.user?.nickname || '匿名'}</span>
                  <span className="wf-m-comment-like">♡ {c.likedCount ? fmtCountNumber(c.likedCount) : ''}</span>
                </div>
                <p className="wf-m-comment-text">{c.content}</p>
                {c.time ? <span className="wf-m-comment-time">{new Date(c.time).toLocaleDateString()}</span> : null}
              </div>
            </div>
          ))}
        </div>
        <button type="button" className="wf-m-actionsheet-cancel" onClick={onClose}>关闭</button>
      </div>
    </div>,
    document.body,
  )
})

function fmtCountNumber(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`
  return String(n)
}
