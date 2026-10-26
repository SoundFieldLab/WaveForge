// 传统模式 Spotify：顶栏附加段的头像下拉菜单（官方：账户/个人资料/最近播放/升级 Premium/支持/设置/登出）。
// 全局顶栏保留（平台药丸/搜索/logo），这里只提供官方账户菜单形态。
import { useEffect, useRef, useState } from 'react'
import { Box, UserRound, Settings, LogOut, Music2, History, ArrowUpRight } from 'lucide-react'
import CachedImage from './CachedImage'

export interface SpotifyAccountMenuProps {
  loggedIn: boolean
  username: string
  avatar?: string
  onAccount: () => void
  onProfile: () => void
  onSettings: () => void
  onLogout: () => void
}

export default function SpotifyAccountMenu({ loggedIn, username, avatar, onAccount, onProfile, onSettings, onLogout }: SpotifyAccountMenuProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  const openExternal = (url: string) => {
    const shell = (window as unknown as { electron?: { shell?: { openExternal?: (u: string) => void } } }).electron?.shell
    if (shell?.openExternal) shell.openExternal(url)
    else window.open(url, '_blank')
  }

  const items: Array<{ key: string; label: string; icon: typeof Box; external?: boolean; action: () => void; show: boolean }> = [
    { key: 'account', label: '账户', icon: Box, external: true, action: onAccount, show: true },
    { key: 'profile', label: '个人资料', icon: UserRound, action: onProfile, show: loggedIn },
    { key: 'recents', label: '最近播放', icon: History, action: () => window.dispatchEvent(new CustomEvent('waveforge:spotify-recents')), show: loggedIn },
    { key: 'premium', label: '升级 Premium', icon: ArrowUpRight, external: true, action: () => openExternal('https://www.spotify.com/premium/'), show: true },
    { key: 'support', label: '支持', icon: ArrowUpRight, external: true, action: () => openExternal('https://support.spotify.com/'), show: true },
    { key: 'settings', label: '设置', icon: Settings, action: onSettings, show: true },
    { key: 'logout', label: '登出', icon: LogOut, action: onLogout, show: loggedIn },
  ]

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(v => !v)} aria-label="账户菜单"
        className="flex h-9 w-9 items-center justify-center overflow-hidden rounded-full transition hover:scale-105"
        style={{ background: 'rgba(255,255,255,.1)' }}>
        {avatar
          ? <CachedImage src={avatar} alt={username || '账户'} className="h-full w-full rounded-full object-cover" role="compact" priority="visible" />
          : loggedIn
            ? <span className="text-[11px] font-bold">{(username || 'S').slice(0, 1).toUpperCase()}</span>
            : <Music2 className="h-4 w-4 opacity-70" />}
      </button>
      {open && (
        <div
          className="absolute right-0 top-11 z-50 w-56 overflow-hidden rounded-lg border py-1 shadow-2xl"
          style={{ background: '#282828', borderColor: 'rgba(255,255,255,.1)', color: '#fff' }}
          role="menu"
        >
          {items.filter(item => item.show).map(item => (
            <button key={item.key} type="button" role="menuitem" onClick={() => { setOpen(false); item.action() }}
              className="flex w-full items-center justify-between px-4 py-2.5 text-left text-sm transition hover:bg-white/10">
              <span className="font-medium">{item.label}</span>
              <item.icon className={`h-4 w-4 opacity-70 ${item.external ? 'text-blue-400' : ''}`} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
