# -*- coding: utf-8 -*-
"""WaveForge 安卓内嵌 beat 分析器（AutoMix 移动端，numba-free）。

与 PC 端 python-beat-service/beat_analyzer.py 同源语义，但：
  - 不依赖 librosa/numba（安卓无 wheel）：STFT/onset 包络/chroma/MFCC 手写（numpy），
    节拍跟踪移植 librosa 的动态规划算法（librosa.beat.__beat_tracker 的 numpy 实现）
  - 输入：WAV 文件（16/32-bit PCM，由调用方保证）；后续如需 mp3 再接解码器
  - 输出：与 PC 端 /analyze 兼容的字段子集（beats/bpm/duration/onset_envelope/chroma/mfcc）
由 Kotlin 侧 analyze_file(path) 调用；结果 JSON 字符串。
"""
import json
import time
import wave

import numpy as np

SR = 22050
N_FFT = 2048
HOP = 512


def _load_wav_mono(path):
    with wave.open(path, 'rb') as w:
        sr = w.getframerate()
        nch = w.getnchannels()
        sw = w.getsampwidth()
        n = w.getnframes()
        raw = w.readframes(n)
    if sw == 2:
        a = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    elif sw == 4:
        a = np.frombuffer(raw, dtype='<i4').astype(np.float32) / 2147483648.0
    elif sw == 1:
        a = (np.frombuffer(raw, dtype=np.uint8).astype(np.float32) - 128.0) / 128.0
    else:
        raise ValueError(f'unsupported sample width {sw}')
    if nch > 1:
        a = a.reshape(-1, nch).mean(axis=1)
    return a, sr


def _stft_mag(y):
    window = np.hanning(N_FFT).astype(np.float32)
    n_frames = 1 + max(0, (len(y) - N_FFT)) // HOP
    if n_frames <= 0:
        return np.zeros((1, N_FFT // 2 + 1), np.float32)
    idx = np.arange(N_FFT)[None, :] + HOP * np.arange(n_frames)[:, None]
    frames = y[idx] * window
    return np.abs(np.fft.rfft(frames, axis=1)).astype(np.float32)


def _onset_strength(spec):
    """flux：谱差分正半周的和（librosa.onset.onset_strength 的核心）。"""
    flux = np.sum(np.diff(spec, axis=0).clip(min=0), axis=1)
    # 局部均值去直流（librosa 的 lag=1 参考）
    kernel = np.ones(9, np.float32) / 9.0
    ref = np.convolve(flux, kernel, mode='same')
    return np.maximum(0.0, flux - ref).astype(np.float32)


def _beat_track_dp(onset, sr=SR, hop=HOP, tightness=100.0, bpm_min=60.0, bpm_max=220.0):
    """动态规划节拍跟踪（移植 librosa.beat.__beat_tracker 的核心 DP，纯 numpy）。"""
    if len(onset) < 20:
        return np.array([]), 120.0
    period_bounds = (60.0 / bpm_max, 60.0 / bpm_min)
    # 自相关（onset → tempo 候选）
    onset_c = onset - onset.mean()
    ac = np.correlate(onset_c, onset_c, mode='full')[len(onset) - 1:]
    lag_min = int(np.floor(period_bounds[0] * sr / hop))
    lag_max = int(np.ceil(period_bounds[1] * sr / hop))
    lag_max = min(lag_max, len(ac) - 1)
    if lag_max <= lag_min:
        return np.array([]), 120.0
    lag_range = np.arange(lag_min, lag_max + 1)
    # 对数加权的自相关谱（librosa tempo 用 log-normal prior）
    log_range = np.log2(60.0 * sr / (hop * lag_range.astype(float)))
    prior = np.exp(-0.5 * ((log_range - np.log2(120.0)) / 1.0) ** 2)
    best_period = lag_range[int(np.argmax(ac[lag_min:lag_max + 1] * prior))]
    bpm = 60.0 * sr / (hop * float(best_period))

    # DP：score[t] = onset[t] + max(score[t'] - tightness * (log(period) - log(t-t'))^2)
    tps = tightness
    score = np.zeros_like(onset)
    backlink = np.full(len(onset), -1, np.int32)
    logp = np.log(best_period)
    window = int(np.ceil(period_bounds[1] * sr / hop)) + 1
    for t in range(len(onset)):
        best = -np.inf
        best_t = -1
        lo = max(0, t - window)
        for tp in range(lo, t):
            if t - tp < lag_min:
                continue
            trans = -tps * (logp - np.log(t - tp)) ** 2
            v = score[tp] + trans
            if v > best:
                best = v
                best_t = tp
        if best_t < 0:
            score[t] = onset[t]
        else:
            score[t] = onset[t] + best
            backlink[t] = best_t
    # 回溯最强链尾
    tail = int(np.argmax(score))
    beats_rev = []
    while tail >= 0:
        beats_rev.append(tail)
        tail = int(backlink[tail])
    beats_frame = np.array(sorted(beats_rev), np.int64)
    beats_time = beats_frame * hop / sr
    return beats_time, float(bpm)


def _chroma(spec):
    """CQT 的廉价近似：把 STFT 频率槽映射到 12 半音（对数频率 bin 求和）。"""
    freqs = np.fft.rfftfreq(N_FFT, 1.0 / SR)
    chroma = np.zeros((spec.shape[0], 12), np.float32)
    mask = freqs > 65.0
    if not mask.any():
        return chroma
    pitch = 12.0 * np.log2(freqs[mask] / 440.0)
    pc_of_bin = np.abs(np.round(pitch).astype(np.int64)) % 12  # 每个 mask 内 bin 的 pitch class
    bins = np.nonzero(mask)[0]
    for pc in range(12):
        sel = bins[pc_of_bin == pc]
        if sel.size:
            chroma[:, pc] = spec[:, sel].sum(axis=1)
    norm = np.maximum(chroma.max(axis=1, keepdims=True), 1e-8)
    return (chroma / norm).astype(np.float32)


def _mfcc(spec, n_mfcc=13):
    """DCT-II of log-mel 的简化：log 幅度谱分组求和后 DCT。"""
    log_mag = np.log1p(spec)
    n_filt = 26
    edges = np.linspace(0, spec.shape[1] - 1, n_filt + 2).astype(int)
    mel = np.stack([log_mag[:, edges[i]:edges[i + 1] + 1].mean(axis=1) for i in range(n_filt)], axis=1)
    # DCT-II
    k = np.arange(n_mfcc)[:, None]
    n = np.arange(n_filt)[None, :]
    dct = np.cos(np.pi * k * (2 * n + 1) / (2 * n_filt)) * (2.0 / n_filt) ** 0.5
    return (dct @ mel.T).T.astype(np.float32)


def analyze_file(path):
    t0 = time.time()
    y, sr = _load_wav_mono(path)
    if sr != SR:
        # 简单线性重采样（精度足够做节拍分析）
        ratio = SR / sr
        n_out = int(len(y) * ratio)
        y = np.interp(np.arange(n_out) / ratio, np.arange(len(y)), y).astype(np.float32)
    duration = float(len(y) / SR)

    spec = _stft_mag(y)
    onset = _onset_strength(spec)
    beats, bpm = _beat_track_dp(onset)
    chroma = _chroma(spec)
    mfcc = _mfcc(spec)

    elapsed_ms = int((time.time() - t0) * 1000)
    return json.dumps({
        'beats': [round(float(b), 3) for b in beats],
        'bpm': round(bpm, 2),
        'duration': round(duration, 3),
        'chroma_mean': [round(float(x), 4) for x in chroma.mean(axis=0)],
        'mfcc_mean': [round(float(x), 3) for x in mfcc.mean(axis=0)],
        'elapsed_ms': elapsed_ms,
        'provider': 'android-embedded-v1',
    })
