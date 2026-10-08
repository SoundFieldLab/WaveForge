// 酷狗音乐 PC 客户端「音乐 → 频道」页。
//
// 频道目录来自 /v1/zone/index（IP 专区）——官方"频道"页签的落地列表，实测 48 个频道带图标；
// 概念版 /concept/channels（订阅频道）对该账号恒空，二者都为空时才显示空态。
// 频道内容页由小程序（miniapp.kugou.com，ip_id 数据源）渲染，官方客户端同样嵌小程序；
// 这里用同源的原生 IP 接口在页内复刻（主页/单曲/歌单/视频），不再跳系统浏览器。
import { memo, useEffect, useState } from 'react'
import { Radio } from 'lucide-react'
import type { ExplorePayload } from '../../services/exploreApi'
import { PcCover, PcEmpty } from './pcKit'
import { kugouCount, type KugouPcPageContext } from './KugouPcShared'
import KugouPcChannelDetail from './KugouPcChannelDetail'

export interface KugouPcChannelsProps {
  ctx: KugouPcPageContext
  payload: ExplorePayload | null
  /** 频道名 → 传统模式搜索页 */
  onSearch?: (keyword: string) => void
  onRetry?: () => void
}

function KugouPcChannels({ ctx, payload, onSearch, onRetry }: KugouPcChannelsProps) {
  const theme = ctx.theme
  const accent = ctx.accent
  const channels = payload?.kugou?.channels || []
  // 频道目录（IP 专区 48 个）：独立拉取，公开数据源、无需登录
  const [zones, setZones] = useState<Array<{ id: string; name: string; icon: string; summary: string; ipId: string; link: string }>>([])
  // 选中的频道（IP 专区）：进入应用内频道详情页（对齐官方：主页/单曲/歌单/视频）
  const [openedChannel, setOpenedChannel] = useState('')
  // 电台（官方「频道」页签的真实内容）：14 个分类 × 每类 20~70 个电台（含当前播放曲）
  const [radioClasses, setRadioClasses] = useState<Array<{ classid: string; name: string; stations: Array<{ fmid: string; name: string; coverUrl: string; fmtype: number; currentSong: { hash: string; audioId?: number; albumId?: string; name: string } | null }> }>>([])
  const [radioClassId, setRadioClassId] = useState('')
  const [radioPlaying, setRadioPlaying] = useState('')
  useEffect(() => {
    let cancelled = false
    void import('../../services/kugouService')
      .then(m => m.fetchKugouChannelZones())
      .then(list => { if (!cancelled) setZones(list) })
      .catch(() => undefined)
    if (ctx.active) {
      void import('../../services/kugouService')
        .then(m => m.fetchKugouRadioClasses())
        .then(list => {
          if (cancelled || !list.length) return
          setRadioClasses(list)
          setRadioClassId(current => current || list[0].classid)
        })
        .catch(() => undefined)
    }
    return () => { cancelled = true }
  }, [ctx.active])

  // 点击电台：拉电台曲单并开播（offset=-1 表示从当前流开始）
  const playRadio = async (station: { fmid: string; fmtype: number; name: string }) => {
    if (radioPlaying) return
    setRadioPlaying(station.fmid)
    try {
      const svc = await import('../../services/kugouService')
      const tracks = await svc.fetchKugouRadioSongs(station.fmid, station.fmtype, 20)
      if (tracks.length) {
        const songs = tracks.map(svc.kugouTrackToSong)
        ctx.actions.onPlaySongs(songs[0], songs, 0)
      }
    } finally {
      setRadioPlaying('')
    }
  }

  if (openedChannel) {
    return (
      <KugouPcChannelDetail
        ctx={ctx}
        ipId={openedChannel}
        onBack={() => setOpenedChannel('')}
        onOpenChannel={next => setOpenedChannel(next)}
      />
    )
  }

  if (channels.length === 0 && zones.length === 0) {
    return (
      <div data-kugou-pc-page="channels">
        <PcEmpty
          theme={theme}
          title="当前账号还没有可显示的频道"
          description={payload?.kugou?.channelError
            ? `上游返回：${payload.kugou.channelError}（概念版频道需在手机端订阅后才会出现）`
            : '酷狗概念版频道需要账号在手机端订阅后才会出现；订阅后回到本页重新加载即可。'}
          action={onRetry ? (
            <button type="button" onClick={onRetry} className="rounded-full px-4 py-2 text-[12px] font-medium text-white" style={{ background: accent }}>
              重新加载
            </button>
          ) : undefined}
        />
      </div>
    )
  }

  return (
    <div className="pb-8" data-kugou-pc-page="channels">
      {/* 电台（官方「频道」页签的真实内容）：分类页签 + 电台卡（封面 + 电台名 + 当前播放曲） */}
      {radioClasses.length > 0 ? (
        <section className="mb-7">
          <div className="mb-3 flex items-center gap-2">
            <Radio className="h-4 w-4" style={{ color: accent }} />
            <h2 className={`text-[17px] font-semibold ${theme.text}`}>电台</h2>
            <span className={`text-[11px] ${theme.faint}`}>共 {radioClasses.length} 个分类 · 点击电台直接开播</span>
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            {radioClasses.map(cls => (
              <button
                key={cls.classid}
                type="button"
                onClick={() => setRadioClassId(cls.classid)}
                className={`rounded-lg px-3.5 py-1.5 text-[13px] transition ${radioClassId === cls.classid ? 'font-medium text-white' : `${theme.text} hover:bg-white/10`}`}
                style={radioClassId === cls.classid ? { background: accent } : { background: theme.tone === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }}
              >
                {cls.name}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
            {(radioClasses.find(cls => cls.classid === radioClassId) || radioClasses[0]).stations.map(station => (
              <button
                key={station.fmid}
                type="button"
                onClick={() => void playRadio(station)}
                disabled={radioPlaying === station.fmid}
                className="group min-w-0 text-left disabled:opacity-60"
                title={`播放电台：${station.name}`}
              >
                <PcCover src={station.coverUrl} alt={station.name} className="aspect-square w-full transition group-hover:-translate-y-0.5" rounded="rounded-lg" />
                <p className={`mt-2 truncate text-[13px] ${theme.text}`}>{station.name}</p>
                <p className={`mt-0.5 line-clamp-1 text-[11px] ${theme.faint}`}>
                  {radioPlaying === station.fmid ? '正在开播…' : (station.currentSong?.name || '电台直播中')}
                </p>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {/* 频道目录（官方"频道"页签的落地列表）：48 个 IP 专区，图标+名称；点击进页内频道详情 */}
      {zones.length > 0 ? (
        <section className="mb-7">
          <div className="mb-3 flex items-center gap-2">
            <Radio className="h-4 w-4" style={{ color: accent }} />
            <h2 className={`text-[17px] font-semibold ${theme.text}`}>频道目录</h2>
            <span className={`text-[11px] ${theme.faint}`}>共 {zones.length} 个 · 点击进入频道（主页/单曲/歌单/视频）</span>
          </div>
          <div className="grid grid-cols-3 gap-x-4 gap-y-5 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
            {zones.map(zone => (
              <button
                key={zone.id}
                type="button"
                onClick={() => setOpenedChannel(zone.ipId || zone.id)}
                className="group flex min-w-0 flex-col items-center gap-2"
                title={zone.summary || `打开频道：${zone.name}`}
              >
                <PcCover src={zone.icon} alt={zone.name} className="h-[92px] w-[92px] transition group-hover:-translate-y-0.5" rounded="rounded-full" />
                <span className={`max-w-full truncate text-[12px] ${theme.text}`}>{zone.name}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {channels.length > 0 ? (
        <div className="mb-3 flex items-center gap-2">
          <h2 className={`text-[17px] font-semibold ${theme.text}`}>我订阅的频道</h2>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {channels.map((channel, index) => (
          <button
            key={`${channel.id}:${index}`}
            type="button"
            onClick={() => onSearch?.(channel.name)}
            className="group relative h-[132px] min-w-0 overflow-hidden rounded-xl text-left transition hover:-translate-y-0.5"
            title={channel.description || channel.name}
          >
            <PcCover src={channel.coverUrl} alt={channel.name} className="absolute inset-0 h-full w-full" rounded="rounded-xl" />
            <span className="absolute inset-0" style={{ background: 'linear-gradient(0deg, rgba(6,8,13,0.92) 0%, rgba(6,8,13,0.14) 70%)' }} />
            <span className="relative flex h-full flex-col p-3">
              <span className="text-[11px] text-white/55">{channel.group || '频道'}</span>
              <span className="mt-auto block">
                <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-white">{channel.name}</span>
                {channel.description ? <span className="mt-1 line-clamp-1 block text-[11px] text-white/50">{channel.description}</span> : null}
                {kugouCount(channel.playCount) ? (
                  <span className="mt-1 flex items-center gap-1 text-[11px] text-white/50">
                    <Radio className="h-3 w-3" /> {kugouCount(channel.playCount)}
                  </span>
                ) : null}
              </span>
            </span>
          </button>
        ))}
      </div>
      <p className={`mt-4 text-[11px] ${theme.faint}`}>
        频道内容与官方客户端同源（IP 专区接口），页内直接展开：主页（子频道）/ 单曲 / 歌单 / 视频。
      </p>
    </div>
  )
}

export default memo(KugouPcChannels)
