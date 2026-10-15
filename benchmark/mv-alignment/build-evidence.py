# -*- coding: utf-8 -*-
"""评测 v2:真值三角验证
可信真值 = 三条独立证据中 ≥2 条一致(±3s):
  1) 全曲峰(峰≥0.55)
  2) 段投票强簇(r≥0.7, 票≥2 或 w≥3)
  3) 段支持率恒定偏移峰(全曲峰处的支持率 ≥0.5)
真值缺失才不可评。误对 = 采纳偏移与真值差 >3s 或与唯一强证据差 >3s。"""
import json, math, statistics, sys, io
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
live_set = json.load(open(os.path.join(HERE, 'live-eval-set.json') if os.path.exists(os.path.join(HERE, 'live-eval-set.json')) else os.path.join(ROOT, 'live-eval-set.json'), encoding='utf-8'))
by_bvid = {v.get('bvid'): v for v in mv.values()}

def decimate(env, step):
    if step == 1: return np.array(env)
    n = len(env) // step
    return np.array([sum(env[i*step:(i+1)*step]) / step for i in range(n)])

def pearson(a, b):
    n = min(len(a), len(b))
    a, b = a[:n], b[:n]
    if n < 64: return -1
    am, bm = a.mean(), b.mean()
    num = ((a-am)*(b-bm)).sum()
    da = ((a-am)**2).sum(); db = ((b-bm)**2).sum()
    return num / math.sqrt(da*db) if da*db > 0 else -1

def seg_scan(mv10, s10):
    seg = 300
    out = []
    for st in range(0, len(s10) - seg + 150, 150):
        cs = min(st, len(s10) - seg)
        bestD, bestR = 0, -1
        for d in range(-450, min(900, len(mv10)-64) + 1, 5):
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

data = []
for p in live_set:
    mvv = by_bvid.get(p['bvid']); song = sg.get(p['songKey'])
    if not mvv or not song: continue
    if len(mvv['env']) < 3200 or len(song['env']) < 3200: continue
    data.append((p, decimate(mvv['env'], 5), decimate(song['env'], 5)))
print(f"评测对: {len(data)}")

# 全量证据预计算(慢,一次算完缓存)
evidence = []
for p, m10, s10 in data:
    # 1) 全曲峰
    bestF, bestS = 0, -1
    for f in range(-450, min(900, len(m10)-64) + 1):
        a, b = (s10, m10[f:]) if f >= 0 else (s10[-f:], m10)
        r = pearson(a, b)
        if r > bestS: bestS, bestF = r, f
    runner = -1
    for f in range(-450, min(900, len(m10)-64) + 1):
        if abs(f - bestF) <= 20: continue
        a, b = (s10, m10[f:]) if f >= 0 else (s10[-f:], m10)
        r = pearson(a, b)
        if r > runner: runner = r
    peak_off = bestF / 10
    prom = bestS - runner
    # 2) 段投票
    votes = seg_scan(m10, s10)
    strong = cluster(votes, min_r=0.7)
    vote_off = strong[0]['off'] if strong and (len(strong[0]['items']) >= 2 or strong[0]['w'] >= 3) else None
    # 3) 支持率 @全曲峰
    seg = 300; delta = bestF
    rs = []
    for st in range(0, len(s10) - seg, seg):
        b = st + delta
        if b < 0 or b + seg > len(m10): continue
        r = pearson(s10[st:st+seg], m10[b:b+seg])
        if r >= 0: rs.append(r)
    ratio = sum(1 for r in rs if r > 0.4) / len(rs) if len(rs) >= 3 else 0
    support_ok = ratio >= 0.5
    evidence.append({'p': p, 'peakOff': peak_off, 'peak': bestS, 'prom': prom,
                     'voteOff': vote_off, 'support': ratio, 'supportOk': support_ok,
                     'votes': votes})
    print(f"  {p['songName'][:20]:22s} peak={bestS:.2f}@{peak_off:+6.1f} prom={prom:.2f} vote={vote_off and round(vote_off,1)} sup={ratio:.2f}")

json.dump([{k: v for k, v in e.items() if k != 'votes'} for e in evidence],
          open(ROOT + r'\live-evidence.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=float)
print('已写 live-evidence.json')
