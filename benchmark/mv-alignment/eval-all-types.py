# -*- coding: utf-8 -*-
"""全类型(5681 对)对齐评测:FFT 加速全范围互相关 + 分段投票 + 三角真值 + 分层指标
产出:all-type-eval-results.json(逐对)+ 分层汇总(按 declared type)"""
import json, math, statistics, sys, io, time, os
import numpy as np
from scipy.signal import fftconvolve
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = r'D:\opencode\WaveForge\.tmp-kg-align'
sg = json.load(open(ROOT + r'\song-envs.json', encoding='utf-8'))
pairs = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'all-type-eval-set.json'), encoding='utf-8'))

envs = {}
with open(ROOT + r'\mv-envs-new.jsonl', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try:
            o = json.loads(line)
            if o.get('bvid'): envs[o['bvid']] = o
        except: pass

def decimate(env, step):
    if step == 1: return np.asarray(env, dtype=np.float64)
    n = len(env) // step
    return np.asarray(env[:n*step], dtype=np.float64).reshape(n, step).mean(axis=1)

def norm(a):
    a = a - a.mean()
    s = np.sqrt((a*a).sum())
    return a / s if s > 1e-12 else a

def fft_best_offset(mv10, s10, max_abs=90):
    """FFT 互相关:offset ∈ [-45, +90],返回 (offset, peak)。
    corr(f) = Σ s[i]·m[i+f];用 fftconvolve(m, s[::-1]) 一次算全 lag。"""
    max_f = min(max_abs * 10, len(mv10) - 64)
    # 有效重叠 ≥64 帧(6.4s)
    corr = fftconvolve(mv10, s10[::-1], mode='full')
    # lag = f 对应 index len(s10)-1+f
    base = len(s10) - 1
    lo, hi = base - 450, base + max_f
    lo = max(lo, len(s10) - 1)  # f≥-450 且重叠足够:允许负 lag 但裁掉重叠不足区
    seg = corr[lo:hi+1]
    if len(seg) == 0: return 0.0, -1.0
    idx = int(np.argmax(seg))
    return (lo + idx - base) / 10.0, float(seg[idx])

def fft_corr_at(mv10, s10, f):
    """指定整数 lag 的归一化皮尔逊(FFT 峰未归一,需要时逐点算)"""
    if f >= 0: a, b = s10, mv10[f:]
    else: a, b = s10[-f:], mv10
    return pearson(a, b)

def pearson(a, b):
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    if n < 64: return -1.0
    am, bm = a.mean(), b.mean()
    num = ((a-am)*(b-bm)).sum()
    da = ((a-am)**2).sum(); db = ((b-bm)**2).sum()
    return num / math.sqrt(da*db) if da*db > 0 else -1.0

def seg_scan_local(mv10, s10, center_f, drift=50):
    """段投票(±5s 邻域,无先验时给 None 全范围)—用于投票/锚点/支持率"""
    seg = 300
    out = []
    for st in range(0, len(s10) - seg + 150, 150):
        cs = min(st, len(s10) - seg)
        if center_f is not None:
            lo, hi = center_f - drift, center_f + drift
        else:
            lo, hi = -450, min(900, len(mv10) - 64)
        bestD, bestR = (center_f if center_f is not None else 0), -1
        for d in range(lo, hi + 1, 5):
            b = cs + d
            if b < 0 or b + seg > len(mv10): continue
            r = pearson(s10[cs:cs+seg], mv10[b:b+seg])
            if r > bestR: bestR, bestD = r, d
        for d in range(-5, 6):
            b = cs + bestD + d
            if b < 0 or b + seg > len(mv10): continue
            r = pearson(s10[cs:cs+seg], mv10[b:b+seg])
            if r > bestR: bestR, bestD = r, bestD + d
        out.append(((cs + seg/2)/10, bestD/10, bestR))
    return out

def cluster(votes, min_r, tol=2.5):
    cs = []
    for t, off, r in votes:
        if r < min_r: continue
        for c in cs:
            if abs(off - c['off']) <= tol:
                c['items'].append((t, off, r)); c['off'] = statistics.median([o for _, o, _ in c['items']]); break
        else:
            cs.append({'off': off, 'items': [(t, off, r)]})
    for c in cs: c['w'] = sum(r for _, _, r in c['items'])
    cs.sort(key=lambda c: -c['w'])
    return cs

def truth_label(peak_off, peak, vote_off, support):
    evidences = []
    if peak >= 0.55: evidences.append(('peak', peak_off))
    if vote_off is not None: evidences.append(('vote', vote_off))
    if support >= 0.5: evidences.append(('support', peak_off))
    if not evidences: return None, 0
    best = None
    for i, (n1, v1) in enumerate(evidences):
        agree = [n1] + [n2 for n2, v2 in evidences[i+1:] if abs(v1 - v2) <= 3]
        if best is None or len(agree) > len(best[0]):
            best = (agree, statistics.median([v for n, v in evidences if n in agree]))
    return best[1], len(best[0])

t0 = time.time()
results = []
for idx, p in enumerate(pairs):
    mvv = envs.get(p['bvid']); song = sg.get(p['songKey'])
    if not mvv or not song: continue
    mv10, s10 = decimate(mvv['env'], 5), decimate(song['env'], 5)
    if len(mv10) < 640 or len(s10) < 640: continue
    # 全曲峰(FFT,粗定位)→ 精确归一峰
    off_f, _ = fft_best_offset(mv10, s10)
    bestF = round(off_f * 10)
    bestS = fft_corr_at(mv10, s10, bestF)
    # 突出度:±2s 外次峰(FFT 曲线上取,无需重算全曲)
    max_f = min(900, len(mv10) - 64)
    runner = -1.0
    for f in list(range(-450, max(0, bestF - 20), 5)) + list(range(bestF + 20, max_f + 1, 5)):
        if f < -450 or f > max_f: continue
        r = fft_corr_at(mv10, s10, f)
        if r > runner: runner = r
    # 段投票(以峰为先验 ±5s)
    votes = seg_scan_local(mv10, s10, bestF)
    strong = cluster(votes, min_r=0.7)
    vote_off = strong[0]['off'] if strong and (len(strong[0]['items']) >= 2 or strong[0]['w'] >= 3) else None
    # 支持率 @峰
    seg = 300; delta = bestF
    rs = []
    for st in range(0, len(s10) - seg, seg):
        b = st + delta
        if b < 0 or b + seg > len(mv10): continue
        r = pearson(s10[st:st+seg], mv10[b:b+seg])
        if r >= 0: rs.append(r)
    ratio = sum(1 for r in rs if r > 0.4) / len(rs) if len(rs) >= 3 else 0.0
    ref, conf = truth_label(bestF/10, bestS, vote_off, ratio)
    results.append({
        'songKey': p['songKey'], 'songName': p['songName'], 'bvid': p['bvid'],
        'title': p['title'], 'type': p['type'],
        'peakOff': bestF/10, 'peak': round(bestS, 4), 'prom': round(bestS - runner, 4),
        'voteOff': vote_off, 'support': round(ratio, 4), 'ref': ref, 'refConf': conf,
    })
    if (idx + 1) % 500 == 0:
        print(f"  进度 {idx+1}/{len(pairs)}  {time.time()-t0:.0f}s", flush=True)

json.dump(results, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'all-type-eval-results.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(f"完成 {len(results)} 对,耗时 {time.time()-t0:.0f}s → all-type-eval-results.json")
