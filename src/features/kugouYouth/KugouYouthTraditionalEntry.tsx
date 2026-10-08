/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 *
 * 传统模式酷狗「刷歌」导航项 + 全屏竖滑页挂载点（3.E）。
 *
 * 为什么单独一个文件：传统模式的酷狗 PC 左栏（KugouPc*）由另一条工作线在写，
 * 这里只提供**可复用的入口组件**与挂载点，双方共用同一个 kugouYouthStore，
 * 谁先落地都不会冲突：通用左栏先接 `KugouYouthNavButton`，KugouPc 左栏做出来后
 * 直接把同一个按钮放进自己的导航列表即可（无需改本文件）。
 * 官方客户端左栏顺序：音乐 / 听书 / 刷歌 / 我的收藏 / 最近播放…，所以「刷歌」当功能位处理。
 */
import { Radio } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import { kugouYouthStore } from './store'
import KugouYouthFeedOverlay, { type KugouYouthFeedOverlayProps } from './KugouYouthFeedOverlay'

export interface KugouYouthNavButtonProps {
  /** 宿主左栏的样式类（传统模式通用左栏与酷狗 PC 左栏各自传自己的） */
  className?: string
  /** 当前高亮色的平台强调色 */
  accent?: string
  /** 宿主左栏的次级文字色类名 */
  mutedClassName?: string
}

/** 传统模式左栏「刷歌」导航项：点击直接打开全屏竖滑页（与 QQ 左栏 local:radio 同粒度） */
export function KugouYouthNavButton({ className, accent, mutedClassName }: KugouYouthNavButtonProps) {
  return (
    <button
      type="button"
      data-kugou-youth-nav="traditional"
      onClick={() => kugouYouthStore.open()}
      className={className || `flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm hover:bg-white/10 ${mutedClassName || ''}`}
      style={accent ? { color: accent } : undefined}
    >
      <Radio className="h-4 w-4" />刷歌
    </button>
  )
}

/** 传统模式下挂载的全屏刷歌页（固定覆盖层，播放走传统模式 origin） */
export function KugouYouthTraditionalOverlay(props: Omit<KugouYouthFeedOverlayProps, 'onPlaySongs'> & {
  onSongSelect: (song: Song, songs: Song[]) => void
}) {
  const { onSongSelect, ...rest } = props
  return <KugouYouthFeedOverlay {...rest} onPlaySongs={(song, songs) => onSongSelect(song, songs)} />
}
