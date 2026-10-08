/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 *
 * 简约模式-酷狗专属区块（平台隔离：只在 HomeView 的 `platform === 'kugou'` 分支渲染）。
 *
 * 为什么单开：简约模式（minimal）里网易/QQ/Apple/汽水各有自己的个人中心与最近播放数据源，
 * 酷狗此前只有歌单/登录卡片，点「个人中心」还会走 ProfileView 的不支持分支弹提示。
 * 这里以与其它平台同粒度补上酷狗：听书入口（复用 kugouLongaudio 的独立 store/Overlay，
 * 不另造播放器）+ 个人中心（资料 / 最近播放 / 我喜欢 / 收藏歌单）。
 *
 * 懒加载：本模块把 kugouService / kugouLongaudio 带进 bundle，HomeView 用 lazy+Suspense
 * 只在酷狗平台下加载（默认模式的 chunk 不为其它平台背这份体积）。
 */
import { motion } from 'framer-motion'
import { BookAudio, Disc3, Heart, History, ListMusic } from 'lucide-react'
import { lazy, Suspense, useCallback, useEffect } from 'react'
import type { Song } from '../../services/musicApi'
import type { KugouMinimalPlaylist, KugouMinimalTab } from './KugouMinimalCenter'

const LazyCenter = lazy(() => import('./KugouMinimalCenter'))
const LazyLongaudioOverlay = lazy(() => import('../kugouLongaudio/KugouLongaudioOverlay'))

export interface KugouMinimalSuiteProps {
  loggedIn: boolean
  username?: string
  avatar?: string
  userId?: string
  theme: 'light' | 'dark'
  /** 个人中心浮层当前页签（null = 关闭）；由 HomeView 持有，便于首页卡片/按钮直接指定页签 */
  openTab: KugouMinimalTab | null
  onOpenTab: (tab: KugouMinimalTab | null) => void
  /** 首页被播放页覆盖：portal 不受父层 CSS 影响，必须显式让位 */
  suspended?: boolean
  onLoginClick?: () => void
  onPlaySongs: (songs: Song[], index: number) => void
  onOpenPlaylist?: (playlist: KugouMinimalPlaylist) => void
  onAddToFavorites?: (song: Song) => void
  onRemoveFromFavorites?: (song: Song) => boolean | Promise<boolean>
}

interface EntryItem {
  key: string
  label: string
  hint: string
  icon: typeof BookAudio
  onSelect: () => void
}

/** 右栏酷狗区块：听书 / 我的听书 + 个人中心六页签入口（含 云盘/已购） */
export function KugouMinimalSuite({
  loggedIn,
  username,
  avatar,
  userId,
  theme,
  openTab,
  onOpenTab,
  suspended = false,
  onLoginClick,
  onPlaySongs,
  onOpenPlaylist,
  onAddToFavorites,
  onRemoveFromFavorites,
}: KugouMinimalSuiteProps) {
  const dark = theme === 'dark'

  // 听书 store 与 kugouService 同属懒加载模块：这里是唯一入口，故用动态 import 调 store
  const openLongaudio = useCallback((view: 'enter' | 'library') => {
    void import('../kugouLongaudio/store').then(({ kugouLongaudioStore }) => {
      if (view === 'library') kugouLongaudioStore.openLibrary()
      else kugouLongaudioStore.enter()
    })
  }, [])

  const entries: EntryItem[] = [
    {
      key: 'longaudio',
      label: '听书',
      hint: '有声小说 / 评书',
      icon: BookAudio,
      onSelect: () => onOpenTab('longaudio'),
    },
    {
      key: 'longaudio-library',
      label: '我的听书',
      hint: '最近收听（本机）',
      icon: History,
      onSelect: () => openLongaudio('library'),
    },
    {
      key: 'liked',
      label: '我喜欢',
      hint: '酷狗红心歌曲',
      icon: Heart,
      onSelect: () => onOpenTab('liked'),
    },
    {
      key: 'playlists',
      label: '收藏歌单',
      hint: '收藏的他人歌单',
      icon: ListMusic,
      onSelect: () => onOpenTab('playlists'),
    },
    {
      key: 'purchased',
      label: '已购',
      hint: '已购单曲与数字专辑',
      icon: Disc3,
      onSelect: () => onOpenTab('purchased'),
    },
  ]

  return (
    <>
      <div className="px-6 pt-5">
        <div className={`mb-3 flex items-center gap-2 text-sm font-semibold ${dark ? 'text-white/80' : 'text-black/75'}`}>
          <BookAudio className="h-4 w-4" style={{ color: '#FF7A00' }} /> 酷狗专区
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          {entries.map(entry => {
            const Icon = entry.icon
            return (
              <motion.button
                key={entry.key}
                type="button"
                whileHover={{ scale: 1.02, y: -1 }}
                whileTap={{ scale: 0.98 }}
                onClick={() => { if (!loggedIn && entry.key !== 'longaudio' && entry.key !== 'longaudio-library') { onLoginClick?.(); return } entry.onSelect() }}
                className="home-recent-card relative overflow-hidden rounded-2xl px-3 py-2.5 text-left"
                title={entry.hint}
              >
                <div
                  aria-hidden="true"
                  className="home-recent-card-glass absolute inset-0 pointer-events-none rounded-2xl"
                />
                <span className="relative z-10 flex items-center gap-2">
                  <Icon className="h-4 w-4 shrink-0" style={{ color: '#FF7A00' }} />
                  <span className={`truncate text-sm font-medium ${dark ? 'text-white' : 'text-black/85'}`}>{entry.label}</span>
                </span>
                <span className={`relative z-10 mt-1 block truncate text-[11px] ${dark ? 'text-white/45' : 'text-black/45'}`}>{entry.hint}</span>
              </motion.button>
            )
          })}
        </div>
        <p className={`mt-2 truncate text-[10px] ${dark ? 'text-white/35' : 'text-black/40'}`} title="听书走独立播放通道；最近播放与收藏在下面「个人中心」里查看">
          听书为独立播放通道；最近播放与收藏在「个人中心」。
        </p>
      </div>

      {/* 个人中心浮层：只在打开时挂载；听书独立播放器复用 kugouLongaudio 的 Overlay */}
      <Suspense fallback={null}>
        {openTab !== null && (
          <LazyCenter
            open
            tab={openTab}
            onTabChange={next => onOpenTab(next)}
            onClose={() => onOpenTab(null)}
            loggedIn={loggedIn}
            username={username}
            avatar={avatar}
            userId={userId}
            suspended={suspended}
            onLoginClick={onLoginClick}
            onPlaySongs={onPlaySongs}
            onOpenPlaylist={onOpenPlaylist}
            onAddToFavorites={onAddToFavorites}
            onRemoveFromFavorites={onRemoveFromFavorites}
          />
        )}
        <LazyLongaudioOverlay />
      </Suspense>
    </>
  )
}

/** 底部快捷入口（仅酷狗）：直接进入听书（有当前专辑进播放器，否则进「我的听书」） */
export function KugouLongaudioQuickButton() {
  const open = () => {
    void import('../kugouLongaudio/store').then(({ kugouLongaudioStore }) => kugouLongaudioStore.enter())
  }
  // 离开酷狗平台时收起听书界面：独立音频不归主播放器管，留着会「关掉还在响」
  useEffect(() => () => {
    void import('../kugouLongaudio/store').then(({ kugouLongaudioStore }) => {
      if (kugouLongaudioStore.getState().view !== 'closed') kugouLongaudioStore.exit()
    })
  }, [])
  return (
    <motion.button
      whileHover={{ scale: 1.1 }}
      whileTap={{ scale: 0.95 }}
      className="p-3 rounded-full bg-gradient-to-r from-orange-500 to-amber-600 hover:from-orange-600 hover:to-amber-700 text-white transition-all shadow-lg"
      onClick={open}
      title="听书"
      aria-label="打开听书"
    >
      <BookAudio className="w-5 h-5" />
    </motion.button>
  )
}

export default KugouMinimalSuite
