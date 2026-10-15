# -*- coding: utf-8 -*-
"""评测 v2 终版:三角真值 + 方案对比"""
import json, math, statistics, sys, io
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

import os
HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.normpath(os.path.join(HERE, '..', '..', '.tmp-kg-align'))
ROOT = DATA
ev = json.load(open(ROOT + r'\live-evidence.json', encoding='utf-8'))

def truth_label(e):
    """三角验证:≥2 条证据一致(±3s)→ 真值;否则 None"""
    evidences = []
    if e['peak'] >= 0.55: evidences.append(('peak', e['peakOff']))
    if e['voteOff'] is not None: evidences.append(('vote', e['voteOff']))
    if e['supportOk']: evidences.append(('support', e['peakOff']))
    if not evidences: return None, 0
    # 簇
    best = None
    for i, (n1, v1) in enumerate(evidences):
        agree = [n1] + [n2 for n2, v2 in evidences[i+1:] if abs(v1 - v2) <= 3]
        if best is None or len(agree) > len(best[0]): best = (agree, statistics.median([v for n, v in evidences if n in agree]))
    return best[1], len(best[0])

def evaluate(name, decide):
    tp = fp = fn = tn = 0
    errs = []
    details = []
    for e in ev:
        ref, conf = truth_label(e)
        off = decide(e)
        if off is not None:
            if ref is not None:
                err = abs(off - ref)
                errs.append(err)
                if err <= 3: tp += 1
                else: fp += 1; details.append(('FP', e['p']['songName'], off, ref, err, conf))
            else:
                fp += 1; details.append(('FP?', e['p']['songName'], off, None, None, conf))
        else:
            if ref is not None: fn += 1; details.append(('FN', e['p']['songName'], None, ref, None, conf))
            else: tn += 1
    print(f"\n== {name} ==")
    print(f"  采纳正确 {tp}  误对 {fp}  漏对 {fn}  正确拒绝 {tn}")
    if errs:
        print(f"  误差: ≤1s {sum(1 for x in errs if x<=1)/len(errs)*100:.0f}%  ≤2s {sum(1 for x in errs if x<=2)/len(errs)*100:.0f}%  中位 {statistics.median(errs):.2f}s")
    print(f"  精确率 {tp/max(1,tp+fp)*100:.0f}%  召回率 {tp/max(1,tp+fn)*100:.0f}%")
    for d in details[:12]:
        print(f"    {d[0]}: {d[1][:26]} off={d[2] is not None and round(d[2],1)} ref={d[3] is not None and round(d[3],1)} err={d[4] is not None and round(d[4],1)} 真值置信={d[5]}")

# 方案A:当前生产(峰0.6+突0.05 / 支持率0.35)
evaluate("方案A:当前生产链路", lambda e: (e['peakOff'] if (e['peak'] >= 0.6 and e['prom'] >= 0.05) or e['support'] >= 0.35 else None))
# 方案B:段投票共识(票≥3 或 w≥2)
evaluate("方案B:段投票共识", lambda e: (e['voteOff'] if False else None))
# 方案C:当前链路 ∪ 投票共识(任一通过即采纳,投票优先)
def decide_union(e):
    if e['voteOff'] is not None: return e['voteOff']
    if (e['peak'] >= 0.6 and e['prom'] >= 0.05) or e['support'] >= 0.35: return e['peakOff']
    return None
evaluate("方案C:投票 ∪ 当前链路", decide_union)
# 方案D:当前链路 + 投票救援(仅当前链路拒绝且投票簇强时用投票)
def decide_rescue(e):
    current = (e['peak'] >= 0.6 and e['prom'] >= 0.05) or e['support'] >= 0.35
    if current: return e['peakOff']
    # 救援:峰≥0.45 且投票一致
    if e['peak'] >= 0.45 and e['voteOff'] is not None and abs(e['voteOff'] - e['peakOff']) <= 5:
        return e['voteOff']
    return None
evaluate("方案D:当前链路+投票救援", decide_rescue)
