import { motion, AnimatePresence } from 'framer-motion'
import { X, Edit3, Lock, Globe, ImagePlus } from 'lucide-react'
import { useState, useEffect, useRef } from 'react'
import { preparePlaylistCover } from '../utils/playlistCover'
import { getProxiedImageUrl } from '../services/musicApi'
import { useTvBack } from '../tv/tvCore'

interface EditPlaylistModalProps {
  show: boolean
  onClose: () => void
  onSubmit: (data: { name: string; desc?: string; privacy?: string; coverDataUrl?: string }) => void
  playlist: any
  loading?: boolean
}

export default function EditPlaylistModal({
  show,
  onClose,
  onSubmit,
  playlist,
  loading = false
}: EditPlaylistModalProps) {
  // TV 遥控器 BACK：关闭编辑歌单弹窗
  useTvBack(() => {
    if (show) {
      onClose()
      return true
    }
    return false
  }, [show, onClose])
  const [accentColor, setAccentColor] = useState(() => localStorage.getItem('accentColor') || '#3B82F6')
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [privacy, setPrivacy] = useState<'public' | 'private'>('public')
  const [coverPreview, setCoverPreview] = useState('')
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

  useEffect(() => {
    if (playlist && show) {
      setName(playlist.name || '')
      setDescription(playlist.description || playlist.desc || '')
      setPrivacy(playlist.privacy === 10 ? 'private' : 'public')
      setCoverPreview(playlist.coverImgUrl || '')
      setCoverDataUrl('')
      setCoverError('')
    }
  }, [playlist, show])

  const handleCoverChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setCoverError('')
    try {
      const prepared = await preparePlaylistCover(file)
      setCoverDataUrl(prepared)
      setCoverPreview(prepared)
    } catch (error) {
      setCoverError(error instanceof Error ? error.message : '封面处理失败')
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (name.trim()) {
      onSubmit({
        name: name.trim(),
        desc: description.trim(),
        privacy: privacy === 'private' ? '10' : '0',
        coverDataUrl: coverDataUrl || undefined
      })
    }
  }

  const handleClose = () => {
    // 提交 loading 期间禁止关闭（与 Delete 系弹窗一致）：关了弹窗请求仍会继续，
    // 用户以为已取消而歌单最终仍被修改
    if (loading) return
    onClose()
  }

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(10px)' }}
          onClick={handleClose}
        >
          <motion.div
            data-tv-scope
            initial={{ scale: 0.94, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            exit={{ scale: 0.94, opacity: 0, y: 12 }}
            transition={{ type: 'spring', damping: 28, stiffness: 320 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg max-h-[90vh] flex flex-col overflow-hidden rounded-3xl shadow-2xl relative"
          >
            {/* 液态玻璃背景 */}
            <div className="absolute inset-0 rounded-3xl overflow-hidden">
              {coverPreview && (
                <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${getProxiedImageUrl(coverPreview)})`, filter: 'blur(40px) brightness(0.6)' }} />
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
                      <Edit3 className="w-4.5 h-4.5" />
                    </div>
                    <div>
                      <h2 className="text-base font-semibold text-white">编辑歌单</h2>
                      <div className="text-white/50 text-[11px] -mt-0.5">修改歌单信息</div>
                    </div>
                  </div>
                  <button type="button" onClick={handleClose} className="p-2 rounded-full transition-colors hover:bg-white/15">
                    <X className="w-5 h-5 text-white/60" />
                  </button>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="p-5 space-y-5 overflow-y-auto">
                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">歌单封面</label>
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="group relative w-28 h-28 rounded-xl overflow-hidden transition-all"
                    style={{ background: 'rgba(255,255,255,0.06)', border: `1px solid ${coverPreview ? 'rgba(255,255,255,0.15)' : 'rgba(255,255,255,0.1)'}`, boxShadow: '0 4px 16px rgba(0,0,0,0.3)' }}
                  >
                    {coverPreview ? (
                      <img src={getProxiedImageUrl(coverPreview)} alt="歌单封面预览" className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-white/50">
                        <ImagePlus className="w-7 h-7" />
                        <span className="text-xs">选择封面</span>
                      </div>
                    )}
                    <div className="absolute inset-0 flex items-center justify-center bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity text-sm text-white">
                      替换图片
                    </div>
                  </button>
                  <input ref={fileInputRef} type="file" accept="image/*" onChange={handleCoverChange} className="hidden" />
                  {coverError && <p className="mt-2 text-xs text-red-400">{coverError}</p>}
                </div>

                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">
                    歌单名称 <span className="text-red-400">*</span>
                  </label>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="歌单名称"
                    maxLength={40}
                    autoFocus
                    className="w-full px-4 py-3 text-white placeholder-white/30 focus:outline-none rounded-xl transition-all"
                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = `${accentColor}88`; e.currentTarget.style.boxShadow = `0 0 0 1px ${accentColor}55` }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.boxShadow = 'none' }}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-white/80 mb-2">
                    歌单描述
                  </label>
                  <textarea
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="描述一下这个歌单..."
                    maxLength={980}
                    rows={5}
                    className="w-full px-4 py-3 text-white placeholder-white/30 focus:outline-none rounded-xl transition-all resize-none"
                    style={{ background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.1)' }}
                    onFocus={(e) => { e.currentTarget.style.borderColor = `${accentColor}88`; e.currentTarget.style.boxShadow = `0 0 0 1px ${accentColor}55` }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)'; e.currentTarget.style.boxShadow = 'none' }}
                  />
                </div>

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
                    {loading ? '保存中...' : '保存'}
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
