// 酷狗音乐 PC 客户端「音乐云盘 / 已购音乐 / 本地与下载」页（传统模式，浅色皮肤）。
//
// 云盘与已购都是酷狗独立通道（mcloudservice / openapi，均需概念版登录态），
// 未登录或上游为空时展示空态说明；本地与下载在 WaveForge 是永久不支持的能力
// （与 QQ/网易云侧同一产品决策），保留官方入口但如实说明，不做空壳。
//
// 面板拆成「数据自加载」的独立组件（KugouCloudPanel / KugouPurchasedPanel）：
// 传统模式传 pcActions 用，简约模式个人中心（KugouMinimalCenter）只传最小的
// 播放回调也能复用同一份数据链路与表格渲染，避免两处各写一遍云盘/已购映射。
import { memo, useCallback, useEffect, useState } from 'react'
import { Disc3, Download, Music2, RefreshCw } from 'lucide-react'
import type { Song } from '../../services/musicApi'
import {
  fetchKugouPurchasedAlbums,
  fetchKugouPurchasedSongs,
  fetchKugouUserCloud,
  hasKugouConceptCredential,
  kugouTrackToSong,
  type KugouCloudSong,
  type KugouPurchasedAlbum,
  type KugouPurchasedSong,
} from '../../services/kugouService'
import { PcCover, PcEmpty, PcListFooter, PcPrimaryButton, PcSongTable, pcTheme, type PcTheme } from './pcKit'
import type { KugouPcPageContext } from './KugouPcShared'

function formatFilesize(size?: number): string {
  if (!size || size <= 0) return ''
  if (size >= 1024 * 1024 * 1024) return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`
  return `${Math.max(1, Math.round(size / 1024))} KB`
}

/** 面板动作子集：比 PcActions 小，简约模式复用时不用凑齐整套回调。 */
export interface KugouPanelActions {
  onPlaySongs: (song: Song, songs: Song[], index?: number) => void
  /** 右键菜单；简约模式没有全局歌曲菜单，可不传（表格右键无响应） */
  onSongMenu?: (event: { clientX: number; clientY: number }, song: Song, songs: Song[]) => void
  /** 打开专辑详情（已购专辑卡片用） */
  onOpenAlbum?: (albumId: string) => void
  currentSongKey?: string
  isPlaying?: boolean
}

/** 网关透传的错误码（KUGOU_XXX_FAILED）对用户不可读，映射成如实但不刺眼的文案。 */
function sanitizePanelError(error: string): string {
  if (/KUGOU_[A-Z0-9_]*FAILED/i.test(error)) return '酷狗上游通道暂时没有返回数据，请稍后刷新重试'
  return error
}

function PanelHeader({ theme, title, hint, loading, onRefresh }: { theme: PcTheme; title: string; hint?: string; loading: boolean; onRefresh: () => void }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-3">
      <div>
        <h1 className={`text-[26px] font-semibold leading-tight ${theme.text}`}>{title}</h1>
        {hint ? <p className={`mt-1 text-[12px] ${theme.subtle}`}>{hint}</p> : null}
      </div>
      <button type="button" onClick={onRefresh} className={`inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] ${theme.solidBtn}`}>
        <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 刷新
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 音乐云盘
 * ------------------------------------------------------------------ */

/** 云盘面板本体：数据自加载，主题/动作由调用方注入（传统模式与简约模式共用）。 */
export function KugouCloudPanel({ theme, accent, actions, showHeader = true }: {
  theme: PcTheme
  accent: string
  actions: KugouPanelActions
  /** 传统模式页要官方同款大标题头；简约模式页签里不再叠一层标题 */
  showHeader?: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [songs, setSongs] = useState<KugouCloudSong[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const result = await fetchKugouUserCloud(1, 100)
      setSongs(result.songs)
      setError(result.error && result.songs.length === 0 ? result.error : '')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const playable = songs.filter(item => Boolean(item.track?.hash))
  const listSongs: Song[] = playable.map(item => kugouTrackToSong(item.track))

  return (
    <div data-kugou-panel="cloud">
      {showHeader && <PanelHeader theme={theme} title="音乐云盘" hint="酷狗概念版云盘（mcloudservice）；上传到云盘的音乐会显示在这里" loading={loading} onRefresh={() => void load()} />}
      {!showHeader && (
        <div className="mb-3 flex items-center justify-end">
          <button type="button" onClick={() => void load()} className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] ${theme.solidBtn}`}>
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> 刷新
          </button>
        </div>
      )}
      {error ? <p className={`mb-3 text-[12px] ${theme.faint}`}>{sanitizePanelError(error)}</p> : null}
      {loading && !playable.length ? (
        <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载…</div>
      ) : playable.length === 0 ? (
        <PcEmpty theme={theme} title="云盘为空" description="上游没有返回可播放的云盘曲目" />
      ) : (
        <>
          <PcPrimaryButton
            label="播放全部"
            accent={accent}
            disabled={!listSongs.length}
            onClick={() => { if (listSongs[0]) actions.onPlaySongs(listSongs[0], listSongs, 0) }}
            className="mb-3"
          />
          <PcSongTable
            songs={listSongs}
            skin="qq"
            theme={theme}
            accent={accent}
            columns={{ index: true, like: false, album: false, duration: true, size: true }}
            playingKey={actions.currentSongKey}
            isPlaying={actions.isPlaying}
            onPlay={(song, index) => actions.onPlaySongs(song, listSongs, index)}
            onMenu={actions.onSongMenu ? (event, song) => actions.onSongMenu?.(event, song, listSongs) : undefined}
          />
          <p className={`mt-3 text-[11px] ${theme.faint}`}>共 {playable.length} 首（大小 {formatFilesize(playable.reduce((sum, item) => sum + (item.filesize || 0), 0)) || '未知'}）</p>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * 已购音乐
 * ------------------------------------------------------------------ */

/** 已购面板本体：单曲 + 数字专辑，数据自加载（传统模式与简约模式共用）。 */
export function KugouPurchasedPanel({ theme, accent, actions, showHeader = true }: {
  theme: PcTheme
  accent: string
  actions: KugouPanelActions
  showHeader?: boolean
}) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [songs, setSongs] = useState<KugouPurchasedSong[]>([])
  const [albums, setAlbums] = useState<KugouPurchasedAlbum[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [songResult, albumResult] = await Promise.all([fetchKugouPurchasedSongs(1, 100), fetchKugouPurchasedAlbums(1, 50)])
      setSongs(songResult.songs)
      setAlbums(albumResult.albums)
      // 只有两个通道同时失败才当错误：任一有内容就照常渲染
      setError(songResult.error && albumResult.error ? (songResult.error || albumResult.error) : '')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const listSongs: Song[] = songs.map(item => kugouTrackToSong(item.track))

  return (
    <div data-kugou-panel="purchased">
      {showHeader && <PanelHeader theme={theme} title="已购音乐" hint="" loading={loading} onRefresh={() => void load()} />}
      {!showHeader && (
        <div className="mb-3 flex items-center justify-end">
          <button type="button" onClick={() => void load()} className={`inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] ${theme.solidBtn}`}>
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} /> 刷新
          </button>
        </div>
      )}
      {error ? <p className={`mb-3 text-[12px] ${theme.faint}`}>{sanitizePanelError(error)}</p> : null}
      {loading && songs.length === 0 && albums.length === 0 ? (
        <div className={`py-16 text-center text-[13px] ${theme.faint}`}>正在加载…</div>
      ) : (
        <>
          <section className="mb-8">
            <h2 className={`mb-3 flex items-center gap-2 text-[15px] font-semibold ${theme.text}`}>
              <Music2 className="h-4 w-4" style={{ color: accent }} /> 已购单曲
            </h2>
            {songs.length === 0 ? (
              <div className={`rounded-xl py-10 text-center text-[13px] ${theme.faint} ${theme.surface}`}>暂无已购单曲</div>
            ) : (
              <>
                <PcSongTable
                  songs={listSongs}
                  skin="qq"
                  theme={theme}
                  accent={accent}
                  columns={{ index: true, like: false, album: false, duration: true }}
                  playingKey={actions.currentSongKey}
                  isPlaying={actions.isPlaying}
                  onPlay={(song, index) => actions.onPlaySongs(song, listSongs, index)}
                  onMenu={actions.onSongMenu ? (event, song) => actions.onSongMenu?.(event, song, listSongs) : undefined}
                />
                <PcListFooter theme={theme} label={`共 ${songs.length} 首已购单曲`} />
              </>
            )}
          </section>

          <section>
            <h2 className={`mb-3 flex items-center gap-2 text-[15px] font-semibold ${theme.text}`}>
              <Disc3 className="h-4 w-4" style={{ color: accent }} /> 已购专辑
            </h2>
            {albums.length === 0 ? (
              <div className={`rounded-xl py-10 text-center text-[13px] ${theme.faint} ${theme.surface}`}>暂无已购专辑</div>
            ) : (
              <div className="grid grid-cols-2 gap-x-4 gap-y-5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {albums.map(album => (
                  <button key={album.albumId} type="button" onClick={() => actions.onOpenAlbum?.(album.albumId)} className="group min-w-0 text-left">
                    <PcCover src={album.coverUrl} alt={album.name} className="aspect-square w-full" rounded="rounded-[8px]" />
                    <span className={`mt-2 line-clamp-1 block text-[13px] ${theme.text}`}>{album.name}</span>
                    <span className={`mt-0.5 line-clamp-1 block text-[11px] ${theme.faint}`}>{album.singerName || '未知歌手'}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  )
}

/** 传统模式已购页：官方同款页头 + 面板。 */
export function KugouPcPurchased({ ctx }: { ctx: KugouPcPageContext }) {
  const loggedIn = hasKugouConceptCredential()
  if (!loggedIn) {
    return (
      <div data-kugou-pc-page="purchased">
        <PcEmpty theme={ctx.theme} title="登录后查看已购音乐" description="已购单曲/数字专辑需要酷狗概念版登录态" />
      </div>
    )
  }
  return (
    <div data-kugou-pc-page="purchased">
      <KugouPurchasedPanel
        theme={ctx.theme}
        accent={ctx.accent}
        actions={{
          onPlaySongs: ctx.actions.onPlaySongs,
          onSongMenu: (event, song, songs) => ctx.actions.onSongMenu({ show: true, x: event.clientX, y: event.clientY, song, songs }),
          onOpenAlbum: albumId => ctx.openAlbum?.(albumId),
          currentSongKey: ctx.actions.currentSongKey,
          isPlaying: ctx.actions.isPlaying,
        }}
      />
    </div>
  )
}
