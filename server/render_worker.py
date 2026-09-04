#!/usr/bin/env python3
"""
WaveForge Transition Render Worker
Uses Pedalboard for high-quality pitch-preserving time stretching
"""

import sys
import json
import os
import traceback
import numpy as np

# Pedalboard imports
try:
    from pedalboard import Pedalboard, Reverb, Compressor
    from pedalboard.io import AudioFile
    PEDALBOARD_AVAILABLE = True
except ImportError:
    print("Warning: Pedalboard not available", file=sys.stderr)
    PEDALBOARD_AVAILABLE = False

# Librosa for fallback
try:
    import librosa
    import soundfile as sf
    LIBROSA_AVAILABLE = True
except ImportError:
    print("Warning: Librosa not available", file=sys.stderr)
    LIBROSA_AVAILABLE = False


def _ensure_stereo(audio: np.ndarray) -> np.ndarray:
    """单声道输入上采样为立体声，立体声/多声道保持原样。

    与 desktop/workers/render_worker.py 一致保留立体声——音乐是立体声，折叠 mono
    会丢失声像信息。pedalboard AudioFile.read() 与 librosa.load(mono=False) 均返回
    (channels, frames) 2D 布局，这里同时兼容 1D 输入（librosa.load 对单声道文件
    以 mono=False 读取时仍返回 1D）。
    """
    if audio.ndim == 1:
        audio = audio[None, :]
    if audio.shape[0] == 1:
        return np.repeat(audio, 2, axis=0)
    return audio


class RenderWorker:
    """Handles audio rendering for seamless transitions"""
    
    def __init__(self):
        self.sample_rate = 44100
        print(f"Render worker initialized (Pedalboard: {PEDALBOARD_AVAILABLE}, Librosa: {LIBROSA_AVAILABLE})", file=sys.stderr)
    
    def render_transition(self, params):
        """
        Render a seamless transition between two tracks
        
        Args:
            params: {
                'plan': TransitionPlan object,
                'sourceAudioPath': path to source audio file,
                'targetAudioPath': path to target audio file,
                'outputPath': where to save the rendered transition
            }
        
        Returns:
            {
                'success': bool,
                'outputPath': path to rendered file,
                'duration': duration in seconds,
                'error': error message if failed
            }
        """
        try:
            plan = params.get('plan', {})
            source_path = params.get('sourceAudioPath')
            target_path = params.get('targetAudioPath')
            output_path = params.get('outputPath')
            
            if not source_path or not target_path or not output_path:
                return {'success': False, 'error': 'Missing required paths'}
            
            print(f"Rendering transition: {plan.get('id')}", file=sys.stderr)
            print(f"  Source: {source_path} [{plan.get('sourceStartTime'):.2f}s - {plan.get('sourceEndTime'):.2f}s]", file=sys.stderr)
            print(f"  Target: {target_path} [{plan.get('targetStartTime'):.2f}s - {plan.get('targetEndTime'):.2f}s]", file=sys.stderr)
            print(f"  BPM: {plan.get('sourceBpm'):.1f} -> {plan.get('targetBpm'):.1f}", file=sys.stderr)
            
            # Try Pedalboard first (best quality)
            if PEDALBOARD_AVAILABLE:
                try:
                    result = self._render_with_pedalboard(plan, source_path, target_path, output_path)
                    if result['success']:
                        return result
                except Exception as e:
                    print(f"Pedalboard rendering failed: {e}", file=sys.stderr)
            
            # Fallback to Librosa
            if LIBROSA_AVAILABLE:
                try:
                    return self._render_with_librosa(plan, source_path, target_path, output_path)
                except Exception as e:
                    print(f"Librosa rendering failed: {e}", file=sys.stderr)
                    return {'success': False, 'error': str(e)}
            
            return {'success': False, 'error': 'No rendering engine available'}
            
        except Exception as e:
            print(f"Render error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            return {'success': False, 'error': str(e)}
    
    def _render_with_pedalboard(self, plan, source_path, target_path, output_path):
        """Render using Pedalboard (high quality)"""
        
        # Extract time ranges
        source_start = plan.get('sourceStartTime', 0)
        source_end = plan.get('sourceEndTime', 0)
        target_start = plan.get('targetStartTime', 0)
        target_end = plan.get('targetEndTime', 0)
        
        source_bpm = plan.get('sourceBpm', 120)
        target_bpm = plan.get('targetBpm', 120)
        tempo_ramp = plan.get('tempoRamp', [])
        beat_count = plan.get('beatCount', 8)
        
        gain_curve_source = plan.get('gainCurve', {}).get('source', [])
        gain_curve_target = plan.get('gainCurve', {}).get('target', [])
        
        # Load audio segments
        with AudioFile(source_path) as f:
            sr = f.samplerate
            # Read the segment
            start_frame = int(source_start * sr)
            end_frame = int(source_end * sr)
            f.seek(start_frame)
            source_audio = f.read(end_frame - start_frame)
        
        with AudioFile(target_path) as f:
            sr_target = f.samplerate
            if sr != sr_target and not LIBROSA_AVAILABLE:
                # 采样率不匹配且 librosa 不可用：在文件打开期间用 pedalboard 自带重采样读取，
                # 避免静默地以不同采样率混音导致输出错位
                print(f"Warning: Sample rate mismatch {sr} vs {sr_target}, using pedalboard resample", file=sys.stderr)
                resampled = f.resampled_to(sr)
                resampled.seek(int(target_start * sr))
                target_audio = resampled.read(
                    int(target_end * sr) - int(target_start * sr)
                )
                sr_target = sr  # 已按源采样率读取，后续无需再重采样
            else:
                start_frame = int(target_start * sr_target)
                end_frame = int(target_end * sr_target)
                f.seek(start_frame)
                target_audio = f.read(end_frame - start_frame)
        
        # Ensure same sample rate
        if sr != sr_target:
            print(f"Warning: Sample rate mismatch {sr} vs {sr_target}, using {sr}", file=sys.stderr)
            # Resample target if needed
            target_audio = librosa.resample(target_audio, orig_sr=sr_target, target_sr=sr)
        
        # 保留立体声（与 desktop/workers/render_worker.py 契约一致）：
        # 立体声输入保持原样，单声道输入上采样为立体声，避免折叠 mono 丢失声像信息。
        # pedalboard AudioFile.read() 始终返回 (channels, frames) 2D 布局
        source_audio = _ensure_stereo(source_audio)
        target_audio = _ensure_stereo(target_audio)
        
        print(f"Source audio: {source_audio.shape}, Target audio: {target_audio.shape}", file=sys.stderr)
        
        # Apply tempo adjustment if BPM difference > 3%
        bpm_ratio = target_bpm / source_bpm if source_bpm > 0 else 1.0
        needs_stretch = abs(bpm_ratio - 1.0) > 0.03
        
        if needs_stretch and LIBROSA_AVAILABLE:
            print(f"Applying time stretch: ratio={bpm_ratio:.3f}", file=sys.stderr)
            # 逐声道 time_stretch 并保留立体声布局（与 desktop/workers/render_worker.py 一致）
            stretched_channels = [
                librosa.effects.time_stretch(channel, rate=bpm_ratio)
                for channel in source_audio
            ]
            source_audio = np.stack(stretched_channels, axis=0)
        
        # Ensure same length
        min_length = min(source_audio.shape[1], target_audio.shape[1])
        max_length = max(source_audio.shape[1], target_audio.shape[1])
        transition_length = max_length
        
        # Pad shorter audio (按声道数补零，保持 (channels, frames) 布局)
        if source_audio.shape[1] < transition_length:
            padding = np.zeros((source_audio.shape[0], transition_length - source_audio.shape[1]))
            source_audio = np.concatenate([source_audio, padding], axis=1)
        
        if target_audio.shape[1] < transition_length:
            padding = np.zeros((target_audio.shape[0], transition_length - target_audio.shape[1]))
            target_audio = np.concatenate([target_audio, padding], axis=1)
        
        # Apply gain curves (crossfade)
        if len(gain_curve_source) > 0 and len(gain_curve_target) > 0:
            # Interpolate gain curves to audio length
            source_gain = np.interp(
                np.linspace(0, 1, transition_length),
                np.linspace(0, 1, len(gain_curve_source)),
                gain_curve_source
            )
            target_gain = np.interp(
                np.linspace(0, 1, transition_length),
                np.linspace(0, 1, len(gain_curve_target)),
                gain_curve_target
            )
            
            source_audio = source_audio * source_gain
            target_audio = target_audio * target_gain
        
        # Mix the two tracks
        mixed = source_audio + target_audio
        
        # Normalize to prevent clipping
        max_val = np.abs(mixed).max()
        if max_val > 0.95:
            mixed = mixed * (0.95 / max_val)
        
        # Apply light compression to smooth dynamics
        board = Pedalboard([
            Compressor(threshold_db=-20, ratio=2.0)
        ])
        
        processed = board(mixed.astype(np.float32), sr)
        
        # Save output (保留立体声声道数)
        with AudioFile(output_path, 'w', sr, num_channels=processed.shape[0]) as f:
            f.write(processed)
        
        duration = len(processed[0]) / sr
        
        print(f"Rendered transition: {duration:.2f}s", file=sys.stderr)
        
        return {
            'success': True,
            'outputPath': output_path,
            'duration': duration,
            'method': 'pedalboard'
        }
    
    def _render_with_librosa(self, plan, source_path, target_path, output_path):
        """Fallback rendering using Librosa"""
        
        source_start = plan.get('sourceStartTime', 0)
        source_end = plan.get('sourceEndTime', 0)
        target_start = plan.get('targetStartTime', 0)
        target_end = plan.get('targetEndTime', 0)
        
        source_bpm = plan.get('sourceBpm', 120)
        target_bpm = plan.get('targetBpm', 120)
        
        gain_curve_source = plan.get('gainCurve', {}).get('source', [])
        gain_curve_target = plan.get('gainCurve', {}).get('target', [])
        
        # Load audio segments (保留立体声，mono 输入由 _ensure_stereo 上采样为立体声)
        source_audio, sr = librosa.load(source_path, sr=44100, mono=False, offset=source_start, duration=source_end - source_start)
        target_audio, sr = librosa.load(target_path, sr=44100, mono=False, offset=target_start, duration=target_end - target_start)
        
        source_audio = _ensure_stereo(source_audio)
        target_audio = _ensure_stereo(target_audio)
        
        # Apply tempo adjustment
        bpm_ratio = target_bpm / source_bpm if source_bpm > 0 else 1.0
        if abs(bpm_ratio - 1.0) > 0.03:
            print(f"Time stretching: ratio={bpm_ratio:.3f}", file=sys.stderr)
            source_audio = librosa.effects.time_stretch(source_audio, rate=bpm_ratio)
        
        # Ensure same length
        min_length = min(source_audio.shape[1], target_audio.shape[1])
        max_length = max(source_audio.shape[1], target_audio.shape[1])
        transition_length = max_length
        
        # Pad to same length (按声道数补零，保持 (channels, frames) 布局)
        source_channels = source_audio.shape[0]
        target_channels = target_audio.shape[0]
        source_padded = np.zeros((source_channels, transition_length))
        target_padded = np.zeros((target_channels, transition_length))
        
        source_padded[:, :source_audio.shape[1]] = source_audio
        target_padded[:, :target_audio.shape[1]] = target_audio
        
        # Apply gain curves
        if len(gain_curve_source) > 0 and len(gain_curve_target) > 0:
            source_gain = np.interp(
                np.linspace(0, 1, transition_length),
                np.linspace(0, 1, len(gain_curve_source)),
                gain_curve_source
            )
            target_gain = np.interp(
                np.linspace(0, 1, transition_length),
                np.linspace(0, 1, len(gain_curve_target)),
                gain_curve_target
            )
            
            source_padded = source_padded * source_gain
            target_padded = target_padded * target_gain
        
        # Mix
        mixed = source_padded + target_padded
        
        # Normalize
        max_val = np.abs(mixed).max()
        if max_val > 0.95:
            mixed = mixed * (0.95 / max_val)
        
        # Save (soundfile 期望 (frames, channels) 布局，内部统一用 (channels, frames)，写出前转置)
        sf.write(output_path, mixed.T, sr)
        
        duration = mixed.shape[1] / sr
        
        print(f"Rendered transition (librosa): {duration:.2f}s", file=sys.stderr)
        
        return {
            'success': True,
            'outputPath': output_path,
            'duration': duration,
            'method': 'librosa'
        }
    
    def get_status(self):
        """Return worker status"""
        return {
            'status': 'ready',
            'pedalboardAvailable': PEDALBOARD_AVAILABLE,
            'librosaAvailable': LIBROSA_AVAILABLE
        }


def main():
    """Main worker loop - processes JSON messages from stdin"""
    worker = RenderWorker()
    
    print("Render worker ready", file=sys.stderr)
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
            
            if msg_type == 'render':
                params = message.get('params', {})
                result = worker.render_transition(params)
                
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
                print("Render worker shutting down", file=sys.stderr)
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
            print(f"JSON decode error: {e}", file=sys.stderr)
            error_response = {
                'type': 'error',
                'id': None,
                'error': f'Invalid JSON: {str(e)}'
            }
            print(json.dumps(error_response))
            sys.stdout.flush()
            
        except Exception as e:
            print(f"Worker error: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
            error_response = {
                'type': 'error',
                'id': message.get('id') if 'message' in locals() else None,
                'error': str(e)
            }
            print(json.dumps(error_response))
            sys.stdout.flush()


if __name__ == '__main__':
    main()
