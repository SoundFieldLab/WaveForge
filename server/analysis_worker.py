#!/usr/bin/env python3
# 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
# 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
"""
WaveForge Analysis Worker - Python Sidecar for Beat Tracking and Audio Analysis
Uses Beat This for high-precision beat/downbeat detection
"""

import sys
import json
import os
import traceback
from pathlib import Path
import numpy as np

# Check if beat_this is available
try:
    from beat_this.inference import File2Beats, Audio2Beats
    BEAT_THIS_AVAILABLE = True
    BEAT_THIS_IMPORT_ERROR = None
except ImportError:
    BEAT_THIS_AVAILABLE = False
    BEAT_THIS_IMPORT_ERROR = "Beat This import unavailable"
    print("WARNING: beat_this not installed", file=sys.stderr)

# Check if librosa is available for feature extraction
try:
    import librosa
    LIBROSA_AVAILABLE = True
except ImportError:
    LIBROSA_AVAILABLE = False
    print("WARNING: librosa not installed, feature extraction limited", file=sys.stderr)


def probe_audio_format(file_path):
    """读文件头魔数，判断 libsndfile/audioread 能否解码（mp3/flac/wav/ogg）。

    B 站 DASH 音频轨是 AAC 封装在 MP4（fMP4），libsndfile 打不开；这类文件
    走 PyAV (FFmpeg) 解码路径（见 decode_audio_universal），仍解不开才
    metadata-only 交给浏览器兜底。
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


def decode_audio_universal(file_path, target_sr=22050):
    """PyAV (FFmpeg) 解码任意容器（m4a/aac/mp4/opus…）→ 单声道 float64 PCM。

    libsndfile 覆盖不了的 AAC 系（B 站 DASH 音频轨等）由这里兜住：
    实测 300s m4a 解码 ~0.2s，Beat This 直接吃 numpy 波形无额外开销。
    解码失败/无 PyAV 返回 None（调用方回退 metadata-only）。
    """
    try:
        import av
    except ImportError:
        return None
    try:
        container = av.open(file_path)
    except Exception:
        return None
    try:
        stream = next((s for s in container.streams.audio), None)
        if stream is None:
            return None
        resampler = av.AudioResampler(format='s16', layout='mono', rate=target_sr)
        chunks = []
        for frame in container.decode(stream):
            for out in resampler.resample(frame):
                arr = out.to_ndarray()
                if arr.ndim == 2 and arr.shape[0] == 1:
                    arr = arr.T
                chunks.append(arr)
        if not chunks:
            return None
        pcm = np.concatenate(chunks).flatten().astype(np.float64) / 32768.0
        return pcm, target_sr
    except Exception:
        return None
    finally:
        try:
            container.close()
        except Exception:
            pass


def safe_error(error):
    """Return an error suitable for protocol output without local paths."""
    text = str(error) or error.__class__.__name__
    return text.replace('\\', '/').split('/')[-1] if '/' in text or '\\' in text else text


def normalize_timing(values):
    """Keep finite, strictly ascending timing values in seconds."""
    if values is None:
        return []
    try:
        values = values.tolist() if hasattr(values, 'tolist') else values
        normalized = []
        for value in values:
            value = float(value)
            if np.isfinite(value):
                normalized.append(value)
        return sorted(set(normalized))
    except (TypeError, ValueError):
        return []


def normalize_confidence(values, count, default=0.0):
    """Return one finite confidence value per timing value."""
    try:
        values = values.tolist() if hasattr(values, 'tolist') else values
        result = [float(value) for value in values]
    except (TypeError, ValueError):
        result = []
    result = [value if np.isfinite(value) else default for value in result]
    return (result + [default] * count)[:count]


class AnalysisWorker:
    """Main worker class for audio analysis"""
    
    def __init__(self):
        self.beat_tracker = None
        self.pcm_tracker = None  # Audio2Beats：PyAV 解码出的 PCM 波形直接喂（m4a/aac 等）
        self.device = 'cpu'  # Default to CPU for stability
        self.checkpoint_path = os.environ.get('BEAT_THIS_CHECKPOINT', 'final0')
        self.beat_this_error = BEAT_THIS_IMPORT_ERROR

        # Try to initialize Beat This
        if BEAT_THIS_AVAILABLE:
            try:
                self.beat_tracker = File2Beats(
                    checkpoint_path=self.checkpoint_path,
                    device=self.device,
                    float16=False,
                    dbn=False
                )
                print("Beat This initialized successfully", file=sys.stderr)
            except Exception as e:
                self.beat_this_error = safe_error(e)
                print(f"Failed to initialize Beat This: {self.beat_this_error}", file=sys.stderr)
                self.beat_tracker = None
            try:
                self.pcm_tracker = Audio2Beats(
                    checkpoint_path=self.checkpoint_path,
                    device=self.device,
                    float16=False,
                    dbn=False
                )
            except Exception as e:
                self.pcm_tracker = None
                print(f"Failed to initialize Audio2Beats (PCM path): {safe_error(e)}", file=sys.stderr)
    
    def analyze_track(self, audio_path, track_key=None, duration=None, source_signature=None):
        """
        Analyze a single track and return beat tracking results
        
        Args:
            audio_path: Path to audio file
            track_key: Optional track identifier
            duration: Optional expected duration
            
        Returns:
            dict with analysis results
        """
        try:
            # Verify file exists
            if not os.path.exists(audio_path):
                raise FileNotFoundError(f"Audio file not found: {audio_path}")
            
            result = {
                'schemaVersion': 1,
                'trackKey': track_key or audio_path,
                'provider': 'unknown',
                'beats': [],
                'downbeats': [],
                'beatConfidence': [],
                'downbeatConfidence': [],
                'estimatedBpm': 0,
                'meter': 4,
                'confidence': 0,
                'sections': [],
                'beatFeatures': [],
                'introSilence': 0,
                'outroSilence': 0,
                'analysisVersion': 'beat-this-dsp-v1',
                'duration': duration or 0
            }
            if source_signature is not None:
                result['sourceSignature'] = source_signature
            
            if self.beat_tracker is None:
                raise RuntimeError(self.beat_this_error or "Required Beat This model is unavailable")

            # libsndfile 打不开的容器（m4a/aac/mp4/opus…）走 PyAV 解码成 PCM 再喂 Beat
            # This（Audio2Beats 直接吃 numpy 波形）；连 PyAV 都解不开才 metadata-only
            # 交给浏览器兜底。这仍是"缺解码器"，不是缺模型——不当作硬失败。
            native_readable = probe_audio_format(audio_path)
            if not native_readable:
                decoded = decode_audio_universal(audio_path)
                if decoded is None:
                    print("Skipping librosa for unsupported format", file=sys.stderr)
                    result['provider'] = 'metadata-only'
                    return result

            try:
                if native_readable:
                    beats, downbeats = self.beat_tracker(audio_path)
                else:
                    # PCM 路径：Beat This 直接吃 numpy 波形（+22050 标准采样率）
                    beats, downbeats = self.pcm_tracker(decoded[0], sr=decoded[1])
                result['provider'] = 'beat_this'
                result['beats'] = normalize_timing(beats)
                result['downbeats'] = normalize_timing(downbeats)

                if len(result['beats']) < 2 or len(result['downbeats']) < 2:
                    raise RuntimeError('Beat This returned insufficient beat/downbeat data')

                intervals = np.diff(result['beats'])
                median_interval = np.median(intervals)
                result['estimatedBpm'] = round(60.0 / median_interval, 1)
                interval_std = np.std(intervals)
                interval_consistency = 1.0 / (1.0 + interval_std)
                result['confidence'] = float(interval_consistency)

                beats_per_bar = []
                normalized_beats = np.asarray(result['beats'])
                for i in range(len(result['downbeats']) - 1):
                    db1, db2 = result['downbeats'][i], result['downbeats'][i + 1]
                    num_beats = np.sum((normalized_beats >= db1) & (normalized_beats < db2))
                    if num_beats > 0:
                        beats_per_bar.append(num_beats)
                if beats_per_bar:
                    result['meter'] = int(np.median(beats_per_bar))

                result['downbeatConfidence'] = normalize_confidence(
                    [result['confidence']] * len(result['downbeats']),
                    len(result['downbeats']),
                )
                result['beatConfidence'] = normalize_confidence(
                    [result['confidence']] * len(result['beats']),
                    len(result['beats']),
                )
                print(
                    f"Beat This: found {len(beats)} beats, {len(downbeats)} downbeats, BPM: {result['estimatedBpm']}",
                    file=sys.stderr,
                )
            except Exception as e:
                raise RuntimeError(f"Beat This analysis failed: {safe_error(e)}") from e
            
            # 整曲只解码一次，特征提取与静音检测复用（原先各自 librosa.load，
            # 连同 tracker 内部一次共 3 次全量解码；解码是分析链路最贵的磁盘/CPU 开销）
            # PyAV 路径（m4a/aac 等）直接复用已解码的 PCM——librosa.load 解不开这些容器。
            audio_y, audio_sr = (None, None)
            if LIBROSA_AVAILABLE:
                if native_readable:
                    audio_y, audio_sr = librosa.load(audio_path, sr=22050, mono=True)
                else:
                    audio_y, audio_sr = decoded

            # Extract beat-synchronous features if we have beats
            if result['beats'] and LIBROSA_AVAILABLE:
                try:
                    result['beatFeatures'] = self._extract_beat_features(audio_path, result['beats'], audio=audio_y, sr=audio_sr)
                    result['sections'] = self._detect_sections(result['beatFeatures'], result['duration'])
                except Exception as e:
                    print(f"Feature extraction failed: {safe_error(e)}", file=sys.stderr)
            
            # Detect silence regions
            if LIBROSA_AVAILABLE:
                try:
                    intro, outro = self._detect_silence(audio_path, audio=audio_y, sr=audio_sr)
                    result['introSilence'] = intro
                    result['outroSilence'] = outro
                except Exception as e:
                    print(f"Silence detection failed: {safe_error(e)}", file=sys.stderr)
            
            return result
            
        except Exception as e:
            print(f"Track analysis error: {safe_error(e)}", file=sys.stderr)
            return {
                'error': safe_error(e),
                'trackKey': track_key or 'unknown',
                'provider': 'error'
            }
    
    def _extract_beat_features(self, audio_path, beats, audio=None, sr=None):
        """Extract beat-synchronous features for transition planning"""
        try:
            # audio/sr 由调用方传入（整曲只解码一次）；未传入时退回自行加载（兼容旧调用）
            if audio is None or sr is None:
                y, sr = librosa.load(audio_path, sr=22050, mono=True)
            else:
                y, sr = audio, sr
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
            feature_frame_count = min(
                chroma.shape[1], mfcc.shape[1], len(rms_frames), len(zcr_frames),
                magnitude.shape[1], len(flatness_frames),
            )

            features = []
            for i, beat_time in enumerate(beats):
                start = int(beat_frames[i])
                start = min(start, max(0, feature_frame_count - 1))
                end = int(beat_frames[i + 1]) if i + 1 < len(beat_frames) else min(feature_frame_count, start + 24)
                end = max(start + 1, min(feature_frame_count, end))
                frames = slice(start, end)
                rms = float(np.mean(rms_frames[frames])) if start < len(rms_frames) else 0.0
                spectrum = magnitude[:, frames]
                total_energy = float(np.sum(spectrum))
                mid_energy = float(np.sum(spectrum[vocal_band])) / max(1e-9, total_energy)
                flatness = float(np.mean(flatness_frames[frames])) if start < len(flatness_frames) else 1.0
                zcr = float(np.mean(zcr_frames[frames])) if start < len(zcr_frames) else 1.0
                vocalness = float(np.clip(
                    mid_energy * np.sqrt(max(0.0, 1.0 - flatness)) * (1.0 - min(1.0, zcr * 5.0)),
                    0.0,
                    1.0,
                ))
                features.append({
                    'beatIndex': i,
                    'time': float(beat_time),
                    'loudness': float(librosa.amplitude_to_db(np.asarray([max(rms, 1e-8)]), ref=1.0)[0]),
                    'rms': rms,
                    'chroma': np.mean(chroma[:, frames], axis=1).astype(float).tolist(),
                    'timbre': np.mean(mfcc[:, frames], axis=1).astype(float).tolist(),
                    'vocalness': vocalness,
                    'energy': rms * rms,
                })
            
            return features
            
        except Exception as e:
            print(f"Feature extraction error: {e}", file=sys.stderr)
            return []

    def _detect_sections(self, features, duration):
        if not features:
            return []
        sections = [{
            'time': features[0]['time'],
            'beatIndex': 0,
            'type': 'intro',
            'confidence': 0.7,
        }]
        novelty = np.zeros(len(features), dtype=float)
        for index in range(1, len(features)):
            left = np.asarray(features[index - 1]['timbre'], dtype=float)
            right = np.asarray(features[index]['timbre'], dtype=float)
            denominator = np.linalg.norm(left) * np.linalg.norm(right)
            timbre_delta = 1.0 if denominator < 1e-12 else 1.0 - np.dot(left, right) / denominator
            energy_delta = abs(features[index]['energy'] - features[index - 1]['energy']) / max(1e-6, features[index - 1]['energy'])
            novelty[index] = np.clip(timbre_delta, 0.0, 1.0) * 0.65 + min(1.0, energy_delta) * 0.35

        threshold = float(np.percentile(novelty, 82)) if len(novelty) >= 8 else 1.0
        last_boundary = 0
        for index in range(4, len(features) - 4):
            if index - last_boundary < 8 or novelty[index] < threshold:
                continue
            if novelty[index] < max(novelty[index - 2:index + 3]):
                continue
            before = np.mean([frame['energy'] for frame in features[index - 4:index]])
            after = np.mean([frame['energy'] for frame in features[index:index + 4]])
            section_type = 'drop' if after > before * 1.22 else 'break' if after < before * 0.78 else 'chorus'
            sections.append({
                'time': features[index]['time'],
                'beatIndex': index,
                'type': section_type,
                'confidence': float(np.clip(0.45 + novelty[index] * 0.5, 0.45, 0.95)),
            })
            last_boundary = index

        outro_index = next(
            (index for index, frame in enumerate(features) if frame['time'] >= duration * 0.82),
            len(features) - 1,
        )
        if abs(sections[-1]['beatIndex'] - outro_index) >= 8:
            sections.append({
                'time': features[outro_index]['time'],
                'beatIndex': outro_index,
                'type': 'outro',
                'confidence': 0.6,
            })
        return sections
    
    def _detect_silence(self, audio_path, threshold_db=-40, audio=None, sr=None):
        """Detect intro and outro silence"""
        try:
            # audio/sr 由调用方传入（整曲只解码一次）；未传入时退回自行加载（兼容旧调用）
            if audio is None or sr is None:
                y, sr = librosa.load(audio_path, sr=22050, mono=True)
            else:
                y, sr = audio, sr
            
            # Compute RMS energy
            rms = librosa.feature.rms(y=y, frame_length=2048, hop_length=512)[0]
            rms_db = librosa.amplitude_to_db(rms)
            
            # Find first and last non-silent frames
            non_silent = np.where(rms_db > threshold_db)[0]
            
            if len(non_silent) == 0:
                return 0, 0
            
            first_sound = non_silent[0]
            last_sound = non_silent[-1]
            
            # Convert to time
            intro_silence = librosa.frames_to_time(first_sound, sr=sr, hop_length=512)
            outro_start = librosa.frames_to_time(last_sound, sr=sr, hop_length=512)
            total_duration = len(y) / sr
            outro_silence = total_duration - outro_start
            
            return float(intro_silence), float(outro_silence)
            
        except Exception as e:
            print(f"Silence detection error: {e}", file=sys.stderr)
            return 0, 0
    
    def get_status(self):
        """Return worker status"""
        available = BEAT_THIS_AVAILABLE and self.beat_tracker is not None
        return {
            'status': 'ready' if available else 'failed',
            'beatThisAvailable': available,
            'model': Path(self.checkpoint_path).name or 'final0',
            'provider': 'beat_this' if available else 'unavailable',
            'librosaAvailable': LIBROSA_AVAILABLE,
            'device': self.device,
            **({'error': self.beat_this_error} if self.beat_this_error else {})
        }


def main():
    """Main worker loop - processes JSON messages from stdin"""
    worker = AnalysisWorker()
    
    print("Analysis worker ready", file=sys.stderr)
    sys.stderr.flush()
    
    # Send initial status
    print(json.dumps({'type': 'status', 'data': worker.get_status()}))
    sys.stdout.flush()
    
    # Process messages
    for line in sys.stdin:
        try:
            line = line.strip()
            if not line:
                continue
            
            message = json.loads(line)
            msg_type = message.get('type')
            msg_id = message.get('id')
            
            if msg_type == 'analyze':
                audio_path = message.get('audioPath')
                track_key = message.get('trackKey')
                duration = message.get('duration')
                source_signature = message.get('sourceSignature')
                
                result = worker.analyze_track(audio_path, track_key, duration, source_signature)
                
                response = {
                    'type': 'result',
                    'id': msg_id,
                    'data': result
                }
                
            elif msg_type == 'status':
                response = {
                    'type': 'status',
                    'id': msg_id,
                    'data': worker.get_status()
                }
                
            elif msg_type == 'exit':
                print("Worker exiting", file=sys.stderr)
                break
                
            else:
                response = {
                    'type': 'error',
                    'id': msg_id,
                    'error': f'Unknown message type: {msg_type}'
                }
            
            print(json.dumps(response))
            sys.stdout.flush()
            
        except json.JSONDecodeError as e:
            print(json.dumps({
                'type': 'error',
                'error': f'Invalid JSON: {e}'
            }))
            sys.stdout.flush()
            
        except Exception as e:
            print(json.dumps({
                'type': 'error',
                'error': safe_error(e)
            }))
            sys.stdout.flush()
            traceback.print_exc(file=sys.stderr)


if __name__ == '__main__':
    main()
