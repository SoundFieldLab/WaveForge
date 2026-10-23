// 传统模式「Spotify 客户端」左栏复刻（对齐官方 Windows 客户端侧栏布局：
// 顶部搜索框 + 发现主页导航 + 我的资料库分组（喜欢的歌曲/歌单），底部账号行。
// 选中态：整行胶囊高亮 + 左缘品牌绿竖条。播放控件由本软件第三栏承担（用户要求保留）。
import { memo, useState } from 'react'
import { House, Library, Search, Heart } from 'lucide-react'
import { applePcTheme, type ApplePcTone } from './applePcKit'

export type SpotifyPcNavKey = 'home' | 'liked' | 'search'

export interface SpotifyPcSidebarProps {
  tone: ApplePcTone
  loggedIn: boolean
  username: string
  avatar?: string
  currentKey: SpotifyPcNavKey | ''
  onNavigate: (key: SpotifyPcNavKey) => void
  onSearch: (keyword: string) => void
  onAccountClick?: () => void
  width?: number
}

const ACCENT = '#1ed760'

function NavRow({ icon, label, active, theme, onClick }: {
  icon: React.ReactNode
  label: string
  active: boolean
  theme: ReturnType<typeof applePcTheme>
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] transition"
      style={{
        background: active ? theme.hover : 'transparent',
        color: active ? theme.text : theme.secondary,
        fontWeight: active ? 600 : 400,
      }}
    >
      {active && <span className="absolute left-0 top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-r" style={{ background: ACCENT }} />}
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

function SpotifyPcSidebar({ tone, loggedIn, username, avatar, currentKey, onNavigate, onSearch, onAccountClick, width = 290 }: SpotifyPcSidebarProps) {
  const theme = applePcTheme(tone)
  const [keyword, setKeyword] = useState('')
  const submit = () => { if (keyword.trim()) onSearch(keyword.trim()) }

  return (
    <aside
      className="flex h-full flex-col overflow-hidden border-r"
      style={{ width, background: theme.background, borderColor: theme.divider }}
    >
      {/* 顶部搜索框 */}
      <div className="px-4 pt-4">
        <div className="flex items-center gap-2 rounded-lg px-3 py-2" style={{ background: theme.fieldBg, border: `1px solid ${theme.fieldBorder}` }}>
          <Search className="h-4 w-4" style={{ color: theme.secondary }} />
          <input
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') submit() }}
            placeholder="搜索 Spotify 音乐"
            className="w-full bg-transparent text-[13px] outline-none"
            style={{ color: theme.text }}
          />
        </div>
      </div>

      {/* 导航 */}
      <nav className="mt-4 flex-1 space-y-1 px-3">
        <NavRow icon={<House className="h-[21px] w-[21px]" />} label="发现音乐" active={currentKey === 'home'} theme={theme} onClick={() => onNavigate('home')} />
        <NavRow icon={<Heart className="h-[21px] w-[21px]" />} label="喜欢的歌曲" active={currentKey === 'liked'} theme={theme} onClick={() => onNavigate('liked')} />
        <NavRow icon={<Search className="h-[21px] w-[21px]" />} label="搜索" active={currentKey === 'search'} theme={theme} onClick={() => { onNavigate('search'); onSearch('') }} />
      </nav>

      {/* 底部账号行 */}
      <div className="border-t px-4 py-3" style={{ borderColor: theme.divider }}>
        <button
          type="button"
          onClick={onAccountClick}
          className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition hover:opacity-80"
        >
          {avatar
            ? <img src={avatar} alt="" className="h-6 w-6 rounded-full object-cover" />
            : <span className="flex h-6 w-6 items-center justify-center rounded-full text-[10px] font-bold" style={{ background: ACCENT, color: '#000' }}>{(username || 'S')[0]}</span>}
          <span className="truncate text-[13px]" style={{ color: theme.text }}>{username || 'Spotify 用户'}</span>
        </button>
      </div>
    </aside>
  )
}

export default memo(SpotifyPcSidebar)
