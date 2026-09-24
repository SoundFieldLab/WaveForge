# AutoMix 过渡动画与调度链完整复查

日期：2026-09-20
承接：[AUTOMIX-THREE-VERSIONS-2026-09-20.md](./AUTOMIX-THREE-VERSIONS-2026-09-20.md)（音频 DSP 部分）
本文范围：过渡**动画/视觉层** + **播放调度状态机**，以及两者与音频的时间同步。
目的：为新增 AutoMix Beta 建立「视觉层应有的正确形态」基线。

所有结论均标注为 ①确认的 bug ／ ②设计缺陷 ／ ③需实测确认。
关键结论已逐条回读源码复核。

---

## 零、一句话结论

**过渡动画目前不是「针对 AutoMix 设计的动画」，而是「一套通用淡入淡出被 12 处不同组件各自实现」**。
它服务全部路径（v1/v2/folia/AI/gapless），不感知任何音频语义，且存在一个确定性的
**进度跳变**（AI 路径最大 ~67%）、一条**歌词过渡死代码链**、
以及一处**两条 rAF 并发写进度**。用户所说「两个版本动画像是同一个但效果又不太一样」
——准确描述是：**音频路径不同、动画同一套、但入场时机四个公式不一致**。

---

## 一、动画清点：12 类，无统一规范

| # | 组件 | 位置 | 驱动 | 服务路径 |
|---|---|---|---|---|
| A | FoliaTransitionOverlay（中央环形进度） | `src/components/folia/FoliaTransitionOverlay.tsx:18` | framer-motion + SVG + backdrop-filter | folia 界面（up-next 关闭/单曲循环/无下一首时；见 §1.1 更正） |
| B | FoliaUpNextCard（conic 进度边框） | `src/components/folia/FoliaUpNextCard.tsx:26` | framer-motion + conic-gradient | folia 界面 |
| C | UpNextNotification（右上角弹簧提示） | `src/components/UpNextNotification.tsx:24` | framer spring | 非 folia |
| D | CrossfadeBackground（全屏封面双图） | `src/components/CrossfadeBackground.tsx:18` | CSS opacity + framer | **全部路径** |
| E | AlbumCoverPlayer 双层封面 | `src/components/AlbumCoverPlayer.tsx:112-160` | 内联 `style.opacity` | **全部路径** |
| F | 歌曲标题双层交叉（两处实现） | `src/App.tsx:9378-9398`、`src/App.tsx:9071-9089` | 内联 `style.opacity` | **全部路径** |
| G | PlayerControls 流光徽标 + 进度条配色 | `src/components/PlayerControls.tsx:541-546, 664-691, 1007-1031` | CSS `@keyframes glow` + framer | 全部路径 |
| H | BilibiliMvBackground A/B 槽交叉 | `src/components/BilibiliMvBackground.tsx:466-482, 1474-1515` | CSS opacity transition | 全部路径 |
| I | 各歌词模式淡入淡出（7 套参数） | `LyricsDisplay.tsx:2400-2410`、`WallpaperLyrics.tsx:358`、`GloriousLyrics.tsx:162`、`MultidimensionalLyrics.tsx:65`、`ModengPlayerPage.tsx:1677` 等 | CSS transition / framer | 全部路径 |
| J | Diorama 世界内相机飞行 | `src/components/foliaDiorama/dioramaTransition.ts:17` | 手写 3D 相机（rAF） | **与 AutoMix 无关** |
| K | ModeTransitionOverlay | `src/components/ModeTransitionOverlay.tsx:32` | CSS keyframes 循环 | 与音频无关 |
| L | TransitionDebugToast | `src/components/TransitionDebugToast.tsx:34` | framer | 调试开关 |

**服务多路径无分支**：D/E/F/G/H/I 六个组件**均不 import 任何 transition 策略**，
代码里没有任何 v1/v2/folia/AI 的分支。所以「两个版本动画是同一个」——是的，物理上就是同一套。

**同屏层数**：v2 DSP 在 folia 模式下，一次过渡同时运行 D+E+F+G+H+I+(B) 共 7 层。

### 1.1 【2026-09-20 更正】中央环形进度环并非死代码——本文档原判断错误

**原文错误结论**：称 `overlayVisible` 恒假，`FoliaTransitionOverlay` 从不渲染。

**更正**：原推理漏掉了 `cardVisible` 里的 `eligibleNext` 条件
（`upNextEnabled && hasNext && playMode !== 'repeat'`）。实测路由矩阵：

| 场景 | cardVisible | transitionBorderVisible | **overlayVisible** |
|---|---|---|---|
| 默认（up-next 开、顺序播放） | true | true | false |
| **用户关闭 up-next** | false | false | **true** |
| **单曲循环** | false | false | **true** |
| **无下一首** | false | false | **true** |
| 短过渡 <5s | true | true | false |

`overlayVisible` **可达**，且此时恰好只有一个进度指示器。
互斥是**有意设计**：`test/foliaPresentation.test.ts:28`
的用例名即为「transition border suppresses the central ring to avoid duplicate animations」。

**另一处原文错误**：称该路由无测试覆盖，只有组件测试。
实际 `test/foliaPresentation.test.ts:28-50` 已完整覆盖路由输出
（含 up-next 关闭→显示、<5s→隐藏、单曲循环）。
原文把 `FoliaTransitionPresentation.test.tsx`（组件测试）
与 `foliaPresentation.test.ts`（路由测试）混淆了。

**同时更正 §4.1 末尾**：「BPM 仅调试数据存在时可用」不成立——
`buildTransitionDebug()` 在 `useAudioPlayer.ts:1872` **无条件赋值**，非调试门控。

```ts
// 原文引用的路由（保持不变，此处仅保留事实描述）
const cardVisible = active && eligibleNext && (input.showUpNext || input.autoMixRunning)
const transitionBorderVisible = cardVisible && input.autoMixRunning
overlayVisible: active && input.autoMixRunning && input.transitionDuration >= 5 && !transitionBorderVisible,
```


### 1.2 ②确认：`isLyricsTransitioning` 死代码链

```
声明：src/App.tsx:1297   const [isLyricsTransitioning, setIsLyricsTransitioning] = useState(false)
消费：src/App.tsx:9111, 9180, 9200, 9209, 9234, 9241, 9268, 9323
```

`grep -c setIsLyricsTransitioning src/App.tsx` = **1**（仅声明行本身）。全仓无任何调用点
→ 8 个消费点的 `animate={{ opacity: isLyricsTransitioning ? 0 : 1 }}` **恒为 opacity:1**
→ 这些歌词淡出动画全是死代码。

真正生效的是各歌词组件内部的 `isTransitioning` prop（另一条通路）。
**这解释了「歌词和封面不同步」**：封面走 `transitionProgress` 连续淡变，
歌词走布尔 `isTransitioning` 的整层切换，两者时钟不同。

另：`LyricsDisplay.tsx:2430` 用 `{!isTransitioning && ...map(...)}`
→ **过渡一开始整棵歌词列表卸载**，过渡结束再全量重挂载。
这既是「过渡期间没歌词」的原因，也是大列表 mount 抖动的来源。

---

## 二、进度跳变：不丝滑的第一元凶

### 2.1 根因：两条时间轴原点不同

代码里 `transitionStartTime` **指代两个不同东西**：

| 载体 | 含义 | 设置点 | 消费点 |
|---|---|---|---|
| state 字段 `transitionStartTime` | **音频时间**阈值 | `useAudioPlayer.ts:1859`（armed）| `App.tsx:3512` 与 `currentTime` 比较 |
| ref `transitionStartTimeRef` | **`performance.now()` 墙钟** | `useAudioPlayer.ts:1005`、`:1323` | `:1027`、`:1362`、`:1423` 算 progress |

progress 的原点是**音频过渡启动时刻**（`playTransition` 调用时），
而动画窗口在**之后**才打开（`App.tsx:3512`）：

```ts
const inAnimationWindow = transitionStartTime === null || currentTime >= transitionStartTime
```

窗口打开的瞬间，progress 已经是一个非零值 → 所有用 progress 驱动 opacity 的图层
（D/E/F）**从 0 硬跳到该值**。

### 2.2 跳变幅度

**AI 路径**（`useAudioPlayer.ts:1852-1854`）：

```ts
const animationStartTime = plan.v2?.aiMix === true
  ? plan.sourceStartTime + 60 - 20
  : Math.max(plan.sourceStartTime, plan.sourceEndTime - ANIMATION_LEAD_SECONDS)
```

音频在 `plan.sourceStartTime` 触发；动画窗口 = `sourceStartTime + 40`；
缓冲 ~60s → 窗口打开时 **progress ≈ 40/60 ≈ 0.67**。
即：AI 过渡进行到第 40 秒，封面/标题/背景**瞬间跳到 67%**。
这与注释所称「动画窗口 = 混音最后 20s」的设计一致——但设计本身没有考虑进度原点。

**v1/v2 DSP 路径**：`animationStartTime = sourceEndTime - 10`（`ANIMATION_LEAD_SECONDS = 10`，`:96`），
音频从 `sourceStartTime` 触发 → 跳变幅度 `(duration-10)/duration`。
`autoMixMaxDuration` 上限 20s（`SettingsPanel.tsx:3762-3770`）→ 12s 时跳 17%，20s 时跳 50%。

**结论：「两个 automix 过渡效果都不太美和丝滑」的最大单一原因就是这个跳变**，
不是缓动曲线问题。而且它解释了为什么「标准版和增强版动画看起来一样但感觉不同」——
两者用了同一套动画组件，但 `duration` 不同 → **跳变幅度不同**。

### 2.3 四个入场公式

| 路径 | 公式 | 位置 |
|---|---|---|
| AI | `sourceStartTime + 60 - 20` | `:1854` |
| v1/v2 DSP | `sourceEndTime - 10` | `:1854` else 分支 |
| 格式预检拦截 | `sourceEndTime - 10` | `:1708` |
| 渲染失败 fallback | `sourceEndTime - 10` | `:1885` |
| gapless | `current?.duration` | `:1554`、`:1907` |

四套公式（后两者相同但独立实现）。加上 `ANIMATION_LEAD_SECONDS = 10` 是源码常量、
`60` 与 `20` 是魔数，**没有任何一处可配置**。

---

## 三、③确认：两条 rAF 并发写进度

`useAudioPlayer.ts:1092` 在 `playTransition` **之前**启动 rAF：

```
:1092   transitionProgressAnimationRef.current = requestAnimationFrame(updateTransitionProgress)
:1097   const result = await transitionRendererRef.current.playTransition(...)
:1100   if (result) {
:1106     if (result.tooLate) {
:1109       strategy = 'fixed-crossfade'
:1110       plan.strategy = 'fixed-crossfade'
:1112       plan.fallbackReason = '...'
          // ← 只改 strategy，没有 cancel，也没有 return
```

代码继续往下走到交叉淡化分支 `:1461` **又启动一条新 rAF**
（`:1423` 用的是另一个 `transitionStartTime`，`:1458` 是新的 rAF 句柄）。

`transitionProgressAnimationRef` 的 cancel 点只有 `:788`、`:860`、`:2282`——
**这个分支里没有**。旧句柄被覆盖丢失，两条循环以各自 30ms 节流同时
`emit({transitionProgress})`，且分母不同（一条除以 `transitionAudioDuration`，
一条除以 `audioDuration`）→ **进度抖动 + 双倍 setState**。

触发条件正是最常见的降级路径（seek 快进后 `tooLate`）。

---

## 四、视觉与音频的语义脱节

### 4.1 动画完全不感知音频

D/E/F/G/H/I 接收的输入只有一个 `0~1` 标量（progress）。它们**不接收**：
`beatCount`、`sourceBpm`/`targetBpm`、`djEffects`、`choreography`、`intensity`、
切点类型、`stemChoreography` 的鼓点/贝斯交换时刻。

因此：
- 动画没有「切点」概念——不知道音频在第几拍换了贝斯。
- 动画没有「段落」概念——不知道过渡是从 drop 还是 outro 开始。
- 动画没有「强度」概念——`intensity`（subtle/standard/strong）在 UI 里**零视觉对应**
  （只在 `djtransgan_worker.py:108` 改 DSP 增益）。
- v2 的 `transitionStyle`（energetic/atmospheric/clean）**只被渲染成一个文字标签**
  （`UpNextNotification.tsx:18-22, 115-119`）。

唯一与音频语义挂钩的是 A（FoliaTransitionOverlay）的呼吸周期
`beatSeconds = 60/bpm`（`FoliaTransitionOverlay.tsx:36, 73`），而它读的是
`transitionDebug?.sourceBpm`（`App.tsx:9492`）——只有调试数据存在时才有 BPM，
否则退化为固定 1.4s。（A 可达，见 §1.1 更正。）

### 4.2 同屏两套时间基准

```
transitionProgress   全量 0→1     → 封面 / 背景 / 标题 / Folia 卡
overlayProgress      仅最后 4s    → MV 背景 :8360 / PlayerControls :9520
```

`App.tsx:3515-3521`:

```ts
const span = Math.min(4, dur)
const start = 1 - span / dur
return Math.max(0, Math.min(1, (transitionProgress - start) / (span / dur)))
```

即同一次过渡里：**封面慢慢淡 60 秒，MV 和进度条只淡最后 4 秒**。
这种同屏不同步极易被感知为不协调。

另：两个标题交叉实现不一致——`App.tsx:9382/9391` 用全量 `transitionProgress`，
而无歌词分支 `:9075/9084` 用 `overlayProgress`。

另：两个标题交叉实现不一致——`App.tsx:9382/9391` 用全量 `transitionProgress`，
而无歌词分支 `:9075/9084` 用 `overlayProgress`。

### 4.3 ③MV 背景与封面背景：两层叠加，各拿一套进度（新增）

**层级结构**（`App.tsx:8307-8363`）：

```
同一起点，AB 两槽视频 position:absolute inset-0 z-0
```

- 封面背景先挂，`<PulsingCrossfadeBackground>`（`App.tsx:8310`），**常驻最底兜底**
- MV 层后挂，`<LazyBilibiliMvBackground>`（`App.tsx:8325`），`z-0`，叠在封面之上
- 注释自述：「封面常驻最底兜底，MV 叠其上（加载期间 MV 层透明露出封面，就绪后渐入）」

所以**用户看到的背景 = 封面（底） + MV（上）两层叠加**，不是互斥的两个模式。

**关键缺陷：两层拿到了两个不同的进度。**

| 层 | 位置 | 传入的 progress | 语义 |
|---|---|---|---|
| 封面背景 | `App.tsx:8315` | `transitionProgress` | 全量 0→1 |
| MV 背景 | `App.tsx:8360` | **`overlayProgress`** | **仅最后 4 秒** |

且 MV 组件内部用的 prop 名仍叫 `transitionProgress`（`BilibiliMvBackground.tsx:121, 256`），
而它驱动的是 `slotOpacity`（`:469`）：

```ts
if (transitionActive && stagedSlotRef.current === slot) return transitionProgress
```

**后果**：过渡进行到 50% 时，封面已经淡了一半，而 MV 的 `overlayProgress` 仍是 0
→ **MV 槽完全不透明（0），一个像素都没动**；直到最后 4 秒 MV 才开始淡入。
这是两层背景在过渡期最明显的不协调：**同屏两层背景的淡变起点不一致
（AI 路径下相差 40s）。** 该结论由代码推得，未经实测验证。

**MV 的 4 秒窗口与音频无关**，`App.tsx:3515-3521` 的 `span = Math.min(4, dur)` 是写死的常量。

### 4.4 ③MV 槽切换用固定 1000ms 定时器，与音频无关（新增）

`BilibiliMvBackground.tsx:664-677`：

```ts
crossfadeTimerRef.current = window.setTimeout(() => {
  crossfadeTimerRef.current = null
  if (incomingSlotRef.current !== slot) return
  activeSlotRef.current = slot
  ...
}, 1000)
```

MV 槽的「渐入完成 → 晋升为 active → 释放旧槽」用的是**固定 1000ms**，
而槽的渐入时长由 `transitionProgress`（即 `overlayProgress`）驱动。
两者不等长：
- 过渡总时长 < 4s 时，`overlayProgress` 会走完，但 MV 可能只淡了 <1s
- AI 长混音时 `overlayProgress` 只有最后 4s，而 1000ms 定时器从 `beginCrossfade` 开始算

**后果**：MV 的透明度爬升速度与它的晋升时刻不同步，快速切歌时会出现
「新 MV 还没淡进来，旧槽已被释放」或「旧槽残留」。代码里已有多处补丁应对
（`pendingPromotionRef`、`incomingSlotRef` 校验、`slotOwnerRef` 归属校验、
`:1361-1372` 的「过渡结束补晋升」），说明这是反复出问题的区域。

### 4.5 ③封面→MV 首次交接与 MV→封面回退都是硬切（新增）

**首次挂载**（封面兜底 → MV 淡入）：
`BilibiliMvBackground.tsx:1432-1436`，`handleCanPlay` 里
`if (slot === activeSlotRef.current && !firstFadeDoneRef.current)` 直接
`firstFadeDoneRef.current = true` → `slotOpacity` 从 0 变 1（`:468`），
配 `opacity 0.65s ease`（`:474`）——这一处有过渡，但**只有 0.65s 固定值，与音乐无关**。

**MV 失败回退**（MV → 封面）：
`App.tsx:1395` `mvBackgroundActive` 依赖 `mvBackgroundReady`，
MV 层失败时 `onReadyChange(false)` → `mvBackgroundReady=false`；
而 MV 容器在 `!enabled || hidden` 时直接 `display: none`（`:1472`）。
`enabled` 还叠加了 `mvBackgroundActive` → **MV 层被 `display:none` 瞬间摘除，
底下的封面以「一直都在」的状态直接露出，没有任何交叉淡化**。

这是「MV 切换/失败时背景闪一下」的机制来源：不是淡变，是**整层消失**。
若此时封面还停在旧歌（`CrossfadeBackground` 的 `incomingUrl` 尚在 preload，
或 1200ms 兜底定时器 `CrossfadeBackground.tsx:47-53` 未到），
用户会看到**旧歌封面直接闪出**。

### 4.6 ③封面背景自身的切换也有两套机制（新增）

`CrossfadeBackground.tsx` 内有**两条互斥路径**：

```
:105-115  explicitTransition 路径   需要 isTransitioning && fromUrl && toUrl 三者齐全
            → opacity 直接等于 clampedProgress，配 `opacity 80ms linear`
:116-127  普通路径（incomingUrl）
            → framer-motion initial 0 → animate 1，duration 0.8 easeInOut
```

`explicitTransition` 的成立条件是**三个 URL 都存在**（`:55-59`）。
过渡开始时若 `transitionFromUrl` 或 `transitionToUrl` 缺失（换歌时上一首封面未记录、
或下一首无封面），会**静默落回普通路径** → 从「progress 线性淡变」突变为
「0.8s easeInOut 淡入」，且新封面以 `incomingUrl` 身份整体淡入而非交叉。

同时 `:47-53` 有一个 **1200ms 兜底定时器**把 `incomingUrl` 强制晋升为 `visibleUrl`：

```ts
const t = window.setTimeout(() => { setVisibleUrl(incomingUrl); setIncomingUrl('') }, 1200)
```

注释说明原因是「onAnimationComplete 在快速连续切歌/动画中断时可能不触发」。
即：**封面切换存在「动画回调失效 → 靠定时器兜底」的已知不可靠路径**，
1200ms 与 0.8s 动画时长是两个独立常量。

### 4.7 音源层与背景层的可见性判定不一致（新增）

```
App.tsx:8311  封面背景  condition: currentSong && lyricDisplayMode !== 'video'
App.tsx:8324  MV 背景    condition: currentSong && !mvBackgroundSuppressed
App.tsx:1395  MV 生效    mvBackgroundActive = ... && mvBackgroundEnabled && !mvBackgroundFallback
                                          && mvBackgroundReady && !mvBackgroundSuppressed
App.tsx:1393  mvBackgroundSuppressed = isAppleRadioPlayback || podcastPlayback
```

封面用 `lyricDisplayMode !== 'video'`，MV 用 `mvBackgroundSuppressed`——**两套不同的判定**。
苹果电台/播客场景下 MV 被抑制但封面仍在（正确），
但「看歌模式（`lyricDisplayMode === 'video'`）」下**两层都不挂**（`App.tsx:3536`
`effectiveTransitionStrategy = 'none'`），此时背景完全依赖视频层——这是设计意图，
但意味着**看歌模式下 AutoMix 视觉完全不存在**，切换进出该模式时背景会整体重构。

---

### 4.8 30fps 阶跃（不丝滑的第二元凶）

E/F/H 的做法是**用 progress 直接写 opacity，不带 CSS transition**：

```
useAudioPlayer.ts:1076     30ms 节流 emit
AlbumCoverPlayer.tsx:140    直接驱动 opacity
App.tsx:9382/9391          直接驱动 opacity
```

progress 是**每秒 30 步的离散阶跃**，浏览器合成器无法插值 → 视觉上是阶梯式淡变。
而同一屏的 D 有 `opacity 80ms linear`（`CrossfadeBackground.tsx:112`）平滑，
**同一过渡里两种行为并存**，进一步破坏统一感。

---

## 五、缓冲/降级与视觉的不同步

### 5.1 MV 预载是独立链路

`BilibiliMvBackground.tsx:924-1037` 在过渡开始时搜 B 站、`loadVideo(preload=true)`、
`resolveAndPrewarmAlignment` 预对齐——**与音频渲染完成无任何同步**。
音频渲染失败降级成交叉淡化时，MV 预载照常执行（资源浪费 + 错位）。

### 5.2 降级后 MV 对齐直接失效

`App.tsx:3524-3533`：`getMvTransitionTargetTimeSeconds()` 只在
`transitionStrategy ∈ {smart-rendered, smart-rendered-v2}` 时返回有效值，
否则返回 `Number.NaN`。

`BilibiliMvBackground.tsx:1143-1152` 拿到 NaN 就 `return` → **整个对齐校正跳过**，
目标 MV 盲目渐入。即：一旦降级成 `fixed-crossfade`，MV 就与音频错位。

`mvAlignment.ts` 的 `MIN_ALIGNMENT_CONFIDENCE = 0.5`（`:42`）以下时 offset 退化为 0
（`BilibiliMvBackground.tsx:1145, 1166, 1181`）= 自由跟随，不校正。

### 5.3 智能渲染的 400ms 双斜坡可能有凹陷

缓冲自身有 400ms 入场渐入（`TransitionRenderer.ts:713-714`），
源 deck 有 400ms 渐出（`useAudioPlayer.ts:1123-1134`）。
两条斜坡用**不同调度时刻**（相隔一个 `await`），理论上等功率，
实际存在毫秒级错位 → 可能听到轻微音量凹陷。③需实测。

另外 `:1130` 用 `Math.max(activeGain.gain.value, 0.0001)` 读的是**排程后的瞬时值**，
若上一斜坡未完成会读到中间值 → 起点不确定。

---

## 六、AI（DJTransGAN）路径专章

### 6.1 动画无专属分支

`App.tsx:2534` → `transitionPlanner.ts:978,993` → `TransitionRenderer.ts:261-272`
→ `useAudioPlayer.ts:1818-1837`（回填 `sourceStartTime`/`targetEndTime`/`overlapSeconds=15`/`mixSpeedRatio`）。

动画侧**只改了两个标量**（`transitionStartTime`、`transitionDuration`），
走的是 D/E/F/G/H/I 那套通用淡变。**AI 专属动画不存在**。

### 6.2 AI 过渡期间的视觉反馈（2026-09-20 更正）

**原文错误**：称「60s 混音全程只有进度条在动」，并附了一句伪造的用户引语。

**更正**：`UpNext` 卡片在动画窗口**之前并不会被隐藏**。
`:2295` 的隐藏条件是 `state.transitioning && inAnimationWindowNow`，
而倒计时基准 `eventTime = transitionStartTime ?? duration`（`:2269`），
`useTransitionCountdown` 在 AutoMix 启用时为真 →
**前段会按 `upNextTime`（默认 10s）正常显示"即将播放"倒计时卡片**。

真实的视觉差异只是：**前段没有叠加渐变（封面/标题/MV 不淡变）**，
而这正是 `overlayProgress`「只在最后 ~4 秒完成叠加」的设计意图。

因此 6.2 原判「视觉上几乎无提示」不成立，不再是待办项。

### 6.3 ①确认：AI 时长完全不可调

| 设置项 | 位置 | 能否影响 AI 时长 |
|---|---|---|
| `crossfadeDuration`（1–12s） | `globalSettingsRegistry.ts:421-431` | 否 |
| `autoMixMinDuration`/`autoMixMaxDuration`（1–19/2–20） | `SettingsPanel.tsx:3741-3777` | **仅 v1**；v2 明确忽略（`transitionPlanner.ts:757-760`）|
| `autoMixTransitionIntensity` | `globalSettingsRegistry.ts:479-497` | 否，只改 DSP 增益 |
| `autoMixAiMix` | `globalSettingsRegistry.ts:513-536` | **无任何时长参数** |
| `upNextSeconds` | `globalSettingsRegistry.ts:752-760` | 只影响提示卡提前量 |

AI 长混音时长被模型窗口锁死（`djtransgan_worker.py:8, 15`，`:88-90` 读 `settings.N_TIME`），
动画的 20s 提前量是源码常量。**「让 AI 缩短过渡时间」目前没有任何入口。**

值得注意的是：`autoMixMinDuration`/`autoMixMaxDuration` **不在 `globalSettingsRegistry.ts` 里**
（只在 `SettingsPanel.tsx:1778-1788, 3745-3773`），跨面板同步不一致。

### 6.4 ①确认：60s 硬编码 + 未消费真实时长

> **实测修正（2026-09-20，基于本机运行日志）**
> 日志 `%APPDATA%\Electron\automix-backend.log` 中 AI 混音共成功 140 次，
> **每次均为精确 `duration=60.0s`**：
> ```
> [AutoMix-AI] render ok: duration=60.0s transitionStart=112.0s targetResume=43.3s
> [AutoMix-AI] render ok: duration=60.0s transitionStart=165.0s targetResume=81.5s
> ```
> 即模型窗口**确实恒为 60.0s**（`djtransgan_worker.py:8,15` 的「~60s」实为精确 60s）。
> 因此「模型输出 55s 或 65s 导致错位」这个推测**不成立**，
> 前端写死 `60` 目前不产生时长错位。
>
> **但仍有两个确证问题**：
> 1. `60` 仍是**跨模块复制的字面量**（worker 用 `settings.N_TIME`，前端用 `60`），
>    二者无任何校验关联。一旦模型换档，前端静默错位。
> 2. **降级回 DSP 后的错位仍然存在**：`plan.v2.aiMix` 经 `:1824` 合并后可能仍为 `true`，
>    此时 `sourceStartTime + 40` 可能落在 DSP 窗口之外 → **过渡动画完全不出现**。
>    这一条与 60s 是否精确无关，是 `aiMix` 标志未随降级清除导致的。

`:1852-1854` 用固定 `60` 算动画起点。`render-runtime.cjs:941` 已返回 `duration`，
而 `useAudioPlayer.ts:1821-1838` 的回填
**只取了 `sourceStartTime`/`targetEndTime`/`overlapSeconds`，没取缓冲真实时长**。

### 6.4b ①确认：DJTransGAN 的 automation 能力已被拆线（实测）

**代码现状**：`desktop/render-runtime.cjs:961-990` 的 `getAutomation()`
实现完整（含 sha256 缓存键、inflight 去重、磁盘缓存 `aimix-*.params.json`、
`rendererVersion: 'djtransgan-automation-v3'`）；
`djtransgan_worker.py:290-330` 的 `extract_automation()`
注释明确写着「**不依赖固定 60s 窗口，不渲染音频（跳过 mixer/ISTFT，快）**」，
可把模型学到的推子/EQ 自动化**复用到 v2 的 8~32 拍短过渡**。

**但接线已断**：

```
desktop/preload.cjs        grep "automation" → 无任何暴露
src/audio/TransitionRenderer.ts:286   automation: undefined
src/audio/TransitionRenderer.ts:301   automation: undefined
全仓 TS 侧调用点           0 处
```

**日志证实它曾正常工作**：`aimix:automation` 事件出现 **177 次，0 次失败**，
时间跨度 `2026-08-20` ~ `2026-08-29`；此后 **9 月 0 次**。
而同一时期 `aimix:ok`（60s 长混音）持续到 `2026-09-02`，
`render:ok` 持续到 `2026-09-12`。

**结论**：`extract_automation` 这条「短过渡用 AI 学到的曲线」的路径
**曾经可用，后被拆线**（preload 移除 + TS 置 undefined）。
对照 `render_worker.py:924` 的 `apply_learned_automation` 与 `_relu6`
（自称 DJTransGAN 推子的闭式近似）——**渲染端仍在等待 automation 数据，
但数据源已断**，所以那条分支恒不执行（`len(automation) != 2` 常真）。

这解释了用户「DJ 生成的 60s 几乎没营养」的观感：
**真正有价值的短过渡曲线复用路径被关掉了，只剩下 60s 长混音这一条**。


### 6.5 ②确认：overlap clamp 导致减速窗口失真

`TransitionRenderer.ts:703`：

```ts
Math.min(options?.overlap ?? 0, bufferRemaining * 0.35)
```

AI 缓冲剩余若因 seek 只剩 20s，overlap 被截到 7s，
而 `useAudioPlayer.ts:1203-1204` 的 `syncHoldMs`/`decelMs` 按 `overlap*1000*(4/15)` 计算
→ 减速窗口只有 1.9s，与注释声称的「4s 同速 + 4s 减速 + 7s 原速」不符（那是 overlap=15 时才成立）。

### 6.6 AI 路径的 seek 缺陷

`useAudioPlayer.ts:1741` 对 `plan.v2?.aiMix !== true` 才做「剩余 <12s 放弃 AutoMix」检查，
**AI 豁免**。若用户中途 seek 进入 AI 窗口，`transitionDuration = rendered.duration - playbackOffset`
会大幅缩短（`:997-1001`），`overlayProgress` 的 start 随之变化，
但 `transitionStartTime` 仍是绝对值 `sourceStartTime + 40` →
**`inAnimationWindow` 可能永远不成立，动画窗口形同虚设**。

---

## 七、状态机与调度

### 7.1 状态枚举（9 个）

`src/audio/types.ts:87-96`：

```
idle | loading-current | playing | preparing-next | armed
| running-transition | committed | cancelled | failed
```

**没有独立的 rendering / preloading 状态**——渲染、预载、分析全部折叠在 `preparing-next` 内
（`useAudioPlayer.ts:1676 / 1931 / 2421`），恢复重试折叠在 `armed` + `preparedOk` 集合
（`:1615-1645`）。

### 7.2 预渲染时机：提前，无固定值

`preRender` 在 `prepareAutoMix` 内被 `await`（`:1764-1769`），即在 `armed` **之前**完成，
由 `preloadNext` 的 canplay 回调触发（`:2448-2451`）。

提前量 = preload 完成 → `sourceStartTime` 的剩余时间：
- v1：`sourceStartTime = sourceEndTime - beatCount*beatDuration` → 提前 **8~16s**
- AI：窗口回伸到源尾约 34s 处 → 提前 **~34s**

而 standby 预载在上一首**刚开始播放**时就调用（`App.tsx:5224`），
所以通常余量几十秒到几分钟。**但短歌或用户 seek 到接近过渡点时，余量可能只剩几秒。**

### 7.3 ③确认：触发无 timer 兜底

`:2086-2095` 是唯一的音频触发门：

```ts
if (active.currentTime >= plan.sourceStartTime) { void startTransition(...) }
```

纯 `timeupdate` 驱动（Chromium ~4Hz，误差 ±250ms），**没有 timer 兜底**
（对比 gapless 有 `transitionTimerRef`）。若 `timeupdate` 缺失（媒体元素异常、后台节流），
AutoMix 永不触发，且 `pairStrategy === 'automix'` 分支不会走 gapless 的 `scheduleBoundary`。

### 7.4 降级链：33 处，终态都是 4s 交叉淡化

完整清单见附表。核心特征：

**优点**：所有降级都保证「一定有过渡」，无无声断点（fallback plan 始终武装，`:1881`）。

**②缺陷**：**级联降级完全不可见**。终态都是 `fixed-crossfade`，
用户只听到淡入淡出，**没有任何 UI 提示**（除非开「过渡调试」开关 `App.tsx:2427`）。
最常触发的是 `tooLate`（`:1107-1112`）——seek 快进后最常见。

这也解释了你说的「增强版开了 DJ 但过渡其实不完美」——
DJ 可用但 `sourceEndTime < 40`（`TransitionRenderer.ts:266`）时会**静默改走 folia stem**，
用户以为在用 AI 长混音，实际是分轨短混音。

### 7.5 ①确认：`transitionBufferActiveRef` 竞态

`:1136` 在 400ms 斜坡**之后**才置 `transitionBufferActiveRef = true`，
而 `handleEnded` 首行检查它（`:2195-2198`）。

若源曲在缓冲启动瞬间刚好播完（AI 长混音时源曲只剩 <1s，完全可能），
`handleEnded` 会先于 `:1136` 执行 → 不被忽略 → 走到 `:2218` 用 `standby.currentTime`
提前 `commitTransition`，**而缓冲仍在播 → 双重奏 + 缓冲残留**。

### 7.6 ②确认：`dspSourceStart`/`dspTargetEnd` 死变量

`:1818-1819` 声明后**从未使用**（全文件仅此两处）。
注释声称「armed 触发点必须用解析后的窗口」，但真正回填写在 `:1833-1837`，
其条件 `plan.v2?.aiMix === true`——而 `plan.v2.aiMix` 在 `:1824` 可能已被
`{...plan.v2, ...renderedPlan.v2}` 覆盖。遗留重构残骸。

### 7.7 视觉与音频不是同一个时钟

`isTransitioning` 是独立 React state（`App.tsx:1288`），由 `transitioning` 字段驱动
（`App.tsx:2311`）。gapless 手动切歌路径还用 1.5s 定时器硬复位
（`App.tsx:5248-5252, 5294-5298`）——**与音频状态机不是同一个时钟**。

---

## 八、可复用的正确设计（Beta 应继承）

复查中也发现了若干做得好的地方，Beta 应保留：

1. **FoliaUpNextCard 的 conic-gradient 进度边框**（`FoliaUpNextCard.tsx:35`）——
   进度直接可视化在卡片边框上，语义清晰。
2. **Diorama 相机飞行**（`dioramaTransition.ts:67-70` 用 smootherstep
   `6t⁵-15t⁴+10t³`）——**全项目唯一有设计感、有明确缓动数学的过渡**，可作缓动基线。
3. **`resolveFoliaPresentation` 的纯函数设计**（`foliaPresentation.ts:21`）——
   把展示路由从组件里抽出来，思路正确（只是路由条件写错了）。
4. **gradient/easing 使用 `cubic-bezier(0.16,1,0.3,1)`**（`FoliaUpNextCard.tsx:48`、
   `FoliaTransitionOverlay.tsx:66`）——这是好的标准曲线，应推广为统一规范。
5. **spinner/ring 用 `linear`**（`FoliaTransitionOverlay.tsx:81`）——进度类用 linear 是正确的。

---

## 九、Beta 的视觉层设计要点

基于以上证据，Beta 的动画应满足：

1. **单一进度源**：一个 `transitionProgress`（0→1），
   由音频缓冲真实时长驱动，**消除 `overlayProgress` 第二套基准**。
2. **进度原点 = 窗口原点**：动画窗口开始时 progress 必须为 0。
   做法：窗口起点不再晚于音频起点，或让 progress 从窗口起点重新归一化。
   **这一步直接消除 17%~67% 跳变。**
3. **可配置时长**：把 `ANIMATION_LEAD_SECONDS`、AI 的 60/20 提为
   `AutoMixSettings` 字段，并消费 `render-runtime.cjs:941` 返回的真实 duration。
   这同时满足「让 AI 缩短过渡时间」的诉求。
4. **动画消费音频语义**：把 `beatCount`、`sourceBpm`、`choreography`、
   `stemChoreography` 的鼓点/贝斯交换时刻传给视觉层，
   让切点有视觉呼应（如鼓点交换时封面闪一下、贝斯交换时色温偏移）。
5. **统一缓动规范**：progess 类用 linear + 合成器插值（CSS transition 或 WAAPI），
   入场类用 `cubic-bezier(0.16,1,0.3,1)`，弹簧只用于提示卡。
6. **带动画的进度驱动**：E/F/H 的「直接写 opacity」改为
   WAAPI `element.animate()` 或 CSS transition，避免 30fps 阶跃。
7. **歌词与封面同源**：删掉 `isLyricsTransitioning` 死代码链，
   歌词改用与封面同一个 `transitionProgress`。
8. **背景双层同源（针对 §4.3）**：封面层与 MV 层**必须消费同一个 progress**。
   当前封面拿 `transitionProgress`、MV 拿 `overlayProgress`，导致 MV 在过渡前半程
   完全不动（`slotOpacity` 恒 0），最后 4 秒才整体换掉。
   Beta 应让 MV 槽的 opacity 与封面共用一条曲线，或至少让 MV 的 4s 窗口与音频窗口对齐。
9. **MV 槽晋升由进度驱动而非固定定时器（针对 §4.4）**：
   `BilibiliMvBackground.tsx:677` 的 1000ms 硬编码应改为「progress 到 1 时晋升」，
   或用与音频同源的时长。
10. **MV 失败/切换要有交叉淡化而非 `display:none`（针对 §4.5）**：
    当前 `enabled` 为假时 MV 容器直接 `display: none`（`:1472`），
    底层封面瞬间暴露。Beta 应先让封面就位再摘除 MV 层。
11. **封面切换不依赖动画回调（针对 §4.6）**：
    `CrossfadeBackground` 的 `onAnimationComplete` 在快速切歌时不可靠，
    已有 1200ms 定时器兜底。Beta 应改为进度驱动，去掉回调竞态。
12. **独立性**：与现有的通用淡变组件解耦，避免重蹈「一套动画服务 12 处」的覆辙。
    现有 `D/E/F/G/H/I` 六个组件不感知策略，Beta 若复用它们会被迫接受上述所有缺陷。

---

## 附表：降级点全清单（33 处）

| # | 触发条件 | 位置 | 结果 | 用户感知 |
|---|---|---|---|---|
| 1 | 看歌模式挂起 | `useAudioPlayer.ts:1532-1535, 940-944` | 跳过 | 无过渡 |
| 2 | Apple CENC 相邻边 | `:1543-1557` | 强制 gapless | 直接拼接 |
| 3 | metadata-only provider | `:137-142` | fixed-crossfade | 4s 交叉 |
| 4 | 分析/流时长差 >1.5s | `:146-154` | fixed-crossfade | 4s 交叉 |
| 5 | 多声道 >2ch | `:159-160` | fixed-crossfade | 4s 交叉 |
| 6 | 分析结果 null | `:1687-1692` → `:1875-1891` | fallback + 重试 | 先交叉，20s 后可能升级 |
| 7 | 剩余 <12s（非 AI） | `:1740-1745` | fixed-crossfade | 4s 交叉 |
| 8 | 渲染抛错 | `:1778-1789` | fixed-crossfade + 重试 | 交叉 |
| 9 | rendererRef 为 null | `:1790-1794` | fixed-crossfade | 4s 交叉 |
| 10 | AI 引擎不可用 | `TransitionRenderer.ts:261-269, 352-357` | Folia → v2 DSP | 无 AI 长混音 |
| 11 | HTDemucs 不可用 | `:338-343` | buildDspFallbackPlan | v2 DSP |
| 12 | Folia 渲染无效 | `:438-445` | v2 DSP 重渲 | DSP |
| 13 | Folia IPC reject | `:382-391` | 原 plan 重试一次 | 延迟 + DSP |
| 14 | DJTransGAN 输出无效 | `:399-406` | Folia/DSP，overlap→1.5s | 短混音替代 60s |
| 15 | DJTransGAN throw | `:421-429` | 同上 | 同上 |
| 16 | stem artifacts 路径重试 | `:447-454` | v1 full-mix | v1 音质 |
| 17 | `stretchApplied !== true` | `:457-459` | throw → #8 | 交叉 |
| 18 | DJ effects 声明未应用 | `:460-462` | throw → #8 | 交叉 |
| 19 | 格式不可解码 | `:195-215` | 转 WAV | 可能 → #8 |
| 20 | 触发越过缓冲 85% | `:678-688` → `:1107-1112` | fixed-crossfade | **seek 后最常见** |
| 21 | 缓冲过期（TTL 5min） | `TransitionRenderer.ts:111-117, 664-667` | fixed-crossfade | 4s 交叉 |
| 22 | `playTransition` 返回 null | `:1299-1303` | fixed-crossfade | 4s 交叉 |
| 23 | target `play()` 失败 | `:1264-1273` | failed | 音乐停 + 报错 |
| 24 | 整体 try/catch | `:1506-1520` | failed | 停在本曲末尾 |
| 25 | preload 超时 15s | `:2471-2487` | 清 standby | 自然播完后重载 |
| 26 | Apple HLS 当前曲失败 | `:2564-2574` | failed | 电台重连 |
| 27 | `handleEnded` 无 standby | `:2242-2245` | idle | 整首重载 |
| 28 | 采样率不一致 | `render_worker.py:583-596, 1260-1272` | 重采样 target | 一般无感 |
| 29 | 拉伸越界（BPM 差>15%） | `transitionPlanner.ts:15-17, 870-895` | withoutBeatGrid | 氛围特效过渡 |
| 30 | BPM 差 >100 | `:870-871` | fixed-crossfade | 4s 交叉 |
| 31 | 置信度不足 | `:856-889` | beat/fixed-crossfade | 4s 交叉 |
| 32 | AI 目标曲太短 | `djtransgan_worker.py:368-369` | throw → DSP | 短混音 |
| 33 | Apple 播放面淡出尾 | `useAudioPlayer.ts:2622-2636` | 线性淡入头 | 渐入 |

---

## 附：配色/性能风险点（可能加剧「不丝滑」）

| 风险 | 位置 | 说明 |
|---|---|---|
| backdrop-filter + 每帧变化背景 | `FoliaUpNextCard.tsx:35, 44, 55` | conic-gradient 每 30ms 变 + `backdrop-filter: blur(28px)` 同元素 → 强制重栅格化。**最可疑** |
| backdrop-filter 大盘 | `PlayerControls.tsx:713-723`、`UpNextNotification.tsx:46-47`（blur 60px）、`FoliaTransitionOverlay.tsx:87` | 过渡期多个 40~60px 模糊层并存 |
| 动画非合成属性 | `index.css:729-738`（`text-shadow` glow）、`FoliaTransitionOverlay.tsx:82`（`drop-shadow`） | 每帧 repaint 而非 composite |
| 全局通配 transition | `index.css:17-18` `html, body, html * { transition: ... }` | 主题/内联颜色变化时全树参与 |
| App 级 30fps setState | `useAudioPlayer.ts:1076-1084` → `App.tsx:2324-2331` | `App.tsx` 单文件 500KB |
| CSS 变量写根节点 | `App.tsx:450` + `:475` | 注释自述实测 8 秒内 RecalcStyle 1325 次 |
| 双分辨率封面并存 | `AlbumCoverPlayer.tsx:117-159` vs `CrossfadeBackground.tsx:26-28` | 不同 rendition key（`artworkLoader.ts:107`）→ 双份下载 + decode |
| MV 视频模糊+缩放 | `BilibiliMvBackground.tsx:1490-1491, 1510-1511` | 双 video 各挂 `filter: blur()` + `scale(1.08)` |
| 歌词列表卸载重挂 | `LyricsDisplay.tsx:2430` | 过渡期整棵列表卸载 |
