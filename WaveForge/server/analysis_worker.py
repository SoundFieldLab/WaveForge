#!/usr/bin/env python3
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
except ImportError:
    BEAT_THIS_AVAILABLE = False
    print("WARNING: beat_this not installed, using fallback", file=sys.stderr)

# Check if librosa is available for feature extraction
try:
    import librosa
    LIBROSA_AVAILABLE = True
except ImportError:
    LIBROSA_AVAILABLE = False
    print("WARNING: librosa not installed, feature extraction limited", file=sys.stderr)


class AnalysisWorker:
    """Main worker class for audio analysis"""
    
    def __init__(self):
        self.beat_tracker = None
        self.device = 'cpu'  # Default to CPU for stability
        
        # Try to initialize Beat This
        if BEAT_THIS_AVAILABLE:
            try:
                self.beat_tracker = File2Beats(
                    checkpoint_path='final0',
                    device=self.device,
                    float16=False,
                    dbn=False
                )
                print("Beat This initialized successfully", file=sys.stderr)
            except Exception as e:
                print(f"Failed to initialize Beat This: {e}", file=sys.stderr)
                self.beat_tracker = None
    
    def analyze_track(self, audio_path, track_key=None, duration=None):
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
                'analysisVersion': 'librosa-dsp-v2',
                'duration': duration or 0
            }
            
            # Try Beat This analysis
            if self.beat_tracker is not None:
                try:
                    beats, downbeats = self.beat_tracker(audio_path)
                    
                    result['provider'] = 'beat_this'
                    result['beats'] = beats.tolist() if hasattr(beats, 'tolist') else list(beats)
                    result['downbeats'] = downbeats.tolist() if hasattr(downbeats, 'tolist') else list(downbeats)
                    
                    # Estimate BPM from beats
                    if len(beats) > 1:
                        intervals = np.diff(beats)
                        median_interval = np.median(intervals)
                        result['estimatedBpm'] = round(60.0 / median_interval, 1)
                        
                        # Calculate beat confidence (based on interval consistency)
                        interval_std = np.std(intervals)
                        interval_consistency = 1.0 / (1.0 + interval_std)
                        result['confidence'] = float(interval_consistency)
                        result['beatConfidence'] = [result['confidence']] * len(beats)
                    
                    # Estimate meter from downbeat spacing
                    if len(downbeats) > 1 and len(beats) > 0:
                        beats_per_bar = []
                        for i in range(len(downbeats) - 1):
                            db1, db2 = downbeats[i], downbeats[i+1]
                            num_beats = np.sum((beats >= db1) & (beats < db2))
                            if num_beats > 0:
                                beats_per_bar.append(num_beats)
                        if beats_per_bar:
                            result['meter'] = int(np.median(beats_per_bar))
                    
                    result['downbeatConfidence'] = [result['confidence']] * len(downbeats)
                    
                    print(f"Beat This: found {len(beats)} beats, {len(downbeats)} downbeats, BPM: {result['estimatedBpm']}", file=sys.stderr)
                    
                except Exception as e:
                    print(f"Beat This analysis failed: {e}", file=sys.stderr)
                    result['provider'] = 'beat_this_failed'
            
            # Fallback: librosa analysis
            if result['provider'] not in ['beat_this'] and LIBROSA_AVAILABLE:
                try:
                    y, sr = librosa.load(audio_path, sr=22050, mono=True)
                    result['duration'] = len(y) / sr
                    
                    onset = librosa.onset.onset_strength(y=y, sr=sr, hop_length=512)
                    tempo, beat_frame_indices = librosa.beat.beat_track(
                        onset_envelope=onset, sr=sr, hop_length=512, units='frames'
                    )
                    beat_frame_indices = np.asarray(beat_frame_indices, dtype=int)
                    beat_times = librosa.frames_to_time(beat_frame_indices, sr=sr, hop_length=512)
                    result['beats'] = beat_times.astype(float).tolist()
                    # 静音音频时 librosa 返回 tempo=0.0，需回退为默认 BPM
                    if tempo == 0 or not np.asarray(beat_frame_indices).size:
                        tempo = 120.0
                    result['estimatedBpm'] = float(np.asarray(tempo).reshape(-1)[0])
                    result['provider'] = 'librosa-fallback'

                    intervals = np.diff(beat_times)
                    consistency = float(np.clip(
                        1.0 - np.std(intervals) / max(1e-6, np.median(intervals)), 0.0, 1.0
                    )) if len(intervals) else 0.0
                    strengths = onset[np.clip(beat_frame_indices, 0, max(0, len(onset) - 1))] if len(beat_frame_indices) else np.array([])
                    strength = float(np.clip(
                        np.mean(strengths) / max(1e-6, np.percentile(onset, 90)), 0.0, 1.0
                    )) if len(strengths) else 0.0
                    result['confidence'] = float(np.clip(0.2 + consistency * 0.55 + strength * 0.25, 0.0, 0.95))
                    result['beatConfidence'] = [result['confidence']] * len(beat_times)

                    phase_scores = [
                        float(np.mean(strengths[phase::4])) if len(strengths[phase::4]) else 0.0
                        for phase in range(4)
                    ]
                    phase = int(np.argmax(phase_scores)) if phase_scores else 0
                    result['downbeats'] = beat_times[phase::4].astype(float).tolist()
                    result['downbeatConfidence'] = [result['confidence'] * 0.85] * len(result['downbeats'])
                    
                    print(f"Librosa fallback: {len(beat_times)} beats, BPM: {result['estimatedBpm']}", file=sys.stderr)
                    
                except Exception as e:
                    print(f"Librosa analysis failed: {e}", file=sys.stderr)
                    result['provider'] = 'librosa_failed'
            
            # Last resort: metadata-only
            if not result['beats']:
                result['provider'] = 'metadata-only'
                print("No beat tracking available, using metadata only", file=sys.stderr)
            
            # Extract beat-synchronous features if we have beats
            if result['beats'] and LIBROSA_AVAILABLE:
                try:
                    result['beatFeatures'] = self._extract_beat_features(audio_path, result['beats'])
                    result['sections'] = self._detect_sections(result['beatFeatures'], result['duration'])
                except Exception as e:
                    print(f"Feature extraction failed: {e}", file=sys.stderr)
            
            # Detect silence regions
            if LIBROSA_AVAILABLE:
                try:
                    intro, outro = self._detect_silence(audio_path)
                    result['introSilence'] = intro
                    result['outroSilence'] = outro
                except Exception as e:
                    print(f"Silence detection failed: {e}", file=sys.stderr)
            
            return result
            
        except Exception as e:
            print(f"Track analysis error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {
                'error': str(e),
                'trackKey': track_key or audio_path,
                'provider': 'error'
            }
    
    def _extract_beat_features(self, audio_path, beats):
        """Extract beat-synchronous features for transition planning"""
        try:
            y, sr = librosa.load(audio_path, sr=22050, mono=True)
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
    
    def _detect_silence(self, audio_path, threshold_db=-40):
        """Detect intro and outro silence"""
        try:
            y, sr = librosa.load(audio_path, sr=22050, mono=True)
            
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
        return {
            'status': 'ready',
            'beatThisAvailable': BEAT_THIS_AVAILABLE and self.beat_tracker is not None,
            'librosaAvailable': LIBROSA_AVAILABLE,
            'device': self.device
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
                
                result = worker.analyze_track(audio_path, track_key, duration)
                
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
                'error': str(e)
            }))
            sys.stdout.flush()
            traceback.print_exc(file=sys.stderr)


if __name__ == '__main__':
    main()
