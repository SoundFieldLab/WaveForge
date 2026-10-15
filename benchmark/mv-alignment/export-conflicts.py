# -*- coding: utf-8 -*-
"""导出证据矛盾对(人工标注清单):采纳/拒绝存疑的对,按可行动性排序。
用途:人工在 B 站开视频+听音源核对,标注 true/false offset 后回填
conflict-labels.json,作为下一轮闸门标定的金标准样本。"""
import json, sys, io, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

HERE = os.path.dirname(os.path.abspath(__file__))
results = json.load(open(os.path.join(HERE, 'all-type-eval-results.json'), encoding='utf-8'))

def accepted(r):
    g = r['peak'] >= 0.6 and r['prom'] >= 0.05
    s = r['support'] >= 0.35
    v = r.get('voteOff') is not None and r['peak'] >= 0.45 and abs(r['voteOff'] - r['peakOff']) <= 5
    return g or s or v

conflicts = []
for r in results:
    acc = accepted(r)
    # 类别1:采纳但与三角真值矛盾(潜在 FP,最需要人工)
    if acc and r['ref'] is not None and abs(r['peakOff'] - r['ref']) > 3:
        conflicts.append({**r, 'conflict': '采纳偏移≠三角真值(潜在FP)', 'priority': 1,
                          'label': None, 'labelNote': ''})
    # 类别2:有强参考(强锚≥0.7)却被拒(潜在 FN,第二优先)
    elif not acc and r['ref'] is not None:
        conflicts.append({**r, 'conflict': '有强参考但被拒(潜在FN)', 'priority': 2,
                          'label': None, 'labelNote': ''})
    # 类别3:采纳但真值缺失(证据单薄,抽样人工)
    elif acc and r['ref'] is None and r['peak'] < 0.6:
        conflicts.append({**r, 'conflict': '采纳但无真值(抽样核验)', 'priority': 3,
                          'label': None, 'labelNote': ''})

conflicts.sort(key=lambda c: (c['priority'], -c['support']))
out = os.path.join(HERE, 'conflict-labels.json')
json.dump(conflicts, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
by = {}
for c in conflicts: by[c['conflict']] = by.get(c['conflict'], 0) + 1
print(f"矛盾对 {len(conflicts)} 条 → conflict-labels.json")
for k, v in by.items(): print(f"  P{[c['priority'] for c in conflicts if c['conflict']==k][0]} {k}: {v}")
# 标注字段说明
print("""
标注方法:每条填 label(=人工确认的正确偏移,秒;确认对不上填 -999)和 labelNote(理由)。
重点核对方式:B 站视频拖到 peakOff 与 ref 两个位置,听哪边的音乐节拍与歌曲对得上。
""")
