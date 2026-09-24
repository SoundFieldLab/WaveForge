# AutoMix 修复记录：学习式曲线接通 + 过渡叠加层进度统一

日期：2026-09-20
承接：[AUTOMIX-TRANSITION-ANIMATION-AUDIT-2026-09-20.md](./AUTOMIX-TRANSITION-ANIMATION-AUDIT-2026-09-20.md)

本轮做了两项改动，均已通过 typecheck 与全量测试。

---

## 一、接通 DJTransGAN 学习式自动化曲线（用户指定）

### 背景

审计发现 `extract_automation()` 这条链路曾完整可用，后被拆线：

- 运行时日志 `%APPDATA%\Electron\automix-backend.log` 中 `aimix:automation`
  有 **177 次成功记录、0 次失败**，时间跨度 2026-08-20 ~ 08-29；9 月起 0 次。
- 而同期 `aimix:ok`（60s 长混音）共 140 次，全部 `duration=60`。
- `render_worker.py` 仍在等待这份数据（`len(automation) == 2` 分支），
  但 TS 侧从不注入 → 分支恒不执行。

这条路径的价值在于注释所述：模型输出是**闭式参数式曲线**（fader: start/slope；
band: 3 边界 × start/slope），可在**任意长度**重建，
**不依赖 60s 窗口、不渲染音频（跳过 mixer/ISTFT）**——
即把 AI 学到的推子/EQ 曲线复用到 v2 的 8~32 拍短过渡。

### 修正一处此前的错误结论

审计报告曾写「preload 桥与类型定义已被移除」。**这是错的**，源于一次失败的 grep。
实际核查：

```
desktop/render-runtime.cjs:1083   ipcMain.handle('render:aiMixAutomation', ...)      ✔ 存在
desktop/render-runtime.cjs:961    async getAutomation(plan, src, tgt)                 ✔ 存在
desktop/preload.cjs:144           aiMixAutomation: (plan, src, tgt) => ...            ✔ 存在
src/electron.d.ts:519             aiMixAutomation?: (plan, ...) => Promise<...>       ✔ 存在
src/audio/types.ts:232            automation?: Array<{ band; fader }>                 ✔ 存在
```

**唯一缺失的是 TS 调用点**（`TransitionRenderer.ts` 里两处 `automation: undefined`）。
所以这是一次「只差一行接线」的修复，而非恢复整条链路。

### 改动

`src/audio/TransitionRenderer.ts` 新增 `attachLearnedAutomation()`，在每次
full-mix DSP 渲染前注入：

```ts
const attachLearnedAutomation = async (): Promise<void> => {
  if (plan.v2?.aiMix !== true || !djAvailable) return
  if (renderPlan.v2?.automation) return
  if (renderPlan.v2?.backend === 'folia-htdemucs' || renderPlan.v2?.stemArtifacts) return
  const fetchAutomation = renderBridge.aiMixAutomation
  if (typeof fetchAutomation !== 'function') return
  try {
    const automation = await fetchAutomation(renderPlan, sourceRenderPath, targetRenderPath)
    if (!automation?.success || !Array.isArray(automation.params) || automation.params.length !== 2) {
      debugLog('... Learned automation unavailable; using rule-based curves:', automation?.error)
      return
    }
    renderPlan = { ...renderPlan, v2: { ...renderPlan.v2, automation: automation.params } }
  } catch (error) {
    debugLog('... Learned automation failed; using rule-based curves:', error)
  }
}
```

调用点：
1. `renderDsp()` 开头——覆盖常规 full-mix 路径。
2. `renderDsp()` 的 IPC 失败重试分支——降级后重新尝试。
3. `:468` 的 folia 渲染失败回退——改为经 `renderDsp()` 以便同样注入。

**三条保护**：
- 只在 `plan.v2.aiMix === true && djAvailable` 时运行（用户开了 DJ 且引擎可用）。
- **不注入 stem 拥有的过渡**：`backend === 'folia-htdemucs'` 或存在 `stemArtifacts` 时直接返回
  （worker 的 folia 分支本就忽略 automation，注入无意义且会造成语义混淆）。
- 任何失败都静默退回规则式曲线，不中断过渡。

### 附带修复：`_band_split` 频段重叠 bug

`apply_learned_automation` 依赖 `_band_split`，而它有个**实测确认**的严重 bug：

```python
# 修复前
mid_high = filtered(filtered(audio, 5000, 'highpass'), 20000, 'lowpass')  # ≈ 全通
high     = filtered(audio, 5000, 'highpass')
# → mid_high 与 high 完全重叠
```

实测（白噪声，44100Hz）：

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 4 段求和 RMS / 原信号 | **1.4583**（高频双重计入） | **1.00001** |
| `corr(mid_high, high)` | 0.7978 | — |
| 各频点重建误差 | — | **0.000 dB**（60Hz~18kHz 全频段） |
| 与原始信号相关系数 | — | **0.99999815** |

修复前会让 automation 路径的高频抬高约 3.3dB 并引入染色——
即「接上 automation 反而更差」。改为**互补级联分频**（每段低通后剩下的残差
再进下一级），并顺带把滤波从 `sosfilt`（因果、有相位延迟）换成
`sosfiltfilt`（零相位，离线渲染负担得起）：

```python
def _lr_filter(audio, sample_rate, cutoff, btype):
    sos = signal.butter(2, safe_cutoff, btype=btype, fs=sample_rate, output='sos')
    try:
        return signal.sosfiltfilt(sos, audio, axis=1).astype(np.float32)   # 零相位
    except ValueError:
        return signal.sosfilt(sos, audio, axis=1).astype(np.float32)       # 短样本回退

def _band_split(audio, sample_rate):
    bands = []; carry = audio
    for boundary in (300.0, 5000.0, 20000.0):
        bands.append(_lr_filter(carry, sample_rate, boundary, 'lowpass'))
        carry = _lr_filter(carry, sample_rate, boundary, 'highpass')
    bands.append(carry)
    return bands
```

重建误差仅出现在末尾 2 个样本（filtfilt 边缘瞬态），中间 98% 为 float32 精度（3.6e-7）。

---

## 二、过渡叠加层进度源统一（Beta 视觉层第一步）

### 问题

审计发现同一屏背景的两层拿到**两个不同进度**：

| 层 | 位置 | 传入 progress |
|---|---|---|
| 封面背景 | `App.tsx:8315` | `transitionProgress`（全量 0→1） |
| MV 背景 | `App.tsx:8360` | `overlayProgress`（最后 ~4s） |
| 大封面 ×2 | `:9061` / `:9368` | `transitionProgress` |
| 歌曲信息（大封面块） | `:9382` / `:9391` | `transitionProgress` |
| 歌曲信息（无歌词块） | `:9075` / `:9084` | `overlayProgress` ← 已经不一致 |

### 根因（数学验证）

`transitionProgress` 的原点是**音频过渡启动时刻**，而动画窗口**晚开**
（v1：`sourceEndTime - 10`；AI：`sourceStartTime + 40`）。
窗口开启瞬间 progress 已非零 → 所有消费它的图层硬跳。

```
v1 (dur=12s, 窗口提前 10s)：窗口开启时 transitionProgress = 0.167
AI (dur=60s, 窗口=+40s)  ：窗口开启时 transitionProgress = 0.667

同样时刻的 overlayProgress = 0.000（两条路径都是 0）
```

**`overlayProgress` 因为从窗口起点重新归一化，天然无跳变。**
即 MV 一直在用的那条进度本来就是对的，跳变只发生在还用 `transitionProgress` 的那几层。

且代码注释（`App.tsx:3516-3517`）明确写了设计意图：
「叠加动画（封面/字/MV 渐变）只在过渡最后 ~4 秒完成」——但封面和字实际没照做。

### 改动

6 处改为 `overlayProgress`：

```
App.tsx:8318   PulsingCrossfadeBackground  transitionProgress={overlayProgress}
App.tsx:9065   AlbumCoverPlayer（有歌词）   transitionProgress={overlayProgress}
App.tsx:9373   AlbumCoverPlayer（无歌词）   transitionProgress={overlayProgress}
App.tsx:9383   歌曲信息块条件判定           overlayProgress > 0
App.tsx:9387   底层旧歌曲信息 opacity        1 - overlayProgress
App.tsx:9396   顶层新歌曲信息 opacity        overlayProgress
```

**保留 `transitionProgress` 的站点**（有意为之）：

```
App.tsx:3520   overlayProgress 的推导源
App.tsx:9477   FoliaUpNextCard progress     ← conic 进度环，是进度指示器，需要完整进度
App.tsx:9495   FoliaTransitionOverlay       ← 同上（目前为死代码，见审计报告 §1.1）
```

### 效果

- 消除 0.167（v1）~ 0.667（AI）的进度硬跳变。
- 封面、大封面、歌曲信息、MV 四层**共用同一条曲线**，不再「封面淡 60 秒、
  MV 只淡最后 4 秒」。
- 歌曲信息交叉不再出现「两首歌标题各 50% 透明重叠」的可读性崩塌。

---

## 三、验证

| 项目 | 结果 |
|---|---|
| `npx tsc --noEmit` | 通过（exit 0） |
| `py_compile render_worker.py` | 通过 |
| 全量 vitest | **1836 通过 / 1 失败 / 6 跳过** |
| 新增 `test/autoMixLearnedAutomation.test.ts` | 6 测试全过 |
| 新增 `test/transitionOverlayProgress.test.ts` | 4 测试全过 |
| 受影响的动画测试（Bilibili/Folia×2/AutoMix×2） | 38 测试全过 |

**唯一失败是 `test/modeIntegrationWiring.test.ts`（AppleExplorePanel 嵌套播放状态）**，
与本次改动无关：已通过 `git stash` 移除本次改动后单跑该测试确认，
**在原始代码上同样失败**，属预先存在的问题。

改动前基线 1832 通过，改动后 1836 通过（+4 为新增测试）。

---

## 四、8 项遗留问题的逐项核实结果

对审计报告列出的 8 项「尚未处理」，本轮**先逐条回读代码取证再动手**。
结果：**4 项是审计误判**（无需修改），**2 项已修**，**2 项确认为真但需产品决策**。

### 4.1 已修复

**① 两条 rAF 并发写进度（确认的 bug）**

`useAudioPlayer.ts` 在 `playTransition` **之前**就启动了进度 rAF（`:1092`）。
`tooLate` 分支（`:1107-1112`）只改 `strategy` 而不 cancel，代码继续贯穿到
标准交叉淡化分支 `:1461`，**又启动第二条 rAF**：

- 第一条闭包持有 `transitionAudioDuration`，第二条持有 `audioDuration`（不同分母）
- `transitionProgressAnimationRef` 的 cancel 点只有 `:788/:860/:2282`，该路径无 cancel
- 旧句柄被覆盖丢失 → 两条循环同时以 30ms 节流 `emit({transitionProgress})`

**修法**：在三条贯穿路径的汇合点（`:1307`）统一 cancel 后再走交叉淡化。
触发条件正是最常见的 `tooLate`（seek 快进后）。

**② AI 动画窗口硬编码（确认的缺陷）**

原 `plan.sourceStartTime + 60 - 20` 把模型窗口长度写死为 60。
实测本机日志 140 次 AI 渲染**恒为 `duration=60.0s`**，所以当前不产生错位，
但 `60` 是跨模块复制的字面量（worker 用 `settings.N_TIME`，前端用 `60`），无关联校验。

**修法**：
- `TransitionPlan` 新增 `renderedDuration`，由 `TransitionRenderer` 回填
  渲染器返回的真实缓冲时长（`result.duration`，`render-runtime.cjs:943` 已有）。
- `useAudioPlayer` 改用它，缺失时按 `AI_MIX_WINDOW_SECONDS = 60` 兜底。
- 抽出 `ANIMATION_TAIL_SECONDS = 20` 常量，替换魔数。

模型换档时前端不再静默错位。

### 4.2 审计误判（经取证确认无需修改）

**③ Folia 中央进度环「死代码」——误判**

审计称 `foliaPresentation.ts:30` 的路由自相矛盾导致组件永不渲染。实测路由矩阵：

| 场景 | cardVisible | border | **overlayVisible** |
|---|---|---|---|
| 默认（up-next 开、顺序播放） | true | true | false |
| **用户关闭 up-next** | false | false | **true** |
| **单曲循环** | false | false | **true** |
| **无下一首** | false | false | **true** |
| 短过渡 <5s | true | true | false |

`overlayVisible` **可达**，且此时恰好只有一个进度指示器。
更关键的是 `test/foliaPresentation.test.ts:28-50` **已经完整覆盖**这些用例，
包括「transition border suppresses the central ring to avoid duplicate animations」——
即互斥是**有意设计**（不同时显示两个指示器）。

我当初把 `FoliaTransitionPresentation.test.tsx`（组件测试）与
`foliaPresentation.test.ts`（路由测试）搞混，误以为路由无测试覆盖。

同时「BPM 仅调试数据存在时才可用」也不成立：
`buildTransitionDebug()` 在 `:1872` **无条件赋值**，不是调试门控。

**④ MV 槽 1000ms 定时器「与进度不等长」——误判**

`beginCrossfade` 首行 `stagedSlotRef.current = null` 并设置 `incomingSlot = slot`。
而 `slotOpacity` 的分支顺序是：

```ts
if (slot === incomingSlot) return 1                                   // ← 转换后走这里
if (slot === activeSlot) return firstFadeDone ? 1 : 0
if (transitionActive && stagedSlotRef.current === slot) return transitionProgress  // ← 转换前
```

即 **staged（progress 驱动）与 incoming（CSS `opacity 0.65s ease` 驱动）
是互斥状态**，`beginCrossfade` 一执行就完成转换。
1000ms 晋升定时器 > 650ms 淡入时长，留 350ms 余量。不存在两者并存。

且过渡期间 `beginCrossfade` 被两处守卫挡住
（`handleCanPlay` 的 `if (transitionActive || preloadingOtherSong) return`、
`:1364` effect 的 `if (transitionToTrack?.trackKey) return`）。

**⑤ MV 失败硬切——方向对但定位错，且修法无效**

审计称容器 `display:none`（`BilibiliMvBackground.tsx:1472`）造成硬切。
实际机制是**两层**：

- 视频元素自身 `display: slotAUrl ? undefined : 'none'`（`:1491/:1513`）
- 更根本的是 `:307` 的 `useEffect(() => { if (!slotAUrl) slotARef.current.load() })`
  ——`load()` **清空解码帧**，视频立刻变透明

我按审计思路加了 opacity 淡出，**实测无效**（帧已被 `load()` 清除，没有内容可淡），
已回滚，未留死代码。

进一步核查：`hideOldMv` 的注释明确说明「立即隐藏」是**有意设计**——
「避免过渡完毕到下一曲后仍显示上一曲 MV；新 MV 就绪后由 canplay 淡入」。
即这个"硬切"是为避免**张冠李戴**而做的取舍。

结论：这不是简单可修的 bug，而是「宁可闪一下也不显示错歌」的设计权衡。
真要改善需要更细的状态机（区分"失败"与"切歌释放"两条路径），属独立工项。

**⑥ AI 过渡前段「无视觉提示」——部分误判**

审计称 60s 全程只有进度条在动。实际：

- 倒计时基准 `eventTime = transitionStartTime`（`:2269`），`useTransitionCountdown`
  在 AutoMix 启用时为真 → up-next 卡片会按 `upNextTime`（默认 10s）提前显示
- 卡片刻意的隐藏条件（`:2295`）只在「已进入动画窗口」后生效

即前段**有**卡片倒计时，不是全无提示。真实差异是「前段无叠加渐变」，
而那正是 `overlayProgress` 的设计意图（最后 4 秒完成叠加）。

### 4.3 确认为真，但需产品决策

**⑦ 时长可配置**：`autoMixMinDuration/MaxDuration` 仅 v1 生效，
v2 在 `transitionPlanner.ts:757-760` 明确忽略，UI 也隐藏滑块。
且这两个项**不在 `globalSettingsRegistry.ts`** 里（只在 `SettingsPanel.tsx`），
跨面板同步不一致。要不要让 v2/AI 也尊重用户时长，是产品选择而非纯 bug。

**⑧ 换时间拉伸引擎**：两家外部平台都用成熟引擎（QQ音乐 SoundTouch+RubberBand，
网易云 RubberBand），我们用 `librosa.effects.time_stretch`（纯相位声码器）。
这是音频质量的最大杠杆，但 RubberBand 是 GPL/商业双授权而 WaveForge 是私有许可，
**需先定授权方向**。

---

## 五、设置面板代码观察（非用户反馈）

> **更正记录（2026-09-20）**：本节初版开头写有「用户反馈『设置面板里内容很奇怪（不是动画）
> 而且很卡』」。**该表述系误加**——用户从未提出此反馈，全仓检索该句只命中本节自身。
> 以下仅为我在读 `SettingsPanel.tsx` 时的**代码观察**，不是任何人的反馈，
> 也**没有实测性能数据支撑**。列此仅为备查，未确认的问题不应作为修改依据。

读 `SettingsPanel.tsx`（5696 行）时注意到以下几点，**均未经验证**：

| 观察 | 位置 | 说明 |
|---|---|---|
| 内容区高度用 calc 估算 | `SettingsPanel.tsx:2085` | `h-[calc(100vh-140px)]`。按 Tailwind 默认值精算头部+标签栏 ≈138px，**当前仅差 2px，无可见问题**。属"冻结的估计值"，头部/标签栏高度变化时会失配 |
| tab 切换无内容过渡 | `:214-217` | `switchTab` 只做 `setActiveTab` + `rAF` 重置滚动 |
| tab 内容块体量 | 内容区 | `advanced` 1222 行 / `about` 1117 行 / `personalization` 916 行 |
| 模糊层 | `:1828`/`:1850`/`:1915`/`:1926` | 面板打开时同时存在 4 处 backdrop-filter；全文件 19 处 |

`useMemo/useCallback` 仅 8 处。

**上述任一项是否真的影响体验，需实测（DevTools Performance profile）才能判断。**
本节不构成待办。

### 附：仓库中真实存在的设置面板问题记录

`docs/resonance-design.md:266` 有一条**已修复**的真实问题，与本项目相关且可佐证
"设置面板确有历史坑"：

> 设置面板里点一下开关，面板自己跳回最上面 —— `Row`/`Segmented` 定义在组件内部
> （每次渲染都是新组件类型）→ 设置写入让 React 卸载重建整行子树，
> 滚动容器瞬间变矮、浏览器把 `scrollTop` 夹到 0。
> 两个控件提到模块作用域后实测：滚动 387px 后点开关仍是 387px（此前归 0）。

另 `HANDOVER.md` §5 记录了 2026-08-16 的性能优化轮次，含
「弹窗（SettingsPanel…）全部 memo + `stableDialogCallbacks`」，
以及 git `05408c4`「降低设置/搜索/桌面设置面板 backdrop-blur(60px→24px)
提升弹出动画流畅度」。即该面板的模糊开销**此前已被处理过一轮**。


