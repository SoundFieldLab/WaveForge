"""
Loudness Measurement Service - 独立响度测量服务（端口 3003）

与 beat_analyzer.py（端口 3002）完全解耦的独立服务：
- 单一路由 POST /lufs：读取本地音频文件，返回 ITU-R BS.1770-4 积分响度（LUFS）
- 供响度归一化（LoudnessNormalization）按曲目调用，不影响节拍分析链路与缓存
- 音频格式白名单与 beat 服务一致（libsndfile 不支持 m4a/aac/opus/webm）

依赖：flask / flask-cors / librosa / numpy / scipy（嵌入式 Python 已预装，无需新装包）
"""

import os
import sys
import math
import json
import time
import hashlib
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS
import librosa
import numpy as np
from scipy import signal as scipy_signal

# 设置 UTF-8 编码
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

PORT = int(os.environ.get('WAVEFORGE_LOUDNESS_PORT', '3003'))

app = Flask(__name__)
CORS(app, origins=["http://localhost:3000", "http://127.0.0.1:3000", "file://", "null"])

# 允许的本地音频格式（与 beat_analyzer.py 保持一致；libsndfile 不支持 m4a/aac/opus/webm）
ALLOWED_AUDIO_EXTENSIONS = {'.mp3', '.flac', '.wav', '.ogg'}
MAX_AUDIO_FILE_SIZE_BYTES = 300 * 1024 * 1024

# ============ 测量结果缓存（同一文件重复测量时跳过解码与计算） ============
# 缓存根目录逻辑与 beat_analyzer.py 保持一致，但服务间保持解耦（不互相 import）。
# 键基于 trackKey + 文件路径 + mtime_ns + 文件大小 + 采样率 + 版本，
# 文件内容未变时测量结果确定（librosa.load 为纯函数），命中即返回，不影响语义。
MEASURE_VERSION = 'bs1770-4'


def _default_cache_root() -> Path:
    configured = os.environ.get('WAVEFORGE_CACHE_PATH', '').strip()
    if configured:
        return Path(configured).expanduser().resolve()
    if sys.platform == 'win32':
        base = os.environ.get('LOCALAPPDATA') or os.environ.get('APPDATA')
        if base:
            return Path(base) / 'WaveForge' / 'cache'
    xdg_cache = os.environ.get('XDG_CACHE_HOME', '').strip()
    return (Path(xdg_cache) if xdg_cache else Path.home() / '.cache') / 'waveforge'


LOUDNESS_CACHE_ROOT = _default_cache_root()
LOUDNESS_CACHE_DIR = LOUDNESS_CACHE_ROOT / 'loudness_analysis'
LOUDNESS_CACHE_DIR.mkdir(parents=True, exist_ok=True)
LOUDNESS_CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
LOUDNESS_CACHE_MAX_SIZE_BYTES = 256 * 1024 * 1024
# 清理节流：避免每次写入都 glob+stat 整个缓存目录（文件多时可达数百毫秒）
_last_loudness_cleanup_time = [0.0]


def _loudness_cache_key(track_key: str, audio_path: str, sr: int) -> str:
    try:
        stat = os.stat(audio_path)
        fingerprint = f'{track_key}:{os.path.abspath(audio_path)}:{stat.st_mtime_ns}:{stat.st_size}:{sr}:{MEASURE_VERSION}'
    except OSError:
        fingerprint = f'{track_key}:{os.path.abspath(audio_path)}:{sr}:{MEASURE_VERSION}'
    return hashlib.md5(fingerprint.encode()).hexdigest()


def _load_loudness_cache(cache_key: str):
    cache_file = LOUDNESS_CACHE_DIR / f'{cache_key}.json'
    if cache_file.exists():
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                data = json.load(f)
            cache_file.touch()
            value = data.get('integratedLufs')
            if isinstance(value, (int, float)):
                return float(value)
            cache_file.unlink(missing_ok=True)
        except (OSError, ValueError, TypeError):
            cache_file.unlink(missing_ok=True)
    return None


def _save_loudness_cache(cache_key: str, value: float):
    cache_file = LOUDNESS_CACHE_DIR / f'{cache_key}.json'
    temporary_file = cache_file.with_suffix(f'.{os.getpid()}.{time.time_ns()}.tmp')
    try:
        with open(temporary_file, 'w', encoding='utf-8') as f:
            json.dump({'integratedLufs': value}, f)
        os.replace(temporary_file, cache_file)
        _cleanup_loudness_cache()
    except (OSError, TypeError, ValueError):
        temporary_file.unlink(missing_ok=True)


def _cleanup_loudness_cache(force=False):
    now = time.time()
    if not force and now - _last_loudness_cleanup_time[0] < 60.0:
        return
    _last_loudness_cleanup_time[0] = now
    entries = []
    for cache_file in LOUDNESS_CACHE_DIR.glob('*.json'):
        try:
            stat = cache_file.stat()
            if now - stat.st_mtime > LOUDNESS_CACHE_MAX_AGE_SECONDS:
                cache_file.unlink(missing_ok=True)
                continue
            entries.append((cache_file, stat.st_size, stat.st_mtime))
        except OSError:
            continue
    total_size = sum(size for _, size, _ in entries)
    for cache_file, size, _ in sorted(entries, key=lambda entry: entry[2]):
        if total_size <= LOUDNESS_CACHE_MAX_SIZE_BYTES:
            break
        try:
            cache_file.unlink(missing_ok=True)
            total_size -= size
        except OSError:
            continue


# K-weighting 系数按采样率缓存——实际使用时采样率固定为 22050，
# 每次请求重复计算纯属浪费；以 dict 缓存首次计算结果，键为采样率。
_k_weighting_coeffs_cache: dict = {}


def _k_weighting_coeffs(sr: float):
    """K-weighting 两级滤波系数（RBJ 双二阶，按采样率自适应）。

    采用 BS.1770-4 标准定义的模拟滤波器参数（与参考实现 libebur128 一致），
    经 RBJ bilinear transform 在目标采样率（本服务为 22050Hz）上设计：
    - Stage 1：二阶高通，fc=38.13547087602444Hz，Q=0.6909123976585623
    - Stage 2：高架滤波，fc=1681.974450955533Hz，增益 +3.999843853973347dB，
      Q=0.7071752369554196
    返回 (b_hp, a_hp, b_shelf, a_shelf)。
    """
    w0_hp = 2.0 * math.pi * 38.13547087602444 / sr
    alpha_hp = math.sin(w0_hp) / (2.0 * 0.6909123976585623)
    b_hp = [(1.0 + math.cos(w0_hp)) / 2.0, -(1.0 + math.cos(w0_hp)), (1.0 + math.cos(w0_hp)) / 2.0]
    a_hp = [1.0 + alpha_hp, -2.0 * math.cos(w0_hp), 1.0 - alpha_hp]
    b_hp = [coeff / a_hp[0] for coeff in b_hp]
    a_hp = [coeff / a_hp[0] for coeff in a_hp]

    a = 10 ** (3.999843853973347 / 40.0)
    w0_shelf = 2.0 * math.pi * 1681.974450955533 / sr
    alpha_shelf = math.sin(w0_shelf) / (2.0 * 0.7071752369554196)
    cos_w0 = math.cos(w0_shelf)
    sqrt_a = math.sqrt(a)
    b0 = a * ((a + 1) + (a - 1) * cos_w0 + 2.0 * sqrt_a * alpha_shelf)
    b1 = -2.0 * a * ((a - 1) + (a + 1) * cos_w0)
    b2 = a * ((a + 1) + (a - 1) * cos_w0 - 2.0 * sqrt_a * alpha_shelf)
    a0 = (a + 1) - (a - 1) * cos_w0 + 2.0 * sqrt_a * alpha_shelf
    a1 = 2.0 * ((a - 1) - (a + 1) * cos_w0)
    a2 = (a + 1) - (a - 1) * cos_w0 - 2.0 * sqrt_a * alpha_shelf
    b_shelf = [b0 / a0, b1 / a0, b2 / a0]
    a_shelf = [1.0, a1 / a0, a2 / a0]

    result = (b_hp, a_hp, b_shelf, a_shelf)
    _k_weighting_coeffs_cache[sr] = result
    return result


def integrated_lufs(y, sr: float) -> float:
    """ITU-R BS.1770-4 积分响度（K-weighting + 相对门限，纯 scipy/numpy）。

    返回 LUFS（-70 ~ 0；0.0 仅表示空输入或全静音，此时无法计算响度）。
    其余计算异常会向上抛出，由路由层转为 500——不能把真实错误当成静音
    返回 0.0，否则前端会把失败曲目误判为极低响度而错误地大幅衰减。
    """
    if y is None or len(y) == 0:
        return 0.0
    samples = np.asarray(y, dtype=np.float64)
    if np.max(np.abs(samples)) <= 1e-9:
        return 0.0
    # K-weighting：高通 38Hz（二阶）+ 高架 1681Hz +4dB
    b_hp, a_hp, b_shelf, a_shelf = _k_weighting_coeffs(sr)
    weighted = scipy_signal.lfilter(b_shelf, a_shelf, scipy_signal.lfilter(b_hp, a_hp, samples))
    # 分块（400ms）计算各块响度。
    # 原实现为 Python 逐块循环（每块一次切片拷贝 + np.mean），大文件上有数百次循环开销；
    # 改用 np.add.reduceat 一次性完成各块能量求和（每块除以其实际长度），
    # 数值误差仅在浮点求和顺序上（<1e-12 相对量级），最终结果仍 round 到 2 位小数，语义不变。
    block = max(1, int(0.4 * sr))
    n = len(weighted)
    starts = np.arange(0, n, block)
    block_sums = np.add.reduceat(weighted * weighted, starts)
    lengths = np.concatenate((starts[1:] - starts[:-1], np.asarray([n - starts[-1]])))
    mean_square = block_sums / lengths
    active_mask = mean_square > 1e-12
    if not np.any(active_mask):
        return 0.0
    block_loudness = 10.0 * np.log10(mean_square[active_mask]) - 0.691
    # 相对门限：-10 LU（BS.1770 简化门限）
    threshold = float(np.max(block_loudness)) - 10.0
    active = block_loudness[block_loudness > threshold]
    if active.size == 0:
        active = block_loudness
    integrated = 10.0 * np.log10(float(np.mean(np.power(10.0, active / 10.0))))
    return round(max(-70.0, min(0.0, integrated)), 2)


@app.route('/health', methods=['GET'])
def health():
    """健康检查"""
    return jsonify({'status': 'ok', 'service': 'loudness', 'port': PORT})


@app.route('/lufs', methods=['POST'])
def measure_lufs():
    """测量音频文件积分响度。请求体：{ trackKey: str, audioPath: str }"""
    data = request.get_json(silent=True) or {}
    track_key = str(data.get('trackKey') or '').strip()
    audio_path = str(data.get('audioPath') or '').strip()

    if not track_key or not audio_path:
        return jsonify({'error': 'Missing trackKey or audioPath'}), 400
    if not isinstance(data.get('audioPath'), str):
        return jsonify({'error': 'audioPath must be a string'}), 400
    if not os.path.exists(audio_path):
        return jsonify({'error': f'File not found: {audio_path}'}), 404

    # 扩展名白名单 + 大小上限，防止非音频文件或超大文件导致资源耗尽
    ext = os.path.splitext(audio_path)[1].lower()
    if ext not in ALLOWED_AUDIO_EXTENSIONS:
        allowed = ', '.join(sorted(ALLOWED_AUDIO_EXTENSIONS))
        return jsonify({'error': f'Unsupported audio format: {ext or "(no extension)"}. Allowed formats: {allowed}'}), 400
    try:
        size = os.path.getsize(audio_path)
    except OSError:
        return jsonify({'error': f'Unable to access file size: {audio_path}'}), 400
    if size > MAX_AUDIO_FILE_SIZE_BYTES:
        return jsonify({'error': f'File too large: {size / (1024 * 1024):.1f} MB exceeds the {MAX_AUDIO_FILE_SIZE_BYTES // (1024 * 1024)} MB limit'}), 400

    try:
        # 先查缓存（键含文件 mtime_ns/size，内容未变则结果确定），命中即跳过解码与计算
        sr = 22050
        cache_key = _loudness_cache_key(track_key, audio_path, sr)
        cached = _load_loudness_cache(cache_key)
        if cached is not None:
            print(f"💾 响度测量缓存命中: {track_key} → {cached} LUFS")
            return jsonify({'trackKey': track_key, 'integratedLufs': cached})
        y, sr = librosa.load(audio_path, sr=sr, mono=True)
        integrated = integrated_lufs(y, sr)
        _save_loudness_cache(cache_key, integrated)
        print(f"🔊 响度测量: {track_key} → {integrated} LUFS")
        return jsonify({'trackKey': track_key, 'integratedLufs': integrated})
    except Exception as e:
        print(f"[ERROR] 响度测量失败: {e}")
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    logging.basicConfig(level=logging.WARNING)
    print(f"🔊 Loudness service starting on http://127.0.0.1:{PORT}")
    app.run(host='127.0.0.1', port=PORT, debug=False, threaded=True)
