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
from flask_cors import CORS
from local_service_auth import is_allowed_audio_path, is_authorized_local_request
import librosa
import numpy as np
import soundfile as sf

try:
    from beat_this.inference import File2Beats
    BEAT_THIS_IMPORT_ERROR = None
except ImportError as error:
    File2Beats = None
    BEAT_THIS_IMPORT_ERROR = f'{error.__class__.__name__}: Beat This runtime unavailable'

BEAT_THIS_CHECKPOINT = os.environ.get('BEAT_THIS_CHECKPOINT') or os.environ.get('WAVEFORGE_BEAT_MODEL_PATH') or 'final0'
BEAT_THIS_TRACKER = None
BEAT_THIS_INFERENCE_LOCK = threading.Lock()
BEAT_THIS_INIT_ERROR = BEAT_THIS_IMPORT_ERROR
if File2Beats is not None:
    try:
        BEAT_THIS_TRACKER = File2Beats(checkpoint_path=BEAT_THIS_CHECKPOINT, device='cpu', float16=False, dbn=False)
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

ANALYSIS_VERSION = "beat-this-dsp-v1"
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


def cleanup_cache(force=False):
    """删除过期缓存，并按最近使用时间把总量限制在 512MB。"""
    now = time.time()
    if not force and now - _last_cleanup_time[0] < 60.0:
        return
    _last_cleanup_time[0] = now
    entries = []
    for cache_file in CACHE_DIR.glob("*.json"):
        try:
            stat = cache_file.stat()
            if now - stat.st_mtime > CACHE_MAX_AGE_SECONDS:
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
    fingerprint = f'{track_key}:{duration}:{file_identity}:{source_signature}:{ANALYSIS_VERSION}'
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

def _cosine_distance(left, right):
    left = np.asarray(left, dtype=float)
    right = np.asarray(right, dtype=float)
    denominator = np.linalg.norm(left) * np.linalg.norm(right)
    if denominator < 1e-12:
        return 1.0
    return float(np.clip(1.0 - np.dot(left, right) / denominator, 0.0, 1.0))


def _detect_sections(beat_features, duration):
    if not beat_features:
        return []

    sections = [{
        'time': beat_features[0]['time'],
        'beatIndex': 0,
        'type': 'intro',
        'confidence': 0.7,
    }]
    novelty = np.zeros(len(beat_features), dtype=float)
    for index in range(1, len(beat_features)):
        before = beat_features[index - 1]
        after = beat_features[index]
        novelty[index] = (
            _cosine_distance(before['timbre'], after['timbre']) * 0.45
            + _cosine_distance(before['chroma'], after['chroma']) * 0.25
            + min(1.0, abs(after['energy'] - before['energy']) / max(1e-6, before['energy'])) * 0.30
        )

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
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop_length)
    rms_frames = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    zcr_frames = librosa.feature.zero_crossing_rate(y, hop_length=hop_length)[0]
    magnitude = np.abs(librosa.stft(y, hop_length=hop_length))
    flatness_frames = librosa.feature.spectral_flatness(S=magnitude)[0]
    frequencies = librosa.fft_frequencies(sr=sr)
    vocal_band = (frequencies >= 180) & (frequencies <= 4200)
    feature_frame_count = min(chroma.shape[1], mfcc.shape[1], len(rms_frames), len(zcr_frames), magnitude.shape[1], len(flatness_frames))
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
        zcr = float(np.mean(zcr_frames[frame_slice])) if start < len(zcr_frames) else 1.0
        vocalness = float(np.clip(mid_energy * np.sqrt(max(0.0, 1.0 - flatness)) * (1.0 - min(1.0, zcr * 5.0)), 0.0, 1.0))
        features.append({
            'beatIndex': index,
            'time': float(beat_time),
            'loudness': float(librosa.amplitude_to_db(np.asarray([max(rms, 1e-8)]), ref=1.0)[0]),
            'rms': rms,
            'chroma': np.mean(chroma[:, frame_slice], axis=1).astype(float).tolist(),
            'timbre': np.mean(mfcc[:, frame_slice], axis=1).astype(float).tolist(),
            'vocalness': vocalness,
            'energy': rms * rms,
        })
    return features


def analyze_audio_file(file_path: str, track_key: str, source_signature: str = '') -> dict:
    """Analyze beat timing with required Beat This plus librosa feature extraction."""
    if BEAT_THIS_TRACKER is None:
        raise RuntimeError(BEAT_THIS_INIT_ERROR or 'Beat This model is unavailable')
    print(f"📊 开始分析音频: {track_key}")
    print(f"   文件路径: {file_path}")

    y, sr = librosa.load(file_path, sr=22050, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))
    print(f"   音频时长: {duration:.2f}s, 采样率: {sr}Hz")

    with BEAT_THIS_INFERENCE_LOCK:
        beats_raw, downbeats_raw = BEAT_THIS_TRACKER(file_path)
    beats = np.asarray(beats_raw.tolist() if hasattr(beats_raw, 'tolist') else beats_raw, dtype=float)
    downbeats = np.asarray(downbeats_raw.tolist() if hasattr(downbeats_raw, 'tolist') else downbeats_raw, dtype=float)
    beats = np.asarray(sorted({float(value) for value in beats if np.isfinite(value) and value >= 0}), dtype=float)
    downbeats = np.asarray(sorted({float(value) for value in downbeats if np.isfinite(value) and value >= 0}), dtype=float)
    if beats.size < 2 or downbeats.size < 2:
        raise RuntimeError('Beat This returned insufficient beat/downbeat data')

    intervals = np.diff(beats)
    median_interval = float(np.median(intervals)) if intervals.size else 0.5
    tempo = float(np.clip(60.0 / max(1e-6, median_interval), 30.0, 300.0))
    consistency = float(np.clip(1.0 - np.std(intervals) / max(1e-6, median_interval), 0.0, 1.0)) if intervals.size else 0.0
    confidence = float(np.clip(0.35 + consistency * 0.6, 0.0, 0.98))
    beats_per_bar = []
    for index in range(len(downbeats) - 1):
        count = int(np.sum((beats >= downbeats[index]) & (beats < downbeats[index + 1])))
        if count > 0: beats_per_bar.append(count)
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
        if not is_allowed_audio_path(audio_path):
            return jsonify({'error': 'audioPath must be inside the WaveForge cache'}), 400
        
        # 检查缓存
        cache_key = get_cache_key(track_key, duration, audio_path, source_signature)
        cached = load_from_cache(cache_key)
        if cached:
            print(f"💾 使用缓存: {track_key}")
            return jsonify(cached)
        
        # 检查文件是否存在
        print(f"🔍 检查文件是否存在: {audio_path}")
        if not os.path.exists(audio_path):
            print(f"❌ 文件不存在: {audio_path}")
            # 如果是 URL，尝试下载
            if audio_path.startswith('http'):
                return jsonify({'error': 'audioPath must reference a local file prepared by WaveForge'}), 400
            return jsonify({'error': f'File not found: {audio_path}'}), 404
        
        print(f"✅ 文件存在，开始分析...")
        
        # 内容探测：libsndfile 打不开 m4a/aac/opus（B 站 DASH 音频轨是 AAC/MP4）。
        # 返回 metadata-only 让调用方走浏览器解码回退，而不是 500 大堆栈。
        if not _probe_audio_format(audio_path):
            print(f"⚠️ 格式不支持 librosa 解码（m4a/aac 等），返回 metadata-only: {audio_path}")
            return jsonify(_metadata_only_result(track_key, duration))
        
        # 校验扩展名与文件大小，防止非音频文件或超大文件导致资源耗尽
        valid, validation_error = _validate_audio_path(audio_path)
        if not valid:
            print(f"❌ 音频路径校验失败: {validation_error}")
            return jsonify({'error': validation_error}), 400
        
        # 分析音频
        result = analyze_audio_file(audio_path, track_key, source_signature)
        
        # 确保所有数据都是原生 Python 类型
        result = convert_to_native_types(result)
        
        # 保存到缓存
        save_to_cache(cache_key, result)
        
        return jsonify(result)
    
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
        return jsonify({'error': str(e)}), 500

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
