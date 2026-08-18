/**
 * 首次平台登录风险提示（自包含）
 *
 * 监听 waveforge-auth-changed（六音乐平台登录成功）与 bilibili-auth-changed（看歌登录成功），
 * 在用户首次登录任意平台后弹出一次，提示第三方客户端登录可能违反平台用户协议；
 * 点击"我已了解"后写入本地标记，之后不再弹出。
 */
import { useEffect, useState } from 'react'
import { ShieldAlert, X } from 'lucide-react'

const NOTICE_FLAG = 'waveforge:platformLoginNoticeShown'

interface PlatformLoginNoticeProps {
  playerTheme?: 'light' | 'dark'
}

export default function PlatformLoginNotice({ playerTheme = 'dark' }: PlatformLoginNoticeProps) {
  const [show, setShow] = useState(false)

  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      if (localStorage.getItem(NOTICE_FLAG)) return
    } catch {
      return
    }
    const onAuthChanged = (event: Event) => {
      try {
        if (localStorage.getItem(NOTICE_FLAG)) return
      } catch {
        return
      }
      const detail = (event as CustomEvent).detail
      // 仅登录成功时提示：音乐平台事件带 userId；B 站事件 loggedIn === true；登出事件均不含
      if (detail && typeof detail === 'object' && 'userId' in detail) {
        setShow(true)
        return
      }
      if (detail?.loggedIn === true) {
        setShow(true)
      }
    }
    window.addEventListener('waveforge-auth-changed', onAuthChanged)
    window.addEventListener('bilibili-auth-changed', onAuthChanged)
    return () => {
      window.removeEventListener('waveforge-auth-changed', onAuthChanged)
      window.removeEventListener('bilibili-auth-changed', onAuthChanged)
    }
  }, [])

  const dismiss = () => setShow(false)

  const acknowledge = () => {
    try {
      localStorage.setItem(NOTICE_FLAG, '1')
    } catch {
      // ignore
    }
    setShow(false)
  }

  if (!show) return null

  const textPrimary = playerTheme === 'dark' ? 'text-white' : 'text-black'
  const textSecondary = playerTheme === 'dark' ? 'text-white/60' : 'text-black/60'
  const textTertiary = playerTheme === 'dark' ? 'text-white/40' : 'text-black/40'
  const cardClass = playerTheme === 'dark' ? 'bg-zinc-900 border-zinc-800' : 'bg-white border-gray-200'
  const borderClass = playerTheme === 'dark' ? 'border-zinc-800' : 'border-gray-200'

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0, 0, 0, 0.75)' }}
      onClick={dismiss}
    >
      <div
        className={`${cardClass} rounded-2xl border shadow-2xl max-w-lg w-full overflow-hidden flex flex-col`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 标题栏 */}
        <div className={`flex items-center justify-between px-6 py-4 border-b ${borderClass}`}>
          <h2 className={`text-lg font-bold ${textPrimary}`}>第三方客户端登录提示</h2>
          <button onClick={dismiss} className={`p-2 rounded-lg transition-colors hover:bg-white/10`} aria-label="关闭">
            <X className={`w-5 h-5 ${textSecondary}`} />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="px-6 py-5">
          <div className={`space-y-4 ${textSecondary} text-sm leading-relaxed`}>
            <div className="flex items-start gap-2">
              <ShieldAlert className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
              <p>您正在通过 WaveForge（第三方客户端）登录音乐平台账号。请知悉：</p>
            </div>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>本软件与各音乐平台不存在任何合作或授权关系，亦非各平台官方发布的客户端；</li>
              <li>通过 Cookie / Token 登录并调用其非官方接口，可能违反相关平台用户协议（如网易云音乐《服务条款》第 8.5 条、QQ音乐《服务许可协议》第 5.1.1 条、酷狗《用户服务协议》第 5.1.9 条、汽水音乐《用户服务协议》第 5.1 条、哔哩哔哩《用户协议》等）；</li>
              <li>可能导致账号风控、功能受限或账号封禁；</li>
              <li>相关账号风险与纠纷由您自行承担，本软件开发者不承担任何责任。</li>
            </ul>
            <div
              className={`rounded-lg p-3 text-xs ${textTertiary}`}
              style={{ backgroundColor: playerTheme === 'dark' ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }}
            >
              本提示仅在您首次登录时显示一次，详细条款请查阅"设置 → 关于 → 法律声明/用户协议"。
            </div>
          </div>
        </div>

        {/* 底部按钮 */}
        <div className={`flex items-center justify-end gap-3 px-6 py-4 border-t ${borderClass}`}>
          <button
            onClick={acknowledge}
            className={`px-5 py-2.5 rounded-xl ${playerTheme === 'dark' ? 'bg-white/10 hover:bg-white/15' : 'bg-black/5 hover:bg-black/10'} ${textPrimary} text-sm font-medium transition-colors`}
          >
            我已了解
          </button>
        </div>
      </div>
    </div>
  )
}
