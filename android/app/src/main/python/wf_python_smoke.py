# -*- coding: utf-8 -*-
"""WaveForge 安卓内嵌 Python 冒烟测试（Chaquopy 集成验证）。

验证链路：numpy 科学计算 + STFT（AutoMix 节拍分析的核心算子）在安卓上真实可跑。
由 MainActivity 通过 PythonPlatform.smokeTest() 调用，结果写入 logcat（tag WFPython）。
后续接入：beat_analyzer 精简移植（numba-free librosa 核心函数）→ :3002 等价能力。
"""
import json
import os
import tempfile
import time
import wave

import numpy as np


def smoke_test() -> str:
    t0 = time.time()
    # 1) numpy 基础
    a = np.random.RandomState(42).rand(44100 * 10)  # 10s 假想音频
    rms = float(np.sqrt(np.mean(a ** 2)))

    # 2) STFT（节拍分析核心算子）：标准滑窗
    n_fft, hop = 2048, 512
    window = np.hanning(n_fft)
    n_frames = 1 + (len(a) - n_fft) // hop
    idx = np.arange(n_fft)[None, :] + hop * np.arange(n_frames)[:, None]
    frames = a[idx] * window
    spec = np.abs(np.fft.rfft(frames, axis=1))
    onset_env = np.sum(np.diff(spec, axis=0).clip(min=0), axis=1)
    bpm_est = float(np.mean(onset_env))

    # 3) 结果摘要（真机 logcat 打印）
    elapsed = (time.time() - t0) * 1000
    return (
        f"numpy={np.__version__} rms={rms:.4f} bpm_est={bpm_est:.1f} "
        f"stft_frames={spec.shape[0]} elapsed={elapsed:.0f}ms"
    )


def beat_smoke(cache_dir: str) -> str:
    """beat 分析器闭环自测：合成 120BPM 打点音频 → WAV → wf_beat.analyze_file。"""
    import wf_beat

    sr = 22050
    duration = 12.0
    t = np.arange(int(sr * duration)) / sr
    y = np.zeros_like(t)
    for beat_t in np.arange(0.5, duration, 0.5):  # 120 BPM = 0.5s 间隔
        i0 = int(beat_t * sr)
        i1 = min(len(y), i0 + int(0.05 * sr))
        if i1 <= i0:
            continue
        click = t[: i1 - i0]
        y[i0:i1] += np.sin(2 * np.pi * 1000.0 * click) * np.exp(-click * 90.0)
    y = (y * 0.8 * 32767).astype('<i2')

    path = os.path.join(cache_dir, 'wf_beat_smoke.wav')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(y.tobytes())

    result = json.loads(wf_beat.analyze_file(path))
    return (
        f"beat: bpm={result['bpm']} beats={len(result['beats'])} "
        f"provider={result['provider']} elapsed={result['elapsed_ms']}ms"
    )
