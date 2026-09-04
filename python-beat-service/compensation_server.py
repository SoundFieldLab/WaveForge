"""
Frequency Response Compensation Service - 独立频响补偿设计服务（端口 3004）

方法论（依据《频响补偿081401.md》《频响补偿081402.md》）：
- 理论：等响曲线（ISO 226 / Fletcher-Munson）——低音量时人耳对低频/高频不敏感，需预提升
- 补偿公式（081402 §4.2）：
    G(f) = clamp(EQ_target(f, L_ref) - EQ_target(f, L_cur), 0, G_max)
    只提升不衰减；工程上低频上限 6-12dB、高频上限 2-6dB，中频保持 0dB 参考（避免中频凹陷）
- 滤波器（081402 §4.3）：低频 1 个 LowShelf + 高频 1 个 HighShelf + 中频温和 PEQ 微调，
  用 shelf 结构而非"每控制点一个全增益 peaking"，避免级联 dB 相加导致过冲
- 音量→SPL 映射（081402 附录 estimate_spl 思路）：音量百分比映射到 40-100dB SPL，
  补偿量随 (L_ref - L_cur) 线性，低频系数 0.35、高频系数 0.15（约 2:1，符合参考参数表）
- 与 beat_analyzer.py（3002）、loudness_server.py（3003）完全解耦

请求：POST /compensation
  { "mode": "auto"|"preset"|"custom", "volume": 0-100, "preset": id, "bands": [...] }
响应：{ "segments": [{"type":"lowshelf"|"peaking"|"highshelf","frequency":Hz,"q":,"gain":dB}], "label": str }
"""

import os
import sys
import math
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from flask import Flask, request, jsonify
from flask_cors import CORS
from local_service_auth import is_authorized_local_request
import numpy as np

if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')

PORT = int(os.environ.get('WAVEFORGE_COMPENSATION_PORT', '3004'))

app = Flask(__name__)
CORS(app, origins=["http://localhost:3000", "http://127.0.0.1:3000", "file://", "null"], allow_headers=["Content-Type", "X-WaveForge-Local-Token"])


@app.before_request
def require_local_service_token():
    if not is_authorized_local_request(request.headers.get('X-WaveForge-Local-Token', '')):
        return jsonify({'error': 'unauthorized'}), 403
    return None

# ============ 补偿强度参数（工程参考，081402 §6.1） ============
# 参考 SPL：80 dB（高音量，补偿 0）
REF_SPL_DB = 80.0
# 音量百分比 → SPL：v=100→80dB、v=50→65dB、v=20→56dB、v=0→50dB
MIN_SPL_DB = 50.0
# 每 1dB SPL 差值的补偿增益系数（低频约 2 倍于高频，参考表 70dB→+3/+1.5、60dB→+6/+3、50dB→+10/+5）
LOW_GAIN_PER_DB = 0.35
HIGH_GAIN_PER_DB = 0.15
# 增益上限（防过量提升导致削波/失真）
MAX_LOW_GAIN_DB = 12.0
MAX_HIGH_GAIN_DB = 6.0
# 中频微调增益上限（避免中频凹陷/突兀）
MAX_MID_GAIN_DB = 3.0

# ============ 滤波器默认参数（081402 §4.3） ============
LOW_SHELF_FREQ = 120.0   # 100-150Hz 推荐区间
LOW_SHELF_Q = 0.707
# 高频 shelf 用 12kHz（而非 10kHz）：实测 10kHz shelf 过渡带太宽，在 1kHz 残留 +5dB
# 污染中频；12kHz Q0.707 在 1kHz 残留 0.00、8kHz 仅 0.63，高频端 16kHz 达满值
HIGH_SHELF_FREQ = 12000.0  # 8-12kHz 推荐区间上限
HIGH_SHELF_Q = 0.707


def volume_to_spl(volume: float) -> float:
    """音量百分比 → 估计回放 SPL（dB）。100% ≈ 80dB，0% ≈ 50dB（线性映射）。"""
    v = float(np.clip(volume, 0.0, 100.0))
    return MIN_SPL_DB + (REF_SPL_DB - MIN_SPL_DB) * (v / 100.0)


def design_equal_loudness(volume: float) -> list:
    """等响度补偿（auto 模式）：
    G(f) = clamp(EQ_target(f, L_ref) - EQ_target(f, L_cur), 0, G_max)
    实现为两段 shelf：低频 LowShelf + 高频 HighShelf，中频 0dB 保持。
    """
    spl = volume_to_spl(volume)
    deficit = REF_SPL_DB - spl  # 低音量亏欠量（0 → 20dB）
    low_gain = round(float(np.clip(deficit * LOW_GAIN_PER_DB, 0.0, MAX_LOW_GAIN_DB)), 2)
    high_gain = round(float(np.clip(deficit * HIGH_GAIN_PER_DB, 0.0, MAX_HIGH_GAIN_DB)), 2)

    segments = []
    if low_gain >= 0.5:
        segments.append({'type': 'lowshelf', 'frequency': LOW_SHELF_FREQ, 'q': LOW_SHELF_Q, 'gain': low_gain})
    if high_gain >= 0.5:
        segments.append({'type': 'highshelf', 'frequency': HIGH_SHELF_FREQ, 'q': HIGH_SHELF_Q, 'gain': high_gain})
    return segments


# ============ 场景化预设（低频 shelf + 高频 shelf + 温和中频 PEQ，不级联叠加） ============
PRESET_CURVES = {
    'flat': {
        'label': '监听平直',
        'low': {'frequency': 120.0, 'gain': 0.0},
        'high': {'frequency': 12000.0, 'gain': 0.0},
        'mid': [],  # 中频微调 PEQ（增益 ≤ ±3dB，避免级联过冲）
    },
    'bass': {
        'label': '低频补偿',
        'low': {'frequency': 120.0, 'gain': 8.0},
        'high': {'frequency': 12000.0, 'gain': 0.0},
        'mid': [{'frequency': 400.0, 'gain': -1.5, 'q': 1.0}],  # 轻微削中低频过渡，防凹陷
    },
    'vocal': {
        'label': '人声突出',
        'low': {'frequency': 120.0, 'gain': 0.0},
        'high': {'frequency': 12000.0, 'gain': 1.5},
        'mid': [
            {'frequency': 1000.0, 'gain': 1.5, 'q': 1.0},
            {'frequency': 4000.0, 'gain': 2.5, 'q': 1.2},
        ],
    },
    'warm': {
        'label': '温暖',
        'low': {'frequency': 120.0, 'gain': 4.0},
        'high': {'frequency': 12000.0, 'gain': -1.0},
        'mid': [{'frequency': 250.0, 'gain': 1.5, 'q': 1.0}],
    },
    'bright': {
        'label': '通透',
        'low': {'frequency': 120.0, 'gain': 0.0},
        'high': {'frequency': 12000.0, 'gain': 3.0},
        'mid': [
            {'frequency': 2000.0, 'gain': 1.0, 'q': 1.0},
            {'frequency': 6000.0, 'gain': 1.5, 'q': 1.0},
        ],
    },
    'night': {
        'label': '夜间温和',
        'low': {'frequency': 120.0, 'gain': 3.0},
        'high': {'frequency': 12000.0, 'gain': 1.0},
        'mid': [],
    },
}


def preset_segments(preset: str) -> tuple:
    curve = PRESET_CURVES.get(preset)
    if not curve:
        return None, f'Unknown preset: {preset}. Available: {", ".join(PRESET_CURVES)}'
    segments = []
    if abs(curve['low']['gain']) >= 0.5:
        segments.append({'type': 'lowshelf', 'frequency': curve['low']['frequency'], 'q': 0.707, 'gain': round(float(np.clip(curve['low']['gain'], -MAX_LOW_GAIN_DB, MAX_LOW_GAIN_DB)), 2)})
    for mid in curve['mid']:
        g = round(float(np.clip(mid['gain'], -MAX_MID_GAIN_DB, MAX_MID_GAIN_DB)), 2)
        if abs(g) >= 0.5:
            segments.append({'type': 'peaking', 'frequency': float(mid['frequency']), 'q': float(mid.get('q', 1.0)), 'gain': g})
    if abs(curve['high']['gain']) >= 0.5:
        segments.append({'type': 'highshelf', 'frequency': curve['high']['frequency'], 'q': 0.6, 'gain': round(float(np.clip(curve['high']['gain'], -MAX_HIGH_GAIN_DB, MAX_HIGH_GAIN_DB)), 2)})
    return segments, None


def custom_segments(bands: list) -> tuple:
    """自定义频段：5 个独立 peaking（频率间隔大，级联过冲可控），增益 ±8dB。"""
    freqs, gains = [], []
    for band in bands:
        f = float(band.get('frequency', 0))
        g = float(band.get('gain', 0))
        if not (30.0 <= f <= 16000.0) or not math.isfinite(g):
            return None, f'Invalid band: {band}'
        freqs.append(f)
        gains.append(float(np.clip(g, -8.0, 8.0)))
    segments = []
    for f, g in zip(freqs, gains):
        if abs(g) >= 0.5:
            segments.append({'type': 'peaking', 'frequency': float(f), 'q': 1.2, 'gain': round(g, 2)})
    return segments, None


@app.route('/health', methods=['GET'])
def health():
    return jsonify({'status': 'ok', 'service': 'compensation', 'port': PORT})


@app.route('/compensation', methods=['POST'])
def design_compensation():
    data = request.get_json(silent=True) or {}
    mode = str(data.get('mode') or 'auto').strip()
    try:
        if mode == 'preset':
            preset = str(data.get('preset') or 'flat').strip()
            segments, err = preset_segments(preset)
            if err:
                return jsonify({'error': err}), 400
            return jsonify({'segments': segments, 'label': PRESET_CURVES[preset]['label'], 'mode': mode, 'preset': preset})

        if mode == 'custom':
            bands = data.get('bands')
            if not isinstance(bands, list) or not bands:
                return jsonify({'error': 'custom mode requires non-empty bands array'}), 400
            segments, err = custom_segments(bands)
            if err:
                return jsonify({'error': err}), 400
            return jsonify({'segments': segments, 'label': '自定义', 'mode': mode})

        # auto：等响度补偿（默认）
        volume = data.get('volume')
        try:
            volume = float(volume) if volume is not None else 100.0
        except (TypeError, ValueError):
            volume = 100.0
        spl = volume_to_spl(volume)
        segments = design_equal_loudness(volume)
        return jsonify({'segments': segments, 'label': f'等响度补偿（音量 {volume:.0f}%）', 'mode': 'auto', 'volume': volume, 'estimatedSpl': round(spl, 1)})

    except Exception as e:
        print(f"[ERROR] 补偿设计失败: {e}")
        return jsonify({'error': str(e)}), 500


if __name__ == '__main__':
    print(f"🎛️ Compensation service starting on http://127.0.0.1:{PORT}")
    app.run(host='127.0.0.1', port=PORT, debug=False, threaded=True)
