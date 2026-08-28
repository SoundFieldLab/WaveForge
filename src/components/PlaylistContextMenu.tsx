import { motion, AnimatePresence } from 'framer-motion'
import { Edit3, Trash2, Star, StarOff, Share2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTvBack } from '../tv/tvCore'
import { collectSodaPlaylist } from '../services/sodaService'

/** 与 SongContextMenu.showMenuToast 一致的全局 toast 通道 */
const showMenuToast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
  window.dispatchEvent(new CustomEvent('showToast', { detail: { message, type } }))
}

interface PlaylistContextMenuProps {
  show: boolean
  x: number
  y: number
  playlist: any
  onClose: () => void
  onEdit: (playlist: any) => void
  onDelete: (playlist: any) => void
  onSubscribe: (playlist: any, subscribe: boolean) => void
  onShare: (playlist: any) => void
  isOwner: boolean
  isSubscribed?: boolean
  isSpecialPlaylist?: boolean
  canEdit?: boolean
}

export default function PlaylistContextMenu({
  show,
  x,
  y,
  playlist,
  onClose,
  onEdit,
  onDelete,
  onSubscribe,
  onShare,
  isOwner,
  isSubscribed = false,
  isSpecialPlaylist = false,
  canEdit = true
}: PlaylistContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  // TV 遥控器 BACK 关闭菜单（必须带 show 守卫：本组件常驻挂载于 HomeView 等宿主，
  // 无守卫会在隐藏时也消费 BACK 键，导致全场景 BACK 失效）
  useTvBack(() => {
    if (show) {
      onClose()
      return true
    }
    return false
  })
  const [adjustedPosition, setAdjustedPosition] = useState({ x, y })
  // 汽水歌单收藏操作进行中标记（防重复点击）
  const [collectBusy, setCollectBusy] = useState(false)

  // 计算菜单位置，确保不超出屏幕
  useEffect(() => {
    if (show && menuRef.current) {
      // offsetWidth/offsetHeight 不受入场 scale 动画影响（getBoundingClientRect 会测到
      // 0.95 缩放值，导致贴屏幕右/下边缘时夹紧不足、菜单溢出约 5% 宽高）
      const menuWidth = menuRef.current.offsetWidth
      const menuHeight = menuRef.current.offsetHeight
      const windowWidth = window.innerWidth
      const windowHeight = window.innerHeight

      let newX = x
      let newY = y

      if (x + menuWidth > windowWidth) {
        newX = windowWidth - menuWidth - 10
      }
      if (y + menuHeight > windowHeight) {
        newY = windowHeight - menuHeight - 10
      }
      if (newX < 10) newX = 10
      if (newY < 10) newY = 10

      setAdjustedPosition({ x: newX, y: newY })
    }
  }, [show, x, y])

  // 点击外部关闭菜单
  useEffect(() => {
    if (!show) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [show, onClose])

  // ESC关闭菜单
  useEffect(() => {
    if (!show) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [show, onClose])

  if (!show || !playlist) return null

  // 汽水歌单：收藏/取消收藏直接走 sodaService（App 层订阅流程不覆盖汽水），
  // 已收藏状态由调用方传入的 playlist.isCollected 决定
  const isSodaPlaylist = String(playlist.platform || '') === 'soda'
  const isSodaCollected = Boolean(playlist.isCollected)
  const handleSodaCollect = () => {
    if (collectBusy) return
    const collected = !isSodaCollected
    setCollectBusy(true)
    void collectSodaPlaylist(String(playlist.id ?? ''), collected)
      .then(ok => {
        setCollectBusy(false)
        if (ok) {
          showMenuToast(collected ? '已收藏歌单' : '已取消收藏歌单', 'success')
          onClose()
        } else {
          showMenuToast(collected ? '收藏歌单失败，请重试' : '取消收藏失败，请重试', 'error')
        }
      })
  }

  const menuItems = [
    // 只有歌单主人才能编辑和删除
    ...(isOwner && !isSpecialPlaylist && canEdit ? [
      {
        label: '编辑歌单',
        icon: Edit3,
        onClick: () => { onEdit(playlist); onClose() }
      }
    ] : []),
    ...(isOwner && !isSpecialPlaylist ? [
      {
        label: '删除歌单',
        icon: Trash2,
        onClick: () => { onDelete(playlist); onClose() },
        danger: true
      }
    ] : []),
    // 只有非本人歌单可以收藏或取消收藏
    ...(!isOwner ? (isSodaPlaylist ? [
      // 汽水歌单：收藏动作走 sodaService，不经过 App 的订阅回调
      {
        label: collectBusy ? '处理中...' : (isSodaCollected ? '取消收藏歌单' : '收藏歌单'),
        icon: isSodaCollected ? StarOff : Star,
        onClick: handleSodaCollect,
        disabled: collectBusy
      }
    ] : [{
      label: isSubscribed ? '取消收藏' : '收藏歌单',
      icon: isSubscribed ? StarOff : Star,
      onClick: () => { onSubscribe(playlist, !isSubscribed); onClose() }
    }]) : []),
    { separator: true },
    {
      label: '分享歌单',
      icon: Share2,
      onClick: () => { onShare(playlist); onClose() }
    },
  ]

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          ref={menuRef}
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.9 }}
          transition={{ duration: 0.15 }}
          className="fixed z-[100] min-w-[180px] py-2 rounded-xl overflow-hidden"
          data-tv-scope
          style={{
            left: adjustedPosition.x,
            top: adjustedPosition.y,
            background: 'rgba(20, 20, 30, 0.95)',
            backdropFilter: 'blur(20px)',
            border: '1px solid rgba(255, 255, 255, 0.1)',
            boxShadow: '0 8px 32px rgba(0, 0, 0, 0.5)'
          }}
        >
          {menuItems.map((item, index) => {
            if ('separator' in item && item.separator) {
              return <div key={index} className="my-1 border-t border-white/10" />
            }
            
            const Icon = 'icon' in item ? item.icon : null
            return (
              <button
                key={index}
                onClick={'onClick' in item ? item.onClick : undefined}
                disabled={'disabled' in item && Boolean(item.disabled)}
                className={`w-full px-4 py-2.5 flex items-center gap-3 text-sm transition-colors ${
                  'danger' in item && item.danger
                    ? 'text-red-400 hover:bg-red-500/20'
                    : 'text-white/90 hover:bg-white/10'
                } ${'disabled' in item && item.disabled ? 'opacity-50 cursor-wait' : ''}`}
              >
                {Icon && <Icon className="w-4 h-4" />}
                <span>{'label' in item ? item.label : ''}</span>
              </button>
            )
          })}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
