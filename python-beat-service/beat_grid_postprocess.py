# python-beat-service/beat_grid_postprocess.py
# 智能动感拍点后处理：纯 Python 的节奏连续性网格拟合（无 madmom 依赖）。
#
# 背景：beat-this 的 minimal 后处理只做 ±70ms 峰值选取 + 概率 >0.5 阈值——
# 没有节奏连续性约束。两个后果：
#   1) 漏检：某一拍概率刚好 <0.5 → 该拍永久丢失（网格缺一拍，下游动画"突然慢半拍"）；
#   2) 假峰：一个 >0.5 的杂音峰直接进网格（"凭空多一拍"）。
# madmom 的 DBN 用 BPM 先验修复这两点，但它需要 Cython/MSVC 编译（嵌入式 runtime 无法安装）。
#
# 这里的轻量实现（三步）：
#   1) 从 minimal 峰值序列的**相邻间隔直方图**估计主拍周期（interval histogram，
#      madmom/Beat This 论文同款的第一步）；
#   2) 全局相位拟合：把周期网格放到使 Σ beat_p[frame] 最大的相位上；
#   3) 网格重建：按周期+相位重建整条拍序列——模型漏检的拍自动补上，
#      不在网格上的假峰自动剔除；强拍 = 网格位置中 down_p 显著高于 beat_p 的每第 4 拍。
# 复杂度 O(T + N log N)，一首歌 <50ms。

from __future__ import annotations

import numpy as np

FPS = 50  # beat-this 帧率
MIN_BPM = 55.0
MAX_BPM = 215.0
TOLERANCE_MS = 90  # 峰归入网格的容差
DOWNBEAT_EVERY = 4  # 每小节拍数（WaveForge 场景固定 4/4）


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-np.asarray(x, dtype=np.float64)))


def _peaks_from_logits(logits: np.ndarray) -> np.ndarray:
    """minimal 同款峰值选取：±70ms（±3 帧）窗口内的最大值且 logit >0 → 帧号数组。
    numpy max-pool 等价实现（torch.max_pool1d kernel=7 stride=1 pad=3 的语义）。"""
    x = logits.astype(np.float64)
    n = len(x)
    padded = np.full(n + 6, -1000.0)
    padded[3:3 + n] = x
    # 窗口最大值：padded[i+3] 的 ±3 邻域
    window_max = np.full(n, -1000.0)
    for offset in range(-3, 4):
        window_max = np.maximum(window_max, padded[3 + offset:3 + offset + n])
    is_peak = (x == window_max) & (x > 0)
    frames = np.where(is_peak)[0].astype(np.int64)
    # 去相邻峰（width=1）
    if len(frames) == 0:
        return frames
    keep = [frames[0]]
    for f in frames[1:]:
        if f - keep[-1] > 1:
            keep.append(f)
    return np.array(keep, dtype=np.int64)


def _estimate_period(peak_frames: np.ndarray, fps: int) -> tuple[float, float] | None:
    """相邻间隔直方图 → 主周期（帧）与得分。间隔 >2s 视为漏拍段跳过。"""
    if len(peak_frames) < 4:
        return None
    intervals = np.diff(peak_frames) / fps  # 秒
    intervals = intervals[(intervals >= 60.0 / MAX_BPM) & (intervals <= 60.0 / MIN_BPM)]
    if len(intervals) < 3:
        return None
    # 中位数估计（对离群间隔鲁棒）：±15% 内的间隔均值精修
    median = float(np.median(intervals))
    near = intervals[np.abs(intervals - median) <= median * 0.15]
    period = float(np.mean(near)) if len(near) else median
    score = len(near) / len(intervals)
    return period, score


def _best_phase(peak_frames: np.ndarray, beat_p: np.ndarray, period_frames: float, fps: int) -> float:
    """在 [0, period_frames) 上扫描相位，选 Σ beat_p[网格帧] 最大的相位。"""
    best_phase = 0.0
    best_score = -1.0
    steps = 64
    for s in range(steps):
        phase = period_frames * s / steps
        frames = np.arange(phase, len(beat_p), period_frames).astype(np.int64)
        frames = frames[(frames >= 0) & (frames < len(beat_p))]
        if len(frames) == 0:
            continue
        score = float(np.sum(beat_p[frames]))
        if score > best_score:
            best_score = score
            best_phase = phase
    return best_phase


def fit_beat_grid(
    beat_logits: np.ndarray,
    downbeat_logits: np.ndarray,
    fps: int = FPS,
) -> tuple[np.ndarray, np.ndarray]:
    """节奏连续性网格拟合。见模块注释。

    Returns:
        (beat_times, downbeat_times) 秒。比 minimal 输出更平滑：
        漏检补上、不在网格上的假峰剔除。
    """
    beat_p = _sigmoid(beat_logits.astype(np.float64))
    down_p = _sigmoid(downbeat_logits.astype(np.float64))
    n_frames = len(beat_p)
    if n_frames < 16:
        return np.array([]), np.array([])

    peak_frames = _peaks_from_logits(beat_logits)
    if len(peak_frames) < 4:
        return np.array([]), np.array([])

    estimated = _estimate_period(peak_frames, fps)
    if estimated is None:
        return np.array([]), np.array([])
    # _estimate_period 返回秒，换算成帧
    period_frames = estimated[0] * fps
    confidence = estimated[1]

    # 周期合理性钳制（直方图主峰可能在 2x/3x 谐波上）：
    # 网格拍数与峰值数的比在 0.8..4.8 之外说明周期错了，向峰值间隔中位数折半/翻倍修正
    span_frames = peak_frames[-1] - peak_frames[0]
    expected_grid = span_frames / period_frames
    ratio = expected_grid / max(1, len(peak_frames))
    if ratio > 2.4:  # 周期估大了（网格太稀）：折半直到接近
        while ratio > 2.4 and period_frames > 60.0 / MAX_BPM * fps:
            period_frames /= 2
            ratio /= 2
    elif ratio < 0.55:  # 周期估小了（网格太密）：翻倍
        while ratio < 0.55 and period_frames < 60.0 / MIN_BPM * fps:
            period_frames *= 2
            ratio *= 2

    phase = _best_phase(peak_frames, beat_p, period_frames, fps)

    # 网格重建：整条拍序列（补漏检 + 剔假峰）
    first = float(peak_frames[0])
    # 相位对齐：网格相位锚定在 first 之前最近的相位位置（避免 while 浮点漂移）
    phase = first - ((first - phase) % period_frames)
    beat_frames = np.arange(phase, n_frames, period_frames).astype(np.int64)
    beat_frames = beat_frames[(beat_frames >= 0) & (beat_frames < n_frames)]

    # 峰归入网格：每个模型峰吸附到最近网格帧（±TOLERANCE_MS 内）；
    # 有峰吸附的网格帧 = "确认拍"；无峰吸附但在高概率区的 = "补漏拍"。
    confirmed = np.zeros(len(beat_frames), dtype=bool)
    tol = TOLERANCE_MS / 1000.0 * fps
    for pf in peak_frames:
        idx = int(np.argmin(np.abs(beat_frames - pf)))
        if abs(beat_frames[idx] - pf) <= tol:
            confirmed[idx] = True

    # 置信段：峰值覆盖范围内的拍才可靠（范围外是尾部静默，不强补）
    in_range = (beat_frames >= peak_frames[0] - tol) & (beat_frames <= peak_frames[-1] + tol)
    keep = confirmed | in_range
    kept_frames = beat_frames[keep]

    beat_times = kept_frames / fps

    # 强拍：每 DOWNBEAT_EVERY 个拍取一个，从"down_p 相对 beat_p 最突出"的网格帧对齐相位
    downbeat_times: list[float] = []
    if len(kept_frames) >= DOWNBEAT_EVERY:
        best_offset = 0
        best_score = -1.0
        for offset in range(DOWNBEAT_EVERY):
            frames = kept_frames[offset::DOWNBEAT_EVERY]
            frames = frames[frames < n_frames]
            if len(frames) == 0:
                continue
            score = float(np.sum(down_p[frames]) - 0.5 * np.sum(beat_p[frames]))
            if score > best_score:
                best_score = score
                best_offset = offset
        downbeat_times = (kept_frames[best_offset::DOWNBEAT_EVERY] / fps).tolist()

    return beat_times, np.array(downbeat_times, dtype=float)
