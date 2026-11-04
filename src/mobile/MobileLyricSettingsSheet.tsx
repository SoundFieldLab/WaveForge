/**
 * 移动端歌词视图增强：翻译/罗马音/逐字/高光开关 + 字号档位（localStorage 持久化）。
 * 由 PlayerSheet 歌词视图左上角「歌词设置」按钮打开。
 * 逐字/高光与 PC QuickSettingsDialog 同键（wordByWordLyrics / lyricGlow），改动
 * 广播同款事件，桌面树（pc-touch）实时跟随。
 */
import { memo, useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconClose } from './ui'

export interface LyricViewSettings {
  showTranslation: boolean
  showRoman: boolean
  fontScale: number
  wordByWord: boolean
  lyricGlow: boolean
}

const KEY = 'waveforge:mobile-lyric-view'
const SCALES = [0.85, 1, 1.25, 1.5]

export function readLyricViewSettings(): LyricViewSettings {
  let wordByWord = true
  let lyricGlow = true
  try { wordByWord = localStorage.getItem('wordByWordLyrics') !== 'false' } catch { /* ignore */ }
  try { lyricGlow = localStorage.getItem('lyricGlow') !== 'false' } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(KEY)
    if (raw) {
      const p = JSON.parse(raw) as Partial<LyricViewSettings>
      return {
        showTranslation: p.showTranslation !== false,
        showRoman: p.showRoman === true,
        fontScale: SCALES.includes(p.fontScale as number) ? (p.fontScale as number) : 1,
        wordByWord,
        lyricGlow,
      }
    }
  } catch { /* ignore */ }
  return { showTranslation: true, showRoman: false, fontScale: 1, wordByWord, lyricGlow }
}

function persistLyricViewSettings(s: LyricViewSettings): void {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* ignore */ }
  // 逐字/高光写各自的全局键 + 事件（与 PC QuickSettingsDialog 同键同事件）
  try {
    localStorage.setItem('wordByWordLyrics', JSON.stringify(s.wordByWord))
    window.dispatchEvent(new Event('wordByWordLyricsChanged'))
    localStorage.setItem('lyricGlow', JSON.stringify(s.lyricGlow))
    window.dispatchEvent(new Event('lyricGlowChanged'))
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent('waveforge:mobile-lyric-view-changed', { detail: s }))
}

export default memo(function MobileLyricSettingsSheet({
  open, settings, onChange, onClose,
}: {
  open: boolean
  settings: LyricViewSettings
  onChange: (next: LyricViewSettings) => void
  onClose: () => void
}) {
  const patch = useCallback((p: Partial<LyricViewSettings>) => {
    const next = { ...settings, ...p }
    onChange(next)
    persistLyricViewSettings(next)
  }, [settings, onChange])

  if (!open) return null
  return createPortal(
    <div className="wf-m-sheet-mask" onClick={onClose}>
      <div className="wf-m-actionsheet" onClick={e => e.stopPropagation()}>
        <div className="wf-m-actionsheet-head">
          <div className="wf-m-actionsheet-meta">
            <div className="wf-m-actionsheet-title">歌词设置</div>
          </div>
          <button type="button" className="wf-m-iconbtn" onClick={onClose}><IconClose size={18} /></button>
        </div>
        <div className="wf-m-more-body">
          <div className="wf-m-more-group">
            <div className="wf-m-more-label">显示内容</div>
            <div className="wf-m-hotwords">
              <button type="button" className={`wf-m-chip ${settings.showTranslation ? 'is-on' : ''}`} onClick={() => patch({ showTranslation: !settings.showTranslation })}>
                翻译 {settings.showTranslation ? '开' : '关'}
              </button>
              <button type="button" className={`wf-m-chip ${settings.showRoman ? 'is-on' : ''}`} onClick={() => patch({ showRoman: !settings.showRoman })}>
                罗马音 {settings.showRoman ? '开' : '关'}
              </button>
              <button type="button" className={`wf-m-chip ${settings.wordByWord ? 'is-on' : ''}`} onClick={() => patch({ wordByWord: !settings.wordByWord })}>
                逐字 {settings.wordByWord ? '开' : '关'}
              </button>
              <button type="button" className={`wf-m-chip ${settings.lyricGlow ? 'is-on' : ''}`} onClick={() => patch({ lyricGlow: !settings.lyricGlow })}>
                高光 {settings.lyricGlow ? '开' : '关'}
              </button>
            </div>
          </div>
          <div className="wf-m-more-group">
            <div className="wf-m-more-label">字号</div>
            <div className="wf-m-hotwords">
              {SCALES.map(s => (
                <button key={s} type="button" className={`wf-m-chip ${settings.fontScale === s ? 'is-on' : ''}`} onClick={() => patch({ fontScale: s })}>
                  {s === 0.85 ? '小' : s === 1 ? '标准' : s === 1.25 ? '大' : '特大'}
                </button>
              ))}
            </div>
          </div>
        </div>
        <button type="button" className="wf-m-actionsheet-cancel" onClick={onClose}>完成</button>
      </div>
    </div>,
    document.body,
  )
})
