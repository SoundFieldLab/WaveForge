import type { CSSProperties } from 'react'
import { Home, MessageCircle, Pause, Play, SkipBack, SkipForward, Volume2 } from 'lucide-react'
import { toRgba } from './quickSettingsPalette'

/**
 * 「播放设置」弹窗左侧预览的**各歌词模式版式**。
 *
 * 预览必须跟着 `lyricDisplayMode` 换版式 —— 六个模式的播放页长得完全不一样：
 * 现代＝左封面右歌词；沉浸＝无封面、居中一行大字 + 下一句淡色预览；墙纸＝散落多列 + 右下相纸；
 * 辉煌＝右侧竖版金框卡 + 左侧巨字海报；多维＝深空 3D 走廊；摩登＝左栏封面/进度/控制 + 右栏逐词。
 * 抽象掉的是**尺寸与细节**，不是**结构**：元素位置按真机比例摆放，一眼能认出是哪个模式。
 *
 * 各模式真机骨架的来源（改这里前先核对，别凭印象）：
 * - modern     `App.tsx:9277-9374` + `AlbumCoverPlayer.tsx:101`（封面 384px 正方形圆角，非圆形）
 * - immersive  `App.tsx:9033-9073` + `LyricsDisplay.tsx:2213-2372`（6 组百分比锚点、下一句 ×0.42）
 * - wallpaper  `WallpaperLyrics.tsx:364-462`（相纸 `bottom-[10%] right-[1.5vw] w-[min(30vw,340px)]`、rotate(-4deg)）
 * - glorious   `GloriousLyrics.tsx:168-445`（竖版卡 `-right-[1vw] top-[10vh] w-[min(22vw,300px)]`、rotate(7deg)、SCENES 巨字）
 * - multidim   `MultidimensionalLyrics.tsx:62-105` + `foliaDiorama/FoliaDioramaLyrics.tsx:275-332`
 * - modeng     `ModengPlayerPage.tsx:1271-2016`（基准画布 1312×951 全屏等比缩放；当前行锚点 41% 高）
 */

export interface PreviewRow {
  key: string
  text: string
  progress: number
  isCurrent: boolean
}

export interface PreviewSceneContext {
  isDaylight: boolean
  /** 封面主色（只用于多维走廊的光晕与看歌的画幅染色，不用于歌词高亮） */
  accentColor: string
  /** 压在封面/模糊底上的前景文字色（暗主题白、亮主题黑） */
  overText: string
  /** 当前行字号（已按「歌词大小」设置换算） */
  lyricPx: number
  rows: PreviewRow[]
  prevRow?: PreviewRow
  currentRow?: PreviewRow
  nextRow?: PreviewRow
  title: string
  artist: string
  /** 沉浸模式的「隐藏歌名艺人」等 */
  showSongInfo: boolean
  showImmersiveBar: boolean
  showVisualizer: boolean
  wordByWord: boolean
  lyricGlow: boolean
  lyricGlowShadow: string
  lyricLineHeight: number
  /** 封面律动开关 + 一档时长（真机是封面随节拍轻微缩放） */
  coverPulse: boolean
  coverPulseDuration: string
  animationPlayState: 'running' | 'paused'
  progressRatio: number
  clockText: string
  durationText: string
  /** 「07 / 42」形如真机的行号计数 */
  counterLabel: string
  coverUrl: string
  coverGradient: string
  hasRealCover: boolean
  toCssUrl: (url: string) => string
}

export interface PreviewSceneProps {
  ctx: PreviewSceneContext
}

/* ------------------------------------------------------------------ *
 * 定位小工具（预览全部用百分比，才能随弹窗高度自适应）
 * ------------------------------------------------------------------ */

const atLT = (left: number, top: number, extra?: CSSProperties): CSSProperties => ({
  position: 'absolute',
  left: `${left}%`,
  top: `${top}%`,
  ...extra,
})

const atRB = (right: number, bottom: number, extra?: CSSProperties): CSSProperties => ({
  position: 'absolute',
  right: `${right}%`,
  bottom: `${bottom}%`,
  ...extra,
})

const atEdge = (bottom: number, extra?: CSSProperties): CSSProperties => ({
  position: 'absolute',
  left: 0,
  right: 0,
  bottom: `${bottom}%`,
  ...extra,
})

const atRT = (right: number, top: number, extra?: CSSProperties): CSSProperties => ({
  position: 'absolute',
  right: `${right}%`,
  top: `${top}%`,
  ...extra,
})

/**
 * 封面层：有真封面就用图，否则退回主题色渐变；律动开关叠加缩放动画。
 * keyframes 定义在 `QuickSettingsPreview.tsx` 的 `<style>` 里（预览外壳统一注入）。
 */
const coverBoxStyle = (ctx: PreviewSceneContext): CSSProperties => ({
  ...(ctx.hasRealCover
    ? { backgroundImage: ctx.toCssUrl(ctx.coverUrl), backgroundSize: 'cover', backgroundPosition: 'center' }
    : { background: ctx.coverGradient }),
  animation: ctx.coverPulse ? `qs-preview-pulse ${ctx.coverPulseDuration} ease-in-out infinite` : undefined,
  animationPlayState: ctx.animationPlayState,
  willChange: 'transform',
})

/** 未唱部分的中性色（真机 LyricsDisplay 的 0.4 alpha）。 */
const unsungColor = (ctx: PreviewSceneContext) => (ctx.isDaylight ? 'rgba(0,0,0,0.4)' : 'rgba(255,255,255,0.4)')

/** 墙纸模式三列的起始高度差（% 容器宽）—— 真机的歌词块是「散落」而不是对齐网格。 */
const WALLPAPER_COLUMN_DROP = [0, 11, 4]

/**
 * 逐字歌词：当前行按进度点亮，其余整行用已唱色。
 * 预览用线性近似（按字数比例），不读真机逐字时间轴 —— 位置与观感足够一致。
 */
export function GlyphText({
  text,
  progress,
  wordByWord,
  sungColor,
  dimColor,
  textShadow,
  style,
}: {
  text: string
  progress: number
  wordByWord: boolean
  sungColor: string
  dimColor: string
  textShadow?: string
  style?: CSSProperties
}) {
  if (!wordByWord || progress >= 1) {
    return <span style={{ ...style, color: sungColor, textShadow }}>{text}</span>
  }
  const sungCount = Math.round(text.length * progress)
  return (
    <span style={{ ...style, textShadow }}>
      {Array.from(text).map((char, index) => (
        <span key={`${char}-${index}`} style={{ color: index < sungCount ? sungColor : dimColor }}>
          {char}
        </span>
      ))}
    </span>
  )
}

/* ------------------------------------------------------------------ *
 * 共用小部件
 * ------------------------------------------------------------------ */

/**
 * 预览里的「迷你控件 chrome」配色。
 * 不能写死白字黑底 —— 浅色主题的播放面是浅底，白字会直接糊掉，
 * 而这些小圆点和 chip 恰恰是「这是哪个模式」的信息载体。
 */
const chromeBg = (ctx: PreviewSceneContext) => (ctx.isDaylight ? 'rgba(255,255,255,0.62)' : 'rgba(0,0,0,0.28)')
const chromeBorder = (ctx: PreviewSceneContext) => toRgba(ctx.overText, ctx.isDaylight ? 0.14 : 0.22)
const chromeDot = (ctx: PreviewSceneContext) => toRgba(ctx.overText, 0.55)

/** 竖排按钮列（`default` / `left` 变体的抽象：右上角一组圆形按钮）。 */
function MiniRail({ ctx }: PreviewSceneProps) {
  return (
    <div className="z-20 flex flex-col items-center gap-[6px]" style={atRT(3, 18)}>
      {[0, 1, 2, 3, 4].map(index => (
        <div
          key={index}
          className="rounded-full border"
          style={{ width: 12, height: 12, borderColor: chromeBorder(ctx), backgroundColor: chromeBg(ctx) }}
        />
      ))}
    </div>
  )
}

/** 频谱条（真机 `ModernAudioVisualizer` 是左下角一条宽条）。 */
function MiniVisualizer({ ctx, style }: PreviewSceneProps & { style?: CSSProperties }) {
  return (
    <div className="z-20 flex items-end gap-[3px]" style={style ?? atRB(0, 2.5, { right: 'auto', left: '3%' })}>
      {[0.32, 0.62, 0.9, 0.5, 1, 0.44, 0.78, 0.36, 0.68, 0.94, 0.52].map((height, index) => (
        <div
          key={index}
          className="w-[4px] rounded-full"
          style={{
            height: `${Math.round(height * 22)}px`,
            background: toRgba(ctx.overText, 0.62),
            transformOrigin: 'bottom',
            animation: `qs-preview-bar ${0.62 + (index % 4) * 0.19}s ease-in-out infinite`,
            animationPlayState: ctx.animationPlayState,
          }}
        />
      ))}
    </div>
  )
}

/**
 * 底部播放条（真机简约模式的固定底栏抽象）：一条贴底细进度 + 左右时间。
 * 现代 / 沉浸 / 看歌都用它承载真实播放进度。
 */
function BottomPlayerBar({ ctx }: PreviewSceneProps) {
  return (
    <div className="z-20" style={atEdge(0, { padding: '0 5% 3%' })}>
      <MiniProgress ctx={ctx} width="100%" trackColor={toRgba(ctx.overText, 0.2)} />
    </div>
  )
}

/** 细进度条 + 时间（摩登左栏、沉浸底部条共用）。 */
function MiniProgress({ ctx, width, trackColor }: PreviewSceneProps & { width: string; trackColor: string }) {
  return (
    <div style={{ width }}>
      <div className="h-[3px] overflow-hidden rounded-full" style={{ background: trackColor }}>
        <div
          className="h-full rounded-full transition-[width] duration-200 ease-linear"
          style={{ width: `${ctx.progressRatio * 100}%`, background: toRgba(ctx.overText, 0.9) }}
        />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px]" style={{ color: toRgba(ctx.overText, 0.6) }}>
        <span>{ctx.clockText}</span>
        <span>{ctx.durationText}</span>
      </div>
    </div>
  )
}

/** 列式歌词行（现代 / 摩登共用）：当前行大而亮，其余小而淡。 */
function ColumnLyricRow({
  ctx,
  row,
  scale,
  align = 'left',
}: PreviewSceneProps & { row: PreviewRow; scale: number; align?: 'left' | 'center' }) {
  return (
    <div
      className="font-medium"
      style={{
        fontSize: `${row.isCurrent ? ctx.lyricPx : Math.round(ctx.lyricPx * scale)}px`,
        lineHeight: ctx.lyricLineHeight,
        textAlign: align,
        opacity: row.isCurrent ? 1 : 0.72,
        filter: row.isCurrent ? 'none' : 'blur(0.4px)',
      }}
    >
      <GlyphText
        text={row.text}
        progress={row.progress}
        wordByWord={ctx.wordByWord && row.isCurrent}
        sungColor={row.isCurrent ? ctx.overText : toRgba(ctx.overText, 0.72)}
        dimColor={unsungColor(ctx)}
        textShadow={row.isCurrent && ctx.lyricGlow ? ctx.lyricGlowShadow : undefined}
      />
    </div>
  )
}

/** 圆形控制按钮条（`compact` / `glorious` 横条变体的抽象）。 */
function DotStrip({ ctx, width, style }: PreviewSceneProps & { width: number; style?: CSSProperties }) {
  return (
    <div
      className="flex items-center gap-[6px] rounded-full border px-2.5 py-1.5 backdrop-blur-sm"
      style={{ ...style, borderColor: chromeBorder(ctx), backgroundColor: chromeBg(ctx) }}
    >
      {[0, 1, 2, 3, 4].map(index => (
        <div key={index} className="rounded-full" style={{ width, height: width, backgroundColor: chromeDot(ctx) }} />
      ))}
    </div>
  )
}

/**
 * 左上角歌名艺人块。刻意从 14% 起排 —— 预览左上角被「实时预览」chip 占着，
 * 真机同一角也是歌名块，两者叠在一起会看不清。
 */
function CornerSongInfo({ ctx }: PreviewSceneProps) {
  if (!ctx.showSongInfo) return null
  return (
    <div className="z-20" style={atLT(4.5, 14, { maxWidth: '52%' })}>
      <div className="truncate font-bold" style={{ color: ctx.overText, fontSize: Math.max(10, ctx.lyricPx * 0.46) }}>
        {ctx.title}
      </div>
      <div className="truncate" style={{ color: toRgba(ctx.overText, 0.58), fontSize: Math.max(8, ctx.lyricPx * 0.32) }}>
        {ctx.artist}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 * ① modern（现代）：左封面 + 右歌词两栏
 * ------------------------------------------------------------------ */
export function ModernScene({ ctx }: PreviewSceneProps) {
  return (
    <>
      <div className="absolute inset-0 z-10 flex items-stretch" style={{ paddingBottom: '10%' }}>
        {/* 左栏：正方形圆角封面 + 居中歌名艺人（真机 AlbumCoverPlayer） */}
        <div className="flex flex-col items-center justify-center gap-[5%]" style={{ width: '46%' }}>
          <div
            className="aspect-square w-[72%] rounded-2xl border border-white/15 shadow-[0_16px_44px_rgba(0,0,0,0.45)]"
            style={coverBoxStyle(ctx)}
          />
          {ctx.showSongInfo && (
            <div className="max-w-[80%] text-center">
              <div className="truncate font-bold" style={{ color: ctx.overText, fontSize: Math.max(11, ctx.lyricPx * 0.5) }}>
                {ctx.title}
              </div>
              <div className="truncate" style={{ color: toRgba(ctx.overText, 0.62), fontSize: Math.max(9, ctx.lyricPx * 0.36) }}>
                {ctx.artist}
              </div>
            </div>
          )}
        </div>

        {/* 右栏：滚动歌词列（非当前行 ×0.63 + 轻微模糊，与真机一致） */}
        <div className="flex flex-col justify-center gap-[3.5%] pr-[9%]" style={{ width: '54%' }}>
          {ctx.rows.map(row => (
            <ColumnLyricRow key={row.key} ctx={ctx} row={row} scale={0.63} />
          ))}
        </div>
      </div>

      {/* 真机只在 modern 分支挂载 ModernAudioVisualizer（`App.tsx:9378`），其他模式没有频谱条 */}
      {ctx.showVisualizer && <MiniVisualizer ctx={ctx} style={atRB(0, 12, { right: 'auto', left: '5%' })} />}

      <BottomPlayerBar ctx={ctx} />
      <MiniRail ctx={ctx} />
    </>
  )
}

/* ------------------------------------------------------------------ *
 * ② immersive（沉浸式）：无封面，一行大字 + 下一句淡色预览
 * ------------------------------------------------------------------ */
export function ImmersiveScene({ ctx }: PreviewSceneProps) {
  const current = ctx.currentRow ?? ctx.rows[1]
  return (
    <>
      {/* 真机无封面，只有居中的单行大字（LyricsDisplay 的百分比锚点会逐句漂移，这里取一个偏移位） */}
      <div className="z-10 flex flex-col items-center text-center" style={atLT(50, 40, { width: '82%', transform: 'translate(-50%, -50%)' })}>
        <div style={{ fontSize: Math.round(ctx.lyricPx * 1.55), lineHeight: 1.28, fontWeight: 600 }}>
          <GlyphText
            text={current?.text ?? ''}
            progress={current?.progress ?? 0}
            wordByWord={ctx.wordByWord}
            sungColor={ctx.overText}
            dimColor={unsungColor(ctx)}
            textShadow={ctx.lyricGlow ? ctx.lyricGlowShadow : undefined}
          />
        </div>
        {ctx.nextRow && (
          <div className="mt-4" style={{ fontSize: Math.round(ctx.lyricPx * 0.66), color: 'rgba(235,235,245,0.5)' }}>
            {ctx.nextRow.text}
          </div>
        )}
      </div>

      {/* 底部进度条：`showImmersiveBar` 控制的就是这条「白条」 */}
      {ctx.showImmersiveBar && (
        <div className="z-10 flex justify-center" style={atEdge(7)}>
          <MiniProgress ctx={ctx} width="52%" trackColor={toRgba(ctx.overText, 0.22)} />
        </div>
      )}

      <MiniRail ctx={ctx} />
      <CornerSongInfo ctx={ctx} />
    </>
  )
}

/* ------------------------------------------------------------------ *
 * ③ wallpaper（墙纸）：散落多列歌词 + 右下「相纸」
 * ------------------------------------------------------------------ */
export function WallpaperScene({ ctx }: PreviewSceneProps) {
  // 真机按视口宽取 2/3/4 列；预览里在左侧 58% 区域排 3 列，给右下相纸留位。
  // 歌词窗口有 7 行、墙纸只铺 6 块 —— 取靠后的 6 行，保证「当前句」几乎总在块里（窗口是当前句居中的）。
  const pool = ctx.rows.length > 6 ? ctx.rows.slice(-6) : ctx.rows
  const blocks = Array.from({ length: 6 }, (_, index) => pool[index % Math.max(1, pool.length)])
  return (
    <>
      {/* 纸面：提亮/压暗 + 细斜纹（真机 WallpaperLyrics 的纸感），盖住底下的封面模糊 */}
      <div
        className="absolute inset-0 z-10"
        style={{
          background: ctx.isDaylight
            ? 'linear-gradient(150deg, rgba(255,255,255,0.74) 0%, rgba(250,248,244,0.62) 55%, rgba(240,238,232,0.5) 100%)'
            : 'linear-gradient(150deg, rgba(26,24,22,0.74) 0%, rgba(16,15,14,0.64) 55%, rgba(10,9,9,0.56) 100%)',
        }}
      />
      <div
        className="absolute inset-0 z-10 opacity-[0.14]"
        style={{ background: `repeating-linear-gradient(0deg, ${toRgba(ctx.overText, 0.5)} 0 1px, transparent 1px 9px)` }}
      />
      {/* 左下角水印（真机 "LYRIC ARCHIVE" 字样） */}
      <div
        className="z-10 font-bold uppercase"
        style={atLT(4.5, 0, {
          bottom: '5%',
          top: 'auto',
          fontSize: Math.max(9, ctx.lyricPx * 0.32),
          letterSpacing: '0.3em',
          color: toRgba(ctx.overText, 0.2),
        })}
      >
        Lyric Archive
      </div>

      {/* 歌词块：3 列散落（每列起始高度不同 + 列内第二行右移），当前块满透明度，其余降透明度。
          列宽 31.33% × 3 + 间隔 3% × 2 = 100%，不溢出容器；列内行距用 px（百分比 row-gap 在
          高度 auto 的 flex 列里会算成 0，两行会贴在一起）。 */}
      <div className="z-10 flex gap-[3%]" style={atLT(5, 14, { width: '58%' })}>
        {WALLPAPER_COLUMN_DROP.map((drop, column) => (
          <div key={column} className="flex flex-col" style={{ width: '31.33%', marginTop: `${drop}%` }}>
            {[0, 1].map(offset => {
              const row = blocks[column * 2 + offset]
              return (
                <div
                  key={offset}
                  className="font-medium"
                  style={{
                    fontSize: `${Math.max(9, Math.round(ctx.lyricPx * 0.62))}px`,
                    lineHeight: 1.35,
                    opacity: row.isCurrent ? 1 : 0.62,
                    marginBottom: Math.round(ctx.lyricPx * 1.1),
                    marginLeft: offset === 1 ? '9%' : undefined,
                  }}
                >
                  <GlyphText
                    text={row.text}
                    progress={row.progress}
                    wordByWord={ctx.wordByWord && row.isCurrent}
                    sungColor={ctx.overText}
                    dimColor={unsungColor(ctx)}
                  />
                </div>
              )
            })}
          </div>
        ))}
      </div>

      {/* 右下「相纸」：宽幅留白纸边 + rotate(-4deg)，照片下方印歌名与 print 编号。
          宽度 26% 是按横版盒定的：34% 在 260 高的盒子里会长到占掉近六成高度，
          压住左上那片歌词块。 */}
      <div className="z-10" style={atRB(4, 11, { width: '26%' })}>
        <div className="rounded-[3px] bg-white px-[5%] pb-[5%] pt-[7%] shadow-[0_14px_34px_rgba(0,0,0,0.42)]" style={{ transform: 'rotate(-4deg)' }}>
          <div className="aspect-[4/3] w-full rounded-[2px]" style={coverBoxStyle(ctx)} />
          <div className="mt-1.5 truncate text-[8px] font-semibold text-black/80">{ctx.title}</div>
          <div className="flex items-center justify-between">
            <span className="truncate text-[7px] text-black/45">{ctx.artist}</span>
            <span className="font-mono text-[7px] text-black/35">print 013</span>
          </div>
        </div>
      </div>

      {/* 相纸正下方的小横向控件条（`compact` 变体锚点） */}
      <DotStrip ctx={ctx} width={6} style={atRB(7.5, 3.5)} />
    </>
  )
}

/* ------------------------------------------------------------------ *
 * ④ glorious（辉煌）：右侧竖版金框卡 + 左侧巨字海报
 * ------------------------------------------------------------------ */
export function GloriousScene({ ctx }: PreviewSceneProps) {
  const current = ctx.currentRow ?? ctx.rows[1]
  const gold = '#c8a24a'
  const corners: CSSProperties[] = [
    { top: -4, left: -4, borderTop: `1px solid ${gold}`, borderLeft: `1px solid ${gold}` },
    { top: -4, right: -4, borderTop: `1px solid ${gold}`, borderRight: `1px solid ${gold}` },
    { bottom: -4, left: -4, borderBottom: `1px solid ${gold}`, borderLeft: `1px solid ${gold}` },
    { bottom: -4, right: -4, borderBottom: `1px solid ${gold}`, borderRight: `1px solid ${gold}` },
  ]

  return (
    <>
      {/* 深蓝底 + 金色格线（真机 GloriousLyrics 的调色） */}
      <div
        className="absolute inset-0 z-10"
        style={{ background: 'linear-gradient(118deg, rgba(8,7,19,0.74) 0%, rgba(12,11,22,0.52) 50%, rgba(16,21,34,0.68) 100%)' }}
      />
      <div
        className="absolute inset-0 z-10 opacity-[0.1]"
        style={{
          background: `repeating-linear-gradient(0deg, ${gold} 0 1px, transparent 1px 26px), repeating-linear-gradient(90deg, ${gold} 0 1px, transparent 1px 26px)`,
        }}
      />

      {/* 上一句：左上淡色 */}
      {ctx.prevRow && (
        <div
          className="z-10 font-medium"
          style={atLT(7, 20, { maxWidth: '44%', fontSize: Math.max(9, Math.round(ctx.lyricPx * 0.62)), color: toRgba(ctx.overText, 0.3) })}
        >
          {ctx.prevRow.text}
        </div>
      )}

      {/* 当前行：左侧巨字海报（真机 clamp(2.6rem,6.4vw,6.8rem) + 轻微旋转）。
          系数 1.6 是按**横版**预览盒（462×260）定的：真机 6.4vw @1440 ≈ 92px，
          换算到 1/3 宽的预览盒约 30px ≈ 1.6×。写 1.95 会让 8 字句在 56% 宽里折行，
          第二行只剩一个「上」，很难看。 */}
      <div className="z-10" style={atLT(8, 33, { width: '56%', transform: 'rotate(-2deg)' })}>
        <GlyphText
          text={current?.text ?? ''}
          progress={current?.progress ?? 0}
          wordByWord={ctx.wordByWord}
          sungColor={ctx.overText}
          dimColor={unsungColor(ctx)}
          textShadow={ctx.lyricGlow ? '0 3px 16px rgba(0,0,0,0.55)' : undefined}
          style={{ fontSize: Math.round(ctx.lyricPx * 1.6), fontWeight: 800, lineHeight: 1.12, letterSpacing: '-0.01em' }}
        />
      </div>

      {/* 下一句：右下淡色 */}
      {ctx.nextRow && (
        <div
          className="z-10 text-right font-medium"
          style={atRB(7, 17, { maxWidth: '44%', fontSize: Math.max(9, Math.round(ctx.lyricPx * 0.62)), color: toRgba(ctx.overText, 0.34) })}
        >
          {ctx.nextRow.text}
        </div>
      )}

      {/* 右侧竖版画廊卡片：aspect 3/4 + rotate(7deg) + 金色细框与四角饰角 */}
      <div className="z-10" style={atRB(-1, 0, { bottom: 'auto', top: '11%', width: '27%' })}>
        <div
          className="rounded-[3px]"
          style={{
            transform: 'rotate(7deg)',
            border: `1px solid ${toRgba(gold, 0.55)}`,
            padding: 3,
            background: 'rgba(6,6,10,0.5)',
            boxShadow: '0 18px 40px rgba(0,0,0,0.5)',
          }}
        >
          <div className="relative">
            <div className="aspect-[3/4] w-full rounded-[2px]" style={coverBoxStyle(ctx)} />
            {corners.map((style, index) => (
              <div key={index} style={{ position: 'absolute', width: 7, height: 7, ...style }} />
            ))}
          </div>
        </div>
        {/* 卡片正下方的小横向控件条（`glorious` 变体锚点） */}
        <div className="mt-2 flex items-center justify-center gap-[6px]">
          {[0, 1, 2, 3, 4].map(index => (
            <div key={index} className="rounded-full" style={{ width: 6, height: 6, backgroundColor: toRgba(gold, 0.6) }} />
          ))}
        </div>
      </div>

      {/* 右下行号计数 + 底部巨号描边水印歌名 */}
      <div className="z-20 font-mono" style={atRB(4.5, 16, { fontSize: 10, color: toRgba(ctx.overText, 0.45) })}>
        {ctx.counterLabel}
      </div>
      <div
        className="z-10 truncate font-black uppercase"
        style={atLT(6, 0, {
          bottom: '10%',
          top: 'auto',
          maxWidth: '86%',
          fontSize: Math.round(ctx.lyricPx * 1.4),
          letterSpacing: '0.04em',
          color: 'transparent',
          WebkitTextStroke: `1px ${toRgba(ctx.overText, 0.2)}`,
        })}
      >
        {ctx.title}
      </div>

      <BottomPlayerBar ctx={ctx} />
    </>
  )
}

/* ------------------------------------------------------------------ *
 * ⑤ multidimensional（多维）：深空 3D 走廊
 * ------------------------------------------------------------------ */
export function MultidimensionalScene({ ctx }: PreviewSceneProps) {
  const current = ctx.currentRow ?? ctx.rows[1]
  return (
    <>
      {/* 深空底 + 电影暗角（真机是 radial-gradient 遮罩） */}
      <div className="absolute inset-0 z-10" style={{ background: 'linear-gradient(180deg, rgba(5,6,12,0.86) 0%, rgba(5,6,12,0.6) 45%, rgba(5,6,12,0.9) 100%)' }} />
      <div className="absolute inset-0 z-10" style={{ background: 'radial-gradient(ellipse 92% 82% at 50% 44%, transparent 46%, rgba(3,4,9,0.66) 100%)' }} />

      {/* 3D 走廊：透视框 + 地平线光晕 + 星河（真机是 R3F Canvas，这里用 CSS 透视示意纵深） */}
      <div className="absolute inset-0 z-10">
        {[0, 1, 2, 3].map(index => (
          <div
            key={index}
            className="rounded-[10px] border"
            style={{
              position: 'absolute',
              left: `${15 + index * 8}%`,
              right: `${15 + index * 8}%`,
              top: `${14 + index * 9}%`,
              bottom: `${14 + index * 9}%`,
              borderColor: toRgba(ctx.accentColor, 0.28 - index * 0.055),
            }}
          />
        ))}
        <div
          className="rounded-full"
          style={{
            position: 'absolute',
            left: '50%',
            top: '44%',
            width: '48%',
            height: '48%',
            transform: 'translate(-50%, -50%)',
            background: `radial-gradient(circle, ${toRgba(ctx.accentColor, 0.32)} 0%, transparent 68%)`,
            animation: 'qs-preview-dot 3.2s ease-in-out infinite',
            animationPlayState: ctx.animationPlayState,
          }}
        />
        {[[18, 30], [74, 24], [30, 66], [82, 58], [58, 18], [12, 52]].map(([left, top], index) => (
          <div
            key={index}
            className="rounded-full"
            style={{ position: 'absolute', left: `${left}%`, top: `${top}%`, width: 3, height: 3, background: 'rgba(255,255,255,0.5)' }}
          />
        ))}
      </div>

      {/* 立体歌词：居中一行，带纵深柔光 */}
      <div className="z-10 flex flex-col items-center text-center" style={atLT(50, 44, { width: '74%', transform: 'translate(-50%, -50%)' })}>
        <div style={{ fontSize: Math.round(ctx.lyricPx * 1.4), lineHeight: 1.3, fontWeight: 600 }}>
          <GlyphText
            text={current?.text ?? ''}
            progress={current?.progress ?? 0}
            wordByWord={ctx.wordByWord}
            sungColor={ctx.overText}
            dimColor={unsungColor(ctx)}
            textShadow={ctx.lyricGlow ? `0 0 22px ${toRgba(ctx.accentColor, 0.55)}` : undefined}
          />
        </div>
      </div>

      {/* 底部居中毛玻璃药丸（真机是罗马音/翻译字幕层） */}
      <div className="z-10 flex justify-center" style={atEdge(13)}>
        <div className="rounded-full border border-white/12 bg-black/30 px-3 py-1.5 backdrop-blur-md">
          <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.66)', letterSpacing: '0.04em' }}>翻译 · 罗马音</span>
        </div>
      </div>

      {/* 右下角行号计数（真机 activeNumber / totalNumber） */}
      <div className="z-20 font-mono" style={atRB(4.5, 13, { fontSize: 10, color: toRgba(ctx.overText, 0.5) })}>
        {ctx.counterLabel}
      </div>

      <BottomPlayerBar ctx={ctx} />
      <MiniRail ctx={ctx} />
      <CornerSongInfo ctx={ctx} />
    </>
  )
}

/* ------------------------------------------------------------------ *
 * ⑥ modeng（摩登）：左栏封面/歌名/进度/控制 + 右栏逐词歌词 + 左下页脚
 * ------------------------------------------------------------------ */
export function ModengScene({ ctx }: PreviewSceneProps) {
  const playing = ctx.animationPlayState === 'running'
  return (
    <>
      {/* 采色节拍光晕（真机 ModengPlayerPage 的 beat halo） */}
      <div
        className="absolute inset-0 z-10"
        style={{
          background: `radial-gradient(circle at 22% 62%, ${toRgba(ctx.accentColor, 0.26)} 0%, transparent 46%)`,
          animation: 'qs-preview-dot 1.6s ease-in-out infinite',
          animationPlayState: ctx.animationPlayState,
        }}
      />

      {/* 左栏：封面 → 歌名艺人 → 细进度条 + 时间 → 播放控制 + 音量。
          封面 `w-full`（正方形=整栏宽 152px）在竖长盒里没问题，横版盒左栏只有 200px 高，
          152px 的方封面会把歌名/进度/控制整段挤出去 → 收到 68%（≈103px，真机封面上屏高占比约 43%）。 */}
      <div className="z-10 flex flex-col" style={{ position: 'absolute', left: '5%', top: '10%', bottom: '13%', width: '33%' }}>
        <div className="aspect-square w-[68%] rounded-[10px] border border-white/12 shadow-[0_16px_40px_rgba(0,0,0,0.5)]" style={coverBoxStyle(ctx)} />
        {ctx.showSongInfo && (
          <div className="mt-3">
            <div className="truncate font-bold" style={{ color: ctx.overText, fontSize: Math.max(10, ctx.lyricPx * 0.5) }}>
              {ctx.title}
            </div>
            <div className="truncate" style={{ color: toRgba(ctx.overText, 0.6), fontSize: Math.max(8, ctx.lyricPx * 0.34) }}>
              {ctx.artist}
            </div>
          </div>
        )}
        <div className="mt-auto">
          <MiniProgress ctx={ctx} width="100%" trackColor={toRgba(ctx.overText, 0.18)} />
        </div>
        <div className="mt-2 flex items-center gap-2.5" style={{ color: ctx.overText }}>
          <SkipBack size={12} />
          <span className="flex h-[22px] w-[22px] items-center justify-center rounded-full" style={{ background: ctx.overText, color: '#111' }}>
            {playing ? <Pause size={11} /> : <Play size={11} />}
          </span>
          <SkipForward size={12} />
          <Volume2 size={12} className="ml-auto" />
          <div className="h-[3px] w-[26%] overflow-hidden rounded-full" style={{ background: toRgba(ctx.overText, 0.22) }}>
            <div className="h-full w-3/5 rounded-full" style={{ background: toRgba(ctx.overText, 0.7) }} />
          </div>
        </div>
      </div>

      {/* 右栏：逐词歌词列（真机当前行锚在 41% 高、非当前行 ×0.87；7 行窗口能填满整栏）。
          竖向留白按**横版**盒收紧：原来是 `top 15% / bottom 20%`（竖长盒够用），
          横过来只有 169px 高，7 行 + 4% 行距要 234px → 首尾两行会被裁掉。
          现在 12%/14% + 1.5% 行距，给到 192px、实测刚好装下。 */}
      <div className="z-10 flex flex-col justify-center gap-[1.5%]" style={{ position: 'absolute', left: '44%', right: '6%', top: '12%', bottom: '14%' }}>
        {ctx.rows.map(row => (
          <ColumnLyricRow key={row.key} ctx={ctx} row={row} scale={0.87} />
        ))}
      </div>

      {/* 左下页脚：回到主页 + 一排 chip（摩登模式不用全局控件条，页脚自带） */}
      <div className="z-20 flex items-center gap-1.5" style={{ position: 'absolute', left: '5%', bottom: '4%' }}>
        <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full border border-white/15 bg-black/25" style={{ color: toRgba(ctx.overText, 0.8) }}>
          <Home size={10} />
        </span>
        {['翻译', '罗马音', 'MV', '设置'].map(label => (
          <span key={label} className="rounded-full border border-white/12 bg-black/25 px-2 py-1" style={{ color: toRgba(ctx.overText, 0.7), fontSize: 8 }}>
            {label}
          </span>
        ))}
        <MessageCircle size={11} style={{ color: toRgba(ctx.overText, 0.55) }} />
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ *
 * ⑦ video（看歌）：MV 画幅 + 底部字幕
 * ------------------------------------------------------------------ */
export function VideoScene({ ctx }: PreviewSceneProps) {
  const current = ctx.currentRow ?? ctx.rows[1]
  return (
    <>
      {/* 16:9 影片画幅：上下留黑边（letterbox），歌词压成字幕 */}
      <div className="z-10" style={{ position: 'absolute', left: 0, right: 0, top: '22%', height: '56%', background: 'rgba(0,0,0,0.55)' }}>
        <div
          className="absolute inset-0"
          style={{ background: `linear-gradient(120deg, ${toRgba(ctx.accentColor, 0.42)} 0%, rgba(0,0,0,0.5) 62%, ${toRgba(ctx.accentColor, 0.24)} 100%)` }}
        />
        <div className="absolute right-2 top-2 rounded border border-white/25 px-1.5 py-0.5 text-[8px] tracking-widest text-white/70">MV</div>
        <div className="absolute inset-x-0 bottom-3 flex justify-center">
          <GlyphText
            text={current?.text ?? ''}
            progress={current?.progress ?? 0}
            wordByWord={ctx.wordByWord}
            sungColor="#ffffff"
            dimColor="rgba(255,255,255,0.45)"
            textShadow="0 2px 10px rgba(0,0,0,0.8)"
            style={{ fontSize: Math.round(ctx.lyricPx * 0.95), fontWeight: 600 }}
          />
        </div>
      </div>

      <BottomPlayerBar ctx={ctx} />
      <MiniRail ctx={ctx} />
      <CornerSongInfo ctx={ctx} />
    </>
  )
}

/**
 * 模式 → 场景。`folia` 是独立页面（有自己的设置界面），
 * 这里退回现代版式；`video`（看歌）单独一版。
 */
export const PREVIEW_SCENES = {
  modern: ModernScene,
  immersive: ImmersiveScene,
  wallpaper: WallpaperScene,
  glorious: GloriousScene,
  multidimensional: MultidimensionalScene,
  modeng: ModengScene,
  video: VideoScene,
  folia: ModernScene,
} as const

export type PreviewSceneKey = keyof typeof PREVIEW_SCENES
