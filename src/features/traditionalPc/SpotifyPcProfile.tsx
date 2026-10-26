// 传统模式「Spotify 客户端」个人资料页（官方 1:1）：
// 渐变大头（圆形头像 + 「个人资料」+ 用户名大字 + 「N 个公开歌单 · 关注 N 人」）
// → 齿轮操作行 → 「公开歌单」网格 → 「关注中」圆形艺人网格。
// 数据源：Web API /me/playlists（公开歌单，official「公开歌单」只列公开歌单）+
// /me/following?type=artist（关注中艺人）。左栏与官方一致（音乐库样式）。
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Music2, Settings } from 'lucide-react'
import { spotifyPcTheme } from './spotifyPcKit'

/** 官方 profile 快照（partner 桥 profile_snapshot 返回）的本地类型 */
interface ProfileSnapshot {
  profile?: { name?: string; imageUrl?: string; followersCount?: number; followingCount?: number; totalPublicPlaylistsCount?: number; publicPlaylists?: Array<{ uri: string; name: string; imageUrl?: string; ownerName?: string }> }
  followingArtists?: Array<{ uri: string; name: string; imageUrl?: string }>
}

export interface SpotifyPcProfileProps {
  tone: 'dark' | 'light'
  accent: string
  loggedIn: boolean
  username: string
  avatar?: string
  active: boolean
  onLoginClick?: () => void
  /** 歌单卡片点击（外壳内嵌详情） */
  onOpenPlaylist?: (playlistId: string) => void
  /** 艺人点击 */
  onOpenArtist?: (artistId: string) => void
  /** 齿轮 → 设置页 */
  onOpenSettings?: () => void
}

interface SimplePlaylist { id: string; name: string; cover: string; owner: string }
interface SimpleArtist { id: string; name: string; cover: string }

/** 官方客户端同款解析：spotify:image:X → i.scdn.co；spotify:mosaic:a:b:c:d →
 *  逐张 i.scdn.co（官方是前端 2×2 拼贴渲染，mosaic.scdn.co 服务已 404）；https 原样 */
function spotifyImagesOf(uri: string | undefined): string[] {
  const raw = String(uri ?? '')
  if (raw.startsWith('spotify:image:')) return [`https://i.scdn.co/image/${raw.slice('spotify:image:'.length)}`]
  if (raw.startsWith('spotify:mosaic:')) {
    return raw.slice('spotify:mosaic:'.length).split(':').filter(Boolean)
      .map(id => `https://i.scdn.co/image/${id}`)
  }
  return raw.startsWith('http') ? [raw] : []
}

export default function SpotifyPcProfile({ tone, accent, loggedIn, username, avatar, active, onLoginClick, onOpenPlaylist, onOpenArtist, onOpenSettings }: SpotifyPcProfileProps) {
  const theme = useMemo(() => spotifyPcTheme(tone), [tone])
  const [playlists, setPlaylists] = useState<SimplePlaylist[]>([])
  const [artists, setArtists] = useState<SimpleArtist[]>([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const b = (window as unknown as { electron?: { spotifyPartner?: { request: (op: string, params?: Record<string, unknown>) => Promise<unknown> } } }).electron?.spotifyPartner
      if (!b) return
      const res = (await b.request('profile_snapshot')) as { ok?: boolean; data?: ProfileSnapshot } | ProfileSnapshot | null
      // 桥返回 { ok, data } 包装：解包 data（与 SpotifyPcHome 同口径）
      const snap = (res as { data?: ProfileSnapshot })?.data ?? (res as ProfileSnapshot | null)
      if (!snap) return
      setPlaylists((snap.profile?.publicPlaylists ?? []).map(p => ({
        id: String(p.uri ?? '').replace('spotify:playlist:', ''),
        name: String(p.name ?? ''),
        cover: spotifyImagesOf(p.imageUrl).join('|'),
        owner: String(p.ownerName ?? ''),
      })).filter(p => p.id && p.name))
      setArtists((snap.followingArtists ?? []).map(a => ({
        id: String(a.uri ?? '').replace('spotify:artist:', ''),
        name: String(a.name ?? ''),
        cover: spotifyImagesOf(a.imageUrl).join('|'),
      })).filter(a => a.id && a.name))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { if (active && loggedIn) void load() }, [active, loggedIn, load])

  if (!loggedIn) {
    return (
      <div className="flex h-full items-center justify-center" style={{ background: theme.background }}>
        <button type="button" onClick={onLoginClick}
          className="rounded-full px-8 py-3 text-sm font-bold text-black transition hover:brightness-110"
          style={{ background: theme.accent }}>
          登录 Spotify
        </button>
      </div>
    )
  }

  return (
    <div className="relative flex h-full" style={{ background: theme.background }} data-active={active}>
      {/* 官方：渐变背景层横跨整窗（含左栏后面），左栏透明叠在其上 */}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-0"
        style={{ height: 340, background: 'linear-gradient(180deg, rgba(90,90,90,.65), rgba(18,18,18,0) 100%)' }} />
      {/* 左栏（官方个人资料页自带音乐库栏：浮动圆角面板） */}
      <aside className="relative z-10 m-2 flex min-h-0 flex-col overflow-hidden rounded-lg" style={{ width: 300, background: theme.content }}>
        <div className="flex items-center justify-between px-4 pb-2 pt-4">
          <h2 className="text-lg font-bold" style={{ color: theme.text }}>音乐库</h2>
        </div>
        <div className="px-4 pb-2">
          <div className="flex gap-2">
            <button type="button" className="rounded-full px-3 py-1 text-xs font-bold" style={{ background: theme.panel, color: theme.secondary }}>歌单</button>
            <button type="button" className="rounded-full px-3 py-1 text-xs font-bold" style={{ background: theme.panel, color: theme.secondary }}>艺人</button>
          </div>
        </div>
      </aside>
      {/* 右侧资料主区 */}
      <div className="relative z-10 min-h-0 flex-1 overflow-y-auto">
        {/* 官方灰渐变大头（渐变已由背景层全宽承担，这里只留透明占位） */}
        <div className="flex items-end gap-6 px-8 pb-6 pt-20">
          {avatar
            ? <img src={avatar} alt="" className="h-[192px] w-[192px] rounded-full object-cover shadow-2xl" />
            : <span className="flex h-[192px] w-[192px] items-center justify-center rounded-full shadow-2xl" style={{ background: theme.panel }}>
                <Music2 className="h-16 w-16" style={{ color: theme.secondary }} />
              </span>}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold" style={{ color: theme.text }}>个人资料</p>
            <h1 className="mt-2 mb-4 text-[clamp(2.5rem,6vw,5rem)] font-black leading-tight" style={{ color: theme.text }}>{username || 'Spotify 用户'}</h1>
            <p className="text-sm" style={{ color: theme.text }}>
              <span style={{ color: theme.secondary }}>{playlists.length} 个公开歌单 · 关注 {artists.length} 人</span>
            </p>
          </div>
        </div>
        {/* 齿轮操作行（官方：设置 + ...） */}
        <div className="flex items-center gap-5 px-8 py-5">
          <button type="button" onClick={onOpenSettings} aria-label="资料设置"
            className="rounded-full p-1 transition hover:scale-110" style={{ color: theme.secondary }}>
            <Settings className="h-6 w-6" />
          </button>
          <button type="button" aria-label="更多选项" onClick={() => {
            const menu = document.createElement('div')
            menu.textContent = '复制个人资料链接'
            menu.style.cssText = 'position:fixed;z-index:9999;padding:8px 12px;border-radius:4px;font-size:13px;font-weight:500;cursor:pointer;background:#282828;color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.5)'
            menu.onmouseenter = () => { menu.style.background = '#3e3e3e' }
            menu.onmouseleave = () => { menu.style.background = '#282828' }
            menu.onclick = () => {
              void navigator.clipboard?.writeText(`https://open.spotify.com/user/`).catch(() => undefined)
              menu.remove()
            }
            const close = (e: MouseEvent) => { if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('mousedown', close) } }
            const anchor = document.querySelector('[aria-label="更多选项"]')?.getBoundingClientRect()
            if (anchor) { menu.style.left = `${anchor.left}px`; menu.style.top = `${anchor.bottom + 6}px` }
            document.body.appendChild(menu)
            setTimeout(() => document.addEventListener('mousedown', close), 0)
          }}
            className="rounded-full p-1 transition hover:scale-110" style={{ color: theme.secondary }}>
            <svg viewBox="0 0 24 24" className="h-6 w-6" fill="currentColor"><circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" /></svg>
          </button>
        </div>
        {/* 公开歌单 */}
        {playlists.length > 0 && (
          <div className="px-8 pb-8">
            <h2 className="mb-4 text-2xl font-bold" style={{ color: theme.text }}>公开歌单</h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
              {playlists.map(p => (
                <button key={p.id} type="button" onClick={() => onOpenPlaylist?.(p.id)} className="group text-left">
                  <span className="relative mb-3 block aspect-square w-full overflow-hidden rounded-md shadow-lg" style={{ background: theme.panel }}>
                    {p.cover.includes('|')
                      ? <span className="grid h-full w-full grid-cols-2 grid-rows-2">{p.cover.split('|').map((src, i) => <img key={i} src={src} alt="" className="h-full w-full object-cover transition group-hover:brightness-110" />)}</span>
                      : p.cover
                        ? <img src={p.cover} alt="" className="h-full w-full object-cover transition group-hover:brightness-110" />
                        : <span className="flex h-full w-full items-center justify-center"><Music2 className="h-10 w-10" style={{ color: theme.secondary }} /></span>}
                    <span className="absolute bottom-2 right-2 flex h-12 w-12 translate-y-2 items-center justify-center rounded-full opacity-0 shadow-xl transition-all group-hover:translate-y-0 group-hover:opacity-100"
                      style={{ background: theme.accent }}>
                      <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5" fill="#000"><path d="M8 5v14l11-7z" /></svg>
                    </span>
                  </span>
                  <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{p.name}</span>
                  <span className="mt-1 block truncate text-xs" style={{ color: theme.secondary }}>创建者：{p.owner}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {/* 关注中 */}
        {artists.length > 0 && (
          <div className="px-8 pb-16">
            <h2 className="mb-4 text-2xl font-bold" style={{ color: theme.text }}>关注中</h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 2xl:grid-cols-7">
              {artists.map(a => (
                <button key={a.id} type="button" onClick={() => onOpenArtist?.(a.id)} className="group text-center">
                  <span className="mx-auto mb-3 block aspect-square w-full overflow-hidden rounded-full shadow-lg" style={{ background: theme.panel }}>
                    {a.cover
                      ? <img src={a.cover} alt="" className="h-full w-full object-cover transition group-hover:brightness-110" />
                      : <span className="flex h-full w-full items-center justify-center"><Music2 className="h-10 w-10" style={{ color: theme.secondary }} /></span>}
                  </span>
                  <span className="block truncate text-sm font-semibold" style={{ color: theme.text }}>{a.name}</span>
                  <span className="mt-1 block text-xs" style={{ color: theme.secondary }}>艺人</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {loading && <p className="px-8 py-10 text-center text-sm" style={{ color: theme.secondary }}>加载中…</p>}
      </div>
    </div>
  )
}
