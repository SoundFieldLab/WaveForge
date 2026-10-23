import { useCallback, useEffect, useState } from 'react'

/**
 * 兑换码管理面板（开发者专用）。
 *
 * 入口：设置 → 开发者选项 → 连点"开发者模式"警告 8 次（见 SettingsPanel.handleDevGateTap）。
 *
 * 安全模型（与 desktop/developer-auth.cjs、resources/license-studio/issue.cjs 对应）：
 *  - 进入面板本身不授予任何签发能力；每次签发都要先通过 GitHub 开发者验证
 *    （仓库 roster 签名提交链 + 协作者强校验），验证在主进程/子进程侧完成。
 *  - 私钥永不出开发者机：面板只构造签发请求，实际签发由
 *    resources/license-studio/issue.cjs 在主进程子进程内完成，缺私钥直接被拒。
 *  - 面板不持久化 GitHub token（仅会话内存中转发给签发器）。
 */

type Tier = 'limited' | 'test' | 'universal'

interface Props {
  dark: boolean
  accent: string
  borderColor: string
  bgCard: string
  textPrimary: string
  textSecondary: string
  onClose: () => void
}

interface DevAuthState {
  ok: boolean
  signer?: string
  headSha?: string
  fromCache?: boolean
  reason?: string
}

const TIER_OPTIONS: Array<{ value: Tier; label: string; hint: string }> = [
  { value: 'limited', label: '限制级', hint: '解锁指定功能' },
  { value: 'test', label: '测试级', hint: '解锁测试版更新通道' },
  { value: 'universal', label: '完全开放级', hint: '解锁一切 + 测试通道' },
]

export function DeveloperLicenseManager({ dark, accent, borderColor, bgCard, textPrimary, textSecondary, onClose }: Props) {
  const [authState, setAuthState] = useState<DevAuthState | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [githubToken, setGithubToken] = useState('')
  const [deviceId, setDeviceId] = useState('')
  const [tier, setTier] = useState<Tier>('limited')
  const [feature, setFeature] = useState('')
  const [label, setLabel] = useState('')
  const [expiresDays, setExpiresDays] = useState('365')
  const [issueBusy, setIssueBusy] = useState(false)
  const [issuedCode, setIssuedCode] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const state = await window.electron?.developerAuth?.state()
      setAuthState(state && state.success ? { ok: Boolean(state.ok), signer: state.signer, headSha: state.headSha, fromCache: state.fromCache, reason: state.reason } : { ok: false, reason: state?.reason || '状态读取失败' })
    } catch (err) {
      setAuthState({ ok: false, reason: (err as Error).message })
    }
  }, [])

  useEffect(() => {
    refresh().catch(() => { /* 面板内部展示错误 */ })
    window.electron?.deviceLicense?.getState().then((state) => {
      if (state?.success && state.deviceId) setDeviceId(state.deviceId)
    }).catch(() => { /* 设备号读取失败时允许手填 */ })
  }, [refresh])

  const handleVerify = async () => {
    setAuthBusy(true)
    setError(null)
    try {
      const result = await window.electron?.developerAuth?.verify({ token: githubToken.trim() || undefined })
      if (result?.success && result.ok) {
        setAuthState({ ok: true, signer: result.signer, headSha: result.headSha, fromCache: false })
      } else {
        setAuthState({ ok: false, reason: result?.error || '验证未通过' })
        setError(result?.error || '开发者验证未通过')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setAuthBusy(false)
    }
  }

  const handleIssue = async () => {
    if (!deviceId.trim()) {
      setError('缺少设备识别码')
      return
    }
    if (tier === 'limited' && !feature.trim()) {
      setError('限制级兑换码必须填写功能标识（feature）')
      return
    }
    setIssueBusy(true)
    setError(null)
    setIssuedCode(null)
    try {
      const result = await window.electron?.licenseStudio?.issue({
        deviceId: deviceId.trim(),
        tier,
        feature: tier === 'limited' ? feature.trim() : undefined,
        label: label.trim() || undefined,
        expiresDays: Number(expiresDays) > 0 ? Number(expiresDays) : undefined,
        githubToken: githubToken.trim() || undefined,
      })
      if (result?.success && result.code) {
        setIssuedCode(result.code)
      } else {
        setError(result?.error || '签发被拒')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIssueBusy(false)
    }
  }

  const inputStyle = `w-full rounded-lg px-3 py-2 text-sm outline-none border ${borderColor} ${dark ? 'bg-white/5 text-white placeholder-white/30' : 'bg-black/5 text-black placeholder-black/40'}`

  return (
    <div className="mt-8">
      <div className="flex items-center justify-between mb-4">
        <h3 className={`text-lg font-semibold ${textPrimary}`}>兑换码管理</h3>
        <button onClick={onClose} className={`text-xs px-3 py-1.5 rounded-lg border ${borderColor} ${textSecondary} hover:opacity-80`}>关闭</button>
      </div>

      {/* 步骤 1：开发者验证 */}
      <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-4`}>
        <div className="flex items-center justify-between mb-2">
          <div className={`${textPrimary} font-medium text-sm`}>① 开发者身份验证</div>
          {authState && (
            <span className={`text-xs px-2 py-0.5 rounded-full ${authState.ok ? 'bg-green-500/15 text-green-500' : 'bg-red-500/15 text-red-400'}`}>
              {authState.ok ? '已验证' : '未验证'}
            </span>
          )}
        </div>
        {authState?.ok ? (
          <div className={`text-xs ${textSecondary}`}>
            签名者 <span style={{ color: accent }}>{authState.signer}</span>
            {authState.headSha ? ` · roster HEAD ${authState.headSha.slice(0, 10)}` : ''}
            {authState.fromCache ? '（缓存）' : ''}
          </div>
        ) : (
          <>
            <div className={`text-xs ${textSecondary} mb-2`}>
              验证基于 GitHub 仓库 <span style={{ color: accent }}>SoundFieldLab/WaveForge</span> 的开发者花名册签名提交链。
              {authState?.reason ? ` 上次结果：${authState.reason}` : ''}
            </div>
            <input
              value={githubToken}
              onChange={(event) => setGithubToken(event.target.value)}
              placeholder="GitHub token（需要 repo 权限；仅本次会话内存使用）"
              type="password"
              className={`${inputStyle} mb-2`}
            />
            <button
              onClick={handleVerify}
              disabled={authBusy}
              className="w-full rounded-lg px-3 py-2 text-sm text-white disabled:opacity-50"
              style={{ backgroundColor: accent }}
            >
              {authBusy ? '验证中…' : '开始验证'}
            </button>
          </>
        )}
      </div>

      {/* 步骤 2：签发 */}
      <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
        <div className={`${textPrimary} font-medium text-sm mb-2`}>② 签发兑换码</div>
        <div className={`text-xs ${textSecondary} mb-3`}>
          私钥仅存在于开发者机的 License Studio 数据目录，签发时经本地签发器完成；
          App 内不持有、也无法导出私钥。
        </div>
        <label className={`text-xs ${textSecondary} block mb-1`}>设备识别码</label>
        <input value={deviceId} onChange={(event) => setDeviceId(event.target.value)} placeholder="WF-XXXXXXXX-…" className={`${inputStyle} mb-3 font-mono`} />

        <label className={`text-xs ${textSecondary} block mb-1`}>兑换码等级</label>
        <div className="grid grid-cols-3 gap-2 mb-3">
          {TIER_OPTIONS.map((option) => (
            <button
              key={option.value}
              onClick={() => setTier(option.value)}
              className={`rounded-lg px-2 py-2 text-xs border transition-all ${tier === option.value ? 'border-transparent text-white' : `${borderColor} ${textSecondary}`}`}
              style={tier === option.value ? { backgroundColor: accent } : undefined}
            >
              <div className="font-medium">{option.label}</div>
              <div className="opacity-70 mt-0.5">{option.hint}</div>
            </button>
          ))}
        </div>

        {tier === 'limited' && (
          <>
            <label className={`text-xs ${textSecondary} block mb-1`}>功能标识（feature）</label>
            <input value={feature} onChange={(event) => setFeature(event.target.value)} placeholder="例如 supporter、dj.*" className={`${inputStyle} mb-3 font-mono`} />
          </>
        )}

        <div className="grid grid-cols-2 gap-2 mb-3">
          <div>
            <label className={`text-xs ${textSecondary} block mb-1`}>展示名（可选）</label>
            <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="默认按等级命名" className={inputStyle} />
          </div>
          <div>
            <label className={`text-xs ${textSecondary} block mb-1`}>有效天数（0 = 永久）</label>
            <input value={expiresDays} onChange={(event) => setExpiresDays(event.target.value)} inputMode="numeric" className={inputStyle} />
          </div>
        </div>

        <button
          onClick={handleIssue}
          disabled={issueBusy || !authState?.ok}
          className="w-full rounded-lg px-3 py-2 text-sm text-white disabled:opacity-50"
          style={{ backgroundColor: accent }}
        >
          {issueBusy ? '签发中…' : '签发兑换码'}
        </button>

        {error && <div className="mt-2 text-xs text-red-400">{error}</div>}

        {issuedCode && (
          <div className={`mt-3 p-3 rounded-lg border ${borderColor} ${dark ? 'bg-white/5' : 'bg-black/5'}`}>
            <div className={`text-xs ${textSecondary} mb-1`}>签发成功，把下面整串发给用户，在「设置 → 授权」兑换：</div>
            <div className="font-mono text-[11px] break-all select-text" style={{ color: accent }}>{issuedCode}</div>
          </div>
        )}
      </div>
    </div>
  )
}
