// 传统模式 Spotify：官方「新增内容」/「收听动态」面板（官方空态 1:1）。
// 官方空态：标题 + 说明 + 灰色占位头像行 + 底部「设置」按钮引导。
// Web OAuth 拿不到 whatsNewFeed（HTTP 400，桌面私有 schema），与官方同策略展示空态 + 引导开启。
import { useState } from 'react'
import { X, UserRound } from 'lucide-react'

export type SpotifyPanelKind = 'whats-new' | 'friend-activity' | null

export interface SpotifySidePanelProps {
  kind: SpotifyPanelKind
  onClose: () => void
  onOpenSettings: () => void
}

const WHATS_NEW_TITLE = '新增内容'
const WHATS_NEW_BODY = '有新消息时，我们会在此公布。关注你最爱的艺人和播客，随时了解他们的最新消息。'
const FRIEND_TITLE = '收听动态'
const FRIEND_BODY = '让 Spotify 上的朋友与粉丝查看你在收听的内容。'
const FRIEND_FOOTER = '前往“设置”>“收听动态和洞察”，然后开启“收听动态”。你可以随时关闭此功能。'

export default function SpotifySidePanel({ kind, onClose, onOpenSettings }: SpotifySidePanelProps) {
  if (!kind) return null
  const isWhatsNew = kind === 'whats-new'
  return (
    <div className="absolute inset-0 z-40 flex flex-col overflow-y-auto bg-[#121212] px-6 py-5" data-testid="spotify-side-panel">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-2xl font-bold text-white">{isWhatsNew ? WHATS_NEW_TITLE : FRIEND_TITLE}</h2>
        <button type="button" onClick={onClose} aria-label="关闭" className="rounded-full p-1.5 text-white/70 transition hover:bg-white/10 hover:text-white">
          <X className="h-5 w-5" />
        </button>
      </div>

      {isWhatsNew ? (
        <>
          <p className="mb-8 text-sm leading-relaxed text-white/60">{WHATS_NEW_BODY}</p>
          <div className="flex flex-1 flex-col items-center justify-center pb-16">
            <h3 className="mb-3 text-3xl font-black text-white">暂无新消息</h3>
            <p className="max-w-sm text-center text-sm text-white/60">有新消息时，我们会在此公布。关注你最爱的艺人和播客，随时了解他们的最新消息。</p>
          </div>
        </>
      ) : (
        <>
          <p className="text-sm leading-relaxed text-white/80">{FRIEND_BODY}</p>
          <div className="my-8 space-y-5">
            {[0, 1, 2].map(i => (
              <div key={i} className="flex items-center gap-4">
                <span className="relative flex h-11 w-11 items-center justify-center rounded-full bg-white/10">
                  <UserRound className="h-6 w-6 text-white/40" />
                  <span className="absolute -left-0.5 top-0 h-2 w-2 rounded-full bg-[#3d54e6]" />
                </span>
                <span className="min-w-0 flex-1 space-y-2">
                  <span className="block h-2.5 w-2/3 rounded bg-white/15" />
                  <span className="block h-2.5 w-1/2 rounded bg-white/10" />
                </span>
              </div>
            ))}
          </div>
          <div className="mt-auto pb-6">
            <p className="mb-4 text-sm leading-relaxed text-white/80">{FRIEND_FOOTER}</p>
            <button type="button" onClick={onOpenSettings}
              className="rounded-full bg-white px-8 py-2.5 text-sm font-bold text-black transition hover:scale-105">
              设置
            </button>
          </div>
        </>
      )}
    </div>
  )
}
