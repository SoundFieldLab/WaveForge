import { motion, AnimatePresence } from 'framer-motion'
import { X, Music, Lock, Globe, ImagePlus } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { preparePlaylistCover } from '../utils/playlistCover'
import { getProxiedImageUrl } from '../services/musicApi'
import { useTvBack } from '../tv/tvCore'

interface CreatePlaylistModalProps {
  show: boolean
  onClose: () => void
  onSubmit: (name: string, privacy: 'public' | 'private', description?: string, coverDataUrl?: string) => void
  loading?: boolean
}

export default function CreatePlaylistModal({
  show,
  onClose,
  onSubmit,
  loading = false
}: CreatePlaylistModalProps) {
  // TV 遥控器 BACK：关闭创建歌单弹窗
  useTvBack(() => {
    if (show) {
      handleClose()
      return true
    }
    return false
  }, [show, onClose])
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [privacy, setPrivacy] = useState<'public' | 'private'>('public')
  const [coverDataUrl, setCoverDataUrl] = useState('')
  const [coverError, setCoverError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const handleAccent = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail) setAccentColor(detail)
    }
    window.addEventListener('accentColorChanged', handleAccent)
    return () => window.removeEventListener('accentColorChanged', handleAccent)
  }, [])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim()) {
      onSubmit(name.trim(), privacy, description.trim() || undefined, coverDataUrl || undefined)
    }
  }

  const handleCoverChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setCoverError('')
    try {
      setCoverDataUrl(await preparePlaylistCover(file))
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : '封面处理失败')
    }
  }

  const handleClose = () => {
    // 提交 loading 期间禁止关闭（与 Delete 系弹窗一致）：关了弹窗请求仍会继续，
    // 用户以为已取消而歌单最终仍被创建
    if (loading) return
    setName('')
    setDescription('')
    setPrivacy('public')
    setCoverDataUrl('')
    setCoverError('')
    onClose()
  }

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          data-tv-scope
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)' }}
          onClick={handleClose}
        >
          <motion.div
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 12 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden rounded-3xl shadow-2xl relative"
          >
            {/* 液态玻璃背景 */}
            <div className="absolute inset-0 rounded-3xl overflow-hidden">
              {coverDataUrl && (
                <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${coverDataUrl})`, filter: 'blur(40px) brightness(0.6)' }} />
              )}
              <div className="absolute inset-0" style={{ background: 'linear-gradient(135deg, rgba(0,0,0,0.3) 0%, rgba(20,20,30,0.5) 50%, rgba(0,0,0,0.4) 100%)', backdropFilter: 'blur(80px) saturate(200%)', WebkitBackdropFilter: 'blur(80px) saturate(200%)' }} />
              <div className="absolute inset-0 rounded-3xl" style={{ border: '1px solid rgba(255,255,255,0.2)', boxShadow: 'inset 0 1px 1px rgba(255,255,255,0.15)', pointerEvents: 'none' }} />
            </div>

            <div className="relative z-10 flex flex-col h-full min-h-0">
              {/* 头部 */}
              <div className="p-5 border-b flex-shrink-0" style={{ borderColor: 'rgba(255,255,255,0.1)' }}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ backgroundColor: `${accentColor}26`, color: accentColor }}>
                      <Music className="w-4.5 h-4.5" />
                    </div>
                    <div>
                      <h2 className="text-base font-semibold text-white">新建歌单</h2>
                      <div className="text-white/50 text-[11px] -mt-0.5">创建一个新的歌单</div>
                    </div>
                  </div>
                  <button type="button" onClick={handleClose} className="p-2 rounded-full transition-colors hover:bg-white/15">
                    <X className="w-5 h-5 text-white/60" />
                  </button>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="p-5 space-y-5 overflow-y-auto">
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">
                    歌单封面 <span className="text-white/40">(可选)</span>
                  </label>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="group relative w-28 h-28 rounded-xl overflow-hidden transition-all"
                    style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${coverDataUrl ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.1)'}`, boxShadow: '0 4px 16px rgba(0,0,0,0.3)' }}
                  >
                    {coverDataUrl ? (
                      <img src={coverDataUrl} alt="歌单封面预览" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-white/50">
                        <ImagePlus className="w-7 h-7" />
                        <span className="text-xs">选择封面</span>
                      </div>
                    )}
                    {coverDataUrl && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity text-sm text-white">
                        替换图片
                      </div>
                    )}
                  </button>
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={handleCoverChange} className="hidden" />
                  {coverError && <p className="mt-2 text-xs text-red-400">{coverError}</p>}
                </div>

                {/* 歌单名称 */}
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">
                    歌单名称 <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="给你的歌单起个名字"
                    maxLength={40}
                    autoFocus
                    className="w-full px-4 py-3 text-white placeholder-white/30 focus:outline-none rounded-xl transition-all"
                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = `${accentColor}88`; e.currentTarget.style.boxShadow = `0 0 0 1px ${accentColor}55` }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.boxShadow = 'none' }}
                  />
                </div>

                {/* 歌单描述 */}
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">
                    歌单描述 <span className="text-white/40">(可选)</span>
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="描述一下这个歌单的主题..."
                    maxLength={980}
                    rows={5}
                    className="w-full px-4 py-3 text-white placeholder-white/30 focus:outline-none rounded-xl transition-all resize-none"
                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = `${accentColor}88`; e.currentTarget.style.boxShadow = `0 0 0 1px ${accentColor}55` }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.boxShadow = 'none' }}
                  />
                </div>

                {/* 隐私设置 */}
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-3">
                    隐私设置
                  </label>
                  <div className="flex gap-3">
                    <button
                      type="button"
                      onClick={() => setPrivacy('public')}
                      className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl transition-all ${privacy === 'public' ? 'text-white' : 'text-white/60 hover:bg-white/10'}`}
                      style={privacy === 'public' ? { background: `${accentColor}33`, border: `1px solid ${accentColor}88` } : { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                    >
                      <Globe className="w-4 h-4" />
                      <span>公开</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setPrivacy('private')}
                      className={`flex-1 flex items-center justify-center gap-2 py-3 rounded-xl transition-all ${privacy === 'private' ? 'text-white' : 'text-white/60 hover:bg-white/10'}`}
                      style={privacy === 'private' ? { background: `${accentColor}33`, border: `1px solid ${accentColor}88` } : { background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                    >
                      <Lock className="w-4 h-4" />
                      <span>私密</span>
                    </button>
                  </div>
                </div>

                {/* 提交按钮 */}
                <div className="flex gap-3 pt-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    className="flex-1 py-3 px-4 text-white/80 rounded-xl transition-colors hover:bg-white/10"
                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                  >
                    取消
                  </button>
                  <button
                    type="submit"
                    disabled={!name.trim() || loading}
                    className={`flex-1 py-3 px-4 rounded-xl font-medium transition-all ${name.trim() && !loading ? 'text-white' : 'text-white/30 cursor-not-allowed'}`}
                    style={name.trim() && !loading
                      ? { background: `linear-gradient(135deg, ${accentColor}, ${accentColor}cc)`, boxShadow: `0 4px 16px ${accentColor}44` }
                      : { background: 'rgba(255,255,255,0.08)' }}
                  >
                    {loading ? '创建中...' : '创建'}
                  </button>
                </div>
              </form>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
