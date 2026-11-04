/**
 * 移动端歌曲详情面板：封面大图 + 发行信息 + 音质/时长/流派等元数据
 * （对应 PC SongDetailModal 的核心信息，触屏底部弹层形态）。
 */
import { memo, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { getArtistDetail } from '../services/musicApi'
import type { Song } from '../services/musicApi'
import { platformLabel, type MusicPlatform } from '../services/platforms'
import { Cover, IconClose, songArtists } from './ui'
import { useMobileNav } from './nav'

export default memo(function MobileSongDetailSheet({ song, onClose }: { song: Song | null; onClose: () => void }) {
  const nav = useMobileNav()
  if (!song) return null
  const platform = (song.platform || 'netease') as MusicPlatform

  const rows: Array<[string, string]> = [
    ['平台', platformLabel(platform)],
    ['歌手', songArtists(song)],
    ['专辑', song.album?.name || '—'],
    ['时长', song.duration ? `${Math.floor(song.duration / 60000)}:${String(Math.floor(song.duration / 1000) % 60).padStart(2, '0')}` : '—'],
    ['歌曲 ID', String(song.platform === 'qq' ? (song.mid || song.id) : song.id)],
    ...(song.album?.id ? [['专辑 ID', String(song.album.id)] as [string, string]] : []),
    ...((song as { mv?: number | string }).mv ? [['MV', '有（长按歌曲可观看）'] as [string, string]] : []),
  ]

  return createPortal(
    <div className="wf-m-sheet-mask" onClick={onClose}>
      <div className="wf-m-actionsheet" onClick={e => e.stopPropagation()}>
        <div className="wf-m-actionsheet-head">
          <Cover song={song} size={120} rounded={12} />
          <div className="wf-m-actionsheet-meta">
            <div className="wf-m-actionsheet-title">{song.name}</div>
            <div className="wf-m-actionsheet-sub">{songArtists(song)}</div>
          </div>
          <button type="button" className="wf-m-iconbtn" onClick={onClose}><IconClose size={18} /></button>
        </div>
        <div className="wf-m-detail-rows">
          {rows.map(([k, v]) => (
            <div key={k} className="wf-m-detail-row">
              <span className="wf-m-detail-key">{k}</span>
              <span className="wf-m-detail-val">{v}</span>
            </div>
          ))}
        </div>
        <button type="button" className="wf-m-actionsheet-cancel" onClick={onClose}>关闭</button>
      </div>
    </div>,
    document.body,
  )
})
