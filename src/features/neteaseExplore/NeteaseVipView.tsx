import { useEffect, useState } from 'react'
import { Crown } from 'lucide-react'
import type { NeteaseVipPage } from './discover'
import { normalizeNeteaseSongs } from './api'
import type { NeteaseNativeResource } from './model'
import { neteaseResourceArtwork } from './model'
import { NeteaseNativeBlockView, type ResourceCallbacks } from './NeteaseResourceView'

// src/features/neteaseExplore/NeteaseVipView.tsx
// 站内 VIP 频道，结构对齐网易云 App（发现-音乐-VIP）：
//   左：VIP 推荐歌曲/专辑卡（App 由 delivery 下发，未下发时隐藏）
//   右：会员卡（等级图 + 轮播文案 + 续费按钮 + 权益图标）
//   下：「每天免费听VIP歌曲」歌曲列表（带「十万红心」等理由标签）
// 接口：vipnewcenter/app/resource/newaccountpage、level/myvip、
//       music-vip-configuration/config/query、vipnewcenter/app/viptab/recommend/song/list

interface NeteaseVipViewProps {
  data: NeteaseVipPage
  callbacks: ResourceCallbacks
}

export default function NeteaseVipView({ data, callbacks }: NeteaseVipViewProps) {
  const { card, level, privileges, songs } = data
  const [carouselIndex, setCarouselIndex] = useState(0)
  const carousels = card.carousels.length > 0 ? card.carousels : ['黑胶VIP享20项+专属特权']

  useEffect(() => {
    if (carousels.length <= 1) return
    const timer = setInterval(() => setCarouselIndex(index => (index + 1) % carousels.length), 3200)
    return () => clearInterval(timer)
  }, [carousels.length])

  const songList = normalizeNeteaseSongs(songs)
  const reasonById = new Map<string, string>(songs.map(song => [String(song?.id || ''), String(song?.reason || '')]))
  const progress = level.nextLevelGrowthPoint > 0
    ? Math.min(100, Math.round((level.growthPoint / level.nextLevelGrowthPoint) * 100))
    : Math.max(0, Math.min(100, card.percent))

  const block = songList.length > 0
    ? {
      id: 'netease-vip-songs',
      blockCode: 'NETEASE_VIP_SONGS',
      showType: 'MIXED_GRID',
      title: '每天免费听VIP歌曲',
      subtitle: '',
      layout: 'songs' as const,
      resources: songList.map((song, index) => ({
        id: String(song.id),
        type: 'song',
        title: song.name,
        subtitle: [song.artists.map(artist => artist.name).join('/'), reasonById.get(String(song.id)) || ''].filter(Boolean).join(' · '),
        coverUrl: song.album.picUrl,
        purePictureUrl: '',
        purePicture: false,
        purePicName: '',
        recommendationShowType: '',
        actionUrl: `orpheus://song/${song.id}`,
        action: { type: 'song' as const, song },
        alg: '',
        song,
        raw: {},
      } as NeteaseNativeResource)).filter(resource => neteaseResourceArtwork(resource) || resource.song),
      raw: {},
    }
    : null

  return (
    <div className="space-y-10">
      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <div className="relative overflow-hidden rounded-2xl border border-amber-200/15 bg-[linear-gradient(135deg,rgba(214,178,106,0.18),rgba(255,255,255,0.03))] p-6">
          <span className="flex items-center gap-2 text-xs text-amber-100/70"><Crown className="h-4 w-4" />黑胶会员</span>
          <h3 className="mt-3 text-2xl font-semibold text-white/92">{level.levelTitle || '网易云会员'}</h3>
          <p className="mt-2 text-sm text-amber-100/70">{carousels[carouselIndex % carousels.length]}</p>
          <div className="mt-5 h-1.5 w-full overflow-hidden rounded-full bg-white/12">
            <span className="block h-full rounded-full bg-amber-200/85" style={{ width: `${progress}%` }} />
          </div>
          <p className="mt-2 text-xs text-white/45">
            成长值 {level.growthPoint}{level.nextLevelGrowthPoint > 0 ? ` / ${level.nextLevelGrowthPoint}` : ''}
            {level.nextLevelTitle ? ` · 距 ${level.nextLevelTitle}` : ''}
          </p>
          <span className="absolute right-6 top-6 flex h-14 w-14 items-center justify-center">
            {card.levelImage
              ? <img src={card.levelImage} alt="" className="h-14 w-14 object-contain" />
              : <Crown className="h-7 w-7 text-amber-200/80" />}
          </span>
        </div>

        <div className="rounded-2xl border border-white/[0.09] bg-white/[0.035] p-6">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-lg font-semibold text-white/90">续费黑胶VIP</h3>
              <p className="mt-1 truncate text-xs text-white/50">{carousels[carouselIndex % carousels.length]}</p>
            </div>
            {card.buttonTitle && (
              <span className="flex h-9 shrink-0 items-center rounded-full bg-rose-300/85 px-4 text-sm font-medium text-black">{card.buttonTitle}</span>
            )}
          </div>
          {privileges.length > 0 && (
            <div className="mt-6 flex flex-wrap items-start gap-x-8 gap-y-4">
              {privileges.map(item => (
                <span key={item.title} className="flex w-16 flex-col items-center gap-2 text-center">
                  <span className="flex h-11 w-11 items-center justify-center rounded-full bg-rose-200/12">
                    {item.icon ? <img src={item.icon} alt="" loading="lazy" className="h-6 w-6 object-contain" /> : <Crown className="h-5 w-5 text-rose-200/80" />}
                  </span>
                  <span className="text-[11px] leading-4 text-white/55">{item.title}</span>
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {block
        ? <NeteaseNativeBlockView block={block} callbacks={callbacks} />
        : <p className="py-8 text-center text-sm text-white/38">暂无免费畅听歌曲</p>}
    </div>
  )
}
