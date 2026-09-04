# Beat Analysis Service

独立的节拍分析 API 服务，用于 WaveForge 的智能混音功能。

## 功能特性

- 🎵 高质量的节拍检测（使用 librosa）
- 📊 BPM（每分钟节拍数）分析
- 🎯 小节线（downbeats）检测
- 💾 智能缓存系统
- 🌐 RESTful API 接口
- ⚡ 快速响应

## 快速启动

### Windows

双击运行 `start.bat`，脚本会自动：
1. 检查 Python 环境
2. 创建虚拟环境
3. 安装依赖
4. 启动服务

服务将运行在 `http://localhost:3002`

### 手动启动

```bash
# 1. 创建虚拟环境
python -m venv venv

# 2. 激活虚拟环境
# Windows:
venv\Scripts\activate
# Linux/Mac:
source venv/bin/activate

# 3. 安装依赖
pip install -r requirements.txt

# 4. 启动服务
python beat_analyzer.py
```

## API 接口

### 健康检查

```http
GET http://localhost:3002/health
```

响应：
```json
{
  "status": "ok",
  "service": "librosa",
  "version": "librosa-dsp-v2"
}
```

### 分析音频

```http
POST http://localhost:3002/analyze
Content-Type: application/json

{
  "trackKey": "qq-003FdJZH1wljMU",
  "audioPath": "C:/path/to/audio.mp3",
  "duration": 229
}
```

响应：
```json
{
  "schemaVersion": 1,
  "trackKey": "qq-003FdJZH1wljMU",
  "duration": 229.5,
  "provider": "librosa-fallback",
  "beats": [0.5, 1.0, 1.5, ...],
  "downbeats": [0.5, 2.5, 4.5, ...],
  "estimatedBpm": 120.5,
  "meter": 4,
  "confidence": 0.85,
  "beatFeatures": [...],
  "introSilence": 0.2,
  "outroSilence": 1.5
}
```

### 清除缓存

```http
POST http://localhost:3002/clear-cache
```

## 系统要求

- Python 3.8+
- Windows / Linux / macOS
- 至少 500MB 可用内存

## 依赖包

- flask - Web 服务框架
- flask-cors - 跨域支持
- librosa - 音频分析库
- numpy - 数值计算
- soundfile - 音频文件读取

## 缓存机制

分析结果会自动缓存到：
- Windows: `%LOCALAPPDATA%\WaveForge\cache\beat_analysis`
- Linux/macOS: `$XDG_CACHE_HOME/waveforge/beat_analysis`（未设置时为 `~/.cache/waveforge/beat_analysis`）

缓存键基于：`trackKey + duration + analysisVersion`

## 故障排除

### 端口被占用

修改 `beat_analyzer.py` 中的端口：
```python
app.run(host='0.0.0.0', port=3002)  # 改为其他端口
```

### librosa 安装失败

某些系统可能需要额外的音频库：

**Windows:**
```bash
pip install librosa soundfile
```

**Linux:**
```bash
sudo apt-get install libsndfile1
pip install librosa soundfile
```

**macOS:**
```bash
brew install libsndfile
pip install librosa soundfile
```

## 性能优化

- 首次分析一首歌需要 2-5 秒
- 缓存命中后响应时间 < 50ms
- 建议预加载即将播放的歌曲

## 许可证

MIT
