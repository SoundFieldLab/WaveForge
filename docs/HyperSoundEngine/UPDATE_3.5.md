> **归档副本（2026-10-20）**：源文件 `temp/hse-optimise/UPDATE_3.5.md`（原文日期 2026-10-20，独立快照只读参考）。`temp/` 被 git 忽略，故原文归档于此；**除本说明外内容与原文一致，未改动**。接入摘要与证据索引见 [INTEGRATION_3.5.md](./INTEGRATION_3.5.md)。

# UPDATE_3.5 — HSE 独立快照相对主程序的更新与优化

日期：2026-10-20
对比对象：主程序 HSE 模块 `D:/Code/ZCode/WaveForge/src/services/waveforge-engine-v3`（主程序工作区当前检出 **`master` @ `8b90d34e9c83a36aaea402bd586271f6efe4b47a`**，2026-10-17，`git status` 干净；历史交接分支 `codex/hse-dsp-integration` @ `cd9f5d4` 与当前 master 在 HSE 模块仅 `ui/components/SpatialRingEditor.tsx` 有 4 行差异、`public/v3-worklet.js` 相同。本次只读，未修改主程序；回流时以当时工作区内容逐文件重比）
快照：`D:/Code/ZCode/WaveForge/temp/hse-optimise/src/services/waveforge-engine-v3`
方法：按目录逐文件遍历 + 文件内容 SHA256 比较（lead diffNote 脚本）+ 本次文档/源码交叉核对（目录集合、行数、关键符号检索、既有验证日志）。行数为文本文件（`ts/tsx/css/md`）实际行数。
结论性质：区分「已实现 + 软件路径已验证」与「已知边界/未验收」；192 kHz 数据仅为压力参考，不作为通过结论。

---

## 1. 对比基准与规模

| 指标 | 快照 | 主程序 | 说明 |
| --- | ---: | ---: | --- |
| 模块文件总数 | **272** | **167** | 含源码/测试/UI/文档/资源 |
| 相对主程序 | 新增 **105**、修改 **107**、相同 **60**、缺少 **0** | — | 主程序没有快照不存在的文件 |
| 文本行数（ts/tsx/css/md） | **60,257** | **36,812** | 快照约为主程序 1.64 倍 |
| ts/tsx 文件数：src / test / ui / integration | **99 / 63 / 77 / 2** | 50 / 30 / 60 / 0 | integration 指模块根 `integration/` |
| Worklet 产物 `public/v3-worklet.js` | **507,004 bytes** | **95,518 bytes** | 快照约 5.3 倍；快照产物需重建，不能直接拷贝 |
| 主程序工作区 | 干净（只读对照） | — | 对比期间未写入主程序 |

**差异分布（快照独有 105 个文件的目录构成）**：`src/spatial` +33（含 19 个空间测试）、`src/dsp` +14、`test` +33、`ui` +20、`integration` +4、`src/integration` +2、`docs` +1。

差异形态以「新增模块 + 同文件扩展」为主：主程序已有的 `EngineV3.ts / types.ts / model Convolver / TsConvolverBackend / roomSim / EqChain / Test / UI 外壳` 均在快照中被修改，`EngineV3` 主程序仍是 `cloneParams + JSON.stringify 比较`（本次只读检索 `cloneParams`、`JSON.stringify` 可见），而快照已改为结构化同步；`types.ts` 主程序没有 `precision / processingOrder / bitPerfectBypass / dynamicEq / crossfeed / replayGain / subsonic / channelCalibration` 等字段。

---

## 2. 功能新增（DSP / 引擎）

| 能力 | 快照实现 | 主程序对照 | 验证与边界 |
| --- | --- | --- | --- |
| 动态均衡 | `src/dsp/DynamicEq.ts`：单段 + 最多 8 段独立检测/衰减，各段频率/Q/阈值/比率/最大衰减/启动/释放/启停；UI、分享串、参数平滑接入 | 主程序无 `DynamicEq.ts` | `test/dynamic-eq.test.ts`；真实节目听感未验收 |
| 参数均衡 PEQ | `EqChain.ts` 扩展：专业模式 1–64 段、8 类 RBJ 滤波器（peaking/lowshelf/highshelf/lowpass/highpass/bandpass/notch/allpass）、独立段类型、Q 补偿、快捷重映射、预设/分享串保留段数 | 主程序 `EqChain.ts` 仅 `bandCount`（20 段上限）与 peaking 路径，无滤波器类型常量 | `eqchain.test.ts`、`peq-types.test.ts`；64 段是容量上限，非无限 |
| 压缩模式 / 瞬态保留 | 向下/向上/三段模式；向上最大提升限制；多段交叉频率/各段参数/总输出增益；`transientPreserve` 0–100% | 主程序 `Compressor.ts` 无 `mode/upward/multiband/transientPreserve` 符号 | `compressor.test.ts`、`compressor-modes.test.ts`；真实节目动态听感未验收 |
| Crossfeed（耳机交叉馈送） | `src/dsp/Crossfeed.ts`：对侧低通 + 短延迟 + 左右对称混入，启停/量/截止/延迟 | 主程序无该文件 | `crossfeed.test.ts`；耳机模型校准未做 |
| 低频管理 / 次声高通 | `MidSide.ts` 40–250 Hz 侧信号收窄、`LowFrequency.ts` 10–40 Hz 次声高通（均 20 ms 平滑，位于空间/扩展节点后、限幅前） | 主程序无 `LowFrequency.ts`；`MidSide` 为旧版 | `lowfrequency.test.ts`、`mside.test.ts` |
| 声道校准 | `EngineV3` 左右独立 dB 增益（±24 dB，20 ms 平滑），分享串/空间页接入 | 主程序 `types.ts` 无 `channelCalibration` | `channel-calibration.test.ts` |
| 卷积 IR：分区/用途/IR 库 | `Convolver.ts` 支持 128/256/512/1024 分区、去周期化参数化、用途（混响/房间/扬声器/耳机校正，校正全湿）；`ConvolutionIrLibrary.ts` + `ui/irStore.ts` IndexedDB 库（导入/选择/删除/容量/重采样） | 主程序 `Convolver` 已有 `partitionSize/dePeriodize` 选项（只读源码核对），但无 `purpose`、无 `PreparedConvolverIR`、无 IR 库/UI 文件 | `convolver*.test.ts`、`convolution-ir-library.test.ts`、IR 持久化 Electron 探针 |
| ReplayGain 多容器扫描 | `ReplayGain.ts`：ID3v2 TXXX、APEv2、FLAC Vorbis Comment、Ogg/Opus、MP4 iTunes atom；有限头/尾扫描（各 1 MiB），URL 扫描 + 缓存 | 主程序无 `ReplayGain.ts` | `replaygain.test.ts`（12 项）；主程序播放队列接线待回流 |
| 量化 / WAV / MP3 导出 | `PcmQuantizer.ts`（plain/TPDF/noiseShaped + 16-bit）、`PcmWav.ts`、离线渲染复用同一 DSP；`integration/V3AdapterSnapshot` 接 WAV/MP3 导出 | 主程序无这两个文件；导出接线未回流 | `pcm-quantizer.test.ts`、`pcm-wav.test.ts`、`mp3EncodeSmoke.test.ts`、`multichannel-export.test.ts` |
| 内部精度 Float32 / Float64 | `audioBuffer.ts` + `V3EngineParams.precision` + 分享串；工作缓冲与链上 DSP 接受两种缓冲；空间/卷积/多段压缩/上混/Ambisonics/房间全后端 `setPrecision` 幂等切换 | 主程序 `types.ts` 无 `precision`，无 `audioBuffer.ts` | `precision.test.ts`（8 项）、`precision-full-chain.test.ts`；最终输出仍 Float32 音频 API |
| 模块排序（既有 9 模块） | `types.processingOrder` + `EngineV3` 实际按序执行；输入/分析/空间解码/最终限幅固定边界；调音器拖拽/按钮；分享串保留 | 主程序 `types.ts` 无 `processingOrder` | `processing-order.test.ts`；整链自由排序已取消（见 §8） |
| 扩展节点 | `src/integration/ProcessingNode.ts`：函数节点/脚本节点；可序列化 gain/biquad/matrix/delay/FIR/waveshaper/chain；第三方 TS 工厂 + 可信模块装载；Worklet 跨线程注册；`docs/PROCESSING_NODES.md` | 主程序 `src/integration` 仅有 `EngineV3Host.ts`，无 ProcessingNode | `processing-node.test.ts`、Worklet 装载/第三方 PCM 验证 |
| 内部逐位旁路 / 多声道 / 高采样率 | `bitPerfectBypass` 输入输出对应逐位复制；5.1/7.1→立体声折叠（`ChannelDownmix.ts`）；Worklet 离散输入最多 32 声道；48/96 kHz 矩阵 | 主程序 `types.ts` 无 `bitPerfectBypass`，无 `ChannelDownmix.ts` | `bit-perfect-bypass.test.ts`、`multichannel-input.test.ts`；设备端比特完美未验收 |
| 参数平滑（通用过渡） | `EffectTransition.ts`（10 ms 退直通→零湿声提交→10 ms 淡入，预分配 1–128 帧两种精度视图）、`SampleRamp.ts`（限幅/卷积读点） | 主程序无这两个文件 | `parameter-smoothing.test.ts`（41 项）+ Electron 48/96 kHz 平滑阶段 |

---

## 2.1 融合层与离线导出（`attachV3Engine.ts` / `ui/bridge.ts`）

| 项 | 快照实现 | 主程序对照 / 边界 |
| --- | --- | --- |
| 参数唯一提交路径 | `createV3UiBridge(engine, fs, { submit })`：`commitParams → engine.setParams → submit`；`setParams` / `applyScene` / 外部 replace 都走同一路径；`attachV3Engine` 不再覆写 `setParams`（原 `{ ...raw, setParams }` 包装删除），由 submit 统一承载 Worklet 下发（`host.setParams`，主线程引擎 + Worklet）、持久化与前置链同步 | 主程序 `ui/bridge.ts` 的 `createV3UiBridge(engine, sampleRate)` 无 submit 选项；`attachV3Engine` 仍是 `createV3UiBridge(host.engine, fs)` + 包装 `setParams`（桥内部快照 → 主线程引擎 → `host.setParams`），`applyScene` 走桥内 `setParams`。快照已改；主程序需按 `MAIN_APP_INTEGRATION_HANDOVER.md` 补齐 |
| ReplayGain | submit 内按 `replayGainMode` 从当前曲目标签选择曲目/专辑增益，写回桥快照（UI 显示的 `replayGainDb` 与宿主实际生效值一致）；`setV3TrackReplayGainTags` / `scanV3TrackReplayGain`（异步扫描、序号取消旧扫描）也经同一提交路径；值相等短路避免重复下发 | 主程序无 ReplayGain 扫描器与曲目标签注入；播放队列切歌生命周期待回流接线 |
| IR 去重 | `WeakMap<Float32Array, token>` 按 IR 引用身份生成 token（不阻止 GC、不对样本做 hash）；同参数换另一份 IR 不再被误判为重复 | 主程序无该去重结构 |
| 离线导出 | `renderV3Pcm`：输入上限 8→32 声道（保持离散顺序；mono 补双声道；7.1.4=12、AmbiX 4/9/16 不被截断）；导出前用 `readActiveHrtf()` 同步当前自定义 SOFA HRTF，IndexedDB 不可用/数据损坏回退内置 KEMAR 不中断；pitch 激活且 >2 声道时只前 L/R 走 Stretch，其余声道按拉伸后长度截断/补零对齐保留（不再整段下混丢布局）；WAV 与 MP3 共用同一离线 DSP（分块 `engine.process` + 1 s 静音冲刷 + 量化/编码） | 主程序 `V3Adapter` 未回流这些入口；快照 `integration/V3AdapterSnapshot` 已接 WAV/MP3 两种导出回调。**边界**：导出容器仍为双声道 WAV/MP3（引擎输出即双耳），pitch+多声道为近似时基 |
| 测试 | 全量 109 文件/1134 项中通过：`test/attachV3Engine.persistence.test.ts`（10 项）、`test/multichannel-export.test.ts`（7 项）、`ui/bridgeIr.test.tsx`（4 项）、`integration/V3AdapterSnapshot.test.tsx`（2 项） | 主程序未回流上述接线 |

---

## 3. 空间音频

| 能力 | 快照实现 | 主程序对照 | 验证与边界 |
| --- | --- | --- | --- |
| 实测 HRTF / 方向插值 | `measuredHrtf.ts / measuredHrtfInterp.ts / kemarData.ts`（MIT KEMAR compact，8–192 kHz 重采样网格）、`hrtfInterp.ts` 球谐插值；`HrtfDataset.ts` 数据校验/坐标/延迟/采样率转换 | 主程序只有 `analyticHrtf.ts + hrtfInterp.ts` 合成网格，无实测数据文件 | `measuredHrtf.test.ts`、`hrtfInterp.test.ts`；前后/高度主观定位未验收 |
| 双耳卷积 | `BinauralConvolver.ts`：128 样本计算分区、512 输出对齐、双耳共享输入频谱、prepared 频谱接管 | 主程序无该文件（`TsConvolverBackend` 为旧版） | `binauralConvolver.test.ts`、PCM 对拍与 prepared 复用 |
| 房间 / 镜像反射 / 谱反射 / FDN / 氛围 | `roomSim.ts` 扩展：镜像声源 HRIR 早反射、墙面低通、谱反射（稀疏 FFT 尾部）、八线 FDN、房间几何/阶数/预算档；`StereoAmbienceExtractor.ts` PCA/Wiener 非相干残差 + 兼容 L-R | 主程序 `roomSim.ts` 存在但无谱反射/氛围提取文件 | `roomReflection.test.ts`、`roomPreparation.test.ts`、`roomPerformance.test.ts`；两声道无法唯一还原真实三维环境场 |
| world / stage / headLocked 路由 | `controller.ts / layouts.ts / scenes.ts` 复用 + `worldRouting.ts` 固定 L/R/both/side 路由；`EngineV3` 空间内联、姿态相对方向、房间/舞台预设 | 主程序 `controller/layouts/scenes` 为旧版（common 文件被修改），无 `worldRouting.ts` | `spatial-rework.test.ts`、`spatial-completion.test.ts`、`spatial-features.test.ts` |
| 传播延迟 / Doppler | `PropagationDelay.ts`：343 m/s、最远 200 m、读头平滑/跳位交叉淡化；轨迹有限差分径向速度只产生一次多普勒 | 主程序无 `PropagationDelay.ts` | `propagationDelay.test.ts` |
| AmbiX 1–3 阶 / FuMa | `AmbisonicDecoder.ts`：ACN/SN3D，1/2/3 阶严格 4/9/16 输入、8/18/32 方向满秩求积、三轴旋转/分阶增益约 20 ms 平滑；FuMa 仅 FOA；格式与声道数不匹配回退普通下混 | 主程序只有 `ambisonics.ts` 旧辅助，无解码器 | `hoaDecoder.test.ts`、`hoaSteady.test.ts`；真实 Ambisonics 曲库主观定位未验收 |
| 5.1 / 7.1 上混 | `StereoUpmixer.ts`：矩阵派生 5.1/7.1（中心/环绕/后方/LFE），下混贡献从前方扣回；进入真实双耳湿路 | 主程序无该文件 | `stereoUpmixer.test.ts`；不能恢复离散声源 |
| 串扰消除 / 音箱校准 | `CrosstalkCancellation.ts` 对称逆滤波（强度/时差平滑、反馈上限）；`SpeakerCalibration.ts` 摆位/听音位置估算 + 四路已反卷积 IR 分析 | 主程序无这两个文件 | `crosstalkCancellation.test.ts`、`speakerCalibration.test.ts`；真实音箱/房间未验收 |
| 头追输入 | `HeadPose.ts` + Host/Worklet `head-pose` 消息 + `ui/headTrackingInput.ts`：DeviceOrientation、串口、可配置 BLE GATT、OSC→本机 WebSocket、30 ms 平滑、过期/非法过滤、朝前校准；桥脚本 `npm run head-tracking:bridge` | 主程序无 head-pose 消息与头追 UI 入口 | `head-tracking-osc.test.ts`、`spatial-worklet-frame.test.ts`；具体硬件/真机延迟未验收 |
| SOFA 导入 | `ui/sofaImport.ts`（h5wasm 读真实 HDF5/SOFA）+ `HrtfDataset.ts`；支持 SimpleFreeFieldHRIR、M×2×N、32 MiB/4096 方向上限、degree/radian/Cartesian、Data.Delay、接收器顺序；IndexedDB 保存 | 主程序无 SOFA 导入 | SOFA/UI 探针与重载恢复；固定听者/固定双耳接收器约定，不做个性化生成 |
| 多声道 WAV 解码 | `src/integration/SpatialAudioSource.ts`：PCM/float/extensible、mask 或显式标签重排、未知顺序显式报告、32 输入容量 | 主程序 integration 目录无该文件 | `spatial-audio-source.test.ts`（16 项） |
| 空间全链路 Float64 | 空间后端 scratch、双耳/时域卷积频谱与历史、传播环、房间早反射总线/历史/FDN/谱反射、氛围提取、上混输出、FOA/HOA 解码输出均可 `setPrecision('float64')`；prepared 数据带 precision 校验 | 主程序无精度机制 | `precision.test.ts`、`precision-full-chain.test.ts` |
| 跨线程预准备接管 | 大型卷积 IR 频谱/空白流状态、双耳 direct IR、房间早反射谱反射 → 控制线程准备 + Transferable；Worklet 帧边界接管，失败回退本地 | 主程序无 `PreparedConvolverIR`/prepared 房间线索 | 性能补强证据；完整音频线程无分配仍未达成（见 §9） |

---

## 4. 运行时 / 性能

| 项 | 变化 | 证据 / 边界 |
| --- | --- | --- |
| WASM SIMD128 向量后端 | 新增 `src/dsp/wasmSimdKernel.ts`：运行时自研 LEB128 生成约 370 字节 WASM（f32x4/f64x2 复数乘法），无 wabt/binaryen/Rust、不 fetch 外部 .wasm、不用 relaxed-simd；`vectorKernel.ts` 成为自动后端门面（阈值 f32 256 / f64 512，低于阈值回退 TS），`processDouble()` 走 f64x2；输入/输出子视图 WeakMap/Map 缓存 | Electron AudioWorklet 探针：`wasmAvailable/simdCompiled/kernelMatches/doublePath.ok` 全 true；count=8192 **4.23×**（0.0065 ms vs 0.0275 ms），预热后 **0 视图分配**；Node 基准 4.35×。**边界**：f32 输出改为逐步 `Math.fround`，与旧版可能有 ≤1 ulp 差异；f64 与 double 逐位一致；NaN 位模式不作契约 |
| 帧边界零分配 | `AudioEffectsProcessor` 待处理房间线索改预分配缓冲 + 计数（256/256/512，超限丢最旧并计入 `timing.droppedRoomHrir`）；参数消息就地修改 structured clone 副本；`process()` 无数组字面量/闭包分配；Host 缓存消息骨架、`ir=null` 副本与 transfer 列表 | `worklet-allocation.test.ts`：稳态 128/64 帧、单声道、块长切换各 100 帧 **0 次 typed-array/Array 构造** |
| `setParams` 结构化同步 | 删除 `cloneParams/cloneSpatial` 深拷贝与全部 `JSON.stringify` 比较（主程序仍在用），改为引擎自有快照逐字段同步 + **22 个逐模块变化标志**；同长度数组/元素对象复用、IR 只复制引用 | `engine-params-allocation.test.ts`：连续 100 次相同快照 **0 次 Float32Array/Float64Array/Array 构造**、快照与子对象引用不变；单字段只重配对应模块；不修改传入 p |
| 全链路 Float64 | `Convolver / MultibandCompressor / TsConvolverBackend / BinauralConvolver / TimeConvolver / PropagationDelay / RoomSim（FDN+谱反射）/ StereoAmbienceExtractor / StereoUpmixer / AmbisonicDecoder` 全部 `setPrecision/getPrecision` 幂等切换；prepared IR/双耳/谱反射带 precision 自描述；`EngineV3` 初始/切换统一下发并修复卷积重建丢精度 | `precision.test.ts`（8 项，含上混/Ambisonics/prepared IR/重建）；**保留 Float32 的仅 HRIR/FIR 系数、源 IR 副本、HRTF 网格与 prepared 时域 HRIR（非信号路径）**；默认仍 float32 |
| 遥测 / 诊断 | `getStats/getAnalysis` 支持复用 target（Worklet 传自身存储）；Worklet stats 周期回传计时、丢弃计数与（2026-10-20 收尾保留的）超预算/配置工作量归因计数；引擎侧配置耗时与 prepared/local 归因计数仅诊断，不影响音频路径 | `worklet-telemetry-storage.test.ts`；归因数据见 `.verification/task9/`（仅参考，性能目标已取消） |

---

## 5. 主要正确性修复（相对主程序）

| 范围 | 修复 |
| --- | --- |
| EQ / Biquad | 左右滤波状态隔离；关闭/重新启用 Q 补偿恢复确定用户增益；非有限参数/非法系数防护；同批系数与 Q 补偿更新保留同一旧状态交叉淡化 |
| 响度 / 分析 | K 加权后左右能量求和（不受同相抬高/反相抵消）；相对门限按功率均值；Float64 功率历史；频谱/特征复用 scratch |
| 限幅器 | 数字瞬态即时保护、插值峰值时序、支持域约束、延迟游标/长跑队列索引、前瞻变化保留历史并平滑读取 |
| 卷积 | 频域延迟线 FDL（各分区频域求和后每块一次 IFFT）；修正预延迟历史与任意分块；大 IR 控制线程预计算 + Transferable；参数变化期间保留待提交 IR |
| Crossfeed / 齿音 | Crossfeed 独立路径；齿音左右检测能量合并、互补一阶分带避免干湿混合相位深陷、未衰减保持恒等、启用清理陈旧包络 |
| 压缩 / 低音 / M/S | 非有限控制值防护、恒等路径减少无效计算、启用/模式切换清旧状态；低音真实能量提升 + 心理声学谐波两条路径 + 真峰值余量平滑 |
| 算法混响 / 等响补偿 | 修正立体声预延迟重复推进；等响度补偿按固定 32 样本控制周期更新（脱离块长），修复同增益换频与退场频段 |
| 变速变调 | 离线声码器按声道/调用隔离相位、首尾 padding、大倍率自适应 hop、分数位置舍入、目标长度；瞬态重置/窗内位置映射/峰值邻域相位锁定；中性参数逐样本复制 |
| 重采样 / YIN / FFT | 强降采样抗混叠窗与逐相直流归一；流式背压保留未消费输入；YIN 修正 CMND 窗/累积/谷值与 DC；FFT 尺寸溢出防护、第一层蝶形专门化 |
| 块 / 线程边界 | 最多 128 帧分块；分析/控制边界拆块；预分配各长度/精度视图、空间缓冲、Worklet 静音与多段 scratch；帧开始应用最新参数快照；回调/配置/DSP 分项遥测 |

以上为纯 TS 实现及对应测试的修复；不把第三方或原生路径写成同一算法，也不宣称认证级响度/真峰值或完整无分配。

---

## 6. UI

| 范围 | 内容 |
| --- | --- |
| 调音室整体 | 九页（主页 / 音效场景 / 均衡器 / 空间音效 / 动态调音 / 分析 / 调音器 / 关于等）统一亮色薄荷主题、玻璃按钮、圆形反光滑块、卡片渐变与弹窗；响应式 1440/760/390 内容宽度；`ui/hse-main-controls.css` 与主程序 `hse-glass.css` 视觉基准一致 |
| 空间工作台 | 四种用途入口；常驻属性区；俯视/侧视二维编辑（真实屏幕变换、拖动固定比例、编号避让）；可选懒加载 3D 场景（浅色房间/地面网格/墙板/听者/音箱/方向参照，第一人称与相机独立）；A/B 原声、静音/Solo、输入格式/布局、SOFA/头追/校准面板 |
| 新增 UI 文件 | `OutputStatus`、`SpatialSceneEditor`、`SpatialWorldScene`、`spatialViewModel`、`SpeakerCalibrationPanel`、`spatial-world-view.css`、`spatial-workbench.css`、`sofaImport.ts`、`hrtfStore.ts`、`irStore.ts`、`headTrackingInput.ts`、`feedback.ts`、新增页面/组件测试 |
| 场景 / 分享串 | 11 个内置场景 + 我的场景 + 参数覆盖层（开发者模式）与发布种子；分享串保留 PEQ 段数/动态 EQ/精度/IR 名称等；场景应用经统一提交路径 |
| 分析 / 调音器 | 实时 32 条对数频率频谱（20 Hz–20 kHz）+ LUFS/GR/特征 + 听力测试，100 ms 轮询 + EMA；调音器模块排序、空间/IR 延迟与统计 |
| 验证 | UI 类型检查 + 独立预览构建；UI 回归 21 文件/195 项；九页三档宽度无横向溢出、弹窗焦点/Tab 约束/减少动态效果；截图与证据见 `.verification/ui-main-style/`、`.verification/spatial-3d-redesign-20261019/` |

---

## 7. 验证与门禁（2026-10-20 收尾）

| 检查 | 结果 |
| --- | --- |
| `npm run typecheck` | 通过 |
| `npm run typecheck:ui` | 通过 |
| 全量单测 `npx vitest run --config vitest.config.mjs` | **109 文件通过 + 3 跳过；1134 项通过 + 16 跳过**（16 跳过 = 5 项可选 LGPL + 11 项显式诊断微基准） |
| Worklet 构建 | `npm run build:worklet` 通过；产物 **507,004 bytes**（快照 `public/v3-worklet.js`） |
| Worklet 装载 / 行为 | `npm run verify:worklet` 通过：打包装载、空间/房间、多声道 HRTF 路由、IR 复用、帧边界参数/reset、可序列化节点、四声道/5.1 折叠、第三方 TS 模块 PCM |
| WASM 内核 | Electron 探针 **4.23×**（count=8192）、预热后 0 视图分配、kernelMatches/doublePath.ok；f32 ≤1 ulp 边界见 §4 |
| IR 持久化 | Electron 探针通过：跨重载恢复、用途修改、删除、32 容量 |
| 融合层 / 离线导出 | 全量中 `attachV3Engine.persistence` 10 项、`multichannel-export` 7 项、`bridgeIr` 4 项、`V3AdapterSnapshot` 2 项通过；参数唯一提交路径与 ReplayGain 注入见 §2.1；导出容器仍为双声道、pitch+多声道为近似时基 |
| 真实 Electron 图 44.1/48/96 kHz | 功能断言零失败、非有限 PCM 为零、关闭/零强度/raw A/B 差异为零；超预算（总回调）**3/4770、4/5370、9/10500**；稳态（>500 ms 后）**1/2460、0/2820、0/5640**；计时为 Date 1 ms，**不能据此声明硬实时期限通过** |
| 真实图 192 kHz | 仅压力/参考数据（completion 探针 ambix3 56/1260、spectral-early 67/2520、same-tick 99/1260），2026-10-20 起**不作为验收门槛** |
| 独立预览 | `preview:spatial` / `build:spatial-preview` 构建通过；`http://127.0.0.1:3018/spatial-debug.html` 默认静音 |

证据索引：`.verification/round-final/`（`SUMMARY.md`、`probe-{44100,48000,96000}.json`、`*worklet*`）、`.verification/spatial-*/20261019/`、`.verification/wasm-simd-20261019.md`、`.verification/engine-setparams-20261019/`、`.verification/task9/`（归因诊断，性能目标已取消）、`.verification/update35-stats.json`。

---

## 8. 已取消 / 不做（用户 2026-10-20）

| 项 | 结论 |
| --- | --- |
| 192 kHz 硬实时期限 | 放弃；真实音频文件通常不会到该采样率，192 kHz 仅保留压力/参考测量，不作为门槛 |
| 整条信号链自由排序 | 取消；输入解码/下混、空间解码、分析、最终限幅保持固定边界，既有 9 个音色/动态模块排序能力保留 |
| 宿主级零拷贝直通 | 取消（收益有限、风险高）；引擎内部逐位旁路已满足比特完美，宿主直连试验代码已移除 |
| 44.1/48/96 kHz 初始化/切换超预算 | 用户要求不再继续性能测试/优化；作为已知边界记录，不阻塞代码收尾 |
| 个性化 HRTF | 早前已按用户要求移除测量/生成/校准；通用 SOFA 加载保留 |
| Atmos / 360RA / 真实多声道设备输出 | 已排除，不列待办 |
| AI 源分离 / 人声消除 / VST2/VST3 宿主 | 已排除 |
| 主程序回流 | 仍需用户明确授权；本轮只读对照，未回流 |

---

## 9. 已知边界（未验收，不得写成已完成）

1. **严格实时期限未通过**：44.1/48/96 kHz 初始化/切换阶段仍有少量超预算（§7），计时为 Date 1 ms；不把 192 kHz 压力数据写成通过。
2. **完整音频线程无分配未达成**：帧边界零分配已达成，但控制线程每条参数消息仍有 `takePreparedRoomHrir` 的 1 个 Array（payload 会被 transfer/detach）、空间配置推导在改参/姿态消息路径仍创建 config/speakers 对象、`getStats/getAnalysis` 省略 target 时仍分配返回对象。
3. **空间验收边界**：真实耳机/音箱主观听感、特定头追硬件与延迟、真实多声道曲库端到端、硬件热切换与安装包验收未做；HRTF 前后/高度定位主观质量未认证；两声道无法唯一还原真实三维环境场。
4. **算法边界**：真峰值是有限 sinc 核近似，非认证级；等响度补偿为简化模型；SOFA 固定听者/固定接收器约定；不解析 Atmos 对象元数据，未知多声道顺序显式报告而非猜测。
5. **主程序未回流**：ReplayGain 切歌生命周期、WAV 导出、完整多声道源适配仍是主程序接线待办；快照通过不代表整个 WaveForge 编译/运行已验收。
6. **性能数据口径**：Electron 探针为隐藏窗口/静音输出、Date 时钟；Node 基准不能替代设备实时结论。

---

## 10. 回流注意事项

1. **Worklet 必须重建**：主程序必须用其自身源码执行 `npm run build:v3-worklet`（predev/prebuild 会触发），并核对实际加载的 `public/v3-worklet.js` 来自新代码；不能拷贝快照产物，也不能只看文件存在。
2. **主程序 167 文件只读**：本轮对比期间主程序工作区干净、未写入；回流前必须重新按**当前文件内容**逐文件比较（不能以旧 MANIFEST/哈希清单、抽样或随机抽检替代当前内容比较），并重新核对许可证/第三方声明。
3. **许可证**：保留模块内 `LICENSE`（CC BY-NC-ND 4.0）、`授权补充说明.md`、`THIRD_PARTY_NOTICES.md` 与 `vendor/h5wasm/LICENSE.txt`；第三方在 WaveForge 之外取用仍受原许可约束。代码标识符（`waveforge-engine-v3`、`EngineV3`、localStorage 键、`build:v3-worklet`）保持不动。
4. **接线待办**：按 `MAIN_APP_INTEGRATION_HANDOVER.md`，在主程序 `V3Adapter` 接入 ReplayGain 切歌生命周期与 WAV/MP3 导出、核对离散输入保真、补齐 `h5wasm` 依赖锁与生产 CSP 下的 SOFA/WASM 路径。
5. **门禁**：在父工程环境重跑 `npm run typecheck`/`typecheck:ui`、单测、Worklet 构建与 `verify:worklet`；Electron 图/IR 探针串行运行，避免与其它计时代理并行污染。
6. **范围**：不把本快照的 192 kHz 压力数据、初始化/切换超预算、宿主零拷贝直通等已取消/已知边界带入主程序验收口径。

---

## 附：本文档结论来源

- **实测/脚本数据**：文件数量、新增/修改/相同/缺少、文本行数、目录文件数、两份 Worklet 字节数（lead diffNote 脚本，2026-10-20）；本次另用目录遍历复核文件集合与行数完全一致。
- **源码核对（只读主程序）**：主程序缺少的文件（`DynamicEq/Crossfeed/MultibandCompressor/ReplayGain/Pcm*[/audioBuffer/ProcessingNode/wasm 等`）、主程序 `EngineV3` 仍为 `cloneParams + JSON.stringify`、主程序 `types.ts` 无精度/排序/旁路等字段、主程序 `EqChain` 20 段与无类型常量、主程序 `Compressor` 无模式字段、主程序 `Convolver` 无 purpose/prepared。
- **文档归纳**：`HANDOVER.md` §4–§6、§20，`DSP_FEATURE_GAPS.md`，`SPATIAL_AUDIO_IMPLEMENTATION.md`，`README.md`（能力清单、修复项、性能/门禁数字与边界）。
- **验证日志**：`.verification/round-final/`、`.verification/wasm-simd-20261019.md`、Worklet/IR/UI 探针记录。
