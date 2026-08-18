#!/usr/bin/env python3
"""
Transition Renderer Worker - Pedalboard-based time stretching and mixing
Reads audio from files, applies time-stretching and mixing, outputs to file
"""

import sys
import json
import hashlib
import numpy as np
from scipy import signal
from pedalboard import Pedalboard, Compressor
from pedalboard.io import AudioFile
import logging
import os

logging.basicConfig(level=logging.INFO, format='%(asctime)s [%(levelname)s] %(message)s')
logger = logging.getLogger(__name__)

try:
    import librosa
    LIBROSA_AVAILABLE = True
except ImportError:
    LIBROSA_AVAILABLE = False


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


def progressive_beat_stretch(
    audio: np.ndarray,
    sample_rate: int,
    beat_times: list[float],
    output_beat_durations: list[float],
    track_label: str,
) -> np.ndarray:
    """Pitch-preserve each input beat and place it on the shared output grid."""
    import librosa

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
        if not 0.85 <= stretch_rate <= 1.15:
            raise ValueError(
                f"{track_label} beat {n} requires unsafe stretch rate {stretch_rate:.3f}"
            )

        beat_audio = audio[:, start_sample:end_sample]
        channels = []
        for channel in beat_audio:
            if 0.999 <= stretch_rate <= 1.001:
                stretched = channel.copy()
            else:
                stretched = librosa.effects.time_stretch(channel, rate=stretch_rate)
            # Librosa rounds the requested length internally; force the exact common grid.
            stretched = librosa.util.fix_length(stretched, size=target_samples)
            channels.append(stretched.astype(np.float32, copy=False))
        stretched_beats.append(np.stack(channels, axis=0))

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
        target_with_gain = apply_gain_curve(target_stretched, plan['gainCurve']['target'])
        
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
