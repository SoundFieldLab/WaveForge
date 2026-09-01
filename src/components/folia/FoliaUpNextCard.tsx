import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Music2 } from 'lucide-react'
import { getProxiedImageUrl } from '../../services/musicApi'
import CachedImage from '../CachedImage'

export interface FoliaCardTrack {
  title: string
  artist: string
  coverUrl?: string
}

export interface FoliaUpNextCardProps {
  visible: boolean
  isTransitioning: boolean
  progress: number
  current: FoliaCardTrack
  next?: FoliaCardTrack
  onActivate?: () => void
  theme: 'light' | 'dark'
  accentColor: string
}

const clamp01 = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0))

/** Folia-only compact now-playing/next-up card with an AutoMix progress border. */
export function FoliaUpNextCard({ visible, isTransitioning, progress, current, next, onActivate, theme, accentColor }: FoliaUpNextCardProps) {
  const reducedMotion = useReducedMotion()
  const showingNext = Boolean(next)
  const displayed = showingNext ? next! : current
  const p = clamp01(progress)
  const surface = theme === 'dark' ? 'rgba(8,10,15,.72)' : 'rgba(255,255,255,.78)'
  const text = theme === 'dark' ? '#f7f7fa' : '#17181d'
  const muted = theme === 'dark' ? 'rgba(255,255,255,.58)' : 'rgba(20,22,28,.56)'
  const border = isTransitioning
    ? `conic-gradient(from -90deg, ${accentColor} 0deg ${p * 360}deg, ${accentColor}24 ${p * 360}deg 360deg)`
    : (theme === 'dark' ? 'rgba(255,255,255,.16)' : 'rgba(10,12,18,.14)')

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          data-testid="folia-up-next-card"
          className="fixed bottom-8 left-6 z-[175] p-[2px] rounded-[18px]"
          style={{ background: border }}
          initial={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -28 }}
          animate={{ opacity: 1, x: 0 }}
          exit={reducedMotion ? { opacity: 0 } : { opacity: 0, x: -16 }}
          transition={{ duration: reducedMotion ? 0.16 : 0.35, ease: [0.16, 1, 0.3, 1] }}
        >
          <button
            type="button"
            data-toast-card
            onClick={onActivate}
            className="flex min-w-[240px] max-w-[300px] items-center gap-3 rounded-2xl px-2 py-2 pr-4 text-left shadow-2xl"
            style={{ background: surface, backdropFilter: 'blur(28px) saturate(150%)', color: text }}
          >
            <div className="h-11 w-11 shrink-0 overflow-hidden rounded-lg" style={{ background: theme === 'dark' ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.06)' }}>
              {displayed.coverUrl ? (
                <CachedImage src={getProxiedImageUrl(displayed.coverUrl)} alt={displayed.title} className="h-full w-full object-cover" fallback={<Music2 className="m-3 h-5 w-5" style={{ color: muted }} />} />
              ) : (
                <Music2 className="m-3 h-5 w-5" style={{ color: muted }} />
              )}
            </div>
            <div className="min-w-0 max-w-[200px] flex-1">
              <AnimatePresence mode="wait" initial={false}>
                <motion.div key={showingNext ? 'next' : 'current'} initial={{ opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -3 }} transition={{ duration: reducedMotion ? 0 : 0.18 }}>
                  <div className="text-[9px] font-semibold uppercase tracking-[0.14em]" style={{ color: isTransitioning ? accentColor : muted }}>
                    {showingNext ? '接下来播放' : '正在播放'}
                  </div>
                  <div className="truncate text-[13px] font-semibold" style={{ color: text }}>{displayed.title}</div>
                  <div className="truncate text-[11px]" style={{ color: muted }}>{displayed.artist}</div>
                </motion.div>
              </AnimatePresence>
            </div>
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  )
}

export default FoliaUpNextCard
