// QQ 音乐 PC 客户端「本地和下载 / 已购音乐 / 试听列表」页（传统模式，深色皮肤）。
//
// 与官方客户端的对齐现状（2026-10-07 全量核查后如实落笔，不编数据）：
//   · 试听列表：官方「没有试听记录」空态逐字对齐（该账号此刻同样为空）；
//   · 已购音乐：购买记录通道未公开（QQMusic_Protocol.dll 全量模块无购买模块、skills 无端点），
//     页面按官方结构（数字专辑 / 单曲页签）呈现，数据通道接入前如实空态；
//   · 本地和下载：本软件无下载链路与本地扫描（既有产品决策，与酷狗侧同一口径），
//     按官方四页签（本地歌曲 / 下载歌曲 / 下载视频 / 正在下载）如实空态。
import { memo, useState } from 'react'
import { Download, ListMusic, ShoppingBag } from 'lucide-react'
import { PcEmpty, PcPrimaryButton, PcTabs, pcTheme } from './pcKit'
import type { PcActions, PcAccount } from './types'

export interface QQPcExtraPageProps {
  page: 'local' | 'purchased' | 'trial'
  chrome: { tone: 'light' | 'dark'; skin: 'qq'; accent: string }
  account: PcAccount
  actions: PcActions
}

/** 页头（官方三页同为「大标题 + 页签行」结构）。 */
function PageHead({ title, tabs, tab, onTab, theme, accent }: {
  title: string
  tabs: Array<{ key: string; label: string }>
  tab: string
  onTab: (key: string) => void
  theme: ReturnType<typeof pcTheme>
  accent: string
}) {
  return (
    <div className="mb-5">
      <h1 className={`text-[22px] font-semibold tracking-tight ${theme.text}`}>{title}</h1>
      <div className={`mt-3 border-b ${theme.divider}`}>
        <PcTabs items={tabs} value={tab} onChange={onTab} accent={accent} theme={theme} />
      </div>
    </div>
  )
}

function QQPcExtraPage({ page, chrome, account, actions }: QQPcExtraPageProps) {
  const theme = pcTheme(chrome.tone)
  const accent = chrome.accent
  const [tab, setTab] = useState('default')

  if (page === 'trial') {
    // 官方「试听列表」空态：唱片图标 + 「没有试听记录」+ 「去音乐馆逛逛」（逐字对齐）
    return (
      <div>
        <h1 className={`mb-6 text-[22px] font-semibold tracking-tight ${theme.text}`}>试听列表</h1>
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <span className={`flex h-16 w-16 items-center justify-center rounded-2xl border ${chrome.tone === 'dark' ? 'border-white/15 text-white/50' : 'border-black/10 text-slate-400'}`}>
            <ListMusic className="h-7 w-7" />
          </span>
          <p className={`mt-4 text-[14px] ${theme.subtle}`}>没有试听记录</p>
          <div className="mt-4">
            <PcPrimaryButton label="去音乐馆逛逛" accent={accent} onClick={() => actions.onNavigate?.({ kind: 'qq', page: 'hall' })} />
          </div>
        </div>
      </div>
    )
  }

  if (page === 'purchased') {
    const tabs = [
      { key: 'album', label: '数字专辑' },
      { key: 'single', label: '单曲' },
    ]
    return (
      <div>
        <PageHead title="已购音乐" tabs={tabs} tab={tab === 'default' ? 'album' : tab} onTab={setTab} theme={theme} accent={accent} />
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <span className={`flex h-16 w-16 items-center justify-center rounded-2xl border ${chrome.tone === 'dark' ? 'border-white/15 text-white/50' : 'border-black/10 text-slate-400'}`}>
            <ShoppingBag className="h-7 w-7" />
          </span>
          <p className={`mt-4 text-[14px] ${theme.subtle}`}>{tab === 'single' ? '暂无已购单曲' : '暂无已购数字专辑'}</p>
          <p className={`mt-1 text-[12px] ${theme.faint}`}>已购记录来自 QQ 音乐商城通道，本软件暂未接入</p>
        </div>
      </div>
    )
  }

  // local：本地和下载
  const tabs = [
    { key: 'local-song', label: '本地歌曲' },
    { key: 'downloaded-song', label: '下载歌曲' },
    { key: 'downloaded-video', label: '下载视频' },
    { key: 'downloading', label: '正在下载' },
  ]
  return (
    <div>
      <PageHead title="本地和下载" tabs={tabs} tab={tab === 'default' ? 'local-song' : tab} onTab={setTab} theme={theme} accent={accent} />
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <span className={`flex h-16 w-16 items-center justify-center rounded-2xl border ${chrome.tone === 'dark' ? 'border-white/15 text-white/50' : 'border-black/10 text-slate-400'}`}>
          <Download className="h-7 w-7" />
        </span>
        <p className={`mt-4 text-[14px] ${theme.subtle}`}>
          {tab === 'downloaded-video' ? '暂无下载视频' : tab === 'downloading' ? '没有正在下载的任务' : '暂无本地/下载歌曲'}
        </p>
        <p className={`mt-1 text-[12px] ${theme.faint}`}>WaveForge 不提供下载与本地文件扫描，这里不会有内容（与网易云/酷狗模式同一口径）</p>
      </div>
    </div>
  )
}

export default memo(QQPcExtraPage)
