import { motion } from 'framer-motion'

export type ModeSelectionMode = 'explore' | 'minimal' | 'traditional' | 'desktop'

interface ModeSelectionCardsProps {
  currentMode: ModeSelectionMode
  onSelect: (mode: ModeSelectionMode) => void
  exploreAccentRgb?: string
  /** 仅渲染这些模式；不传时渲染全部模式 */
  visibleModes?: ModeSelectionMode[]
}

const MODE_OPTIONS: ReadonlyArray<{
  mode: ModeSelectionMode
  label: string
  description: string
}> = [
  { mode: 'explore', label: '探索', description: '推荐 · 榜单 · 新鲜发行' },
  { mode: 'minimal', label: '简约', description: '三栏布局 · 沉浸聆听' },
  { mode: 'traditional', label: '传统', description: '经典布局 · 推荐与歌词' },
  { mode: 'desktop', label: '桌面', description: '沉浸歌词 · 桌面组件' },
]

function ExploreMiniature({ accentRgb }: { accentRgb: string }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
      style={{
        background: `radial-gradient(circle at 12% 0%, rgba(${accentRgb},0.48), transparent 42%), radial-gradient(circle at 92% 24%, rgba(55,126,255,0.3), transparent 38%), linear-gradient(145deg, #071a1a 0%, #091528 56%, #070910 100%)`,
      }}
    >
      <span className="absolute left-2.5 right-2.5 top-2 flex h-2.5 items-center gap-1 rounded-full border border-white/10 bg-black/25 px-1.5">
        <span className="h-1 w-1 rounded-full bg-white/45" />
        <span className="h-1 flex-1 rounded-full bg-white/15" />
        <span className="h-1 w-3 rounded-full" style={{ backgroundColor: `rgba(${accentRgb},0.5)` }} />
      </span>
      <span className="absolute left-2.5 top-[23px] h-8 w-[42px] rounded-md border border-white/10 bg-white/[0.09] p-1">
        <span className="block h-3.5 rounded-sm bg-gradient-to-br from-white/25 to-white/5" />
        <span className="mt-1 block h-0.5 w-6 rounded-full bg-white/25" />
        <span className="mt-0.5 block h-0.5 w-4 rounded-full bg-white/10" />
      </span>
      <span className="absolute left-[58px] top-[23px] h-8 w-[42px] rounded-md border border-white/10 bg-white/[0.07] p-1">
        <span className="block h-3.5 rounded-sm" style={{ background: `linear-gradient(135deg, rgba(${accentRgb},0.44), rgba(255,255,255,0.05))` }} />
        <span className="mt-1 block h-0.5 w-6 rounded-full bg-white/25" />
        <span className="mt-0.5 block h-0.5 w-5 rounded-full bg-white/10" />
      </span>
      <span className="absolute right-2.5 top-[23px] h-8 w-[42px] rounded-md border border-white/10 bg-white/[0.07] p-1">
        <span className="flex h-3.5 items-end gap-0.5 rounded-sm bg-black/15 px-1 pb-0.5">
          {[38, 70, 48, 88, 60].map((height, index) => (
            <span key={index} className="w-0.5 rounded-full" style={{ height: `${height}%`, backgroundColor: `rgba(${accentRgb},${0.32 + index * 0.08})` }} />
          ))}
        </span>
        <span className="mt-1 block h-0.5 w-6 rounded-full bg-white/25" />
        <span className="mt-0.5 block h-0.5 w-4 rounded-full bg-white/10" />
      </span>
    </span>
  )
}

function MinimalMiniature() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden bg-[radial-gradient(circle_at_76%_0%,rgba(145,99,255,0.34),transparent_42%),linear-gradient(145deg,#241438_0%,#130d25_56%,#090810_100%)]"
    >
      <span className="absolute inset-x-2.5 top-2 flex h-[45px] gap-1.5 rounded-md border border-white/[0.08] bg-black/15 p-1.5">
        <span className="flex w-[27%] flex-col gap-1 rounded bg-white/[0.07] p-1">
          <span className="h-2 rounded-sm bg-purple-300/20" />
          <span className="h-1 rounded-full bg-white/20" />
          <span className="h-1 w-3/4 rounded-full bg-white/10" />
          <span className="mt-auto h-2 rounded-sm bg-white/[0.08]" />
        </span>
        <span className="flex flex-1 flex-col gap-1 rounded bg-white/[0.055] p-1">
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-gradient-to-br from-violet-300/45 to-blue-400/20" />
            <span className="h-1 flex-1 rounded-full bg-white/20" />
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-gradient-to-br from-fuchsia-300/40 to-purple-500/15" />
            <span className="h-1 flex-1 rounded-full bg-white/14" />
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2.5 w-2.5 rounded-sm bg-gradient-to-br from-blue-300/35 to-violet-500/15" />
            <span className="h-1 flex-1 rounded-full bg-white/10" />
          </span>
        </span>
        <span className="flex w-[25%] flex-col items-center rounded bg-white/[0.07] px-1 py-1.5">
          <span className="h-3.5 w-3.5 rounded-full border border-white/20 bg-gradient-to-br from-violet-200/40 to-purple-500/15" />
          <span className="mt-1 h-1 w-5 rounded-full bg-white/20" />
          <span className="mt-0.5 h-1 w-3.5 rounded-full bg-white/10" />
          <span className="mt-auto h-1.5 w-full rounded-sm bg-purple-300/15" />
        </span>
      </span>
    </span>
  )
}

function DesktopMiniature() {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden bg-[radial-gradient(circle_at_20%_10%,rgba(79,147,255,0.36),transparent_39%),radial-gradient(circle_at_86%_24%,rgba(119,83,255,0.24),transparent_36%),linear-gradient(145deg,#132640_0%,#0b1526_56%,#070a10_100%)]"
    >
      <span className="absolute left-3 top-2.5 h-[35px] w-[35px] rotate-[-3deg] rounded-md border border-white/15 bg-gradient-to-br from-blue-200/35 via-indigo-400/20 to-black/20 shadow-[0_6px_16px_rgba(0,0,0,0.3)]">
        <span className="absolute inset-[9px] rounded-full border border-white/25 bg-black/20" />
      </span>
      <span className="absolute left-[57px] right-3 top-3 flex flex-col gap-1.5">
        <span className="h-1 w-4/5 rounded-full bg-white/35" />
        <span className="h-1 w-full rounded-full bg-white/16" />
        <span className="h-1 w-3/4 rounded-full bg-blue-200/24" />
        <span className="h-1 w-5/6 rounded-full bg-white/11" />
      </span>
      <span className="absolute left-3 right-3 top-[52px] flex h-2.5 items-center gap-1.5 rounded-full border border-white/10 bg-black/25 px-2">
        <span className="h-1 w-1 rounded-full bg-white/35" />
        <span className="h-1 w-1 rounded-full bg-white/55" />
        <span className="h-1 flex-1 rounded-full bg-white/10">
          <span className="block h-full w-[58%] rounded-full bg-gradient-to-r from-blue-300/55 to-violet-300/55" />
        </span>
        <span className="h-1 w-1 rounded-full bg-white/35" />
      </span>
    </span>
  )
}

function ModeMiniature({ mode, exploreAccentRgb }: { mode: ModeSelectionMode; exploreAccentRgb: string }) {
  if (mode === 'explore') return <ExploreMiniature accentRgb={exploreAccentRgb} />
  if (mode === 'minimal') return <MinimalMiniature />
  if (mode === 'traditional') return <TraditionalMiniature />
  return <DesktopMiniature />
}

function TraditionalMiniature() {
  return (
    <span aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden bg-[linear-gradient(145deg,#2a2030,#101521)]">
      <span className="absolute inset-y-0 left-0 w-[27%] border-r border-white/10 bg-white/[0.05]" />
      <span className="absolute left-2 top-3 h-2 w-9 rounded-full bg-pink-300/60" />
      <span className="absolute left-2 top-8 flex flex-col gap-2"><i className="h-1.5 w-12 rounded bg-white/35" /><i className="h-1.5 w-10 rounded bg-white/20" /><i className="h-1.5 w-11 rounded bg-white/20" /></span>
      <span className="absolute left-[31%] right-2 top-3 h-3 rounded-full bg-white/10" />
      <span className="absolute left-[31%] right-[25%] top-9 h-12 rounded-lg bg-gradient-to-br from-amber-200/30 via-rose-300/20 to-blue-300/20" />
      <span className="absolute left-[31%] right-[25%] bottom-4 grid grid-cols-4 gap-1"><i className="aspect-square rounded bg-white/15" /><i className="aspect-square rounded bg-pink-200/25" /><i className="aspect-square rounded bg-blue-200/20" /><i className="aspect-square rounded bg-white/10" /></span>
      <span className="absolute right-2 top-9 bottom-3 w-[19%] rounded-lg border border-white/10 bg-black/20" />
    </span>
  )
}

export default function ModeSelectionCards({
  currentMode,
  onSelect,
  exploreAccentRgb = '49, 230, 139',
  visibleModes,
}: ModeSelectionCardsProps) {
  const options = visibleModes
    ? MODE_OPTIONS.filter(({ mode }) => visibleModes.includes(mode))
    : MODE_OPTIONS
  return (
    <div className="flex items-center justify-center gap-4">
      {options.map(({ mode, label, description }) => {
        const active = currentMode === mode

        return (
          <motion.button
            key={mode}
            type="button"
            aria-label={`切换到${label}模式`}
            whileHover={{ scale: 1.045, y: -2 }}
            whileTap={{ scale: 0.965 }}
            onClick={() => onSelect(mode)}
            className="group relative h-24 w-40 cursor-pointer overflow-hidden rounded-xl border-2 text-white transition-[border-color,box-shadow] duration-300"
            style={{
              borderColor: active ? 'rgba(255,255,255,0.96)' : 'rgba(255,255,255,0.18)',
              boxShadow: active
                ? '0 12px 30px rgba(0,0,0,0.34), inset 0 0 0 1px rgba(255,255,255,0.08)'
                : '0 10px 24px rgba(0,0,0,0.22)',
            }}
          >
            <ModeMiniature mode={mode} exploreAccentRgb={exploreAccentRgb} />
            <span className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,transparent_20%,rgba(4,6,12,0.12)_43%,rgba(4,6,12,0.94)_100%)]" />
            <span className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100 bg-[linear-gradient(110deg,transparent_18%,rgba(255,255,255,0.12)_48%,transparent_72%)]" />
            <span className="absolute bottom-2.5 left-3 right-3 z-20 flex flex-col items-start leading-none">
              <span className="text-[15px] font-semibold tracking-[0.08em] text-white drop-shadow-md">{label}</span>
              <span className="mt-1.5 whitespace-nowrap text-[9px] font-medium tracking-[0.02em] text-white/58">{description}</span>
            </span>
            {active && (
              <span className="absolute right-2 top-2 z-30 rounded-full border border-white/15 bg-black/35 px-2 py-1 text-[10px] leading-none text-white shadow-sm backdrop-blur-md">
                当前
              </span>
            )}
          </motion.button>
        )
      })}
    </div>
  )
}
