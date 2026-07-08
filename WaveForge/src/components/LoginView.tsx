import { useState, useEffect } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { X, Music, RefreshCw, Copy, Check, ExternalLink } from 'lucide-react'
import GlobalToast from './GlobalToast'

interface LoginViewProps {
  platform: 'netease' | 'qq'
  onCancel: () => void
  onLoginSuccess: (cookie: string) => void
}

export default function LoginView({ platform, onCancel, onLoginSuccess }: LoginViewProps) {
  const [qrCode, setQrCode] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<'pending' | 'scanned' | 'success' | 'expired'>('pending')
  const [pollTimer, setPollTimer] = useState<number | null>(null)
  const [qrKey, setQrKey] = useState<string>('')
  
  // QQ音乐Cookie登录
  const [qqCookie, setQQCookie] = useState('')
  const [qqCopied, setQQCopied] = useState(false)
  const [qqError, setQQError] = useState('')
  const [showCopiedToast, setShowCopiedToast] = useState(false)

  const handleQQOpenWebsite = async () => {
    try {
      // 复制 document.cookie 到剪贴板
      await navigator.clipboard.writeText('document.cookie')
      
      // 显示提示
      setShowCopiedToast(true)
      
      // 等待3.5秒后跳转（让用户看到提示）
      setTimeout(() => {
        window.open('https://y.qq.com', '_blank')
        // 再等0.5秒后隐藏提示
        setTimeout(() => setShowCopiedToast(false), 500)
      }, 3500)
    } catch (err) {
      console.error('复制失败:', err)
    }
  }

  useEffect(() => {
    if (platform === 'netease') {
      generateQRCode()
    } else {
      setLoading(false)
    }
    return () => {
      if (pollTimer) {
        clearInterval(pollTimer)
      }
    }
  }, [platform])

  const generateQRCode = async () => {
    setLoading(true)
    setStatus('pending')
    
    try {
      // 获取二维码 key
      const keyRes = await fetch('http://localhost:3001/api/netease/login/qr/key')
      const keyData = await keyRes.json()
      
      if (!keyData.data || !keyData.data.unikey) {
        throw new Error('获取二维码 key 失败')
      }

      const unikey = keyData.data.unikey
      setQrKey(unikey)

      // 生成二维码
      const qrRes = await fetch(`http://localhost:3001/api/netease/login/qr/create?key=${unikey}&qrimg=true`)
      const qrData = await qrRes.json()

      if (qrData.data && qrData.data.qrimg) {
        setQrCode(qrData.data.qrimg)
        setLoading(false)
        startPolling(unikey)
      } else {
        throw new Error('生成二维码失败')
      }
    } catch (error) {
      console.error('二维码生成错误:', error)
      setLoading(false)
    }
  }

  const startPolling = (key: string) => {
    // 清除旧的轮询
    if (pollTimer) {
      clearInterval(pollTimer)
    }

    // 开始轮询检查扫码状态
    const timer = window.setInterval(async () => {
      try {
        const res = await fetch(`http://localhost:3001/api/netease/login/qr/check?key=${key}`)
        const data = await res.json()

        if (data.code === 800) {
          // 二维码过期
          setStatus('expired')
          clearInterval(timer)
        } else if (data.code === 801) {
          // 等待扫码
          setStatus('pending')
        } else if (data.code === 802) {
          // 已扫码，等待确认
          setStatus('scanned')
        } else if (data.code === 803) {
          // 登录成功
          setStatus('success')
          clearInterval(timer)
          
          // 获取 cookie
          if (data.cookie) {
            onLoginSuccess(data.cookie)
          }
        }
      } catch (error) {
        console.error('检查扫码状态错误:', error)
      }
    }, 2000)

    setPollTimer(timer)
  }

  const handleRefresh = () => {
    if (pollTimer) {
      clearInterval(pollTimer)
    }
    generateQRCode()
  }

  const handleQQLogin = () => {
    setQQError('')
    
    if (!qqCookie.trim()) {
      setQQError('请输入 Cookie')
      return
    }

    // 验证 Cookie 格式
    if (!qqCookie.includes('uin') || !qqCookie.includes('qm_keyst')) {
      setQQError('Cookie 格式不正确，请确保包含 uin 和 qm_keyst')
      return
    }

    onLoginSuccess(qqCookie.trim())
  }

  const getStatusText = () => {
    switch (status) {
      case 'pending':
        return '请使用网易云音乐 App 扫码登录'
      case 'scanned':
        return '扫码成功，请在手机上确认登录'
      case 'success':
        return '登录成功！'
      case 'expired':
        return '二维码已过期，请点击刷新'
    }
  }

  const getStatusColor = () => {
    switch (status) {
      case 'pending':
        return 'text-white/60'
      case 'scanned':
        return 'text-blue-400'
      case 'success':
        return 'text-green-400'
      case 'expired':
        return 'text-red-400'
    }
  }

  return (
    <>
      <div className="fixed inset-0 w-full h-full overflow-hidden z-50">
        {/* 动态背景 */}
      <motion.div 
        className="absolute inset-0"
        animate={{
          background: [
            'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)',
            'linear-gradient(135deg, #3d1b2d 0%, #2e0f1a 50%, #0a0a0a 100%)',
            'linear-gradient(135deg, #2d1b3d 0%, #1a0f2e 50%, #0a0a0a 100%)',
          ]
        }}
        transition={{
          duration: 10,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      
      {/* 动态光晕 */}
      <motion.div
        className="absolute w-[40vw] h-[40vw] max-w-[500px] max-h-[500px] rounded-full"
        style={{
          background: 'radial-gradient(circle, rgba(255, 105, 180, 0.5) 0%, transparent 70%)',
          filter: 'blur(80px)',
          top: '20%',
          left: '15%',
        }}
        animate={{
          scale: [1, 1.3, 1],
          x: [0, 60, 0],
          y: [0, 40, 0],
        }}
        transition={{
          duration: 12,
          repeat: Infinity,
          ease: "easeInOut"
        }}
      />
      
      {/* 遮罩 */}
      <div className="absolute inset-0 bg-black/20" />

      {/* 内容区 */}
      <div className="relative z-10 w-full h-full flex items-center justify-center p-6">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          className="relative w-full max-w-md"
          style={{
            background: 'rgba(0, 0, 0, 0.4)',
            backdropFilter: 'blur(40px) saturate(180%)',
            WebkitBackdropFilter: 'blur(40px) saturate(180%)',
            borderRadius: '24px',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 8px 32px 0 rgba(0, 0, 0, 0.37)'
          }}
        >
          {/* 头部 */}
          <div className="flex items-center justify-between p-6 border-b border-white/10">
            <div className="flex items-center gap-3">
              <Music className="w-6 h-6 text-white" />
              <h2 className="text-2xl font-bold text-white">
                {platform === 'netease' ? '网易云音乐登录' : 'QQ音乐登录'}
              </h2>
            </div>
            <motion.button
              whileHover={{ scale: 1.1, rotate: 90 }}
              whileTap={{ scale: 0.9 }}
              onClick={onCancel}
              className="p-2 hover:bg-white/10 rounded-full transition-colors"
            >
              <X className="w-6 h-6 text-white/60" />
            </motion.button>
          </div>

          {/* 二维码区域 */}
          <div className="p-8 flex flex-col items-center">
            {platform === 'netease' ? (
              <>
                {/* 二维码 */}
                <div className="relative mb-6">
                  <AnimatePresence mode="wait">
                    {loading ? (
                      <motion.div
                        key="loading"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="w-64 h-64 bg-white/10 rounded-2xl flex items-center justify-center"
                      >
                        <div className="text-white/60">加载中...</div>
                      </motion.div>
                    ) : (
                      <motion.div
                        key="qrcode"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="relative"
                      >
                        <img 
                          src={qrCode} 
                          alt="登录二维码" 
                          className="w-64 h-64 rounded-2xl bg-white p-4"
                        />
                        {status === 'expired' && (
                          <div className="absolute inset-0 bg-black/60 rounded-2xl flex items-center justify-center">
                            <motion.button
                              whileHover={{ scale: 1.1 }}
                              whileTap={{ scale: 0.9 }}
                              onClick={handleRefresh}
                              className="px-6 py-3 bg-white/20 hover:bg-white/30 text-white rounded-full font-medium transition-all flex items-center gap-2"
                            >
                              <RefreshCw className="w-5 h-5" />
                              刷新二维码
                            </motion.button>
                          </div>
                        )}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* 状态提示 */}
                <motion.p 
                  key={status}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`text-center text-lg ${getStatusColor()}`}
                >
                  {getStatusText()}
                </motion.p>

                {status === 'pending' && (
                  <p className="text-center text-white/40 text-sm mt-2">
                    打开网易云音乐 App，扫描上方二维码
                  </p>
                )}
              </>
            ) : (
              // QQ音乐 Cookie 登录
              <div className="space-y-4 w-full">
                <div>
                  <div className="bg-white/5 rounded-lg p-4 text-white/80 text-sm space-y-3">
                    <p className="text-white/60 mb-3">由于QQ音乐API限制，需要手动获取Cookie进行登录</p>
                    
                    <div className="space-y-3">
                      <div>
                        <div className="flex items-start gap-3">
                          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center text-xs font-bold">1</span>
                          <div className="flex-1">
                            <p className="font-medium text-white mb-1">打开QQ音乐官网并登录</p>
                            <button
                              onClick={handleQQOpenWebsite}
                              className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm transition-colors inline-flex items-center gap-2"
                            >
                              <ExternalLink className="w-4 h-4" />
                              前往 y.qq.com
                            </button>
                          </div>
                        </div>
                      </div>
                      
                      <div>
                        <div className="flex items-start gap-3">
                          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center text-xs font-bold">2</span>
                          <div className="flex-1">
                            <p className="font-medium text-white mb-2">获取Cookie</p>
                            <div className="text-white/70 text-sm space-y-1.5">
                              <p>1. 按 <span className="text-green-400 font-semibold">F12</span> 打开开发者工具</p>
                              <p>2. 切换到 <span className="text-green-400 font-semibold">Console</span> 标签</p>
                              <p className="text-base">3. 输入以下代码并回车：</p>
                              <div className="bg-black/40 rounded px-3 py-2 mt-1.5 font-mono text-base">
                                <span className="text-green-400">document.cookie</span>
                              </div>
                              <p>4. 复制输出的内容（通常很长）</p>
                            </div>
                          </div>
                        </div>
                      </div>
                      
                      <div>
                        <div className="flex items-start gap-3">
                          <span className="flex-shrink-0 w-6 h-6 rounded-full bg-green-500/20 text-green-400 flex items-center justify-center text-xs font-bold">3</span>
                          <div className="flex-1">
                            <p className="font-medium text-white">粘贴Cookie</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div>
                  <label className="block text-white text-sm font-medium mb-2">
                    粘贴 Cookie：
                  </label>
                  <textarea
                    value={qqCookie}
                    onChange={(e) => setQQCookie(e.target.value)}
                    placeholder="粘贴从浏览器复制的 Cookie..."
                    className="w-full h-32 bg-white/10 border border-white/20 rounded-lg px-4 py-3 text-white placeholder-white/40 focus:outline-none focus:border-green-500/50 transition-colors resize-none"
                  />
                  {qqError && (
                    <p className="mt-2 text-red-400 text-sm">{qqError}</p>
                  )}
                </div>

                <div className="flex gap-3 pt-2">
                  <button
                    onClick={onCancel}
                    className="flex-1 px-6 py-3 bg-white/10 hover:bg-white/20 text-white rounded-full font-medium transition-colors"
                  >
                    取消
                  </button>
                  <button
                    onClick={handleQQLogin}
                    className="flex-1 px-6 py-3 bg-green-600 hover:bg-green-700 text-white rounded-full font-medium transition-colors"
                  >
                    登录
                  </button>
                </div>
              </div>
            )}
          </div>
        </motion.div>
      </div>
      
      {/* 全局 Toast 通知 */}
      <GlobalToast 
        show={showCopiedToast}
        message="已复制指令！请前往 y.qq.com 按 F12 打开控制台粘贴"
        type="info"
        onClose={() => setShowCopiedToast(false)}
      />
    </div>
    </>
  )
}
