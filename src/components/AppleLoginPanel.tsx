/**
 * 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
 * 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
 */
import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, ChevronDown, KeyRound, Link2, Loader2, LogOut, Music, ShieldCheck, X } from 'lucide-react'
import { validateAppleLogin, clearAppleLogin, saveAppleLogin, getAppleAuthState, resolveAppleAccountName, resolveAppleAccountProfile, generateInitialsAvatar, type AppleUserInfo } from '../services/appleAuth'
import { ensureAppleWebDevToken } from '../services/appleMusicToken'
import { recordLogin, clearLoginExpiry } from '../services/loginExpiry'
import { useTvBack } from '../tv/tvCore'

const STOREFRONTS = [
  { code: 'cn', label: '中国大陆 (cn)' },
  { code: 'hk', label: '香港 (hk)' },
  { code: 'tw', label: '台湾 (tw)' },
  { code: 'us', label: '美国 (us)' },
  { code: 'jp', label: '日本 (jp)' },
  { code: 'kr', label: '韩国 (kr)' },
  { code: 'gb', label: '英国 (gb)' },
]

interface AppleLoginPanelProps {
  accentColor?: string
  onClose: () => void
  onLoginSuccess: (user: AppleUserInfo | null) => void
}

/**
 * Apple Music 登录：Developer Token + Media-User-Token。
 * 校验通过后拉取 storefront 与用户资料（头像/昵称）。
 */
export default function AppleLoginPanel({ accentColor = '#fa2d48', onClose, onLoginSuccess }: AppleLoginPanelProps) {
  // TV 遥控器 BACK：关闭 Apple 登录面板
  useTvBack(() => {
    onClose()
    return true
  }, [onClose])
  const [devToken, setDevToken] = useState(() => localStorage.getItem('appleDeveloperToken') || '')
  const [mediaToken, setMediaToken] = useState(() => localStorage.getItem('appleMediaUserToken') || '')
  const [storefront, setStorefront] = useState(() => localStorage.getItem('appleStorefront') || 'cn')
  const [loading, setLoading] = useState(false)
  const [autoLoading, setAutoLoading] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null)
  const [currentUser, setCurrentUser] = useState(() => getAppleAuthState())
  const [showGuide, setShowGuide] = useState(false)
  const mountedRef = useRef(true)
  const autoTimeoutRef = useRef<number | null>(null)
  // 商店下拉框（自定义样式，替代原生 select）
  const [storefrontOpen, setStorefrontOpen] = useState(false)
  const storefrontRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!storefrontOpen) return
    const onDown = (event: MouseEvent) => {
      if (storefrontRef.current && !storefrontRef.current.contains(event.target as Node)) setStorefrontOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [storefrontOpen])
  // Electron 桌面端支持网页一键登录（内置窗口登录 Apple ID 自动抓取凭据）
  const hasNativeLogin = Boolean(window.electron?.appleLogin)
  // 登录方式：网页一键登录（桌面端默认）/ 手动填写 Token（同 QQ 的手动 Cookie 选项）
  const [loginMode, setLoginMode] = useState<'auto' | 'manual'>(hasNativeLogin ? 'auto' : 'manual')

  useEffect(() => () => {
    mountedRef.current = false
    if (autoTimeoutRef.current !== null) window.clearTimeout(autoTimeoutRef.current)
    autoTimeoutRef.current = null
  }, [])

  type AccountInfo = Partial<AppleUserInfo>
  const completeLogin = async (dev: string, media: string, accountInfo?: AccountInfo) => {
    if (!dev || !media) {
      setStatus({ ok: false, message: '请先填写 Developer Token 与 Media-User-Token' })
      return
    }
    setLoading(true)
    setStatus(null)
    try {
      const result = await validateAppleLogin(dev, media, storefront)
      if (!mountedRef.current) return
      // 转发校验结果到后台控制台（便于用户直接复制）
      try {
        const bridge = (window as any).electron
        if (bridge && typeof bridge.log === 'function') {
          bridge.log(`[Apple登录] 校验结果：${result.ok ? '登录成功' : '登录失败'}（${result.error || result.user?.name || ''}）`)
        }
      } catch {
        // 忽略
      }
      if (result.ok && result.user) {
        // 界面提取的字段优先覆盖 validateAppleLogin 的结果（多源合并）
        const finalUser: AppleUserInfo = { ...result.user, ...(accountInfo || {}) }
        if (!finalUser.name) finalUser.name = result.user.name
        if (!finalUser.avatarUrl) finalUser.avatarUrl = result.user.avatarUrl
        // 兜底：显示名仍是占位"Apple Music 用户"但已有账单真名时，用真名 + 其 monogram 头像
        // （避免出现 "Apple Music 用户" → 首字母 "A" 的尴尬头像）
        if (finalUser.name === 'Apple Music 用户' && finalUser.realName) {
          finalUser.name = finalUser.realName
          finalUser.avatarUrl = generateInitialsAvatar(finalUser.realName)
        }
        // 若头像缺失，用当前显示名生成 monogram（账单真名优先）
        if (!finalUser.avatarUrl) {
          finalUser.avatarUrl = generateInitialsAvatar(finalUser.realName || finalUser.name || '?')
        }
        localStorage.setItem('appleDeveloperToken', dev)
        localStorage.setItem('appleMediaUserToken', media)
        // 持久化昵称/头像/storefront：不存则重启后判定为未登录，需要重新登录
        saveAppleLogin(finalUser)
        // 记录登录有效期：dev-token 是 JWT 有真实 exp，优先用真实值（media-token 会话用默认预估）
        let appleExpiresAt: number | undefined
        try {
          const parts = dev.split('.')
          if (parts.length === 3) {
            const payload = JSON.parse(decodeURIComponent(escape(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')))))
            if (payload && typeof payload.exp === 'number') appleExpiresAt = payload.exp * 1000
          }
        } catch { /* 解析失败用默认 */ }
        recordLogin('apple', appleExpiresAt)
        setCurrentUser({ loggedIn: true, name: finalUser.name, avatarUrl: finalUser.avatarUrl, email: finalUser.email, realName: finalUser.realName, billingAddress: finalUser.billingAddress, country: finalUser.country, paymentType: finalUser.paymentType, accountBalance: finalUser.accountBalance, birthday: finalUser.birthday, language: finalUser.language, twoFactor: finalUser.twoFactor, trustedDevices: finalUser.trustedDevices, passwordUpdated: finalUser.passwordUpdated, notificationEmail: finalUser.notificationEmail, signInWithApple: finalUser.signInWithApple, devices: finalUser.devices, icons: finalUser.icons, storefront: finalUser.storefront })
        setStatus({ ok: true, message: `登录成功：${finalUser.name}` })
        // 隐私知情选择已移至登录窗口内（主进程 askAppleAccountConsent 弹窗）。
        // 这里根据主进程返回的 consent 决定最终展示形态：
        // - consent === 'accept'：完整账户资料（昵称/头像/个人信息）已抓取
        // - consent === 'reject'：仅账单 Apple ID + 账单真实姓名 + monogram 头像
        onLoginSuccess(finalUser)
      } else {
        setStatus({ ok: false, message: result.error || '登录失败' })
      }
    } catch (error) {
      if (mountedRef.current) setStatus({ ok: false, message: error instanceof Error ? error.message : '登录失败' })
    } finally {
      if (mountedRef.current) setLoading(false)
    }
  }

  const handleLogin = async () => {
    await completeLogin(devToken.trim(), mediaToken.trim())
  }

  /** 网页一键登录：内置窗口登录 Apple ID 抓取账号令牌 + 从 Apple 网页获取可用开发者令牌 */
  const handleAutoLogin = async () => {
    if (autoLoading) return
    setAutoLoading(true)
    setStatus(null)
    // 兜底：登录窗口含用户交互（Apple 账户同意/拒绝弹窗、账户登录、2FA），
    // 等待可长达数分钟；仅当窗口真正卡死超过 6 分钟才强制退出并提示。
    const autoTimeoutId = window.setTimeout(() => {
      if (autoTimeoutRef.current !== autoTimeoutId) return
      autoTimeoutRef.current = null
      if (!mountedRef.current) return
      setStatus({ ok: false, message: '登录流程超时，请重试（可先手动获取开发者令牌）' })
      setAutoLoading(false)
    }, 6 * 60 * 1000)
    autoTimeoutRef.current = autoTimeoutId
    try {
      const result = await window.electron!.appleLogin()
      if (!mountedRef.current) return
      if (!result?.success) {
        setStatus({ ok: false, message: result?.error || '登录失败' })
        return
      }
      const media = (result.mediaUserToken || '').trim()
      if (!media) {
        setStatus({ ok: false, message: '未能获取账号令牌，请重试' })
        return
      }
      setMediaToken(media)
      // 名字/头像/邮箱：界面提取（account.apple.com 个人信息页 + web 播放器侧边栏 + 账户摘要）优先级最高
      const accountInfo: AccountInfo = {}
      try {
        const domName = (result as any).name
        const domAvatar = (result as any).avatar
        const domEmail = (result as any).email
        const domRealName = (result as any).realName
        const domBilling = (result as any).billingAddress
        const domCountry = (result as any).country
        const domPayment = (result as any).paymentType
        const domBalance = (result as any).accountBalance
        const domBirthday = (result as any).birthday
        const domLanguage = (result as any).language
        const domTwoFactor = (result as any).twoFactor
        const domTrustedDevices = (result as any).trustedDevices
        const domPasswordUpdated = (result as any).passwordUpdated
        const domNotificationEmail = (result as any).notificationEmail
        const domSignInWithApple = (result as any).signInWithApple
        const domDevices = (result as any).devices
        const domIcons = (result as any).icons
        // 昵称/头像（个人信息页）→ 显示名；其余字段只做资料数据，不当显示名
        if (domName) accountInfo.name = domName
        if (domAvatar) accountInfo.avatarUrl = domAvatar
        if (domEmail) accountInfo.email = domEmail
        if (domRealName) accountInfo.realName = domRealName
        if (domBilling) accountInfo.billingAddress = domBilling
        if (domCountry) accountInfo.country = domCountry
        if (domPayment) accountInfo.paymentType = domPayment
        if (domBalance) accountInfo.accountBalance = domBalance
        if (domBirthday) accountInfo.birthday = domBirthday
        if (domLanguage) accountInfo.language = domLanguage
        if (domTwoFactor) accountInfo.twoFactor = domTwoFactor
        if (domTrustedDevices) accountInfo.trustedDevices = domTrustedDevices
        if (domPasswordUpdated) accountInfo.passwordUpdated = domPasswordUpdated
        if (domNotificationEmail) accountInfo.notificationEmail = domNotificationEmail
        if (domSignInWithApple) accountInfo.signInWithApple = domSignInWithApple
        if (domDevices && Array.isArray(domDevices) && domDevices.length) accountInfo.devices = domDevices
        if (domIcons && typeof domIcons === 'object' && Object.keys(domIcons).length) accountInfo.icons = domIcons
      } catch {
        // 忽略
      }
      // 隐私知情选择在登录窗口内完成（主进程 askAppleAccountConsent）：
      // 用户拒绝时强制降级——仅保留账单 Apple ID/真实姓名，头像用账单名生成的 monogram，
      // 丢弃 account.apple.com 抓取的昵称/头像/个人信息/设备等。
      const consent = (result as any).consent
      if (consent === 'reject') {
        const realName = accountInfo.realName || ''
        accountInfo.name = realName || 'Apple Music 用户'
        accountInfo.avatarUrl = generateInitialsAvatar(realName || accountInfo.name || '?')
        accountInfo.birthday = undefined
        accountInfo.language = undefined
        accountInfo.twoFactor = undefined
        accountInfo.trustedDevices = undefined
        accountInfo.passwordUpdated = undefined
        accountInfo.notificationEmail = undefined
        accountInfo.signInWithApple = undefined
        accountInfo.devices = undefined
        accountInfo.icons = undefined
        console.log(`[Apple登录] 用户拒绝展示账户信息，使用账单姓名：${realName || 'Apple Music 用户'}`)
      }
      try {
        const cookies = (result as any).cookies
        const allCookies = (result as any).allCookies
        // buy.itunes 账号接口需要完整会话 cookie（过滤后的 itunes 子集会 401）
        if (allCookies && !accountInfo.name) {
          const name = await resolveAppleAccountName(allCookies)
          if (name) accountInfo.name = name
        }
        if (allCookies && (!accountInfo.name || !accountInfo.avatarUrl)) {
          const profile = await resolveAppleAccountProfile(allCookies)
          if (profile.name) accountInfo.name = profile.name
          if (profile.avatarUrl) accountInfo.avatarUrl = profile.avatarUrl
        }
      } catch {
        // 忽略
      }
      // 1) 首选：Apple 网页内置开发者令牌（免密钥，约 70 天有效，自动刷新）
      let dev = ''
      try {
        dev = await ensureAppleWebDevToken()
      } catch {
        // 降级到登录窗口内捕获的令牌
      }
      if (!dev) dev = (result.developerToken || '').trim()
      if (dev) setDevToken(dev)
      if (dev) {
        await completeLogin(dev, media, accountInfo)
      } else {
        setStatus({ ok: false, message: '已获取账号令牌，但开发者令牌获取失败（网络或 Apple 页面变更）；可稍后重试或手动获取' })
      }
    } catch (error) {
      if (mountedRef.current) setStatus({ ok: false, message: error instanceof Error ? error.message : '自动登录失败' })
    } finally {
      window.clearTimeout(autoTimeoutId)
      if (autoTimeoutRef.current === autoTimeoutId) autoTimeoutRef.current = null
      if (mountedRef.current) setAutoLoading(false)
    }
  }

  /** 手动模式：一键获取 Apple 网页开发者令牌（免费，无需开发者密钥） */
  const [tokenFetching, setTokenFetching] = useState(false)
  const handleFetchWebToken = async () => {
    if (tokenFetching) return
    setTokenFetching(true)
    setStatus(null)
    try {
      const token = await ensureAppleWebDevToken(true)
      if (!mountedRef.current) return
      setDevToken(token)
      setStatus({ ok: true, message: '已获取 Apple 网页开发者令牌（有效期约 70 天，到期自动刷新）' })
    } catch (error) {
      if (mountedRef.current) setStatus({ ok: false, message: error instanceof Error ? error.message : '获取开发者令牌失败' })
    } finally {
      if (mountedRef.current) setTokenFetching(false)
    }
  }

  const handleLogout = () => {
    clearAppleLogin()
    localStorage.removeItem('appleDeveloperToken')
    localStorage.removeItem('appleMediaUserToken')
    localStorage.removeItem('appleAccountFullEnabled')
    clearLoginExpiry('apple')
    setCurrentUser({ loggedIn: false, name: '', storefront })
    setStatus({ ok: true, message: '已退出登录' })
    onLoginSuccess(null)
  }

  const inputClass = 'w-full rounded-xl border border-white/12 bg-white/[0.05] px-3.5 py-2.5 text-sm text-white outline-none placeholder:text-white/30 focus:border-white/30'

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div data-tv-scope className="flex w-full max-w-3xl items-stretch justify-center gap-3" onClick={event => event.stopPropagation()}>
        {loginMode === 'manual' && showGuide && (
          <div className="hidden w-72 shrink-0 flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#12141c] shadow-2xl sm:flex">
            <div className="flex items-center justify-between px-5 pb-3 pt-5">
              <h3 className="text-sm font-semibold text-white">Token 获取指引</h3>
              <button
                type="button"
                onClick={() => setShowGuide(false)}
                className="flex h-7 w-7 items-center justify-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white"
                aria-label="收起指引"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-5 pb-5 text-xs leading-relaxed text-white/55">
              <p className="mb-2 font-medium text-white/75">Token 获取方式：</p>
              {hasNativeLogin && (
                <p className="mb-2 rounded-lg bg-emerald-400/10 px-3 py-2 text-emerald-200/85">
                  <b>推荐（桌面端）：</b>点击「网页一键登录」，在弹出窗口登录 Apple 账号，
                  登录后自动完成授权并同步开发者令牌。
                </p>
              )}
              <ol className="list-decimal space-y-1.5 pl-4">
                <li>
                  <b className="text-white/80">Developer Token</b>：点击上方「自动获取开发者令牌」即可免费获取
                  （从 Apple 网页提取，有效期约 70 天，到期自动刷新），无需任何开发者密钥。
                </li>
                <li>
                  <b className="text-white/80">Media-User-Token</b>：桌面端用「网页一键登录」自动完成；或在
                  <span className="text-white/70">music.apple.com</span> 登录后，从浏览器开发者工具 →
                  网络 → 任意 amp-api 请求的请求头中复制
                  <code className="mx-1 rounded bg-white/10 px-1 py-0.5">media-user-token</code> 的值。
                </li>
              </ol>
              <p className="mt-2 text-white/40">令牌仅保存在本机 localStorage，用于直接调用 Apple Music API。</p>
            </div>
          </div>
        )}
      <div
        className="w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-[#12141c] shadow-2xl"
        onClick={event => event.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 pb-4 pt-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl" style={{ background: `${accentColor}22` }}>
              <Music className="h-5 w-5" style={{ color: accentColor }} />
            </span>
            <div>
              <h2 className="text-base font-semibold text-white">Apple Music 登录</h2>
              <p className="text-xs text-white/45">使用 Apple 账号接入 WaveForge</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-6 pb-6">
          {currentUser.loggedIn && (
            <div className="flex items-center gap-3 rounded-2xl border border-emerald-400/25 bg-emerald-400/10 p-3.5">
              {currentUser.avatarUrl ? (
                <img src={currentUser.avatarUrl} alt={currentUser.name} className="h-10 w-10 rounded-full object-cover" />
              ) : (
                <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10">
                  <ShieldCheck className="h-5 w-5 text-emerald-300" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-white">{currentUser.name}</div>
                <div className="truncate text-xs text-white/45">
                  {currentUser.email ? <span className="block truncate">{currentUser.email}</span> : null}
                  Apple Music · {currentUser.storefront.toUpperCase()} 商店
                </div>
              </div>
              <button
                type="button"
                onClick={handleLogout}
                className="flex items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs text-white/65 transition hover:bg-white/10"
              >
                <LogOut className="h-3.5 w-3.5" /> 退出
              </button>
            </div>
          )}

          {hasNativeLogin && !currentUser.loggedIn && (
            <div className="flex rounded-xl border border-white/12 bg-white/[0.05] p-1">
              <button
                type="button"
                onClick={() => setLoginMode('auto')}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${loginMode === 'auto' ? 'text-white' : 'text-white/50 hover:text-white'}`}
                style={loginMode === 'auto' ? { background: `${accentColor}33` } : undefined}
              >
                网页一键登录
              </button>
              <button
                type="button"
                onClick={() => setLoginMode('manual')}
                className={`flex-1 rounded-lg px-3 py-2 text-sm font-medium transition ${loginMode === 'manual' ? 'text-white' : 'text-white/50 hover:text-white'}`}
                style={loginMode === 'manual' ? { background: `${accentColor}33` } : undefined}
              >
                手动填写 Token
              </button>
            </div>
          )}

          {loginMode === 'auto' && hasNativeLogin && !currentUser.loggedIn && (
            <div className="space-y-3">
              <button
                type="button"
                onClick={() => void handleAutoLogin()}
                disabled={autoLoading}
                className="flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold text-white transition-opacity disabled:opacity-60"
                style={{ background: accentColor }}
              >
                {autoLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
                {autoLoading ? '正在打开 Apple 登录窗口…' : '在弹出窗口登录 Apple ID'}
              </button>
              <p className="rounded-xl border border-white/10 bg-white/[0.04] px-3.5 py-2.5 text-xs leading-relaxed text-white/50">
                将打开 Apple Music 官方登录窗口，登录 Apple 账号后应用会自动完成授权，
                并同步可用的开发者令牌（无需开发者密钥）。完成后窗口自动关闭。
              </p>
            </div>
          )}

          {loginMode === 'manual' && (
            <>
          <button
            type="button"
            onClick={() => void handleFetchWebToken()}
            disabled={tokenFetching}
            className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/12 bg-white/[0.06] py-2.5 text-sm font-medium text-white transition hover:bg-white/10 disabled:opacity-60"
          >
            {tokenFetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" style={{ color: accentColor }} />}
            {tokenFetching ? '正在获取…' : '自动获取开发者令牌（免费，无需开发者密钥）'}
          </button>
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-white/60">
              <KeyRound className="h-3.5 w-3.5" /> Developer Token（Authorization: Bearer …）
            </label>
            <input
              type="password"
              value={devToken}
              onChange={event => setDevToken(event.target.value)}
              placeholder="eyJhbGciOiJFUzI1NiIsImtpZCI6…"
              className={inputClass}
              autoComplete="off"
            />
          </div>
          <div>
            <label className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-white/60">
              <ShieldCheck className="h-3.5 w-3.5" /> Media-User-Token（Apple Music 账号会话令牌）
            </label>
            <input
              type="password"
              value={mediaToken}
              onChange={event => setMediaToken(event.target.value)}
              placeholder="AwAAAB…"
              className={inputClass}
              autoComplete="off"
            />
          </div>
          <div ref={storefrontRef} className="relative">
            <label className="mb-1.5 block text-xs font-medium text-white/60">商店（Storefront）</label>
            <button
              type="button"
              onClick={() => setStorefrontOpen(value => !value)}
              className={`${inputClass} flex items-center justify-between`}
            >
              <span className="truncate">{STOREFRONTS.find(item => item.code === storefront)?.label || storefront}</span>
              <ChevronDown className={`h-4 w-4 shrink-0 text-white/40 transition-transform ${storefrontOpen ? 'rotate-180' : ''}`} />
            </button>
            {storefrontOpen && (
              <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-48 overflow-y-auto rounded-xl border border-white/12 bg-[#1a1d26] shadow-2xl">
                {STOREFRONTS.map(item => (
                  <button
                    key={item.code}
                    type="button"
                    onClick={() => {
                      setStorefront(item.code)
                      setStorefrontOpen(false)
                    }}
                    className={`flex w-full items-center justify-between px-3.5 py-2.5 text-left text-sm transition hover:bg-white/8 ${storefront === item.code ? 'text-white' : 'text-white/65'}`}
                  >
                    <span>{item.label}</span>
                    {storefront === item.code && <CheckCircle2 className="h-4 w-4" style={{ color: accentColor }} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={() => void handleLogin()}
            disabled={loading}
            className="flex w-full items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold text-white transition-opacity disabled:opacity-50"
            style={{ background: accentColor }}
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
            {loading ? '验证中…' : (currentUser.loggedIn ? '重新登录' : '登录 Apple Music')}
          </button>
            </>
          )}

          {status && (
            <div className={`flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-xs ${status.ok ? 'bg-emerald-400/10 text-emerald-200' : 'bg-amber-400/10 text-amber-200'}`}>
              {status.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <X className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              <span>{status.message}</span>
            </div>
          )}

          {loginMode === 'manual' && (
          <button
            type="button"
            onClick={() => setShowGuide(value => !value)}
            className="text-xs text-white/45 underline-offset-2 transition hover:text-white/70 hover:underline"
          >
            {showGuide ? '收起 Token 获取指引' : '如何获取 Token？'}
          </button>
          )}
        </div>
      </div>
      </div>
    </div>
  )
}
