# -*- coding: utf-8 -*-
"""5619 对全类型分层分析:
1) 各 declared type 的对齐行为(采纳率/同源率/真值覆盖)
2) 分类器交叉审计:declared type × 包络真值(同录音/不同录音/货不对板)
3) 深偏移/无真值/矛盾证据的分布"""
import json, statistics, sys, io, collections
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

ROOT = r'D:\opencode\WaveForge\.tmp-kg-align'
rs = json.load(open(ROOT + r'\all-type-eval-results.json', encoding='utf-8'))
print(f"评测对: {len(rs)}\n")

def accepted(r, rescue=True):
    g = r['peak'] >= 0.6 and r['prom'] >= 0.05
    s = r['support'] >= 0.35
    v = rescue and r.get('voteOff') is not None and r['peak'] >= 0.45 and abs(r['voteOff'] - r['peakOff']) <= 5
    return g or s or v

print("== 按类型分层 ==")
print(f"{'类型':14s} {'n':>5s} {'采纳':>5s} {'采纳率':>6s} {'峰≥0.6':>7s} {'支持过':>7s} {'投票过':>7s} {'真值':>5s} {'真值覆盖':>7s}")
by_type = collections.defaultdict(list)
for r in rs: by_type[r['type']].append(r)
for t in ('official', 'lyrics', 'other', 'live', 'instrumental', 'cover'):
    grp = by_type.get(t, [])
    if not grp: continue
    n = len(grp)
    acc = sum(1 for r in grp if accepted(r))
    pk = sum(1 for r in grp if r['peak'] >= 0.6)
    sp = sum(1 for r in grp if r['support'] >= 0.35)
    vt = sum(1 for r in grp if r.get('voteOff') is not None)
    ref = sum(1 for r in grp if r['ref'] is not None)
    print(f"{t:14s} {n:5d} {acc:5d} {acc/n*100:5.0f}% {pk:7d} {sp:7d} {vt:7d} {ref:5d} {ref/n*100:6.0f}%")

print("\n== 分类器交叉审计:declared type × 包络证据 ==")
print("(峰值 ≥0.8 = 几乎必然同录音/官方音源;<0.4 = 不同源/货不对板)")
cross = collections.defaultdict(lambda: collections.Counter())
for r in rs:
    if r['peak'] >= 0.8: bucket = '同录音(≥0.8)'
    elif r['peak'] >= 0.6: bucket = '可能同源(0.6-0.8)'
    elif r['peak'] >= 0.4: bucket = '弱(0.4-0.6)'
    else: bucket = '不同源(<0.4)'
    cross[r['type']][bucket] += 1
for t in ('official', 'lyrics', 'other', 'live', 'instrumental', 'cover'):
    grp = cross.get(t)
    if not grp: continue
    n = sum(grp.values())
    line = ' '.join(f"{k}={v/n*100:.0f}%" for k, v in sorted(grp.items()))
    print(f"  {t:14s} n={n:4d}  {line}")

print("\n== 值得审计的错分样本 ==")
print("官方标记但不同源(峰<0.4) — 匹配层放过了货不对板的「官方」:")
for r in by_type['official']:
    if r['peak'] < 0.4:
        print(f"  {r['songName'][:24]:26s} {r['bvid']} peak={r['peak']:.2f} {r['title'][:50]}")
print("\n非官方标记但高同源(峰≥0.8) — 实为官方音源的搬运(分类无损对齐,但评分层或可加分):")
cnt = 0
for t in ('other', 'lyrics', 'live', 'instrumental', 'cover'):
    for r in by_type[t]:
        if r['peak'] >= 0.8:
            cnt += 1
            if cnt <= 8: print(f"  [{t}] {r['songName'][:22]:24s} peak={r['peak']:.2f} {r['title'][:46]}")
print(f"  合计 {cnt} 对")

print("\n== 深偏移分布(采纳且|offset|>45s) ==")
deep = [r for r in rs if accepted(r) and abs(r['peakOff']) > 45]
by_t2 = collections.Counter(r['type'] for r in deep)
print(f"  合计 {len(deep)}: {dict(by_t2)}")
for r in deep[:10]:
    print(f"  [{r['type']}] {r['songName'][:24]:26s} {r['peakOff']:+7.1f}s peak={r['peak']:.2f} sup={r['support']:.2f}")

print("\n== 真值矛盾(采纳但 ref 存在且差>3s,即潜在 FP) ==")
fps = [r for r in rs if accepted(r) and r['ref'] is not None and abs(r['peakOff'] - r['ref']) > 3]
print(f"  合计 {len(fps)}")
for r in fps[:12]:
    print(f"  [{r['type']}] {r['songName'][:22]:24s} off={r['peakOff']:+7.1f} ref={r['ref']:+7.1f} peak={r['peak']:.2f} sup={r['support']:.2f} vote={r['voteOff'] and round(r['voteOff'],1)}")
