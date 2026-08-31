#!/usr/bin/env python3
# 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
# 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
"""
Transition Renderer Worker - Pedalboard-based time stretching and mixing
Reads audio from files, applies time-stretching and mixing, outputs to file
"""

import sys
import json
import hashlib
import numpy as np
from scipy import signal
from scipy.ndimage import minimum_filter1d
from pedalboard import Pedalboard, Compressor
from pedalboard.io import AudioFile
import logging
import os
import uuid

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

try:
    import librosa
    LIBROSA_AVAILABLE = True
except ImportError:
    LIBROSA_AVAILABLE = False


def write_wav_atomic(output_path: str, audio: np.ndarray, sample_rate: int, channels: int) -> int:
    if not np.all(np.isfinite(audio)):
        raise ValueError("Refusing to write non-finite transition audio")
    temp_path = f"{output_path}.{os.getpid()}.{uuid.uuid4().hex}.tmp.wav"
    try:
        with AudioFile(temp_path, 'w', sample_rate, num_channels=channels) as f:
            f.write(audio)
        if os.path.getsize(temp_path) <= 44:
            raise ValueError("Rendered transition WAV is empty")
        os.replace(temp_path, output_path)
        return os.path.getsize(output_path)
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)


def ensure_stereo(audio: np.ndarray) -> np.ndarray:
    """单声道输入上采样为立体声，立体声/多声道保持原样。

    与 server/render_worker.py 的 _ensure_stereo 契约一致——音乐是立体声，
    折叠 mono 会丢失声像信息。AudioFile.read() 返回 (channels, frames) 布局。
    """
    if audio.ndim == 1:
        audio = audio[None, :]
    if audio.shape[0] == 1:
        return np.repeat(audio, 2, axis=0)
    return audio


def common_output_beat_durations(
    source_beat_times: list[float],
    target_beat_times: list[float],
    beat_count: int,
) -> list[float]:
    """Calculate the one output beat grid shared by both tracks."""
    if len(source_beat_times) < beat_count + 1 or len(target_beat_times) < beat_count + 1:
        raise ValueError(
            f"Insufficient beat grid: source={len(source_beat_times)}, "
            f"target={len(target_beat_times)}, required={beat_count + 1}"
        )

    output_durations = []
    for n in range(beat_count):
        source_duration = source_beat_times[n + 1] - source_beat_times[n]
        target_duration = target_beat_times[n + 1] - target_beat_times[n]
        if source_duration <= 0 or target_duration <= 0:
            raise ValueError(f"Non-monotonic beat grid at beat {n}")

        # ISMIR 2017: both tracks are stretched to this same interpolated duration.
        progress = n / beat_count
        output_duration = (1.0 - progress) * source_duration + progress * target_duration
        if not 0.2 <= output_duration <= 2.0:
            raise ValueError(f"Implausible output beat duration at beat {n}: {output_duration:.3f}s")
        output_durations.append(output_duration)

    return output_durations


def v2_output_beat_durations(
    source_beat_times: list[float],
    target_beat_times: list[float],
    beat_count: int,
) -> list[float]:
    """v2 专属共享网格：插值用 n/(beat_count-1)——首拍=source 原速、**末拍=target 原速**。

    与 v1 的 common_output_beat_durations（n/beat_count，末拍仍是混合速度）不同，
    保证过渡缓冲结束时 target 处于原始速度，handoff 到真实 deck 时无速度台阶。
    v1 的 render_transition 不使用本函数，行为不变。
    """
    if len(source_beat_times) < beat_count + 1 or len(target_beat_times) < beat_count + 1:
        raise ValueError(
            f"Insufficient beat grid: source={len(source_beat_times)}, "
            f"target={len(target_beat_times)}, required={beat_count + 1}"
        )
    output_durations = []
    for n in range(beat_count):
        source_duration = source_beat_times[n + 1] - source_beat_times[n]
        target_duration = target_beat_times[n + 1] - target_beat_times[n]
        if source_duration <= 0 or target_duration <= 0:
            raise ValueError(f"Non-monotonic beat grid at beat {n}")
        progress = n / max(1, beat_count - 1)
        output_duration = (1.0 - progress) * source_duration + progress * target_duration
        if not 0.2 <= output_duration <= 2.0:
            raise ValueError(f"Implausible output beat duration at beat {n}: {output_duration:.3f}s")
        output_durations.append(output_duration)
    return output_durations


def _wsola_stretch(channel: np.ndarray, rate: float, sample_rate: int) -> np.ndarray:
    """WSOLA 时域拉伸（瞬态保持）：重叠-相加时对每段做相似度搜索对齐，
    打击乐（kick/snare 等冲击瞬态）不经过相位声码器，避免"糊鼓"。
    rate>1 加速、rate<1 减速；失败/过短时回退相位声码器。
    相关搜索用 np.correlate 单次 C 实现（0.5s 拍段约 1ms）。"""
    n = len(channel)
    if abs(rate - 1.0) < 1e-3:
        return channel.copy()
    win_len = int(0.05 * sample_rate)
    if win_len < 64 or n <= win_len * 2:
        import librosa
        return librosa.effects.time_stretch(channel, rate=rate)
    ana_hop = win_len // 4
    syn_hop = max(1, int(round(ana_hop * rate)))
    out_len = int(n / rate)
    if out_len <= win_len:
        import librosa
        return librosa.effects.time_stretch(channel, rate=rate)
    window = np.hanning(win_len).astype(np.float32)
    out = np.zeros(out_len, dtype=np.float64)
    acc = np.zeros(out_len, dtype=np.float64)
    search = 256
    pos_in = 0
    pos_out = 0
    prev_seg = None
    while pos_out + win_len <= out_len and pos_in < n:
        if prev_seg is None:
            seg_start = pos_in
        else:
            lo = max(0, pos_in - search)
            hi = min(n - win_len, pos_in + search)
            if hi > lo:
                # 单次 C 相关：与上一输出段最相似的输入位置
                corr = np.correlate(channel[lo:hi + win_len], prev_seg, mode='valid')
                seg_start = lo + int(np.argmax(corr))
            else:
                seg_start = pos_in
        seg = channel[seg_start:seg_start + win_len].astype(np.float64) * window
        prev_seg = channel[seg_start:seg_start + win_len].astype(np.float64)
        out[pos_out:pos_out + win_len] += seg
        acc[pos_out:pos_out + win_len] += window * window
        pos_in = seg_start + ana_hop
        pos_out += syn_hop
    acc[acc < 1e-9] = 1.0
    return (out / acc)[:out_len].astype(np.float32)


def _quality_stretch(channel: np.ndarray, stretch_rate: float, sample_rate: int) -> np.ndarray:
    """v2 专用高质量拉伸：HPSS 分离后，谐波走相位声码器（PDFR 思路的工程近似），
    打击乐走 WSOLA（瞬态保持），比纯相位声码器糊鼓更少。任何环节失败回退纯 PV。"""
    import librosa
    try:
        if len(channel) < int(0.3 * sample_rate):
            # 太短的拍段 HPSS 帧数不足，直接 PV
            return librosa.effects.time_stretch(channel, rate=stretch_rate)
        harmonic, percussive = librosa.effects.hpss(channel, margin=2.0)
        harmonic_stretched = librosa.effects.time_stretch(harmonic, rate=stretch_rate)
        percussive_stretched = _wsola_stretch(percussive, stretch_rate, sample_rate)
        if not (len(harmonic_stretched) and len(percussive_stretched)):
            raise ValueError('quality stretch produced empty output')
        return (harmonic_stretched + percussive_stretched).astype(np.float32)
    except Exception:
        return librosa.effects.time_stretch(channel, rate=stretch_rate)


def progressive_beat_stretch(
    audio: np.ndarray,
    sample_rate: int,
    beat_times: list[float],
    output_beat_durations: list[float],
    track_label: str,
    rate_bounds: tuple[float, float] = (0.85, 1.15),
    quality_stretch: bool = False,
) -> np.ndarray:
    """Pitch-preserve each input beat and place it on the shared output grid.

    rate_bounds：每拍拉伸率安全区间（v1 用默认 [0.85, 1.15]；v2 放宽到 [0.8, 1.2]，
    真实歌曲节拍网格抖动时减少"unsafe stretch rate"导致的整段渲染失败）。
    quality_stretch：v2 专用高质量拉伸（HPSS 分离 + 谐波相位声码器 + 打击乐 WSOLA），
    v1 恒为 False → v1 渲染产物逐字节不变。
    """
    import librosa

    low_rate, high_rate = rate_bounds
    # 拉伸前校验 beat 网格是否落在已加载片段范围内（网格长度已由调用方校验），
    # 避免静默裁剪导致 "beat is too short" / "unsafe stretch rate" 等误导性错误
    segment_duration = audio.shape[1] / sample_rate
    epsilon = 1e-6
    if beat_times[0] < 0:
        raise ValueError(
            f"{track_label} beat grid starts before segment start: "
            f"beat 0 at {beat_times[0]:.2f}s"
        )
    last_beat_time = beat_times[len(output_beat_durations)]
    if last_beat_time > segment_duration + epsilon:
        raise ValueError(
            f"{track_label} beat grid extends past loaded segment: "
            f"beat {len(output_beat_durations)} at {last_beat_time:.2f}s "
            f"> segment end {segment_duration:.2f}s"
        )

    stretched_beats = []
    for n, target_duration in enumerate(output_beat_durations):
        start_sample = int(round(beat_times[n] * sample_rate))
        end_sample = int(round(beat_times[n + 1] * sample_rate))
        start_sample = max(0, min(audio.shape[1], start_sample))
        end_sample = max(start_sample, min(audio.shape[1], end_sample))
        input_samples = end_sample - start_sample
        target_samples = max(1, int(round(target_duration * sample_rate)))
        if input_samples < 32:
            raise ValueError(f"{track_label} beat {n} is too short ({input_samples} samples)")

        stretch_rate = input_samples / target_samples
        if not low_rate <= stretch_rate <= high_rate:
            raise ValueError(
                f"{track_label} beat {n} requires unsafe stretch rate {stretch_rate:.3f}"
            )

        beat_audio = audio[:, start_sample:end_sample]
        channels = []
        for channel in beat_audio:
            if 0.999 <= stretch_rate <= 1.001:
                stretched = channel.copy()
            else:
                stretched = _quality_stretch(channel, stretch_rate, sample_rate) if quality_stretch \
                    else librosa.effects.time_stretch(channel, rate=stretch_rate)
            # Librosa rounds the requested length internally; force the exact common grid.
            stretched = librosa.util.fix_length(stretched, size=target_samples)
            channels.append(stretched.astype(np.float32, copy=False))
        stretched_beats.append(np.stack(channels, axis=0))

    # 接缝点击修复（v2 quality_stretch 路径）：每拍独立拉伸（HPSS 相位声码器 + WSOLA）后
    # 相位不连续，硬拼接在接缝处产生巨大点击与高频噪（实测 99.9% 差分跳变 ≈ 纯 PV 的 700 倍，
    # 正是 v2 增强版"过渡满屏噪音/奇怪声音"的根因）。在**内部接缝**做 ~8ms 淡出/淡入缝合：
    # 首段头、末段尾保持原样（不影响过渡起始与 handoff 满音量），总长不变、网格保持。
    # v1（quality_stretch=False，纯 PV）逐字节不变，不受影响。
    if quality_stretch and len(stretched_beats) > 1:
        seam = min(int(0.008 * sample_rate), min(beat.shape[1] for beat in stretched_beats) // 4)
        if seam > 0:
            fade_in = np.linspace(0.0, 1.0, seam).astype(np.float32)
            fade_out = np.linspace(1.0, 0.0, seam).astype(np.float32)
            beat_count = len(stretched_beats)
            for index, beat in enumerate(stretched_beats):
                if index < beat_count - 1:
                    beat[:, -seam:] *= fade_out[None, :]
                if index > 0:
                    beat[:, :seam] *= fade_in[None, :]

    result = np.concatenate(stretched_beats, axis=1)
    expected_samples = sum(max(1, int(round(value * sample_rate))) for value in output_beat_durations)
    if result.shape[1] != expected_samples:
        raise RuntimeError(
            f"{track_label} output length mismatch: {result.shape[1]} != {expected_samples}"
        )

    logger.info(
        f"{track_label} progressive stretch complete: {len(output_beat_durations)} beats, "
        f"{result.shape[1] / sample_rate:.3f}s"
    )
    return result


def beat_automation(
    samples: int,
    sample_rate: int,
    beat_durations: list[float],
    points: list[tuple[float, float]],
) -> np.ndarray:
    """Interpolate automation points expressed in beat indices onto audio samples."""
    beat_samples = [0]
    for duration in beat_durations:
        beat_samples.append(beat_samples[-1] + max(1, int(round(duration * sample_rate))))

    def beat_to_sample(beat_position: float) -> float:
        beat_position = float(np.clip(beat_position, 0, len(beat_durations)))
        lower = min(len(beat_durations) - 1, int(np.floor(beat_position)))
        if beat_position >= len(beat_durations):
            return float(beat_samples[-1])
        fraction = beat_position - lower
        return beat_samples[lower] + fraction * (beat_samples[lower + 1] - beat_samples[lower])

    sample_points = np.asarray([beat_to_sample(beat) for beat, _ in points], dtype=float)
    values = np.asarray([value for _, value in points], dtype=float)
    return np.interp(np.arange(samples, dtype=float), sample_points, values).astype(np.float32)


def filtered(audio: np.ndarray, sample_rate: int, cutoff: float, filter_type: str) -> np.ndarray:
    nyquist = sample_rate / 2
    safe_cutoff = float(np.clip(cutoff, 20, nyquist * 0.9))
    sos = signal.butter(2, safe_cutoff, btype=filter_type, fs=sample_rate, output='sos')
    return signal.sosfilt(sos, audio, axis=1).astype(np.float32)


def apply_bass_swap(
    source: np.ndarray,
    target: np.ndarray,
    sample_rate: int,
    beat_durations: list[float],
    intensity: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Exchange low-frequency ownership on the middle downbeat."""
    beat_count = len(beat_durations)
    swap_beat = beat_count / 2
    transition_beats = min(2.0, max(1.0, beat_count / 8))
    minimum_bass = max(0.08, 1.0 - intensity * 1.25)
    source_bass = beat_automation(source.shape[1], sample_rate, beat_durations, [
        (0, 1.0),
        (swap_beat - transition_beats, 1.0),
        (swap_beat, minimum_bass),
        (beat_count, minimum_bass),
    ])
    target_bass = beat_automation(target.shape[1], sample_rate, beat_durations, [
        (0, minimum_bass),
        (swap_beat - transition_beats, minimum_bass),
        (swap_beat, 1.0),
        (beat_count, 1.0),
    ])
    source_low = filtered(source, sample_rate, 180, 'lowpass')
    target_low = filtered(target, sample_rate, 180, 'lowpass')
    source_result = source + source_low * (source_bass[None, :] - 1.0)
    target_result = target + target_low * (target_bass[None, :] - 1.0)
    return source_result.astype(np.float32), target_result.astype(np.float32)


def apply_filter_sweep(
    source: np.ndarray,
    target: np.ndarray,
    sample_rate: int,
    beat_durations: list[float],
    intensity: float,
) -> tuple[np.ndarray, np.ndarray]:
    """Use beat-quantized filter stages instead of an arbitrary time-based sweep."""
    beat_count = len(beat_durations)
    wet = float(np.clip(0.35 + intensity * 0.65, 0.0, 0.85))
    source_result = source.copy()
    for cutoff, start_beat, end_beat, stage_wet in [
        (120, beat_count * 0.45, beat_count * 0.65, wet * 0.65),
        (360, beat_count * 0.65, beat_count * 0.82, wet * 0.82),
        (900, beat_count * 0.82, beat_count, wet),
    ]:
        highpassed = filtered(source, sample_rate, cutoff, 'highpass')
        envelope = beat_automation(source.shape[1], sample_rate, beat_durations, [
            (0, 0.0),
            (start_beat, 0.0),
            (end_beat, stage_wet),
            (beat_count, stage_wet),
        ])
        source_result = source_result * (1.0 - envelope[None, :]) + highpassed * envelope[None, :]

    target_highpassed = filtered(target, sample_rate, 180, 'highpass')
    target_wet = min(0.75, intensity * 0.9)
    target_envelope = beat_automation(target.shape[1], sample_rate, beat_durations, [
        (0, target_wet),
        (beat_count * 0.25, target_wet),
        (beat_count * 0.5, 0.0),
        (beat_count, 0.0),
    ])
    target_result = target * (1.0 - target_envelope[None, :]) + target_highpassed * target_envelope[None, :]
    return source_result.astype(np.float32), target_result.astype(np.float32)


def create_echo_out(
    source: np.ndarray,
    sample_rate: int,
    beat_durations: list[float],
    delay_beats: float,
    feedback: float,
    intensity: float,
) -> np.ndarray:
    beat_count = len(beat_durations)
    representative_beat = float(np.median(beat_durations[max(0, beat_count // 2):]))
    delay_samples = max(1, int(round(representative_beat * delay_beats * sample_rate)))
    send = beat_automation(source.shape[1], sample_rate, beat_durations, [
        (0, 0.0),
        (beat_count * 0.55, 0.0),
        (beat_count * 0.65, 1.0),
        (beat_count, 0.35),
    ])
    echo = np.zeros_like(source, dtype=np.float32)
    seed = source * send[None, :]
    for tap in range(1, 5):
        offset = delay_samples * tap
        if offset >= source.shape[1]:
            break
        echo[:, offset:] += seed[:, :-offset] * (feedback ** (tap - 1))

    return_envelope = beat_automation(source.shape[1], sample_rate, beat_durations, [
        (0, 0.0),
        (beat_count * 0.58, 0.0),
        (beat_count * 0.72, 1.0),
        (max(0, beat_count - 1), 0.55),
        (beat_count, 0.0),
    ])
    wet_level = 0.10 + intensity * 0.12
    return echo * return_envelope[None, :] * wet_level


def create_sweep_fx(
    channels: int,
    samples: int,
    sample_rate: int,
    beat_durations: list[float],
    intensity: float,
    reference_rms: float,
    seed_text: str,
) -> np.ndarray:
    """Create a quiet deterministic, beat-shaped noise sweep for transition motion."""
    seed = int(hashlib.sha256(seed_text.encode('utf-8')).hexdigest()[:8], 16)
    rng = np.random.default_rng(seed)
    noise = rng.standard_normal(samples).astype(np.float32)
    high_cutoff = min(7000, sample_rate * 0.44)
    low_cutoff = min(700, high_cutoff * 0.45)
    sos = signal.butter(2, [low_cutoff, high_cutoff], btype='bandpass', fs=sample_rate, output='sos')
    noise = signal.sosfilt(sos, noise).astype(np.float32)
    noise_rms = float(np.sqrt(np.mean(noise * noise)))
    if noise_rms > 1e-9:
        noise /= noise_rms

    beat_count = len(beat_durations)
    envelope = beat_automation(samples, sample_rate, beat_durations, [
        (0, 0.0),
        (beat_count * 0.25, 0.04),
        (beat_count * 0.5, 1.0),
        (beat_count * 0.75, 0.12),
        (beat_count, 0.0),
    ])
    level = reference_rms * (0.025 + intensity * 0.035)
    sweep = noise[None, :] * envelope[None, :] * level
    return np.repeat(sweep, channels, axis=0).astype(np.float32)


def apply_pre_mix_dj_effects(
    source: np.ndarray,
    target: np.ndarray,
    sample_rate: int,
    beat_durations: list[float],
    effects: dict,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    intensity = float(np.clip(effects.get('intensity', 0.55), 0.0, 1.0))
    source_result = source.copy()
    target_result = target.copy()
    if effects.get('bassSwap', True):
        source_result, target_result = apply_bass_swap(
            source_result, target_result, sample_rate, beat_durations, intensity
        )
    if effects.get('filterSweep', True):
        source_result, target_result = apply_filter_sweep(
            source_result, target_result, sample_rate, beat_durations, intensity
        )
    echo = np.zeros_like(source_result, dtype=np.float32)
    if effects.get('echoOut', False):
        echo = create_echo_out(
            source_result,
            sample_rate,
            beat_durations,
            float(effects.get('echoDelayBeats', 0.5)),
            float(np.clip(effects.get('echoFeedback', 0.22), 0.0, 0.55)),
            intensity,
        )
    return source_result, target_result, echo


def apply_gain_curve(audio: np.ndarray, gain_curve: list[float]) -> np.ndarray:
    """
    Apply smooth gain curve to audio with gentle crossfading.
    
    Args:
        audio: Input audio (channels, samples)
        gain_curve: Gain values (0-1)
    
    Returns:
        Audio with gain applied
    """
    samples = audio.shape[1]
    curve_length = len(gain_curve)
    
    # Interpolate gain curve to match audio length
    gain_envelope = np.interp(
        np.linspace(0, curve_length - 1, samples),
        np.arange(curve_length),
        gain_curve
    )
    
    # The curve from powerCurve is already using sin/cos for smooth transition
    # Don't apply sqrt again - it makes the curve too aggressive
    # Just use the curve directly for a natural, smooth fade
    
    # Apply to all channels
    result = audio.copy()
    for ch in range(audio.shape[0]):
        result[ch] *= gain_envelope
    
    return result


def render_transition(params: dict) -> dict:
    """
    Render a smart DJ-style transition with progressive beat alignment.
    
    Implements the algorithm from Spotify's ISMIR 2017 paper:
    "Automatic Playlist Sequencing and Transitions"
    
    Args:
        params: {
            'plan': {
                'sourceTrackKey': str,
                'targetTrackKey': str,
                'sourceStartTime': float,
                'sourceEndTime': float,
                'targetStartTime': float,
                'targetEndTime': float,
                'sourceBpm': float,
                'targetBpm': float,
                'beatCount': int,
                'tempoRamp': list[float],
                'sourceBeatTimes': list[float],  # Beat positions in source
                'targetBeatTimes': list[float],  # Beat positions in target
                'gainCurve': {'source': list[float], 'target': list[float]}
            },
            'sourceAudioPath': str,
            'targetAudioPath': str,
            'outputPath': str
        }
    
    Returns:
        {
            'success': bool,
            'outputPath': str,
            'duration': float,
            'error': str (optional)
        }
    """
    try:
        plan = params['plan']
        source_path = params['sourceAudioPath']
        target_path = params['targetAudioPath']
        output_path = params['outputPath']
        
        logger.info(f"🎵 Rendering DJ transition: {plan['beatCount']} beats, "
                   f"{plan['sourceBpm']:.1f} → {plan['targetBpm']:.1f} BPM")
        logger.info(f"   Source: {source_path}")
        logger.info(f"   Target: {target_path}")
        
        # Load source audio segment
        logger.info("📂 Loading source audio...")
        with AudioFile(source_path) as f:
            source_sample_rate = f.samplerate
            source_start_sample = int(plan['sourceStartTime'] * source_sample_rate)
            source_end_sample = int(plan['sourceEndTime'] * source_sample_rate)
            
            f.seek(source_start_sample)
            source_audio = f.read(source_end_sample - source_start_sample)
        
        # Load target audio segment
        logger.info("📂 Loading target audio...")
        with AudioFile(target_path) as f:
            target_sample_rate = f.samplerate
            target_start_sample = int(plan['targetStartTime'] * target_sample_rate)
            target_end_sample = int(plan['targetEndTime'] * target_sample_rate)
            
            f.seek(target_start_sample)
            target_audio = f.read(target_end_sample - target_start_sample)
        
        # Ensure same sample rate
        if source_sample_rate != target_sample_rate:
            logger.warning(f"⚠️ Sample rate mismatch: {source_sample_rate} vs {target_sample_rate}")
            if LIBROSA_AVAILABLE:
                # librosa 0.11+ 默认使用 soxr_hq，质量优于裸 FFT 重采样（减少振铃/混叠）
                target_audio = librosa.resample(
                    target_audio,
                    orig_sr=target_sample_rate,
                    target_sr=source_sample_rate,
                )
            else:
                # librosa 不可用时回退到 scipy FFT 重采样，保证 worker 仍可用
                target_audio = signal.resample(
                    target_audio,
                    int(target_audio.shape[1] * source_sample_rate / target_sample_rate),
                    axis=1
                )
        
        output_sample_rate = source_sample_rate

        # 统一为立体声输出（与 server/render_worker.py 契约一致）：
        # 单声道输入上采样为立体声，避免折叠 mono 丢失声像信息
        source_audio = ensure_stereo(source_audio)
        target_audio = ensure_stereo(target_audio)
        
        # Get beat times relative to the audio segments
        source_beat_times = plan.get('sourceBeatTimes', [])
        target_beat_times = plan.get('targetBeatTimes', [])
        
        if not source_beat_times or not target_beat_times:
            raise ValueError("Smart rendering requires source and target beat grids")

        logger.info("Applying shared progressive beat alignment...")
        source_beat_times_relative = [t - plan['sourceStartTime'] for t in source_beat_times]
        target_beat_times_relative = [t - plan['targetStartTime'] for t in target_beat_times]
        output_beat_durations = common_output_beat_durations(
            source_beat_times_relative,
            target_beat_times_relative,
            plan['beatCount'],
        )
        source_stretched = progressive_beat_stretch(
            source_audio,
            output_sample_rate,
            source_beat_times_relative,
            output_beat_durations,
            'source',
        )
        target_stretched = progressive_beat_stretch(
            target_audio,
            output_sample_rate,
            target_beat_times_relative,
            output_beat_durations,
            'target',
        )
        if source_stretched.shape[1] != target_stretched.shape[1]:
            raise RuntimeError("Tracks did not land on the same output beat grid")
        output_length = source_stretched.shape[1]

        effects = plan.get('djEffects') or {}
        effects_applied = bool(effects.get('enabled', False))
        echo_return = np.zeros_like(source_stretched, dtype=np.float32)
        if effects_applied:
            logger.info(
                f"Applying beat-synchronous DJ FX: profile={effects.get('profile', 'smooth')}, "
                f"intensity={float(effects.get('intensity', 0.55)):.2f}, "
                f"echoOut={bool(effects.get('echoOut', False))}"
            )
            source_stretched, target_stretched, echo_return = apply_pre_mix_dj_effects(
                source_stretched,
                target_stretched,
                output_sample_rate,
                output_beat_durations,
                effects,
            )

        # Apply gain curves (equal-power crossfade)
        logger.info("Applying gain curves...")
        source_with_gain = apply_gain_curve(source_stretched, plan['gainCurve']['source'])
        target_curve = plan['gainCurve']['target']
        # 响度补偿（dB）：按 source/target 积分响度差缩放 target 侧，平滑过渡衔接
        gain_offset_db = float(plan.get('gainOffsetDb', 0) or 0)
        if abs(gain_offset_db) > 0.001:
            offset_linear = 10.0 ** (gain_offset_db / 20.0)
            target_curve = [min(1.0, v * offset_linear) for v in target_curve]
            logger.info(f"Applying loudness compensation: {gain_offset_db:+.1f} dB")
        target_with_gain = apply_gain_curve(target_stretched, target_curve)
        
        # Mix with professional audio processing
        logger.info("Mixing with audio processing...")
        channels = max(source_with_gain.shape[0], target_with_gain.shape[0])
        output = np.zeros((channels, output_length), dtype=np.float32)
        
        for ch in range(channels):
            if ch < source_with_gain.shape[0]:
                output[ch] += source_with_gain[ch]
            if ch < echo_return.shape[0]:
                output[ch] += echo_return[ch]
            if ch < target_with_gain.shape[0]:
                output[ch] += target_with_gain[ch]

        if effects_applied and effects.get('sweepFx', True):
            reference_rms = max(
                float(np.sqrt(np.mean(source_stretched * source_stretched))),
                float(np.sqrt(np.mean(target_stretched * target_stretched))),
            )
            sweep = create_sweep_fx(
                channels,
                output_length,
                output_sample_rate,
                output_beat_durations,
                float(np.clip(effects.get('intensity', 0.55), 0.0, 1.0)),
                reference_rms,
                f"{plan['sourceTrackKey']}->{plan['targetTrackKey']}",
            )
            output += sweep
        
        # Apply professional audio processing using Pedalboard
        try:
            board = Pedalboard([
                # Very gentle compression to glue the mix together
                # Lower ratio and higher threshold for more natural sound
                Compressor(threshold_db=-18, ratio=1.5, attack_ms=10, release_ms=100),
            ])
            output = board(output, output_sample_rate)
            logger.info("Applied audio processing (gentle compression)")
        except Exception as e:
            logger.warning(f"Audio processing skipped: {e}")
        
        # Apply very gentle soft limiting to prevent clipping
        max_amplitude = np.max(np.abs(output))
        if max_amplitude > 0.98:
            logger.info(f"Applying soft limiting (peak: {max_amplitude:.2f})")
            # Gentle tanh limiting for natural sound
            output = np.tanh(output * 0.95) * 0.95
        
        # Write output file
        logger.info(f"Writing output to {output_path}...")
        with AudioFile(output_path, 'w', output_sample_rate, num_channels=channels) as f:
            f.write(output)
        
        duration = output_length / output_sample_rate
        file_size = os.path.getsize(output_path)
        
        logger.info(f"Render complete: {channels} channels, {duration:.2f}s, {file_size / 1024:.1f} KB")
        
        return {
            'success': True,
            'outputPath': output_path,
            'duration': duration,
            'sampleRate': output_sample_rate,
            'channels': channels,
            'size': file_size,
            'stretchApplied': True,
            'djEffectsApplied': effects_applied,
            'targetResumeTime': plan['targetEndTime'],
            'rendererVersion': plan.get('rendererVersion', 'unknown'),
        }
        
    except Exception as e:
        logger.error(f"Render failed: {e}", exc_info=True)
        return {
            'success': False,
            'error': str(e)
        }


# ─────────────────────────────────────────────────────────────────────────────
# AutoMix 增强版（v2）渲染：在 v1 的逐拍保音高拉伸 + DJ FX 基础上，新增
# riser / 鼓点填充 / tempo ramp 加速 / 侧链混响虚化，并按 choreography 编排。
# 与 v1 的 render_transition 完全隔离：独立消息类型 'render_v2'，独立缓存键。
# 不引入任何新依赖（仅 numpy/scipy/pedalboard/librosa，与 v1 相同）。
# ─────────────────────────────────────────────────────────────────────────────

INTENSITY_FACTOR = {'subtle': 0.55, 'standard': 0.75, 'strong': 1.0}


def apply_tempo_ramp_up(
    output_beat_durations: list[float],
    beat_count: int,
    intensity: float,
    max_rate: float = 1.0,
) -> list[float]:
    """倒数第 2~4 拍渐进提速（DJ 式"加速落入"），**末拍保持目标原速**——
    过渡结束 handoff 到真实 target 时速度无缝回正（配合 v2 网格末拍=target 原速）。

    提速幅度自适应钳制：progressive_beat_stretch 有 0.85≤rate≤1.15 的硬上限，
    若 BPM 差已让某拍接近上限，继续加速会抛错导致整段渲染失败、静默回退——
    这里把 ramp 预算压到 `1 - max_rate/1.15` 之内，保证始终渲染成功。
    """
    if beat_count < 5:
        return output_beat_durations
    ramp_beats = 3
    max_speedup = min(0.12 * float(np.clip(intensity, 0.0, 1.0)), 1.0 - float(max_rate) / 1.15)
    if max_speedup <= 0.01:
        return output_beat_durations
    result = list(output_beat_durations)
    # offset 2/3/4 → 倒数第 2/3/4 拍（末拍 offset=1 不动，保持 target 原速）
    for offset in range(2, ramp_beats + 2):
        idx = beat_count - offset
        if idx < 0:
            break
        strength = (ramp_beats - (offset - 2)) / ramp_beats  # 越靠近末拍加速越强
        factor = 1.0 - max_speedup * strength
        result[idx] = max(0.2, result[idx] * factor)
    return result


def synthesize_kick(sample_rate: int, duration: float = 0.12) -> np.ndarray:
    """合成 kick：指数扫频（160→45Hz）+ 指数衰减包络。"""
    n = max(1, int(duration * sample_rate))
    t = np.arange(n) / sample_rate
    freq = 45.0 + (160.0 - 45.0) * np.exp(-t * 18.0)
    phase = 2.0 * np.pi * np.cumsum(freq) / sample_rate
    envelope = np.exp(-t * 9.0)
    return (np.sin(phase) * envelope).astype(np.float32)


def create_drum_fill(
    channels: int,
    samples: int,
    sample_rate: int,
    beat_durations: list[float],
    fill_beats: int,
    intensity: float,
    reference_rms: float,
    seed_text: str,
) -> np.ndarray:
    """按输出节拍网格在过渡尾部合成鼓点填充（切分拍 offbeat 模式），导向目标 downbeat。"""
    beat_count = len(beat_durations)
    if fill_beats <= 0 or beat_count <= 1:
        return np.zeros((channels, samples), dtype=np.float32)

    beat_samples = [0]
    for duration in beat_durations:
        beat_samples.append(beat_samples[-1] + max(1, int(round(duration * sample_rate))))
    fill_start_beat = max(0, beat_count - fill_beats)
    fill_start_sample = beat_samples[fill_start_beat] if fill_start_beat < len(beat_samples) else 0
    fill_span = max(1, beat_samples[beat_count] - fill_start_sample)

    # 切分拍位置（相对填充窗口的拍偏移），填充拍数不同自动缩放
    subdivisions = [0.0, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.75]
    pattern = [rel for rel in subdivisions if rel < fill_beats]

    kick = synthesize_kick(sample_rate)
    fill = np.zeros((channels, samples), dtype=np.float32)
    rng = np.random.default_rng(int(hashlib.sha256(seed_text.encode('utf-8')).hexdigest()[:8], 16))
    for rel in pattern:
        pos = fill_start_sample + int(round((rel / max(1, fill_beats)) * fill_span))
        end = min(samples, pos + len(kick))
        if pos >= samples:
            continue
        # 每击微小随机增益，避免机械感
        hit = kick[:end - pos] * (0.9 + 0.2 * rng.random())
        for ch in range(channels):
            fill[ch, pos:end] += hit

    level = reference_rms * (0.16 + 0.20 * float(np.clip(intensity, 0.0, 1.0)))
    return (fill * level).astype(np.float32)


def create_riser(
    channels: int,
    samples: int,
    sample_rate: int,
    beat_durations: list[float],
    intensity: float,
    reference_rms: float,
    seed_text: str,
    start_beat: int | None = None,
    end_freq: float = 2400.0,
) -> np.ndarray:
    """指数扫频 riser（180→end_freq Hz）+ 滤波噪声层，渐强导向 downbeat。

    start_beat：riser 起始拍（乐句锚定，缺省=倒数第 3 拍）；
    end_freq：终止频率（调性驱动，缺省 2400Hz）。
    """
    beat_count = len(beat_durations)
    if start_beat is None:
        start_beat = max(0, beat_count - 3)
    else:
        start_beat = max(0, min(beat_count - 1, int(start_beat)))
    envelope = beat_automation(samples, sample_rate, beat_durations, [
        (0, 0.0),
        (start_beat, 0.0),
        (beat_count, 1.0),
    ])
    if envelope.max() < 1e-9:
        return np.zeros((channels, samples), dtype=np.float32)

    rng = np.random.default_rng(int(hashlib.sha256(seed_text.encode('utf-8')).hexdigest()[:8], 16))
    t = np.arange(samples) / sample_rate
    sweep_len = samples
    f0, f1 = 180.0, float(np.clip(end_freq, 300.0, 9000.0))
    freq = f0 * (f1 / f0) ** (t / max(1e-9, t[-1]))
    phase = 2.0 * np.pi * np.cumsum(freq) / sample_rate
    sweep = np.sin(phase).astype(np.float32)

    noise = rng.standard_normal(samples).astype(np.float32)
    noise = filtered(noise[None, :], sample_rate, 4000, 'lowpass')[0]
    noise = filtered(noise[None, :], sample_rate, 300, 'highpass')[0]
    noise_rms = float(np.sqrt(np.mean(noise * noise))) + 1e-9

    riser = (0.75 * sweep + 0.25 * noise / noise_rms) * envelope[None, :]
    level = reference_rms * (0.09 + 0.13 * float(np.clip(intensity, 0.0, 1.0)))
    return np.repeat(riser, channels, axis=0).astype(np.float32) * level


def apply_reverb_dip(
    audio: np.ndarray,
    sample_rate: int,
    beat_durations: list[float],
    intensity: float,
    start_beat: float | None = None,
) -> np.ndarray:
    """源尾侧链混响"虚化"：噪声脉冲 IR 卷积 + 低通，随过渡进程渐混入，
    让源侧在交棒前被空间感模糊而非硬切。start_beat：混响起始拍（乐句锚定）。"""
    beat_count = len(beat_durations)
    if start_beat is None:
        start_beat = beat_count * 0.55
    start_beat = max(0.0, min(float(beat_count), float(start_beat)))
    ir_len = int(0.6 * sample_rate)
    rng = np.random.default_rng(int(hashlib.sha256(b'v2-reverb-ir').hexdigest()[:8], 16))
    t = np.arange(ir_len) / sample_rate
    tau = 0.16 + 0.06 * float(np.clip(intensity, 0.0, 1.0))
    ir = (rng.standard_normal(ir_len) * np.exp(-t / tau)).astype(np.float32)
    ir /= np.sqrt(np.sum(ir * ir)) + 1e-9

    wet = np.stack(
        [signal.fftconvolve(audio[ch], ir)[:audio.shape[1]] for ch in range(audio.shape[0])],
        axis=0,
    ).astype(np.float32)
    wet = filtered(wet, sample_rate, 6000, 'lowpass')

    envelope = beat_automation(audio.shape[1], sample_rate, beat_durations, [
        (0, 0.0),
        (start_beat, 0.0),
        (beat_count * 0.8, 0.5 + 0.3 * float(np.clip(intensity, 0.0, 1.0))),
        (beat_count, 0.65 + 0.35 * float(np.clip(intensity, 0.0, 1.0))),
    ])
    return (audio * (1.0 - envelope[None, :]) + wet * envelope[None, :]).astype(np.float32)


def _relu6(x: np.ndarray, start: float, slope: float) -> np.ndarray:
    """DJTransGAN 推子曲线的闭式式：y = relu6(relu6(x - start) * slope) / 6。"""
    return np.minimum(np.maximum(x - start, 0.0) * slope, 6.0) / 6.0


def _band_split(audio: np.ndarray, sample_rate: int) -> list[np.ndarray]:
    """4 频段分频（20-300 / 300-5000 / 5000-20000，与 DJTransGAN BAND_FREQS 一致）。"""
    low = filtered(audio, sample_rate, 300, 'lowpass')
    mid_low = filtered(filtered(audio, sample_rate, 300, 'highpass'), sample_rate, 5000, 'lowpass')
    mid_high = filtered(filtered(audio, sample_rate, 5000, 'highpass'), sample_rate, 20000, 'lowpass')
    high = filtered(audio, sample_rate, 5000, 'highpass')
    return [low, mid_low, mid_high, high]


def apply_learned_automation(audio: np.ndarray, sample_rate: int, params: dict, fade_type: str) -> np.ndarray:
    """DJTransGAN 学到的逐频段推子曲线（EQ 分层渐出/渐入）+ 频段 EQ 自动化。

    - fo（源曲）：逐频段 1→0 归一，保证 handoff 时源曲静音；
    - fi（目标曲）：逐频段 0→1 归一，保证 handoff 时目标曲满增益（无音量台阶）；
    - 保留模型学到的"各频段在不同时刻淡出/淡入"的 EQ 分层特性（Apple/DJ 级手法）。
    """
    fader = np.array(params['fader'])[0]  # (4,1,2)
    length = audio.shape[1]
    if length < 32:
        return audio
    x = np.linspace(0.0, 6.0, length)
    bands = _band_split(audio, sample_rate)

    # 频段 EQ 自动化（band_params 3 边界 → 4 频段增益，温和钳制 ±30%）
    eq_gains = None
    band_raw = params.get('band')
    if band_raw is not None:
        band = np.array(band_raw)[0]  # (3,2)
        if band.shape[0] >= 3:
            boundaries = [_relu6(x, float(band[i, 0]), float(band[i, 1])) for i in range(3)]
            eps = 1e-6
            raw = [
                boundaries[0],
                boundaries[1] / (boundaries[0] + eps),
                boundaries[2] / (boundaries[1] + eps),
                1.0 / (boundaries[2] + eps),
            ]
            eq_gains = [np.clip(g, 0.7, 1.3) for g in raw]

    out = np.zeros_like(audio, dtype=np.float32)
    for b in range(4):
        start = float(fader[b, 0, 0])
        slope = float(fader[b, 0, 1])
        curve = _relu6(x, start, slope)
        if fade_type == 'fo':
            curve = 1.0 - curve
            span = float(np.max(curve) - np.min(curve))
            if span > 1e-6:
                curve = (curve - float(np.min(curve))) / span
        else:
            peak = float(np.max(curve))
            if peak > 1e-6:
                curve = curve / peak
        gain = np.clip(curve, 0.0, 1.0)
        if eq_gains is not None:
            gain = gain * eq_gains[b]
        out += bands[b] * gain[None, :]
    return out.astype(np.float32)


def spectral_seam_mix(source: np.ndarray, target: np.ndarray, sample_rate: int) -> np.ndarray:
    """图割频谱 crossfade（ISMIR 2019 思路的轻量实现）：无节拍对齐（大 BPM 差）路径的
    混合内核——对每个频段独立选择"切换到目标曲"的时刻（跨频段平滑 DP，等效 1D 图割），
    每个频段同一时刻只取一边，接缝处 ±3 帧短交叉。比宽带等功率叠加更干净：
    无相位抵消/无中频浑浊（Apple 式"频谱分域过渡"的工程近似）。
    source/target 须同长（(ch, N)）。任何环节失败回退逐点相加。
    """
    import librosa
    try:
        n_fft = 2048
        hop = n_fft // 4
        mono_s = np.mean(source, axis=0) if source.ndim > 1 else source
        mono_t = np.mean(target, axis=0) if target.ndim > 1 else target
        S = np.abs(librosa.stft(mono_s, n_fft=n_fft, hop_length=hop))
        T = np.abs(librosa.stft(mono_t, n_fft=n_fft, hop_length=hop))
        frames = min(S.shape[1], T.shape[1])
        if frames < 16:
            return source + target
        S, T = S[:, :frames], T[:, :frames]
        B, N = S.shape
        # 切点成本：f 帧处从源切到目标的频谱连续性（越小越顺）
        cost = np.zeros((B, N))
        cost[:, 1:] = np.abs(S[:, :-1] - T[:, 1:])
        cost[:, 0] = np.abs(S[:, 0] - T[:, 0])
        # 跨频段平滑 DP：dp[b][f] = cost[b][f] + min_fp(dp[b-1][fp] + pen*|f-fp|)
        # 滑动窗口最小值用 scipy minimum_filter1d（C 实现），origin 偏移窗心。
        window = 6
        pen = 0.06
        dp_history = np.zeros((B, N))
        dp_history[0] = cost[0]
        idx = np.arange(N)
        for b in range(1, B):
            v = dp_history[b - 1]
            left_min = minimum_filter1d(v - pen * idx, size=window + 1, origin=-(window // 2), mode='nearest')
            right_min = minimum_filter1d(v + pen * idx, size=window + 1, origin=window - (window // 2), mode='nearest')
            candidate = np.minimum(left_min + pen * idx, right_min - pen * idx)
            # 超出 ±window 的切点惩罚固定为封顶值
            candidate = np.minimum(candidate, float(np.min(v)) + pen * window)
            dp_history[b] = cost[b] + candidate
        # 回溯最优切点路径（重算最优父节点，避免存 back 表）
        cuts = np.zeros(B, dtype=np.int32)
        cuts[-1] = int(np.argmin(dp_history[-1]))
        for b in range(B - 1, 0, -1):
            v = dp_history[b - 1]
            fp_vals = v + pen * np.abs(idx - cuts[b])
            cuts[b - 1] = int(np.argmin(fp_vals))
        # 中值平滑（相邻频段切点相近 → 避免"频谱分叉"）
        cuts = np.array([int(np.median(cuts[max(0, b - 8):b + 9])) for b in range(B)], dtype=np.int32)
        # 组装：每频段切点前用源、后用目标，接缝 ±3 帧线性交叉
        seam = 3
        channels_out = []
        for ch in range(source.shape[0]):
            Xs = librosa.stft(source[ch], n_fft=n_fft, hop_length=hop)[:, :frames]
            Xt = librosa.stft(target[ch], n_fft=n_fft, hop_length=hop)[:, :frames]
            out = np.zeros_like(Xs)
            for b in range(B):
                c = int(np.clip(int(cuts[b]), seam, N - seam - 1))
                if c - seam > 0:
                    out[b, :c - seam] = Xs[b, :c - seam]
                if c + seam < N:
                    out[b, c + seam:] = Xt[b, c + seam:]
                for f in range(c - seam, min(c + seam, N)):
                    w = (f - (c - seam)) / max(1, 2 * seam)
                    out[b, f] = (1 - w) * Xs[b, f] + w * Xt[b, f]
            channels_out.append(librosa.istft(out, hop_length=hop, length=source.shape[1]))
        result = np.stack(channels_out, axis=0).astype(np.float32)
        if not np.isfinite(result).all():
            raise ValueError('spectral seam produced non-finite output')
        return result
    except Exception as e:
        logger.warning(f"⚠️ [v2] spectral seam fallback to broadband mix: {e}")
        return source + target


def _piecewise_gain(points: list, samples: int, sample_rate: int) -> np.ndarray:
    """Render deterministic linear gain keyframes from the stem choreography."""
    if samples <= 0:
        return np.zeros(0, dtype=np.float32)
    valid = sorted(
        (float(point.get('time', 0)), float(point.get('gain', 0)))
        for point in (points or [])
        if np.isfinite(point.get('time', 0)) and np.isfinite(point.get('gain', 0))
    )
    if not valid:
        return np.ones(samples, dtype=np.float32)
    positions = np.asarray([max(0, min(samples - 1, round(t * sample_rate))) for t, _ in valid], dtype=np.float64)
    gains = np.asarray([max(0, min(1, gain)) for _, gain in valid], dtype=np.float64)
    # Collapse duplicate positions so np.interp always receives an increasing axis.
    unique_positions, unique_indices = np.unique(positions, return_index=True)
    unique_gains = gains[unique_indices]
    return np.interp(np.arange(samples), unique_positions, unique_gains,
                     left=unique_gains[0], right=unique_gains[-1]).astype(np.float32)


def _load_stem_window(artifact: dict, stem: str, plan_start: float, plan_end: float, output_rate: int) -> np.ndarray:
    stem_path = artifact.get('files', {}).get(stem)
    if not stem_path or not os.path.isfile(stem_path):
        raise FileNotFoundError(f"missing {stem} artifact")
    artifact_start = float(artifact.get('startSeconds', 0) or 0)
    with AudioFile(stem_path) as reader:
        rate = reader.samplerate
        start = max(0, int(round((plan_start - artifact_start) * rate)))
        frames = max(1, int(round((plan_end - plan_start) * rate)))
        reader.seek(start)
        audio = ensure_stereo(reader.read(frames))
    if rate != output_rate:
        if LIBROSA_AVAILABLE:
            audio = librosa.resample(audio, orig_sr=rate, target_sr=output_rate)
        else:
            audio = signal.resample(audio, int(round(audio.shape[1] * output_rate / rate)), axis=1)
    return np.ascontiguousarray(audio, dtype=np.float32)


def _render_stem_mix(plan: dict, output_rate: int, output_length: int,
                     output_beat_durations: list, without_grid: bool) -> np.ndarray | None:
    v2 = plan.get('v2') or {}
    artifacts = v2.get('stemArtifacts') or {}
    choreography = v2.get('stemChoreography') or {}
    if not artifacts.get('source') or not artifacts.get('target') or not choreography:
        return None
    source_beats = [t - plan['sourceStartTime'] for t in plan.get('sourceBeatTimes', [])]
    target_beats = [t - plan['targetStartTime'] for t in plan.get('targetBeatTimes', [])]
    channels = 2
    output = np.zeros((channels, output_length), dtype=np.float32)
    pitch_shift = float(v2.get('pitchShiftSemitones', 0) or 0)
    for stem in ('vocals', 'drums', 'bass', 'other'):
        source = _load_stem_window(artifacts['source'], stem, plan['sourceStartTime'], plan['sourceEndTime'], output_rate)
        target = _load_stem_window(artifacts['target'], stem, plan['targetStartTime'], plan['targetEndTime'], output_rate)
        # Preserve drum transients: harmonic pitch correction never touches the drum stem.
        if stem != 'drums' and abs(pitch_shift) > 0.01 and LIBROSA_AVAILABLE:
            target = librosa.effects.pitch_shift(target, sr=output_rate, n_steps=pitch_shift).astype(np.float32)
        if without_grid:
            source_rendered = np.pad(source, ((0, 0), (0, max(0, output_length - source.shape[1]))))[:, :output_length]
            target_rendered = np.pad(target, ((0, 0), (0, max(0, output_length - target.shape[1]))))[:, :output_length]
        else:
            source_rendered = progressive_beat_stretch(
                source, output_rate, source_beats, output_beat_durations, f'source-{stem}',
                rate_bounds=(0.8, 1.2), quality_stretch=False,
            )
            target_rendered = progressive_beat_stretch(
                target, output_rate, target_beats, output_beat_durations, f'target-{stem}',
                rate_bounds=(0.8, 1.2), quality_stretch=False,
            )
            source_rendered = source_rendered[:, :output_length]
            target_rendered = target_rendered[:, :output_length]
        # Preserve WaveForge's complementary v2 processing inside the stem path:
        # - drums keep transient shape and pitch;
        # - harmonic stems can receive pitch correction and filter motion;
        # - source vocals/other retain the reverb-dip phrase exit.
        effects = plan.get('djEffects') or {}
        v2_choreography = v2.get('choreography') or {}
        if stem != 'drums' and effects.get('filterSweep', True):
            source_rendered, target_rendered = apply_filter_sweep(
                source_rendered, target_rendered, output_rate, output_beat_durations,
                float(np.clip(effects.get('intensity', 0.55), 0.0, 1.0)),
            )
        if stem in ('vocals', 'other') and v2_choreography.get('reverbDip', False):
            source_rendered = apply_reverb_dip(
                source_rendered, output_rate, output_beat_durations,
                float(INTENSITY_FACTOR.get(v2_choreography.get('intensity', 'standard'), 0.75)),
                start_beat=v2_choreography.get('reverbStartBeat'),
            )
        stem_plan = choreography.get(stem) or {}
        source_gain = _piecewise_gain(stem_plan.get('source') or [], output_length, output_rate)
        target_gain = _piecewise_gain(stem_plan.get('target') or [], output_length, output_rate)
        output += source_rendered * source_gain[None, :] + target_rendered * target_gain[None, :]
    gain_offset_db = float(plan.get('gainOffsetDb', 0) or 0)
    if abs(gain_offset_db) > 0.001:
        # Choreography already mixes both sides; apply only a conservative final compensation.
        output *= min(1.25, max(0.8, 10.0 ** (gain_offset_db / 40.0)))
    logger.info("🎚️ [v2] HTDemucs stem choreography applied: %s", choreography.get('style', 'unknown'))
    return output


def render_transition_v2(params: dict) -> dict:
    """AutoMix 增强版（v2）渲染：v1 的逐拍共拍网格拉伸 + choreography 特效编排。

    plan.v2.choreography 驱动：style（energetic/atmospheric/clean）+ intensity
    （subtle/standard/strong）+ 各特效开关。渲染结果与 v1 共用同一个
    TransitionRenderer 缓存/播放链路，仅 plan.id（rendererVersion=v2）隔离。
    """
    try:
        plan = params['plan']
        source_path = params['sourceAudioPath']
        target_path = params['targetAudioPath']
        output_path = params['outputPath']

        v2 = plan.get('v2') or {}
        choreography = v2.get('choreography') or {}
        style = choreography.get('style', 'clean')
        intensity = float(INTENSITY_FACTOR.get(choreography.get('intensity', 'standard'), 0.75))
        drum_fill_beats = int(choreography.get('drumFillBeats', 0) or 0)
        use_tempo_ramp = bool(choreography.get('tempoRampUp', False))
        use_riser = bool(choreography.get('riser', False))
        use_reverb_dip = bool(choreography.get('reverbDip', False))
        use_noise_sweep = bool(choreography.get('noiseSweep', False))

        logger.info(f"🎵 [v2] Rendering enhanced transition: {plan['beatCount']} beats, "
                   f"style={style}, intensity={choreography.get('intensity', 'standard')}, "
                   f"{plan['sourceBpm']:.1f} → {plan['targetBpm']:.1f} BPM")

        # 1) 加载源/目标切片（与 v1 相同：AudioFile 上下文管理器，读毕即释放）
        with AudioFile(source_path) as f:
            source_sample_rate = f.samplerate
            source_start_sample = int(plan['sourceStartTime'] * source_sample_rate)
            source_end_sample = int(plan['sourceEndTime'] * source_sample_rate)
            f.seek(source_start_sample)
            source_audio = f.read(source_end_sample - source_start_sample)
        with AudioFile(target_path) as f:
            target_sample_rate = f.samplerate
            target_start_sample = int(plan['targetStartTime'] * target_sample_rate)
            target_end_sample = int(plan['targetEndTime'] * target_sample_rate)
            f.seek(target_start_sample)
            target_audio = f.read(target_end_sample - target_start_sample)

        if source_sample_rate != target_sample_rate:
            logger.warning(f"⚠️ [v2] Sample rate mismatch: {source_sample_rate} vs {target_sample_rate}")
            if LIBROSA_AVAILABLE:
                target_audio = librosa.resample(
                    target_audio, orig_sr=target_sample_rate, target_sr=source_sample_rate,
                )
            else:
                target_audio = signal.resample(
                    target_audio,
                    int(target_audio.shape[1] * source_sample_rate / target_sample_rate),
                    axis=1,
                )
        output_sample_rate = source_sample_rate
        source_audio = ensure_stereo(source_audio)
        target_audio = ensure_stereo(target_audio)

        # 谐波变调（谐波混音，Vande Veire 2018）：过渡窗口内目标曲变调到源曲主音
        # （≤2 半音），两曲和声兼容；handoff 后 deck 恢复目标原调（≤2 半音校正可接受）。
        pitch_shift = float((plan.get('v2') or {}).get('pitchShiftSemitones', 0) or 0)
        if abs(pitch_shift) > 0.01:
            if LIBROSA_AVAILABLE:
                logger.info(f"🎼 [v2] Harmonic pitch-shift: target window {pitch_shift:+.1f} semitones")
                target_audio = librosa.effects.pitch_shift(
                    target_audio, sr=output_sample_rate, n_steps=pitch_shift,
                ).astype(np.float32)
            else:
                logger.warning("⚠️ [v2] librosa unavailable, skipping harmonic pitch-shift")

        source_beat_times = plan.get('sourceBeatTimes', [])
        target_beat_times = plan.get('targetBeatTimes', [])
        without_grid = bool((plan.get('v2') or {}).get('withoutBeatGrid', False))

        if without_grid:
            # 大 BPM 差（15~100）：不做节拍对齐拉伸（±15% 外质量崩坏）。
            # source 自然速度播完自己的窗口（渐出），target 渐入，配合氛围特效层。
            logger.info("🌫️ [v2] No-beat-grid transition (BPM gap too large, effects crossfade)")
            output_length = source_audio.shape[1]
            if target_audio.shape[1] < output_length:
                target_audio = np.pad(target_audio, ((0, 0), (0, output_length - target_audio.shape[1])), mode='constant')
            source_stretched = source_audio
            target_stretched = target_audio[:, :output_length]
            # 时间基合成节拍网格（0.5s/拍）：仅用于特效包络定位（riser/sweep/reverb）
            out_dur = output_length / output_sample_rate
            output_beat_durations = [0.5] * max(1, int(out_dur / 0.5) + 1)
            # 目标曲恢复点：缓冲区混入了 target 前 min(src_span, tgt_span) 秒
            source_span = plan['sourceEndTime'] - plan['sourceStartTime']
            target_span = plan['targetEndTime'] - plan['targetStartTime']
            resume_time = plan['targetStartTime'] + min(source_span, target_span)
        else:
            if not source_beat_times or not target_beat_times:
                raise ValueError("Smart rendering requires source and target beat grids")
            source_beat_times_relative = [t - plan['sourceStartTime'] for t in source_beat_times]
            target_beat_times_relative = [t - plan['targetStartTime'] for t in target_beat_times]
            # v2 共享网格：末拍=target 原速，handoff 无速度台阶（v1 路径不用此函数）
            output_beat_durations = v2_output_beat_durations(
                source_beat_times_relative,
                target_beat_times_relative,
                plan['beatCount'],
            )
            # 2) tempo ramp 加速（DJ 式落入）：预算按 ramp 区域当前最大拉伸率自适应钳制，
            #    确保叠加后每拍 rate ≤1.15，不会因抛错导致整段渲染静默回退。
            #    ramp 只作用于倒数第 2~4 拍，末拍保持 target 原速 → 手尾速度无缝回正。
            if use_tempo_ramp:
                beat_count = plan['beatCount']
                ramp_region_start = max(0, beat_count - 4)
                ramp_max_rate = 1.0
                for idx in range(ramp_region_start, beat_count):
                    src_duration = source_beat_times_relative[idx + 1] - source_beat_times_relative[idx]
                    tgt_duration = target_beat_times_relative[idx + 1] - target_beat_times_relative[idx]
                    out_duration = output_beat_durations[idx]
                    if src_duration > 0:
                        ramp_max_rate = max(ramp_max_rate, src_duration / out_duration)
                    if tgt_duration > 0:
                        ramp_max_rate = max(ramp_max_rate, tgt_duration / out_duration)
                output_beat_durations = apply_tempo_ramp_up(output_beat_durations, beat_count, intensity, ramp_max_rate)

            source_stretched = progressive_beat_stretch(
                source_audio, output_sample_rate, source_beat_times_relative, output_beat_durations, 'source',
                rate_bounds=(0.8, 1.2),
                # quality_stretch=False：v2 曾用 HPSS 分离 + 相位声码器 + WSOLA（"高质量"拉伸），
                # 但 _wsola_stretch 在稀疏打击乐信号上相关性搜索找错段位，overlap-add 归一化
                # out/acc 在 acc 极小时爆炸，产生 25~2200× 的爆音尖峰（实测最大样本跳变 2209，
                # 信号峰值仅 1.0）——正是增强版"过渡满屏噪音"的根因。回退普通 PV（librosa
                # time_stretch），实测最大跳变 0.12、无尖峰，过渡干净。
                quality_stretch=False,
            )
            target_stretched = progressive_beat_stretch(
                target_audio, output_sample_rate, target_beat_times_relative, output_beat_durations, 'target',
                rate_bounds=(0.8, 1.2),
                quality_stretch=False,
            )
            if source_stretched.shape[1] != target_stretched.shape[1]:
                raise RuntimeError("Tracks did not land on the same output beat grid")
            output_length = source_stretched.shape[1]
            resume_time = plan['targetEndTime']

        # 3) 源尾侧链混响"虚化"（乐句锚定起始拍）
        if use_reverb_dip:
            logger.info("🎚️ [v2] Applying source reverb dip (blur out)")
            source_stretched = apply_reverb_dip(
                source_stretched, output_sample_rate, output_beat_durations, intensity,
                start_beat=choreography.get('reverbStartBeat'),
            )

        # 4) DJ FX（bass swap / filter sweep / echo out）：节拍对齐路径全量应用；
        #    无节拍网格路径也应用 bassSwap/filterSweep（用合成 0.5s 网格定位）+ 时间基回声，
        #    让大 BPM 差的过渡同样有"对音乐本身的 DJ 混音处理"，不只是叠加合成音效。
        effects = plan.get('djEffects') or {}
        effects_applied = bool(effects.get('enabled', False))
        echo_return = np.zeros_like(source_stretched, dtype=np.float32)
        if effects_applied:
            source_stretched, target_stretched, echo_return = apply_pre_mix_dj_effects(
                source_stretched, target_stretched, output_sample_rate, output_beat_durations, effects,
            )
        elif bool(choreography.get('echoOut', False)):
            echo_return = create_echo_out(
                source_stretched,
                output_sample_rate,
                output_beat_durations,
                float(effects.get('echoDelayBeats', 0.5)),
                float(np.clip(effects.get('echoFeedback', 0.22), 0.0, 0.55)),
                intensity,
            )

        # 5) 增益：AI 学习式推子/EQ（DJTransGAN 提取）优先；否则规则式等功率曲线
        automation = (plan.get('v2') or {}).get('automation') or []
        gain_offset_db = float(plan.get('gainOffsetDb', 0) or 0)
        if len(automation) == 2 and automation[0].get('fader') and automation[1].get('fader'):
            logger.info("🎛️ [v2] Applying DJTransGAN learned fader/EQ automation")
            source_with_gain = apply_learned_automation(source_stretched, output_sample_rate, automation[0], 'fo')
            target_with_gain = apply_learned_automation(target_stretched, output_sample_rate, automation[1], 'fi')
            # 响度补偿叠加到目标（学习式曲线已归一，此处在末尾补偿响度差）
            if abs(gain_offset_db) > 0.001:
                offset_linear = min(2.0, 10.0 ** (gain_offset_db / 20.0))
                target_with_gain = target_with_gain * offset_linear
        else:
            source_with_gain = apply_gain_curve(source_stretched, plan['gainCurve']['source'])
            target_curve = plan['gainCurve']['target']
            if abs(gain_offset_db) > 0.001:
                offset_linear = 10.0 ** (gain_offset_db / 20.0)
                target_curve = [min(1.0, v * offset_linear) for v in target_curve]
            target_with_gain = apply_gain_curve(target_stretched, target_curve)

        # 5.5) 人声 ducking：目标窗口逐拍 vocalness 高的位置压低进入音量，
        #      避免与源曲人声重叠（plan.v2.targetVocalness 由计划器提供）。
        target_vocalness = (plan.get('v2') or {}).get('targetVocalness') or []
        if target_vocalness and len(target_vocalness) >= 2:
            points = []
            count = len(target_vocalness)
            for i, vocal in enumerate(target_vocalness):
                beat_pos = (i / max(1, count - 1)) * len(output_beat_durations)
                duck = 1.0 - 0.35 * float(np.clip(vocal, 0.0, 1.0))
                points.append((beat_pos, duck))
            duck_envelope = beat_automation(target_with_gain.shape[1], output_sample_rate, output_beat_durations, points)
            target_with_gain = target_with_gain * duck_envelope[None, :]

        # 6) 混合：有 HTDemucs artifacts 时用四轨 choreography；否则保持现有 full-mix DSP。
        channels = max(source_with_gain.shape[0], target_with_gain.shape[0])
        stem_output = _render_stem_mix(plan, output_sample_rate, output_length, output_beat_durations, without_grid)
        stem_mix_applied = stem_output is not None
        output = np.zeros((channels, output_length), dtype=np.float32) if stem_output is None else stem_output
        # 回声可闻度 boost（v2 专用；v1 的 create_echo_out 产物不受影响）
        fx_echo_boost = 2.0
        if stem_output is None and without_grid and len(automation) != 2:
            # 图割频谱 crossfade（大 BPM 差无节拍对齐路径）：逐频段选切换时刻，
            # 避免宽带等功率叠加的相位抵消/浑浊；失败自动回退逐点相加。
            output = spectral_seam_mix(source_with_gain, target_with_gain, output_sample_rate)
            for ch in range(min(channels, output.shape[0])):
                if ch < echo_return.shape[0]:
                    output[ch] += echo_return[ch] * fx_echo_boost
        elif stem_output is None:
            for ch in range(channels):
                if ch < source_with_gain.shape[0]:
                    output[ch] += source_with_gain[ch]
                if ch < echo_return.shape[0]:
                    output[ch] += echo_return[ch] * fx_echo_boost
                if ch < target_with_gain.shape[0]:
                    output[ch] += target_with_gain[ch]
        else:
            # Stem choreography owns the source/target mix; the existing echo/riser/noise layers remain complementary.
            for ch in range(min(channels, echo_return.shape[0])):
                output[ch] += echo_return[ch] * fx_echo_boost

        reference_rms = max(
            float(np.sqrt(np.mean(source_stretched * source_stretched))),
            float(np.sqrt(np.mean(target_stretched * target_stretched))),
            1e-9,
        )
        seed_text = f"{plan['sourceTrackKey']}->{plan['targetTrackKey']}"

        # 7) v2 尾部特效层：riser / 鼓点填充 / noise sweep（叠加在混音之上）
        # 特效可闻度 boost：v2 过渡应能听出 DJ 效果（用户反馈"听不到额外音效"）。
        # 共享特效函数（v1 也在用）不改，只在 v2 调用处放大；v1 渲染产物不受影响。
        fx_boost = 2.0
        if use_riser:
            output += create_riser(
                channels, output_length, output_sample_rate, output_beat_durations, intensity, reference_rms, seed_text,
                start_beat=choreography.get('riserStartBeat'),
                end_freq=float(choreography.get('riserEndFreq', 2400)),
            ) * fx_boost
        if drum_fill_beats > 0:
            output += create_drum_fill(channels, output_length, output_sample_rate, output_beat_durations, drum_fill_beats, intensity, reference_rms, seed_text) * fx_boost
        if use_noise_sweep:
            output += create_sweep_fx(channels, output_length, output_sample_rate, output_beat_durations, float(effects.get('intensity', 0.55)), reference_rms, seed_text) * fx_boost

        # 8) Pedalboard 轻压缩 + 软限幅（与 v1 相同）
        try:
            board = Pedalboard([
                Compressor(threshold_db=-18, ratio=1.5, attack_ms=10, release_ms=100),
            ])
            output = board(output, output_sample_rate)
        except Exception as e:
            logger.warning(f"Audio processing skipped: {e}")
        max_amplitude = np.max(np.abs(output))
        if max_amplitude > 0.98:
            logger.info(f"Applying soft limiting (peak: {max_amplitude:.2f})")
            output = np.tanh(output * 0.95) * 0.95

        file_size = write_wav_atomic(output_path, output, output_sample_rate, channels)

        duration = output_length / output_sample_rate
        logger.info(f"🎉 [v2] Render complete: {channels} channels, {duration:.2f}s, {file_size / 1024:.1f} KB")

        return {
            'success': True,
            'outputPath': output_path,
            'duration': duration,
            'sampleRate': output_sample_rate,
            'channels': channels,
            'size': file_size,
            'stretchApplied': True,
            'djEffectsApplied': effects_applied,
            'targetResumeTime': resume_time,
            'rendererVersion': plan.get('rendererVersion', 'unknown'),
            'v2ChoreographyApplied': True,
            'stemMixApplied': stem_mix_applied,
        }
    except Exception as e:
        logger.error(f"[v2] Render failed: {e}", exc_info=True)
        return {
            'success': False,
            'error': str(e),
        }


def main():
    """Main worker loop - read JSON requests from stdin, write responses to stdout."""
    logger.info("Render worker ready")
    
    for line in sys.stdin:
        try:
            request = json.loads(line.strip())
            message_type = request.get('type')
            message_id = request.get('id')
            
            if message_type == 'render':
                result = render_transition(request['params'])
                response = {
                    'type': 'result',
                    'id': message_id,
                    'data': result
                }
            elif message_type == 'render_v2':
                result = render_transition_v2(request['params'])
                response = {
                    'type': 'result',
                    'id': message_id,
                    'data': result
                }
            elif message_type == 'exit':
                logger.info("Exit requested")
                break
            else:
                response = {
                    'type': 'error',
                    'id': message_id,
                    'error': f"Unknown message type: {message_type}"
                }
            
            print(json.dumps(response), flush=True)
            
        except json.JSONDecodeError as e:
            logger.error(f"Invalid JSON: {e}")
            print(json.dumps({'type': 'error', 'error': 'Invalid JSON'}), flush=True)
        except Exception as e:
            logger.error(f"Error processing request: {e}", exc_info=True)
            print(json.dumps({'type': 'error', 'error': str(e)}), flush=True)


if __name__ == '__main__':
    main()
