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
from logging.handlers import RotatingFileHandler
from pathlib import Path
from flask import Flask, request, jsonify
from flask_cors import CORS
import librosa
import numpy as np

# 设置 UTF-8 编码
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

app = Flask(__name__)
CORS(app, origins=["http://localhost:3000", "http://127.0.0.1:3000", "file://", "null"])


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

ANALYSIS_VERSION = "librosa-dsp-v2"
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

def get_cache_key(track_key: str, duration: float) -> str:
    """生成缓存键"""
    return hashlib.md5(f"{track_key}:{duration}:{ANALYSIS_VERSION}".encode()).hexdigest()

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


def analyze_audio_file(file_path: str, track_key: str) -> dict:
    """Analyze beat timing and beat-synchronous transition features with Librosa."""
    print(f"📊 开始分析音频: {track_key}")
    print(f"   文件路径: {file_path}")

    y, sr = librosa.load(file_path, sr=22050, mono=True)
    duration = float(librosa.get_duration(y=y, sr=sr))
    print(f"   音频时长: {duration:.2f}s, 采样率: {sr}Hz")

    hop_length = 512
    onset_envelope = librosa.onset.onset_strength(y=y, sr=sr, hop_length=hop_length)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_envelope,
        sr=sr,
        hop_length=hop_length,
        units='frames',
    )
    # 静音音频时 librosa 返回 tempo=0.0，需回退为默认 BPM
    if tempo == 0 or not np.asarray(beat_frames).size:
        tempo = 120.0
    tempo = float(np.asarray(tempo).reshape(-1)[0]) if np.asarray(tempo).size else 120.0
    beat_frames = np.asarray(beat_frames, dtype=int)
    beats = librosa.frames_to_time(beat_frames, sr=sr, hop_length=hop_length).astype(float).tolist()

    beat_strengths = onset_envelope[np.clip(beat_frames, 0, max(0, len(onset_envelope) - 1))] if len(beat_frames) else np.array([])
    phase_scores = [float(np.mean(beat_strengths[phase::4])) if len(beat_strengths[phase::4]) else 0.0 for phase in range(4)]
    downbeat_phase = int(np.argmax(phase_scores)) if phase_scores else 0
    downbeat_indices = list(range(downbeat_phase, len(beats), 4))
    downbeats = [beats[index] for index in downbeat_indices]

    intervals = np.diff(beats)
    if len(intervals):
        consistency = float(np.clip(1.0 - np.std(intervals) / max(1e-6, np.median(intervals)), 0.0, 1.0))
    else:
        consistency = 0.0
    if len(beat_strengths) and np.max(onset_envelope) > 0:
        strength = float(np.clip(np.mean(beat_strengths) / np.percentile(onset_envelope, 90), 0.0, 1.0))
    else:
        strength = 0.0
    confidence = float(np.clip(0.2 + consistency * 0.55 + strength * 0.25, 0.0, 0.95))

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop_length)
    mfcc = librosa.feature.mfcc(y=y, sr=sr, n_mfcc=13, hop_length=hop_length)
    rms_frames = librosa.feature.rms(y=y, hop_length=hop_length)[0]
    zcr_frames = librosa.feature.zero_crossing_rate(y, hop_length=hop_length)[0]
    magnitude = np.abs(librosa.stft(y, hop_length=hop_length))
    flatness_frames = librosa.feature.spectral_flatness(S=magnitude)[0]
    frequencies = librosa.fft_frequencies(sr=sr)
    vocal_band = (frequencies >= 180) & (frequencies <= 4200)
    feature_frame_count = min(
        chroma.shape[1], mfcc.shape[1], len(rms_frames), len(zcr_frames),
        magnitude.shape[1], len(flatness_frames),
    )

    beat_features = []
    for index, beat_time in enumerate(beats):
        frame_start = int(beat_frames[index])
        frame_start = min(frame_start, max(0, feature_frame_count - 1))
        frame_end = int(beat_frames[index + 1]) if index + 1 < len(beat_frames) else min(feature_frame_count, frame_start + 24)
        frame_end = max(frame_start + 1, min(feature_frame_count, frame_end))
        frame_slice = slice(frame_start, frame_end)
        rms = float(np.mean(rms_frames[frame_slice])) if frame_start < len(rms_frames) else 0.0
        spectrum = magnitude[:, frame_slice]
        total_energy = float(np.sum(spectrum))
        mid_energy = float(np.sum(spectrum[vocal_band])) / max(1e-9, total_energy)
        flatness = float(np.mean(flatness_frames[frame_slice])) if frame_start < len(flatness_frames) else 1.0
        zcr = float(np.mean(zcr_frames[frame_slice])) if frame_start < len(zcr_frames) else 1.0
        vocalness = float(np.clip(mid_energy * np.sqrt(max(0.0, 1.0 - flatness)) * (1.0 - min(1.0, zcr * 5.0)), 0.0, 1.0))
        beat_features.append({
            'beatIndex': index,
            'time': float(beat_time),
            'loudness': float(librosa.amplitude_to_db(np.asarray([max(rms, 1e-8)]), ref=1.0)[0]),
            'rms': rms,
            'chroma': np.mean(chroma[:, frame_slice], axis=1).astype(float).tolist(),
            'timbre': np.mean(mfcc[:, frame_slice], axis=1).astype(float).tolist(),
            'vocalness': vocalness,
            'energy': rms * rms,
        })

    sections = _detect_sections(beat_features, duration)
    non_silent = librosa.effects.split(y, top_db=40)
    if len(non_silent):
        intro_silence = float(non_silent[0][0] / sr)
        outro_silence = float(max(0, len(y) - non_silent[-1][1]) / sr)
    else:
        intro_silence = 0.0
        outro_silence = 0.0

    timestamp = int(os.path.getmtime(file_path) * 1000) if os.path.exists(file_path) else 0
    result = {
        'schemaVersion': 1,
        'trackKey': track_key,
        'duration': duration,
        'provider': 'librosa-fallback',
        'beats': beats,
        'downbeats': downbeats,
        'beatConfidence': [confidence] * len(beats),
        'downbeatConfidence': [confidence * 0.85] * len(downbeats),
        'estimatedBpm': tempo,
        'meter': 4,
        'confidence': confidence,
        'sections': sections,
        'beatFeatures': beat_features,
        'introSilence': intro_silence,
        'outroSilence': outro_silence,
        'analysisVersion': ANALYSIS_VERSION,
        'createdAt': timestamp,
        'lastAccessAt': timestamp,
    }

    print(
        f"✅ 分析完成: BPM={tempo:.1f}, 节拍数={len(beats)}, "
        f"段落数={len(sections)}, 置信度={confidence:.2f}"
    )
    return result

@app.route('/health', methods=['GET'])
def health():
    """健康检查"""
    return jsonify({
        'status': 'ok',
        'service': 'librosa',
        'version': ANALYSIS_VERSION
    })

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
        
        print(f"📥 收到分析请求:")
        print(f"   trackKey: {track_key}")
        print(f"   audioPath: {audio_path}")
        print(f"   duration: {duration}")
        
        if not track_key or not audio_path:
            return jsonify({'error': 'Missing trackKey or audioPath'}), 400

        # 校验 audioPath 必须是字符串（而非数字/布尔等被 str() 强转的值）
        if not isinstance(data.get('audioPath'), str):
            return jsonify({'error': 'audioPath must be a string'}), 400
        
        # 检查缓存
        cache_key = get_cache_key(track_key, duration)
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
        result = analyze_audio_file(audio_path, track_key)
        
        # 确保所有数据都是原生 Python 类型
        result = convert_to_native_types(result)
        
        # 保存到缓存
        save_to_cache(cache_key, result)
        
        return jsonify(result)
    
    except Exception as e:
        error_msg = str(e)
        print(f"[ERROR] 分析失败: {error_msg}")
        import traceback
        tb_str = traceback.format_exc()
        print(tb_str)
        return jsonify({
            'error': error_msg,
            'traceback': tb_str,
            'trackKey': data.get('trackKey', 'unknown'),
            'audioPath': data.get('audioPath', 'unknown')
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
    print(f"Service URL: http://localhost:3002")
    print("=" * 60)
    
    app.run(host='127.0.0.1', port=3002, debug=False, threaded=True)
