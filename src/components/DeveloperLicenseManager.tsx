import { useCallback, useEffect, useState } from 'react'

/**
 * WaveForge 授权体系总览（给后续维护者/AI 的导航）：
 *
 * 【识别码】desktop/device-fingerprint.cjs —— 硬件指纹（主板/BIOS/系统盘/主板型号
 *   加权哈希）派生确定性 DeviceId，注册表+文件双快照，容忍权重 ≤3 的硬件漂移，
 *   重装/清注册表不换 ID。
 * 【兑换码】desktop/device-license.cjs —— Ed25519 离线码 WF1.<payload>.<sig>，
 *   payload 含 deviceHash + tier（limited/test/universal）+ feature + 有效期；
 *   verifyCode 验签绑设备，hasFeature 分级判定，redeem/reset 落 userData。
 * 【签发】resources/license-studio/issue.cjs（App 内经 IPC license-studio:issue）
 *   或 scripts/license-keys.cjs issue（CLI）—— 私钥只在开发者机
 *   %APPDATA%\WaveForge License Studio\，签发必须先过 GitHub 开发者验证门
 *   （developers/roster.json 签名提交链 + 协作者强校验）。
 * 【密钥】scripts/license-keys.cjs —— init/check/rotate/export/issue/sign-manifest。
 * 【文档】docs/license-keys.md 与 docs/license-system.md。
 *
 * 本组件是以上体系在 App 内的唯一管理入口：设置 → 开发者模式 → 连点警告 8 次。
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
  { value: 'test', label: '测试级', hint: '解锁测试版通道' },
  { value: 'universal', label: '完全开放级', hint: '解锁一切' },
]

export function DeveloperLicenseManager({ dark, accent, borderColor, bgCard, textPrimary, textSecondary, onClose }: Props) {
  const [authState, setAuthState] = useState<DevAuthState | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [githubToken, setGithubToken] = useState('')
  const [tokenVisible, setTokenVisible] = useState(false)
  const [rememberToken, setRememberToken] = useState(() => {
    try { return localStorage.getItem('waveforge:dev-gh-token') ? true : false } catch { return false }
  })
  const [deviceId, setDeviceId] = useState('')
  const [tier, setTier] = useState<Tier>('limited')
  const [feature, setFeature] = useState('')
  const [label, setLabel] = useState('')
  const [expiresDays, setExpiresDays] = useState('365')
  const [note, setNote] = useState('')
  const [issueBusy, setIssueBusy] = useState(false)
  const [issuedCode, setIssuedCode] = useState<string | null>(null)
  const [issuedMeta, setIssuedMeta] = useState<{ tier?: string; feature?: string; issuedBy?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [advancedOpen, setAdvancedOpen] = useState(false)

  // 会话内恢复记住的 token（localStorage；仅开发者机本地）
  useEffect(() => {
    try {
      const saved = localStorage.getItem('waveforge:dev-gh-token')
      if (saved) {
        setGithubToken(saved)
        setRememberToken(true)
      }
    } catch { /* ignore */ }
  }, [])

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

  const persistToken = (value: string) => {
    setGithubToken(value)
    try {
      if (rememberToken && value.trim()) localStorage.setItem('waveforge:dev-gh-token', value.trim())
      else localStorage.removeItem('waveforge:dev-gh-token')
    } catch { /* ignore */ }
  }

  const toggleRemember = (checked: boolean) => {
    setRememberToken(checked)
    try {
      if (checked && githubToken.trim()) localStorage.setItem('waveforge:dev-gh-token', githubToken.trim())
      else localStorage.removeItem('waveforge:dev-gh-token')
    } catch { /* ignore */ }
  }

  /** 一键创建 GitHub token：打开预填好 scope 的创建页并复制说明。 */
  const openTokenCreator = () => {
    try {
      window.open('https://github.com/settings/personal-access-tokens/new?fine_grained_token_name=WaveForge%20License%20Studio', '_blank', 'noopener')
    } catch { /* 非 Electron 环境 */ }
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '已打开 GitHub token 创建页；勾选 repo 权限后生成，粘贴回此处', type: 'info' } }))
  }

  const handleVerify = async () => {
    setAuthBusy(true)
    setError(null)
    try {
      const result = await window.electron?.developerAuth?.verify({ token: githubToken.trim() || undefined })
      if (result?.success && result.ok) {
        setAuthState({ ok: true, signer: result.signer, headSha: result.headSha, fromCache: false })
        window.dispatchEvent(new CustomEvent('showToast', { detail: { message: `开发者验证通过：${result.signer}`, type: 'success' } }))
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
    if (!deviceId.trim()) { setError('缺少设备识别码'); return }
    if (tier === 'limited' && !feature.trim()) { setError('限制级兑换码必须填写功能标识（feature）'); return }
    setIssueBusy(true)
    setError(null)
    setIssuedCode(null)
    setIssuedMeta(null)
    try {
      const result = await window.electron?.licenseStudio?.issue({
        deviceId: deviceId.trim(),
        tier,
        feature: tier === 'limited' ? feature.trim() : undefined,
        label: label.trim() || undefined,
        expiresDays: Number(expiresDays) > 0 ? Number(expiresDays) : undefined,
        note: note.trim() || undefined,
        githubToken: githubToken.trim() || undefined,
      })
      if (result?.success && result.code) {
        setIssuedCode(result.code)
        setIssuedMeta({ tier: result.tier, feature: result.feature, issuedBy: result.issuedBy })
      } else {
        setError(result?.error || '签发被拒')
      }
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setIssueBusy(false)
    }
  }

  const copyIssued = async () => {
    if (!issuedCode) return
    try { await navigator.clipboard.writeText(issuedCode) } catch { /* 用户可手选复制 */ }
    window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '兑换码已复制', type: 'success' } }))
  }

  const inputStyle = `w-full rounded-lg px-3 py-2 text-sm outline-none border ${borderColor} ${dark ? 'bg-white/5 text-white placeholder-white/30' : 'bg-black/5 text-black placeholder-black/40'}`
  const sectionTitle = `${textPrimary} font-medium text-sm`

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-6" style={{ background: dark ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.4)' }} onClick={onClose}>
      <div
        className={`${bgCard} w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border ${borderColor} p-5`}
        onClick={(event) => event.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between mb-4">
          <div>
            <div className={`${textPrimary} font-semibold`}>兑换码管理</div>
            <div className={`text-xs ${textSecondary} mt-0.5`}>
              识别码 / 兑换码 / 签发 · 详见 docs/license-system.md
            </div>
          </div>
          <button onClick={onClose} className={`text-xs px-3 py-1.5 rounded-lg border ${borderColor} ${textSecondary} hover:opacity-80`}>关闭</button>
        </div>

        {/* ① 本机身份 */}
        <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-3`}>
          <div className={sectionTitle}>① 本机设备识别码</div>
          <div className="mt-2 flex items-center gap-2">
            <code className={`flex-1 text-xs font-mono px-2 py-1.5 rounded-lg border ${borderColor} ${dark ? 'bg-white/5' : 'bg-black/5'} ${textPrimary} break-all`}>{deviceId || '读取中…'}</code>
            <button
              onClick={() => { try { navigator.clipboard.writeText(deviceId) } catch { } window.dispatchEvent(new CustomEvent('showToast', { detail: { message: '识别码已复制', type: 'success' } })) }}
              className={`text-xs px-3 py-1.5 rounded-lg border ${borderColor} ${textSecondary} shrink-0`}
            >复制</button>
          </div>
          <div className={`text-xs ${textSecondary} mt-1.5`}>
            硬件指纹派生（主板+BIOS+系统盘），重装/清注册表不变；兑换码与此绑定
          </div>
        </div>

        {/* ② 开发者验证 */}
        <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-3`}>
          <div className="flex items-center justify-between mb-2">
            <div className={sectionTitle}>② 开发者身份验证</div>
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
              {authState.fromCache ? '（缓存，roster 变更自动失效）' : ''}
              {' · '}
              <button onClick={() => { window.electron?.developerAuth?.logout(); setAuthState(null) }} className="underline hover:opacity-80">注销</button>
            </div>
          ) : (
            <>
              <div className={`text-xs ${textSecondary} mb-2`}>
                基于 GitHub 仓库 <span style={{ color: accent }}>SoundFieldLab/WaveForge</span> 的开发者花名册签名提交链。
                {authState?.reason ? ` 上次：${authState.reason}` : ''}
              </div>
              <div className="flex gap-2 mb-2">
                <input
                  value={githubToken}
                  onChange={(event) => persistToken(event.target.value)}
                  placeholder="GitHub token（需 repo 权限）"
                  type={tokenVisible ? 'text' : 'password'}
                  className={`${inputStyle} font-mono`}
                />
                <button onClick={() => setTokenVisible((value) => !value)} className={`text-xs px-2 rounded-lg border ${borderColor} ${textSecondary} shrink-0`}>{tokenVisible ? '隐藏' : '显示'}</button>
              </div>
              <div className="flex items-center justify-between mb-2">
                <label className={`text-xs ${textSecondary} flex items-center gap-1.5 cursor-pointer`}>
                  <input type="checkbox" checked={rememberToken} onChange={(event) => toggleRemember(event.target.checked)} className="accent-current" style={{ accentColor: accent }} />
                  在本机记住 token（localStorage，仅开发者机建议勾选）
                </label>
                <button onClick={openTokenCreator} className={`text-xs underline ${textSecondary} hover:opacity-80`} style={{ color: accent }}>
                  一键创建 token →
                </button>
              </div>
              <button onClick={handleVerify} disabled={authBusy} className="w-full rounded-lg px-3 py-2 text-sm text-white disabled:opacity-50" style={{ backgroundColor: accent }}>
                {authBusy ? '验证中…' : '开始验证'}
              </button>
            </>
          )}
        </div>

        {/* ③ 签发 */}
        <div className={`${bgCard} rounded-xl p-4 border ${borderColor} mb-3`}>
          <div className={sectionTitle}>③ 签发兑换码</div>
          <div className={`text-xs ${textSecondary} mt-1 mb-3`}>
            私钥仅存在于开发者机 License Studio 数据目录，签发经本地签发器完成；
            App 不持有也无法导出私钥（防逆向边界）。
          </div>
          <label className={`text-xs ${textSecondary} block mb-1`}>目标设备识别码</label>
          <input value={deviceId} onChange={(event) => setDeviceId(event.target.value)} placeholder="WF-XXXXXXXX-…" className={`${inputStyle} mb-3 font-mono`} />

          <label className={`text-xs ${textSecondary} block mb-1`}>等级</label>
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
              <label className={`text-xs ${textSecondary} block mb-1`}>功能标识（feature，支持 abc.* 前缀通配）</label>
              <input value={feature} onChange={(event) => setFeature(event.target.value)} placeholder="例如 supporter、dj.*" className={`${inputStyle} mb-3 font-mono`} />
            </>
          )}

          <div className="grid grid-cols-2 gap-2 mb-3">
            <div>
              <label className={`text-xs ${textSecondary} block mb-1`}>展示名（可选）</label>
              <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="默认按等级命名" className={inputStyle} />
            </div>
            <div>
              <label className={`text-xs ${textSecondary} block mb-1`}>有效天数（0/空 = 永久）</label>
              <input value={expiresDays} onChange={(event) => setExpiresDays(event.target.value)} inputMode="numeric" className={inputStyle} />
            </div>
          </div>

          {/* 高级选项 */}
          <button onClick={() => setAdvancedOpen((value) => !value)} className={`text-xs ${textSecondary} mb-2 underline hover:opacity-80`}>
            {advancedOpen ? '收起高级选项' : '高级选项'}
          </button>
          {advancedOpen && (
            <div className="mb-3">
              <label className={`text-xs ${textSecondary} block mb-1`}>备注（写入码内 note，可追溯签发用途）</label>
              <input value={note} onChange={(event) => setNote(event.target.value)} placeholder={`默认 "issued by <GitHub 用户名>"`} className={inputStyle} />
            </div>
          )}

          <button onClick={handleIssue} disabled={issueBusy || !authState?.ok} className="w-full rounded-lg px-3 py-2 text-sm text-white disabled:opacity-50" style={{ backgroundColor: accent }}>
            {issueBusy ? '签发中…' : !authState?.ok ? '需先通过开发者验证' : '签发兑换码'}
          </button>

          {error && <div className="mt-2 text-xs text-red-400">{error}</div>}

          {issuedCode && (
            <div className={`mt-3 p-3 rounded-lg border ${borderColor} ${dark ? 'bg-white/5' : 'bg-black/5'}`}>
              <div className={`text-xs ${textSecondary} mb-1 flex items-center justify-between`}>
                <span>
                  签发成功（{issuedMeta?.tier}
                  {issuedMeta?.issuedBy ? ` · by ${issuedMeta.issuedBy}` : ''}），发给了用户后在「设置 → 授权」兑换：
                </span>
                <button onClick={copyIssued} className="underline hover:opacity-80" style={{ color: accent }}>复制</button>
              </div>
              <div className="font-mono text-[11px] break-all select-text" style={{ color: accent }}>{issuedCode}</div>
            </div>
          )}
        </div>

        {/* ④ 密钥状态（只读展示；密钥操作走 CLI scripts/license-keys.cjs） */}
        <div className={`${bgCard} rounded-xl p-4 border ${borderColor}`}>
          <div className={sectionTitle}>④ 密钥与安全边界</div>
          <ul className={`text-xs ${textSecondary} mt-2 space-y-1 list-disc list-inside`}>
            <li>私钥：<span style={{ color: accent }}>%APPDATA%\WaveForge License Studio\license-private-key.pem</span>（仅开发者机；不入库、不进 App 包）</li>
            <li>公钥：内嵌 <code>desktop/license-public-key.cjs</code> 与 <code>desktop/update-manifest-public-key.cjs</code>（验签用，可公开）</li>
            <li>密钥操作（初始化/校验/轮换/导出）走 CLI：<code>node scripts/license-keys.cjs --help</code></li>
            <li>轮换会让旧兑换码全部作废；发布顺序：先发带新公钥的客户端，再切清单签名</li>
            <li>App 被逆向也只能得到"需本机私钥 + GitHub 验证"的门，无签发能力</li>
          </ul>
        </div>
      </div>
    </div>
  )
}
