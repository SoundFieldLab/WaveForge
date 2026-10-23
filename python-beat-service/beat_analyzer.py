# 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
# 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
"""
Beat Analysis Service - 独立的节拍分析 API 服务
使用 librosa 进行高质量的节拍和 BPM 检测
"""

import os
import sys
import json
import hashlib
import time
import logging
import threading
from logging.handlers import RotatingFileHandler
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from flask import Flask, request, jsonify
from flask.json.provider import DefaultJSONProvider
from flask_cors import CORS
from local_service_auth import _allowed_roots, is_allowed_audio_path, is_authorized_local_request
import librosa
import numpy as np
import soundfile as sf

try:
    from beat_this.inference import Audio2Beats
    BEAT_THIS_IMPORT_ERROR = None
except ImportError as error:
    Audio2Beats = None
    BEAT_THIS_IMPORT_ERROR = f'{error.__class__.__name__}: Beat This runtime unavailable'

BEAT_THIS_CHECKPOINT = os.environ.get('BEAT_THIS_CHECKPOINT') or os.environ.get('WAVEFORGE_BEAT_MODEL_PATH') or 'final0'
BEAT_THIS_TRACKER = None
BEAT_THIS_INFERENCE_LOCK = threading.Lock()
BEAT_THIS_INIT_ERROR = BEAT_THIS_IMPORT_ERROR
if Audio2Beats is not None:
    try:
        # Audio2Beats(signal, sr)：analyze_audio_file 已用 librosa 解码出 22050Hz 单声道
        # PCM，直接喂波形（signal2spect 对 sr==22050 跳过重采样）。此前用 File2Beats
        # 却按 (y, sr) 两参调用——File2Beats.__call__ 只收 audio_path，任何分析请求都会
        # 在这里抛裸 TypeError（实测 Can't look away 截断 FLAC → 500 → worker 全崩）。
        BEAT_THIS_TRACKER = Audio2Beats(checkpoint_path=BEAT_THIS_CHECKPOINT, device='cpu', float16=False, dbn=False)
        BEAT_THIS_INIT_ERROR = None
    except Exception as error:
        BEAT_THIS_INIT_ERROR = f'{error.__class__.__name__}: Beat This model initialization failed'


# 设置 UTF-8 编码
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

app = Flask(__name__)
CORS(app, origins=["http://localhost:3000", "http://127.0.0.1:3000", "file://", "null"], allow_headers=["Content-Type", "X-WaveForge-Local-Token"])


class _NumpyAwareJSONProvider(DefaultJSONProvider):
    """jsonify 直编 numpy：免去 convert_to_native_types 对整棵响应树（数万节点）的
    纯 Python 递归重建——响应对象里残余的少量 numpy 标量/数组由 default() 兜底转换。"""

    def default(self, o):
        if isinstance(o, np.integer):
            return int(o)
        if isinstance(o, np.floating):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
        if isinstance(o, np.bool_):
            return bool(o)
        return super().default(o)


app.json = _NumpyAwareJSONProvider(app)


@app.before_request
def require_local_service_token():
    if not is_authorized_local_request(request.headers.get('X-WaveForge-Local-Token', '')):
        return jsonify({'error': 'unauthorized'}), 403
    return None


def default_cache_root() -> Path:
    configured = os.environ.get("WAVEFORGE_CACHE_PATH", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    if sys.platform == "win32":
        base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA")
        if base:
            return Path(base) / "WaveForge" / "cache"
    xdg_cache = os.environ.get("XDG_CACHE_HOME", "").strip()
    return (Path(xdg_cache) if xdg_cache else Path.home() / ".cache") / "waveforge"


CACHE_ROOT = default_cache_root()
CACHE_DIR = CACHE_ROOT / "beat_analysis"
CACHE_DIR.mkdir(parents=True, exist_ok=True)

ANALYSIS_VERSION = "beat-this-hpss-v2"
CACHE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60
CACHE_MAX_SIZE_BYTES = 512 * 1024 * 1024

# 允许分析的本地音频格式（小写扩展名）
ALLOWED_AUDIO_EXTENSIONS = {
    '.mp3', '.flac', '.wav', '.ogg',
}
# 音频文件大小上限（300MB），防止超大文件被整体读入内存导致资源耗尽
MAX_AUDIO_FILE_SIZE_BYTES = 300 * 1024 * 1024


# 缓存清理节流：cleanup_cache() 需要 glob+stat 整个缓存目录，
# 在缓存文件较多时开销可达数百毫秒（实测 3000 文件约 585ms）。
# 每次 save 都全量清理会显著拖慢新曲目分析，故按时间节流——最多每 60 秒清理一次，
# 缓存总量上限与过期清理改为"最终一致"（延后至多 60 秒生效），不影响输出语义。
_last_cleanup_time = [0.0]
_CACHE_CLEANUP_LOCK = threading.Lock()
_ANALYSIS_LIMIT = max(1, int(os.environ.get('WAVEFORGE_ANALYSIS_CONCURRENCY', '2')))
_ANALYSIS_SEMAPHORE = threading.BoundedSemaphore(_ANALYSIS_LIMIT)
_INFLIGHT_ANALYSES = {}
_INFLIGHT_LOCK = threading.Lock()


def cleanup_cache(force=False):
    """删除过期缓存、临时文件，并按最近使用时间把总量限制在 512MB。"""
    now = time.time()
    with _CACHE_CLEANUP_LOCK:
        if not force and now - _last_cleanup_time[0] < 60.0:
            return
        _last_cleanup_time[0] = now
        entries = []
        for cache_file in CACHE_DIR.iterdir():
            try:
                stat = cache_file.stat()
                if cache_file.suffix == '.tmp' or cache_file.name.endswith('.tmp'):
                    if now - stat.st_mtime > 300:
                        cache_file.unlink(missing_ok=True)
                    continue
                if cache_file.suffix != '.json' or now - stat.st_mtime > CACHE_MAX_AGE_SECONDS:
                    # 与 loudness_server 单分支写法一致；此前的内层条件是外层的严格子集
                    # （合并失误的死代码），且缺少 is_file() 守卫语义
                    if cache_file.is_file():
                        cache_file.unlink(missing_ok=True)
                    continue
                entries.append((cache_file, stat.st_size, stat.st_mtime))
            except OSError:
                continue

        total_size = sum(size for _, size, _ in entries)
        for cache_file, size, _ in sorted(entries, key=lambda entry: entry[2]):
            if total_size <= CACHE_MAX_SIZE_BYTES:
                break
            try:
                cache_file.unlink(missing_ok=True)
                total_size -= size
            except OSError:
                continue

def convert_to_native_types(obj):
    """递归转换 numpy 类型为 Python 原生类型"""
    if isinstance(obj, np.integer):
        return int(obj)
    elif isinstance(obj, np.floating):
        return float(obj)
    elif isinstance(obj, np.ndarray):
        return obj.tolist()
    elif isinstance(obj, dict):
        return {key: convert_to_native_types(value) for key, value in obj.items()}
    elif isinstance(obj, list):
        return [convert_to_native_types(item) for item in obj]
    else:
        return obj

def get_cache_key(track_key: str, duration: float, audio_path: str = '', source_signature: str = '') -> str:
    """生成与实际音频文件绑定的缓存键，避免同曲换源后复用旧分析。"""
    resolved_path = os.path.normcase(os.path.abspath(audio_path)) if audio_path else ''
    try:
        stat = os.stat(audio_path)
        file_identity = f'{resolved_path}:{stat.st_mtime_ns}:{stat.st_size}'
    except OSError:
        file_identity = resolved_path
    # duration 不进指纹：它是客户端上报值（不同调用方取整不同），同一文件会生成不同键
    # 触发十秒级全量重算；文件身份 (path+mtime_ns+size) 已足够防换源复用。
    # duration 仍随结果返回用于 UI 展示，不影响分析一致性。
    fingerprint = f'{track_key}:{file_identity}:{source_signature}:{ANALYSIS_VERSION}'
    return hashlib.md5(fingerprint.encode()).hexdigest()

def load_from_cache(cache_key: str):
    """从缓存加载分析结果"""
    cache_file = CACHE_DIR / f"{cache_key}.json"
    if cache_file.exists():
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                value = json.load(f)
            cache_file.touch()
            return value
        except (OSError, ValueError, TypeError):
            cache_file.unlink(missing_ok=True)
    return None

def save_to_cache(cache_key: str, data: dict):
    """保存分析结果到缓存"""
    cache_file = CACHE_DIR / f"{cache_key}.json"
    temporary_file = cache_file.with_suffix(f".{os.getpid()}.{time.time_ns()}.tmp")
    try:
        with open(temporary_file, 'w', encoding='utf-8') as f:
            json.dump(data, f)
        os.replace(temporary_file, cache_file)
        cleanup_cache()
    except (OSError, TypeError, ValueError):
        temporary_file.unlink(missing_ok=True)

def _detect_sections(beat_features, duration):
    if not beat_features:
        return []

    sections = [{
        'time': beat_features[0]['time'],
        'beatIndex': 0,
        'type': 'intro',
        'confidence': 0.7,
    }]
    # 向量化：timbre/chroma 已是等长向量，预先堆成矩阵一次算完相邻余弦距离，
    # 替代原来逐对 np.asarray×4 + 逐对 np.linalg.norm 的 N 次小数组重建。
    n = len(beat_features)
    novelty = np.zeros(n, dtype=float)
    if n >= 2:
        timbre = np.asarray([f['timbre'] for f in beat_features], dtype=float)
        chroma = np.asarray([f['chroma'] for f in beat_features], dtype=float)
        energy = np.asarray([f['energy'] for f in beat_features], dtype=float)

        def _pair_cosine_prev(matrix):
            # rows[i] 与 rows[i-1] 的余弦相似度（i>=1），首行占位 0
            if matrix.shape[0] < 2:
                return np.zeros(matrix.shape[0], dtype=float)
            norms = np.linalg.norm(matrix, axis=1)
            dots = np.einsum('ij,ij->i', matrix[1:], matrix[:-1])
            denom = np.maximum(norms[1:] * norms[:-1], 1e-12)
            sim = np.clip(dots / denom, -1.0, 1.0)
            return np.concatenate([[0.0], 1.0 - sim])

        timbre_dist = _pair_cosine_prev(timbre)
        chroma_dist = _pair_cosine_prev(chroma)
        prev_energy = np.maximum(energy[:-1], 1e-6)
        energy_jump = np.minimum(1.0, np.abs(np.diff(energy)) / prev_energy)
        novelty[1:] = timbre_dist[1:] * 0.45 + chroma_dist[1:] * 0.25 + energy_jump * 0.30

    threshold = float(np.percentile(novelty, 82)) if len(novelty) >= 8 else 1.0
    last_boundary = 0
    for index in range(4, len(beat_features) - 4):
        if index - last_boundary < 8 or novelty[index] < threshold:
            continue
        if novelty[index] < max(novelty[index - 2:index + 3]):
            continue
        before_energy = np.mean([frame['energy'] for frame in beat_features[index - 4:index]])
        after_energy = np.mean([frame['energy'] for frame in beat_features[index:index + 4]])
        if after_energy > before_energy * 1.22:
            section_type = 'drop'
        elif after_energy < before_energy * 0.78:
            section_type = 'break'
        else:
            section_type = 'chorus'
        sections.append({
            'time': beat_features[index]['time'],
            'beatIndex': index,
            'type': section_type,
            'confidence': float(np.clip(0.45 + novelty[index] * 0.5, 0.45, 0.95)),
        })
        last_boundary = index

    outro_index = next(
        (index for index, frame in enumerate(beat_features) if frame['time'] >= duration * 0.82),
        len(beat_features) - 1,
    )
    if not sections or abs(sections[-1]['beatIndex'] - outro_index) >= 8:
        sections.append({
            'time': beat_features[outro_index]['time'],
            'beatIndex': outro_index,
            'type': 'outro',
            'confidence': 0.6,
        })
    return sections


def _detect_silence_bounds(y: np.ndarray, sr: int, frame_duration: float = 0.05) -> tuple:
    """固定绝对阈值（-45dBFS）的首尾静音边界（秒）。

    语义与浏览器回退分析保持一致：逐帧 RMS 对比绝对幅度阈值，不随曲目响度
    自适应（相对峰值/中位数的自适应阈值会把安静乐段误判成静音，导致裁剪点
    漂移）。帧长 50ms，边界取最后一帧有声位置的帧边界。
    """
    amplitude_threshold = 10.0 ** (-45.0 / 20.0)  # ≈0.00562 线性幅度
    frame_len = max(1, int(sr * frame_duration))
    n_frames = len(y) // frame_len
    if n_frames <= 0:
        return 0.0, 0.0
    frames = np.abs(y[: n_frames * frame_len].reshape(n_frames, frame_len))
    rms = np.sqrt(np.mean(frames * frames, axis=1))
    loud = np.nonzero(rms > amplitude_threshold)[0]
    if len(loud) == 0:
        return 0.0, 0.0
    first = int(loud[0])
    last = int(loud[-1])
    intro = first * frame_duration
    outro = max(0.0, (n_frames - (last + 1)) * frame_duration)
    return float(intro), float(outro)


def _extract_beat_features(y: np.ndarray, sr: int, beats: np.ndarray) -> list:
    hop_length = 512
    beat_frames = librosa.time_to_frames(beats, sr=sr, hop_length=hop_length)
    # STFT 只算一次：magnitude 显式算出后同时喂 mfcc（S= 预算参数）与 spectral_flatness，
    # 避免 mfcc 内部再做一遍 STFT、flatness 再做一遍（同一信号三遍频谱）。
    # chroma 用 chroma_stft 复用同一份 magnitude——chroma_cqt 的 CQT 滤波器组是全曲
    # 最贵特征而这里只取逐拍均值，chroma_stft 与之高度相关且几乎免费。
    magnitude = np.abs(librosa.stft(y, hop_length=hop_length))
    chroma = librosa.feature.chroma_stft(S=magnitude, sr=sr)
    mfcc = librosa.feature.mfcc(S=librosa.power_to_db(magnitude ** 2), sr=sr, n_mfcc=13)
    rms_frames = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    zcr_frames = librosa.feature.zero_crossing_rate(y, hop_length=hop_length)[0]
    flatness_frames = librosa.feature.spectral_flatness(S=magnitude)[0]
    frequencies = librosa.fft_frequencies(sr=sr, n_fft=magnitude.shape[0] * 2 - 2)
    vocal_band = (frequencies >= 180) & (frequencies <= 4200)
    feature_frame_count = min(chroma.shape[1], mfcc.shape[1], len(rms_frames), len(zcr_frames), magnitude.shape[1], len(flatness_frames))
    # 逐拍 dB 全拍向量化：此前每拍对单元素数组调 amplitude_to_db（Python 循环 × N）
    loudness_db = librosa.amplitude_to_db(np.maximum(np.asarray(rms_frames, dtype=float), 1e-8), ref=1.0)
    features = []
    for index, beat_time in enumerate(beats):
        start = min(int(beat_frames[index]), max(0, feature_frame_count - 1))
        end = int(beat_frames[index + 1]) if index + 1 < len(beat_frames) else min(feature_frame_count, start + 24)
        end = max(start + 1, min(feature_frame_count, end))
        frame_slice = slice(start, end)
        rms = float(np.mean(rms_frames[frame_slice])) if start < len(rms_frames) else 0.0
        spectrum = magnitude[:, frame_slice]
        total_energy = float(np.sum(spectrum))
        mid_energy = float(np.sum(spectrum[vocal_band])) / max(1e-9, total_energy)
        flatness = float(np.mean(flatness_frames[frame_slice])) if start < len(flatness_frames) else 1.0
        zcr = float(np.mean(zcr_frames[frame_slice])) if start < len(flatness_frames) else 1.0
        vocalness = float(np.clip(mid_energy * np.sqrt(max(0.0, 1.0 - flatness)) * (1.0 - min(1.0, zcr * 5.0)), 0.0, 1.0))
        # loudness 取该拍帧区间内的 dB 均值（向量化预算见上）；与旧「首帧单点 dB」相比
        # 更平滑且同量纲——rms 已按帧区间取均值，对齐同一口径。
        loudness_slice = loudness_db[frame_slice] if start < len(loudness_db) else None
        features.append({
            'beatIndex': index,
            'time': float(beat_time),
            'loudness': float(np.mean(loudness_slice)) if loudness_slice is not None else (float(librosa.amplitude_to_db(np.asarray([max(rms, 1e-8)]), ref=1.0)[0])),
            'rms': rms,
            'chroma': np.mean(chroma[:, frame_slice], axis=1).astype(float).tolist(),
            'timbre': np.mean(mfcc[:, frame_slice], axis=1).astype(float).tolist(),
            'vocalness': vocalness,
            'energy': rms * rms,
        })
    return features


def analyze_audio_file(file_path: str, track_key: str, source_signature: str = '', reported_duration: float = 0.0) -> dict:
    """Analyze beat timing with required Beat This plus librosa feature extraction."""
    if BEAT_THIS_TRACKER is None:
        raise RuntimeError(BEAT_THIS_INIT_ERROR or 'Beat This model is unavailable')
    print(f"📊 开始分析音频: {track_key}")
    print(f"   文件路径: {file_path}")

    y, sr = librosa.load(file_path, sr=22050, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))
    print(f"   音频时长: {duration:.2f}s, 采样率: {sr}Hz")
    # 截断/试听片段警告：上报时长与实际解码明显不符 = 空 vkey/试听流
    #（实测 370s 的歌存下 176.5s 的合法 FLAC——文件头正常、能解，但只有半首）。
    # duration 恒用实际解码值（上报值只影响这条日志），下游脏缓存防线不会被半首分析骗过。
    if reported_duration > 5 and reported_duration - duration > 5:
        print(f"   ⚠️ 音频明显短于上报时长：解码={duration:.1f}s 上报={reported_duration:.0f}s（截断/试听片段）")

    # 打击乐预分离（folia 0.7.21 智能动感同思路）：beat_this 直接吃全混音 mel 时，
    # 人声/和声/持续低音的 onset 会污染拍点检测——电子乐与人声主导的曲目上
    # "鼓点抓不准"的主因。librosa HPSS（中值滤波谐波/打击乐分离）把 percussive
    # 分量提出来再喂模型：拍点证据更纯。仅在打击乐能量占比不极端时启用
    #（纯人声/管弦曲目 HPSS 反而会削掉真实证据）；HPSS 代价约整曲解码的 +30%，
    # 结果进缓存，只付一次。
    beat_input = y
    try:
        harmonic, percussive = librosa.effects.hpss(y, margin=(1.0, 2.0))
        h_energy = float(np.sum(harmonic ** 2))
        p_energy = float(np.sum(percussive ** 2))
        total = h_energy + p_energy
        p_ratio = p_energy / total if total > 1e-9 else 0.0
        if 0.04 <= p_ratio <= 0.9:
            beat_input = percussive
            print(f"   🥁 HPSS 打击乐占比 {p_ratio:.2f} → 拍点检测使用打击乐分量")
        else:
            print(f"   🎼 HPSS 打击乐占比 {p_ratio:.2f}（过低/过高，拍点检测保持全混音）")
    except Exception as hpss_error:
        print(f"   ⚠️ HPSS 失败（退回全混音）: {hpss_error.__class__.__name__}: {hpss_error}")

    # 复用已解码信号：此前 File2Beats(file_path) 内部用 torchaudio 按原生采样率 float64
    # 再整曲解码一次（双重解码，耗时与内存峰值双倍）。Audio2Beats(signal, sr) 直接吃
    # 上面的 22050Hz 单声道数据（signal2spect 对 sr==22050 跳过重采样），结果一致。
    # 解码留在锁外：全局推理锁只护模型前向，长解码不再占锁阻塞并发请求。
    with BEAT_THIS_INFERENCE_LOCK:
        # 直接拿帧级 logits（而非 Audio2Beats 的时间序列）：智能动感动效需要
        # 节奏连续性网格拟合（beat_grid_postprocess），它吃 logits 自己出拍——
        # 修复 minimal 后处理的漏检/假峰问题（folia 智能动感的拍点质量关键）。
        beat_logits, downbeat_logits = BEAT_THIS_TRACKER.spect2frames(
            BEAT_THIS_TRACKER.signal2spect(beat_input, sr)
        )
    beat_logits_np = beat_logits.detach().cpu().numpy().astype(np.float64)
    downbeat_logits_np = downbeat_logits.detach().cpu().numpy().astype(np.float64)
    if beat_logits_np.ndim > 1:
        beat_logits_np = beat_logits_np[0]
        downbeat_logits_np = downbeat_logits_np[0]

    # 节奏连续性网格拟合（纯 numpy，<50ms）：补漏检、剔假峰、对齐 downbeat。
    # 置信度极低时回退 minimal 时间序列（Audio2Beats.__call__ 的输出）。
    from beat_grid_postprocess import fit_beat_grid
    grid_beats, grid_downbeats = fit_beat_grid(beat_logits_np, downbeat_logits_np, fps=50)
    if grid_beats.size >= 8 and grid_downbeats.size >= 2:
        beats = np.asarray(grid_beats, dtype=float)
        downbeats = np.asarray(grid_downbeats, dtype=float)
        print(f"   🥁 网格拟合拍点: {len(beats)} beats / {len(downbeats)} downbeats")
    else:
        beats_raw, downbeats_raw = BEAT_THIS_TRACKER(beat_input, sr)
        beats = np.asarray(beats_raw.tolist() if hasattr(beats_raw, 'tolist') else beats_raw, dtype=float)
        downbeats = np.asarray(downbeats_raw.tolist() if hasattr(downbeats_raw, 'tolist') else downbeats_raw, dtype=float)
        print(f"   ↩️ 网格拟合失败（{grid_beats.size} beats），回退 minimal 后处理")
    beats = np.asarray(sorted({float(value) for value in beats if np.isfinite(value) and value >= 0}), dtype=float)
    downbeats = np.asarray(sorted({float(value) for value in downbeats if np.isfinite(value) and value >= 0}), dtype=float)
    if beats.size < 2 or downbeats.size < 2:
        # 静音/极短音频：模型给不出足够节拍是**该文件的确定属性**，不是服务故障。
        # 此前抛 RuntimeError → 500 → 客户端把它当成"服务不可用"触发 5 秒全局熔断，
        # 一个坏文件会让其它正常曲目的分析全部回退。改返回 metadata-only（客户端语义
        # 与浏览器解码回退一致，可正常进过渡队列），并写缓存避免每次重打上游。
        print(f"⚠️ 节拍数据不足（beats={beats.size}, downbeats={downbeats.size}），返回 metadata-only: {track_key}")
        return _metadata_only_result(track_key, float(librosa.get_duration(y=y, sr=sr)))

    intervals = np.diff(beats)
    median_interval = float(np.median(intervals)) if intervals.size else 0.5
    tempo = float(np.clip(60.0 / max(1e-6, median_interval), 30.0, 300.0))
    consistency = float(np.clip(1.0 - np.std(intervals) / max(1e-6, median_interval), 0.0, 1.0)) if intervals.size else 0.0
    confidence = float(np.clip(0.35 + consistency * 0.6, 0.0, 0.98))
    # searchsorted 代替逐 downbeat 全拍布尔扫描：2000 downbeat × 万级 beats 的 O(D×B)
    # Python 循环（千万次比较）降为两次二分向量化。
    left_indices = np.searchsorted(beats, downbeats[:-1], side='left')
    right_indices = np.searchsorted(beats, downbeats[1:], side='left')
    beats_per_bar = [int(r - l) for l, r in zip(left_indices, right_indices) if r > l]
    meter = int(np.median(beats_per_bar)) if beats_per_bar else 4

    beat_features = _extract_beat_features(y, sr, beats)
    sections = _detect_sections(beat_features, duration)
    intro_silence, outro_silence = _detect_silence_bounds(y, sr)
    audio_format = None
    try:
        info = sf.info(file_path)
        audio_format = {'sampleRate': int(info.samplerate), 'channels': int(info.channels)}
    except Exception as exc:
        print(f"   ⚠️ 无法读取源文件格式（跳过 audioFormat）: {exc}")

    timestamp = int(os.path.getmtime(file_path) * 1000) if os.path.exists(file_path) else 0
    return {
        'schemaVersion': 1,
        'trackKey': track_key,
        'duration': duration,
        'provider': 'beat_this',
        'beats': beats.tolist(),
        'downbeats': downbeats.tolist(),
        'beatConfidence': [confidence] * len(beats),
        'downbeatConfidence': [confidence] * len(downbeats),
        'estimatedBpm': tempo,
        'meter': meter,
        'confidence': confidence,
        'sections': sections,
        'beatFeatures': beat_features,
        'introSilence': intro_silence,
        'outroSilence': outro_silence,
        'audioFormat': audio_format,
        'sourceSignature': source_signature,
        'analysisVersion': ANALYSIS_VERSION,
        'createdAt': timestamp,
        'lastAccessAt': timestamp,
    }

@app.route('/health', methods=['GET'])
def health():
    """健康检查"""
    return jsonify({
        'status': 'ok' if BEAT_THIS_TRACKER is not None else 'failed',
        'service': 'beat_this' if BEAT_THIS_TRACKER is not None else 'unavailable',
        'provider': 'beat_this' if BEAT_THIS_TRACKER is not None else 'unavailable',
        'model': Path(BEAT_THIS_CHECKPOINT).name or 'final0',
        'beatThisAvailable': BEAT_THIS_TRACKER is not None,
        'version': ANALYSIS_VERSION,
        **({'error': BEAT_THIS_INIT_ERROR} if BEAT_THIS_INIT_ERROR else {}),
    }), (200 if BEAT_THIS_TRACKER is not None else 503)

def _validate_audio_path(audio_path: str):
    """校验音频路径：扩展名必须在允许列表内，且文件大小不超过上限。

    返回 (是否通过, 错误消息)，通过时错误消息为 None。
    """
    ext = os.path.splitext(audio_path)[1].lower()
    if ext not in ALLOWED_AUDIO_EXTENSIONS:
        allowed = ', '.join(sorted(ALLOWED_AUDIO_EXTENSIONS))
        return False, f'Unsupported audio format: {ext or "(no extension)"}. Allowed formats: {allowed}'
    try:
        size = os.path.getsize(audio_path)
    except OSError:
        return False, f'Unable to access file size: {audio_path}'
    if size > MAX_AUDIO_FILE_SIZE_BYTES:
        limit_mb = MAX_AUDIO_FILE_SIZE_BYTES // (1024 * 1024)
        return False, f'File too large: {size / (1024 * 1024):.1f} MB exceeds the {limit_mb} MB limit'
    return True, None


def _coerce_duration(value) -> float:
    """上报时长 → float；缺失/非法返回 0（仅用于截断警告，不进分析结果）。"""
    try:
        duration = float(value)
        return duration if duration > 0 and np.isfinite(duration) else 0.0
    except (TypeError, ValueError):
        return 0.0


def _probe_audio_format(file_path: str) -> bool:
    """读文件头魔数，判断 libsndfile/audioread 能否解码（mp3/flac/wav/ogg）。

    B 站 DASH 音频轨是 AAC 封装在 MP4（fMP4），libsndfile 打不开；这类文件
    返回 metadata-only（由调用方走浏览器解码回退），而不是 500 大堆栈。
    """
    try:
        with open(file_path, 'rb') as f:
            head = f.read(16)
    except OSError:
        return False
    if len(head) < 4:
        return False
    if head[:3] == b'ID3' or (head[0] == 0xFF and (head[1] & 0xE0) == 0xE0):
        return True  # mp3
    if head[:4] == b'fLaC':
        return True
    if head[:4] == b'OggS':
        return True
    if head[:4] == b'RIFF' and head[8:12] == b'WAVE':
        return True
    return False  # m4a/mp4/aac/opus/未知格式


def _metadata_only_result(track_key: str, duration) -> dict:
    """无法解码的格式（m4a/aac 等）返回的空分析结果，语义与渲染端 metadata-only 一致。"""
    now = int(time.time() * 1000)
    return {
        'schemaVersion': 1,
        'trackKey': track_key,
        'duration': float(duration or 0),
        'provider': 'metadata-only',
        'beats': [],
        'downbeats': [],
        'beatConfidence': [],
        'downbeatConfidence': [],
        'estimatedBpm': 120.0,
        'meter': 4,
        'confidence': 0.0,
        'sections': [],
        'beatFeatures': [],
        'introSilence': 0.0,
        'outroSilence': 0.0,
        'analysisVersion': ANALYSIS_VERSION,
        'createdAt': now,
        'lastAccessAt': now,
    }


@app.route('/analyze', methods=['POST'])
def analyze():
    """分析音频文件"""
    data = {}
    try:
        data = request.get_json(silent=True) or {}
        track_key = str(data.get('trackKey') or '').strip()
        audio_path = str(data.get('audioPath') or '').strip()
        duration = data.get('duration', 0)
        source_signature = str(data.get('sourceSignature') or '').strip()
        
        print(f"📥 收到分析请求:")
        print(f"   trackKey: {track_key}")
        print(f"   audioPath: {audio_path}")
        print(f"   duration: {duration}")
        
        if not track_key or not audio_path:
            return jsonify({'error': 'Missing trackKey or audioPath'}), 400

        # 校验 audioPath 必须是字符串（而非数字/布尔等被 str() 强转的值）
        if not isinstance(data.get('audioPath'), str):
            return jsonify({'error': 'audioPath must be a string'}), 400
        # 404 检查必须先于 is_allowed_audio_path：后者用 resolve(strict=True)，
        # 文件不存在时直接 False → 400「路径越界」，把「文件已丢失」误报成路径错误
        if not os.path.exists(audio_path):
            print(f"❌ 文件不存在: {audio_path}")
            if audio_path.startswith('http'):
                return jsonify({'error': 'audioPath must reference a local file prepared by WaveForge'}), 400
            return jsonify({'error': f'File not found: {audio_path}'}), 404
        if not is_allowed_audio_path(audio_path):
            # 带上实际白名单根与收到的路径：渲染端日志"音频路径:"一直为空（响应体没这字段），
            # 排查缓存根劈叉（允许根 ≠ 下载目录）时只能干瞪眼
            return jsonify({
                'error': 'audioPath must be inside the WaveForge cache',
                'audioPath': audio_path,
                'expectedRoots': [str(r) for r in _allowed_roots()],
            }), 400
        
        # 检查缓存
        cache_key = get_cache_key(track_key, duration, audio_path, source_signature)
        cached = load_from_cache(cache_key)
        if cached:
            print(f"💾 使用缓存: {track_key}")
            return jsonify(cached)

        # 同一缓存键只允许一个分析任务，其他请求等待结果落盘后读取。
        with _INFLIGHT_LOCK:
            inflight = _INFLIGHT_ANALYSES.get(cache_key)
            if inflight is None:
                inflight = threading.Event()
                _INFLIGHT_ANALYSES[cache_key] = inflight
                owner = True
            else:
                owner = False
        if not owner:
            inflight.wait(timeout=900)
            cached = load_from_cache(cache_key)
            if cached:
                return jsonify(cached)
            # owner 走 metadata-only 分支时不写缓存（见下），等待者醒来后缓存 miss
            # 并不意味着失败——对该文件做同样的格式探测，不可解码时返回同样的
            # metadata-only（duration 用请求参数，与 owner 分支同源）。
            if not _probe_audio_format(audio_path):
                return jsonify(_metadata_only_result(track_key, duration))
            return jsonify({'error': 'Audio analysis did not produce a cache result'}), 503

        acquired = _ANALYSIS_SEMAPHORE.acquire(timeout=900)
        if not acquired:
            with _INFLIGHT_LOCK:
                _INFLIGHT_ANALYSES.pop(cache_key, None)
                inflight.set()
            return jsonify({'error': 'Too many audio analyses in progress'}), 503
        try:
            print(f"🔍 检查文件是否存在: {audio_path}")
            if not os.path.exists(audio_path):
                print(f"❌ 文件不存在: {audio_path}")
                if audio_path.startswith('http'):
                    return jsonify({'error': 'audioPath must reference a local file prepared by WaveForge'}), 400
                return jsonify({'error': f'File not found: {audio_path}'}), 404

            print(f"✅ 文件存在，开始分析...")
            if not _probe_audio_format(audio_path):
                print(f"⚠️ 格式不支持 librosa 解码（m4a/aac 等），返回 metadata-only: {audio_path}")
                result = _metadata_only_result(track_key, duration)
            else:
                valid, validation_error = _validate_audio_path(audio_path)
                if not valid:
                    print(f"❌ 音频路径校验失败: {validation_error}")
                    return jsonify({'error': validation_error}), 400
                result = convert_to_native_types(analyze_audio_file(audio_path, track_key, source_signature, reported_duration=_coerce_duration(duration)))
                save_to_cache(cache_key, result)
            return jsonify(result)
        finally:
            _ANALYSIS_SEMAPHORE.release()
            with _INFLIGHT_LOCK:
                _INFLIGHT_ANALYSES.pop(cache_key, None)
                inflight.set()

    except Exception as error:
        error_type = error.__class__.__name__
        print(f"[ERROR] 分析失败: {error_type}")
        return jsonify({
            'error': f'Audio analysis failed: {error_type}',
            'trackKey': str(data.get('trackKey') or 'unknown'),
        }), 500

@app.route('/clear-cache', methods=['POST'])
def clear_cache():
    """清除缓存"""
    try:
        import shutil
        if CACHE_DIR.exists():
            shutil.rmtree(CACHE_DIR)
            CACHE_DIR.mkdir(parents=True, exist_ok=True)
        return jsonify({'status': 'ok', 'message': 'Cache cleared'})
    except Exception as e:
        # 只回错误类名：shutil 异常文本含本地缓存路径，不外发（细节在服务端日志）
        print(f"[ERROR] 缓存清理失败: {e}")
        return jsonify({'error': f'{type(e).__name__}: cache cleanup failed'}), 500

if __name__ == '__main__':
    cleanup_cache(force=True)
    # 设置日志文件
    log_dir = CACHE_ROOT / "logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / "beat_service.log"
    
    # 同时输出到控制台和文件
    class TeeOutput:
        def __init__(self, *files):
            self.files = files
        def write(self, data):
            for f in self.files:
                f.write(data)
                f.flush()
        def flush(self):
            for f in self.files:
                f.flush()
    
    file_handler = RotatingFileHandler(log_file, maxBytes=5 * 1024 * 1024, backupCount=2, encoding='utf-8')
    file_handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
    service_logger = logging.getLogger('waveforge-beat-service')
    service_logger.setLevel(logging.INFO)
    service_logger.addHandler(file_handler)
    service_logger.propagate = False

    class LogWriter:
        def write(self, data):
            message = data.rstrip()
            if message:
                service_logger.info(message)
        def flush(self):
            file_handler.flush()

    sys.stdout = TeeOutput(sys.stdout, LogWriter())
    sys.stderr = TeeOutput(sys.stderr, LogWriter())
    
    # 静音 Werkzeug 的 dev server 告警与 ANSI 颜色码：
    # ① "WARNING: This is a development server..." —— 三服务只绑 127.0.0.1 本地回环，
    #    永不对外，dev server 是刻意设计（AGENTS.md），红字警告纯属控制台噪音；
    # ② click.secho 的 ANSI 颜色码（重定向/管道下残留 [0m 乱码）—— 强制着色关闭。
    logging.getLogger('werkzeug').setLevel(logging.ERROR)
    try:
        import click
        click.echo = lambda *a, **k: None
    except ImportError:
        pass

    print("=" * 60)
    print("Beat Analysis Service Starting...")
    print("=" * 60)
    print(f"Cache directory: {CACHE_DIR}")
    print(f"Log file: {log_file}")
    print(f"Analysis version: {ANALYSIS_VERSION}")
    print(f"Beat This model: {Path(BEAT_THIS_CHECKPOINT).name if BEAT_THIS_TRACKER is not None else 'unavailable'}")
    print(f"Service URL: http://localhost:3002")
    print("=" * 60)
    
    app.run(host='127.0.0.1', port=3002, debug=False, threaded=True)
