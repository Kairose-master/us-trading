import sys, io, contextlib, statistics as st, random
sys.argv = ["rug.py", "trades.json"]
buf = io.StringIO()
with contextlib.redirect_stdout(buf): exec(open(__file__.replace("pumpfun_rug_ablation.py", "pumpfun_rug_analyze.py")).read())
RULES = {"개발자>10": lambda r: r["creator_pct"] > 10, "상위10>50": lambda r: r["top10_pct"] > 50, "번들>15": lambda r: r["bundle3s_pct"] > 15,
         "스나이퍼>30": lambda r: r["snipers60_pct"] > 30, "지갑당>5": lambda r: r["trades_per_wallet5m"] > 5, "홀더>120": lambda r: r["holders"] > 120}
def ev(active, rs):
    keep = [r for r in rs if not any(RULES[k](r) for k in active)]
    return st.mean(r["pnl"] for r in keep) * 100, len(keep)
full = list(RULES)
m, n = ev(full, rows); print(f"전부: 평균 {m:+.1f}% (n={n})")
print("하나씩 뺐을 때 (뺀 뒤 평균 · 규칙 단독이 막는 건수 · 그중 러그/대박)")
for k in full:
    m2, n2 = ev([x for x in full if x != k], rows)
    hit = [r for r in rows if RULES[k](r)]
    print(f"  -{k:9s} → {m2:+.1f}% ({m2-m:+.1f}p) · 막음 {len(hit)} (러그 {sum(r['rug'] for r in hit)} / 대박 {sum(r['win'] for r in hit)})")
# 표본 밖 확인: 무작위 절반 200회 — 규칙 전부 vs 없음, 규칙 조합 A(번들 제외)
random.seed(7); wins = {"전부": 0, "번들 제외": 0}; diffs = {"전부": [], "번들 제외": []}
for _ in range(200):
    half = random.sample(rows, len(rows) // 2)
    base = st.mean(r["pnl"] for r in half)
    for name, act in (("전부", full), ("번들 제외", [x for x in full if x != "번들>15"])):
        m3, _ = ev(act, half); diffs[name].append(m3 - base * 100); wins[name] += m3 > base * 100
for name in diffs: print(f"무작위 절반 200회 [{name}]: 필터가 나은 비율 {wins[name]/2:.0f}% · 평균 개선 {st.mean(diffs[name]):+.1f}p")
