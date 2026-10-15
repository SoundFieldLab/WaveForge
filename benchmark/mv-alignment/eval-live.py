# -*- coding: utf-8 -*-
"""
Live/现场版对齐评测器(离线,无 app 依赖)
数据:mv-envs.json(5671 MV 包络) × song-envs.json(2193 歌曲包络),生产口径 22050Hz 50fps
链路:envelopeOffsetOf(-45..+90 非对称) → envelopeSegmentSupport(10fps 口径) → envelopeSegmentAnchors
真值:参考锚点段(强相关连续段的中位偏移),标定语义与 .tmp-kg-align 历史评测一致
输出:分层指标(采纳率/误差/拒绝正确率) + 阈值扫描
"""
import json, re, math, collections, statistics, sys, io
import numpy as np

def load_mv_jsonl(jsonl_path):
    envs = {}
    with open(jsonl_path, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
                if o.get('bvid'):
                    envs[o['bvid']] = o
            except Exception:
                pass
    return envs
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import os
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, '..', '..', '.tmp-kg-align'))
ROOT = DATA
mv = load_mv_jsonl(os.path.join(ROOT, 'mv-envs-new.jsonl'))


sg = json.load(open(ROOT + r'\song-envs.json', encoding='utf-8'))
cand = json.load(open(ROOT + r'\candidates.json', encoding='utf-8'))
live_set = json.load(open(os.path.join(HERE, 'live-eval-set.json') if os.path.exists(os.path.join(HERE, 'live-eval-set.json')) else os.path.join(ROOT, 'live-eval-set.json'), encoding='utf-8'))

by_bvid = {v.get('bvid'): v for v in mv.values()}
by_songkey = {k: sg[k] for k in sg}

# ---- 生产口径原语(与 autoMixAnalysisService.ts 一致) ----
def decimate(env, step):
    if step == 1: return env
    n = len(env) // step
    out = []
    for i in range(n):
        base = i * step
        out.append(sum(env[base:base+step]) / step)
    return out

def pearson(a, b):
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    if n < 64: return -1
    am, bm = a.mean(), b.mean()
    num = ((a-am)*(b-bm)).sum()
    da = ((a-am)**2).sum(); db = ((b-bm)**2).sum()
    return num / math.sqrt(da*db) if da*db > 0 else -1

def envelope_offset_of(mv_env, song_env, fps=50):
    """-45..+90 非对称搜索 + 10fps 盒平均 + ±0.1s 原始帧率精化"""
    s10 = np.array(decimate(song_env, 5)); m10 = np.array(decimate(mv_env, 5))
    minF, maxF = -450, min(900, len(m10) - 64)
    bestF, bestS = 0, -1
    for f in range(minF, maxF + 1):
        if f >= 0: a, b = s10, m10[f:]
        else: a, b = s10[-f:], m10
        r = pearson(a, b)
        if r > bestS: bestS, bestF = r, f
    # prominence: ±2s(20帧) 外次峰
    runner = -1
    for f in range(minF, maxF + 1):
        if abs(f - bestF) <= 20: continue
        if f >= 0: a, b = s10, m10[f:]
        else: a, b = s10[-f:], m10
        r = pearson(a, b)
        if r > runner: runner = r
    # 精化:原始帧率 ±0.1s(±5 帧@50fps)
    s50 = np.array(song_env); m50 = np.array(mv_env)
    baseF = bestF * 5
    refinedF, refinedS = baseF, pearson50(s50, m50, baseF)
    for d in range(-5, 6):
        r = pearson50(s50, m50, baseF + d)
        if r > refinedS: refinedS, refinedF = r, baseF + d
    return refinedF / fps, max(bestS, refinedS), bestS - runner

def pearson50(a, b, delta):
    if delta >= 0: a2, b2 = a, b[delta:]
    else: a2, b2 = a[-delta:], b
    return pearson(a2, b2)

def segment_support(mv_env, song_env, offset, fps=50):
    """10fps 盒平均口径(与生产 envelopeSegmentSupport 一致)"""
    m = np.array(decimate(mv_env, 5)); s = np.array(decimate(song_env, 5))
    seg = 300
    delta = round(offset * 10)
    rs = []
    for st in range(0, len(s) - seg, seg):
        b = st + delta
        if b < 0 or b + seg > len(m): continue
        r = pearson(s[st:st+seg], m[b:b+seg])
        if r >= 0: rs.append(r)
    if len(rs) < 3: return 0.0, len(rs)
    return sum(1 for r in rs if r > 0.4) / len(rs), len(rs)

def segment_anchors(mv_env, song_env, global_offset, fps=50):
    """10fps 口径锚点提取(±5s 粗扫 0.5s + 精化 0.1s;跳变/间距防护)"""
    m = np.array(decimate(mv_env, 5)); s = np.array(decimate(song_env, 5))
    seg = 300; delta0 = round(global_offset * 10)
    out = []
    for st in range(0, len(s) - seg + 150, 150):
        cs = min(st, len(s) - seg)
        if cs + delta0 < 0 or cs + delta0 + seg > len(m): continue
        bestD, bestR = delta0, pearson(s[cs:cs+seg], m[cs+delta0:cs+delta0+seg])
        for d in range(-50, 51, 5):
            r = pearson(s[cs:cs+seg], m[cs+delta0+d:cs+delta0+d+seg])
            if r > bestR: bestR, bestD = r, delta0 + d
        for d in range(-5, 6):
            r = pearson(s[cs:cs+seg], m[cs+bestD+d:cs+bestD+d+seg])
            if r > bestR: bestR, bestD = r, bestD + d
        if bestR < 0.5: continue
        songTime = (cs + seg / 2) / 10
        offS = bestD / 10
        prev = out[-1] if out else None
        if prev and abs(offS - prev[1]) > 10: continue
        if prev and songTime - prev[0] < 20 and abs(offS - prev[1]) < 1: continue
        out.append((songTime, offS, bestR))
    return out

# ---- 评测 ----
rows = []
for p in live_set:
    mvv = by_bvid.get(p['bvid']); song = by_songkey.get(p['songKey'])
    if not mvv or not song: continue
    mv_env, song_env = mvv['env'], song['env']
    if len(mv_env) < 640 or len(song_env) < 640: continue
    offset, peak, prom = envelope_offset_of(mv_env, song_env)
    ratio, nseg = segment_support(mv_env, song_env, offset)
    anchors = segment_anchors(mv_env, song_env, offset)
    strong_anchors = [a for a in anchors if a[2] >= 0.7]
    # 参考真值:强锚(≥0.7)中位偏移;无强锚时用全曲峰(仅峰≥0.6 才算可信参考)
    if strong_anchors:
        ref = statistics.median([a[1] for a in strong_anchors])
        ref_src = 'strong-anchor'
        ref_conf = 'high'
    elif peak >= 0.7:
        ref = offset; ref_src = 'global-peak'; ref_conf = 'mid'
    else:
        ref = None; ref_src = 'none'; ref_conf = 'none'
    accepted = (peak >= 0.6 and prom >= 0.05) or (ratio >= 0.35)
    rows.append({
        'song': p['songName'], 'artist': p['artist'], 'bvid': p['bvid'], 'title': p['title'],
        'offset': offset, 'peak': peak, 'prom': prom, 'support': ratio, 'segs': nseg,
        'anchors': len(anchors), 'strongAnchors': len(strong_anchors),
        'anchorSpread': (max(a[1] for a in anchors) - min(a[1] for a in anchors)) if len(anchors) >= 2 else 0,
        'accepted': bool(accepted), 'ref': ref, 'refSrc': ref_src, 'refConf': ref_conf,
        'err': abs(offset - ref) if ref is not None else None,
    })

json.dump(rows, open(ROOT + r'\live-eval-results.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1)

# ---- 汇总 ----
print(f"评测对数: {len(rows)}")
acc = [r for r in rows if r['accepted']]
rej = [r for r in rows if not r['accepted']]
print(f"采纳: {len(acc)}  拒绝: {len(rej)}")

print("\n== 采纳对的参考误差(参考源分布) ==")
by_src = collections.Counter(r['refSrc'] for r in acc)
print('参考源:', dict(by_src))
for src in ('strong-anchor', 'global-peak'):
    grp = [r for r in acc if r['refSrc'] == src and r['err'] is not None]
    if grp:
        errs = [r['err'] for r in grp]
        print(f"  {src}: n={len(grp)}  ≤1s {sum(1 for e in errs if e<=1)/len(grp)*100:.0f}%  ≤2s {sum(1 for e in errs if e<=2)/len(grp)*100:.0f}%  ≤3s {sum(1 for e in errs if e<=3)/len(grp)*100:.0f}%  中位 {statistics.median(errs):.2f}s  最大 {max(errs):.1f}s")

print("\n== 拒绝对构成(是否正确拒绝) ==")
rej_src = collections.Counter(r['refSrc'] for r in rej)
print('参考源:', dict(rej_src))
# 正确拒绝 = 无可信参考(peak<0.7 且无强锚)
correct_rej = sum(1 for r in rej if r['refSrc'] == 'none')
possible_miss = sum(1 for r in rej if r['refSrc'] != 'none')
print(f"  正确拒绝(无可信参考): {correct_rej}  潜在漏对(有强参考但被拒): {possible_miss}")

print("\n== 分段启用情况(采纳对) ==")
seg_on = [r for r in acc if r['strongAnchors'] >= 2 and r['anchorSpread'] >= 0.3]
print(f"  segments 启用: {len(seg_on)}  退常数: {len(acc) - len(seg_on)}")

print("\n== 支持率/峰值分布 ==")
print(f"  支持 ≥0.35: {sum(1 for r in rows if r['support']>=0.35)}  0.2-0.35: {sum(1 for r in rows if 0.2<=r['support']<0.35)}  <0.2: {sum(1 for r in rows if r['support']<0.2)}")
print(f"  peak ≥0.6: {sum(1 for r in rows if r['peak']>=0.6)}  0.4-0.6: {sum(1 for r in rows if 0.4<=r['peak']<0.6)}  <0.4: {sum(1 for r in rows if r['peak']<0.4)}")

print("\n== 潜在漏对明细(有强参考但被拒,最多 15) ==")
for r in [r for r in rej if r['refSrc'] != 'none'][:15]:
    print(f"  {r['song']} | {r['title'][:45]} peak={r['peak']:.2f} 支={r['support']:.2f} ref={r['ref']:.1f}({r['refSrc']}) err={r['err']:.1f}s")
