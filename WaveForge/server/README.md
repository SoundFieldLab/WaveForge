# Beat This Analysis Integration Setup Guide

## 概述

WaveForge 使用 Beat This 进行高精度的节拍检测，这是实现智能无缝衔接（AutoMix）的核心技术。

## 系统要求

- Python 3.13.x（Windows x64 嵌入式运行时）
- 至少 2GB 可用内存
- 依赖约 2GB 磁盘空间（Torch/torchaudio 不包含模型权重）
- Beat This `final0` checkpoint：首次运行前单独获取并校验 SHA-256

## 依赖锁与打包

根目录 [`requirements.txt`](../requirements.txt) 是唯一规范依赖锁，包含 Beat This、兼容的 `torch==2.7.1`/`torchaudio==2.7.1`、`einops`、`rotary-embedding-torch`、`soxr` 及运行时依赖。`server/requirements.txt` 和 `python-beat-service/requirements.txt` 仅转发到该文件；不要在它们中维护第二份版本范围。

运行 `npm run bundle-python` 时，脚本只从根目录锁文件安装二进制 wheel，并在嵌入式运行时写入 `VERSION.json`。脚本不会下载或捆绑 Beat This 权重；构建完成不代表模型可用。

## 首次模型获取

模型缓存默认位置是 `%LOCALAPPDATA%\\WaveForge\\cache\\torch\\hub\\checkpoints\\beat_this-final0.ckpt`；在启动前设置 `TORCH_HOME` 可覆盖其父缓存目录。从 Beat This 上游获取 `final0` checkpoint 后，设置以下环境变量再启动 `python-beat-service\\start.bat`：

```bat
set WAVEFORGE_BEAT_MODEL_PATH=C:\\path\\to\\final0.ckpt
set WAVEFORGE_BEAT_MODEL_SHA256=<independently-verified-sha256>
```

启动脚本在服务启动前会校验文件存在性和 SHA-256，然后复制到 Beat This/Torch Hub 约定的 `beat_this-final0.ckpt` 路径，并把 `TORCH_HOME` 固定到 WaveForge 用户缓存。缺少路径、摘要或校验失败会明确终止；不会回退到未经校验的下载，也不会在线安装依赖。当前仓库没有声明一个已核实的上游权重 SHA-256，因此必须由发布流程在确认具体文件后填写环境变量。

### 1. 安装 Python 依赖

在仓库根目录运行（网络安装由调用方自行控制；本任务不执行安装）：

```bash
python -m pip install -r requirements.txt
```

服务目录中的 `server/requirements.txt` 是同一锁文件的转发入口。

### 2. 验证安装

运行测试脚本：

```bash
python test_beat_this.py
```

如果所有测试通过，说明 Beat This 已正确安装。

## 依赖项说明

安装的主要包：

- **beat-this**: 高精度节拍检测模型
- **librosa**: 音频特征提取库
- **pedalboard**: 音频处理和时间拉伸（Spotify 开源）
- **soundfile**: 音频文件读写
- **numpy/scipy**: 科学计算库

## 架构说明

```
┌─────────────────┐
│  Electron Main  │
│   (Node.js)     │
└────────┬────────┘
         │ IPC
         │ (spawn + stdio)
         ▼
┌─────────────────┐
│ Python Worker   │
│ analysis_worker │
│    .py          │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Beat This     │
│   (PyTorch)     │
└─────────────────┘
```

### 工作流程

1. **启动**: Electron Main 在需要时启动 Python worker 进程
2. **通信**: 通过 stdin/stdout 的 JSON 消息通信
3. **分析**: Worker 使用 Beat This 分析音频文件
4. **缓存**: 分析结果保存在 `userData/analysis-cache/tracks/`
5. **空闲**: Worker 在空闲 1 分钟后自动关闭

## 缓存目录结构

```
analysis-cache/
├── tracks/              # 歌曲分析结果（长期保留）
│   └── {hash}.json
├── transition-plans/    # 过渡计划（中期保留）
│   └── {hash}.json
├── transition-renders/  # 渲染音频（短期保留，LRU）
│   └── {id}.webm
└── temp/                # 临时下载文件（任务后删除）
    └── {hash}.mp3
```

## API 使用示例

### TypeScript (Renderer)

```typescript
import { analysisService } from './services/analysisService'

// 分析一首歌
const trackKey = analysisService.generateTrackKey({
  platform: 'netease',
  id: '123456',
  duration: 240
})

const analysis = await analysisService.analyzeTrack(
  trackKey,
  audioUrl,
  240,
  (progress) => {
    console.log(`${progress.stage}: ${progress.progress}%`)
  }
)

if (analysis) {
  console.log(`Found ${analysis.beats.length} beats`)
  console.log(`BPM: ${analysis.estimatedBpm}`)
}
```

### JavaScript (Main Process)

```javascript
// 在 desktop/main.cjs 中
const { createAnalysisRuntime } = require('./analysis-runtime.cjs')

// 初始化
const analysisRuntime = createAnalysisRuntime(app, ipcMain, getMainWindow)

// 检查状态
const status = analysisRuntime.runtimeStatus()
console.log('Analysis available:', status.available)
```

## 性能特征

### 分析速度

- **CPU 模式**: 约 5-10x 实时速度
  - 3 分钟歌曲需要 18-36 秒分析
- **首次启动**: 额外增加 2-5 秒（模型加载）
- **缓存命中**: < 50ms（直接读取）

### 内存使用

- Python Worker: ~300-500MB（含模型）
- 临时音频文件: 取决于音频大小（通常 5-15MB/首）
- 分析缓存: ~10KB/首

## 故障排除

### Python 未找到

错误: `Python executable not found`

解决:
1. 确保已安装 Python 3.8+
2. 将 Python 添加到 PATH
3. 或在 `analysis-runtime.cjs` 中指定 Python 路径

### 模块导入失败

错误: `ModuleNotFoundError: No module named 'beat_this'`

解决:
```bash
cd server
python -m pip install -r requirements.txt
```

### 模型下载失败或未配置

错误: `Beat This weights are not bundled`、`WAVEFORGE_BEAT_MODEL_SHA256 is required` 或 `SHA-256 mismatch`

解决:
1. 从 Beat This 上游获取 `final0` checkpoint（URL 与缓存约定见“首次模型获取”）。
2. 对实际下载文件计算 SHA-256，并设置 `WAVEFORGE_BEAT_MODEL_PATH` 与 `WAVEFORGE_BEAT_MODEL_SHA256`。
3. 重新启动服务；校验失败时不要使用该文件。

仓库未包含模型权重，也未将未知的上游摘要写入锁文件，因此不能在没有发布流程确认的情况下声称权重可复现。

### Worker 启动超时

错误: `Worker request timeout`

可能原因:
- Python 环境问题
- 首次模型加载慢
- 内存不足

解决:
- 运行 `test_beat_this.py` 诊断
- 增加 WORKER_TIMEOUT_MS
- 检查系统内存

## 开发调试

### 查看 Worker 日志

Worker 的 stderr 输出会显示在 Electron 主进程控制台：

```bash
npm run dev:electron
# 查看控制台中 [Python Worker] 开头的日志
```

### 手动测试 Worker

```bash
cd server
python analysis_worker.py
```

然后输入 JSON 消息：

```json
{"type": "status", "id": "test1"}
{"type": "analyze", "id": "test2", "audioPath": "/path/to/test.mp3", "trackKey": "test:123:180"}
{"type": "exit", "id": "test3"}
```

### 清除缓存

在应用中：设置 → AutoMix → 清除分析缓存

或手动删除：
```bash
rm -rf ~/AppData/Roaming/WaveForge/analysis-cache  # Windows
rm -rf ~/Library/Application\ Support/WaveForge/analysis-cache  # macOS
```

## 下一步

Phase 1 完成后，继续实施：

- **Phase 2**: 智能过渡点选择算法
- **Phase 3**: 逐拍渲染引擎（使用 Pedalboard）

参考 `无缝衔接完整方案.txt` 获取完整开发计划。
