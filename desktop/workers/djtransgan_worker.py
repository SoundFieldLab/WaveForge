#!/usr/bin/env python3
# 私有模块（Private Module）—— 见仓库根 PRIVATE-LICENSE.md。
# 版权所有（c）2026 WaveForge 澜音工坊，保留所有权利；未经书面授权禁止复制/移植/再分发。
"""
AI 混音（DJTransGAN）渲染 Worker —— 独立于 render_worker.py。

用带 torch 的 Python（venv / 可选下载的 AI 引擎）跑 DJTransGAN 预训练模型，
把两首曲子的过渡窗口交给模型生成"推子 + EQ 自动化"驱动的长混音（~60s）。

与 render_worker.py 协议一致：stdin 收 {type,id,params}，stdout 回 {type,id,data}。
消息类型：'render'（渲染 AI 过渡）、'probe'（探测引擎可用性）、'exit'。

依赖的 DJTransGAN 仓库路径：
  - 环境变量 WAVEFORGE_DJTRANSGAN_DIR（默认 D:\\opencode\\DJTransGAN）
模型输出为固定 ~60s 混音窗口（模型训练语义），起始/结束时间戳随结果返回，
前端据此把过渡窗口替换为模型窗口（长混音），源曲提前切入、目标曲延后恢复。
"""

import json
import os
import sys
import uuid

REPO_DIR = os.environ.get('WAVEFORGE_DJTRANSGAN_DIR', r'D:\opencode\DJTransGAN')

if REPO_DIR not in sys.path:
    sys.path.insert(0, REPO_DIR)

import numpy as np  # noqa: E402

SR = 44100


def _plan_beats(plan, key):
    """App 分析好的节拍注入（替代仓库内 madmom 节拍检测——madmom 无 wheel 且
    不支持 Py3.13，无法自动安装）。plan 携带 source/target 的 bpm 与拍点，
    4/4 主拍网格下每 4 拍取一个 downbeat 近似（真实歌曲以 4/4 为主）。"""
    prefix = 'source' if key == 'prev' else 'target'
    beats = plan.get(f'{prefix}BeatTimes') or []
    bpm = float(plan.get(f'{prefix}Bpm') or 120.0)
    downbeats = beats[::4] if beats else []
    return {'bpm': bpm, 'downbeats': downbeats}


def _preprocess(prev_audio, next_audio, prev_cue, next_cue, plan_beats):
    """DJTransGAN preprocess 的 WaveForge 适配版。

    仓库原版 preprocess(prev, next, prev_cue, next_cue) 用 madmom/librosa 自行估
    节拍（签名 4 参、返回 3 值），与 WaveForge 期望的"注入 App 节拍 + 返回 2 值"
    不符。这里用 plan_beats（App 分析注入的 BPM/拍点）替代内部估拍，流程与仓库
    原版一致；缺注入数据时回退仓库自身估拍（librosa 兜底），保证 AI 混音可用。
    """
    import torch
    from djtransgan.config import settings
    from djtransgan.utils import normalize
    from djtransgan.dataset import select_audio_region
    from djtransgan.process import sync_bpm, sync_cue, select_cue_points, correct_cue, estimate_beat

    def _beats(key, audio):
        info = (plan_beats or {}).get(key) or {}
        bpm = float(info.get('bpm') or 0.0)
        downbeat = np.asarray(info.get('downbeats') or [], dtype=float)
        if bpm <= 0 or downbeat.size < 2:
            # 缺节拍注入（旧 plan/上游路径）时回退仓库自身估拍
            try:
                _, bpm, _, downbeat = estimate_beat(audio)
                bpm = float(bpm or 0.0)
                downbeat = np.asarray(downbeat, dtype=float)
            except Exception as e:
                raise RuntimeError(f'beat data unavailable for AI mix: {e}')
        return bpm, downbeat

    prev_bpm, prev_downbeat = _beats('prev', prev_audio)
    next_bpm, next_downbeat = _beats('next', next_audio)

    next_audio, ratio = sync_bpm(next_audio, prev_bpm, next_bpm)
    next_downbeat = next_downbeat / ratio
    next_cue = correct_cue(next_downbeat, next_cue / ratio)
    prev_cue = correct_cue(prev_downbeat, prev_cue)

    prev_cues, next_cues = select_cue_points(prev_cue, next_cue, prev_downbeat, next_downbeat)
    next_audio, next_cues = sync_cue(prev_audio, next_audio, prev_cues, next_cues)

    next_audio = normalize(next_audio)
    prev_audio = normalize(prev_audio)

    prev_audio_for_g, prev_cues_for_g, (prev_cues_ori, prev_timestamps) = select_audio_region(
        prev_audio, prev_cues, settings.N_TIME, True, 0)
    next_audio_for_g, next_cues_for_g, (next_cues_ori, next_timestamps) = select_audio_region(
        next_audio, next_cues, settings.N_TIME, True, 1)

    pair_audio = [prev_audio, next_audio]
    timestamps = [prev_timestamps, next_timestamps]
    pair_audio_for_g = [
        prev_audio_for_g.unsqueeze(0).to(torch.float32),
        next_audio_for_g.unsqueeze(0).to(torch.float32),
    ]
    cue_for_g = prev_cues_for_g.unsqueeze(0).to(torch.float32)
    return (pair_audio, timestamps), (pair_audio_for_g, cue_for_g)

# ── v2 编排特效层（与 render_worker.py 同实现的独立副本，只依赖 numpy/scipy）──
# AI worker 运行在带 torch 的 venv（无 pedalboard），无法 import render_worker；
# 这里内嵌 riser/噪声扫频/鼓点填充/回声 + 依赖的 filtered/beat_automation/kick，
# 让 AI 长混音同样具备 v2 的 DJ 特效（否则只有"前曲渐出+后曲渐入"的最基本形态）。
import hashlib  # noqa: E402
from scipy import signal  # noqa: E402

INTENSITY_FACTOR = {'subtle': 0.55, 'standard': 0.75, 'strong': 1.0}


def _filtered(audio, sample_rate, cutoff, filter_type):
    nyquist = sample_rate / 2
    safe_cutoff = float(np.clip(cutoff, 20, nyquist * 0.9))
    sos = signal.butter(2, safe_cutoff, btype=filter_type, fs=sample_rate, output='sos')
    return signal.sosfilt(sos, audio, axis=1).astype(np.float32)


def _beat_automation(samples, sample_rate, beat_durations, points):
    beat_samples = [0]
    for duration in beat_durations:
        beat_samples.append(beat_samples[-1] + max(1, int(round(duration * sample_rate))))

    def beat_to_sample(beat_position):
        beat_position = float(np.clip(beat_position, 0, len(beat_durations)))
        lower = min(len(beat_durations) - 1, int(np.floor(beat_position)))
        if beat_position >= len(beat_durations):
            return float(beat_samples[-1])
        fraction = beat_position - lower
        return beat_samples[lower] + fraction * (beat_samples[lower + 1] - beat_samples[lower])

    sample_points = np.asarray([beat_to_sample(beat) for beat, _ in points], dtype=float)
    values = np.asarray([value for _, value in points], dtype=float)
    return np.interp(np.arange(samples, dtype=float), sample_points, values).astype(np.float32)


def _synthesize_kick(sample_rate, duration=0.12):
    n = max(1, int(duration * sample_rate))
    t = np.arange(n) / sample_rate
    freq = 45.0 + (160.0 - 45.0) * np.exp(-t * 18.0)
    phase = 2.0 * np.pi * np.cumsum(freq) / sample_rate
    envelope = np.exp(-t * 9.0)
    return (np.sin(phase) * envelope).astype(np.float32)


def _create_echo_out(source, sample_rate, beat_durations, delay_beats, feedback, intensity):
    beat_count = len(beat_durations)
    representative_beat = float(np.median(beat_durations[max(0, beat_count // 2):]))
    delay_samples = max(1, int(round(representative_beat * delay_beats * sample_rate)))
    send = _beat_automation(source.shape[1], sample_rate, beat_durations, [
        (0, 0.0), (beat_count * 0.55, 0.0), (beat_count * 0.65, 1.0), (beat_count, 0.35),
    ])
    echo = np.zeros_like(source, dtype=np.float32)
    seed = source * send[None, :]
    for tap in range(1, 5):
        offset = delay_samples * tap
        if offset >= source.shape[1]:
            break
        echo[:, offset:] += seed[:, :-offset] * (feedback ** (tap - 1))
    return_envelope = _beat_automation(source.shape[1], sample_rate, beat_durations, [
        (0, 0.0), (beat_count * 0.58, 0.0), (beat_count * 0.72, 1.0),
        (max(0, beat_count - 1), 0.55), (beat_count, 0.0),
    ])
    wet_level = 0.24 + intensity * 0.24
    return echo * return_envelope[None, :] * wet_level


def _create_sweep_fx(channels, samples, sample_rate, beat_durations, intensity, reference_rms, seed_text):
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
    envelope = _beat_automation(samples, sample_rate, beat_durations, [
        (0, 0.0), (beat_count * 0.25, 0.04), (beat_count * 0.5, 1.0),
        (beat_count * 0.75, 0.12), (beat_count, 0.0),
    ])
    level = reference_rms * (0.10 + intensity * 0.09)
    return np.repeat(noise[None, :] * envelope[None, :] * level, channels, axis=0).astype(np.float32)


def _create_drum_fill(channels, samples, sample_rate, beat_durations, fill_beats, intensity, reference_rms, seed_text):
    beat_count = len(beat_durations)
    if fill_beats <= 0 or beat_count <= 1:
        return np.zeros((channels, samples), dtype=np.float32)
    beat_samples = [0]
    for duration in beat_durations:
        beat_samples.append(beat_samples[-1] + max(1, int(round(duration * sample_rate))))
    fill_start_beat = max(0, beat_count - fill_beats)
    fill_start_sample = beat_samples[fill_start_beat] if fill_start_beat < len(beat_samples) else 0
    fill_span = max(1, beat_samples[beat_count] - fill_start_sample)
    subdivisions = [0.0, 0.5, 0.75, 1.0, 1.25, 1.5, 2.0, 2.75]
    pattern = [rel for rel in subdivisions if rel < fill_beats]
    kick = _synthesize_kick(sample_rate)
    fill = np.zeros((channels, samples), dtype=np.float32)
    rng = np.random.default_rng(int(hashlib.sha256(seed_text.encode('utf-8')).hexdigest()[:8], 16))
    for rel in pattern:
        pos = fill_start_sample + int(round((rel / max(1, fill_beats)) * fill_span))
        end = min(samples, pos + len(kick))
        if pos >= samples:
            continue
        hit = kick[:end - pos] * (0.9 + 0.2 * rng.random())
        for ch in range(channels):
            fill[ch, pos:end] += hit
    level = reference_rms * (0.26 + 0.28 * float(np.clip(intensity, 0.0, 1.0)))
    return (fill * level).astype(np.float32)


def _apply_mix_filter_sweep(mix: np.ndarray, sample_rate: int, beat_durations: list[float], intensity: float) -> np.ndarray:
    """DJ 式整体滤波扫频（对音乐本身，非叠加合成音效）：
    过渡中段低通压暗（抽低频、声音"闷"下去），尾部高通提亮（低频回归、空气感），
    导向 handoff 的"重新打开"听感——DJ 过渡最典型的处理，AI 混音（已混合信号）同样适用。
    """
    beat_count = len(beat_durations)
    wet = float(np.clip(0.45 + intensity * 0.55, 0.0, 0.9))
    result = mix.copy()
    # 阶段 1：中段低通压暗（0.35→0.6 beat 渐入，0.75 beat 收回）
    lowpassed = _filtered(mix, sample_rate, 500, 'lowpass')
    env1 = _beat_automation(mix.shape[1], sample_rate, beat_durations, [
        (0, 0.0),
        (beat_count * 0.35, 0.0),
        (beat_count * 0.6, wet * 0.7),
        (beat_count * 0.75, 0.0),
    ])
    result = result * (1.0 - env1[None, :]) + lowpassed * env1[None, :]
    # 阶段 2：尾部高通提亮（0.75→0.92 beat 渐入，保持到结束）
    highpassed = _filtered(mix, sample_rate, 250, 'highpass')
    env2 = _beat_automation(mix.shape[1], sample_rate, beat_durations, [
        (0, 0.0),
        (beat_count * 0.75, 0.0),
        (beat_count * 0.92, wet * 0.55),
        (beat_count, wet * 0.45),
    ])
    result = result * (1.0 - env2[None, :]) + highpassed * env2[None, :]
    return result.astype(np.float32)


def _create_riser(channels, samples, sample_rate, beat_durations, intensity, reference_rms, seed_text,
                  start_beat=None, end_freq=2400.0):
    beat_count = len(beat_durations)
    if start_beat is None:
        start_beat = max(0, beat_count - 3)
    else:
        start_beat = max(0, min(beat_count - 1, int(start_beat)))
    envelope = _beat_automation(samples, sample_rate, beat_durations, [
        (0, 0.0), (start_beat, 0.0), (beat_count, 1.0),
    ])
    if envelope.max() < 1e-9:
        return np.zeros((channels, samples), dtype=np.float32)
    rng = np.random.default_rng(int(hashlib.sha256(seed_text.encode('utf-8')).hexdigest()[:8], 16))
    t = np.arange(samples) / sample_rate
    f0, f1 = 180.0, float(np.clip(end_freq, 300.0, 9000.0))
    freq = f0 * (f1 / f0) ** (t / max(1e-9, t[-1]))
    phase = 2.0 * np.pi * np.cumsum(freq) / sample_rate
    sweep = np.sin(phase).astype(np.float32)
    noise = rng.standard_normal(samples).astype(np.float32)
    noise = _filtered(noise[None, :], sample_rate, 4000, 'lowpass')[0]
    noise = _filtered(noise[None, :], sample_rate, 300, 'highpass')[0]
    noise_rms = float(np.sqrt(np.mean(noise * noise))) + 1e-9
    riser = (0.75 * sweep + 0.25 * noise / noise_rms) * envelope[None, :]
    level = reference_rms * (0.28 + 0.22 * float(np.clip(intensity, 0.0, 1.0)))
    return np.repeat(riser, channels, axis=0).astype(np.float32) * level


def load_generator():
    """加载 DJTransGAN 预训练生成器（模型/权重都较大，仅加载一次，常驻进程）。"""
    import torch
    from djtransgan.model import get_generator
    from djtransgan.utils import load_pt

    gen = get_generator()
    weight_path = os.path.join(REPO_DIR, 'pretrained', 'djtransgan_minmax.pt')
    if not os.path.exists(weight_path):
        raise RuntimeError(f'DJTransGAN 预训练权重不存在: {weight_path}')
    gen.load_state_dict(load_pt(weight_path))
    gen.eval()
    return gen, torch


def load_track(path, torch):
    """整曲解码为 DJTransGAN 期望的 (1, N) float32 tensor（44.1k mono）。"""
    import librosa
    audio, _ = librosa.load(path, sr=SR, mono=True)
    audio = np.ascontiguousarray(audio, dtype=np.float32)
    return torch.from_numpy(audio).unsqueeze(0)


def extract_automation(plan, source_path, target_path):
    """只跑编码器+后处理器，提取 DJTransGAN 学到的推子/EQ 自动化参数（14 标量）。

    模型输出是闭式参数式曲线（fader: start/slope；band: 3 边界 × start/slope），
    可在**任意长度**上重建——这是把 AI 学到的过渡曲线复用到 v2 短过渡（8~32 拍）
    的关键：不依赖固定 60s 窗口，不渲染音频（跳过 mixer/ISTFT，快）。
    """

    generator, torch = load_generator()

    prev_cue = float(plan['sourceEndTime'])
    next_cue = float(plan['targetStartTime'])
    prev_audio = load_track(source_path, torch)
    next_audio = load_track(target_path, torch)

    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        # WaveForge 适配：节拍用 App 分析注入（_preprocess 内部替代估拍）
        plan_beats = {'prev': _plan_beats(plan, 'prev'), 'next': _plan_beats(plan, 'next')}
        (pair_audio, timestamps), (pair_audio_for_g, cue_for_g) = _preprocess(prev_audio, next_audio, prev_cue, next_cue, plan_beats)
        pair_audio_for_g = [t.float() for t in pair_audio_for_g]  # preprocess 部分输出 float64，模型需要 float32
        with torch.no_grad():
            in_vecs, _in_mags = generator.encode(pair_audio_for_g)
            render_params = [generator.unzipper(processor(*in_vecs)) for processor in generator.post_processors]
        params = [{
            'band': render_params[i]['band'].detach().cpu().numpy().tolist(),    # (1,3,2)
            'fader': render_params[i]['fader'].detach().cpu().numpy().tolist(),  # (1,4,1,2)
        } for i in range(2)]  # [0]=prev(fo 渐出), [1]=next(fi 渐入)
    finally:
        sys.stdout = real_stdout
    print(f"[AutoMix-AI] automation extracted: prev_cue={prev_cue:.1f}s next_cue={next_cue:.1f}s", file=sys.stderr, flush=True)
    return {'success': True, 'params': params, 'sourceTrackKey': plan['sourceTrackKey'], 'targetTrackKey': plan['targetTrackKey']}


def render_ai_transition(plan, source_path, target_path, output_path):
    """跑 DJTransGAN 长混音，返回 {success, outputPath, transitionStart, targetResumeTime, duration, ...}。"""

    generator, torch = load_generator()

    prev_cue = float(plan['sourceEndTime'])
    next_cue = float(plan['targetStartTime'])

    print(f"[AutoMix-AI] render start: prev_cue={prev_cue:.1f}s next_cue={next_cue:.1f}s source={source_path}", file=sys.stderr, flush=True)
    prev_audio = load_track(source_path, torch)
    next_audio = load_track(target_path, torch)

    # DJTransGAN 库内部用 print 打进度（[1/5] ...）到 stdout，会污染 JSON 协议：
    # 库调用期间把 stdout 重定向到 stderr（日志通道），JSON 响应由 main() 在恢复后打印。
    real_stdout = sys.stdout
    sys.stdout = sys.stderr
    try:
        # 模型窗口起点/终点（源曲/目标曲内的绝对时间，由 _preprocess 的 timestamps 给出：
        # timestamps[i] = [start_sample, end_sample]；next 侧为"拉伸后"时间轴）
        plan_beats = {'prev': _plan_beats(plan, 'prev'), 'next': _plan_beats(plan, 'next')}
        (pair_audio, timestamps), (pair_audio_for_g, cue_for_g) = _preprocess(prev_audio, next_audio, prev_cue, next_cue, plan_beats)
        pair_audio_for_g = [t.float() for t in pair_audio_for_g]  # preprocess 部分输出 float64，模型需要 float32
        stretch_ratio = float(plan.get('sourceBpm') or 120.0) / max(1.0, float(plan.get('targetBpm') or 120.0))
        transition_start = timestamps[0][0] / SR      # 源曲内（未拉伸轴）：混音窗口起始
        # 目标曲恢复点：timestamps[1][1] 在"拉伸后"时间轴，必须乘回拉伸比
        # （ratio = prev_bpm/next_bpm，next 被 sync_bpm 拉伸）才是原始时间轴位置，
        # 否则恢复位置错位 → 过渡段与真下一曲"跳转"割裂。
        target_resume = (timestamps[1][1] / SR) * stretch_ratio

        with torch.no_grad():
            mix_audio, _ = generator.infer(*pair_audio_for_g, cue_region=cue_for_g)
    finally:
        sys.stdout = real_stdout

    mix = mix_audio.squeeze(0).numpy()

    # target 长度守卫：混音末尾若被零填充（目标曲太短，窗口被钳制），没有真实 target
    # 内容 → handoff 会静音/跳变，返回失败让前端回退 DSP。
    tail = mix[:, -int(2 * SR):] if mix.ndim > 1 else mix[-int(2 * SR):]
    if float(np.sqrt(np.mean(tail ** 2))) < 1e-4:
        raise RuntimeError('target track too short for the AI mix window; falling back to DSP')

    # 响度衔接：混音末尾（target 主导段）响度向 target 原曲靠拢，减少 handoff 响度跳变
    # （模型输入被 -12 LUFS 归一，与原曲实际响度可能差很多）。
    try:
        import soundfile as _sf
        _info = _sf.info(target_path)
        _resume_sample = int(target_resume * _info.samplerate)
        _start = max(0, _resume_sample - int(2 * _info.samplerate))
        _frames = _resume_sample - _start
        if _frames > int(0.5 * _info.samplerate):
            _seg, _ = _sf.read(target_path, start=_start, frames=_frames, dtype='float32')
            _tgt_rms = float(np.sqrt(np.mean(_seg ** 2)))
            _mix_tail_rms = float(np.sqrt(np.mean(mix[:, -int(2 * SR):] ** 2)))
            if _tgt_rms > 1e-6 and _mix_tail_rms > 1e-6:
                _gain = float(np.clip(_tgt_rms / _mix_tail_rms, 0.6, 1.6))
                mix = mix * _gain
                print(f"[AutoMix-AI] loudness match: gain={_gain:.3f} (tgt_rms={_tgt_rms:.4f} mix_tail_rms={_mix_tail_rms:.4f})", file=sys.stderr, flush=True)
    except Exception as _e:
        print(f"[AutoMix-AI] loudness match skipped: {_e}", file=sys.stderr, flush=True)

    # 混音开头响度向源曲靠拢：automix 介入瞬间（缓冲起点）音量应与源曲一致，
    # 否则每首进入过渡都音量突变（模型输入被 -12 LUFS 归一）。
    try:
        import soundfile as _sf2
        _info2 = _sf2.info(source_path)
        _head_src = int(transition_start * _info2.samplerate)
        _head_len = int(10 * SR)
        _fade_len = int(3 * SR)
        if _head_src >= 0 and _head_src < _info2.frames:
            _seg2, _ = _sf2.read(source_path, start=_head_src, frames=_head_len, dtype='float32')
            _src_rms = float(np.sqrt(np.mean(_seg2 ** 2)))
            _mix_head_rms = float(np.sqrt(np.mean(mix[:, :_head_len] ** 2)))
            if _src_rms > 1e-6 and _mix_head_rms > 1e-6:
                _gain_head = float(np.clip(_src_rms / _mix_head_rms, 0.6, 1.5))
                _g = np.ones(mix.shape[-1], dtype=np.float32)
                _g[:_head_len] = _gain_head
                _g[_head_len:_head_len + _fade_len] = np.linspace(_gain_head, 1.0, _fade_len)
                mix = mix * _g[None, :]
                print(f"[AutoMix-AI] head loudness match: gain={_gain_head:.3f} (src_rms={_src_rms:.4f} mix_head_rms={_mix_head_rms:.4f})", file=sys.stderr, flush=True)
    except Exception as _e2:
        print(f"[AutoMix-AI] head loudness match skipped: {_e2}", file=sys.stderr, flush=True)

    # 峰值归一化（模型输出可能过 0dB），避免播放爆音
    peak = float(np.max(np.abs(mix))) if mix.size else 0.0
    if peak > 0.95:
        mix = mix * (0.95 / peak)

    # v2 编排特效层：AI 长混音同样应用 riser/噪声扫频/鼓点填充/回声（与 DSP 路径一致），
    # 否则 AI 混音只有"前曲渐出 + 后曲渐入"的最基本形态，用户听不到 DJ 效果。
    # 60s 混音无节拍网格信息 → 用合成 0.5s 网格定位包络（riser 收在混音尾部，导向 handoff）。
    try:
        choreography = (plan.get('v2') or {}).get('choreography') or {}
        effects = plan.get('djEffects') or {}
        _intensity = float(INTENSITY_FACTOR.get(choreography.get('intensity', 'standard'), 0.75))
        _ch = int(mix.shape[0])
        _n = int(mix.shape[-1])
        _out_dur = _n / SR
        _beats = [0.5] * max(1, int(_out_dur / 0.5) + 1)
        _ref_rms = float(np.sqrt(np.mean(mix ** 2))) + 1e-9
        _seed = f"{plan['sourceTrackKey']}->{plan['targetTrackKey']}"
        if choreography.get('riser'):
            mix = mix + _create_riser(
                _ch, _n, SR, _beats, _intensity, _ref_rms, _seed,
                end_freq=float(choreography.get('riserEndFreq', 2400)),
            )
        if choreography.get('noiseSweep'):
            mix = mix + _create_sweep_fx(_ch, _n, SR, _beats, _intensity, _ref_rms, _seed)
        # DJ 混音处理（对音乐本身）：滤波扫频——中段低通压暗、尾部高通提亮
        if choreography.get('filterSweep', True):
            mix = _apply_mix_filter_sweep(mix, SR, _beats, _intensity)
        if int(choreography.get('drumFillBeats', 0) or 0) > 0:
            mix = mix + _create_drum_fill(
                _ch, _n, SR, _beats, int(choreography.get('drumFillBeats', 0)),
                _intensity, _ref_rms, _seed,
            )
        if choreography.get('echoOut'):
            mix = mix + _create_echo_out(
                mix, SR, _beats,
                float(effects.get('echoDelayBeats', 0.5)),
                float(np.clip(effects.get('echoFeedback', 0.22), 0.0, 0.55)),
                _intensity,
            )
        _peak2 = float(np.max(np.abs(mix))) if mix.size else 0.0
        if _peak2 > 0.95:
            mix = mix * (0.95 / _peak2)
        print(
            "[AutoMix-AI] v2 choreography effects applied: "
            f"{ {'riser': bool(choreography.get('riser')), 'sweep': bool(choreography.get('noiseSweep')), 'drumFill': int(choreography.get('drumFillBeats', 0) or 0) > 0, 'echoOut': bool(choreography.get('echoOut'))} }",
            file=sys.stderr, flush=True,
        )
    except Exception as _fx:
        print(f"[AutoMix-AI] choreography effects skipped: {_fx}", file=sys.stderr, flush=True)

    if not np.all(np.isfinite(mix)):
        raise ValueError('DJTransGAN produced non-finite audio')
    import soundfile
    temp_output = f"{output_path}.{os.getpid()}.{uuid.uuid4().hex}.tmp.wav"
    try:
        soundfile.write(temp_output, mix.T, SR)
        if os.path.getsize(temp_output) <= 44:
            raise ValueError('DJTransGAN output WAV is empty')
        os.replace(temp_output, output_path)
    finally:
        if os.path.exists(temp_output):
            os.remove(temp_output)

    print(f"[AutoMix-AI] render ok: duration={float(mix.shape[-1]) / SR:.1f}s transitionStart={float(transition_start):.1f}s targetResume={float(target_resume):.1f}s", file=sys.stderr, flush=True)

    return {
        'success': True,
        'outputPath': output_path,
        'duration': float(mix.shape[-1]) / SR,
        'transitionStart': float(transition_start),
        'targetResumeTime': float(target_resume),
        'sampleRate': SR,
        'channels': int(mix.shape[0]) if mix.ndim > 1 else 1,
        'stretchApplied': True,
        'djEffectsApplied': True,
        'rendererVersion': 'djtransgan-v1',
        'aiMixApplied': True,
        # 混音尾段 target 内容相对原曲的播放速度比（sync_bpm 重采样比）：
        # >1 = 混音尾比原曲快（source 比 target 快），<1 = 慢。
        # 前端据此计算 overlap handoff 窗口，用渐入 deck 掩蔽 handoff 速度台阶。
        'mixSpeedRatio': float(stretch_ratio),
    }


def probe():
    """探测 AI 引擎是否可用（torch + 权重 + 仓库可导入）。"""
    try:
        import torch  # noqa: F401
        has_torch = True
    except Exception:
        has_torch = False
    weight_ok = os.path.exists(os.path.join(REPO_DIR, 'pretrained', 'djtransgan_minmax.pt'))
    repo_ok = os.path.exists(os.path.join(REPO_DIR, 'djtransgan', 'model', '__init__.py'))
    return {
        'available': bool(has_torch and weight_ok and repo_ok),
        'hasTorch': has_torch,
        'weightReady': weight_ok,
        'repoReady': repo_ok,
        'repoDir': REPO_DIR,
        'python': sys.executable,
    }


def main():
    print(json.dumps({'type': 'status', 'data': {'ready': True, 'engine': 'djtransgan'}}), flush=True)
    for line in sys.stdin:
        try:
            request = json.loads(line.strip())
            message_type = request.get('type')
            message_id = request.get('id')
            if message_type == 'render':
                params = request['params']
                try:
                    result = render_ai_transition(
                        params['plan'],
                        params['sourceAudioPath'],
                        params['targetAudioPath'],
                        params['outputPath'],
                    )
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    result = {'success': False, 'error': str(e)}
                response = {'type': 'result', 'id': message_id, 'data': result}
            elif message_type == 'automation':
                params = request['params']
                try:
                    result = extract_automation(
                        params['plan'],
                        params['sourceAudioPath'],
                        params['targetAudioPath'],
                    )
                except Exception as e:
                    import traceback
                    traceback.print_exc()
                    result = {'success': False, 'error': str(e)}
                response = {'type': 'result', 'id': message_id, 'data': result}
            elif message_type == 'probe':
                response = {'type': 'result', 'id': message_id, 'data': probe()}
            elif message_type == 'exit':
                break
            else:
                response = {'type': 'error', 'id': message_id, 'error': f'Unknown message type: {message_type}'}
            print(json.dumps(response), flush=True)
        except json.JSONDecodeError:
            print(json.dumps({'type': 'error', 'error': 'Invalid JSON'}), flush=True)
        except Exception as e:
            print(json.dumps({'type': 'error', 'error': str(e)}), flush=True)


if __name__ == '__main__':
    main()
