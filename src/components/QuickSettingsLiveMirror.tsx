import { useLayoutEffect, useRef } from 'react'

/**
 * 「播放设置」预览的**实时镜像**层 —— 预览不再另画一套抽象画面，而是把**真实播放页**
 * （`[data-waveforge-playback-layer]`，App 里的简约模式层，**含** MV 视频背景等兄弟层 ——
 * 它们是播放面 `minimal-playback-surface` 的兄弟节点，只克隆播放面的话预览背景就缺一整块）
 * 克隆一份搬进预览框，并按帧同步内联样式、文本与 canvas 像素。预览因此**就是真机**：
 * 改设置、歌词滚动、频谱跳动、封面律动、MV 画面全部实时跟着变，永远不会和真机漂移。
 *
 * ## 为什么是「克隆 + 逐帧同步」而不是别的做法
 *
 * - **不能把真身搬进来**：真身是 React 管理的节点，reparent 会破坏 React 的 bookkeeping。
 * - **不能就地 transform 真身**：真身是 framer 的 `motion.div`，`style.transform` 归 framer 管，
 *   外部写会被下一次渲染覆盖；改 `#root` 的 transform 又会连带缩放整个 App。
 * - **不能留着真身在原地、只在预览处开个「洞」看过去**：那要给遮罩与面板都开 clip-path 洞，
 *   面板圆角会被顶掉，洞的位置还得随面板布局实时重算。
 *
 * 克隆 + 逐帧同步完全没有上述副作用：自包含、不碰全局布局、不碰 React 树。
 *
 * ## 同步机制（改这里之前务必读完）
 *
 * **绝对不能「每隔 N 毫秒整棵重建」**。重建会让克隆体里的 CSS 动画每次都从第 0 帧重来 ——
 * 封面律动、频谱条这类无限 keyframes 会看起来卡在起始帧，歌词的入场过渡也会被反复重播，
 * 比静态画面还难看。所以按**变更类型**分三档处理，只有真·结构变化才动 DOM：
 *
 * | 变更 | 来源 | 处理 |
 * |---|---|---|
 * | `attributes`（style / class） | 歌词 rAF 逐帧写 `el.style.color`、切 class | 只把内联 style / class 抄到配对节点 |
 * | `characterData` | **React 更新文本走的是 `node.nodeValue`**（时钟、歌名、倒计时） | 只抄 `nodeValue` |
 * | `childList` | 整块增删（歌词行切换、模式切换） | **只重建该元素的子节点**，其余子树原样保留 |
 *
 * 配对表 `pairs` 覆盖 `childNodes`（元素 + 文本节点），由 `pairTree()` 递归建立。
 * 逐帧代价是 O(变更节点数)，不是 O(整棵树)。
 *
 * ## 已知取舍
 *
 * - `<video>` / `<audio>` / `<iframe>` 会**断源**（否则预览里会再拉一次流、甚至再出一路声音），
 *   其中 `<video>` 额外换成一枚同款式的 `<canvas>`，逐帧 `drawImage` 抄真身视频的画面 ——
 *   MV / 视频背景因此照常实时显示，只是不出声。canvas 复制依赖同源像素（B站 CDN 的
 *   视频经本地代理转发，无跨域污染；被污染时按帧 try/catch 跳过）。
 * - 用 WebGL 且未开 `preserveDrawingBuffer` 的 canvas 复制不到像素（本项目
 *   `ModernAudioVisualizer` / `ModengPlayerPage` 都是 2d，正常可复制）。
 * - 克隆体打 `inert` + `aria-hidden`，宿主 `pointer-events: none`：预览是「看」的、不能点，
 *   也不能进可访问性树（否则会多出一个「播放设置」按钮，和无障碍/测试的角色查询打架）。
 * - 克隆体里会清掉几个**会「冒充真身」的标记与 id**（见 `STRIP_*`）：它们在别处是被
 *   `querySelector` / `getElementById` 当唯一实体用的，尤其 `data-waveforge-playback-page`
 *   留着的话镜像会认到自己的克隆体上。
 * - 缩放用 `min(盒宽/源宽, 盒高/源高)` **等比**，宁可有留边也不拉伸 —— 预览的比例必须与真机一致。
 *
 * 拿不到真实播放页时（jsdom 单测、简约模式层未挂载的 home 页等）
 * 上报 `onStatusChange('absent')`，由父级回退到内置的模拟场景。
 */
export type QuickSettingsMirrorStatus = 'live' | 'absent'

/** 镜像源 = 整个播放页模式层（含 MV 视频背景等兄弟层；见 App.tsx 的 data-waveforge-playback-layer）。 */
const SOURCE_SELECTOR = '[data-waveforge-playback-layer="true"]'

/** 克隆体里必须清掉的属性：别处按它们查「唯一实体」。 */
const STRIP_ATTRIBUTES = ['data-waveforge-playback-layer', 'data-waveforge-playback-page', 'data-wf-upnext-card']

/** 克隆体里必须清掉的 id 前缀：`wf-` 是本项目锚点约定（墙纸/辉煌控件锚点）。 */
const STRIP_ID_PREFIX = 'wf-'

/** 每 N 帧做一次「源是否被换掉 / 尺寸是否变了」的低频巡检（约 4 次/秒）。 */
const SOURCE_POLL_FRAMES = 15

/** canvas 像素复制的分频：频谱条不需要 60fps，隔帧抄一次足够跟手。 */
const CANVAS_COPY_EVERY = 2

interface QuickSettingsLiveMirrorProps {
  /** 源播放面是否存在；'absent' 时父级应回退到内置模拟场景。 */
  onStatusChange: (status: QuickSettingsMirrorStatus) => void
}

export default function QuickSettingsLiveMirror({ onStatusChange }: QuickSettingsLiveMirrorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const host = hostRef.current
    const stage = stageRef.current
    if (!host || !stage) return

    let source: HTMLElement | null = null
    let cloneRoot: HTMLElement | null = null
    let frame = 0
    let disposed = false
    let status: QuickSettingsMirrorStatus | null = null
    let sourceW = 0
    let sourceH = 0
    let hostW = 0
    let hostH = 0

    /** 源节点 → 克隆节点（元素 + 文本节点）；逐帧同步靠它定位。 */
    const pairs = new Map<Node, Node>()
    const canvasPairs: Array<[HTMLCanvasElement, HTMLCanvasElement]> = []
    /** 真身视频 → 克隆体里替它显示画面的 canvas（视频断源后由它逐帧抄画面）。 */
    const videoFrames: Array<[HTMLVideoElement, HTMLCanvasElement]> = []
    /** 内联 style / class 被改过的元素 */
    const dirtyAttrs = new Set<Element>()
    /** `childList` 变化过的元素：只重建它们的子节点 */
    const dirtyChildren = new Set<Element>()
    /** `characterData` 变化过的文本节点 */
    const dirtyText = new Set<CharacterData>()

    const report = (next: QuickSettingsMirrorStatus) => {
      if (status === next) return
      status = next
      onStatusChange(next)
    }

    const observer = new MutationObserver((records) => {
      for (const record of records) {
        if (record.type === 'attributes') {
          if (record.target instanceof Element) dirtyAttrs.add(record.target)
          continue
        }
        if (record.type === 'characterData') {
          if (record.target instanceof CharacterData) dirtyText.add(record.target)
          continue
        }
        if (record.target instanceof Element) dirtyChildren.add(record.target)
      }
    })

    /**
     * 递归消毒：清掉会冒充真身的标记与 id、停掉媒体元素。可作用于任意子树根
     * （首次建树与后续局部重建共用）。
     * `<video>` 断源后**就地换成 canvas**（返回替身）：预览里 MV 背景要照常显示，
     * 由视频帧复制循环逐帧抄真身画面 —— 只断声、不断画。
     */
    const sanitizeNode = <T extends Node>(node: T): T => {
      if (node instanceof Element) {
        for (const attr of STRIP_ATTRIBUTES) node.removeAttribute(attr)
        if (node.id && node.id.startsWith(STRIP_ID_PREFIX)) node.removeAttribute('id')

        const tag = node.tagName
        if (tag === 'VIDEO') {
          const media = node as unknown as HTMLMediaElement
          media.pause()
          media.removeAttribute('autoplay')
          for (const child of Array.from(node.querySelectorAll('source'))) child.remove()
          const frame = document.createElement('canvas')
          // 视频多半带 className/style（object-cover、blur 滤镜等），替身必须原样接住，
          // 否则画面比例/模糊就与真机对不上
          frame.setAttribute('style', node.getAttribute('style') ?? '')
          if (node.className) frame.setAttribute('class', node.className)
          frame.setAttribute('data-wf-mirror-video-frame', '')
          node.replaceWith(frame)
          return frame as unknown as T
        }
        if (tag === 'AUDIO') {
          const media = node as unknown as HTMLMediaElement
          media.pause()
          media.removeAttribute('src')
          media.removeAttribute('autoplay')
          for (const child of Array.from(node.querySelectorAll('source'))) child.remove()
        } else if (tag === 'IFRAME') {
          // 断源即可：空 iframe 是透明的，比留一个正在加载的第二个播放器好得多
          node.removeAttribute('src')
        }
        for (const child of Array.from(node.children)) sanitizeNode(child)
      }
      return node
    }

    /** 递归建立「源 → 克隆」配对表，顺带收集需要逐帧抄像素的 canvas 对与视频帧替身。 */
    const pairTree = (srcNode: Node, dstNode: Node) => {
      pairs.set(srcNode, dstNode)
      if (srcNode instanceof HTMLCanvasElement && dstNode instanceof HTMLCanvasElement) {
        canvasPairs.push([srcNode, dstNode])
      }
      if (srcNode instanceof HTMLVideoElement && dstNode instanceof HTMLCanvasElement) {
        videoFrames.push([srcNode, dstNode])
      }
      const srcChildren = srcNode.childNodes
      const dstChildren = dstNode.childNodes
      const count = Math.min(srcChildren.length, dstChildren.length)
      for (let index = 0; index < count; index += 1) {
        pairTree(srcChildren[index], dstChildren[index])
      }
    }

    const rebuildPairs = () => {
      pairs.clear()
      canvasPairs.length = 0
      videoFrames.length = 0
      if (source && cloneRoot) pairTree(source, cloneRoot)
    }

    /** 按预览框尺寸给舞台定标：**等比**缩放 + 居中（宁可有留边，也不拉伸变形）。 */
    const layout = () => {
      const nextHostW = host.clientWidth
      const nextHostH = host.clientHeight
      if (!nextHostW || !nextHostH || !sourceW || !sourceH) return
      hostW = nextHostW
      hostH = nextHostH
      const scale = Math.min(hostW / sourceW, hostH / sourceH)
      stage.style.transform = `translate(${(hostW - sourceW * scale) / 2}px, ${(hostH - sourceH * scale) / 2}px) scale(${scale})`
    }

    /** 整棵重建：只用于首次挂载、源被换掉、源尺寸变了以外的结构崩坏。 */
    const build = () => {
      observer.disconnect()
      dirtyAttrs.clear()
      dirtyChildren.clear()
      dirtyText.clear()
      pairs.clear()
      canvasPairs.length = 0
      videoFrames.length = 0
      stage.replaceChildren()

      const next = document.querySelector<HTMLElement>(SOURCE_SELECTOR)
      if (!next) {
        source = null
        cloneRoot = null
        // 清掉上一次定标留下的尺寸/位移，避免空舞台留下残留样式
        stage.style.width = ''
        stage.style.height = ''
        stage.style.transform = ''
        report('absent')
        return
      }
      source = next
      cloneRoot = null

      const root = sanitizeNode(next.cloneNode(true) as HTMLElement)
      root.setAttribute('inert', '')
      root.setAttribute('aria-hidden', 'true')
      // 真身的入场动画（framer 写的内联 transform/opacity/filter）可能停在半路，
      // 克隆体要停在静止态；后续帧的同步会再把它抄成真身当时的真实值。
      root.style.transform = 'none'
      root.style.opacity = '1'
      root.style.filter = 'none'

      sourceW = next.offsetWidth || window.innerWidth
      sourceH = next.offsetHeight || window.innerHeight
      stage.style.width = `${sourceW}px`
      stage.style.height = `${sourceH}px`
      stage.replaceChildren(root)
      cloneRoot = root
      pairTree(next, root)
      layout()

      observer.observe(next, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeFilter: ['style', 'class'],
      })
      report('live')
    }

    /**
     * 只重建某个元素的子节点（`childList` 变化）。
     * **不整棵重建**是刻意的：整棵重建会把无关子树的 CSS 动画全部从头播一遍。
     * 重建后要重扫这对子树的视频替身 —— 新克隆出来的 `<video>` 同样要换 canvas 并
     * 进帧复制表，否则局部重建过的区域里 MV 会退回黑洞。
     */
    /**
     * 子树的「视觉签名」：文本内容 + 字级内联颜色按序拼接。
     * React 重渲染常把同一份文本拆成全新的一组节点（key 变化 / 结构微调），
     * textContent 不变——这类重建对预览视觉零影响。但 folia 的逐字卡拉OK颜色
     * 也是经 span 重建携带的（wordColoring 每拍换色），所以签名必须包含
     * 内联 color：颜色没变 → 跳过重建（消除每帧鬼畜）；颜色变了 → 正常重建
     * （每拍一次，视觉连续）。
     */
    const visualSignature = (node: Node): string => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? ''
      if (!(node instanceof Element)) return ''
      // 签名纳入所有会随播放/设置变化的本节点内联视觉属性：
      // color（逐字卡拉OK填色）、fontSize/fontWeight（字幕缩放设置）、
      // opacity/transform（淡入淡出与逐字位移动画）、background（填充层）。
      const style = (node as HTMLElement).style
      let out = ''
      for (const prop of ['color', 'fontSize', 'fontWeight', 'opacity', 'transform', 'background', 'width', 'height']) {
        const value = style ? (style as unknown as Record<string, string>)[prop] : ''
        if (value) out += `${prop}=${value}`
      }
      for (const child of node.childNodes) out += visualSignature(child)
      return out
    }

    const resyncChildren = (srcElement: Element) => {
      const dstElement = pairs.get(srcElement)
      if (!(dstElement instanceof Element)) return false
      // 守卫：源与克隆体的视觉签名一致 → 文本和字色都没变，只是节点被 React
      // 拆了重建。跳过 replaceChildren（重建会让克隆体歌词行每帧白闪一次）。
      if (visualSignature(srcElement) === visualSignature(dstElement)) return true
      const rebuilt: Node[] = []
      for (const child of Array.from(srcElement.childNodes)) {
        rebuilt.push(sanitizeNode(child.cloneNode(true)))
      }
      dstElement.replaceChildren(...rebuilt)
      // 立即重扫这对子树，让后续 attributes/characterData 同步拿得到新配对；
      // 紧随其后的 rebuildPairs() 会整树清表重扫（覆盖这里的结果），冗余但无害
      pairTree(srcElement, dstElement)
      return true
    }

    /** 剔除被更外层元素覆盖的项：先处理最外层，避免拿着已被替换掉的旧节点去同步。 */
    const outermostOnly = (candidates: Set<Element>) => Array.from(candidates).filter((element) => {
      let parent = element.parentElement
      while (parent) {
        if (candidates.has(parent)) return false
        parent = parent.parentElement
      }
      return true
    })

    const syncDirty = () => {
      // ① 结构（先做：它会改变配对表）
      if (dirtyChildren.size > 0) {
        const targets = outermostOnly(dirtyChildren)
        dirtyChildren.clear()
        let intact = true
        for (const element of targets) {
          if (!resyncChildren(element)) intact = false
        }
        if (!intact) {
          build()
          return
        }
        rebuildPairs()
      }
      // ② 文本
      if (dirtyText.size > 0) {
        for (const srcText of dirtyText) {
          const dstText = pairs.get(srcText)
          if (dstText instanceof CharacterData && dstText.nodeValue !== srcText.nodeValue) {
            dstText.nodeValue = srcText.nodeValue
          }
        }
        dirtyText.clear()
      }
      // ③ 内联 style / class
      if (dirtyAttrs.size > 0) {
        for (const srcElement of dirtyAttrs) {
          const dstElement = pairs.get(srcElement)
          if (!(dstElement instanceof Element)) continue
          const style = srcElement.getAttribute('style')
          if (style !== dstElement.getAttribute('style')) {
            if (style === null) dstElement.removeAttribute('style')
            else dstElement.setAttribute('style', style)
          }
          const className = srcElement.getAttribute('class')
          if (className !== dstElement.getAttribute('class')) {
            if (className === null) dstElement.removeAttribute('class')
            else dstElement.setAttribute('class', className)
          }
        }
        dirtyAttrs.clear()
      }
    }

    /** canvas 像素复制：频谱条这类画在 canvas 上，DOM 克隆只能拿到空画布。 */
    const copyCanvases = () => {
      for (const [srcCanvas, dstCanvas] of canvasPairs) {
        if (!srcCanvas.isConnected || !dstCanvas.isConnected) continue
        if (srcCanvas.width !== dstCanvas.width) dstCanvas.width = srcCanvas.width
        if (srcCanvas.height !== dstCanvas.height) dstCanvas.height = srcCanvas.height
        const context = dstCanvas.getContext('2d')
        if (!context) continue
        try {
          context.clearRect(0, 0, dstCanvas.width, dstCanvas.height)
          context.drawImage(srcCanvas, 0, 0, dstCanvas.width, dstCanvas.height)
        } catch {
          // 画布被跨域资源污染等情况：跳过这一帧，不影响其余同步
        }
      }
    }

    /**
     * 视频帧复制：真身 `<video>`（MV 背景）的断源替身 canvas 逐帧抄它的当前画面。
     * 分辨率对齐视频的固有尺寸（宽高 0 时尚未出画，跳过）；跨域污染按帧跳过。
     * 视频是 `muted` 播放，替身只抄画面不出声 —— 预览看得到 MV、也绝不会多一路声音。
     */
    const copyVideoFrames = () => {
      for (const [video, frame] of videoFrames) {
        if (!video.isConnected || !frame.isConnected) continue
        const width = video.videoWidth
        const height = video.videoHeight
        if (!width || !height) continue
        if (frame.width !== width) frame.width = width
        if (frame.height !== height) frame.height = height
        const context = frame.getContext('2d')
        if (!context) continue
        try {
          context.clearRect(0, 0, width, height)
          context.drawImage(video, 0, 0, width, height)
        } catch {
          // 视频被跨域资源污染：跳过这一帧
        }
      }
    }

    let rafId = 0
    const schedule = () => {
      if (disposed) return
      rafId = requestAnimationFrame(tick)
    }

    const tick = () => {
      if (disposed) return
      frame += 1

      if (frame % SOURCE_POLL_FRAMES === 0) {
        const current = document.querySelector<HTMLElement>(SOURCE_SELECTOR)
        if (!current || current !== source) {
          build()
          schedule()
          return
        }
        if (current.offsetWidth !== sourceW || current.offsetHeight !== sourceH) {
          sourceW = current.offsetWidth
          sourceH = current.offsetHeight
          stage.style.width = `${sourceW}px`
          stage.style.height = `${sourceH}px`
          layout()
        }
        if (host.clientWidth !== hostW || host.clientHeight !== hostH) layout()
      }

      syncDirty()
      if (frame % CANVAS_COPY_EVERY === 0) {
        copyCanvases()
        copyVideoFrames()
      }
      schedule()
    }

    build()
    schedule()

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => layout())
    resizeObserver?.observe(host)

    return () => {
      disposed = true
      cancelAnimationFrame(rafId)
      observer.disconnect()
      resizeObserver?.disconnect()
      stage.replaceChildren()
      pairs.clear()
      canvasPairs.length = 0
      videoFrames.length = 0
    }
  }, [onStatusChange])

  return (
    <div
      ref={hostRef}
      data-wf-qs-mirror=""
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div
        ref={stageRef}
        className="absolute left-0 top-0"
        style={{ transformOrigin: '0 0', contain: 'layout paint' }}
      />
    </div>
  )
}
