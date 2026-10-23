# HSE TypeScript 扩展节点

本接口位于独立快照中。扩展节点按注册顺序在空间处理和 Crossfeed 之后、次声高通和最终限幅器之前运行。关闭最终限幅器时，扩展作者应自行控制输出幅度。

## 内建组合

```ts
host.registerSerializableProcessingNode({
  id: 'custom-chain', kind: 'chain', nodes: [
    { id: 'swap', kind: 'matrix', ll: 0, lr: 1, rl: 1, rr: 0 },
    { id: 'eq', kind: 'biquad', type: 'peaking', frequency: 1200, q: 1, gainDb: -2 },
    { id: 'fir', kind: 'fir', coefficients: [0.5, 0.25, 0.25] },
    { id: 'delay', kind: 'delay', samples: 64 },
    { id: 'saturation', kind: 'waveshaper', drive: 1.5, mix: 0.1 },
  ],
})
```

内建类型包括 gain、biquad、matrix、delay、fir、waveshaper、chain。每个节点可设 `enabled:false`。组合按子节点顺序处理，并汇总启用节点的额外延迟。FIR 是因果直接卷积，没有另加块缓存；滤波器相位响应不作为固定延迟补偿。delay 上限为当前采样率的两秒，FIR 为 1–4096 个系数，整个组合最多 128 个节点、嵌套最多八层。长 FIR 或密集组合应测量目标机器负载。

注册会保存深快照；相同 ID 替换节点，重新初始化流状态。参数更新没有隐式交叉淡化。处理器在创建时分配历史，`processStereo` 不应分配或阻塞。函数节点仅支持 script 模式；Worklet 使用下方模块协议。

## 第三方 TS 模块

1. TS 模块调用 `registerProcessingNodeFactory(type, factory)`。工厂接收 `{id, data, sampleRate}`，返回 `HseProcessingNode`；`processStereo`、`reset`、`getLatencySamples` 都保留 `this` 绑定。工厂必须验证自己的数据语义，返回 ID 必须与请求一致。
2. 应用主线程 import 该模块，供脚本模式、离线导出和控制线程参照引擎使用。
3. 用现有 esbuild 把同一 TS 模块单独打包为不含 import 的 JS 文件；把输出 URL 放入 `EngineV3Host({ processingModuleUrls: [...] })`。宿主先装载主 Worklet，再装载这些可信模块，最后创建并注册节点；每次重新挂接均走同一流程。示例源码见快照根目录 `examples/dc-blocker.ts`。
4. 通过描述注册 DSP：

```ts
host.registerSerializableProcessingNode({
  id: 'dc-filter', kind: 'custom', type: 'example/dc-blocker',
  data: { cutoffHz: 20 },
})
```

`custom` 可嵌套于 chain。`data` 只接受 null、boolean、有限 number、string、数组和普通对象；会深拷贝，限制深度 12、值总数 8192，拒绝循环/函数/类实例。模块中的代码是应用信任的代码，参数消息不会携带或执行函数源码。两个线程分别创建 DSP 实例和流状态。

工厂注册函数返回注销回调；注销仅影响后续创建，已存在的节点继续运行。同名不同工厂重复注册会抛错。`host.unregisterProcessingNode(id)` 移除具体节点。Worklet 模块装载失败遵循宿主模式：auto 尝试 script 回退，worklet 模式恢复音频直连后报告接入失败。

## 验证

`npm test` 验证组合顺序、跨块 FIR/延迟、reset、参数隔离、工厂校验及宿主模块装载。`npm run verify:worklet` 将示例 TS 单独打包后在隔离 Worklet 全局中运行，并核对实际 PCM。`npm run probe:graph -- --rate=96000 --auto-layout --budget=auto --probe-nodes --output=.verification/custom-96000.json` 在真实隐藏 Electron 图中装载扩展模块并检查有限非静音输出。
